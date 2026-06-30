import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { postResourceViaBrowser } from "./browserResourceUploader.js";
import { config } from "./config.js";
import { extractPdfFromEvent } from "./pdfExtractor.js";
import { ClassificationResult, GroupBinding, OpenClawDocumentEvent } from "./types.js";
import { sleep, extractYoutubeUrl } from "./utils.js";

const execFileAsync = promisify(execFile);

interface PostResult {
  entityType: "resource" | "notice" | "syllabus";
  entityId: string;
}

export interface StudyShareAdminResource {
  id: string;
  title: string;
  type: string;
  description?: string | null;
  file_url?: string | null;
  video_url?: string | null;
  branch?: string | null;
  semester?: string | null;
  subject?: string | null;
  status?: string | null;
  college_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

interface ListAdminResourcesResponse {
  resources?: StudyShareAdminResource[];
  count?: number;
}

export interface ResourceMetadataUpdateInput {
  resourceId: string;
  branch: string;
  semester: string;
  subject: string;
  collegeId?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface ResourceMetaBrief {
  id: string;
  title: string | null;
  branch: string | null;
  semester: string | null;
  subject: string | null;
  type: string | null;
  fileUrl: string | null;
}

export interface DuplicateResourceGroup {
  fingerprint: string;
  mode: DuplicateMode;
  keep: StudyShareAdminResource;
  remove: StudyShareAdminResource[];
}

export type DuplicateMode = "strict" | "file" | "loose" | "ocr";

export interface DuplicateScanResult {
  mode: DuplicateMode;
  scanned: number;
  totalAvailable: number;
  recentLimit: number | null;
  strictGroupCount: number;
  strictRemoveCount: number;
  fileGroupCount: number;
  fileRemoveCount: number;
  looseGroupCount: number;
  looseRemoveCount: number;
  ocrGroupCount: number;
  ocrRemoveCount: number;
  selectedGroupCount: number;
  selectedRemoveCount: number;
  selectedGroups: DuplicateResourceGroup[];
  strictGroups: DuplicateResourceGroup[];
  fileGroups: DuplicateResourceGroup[];
  looseGroups: DuplicateResourceGroup[];
  ocrGroups: DuplicateResourceGroup[];
}

export interface DuplicateDeleteResult extends DuplicateScanResult {
  deletedCount: number;
  failedCount: number;
  failedIds: Array<{ id: string; reason: string }>;
}

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeFileReference(urlOrPath: string | null | undefined): string {
  const raw = String(urlOrPath ?? "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return decodeURIComponent(url.pathname || "")
      .toLowerCase()
      .trim();
  } catch {
    return raw.split("?")[0]?.split("#")[0]?.toLowerCase().trim() ?? raw.toLowerCase().trim();
  }
}

function normalizeVideoReference(urlOrPath: string | null | undefined): string {
  const raw = String(urlOrPath ?? "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(parsed.pathname || "")
      .toLowerCase()
      .trim();

    if (host.includes("youtube.com")) {
      if (path === "/watch") {
        const videoId = parsed.searchParams.get("v")?.trim();
        if (videoId) return `youtube:${videoId.toLowerCase()}`;
      }
      if (path.startsWith("/shorts/")) {
        const videoId = path.split("/")[2]?.trim();
        if (videoId) return `youtube:${videoId.toLowerCase()}`;
      }
    }

    if (host === "youtu.be") {
      const videoId = path.replace(/^\//, "").split("/")[0]?.trim();
      if (videoId) return `youtube:${videoId.toLowerCase()}`;
    }

    return `${host}${path}${parsed.search.toLowerCase()}`;
  } catch {
    return raw.toLowerCase().trim();
  }
}

function normalizeResourceReference(resource: StudyShareAdminResource): string {
  const fileRef = normalizeFileReference(resource.file_url ?? "");
  if (fileRef) return `file:${fileRef}`;

  const videoRef = normalizeVideoReference(resource.video_url ?? "");
  if (videoRef) return `video:${videoRef}`;

  return "";
}

function fileBaseName(fileRef: string): string {
  const last =
    String(fileRef || "")
      .split("/")
      .pop() ?? "";
  return last.toLowerCase().trim();
}

function fileStem(fileRef: string): string {
  const base = fileBaseName(fileRef);
  return base.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
}

function normalizeLooseTitle(input: string | null | undefined): string {
  const raw = normalizeText(input);
  if (!raw) return "";
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "of",
    "in",
    "to",
    "unit",
    "module",
    "chapter",
    "notes",
    "note",
    "ppt",
    "pdf",
    "lecture",
  ]);

  const tokens = raw
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !stopwords.has(token));

  return tokens.join(" ");
}

function parseDateSafe(value: string | null | undefined): number {
  if (!value) return 0;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOcrText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function safeTextSample(input: string, max: number): string {
  const trimmed = String(input || "").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function looksLikePdfResource(resource: StudyShareAdminResource): boolean {
  const fileUrl = String(resource.file_url ?? "").toLowerCase();
  if (!fileUrl) return false;
  if (fileUrl.includes(".pdf")) return true;
  return String(resource.type ?? "").toLowerCase() === "notes";
}

interface RenderPagesResponse {
  ok: boolean;
  error?: string;
  pages?: string[];
}

interface GoogleVisionAnnotateResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    error?: { message?: string };
  }>;
}

interface OcrFingerprint {
  hash: string;
  sample: string;
  provider: "google_vision";
}

interface OcrCacheEntry {
  fingerprint: OcrFingerprint | null;
  resourceUpdatedAt: string | null;
  fileRef: string;
}

const resourceOcrCache = new Map<string, OcrCacheEntry>();

function buildResourceOcrCacheKey(resource: StudyShareAdminResource): string {
  return String(resource.id || "").trim();
}

function getCachedResourceOcrFingerprint(
  resource: StudyShareAdminResource,
): OcrFingerprint | null | undefined {
  const key = buildResourceOcrCacheKey(resource);
  if (!key) return undefined;
  const entry = resourceOcrCache.get(key);
  if (!entry) return undefined;
  const currentUpdatedAt = resource.updated_at ?? null;
  const currentFileRef = normalizeResourceReference(resource);
  if (entry.resourceUpdatedAt !== currentUpdatedAt || entry.fileRef !== currentFileRef) {
    return undefined;
  }
  return entry.fingerprint;
}

function setCachedResourceOcrFingerprint(
  resource: StudyShareAdminResource,
  fingerprint: OcrFingerprint | null,
): void {
  const key = buildResourceOcrCacheKey(resource);
  if (!key) return;
  resourceOcrCache.set(key, {
    fingerprint,
    resourceUpdatedAt: resource.updated_at ?? null,
    fileRef: normalizeResourceReference(resource),
  });
}

async function renderPdfPagesForOcr(tempPath: string, maxPages: number): Promise<string[]> {
  const scriptPath = "/app/extractor/render_pdf_pages.py";
  const { stdout } = await execFileAsync(
    config.PYTHON_BIN,
    [scriptPath, tempPath, String(maxPages), "140"],
    {
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const parsed = JSON.parse(stdout.trim()) as RenderPagesResponse;
  if (!parsed.ok) {
    throw new Error(parsed.error ?? "ocr_render_failed");
  }

  return Array.isArray(parsed.pages)
    ? parsed.pages.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function runGoogleVisionOnPages(pageBase64: string[]): Promise<string> {
  const apiKey = String(config.GOOGLE_VISION_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("google_vision_api_key_missing");
  }

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
  const requests = pageBase64.map((page) => ({
    image: { content: page },
    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
  }));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`google_vision_http_${response.status}:${detail}`);
  }

  const payload = (await response.json()) as GoogleVisionAnnotateResponse;
  const texts = (payload.responses ?? [])
    .map(
      (entry) => entry?.fullTextAnnotation?.text ?? entry?.textAnnotations?.[0]?.description ?? "",
    )
    .map((text) => String(text || "").trim())
    .filter(Boolean);

  return texts.join("\n");
}

async function computeResourceOcrFingerprint(
  resource: StudyShareAdminResource,
): Promise<OcrFingerprint | null> {
  if (!config.enableGoogleVisionOcr || !looksLikePdfResource(resource) || !resource.file_url) {
    return null;
  }

  const cached = getCachedResourceOcrFingerprint(resource);
  if (cached !== undefined) {
    return cached;
  }

  let tempPath: string | null = null;
  try {
    const response = await fetchWithRetry(String(resource.file_url), { method: "GET" });
    if (!response.ok) {
      setCachedResourceOcrFingerprint(resource, null);
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      setCachedResourceOcrFingerprint(resource, null);
      return null;
    }

    tempPath = path.join(tmpdir(), `resource-dedupe-${randomUUID()}.pdf`);
    await fs.writeFile(tempPath, bytes);

    const maxPages = Math.min(Math.max(config.GOOGLE_VISION_OCR_MAX_PAGES, 1), 6);
    const pages = await renderPdfPagesForOcr(tempPath, maxPages);
    if (!pages.length) {
      setCachedResourceOcrFingerprint(resource, null);
      return null;
    }

    const rawText = await runGoogleVisionOnPages(pages);
    const normalized = normalizeOcrText(rawText);
    if (normalized.length < 120) {
      setCachedResourceOcrFingerprint(resource, null);
      return null;
    }

    const fingerprint: OcrFingerprint = {
      hash: sha256(normalized),
      sample: safeTextSample(normalized, 280),
      provider: "google_vision",
    };
    setCachedResourceOcrFingerprint(resource, fingerprint);
    return fingerprint;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown_ocr_error";
    console.warn("[duplicate-ocr] failed to fingerprint resource", {
      resourceId: resource.id,
      fileUrl: resource.file_url,
      error: detail,
    });
    try {
      const fallbackEvent: OpenClawDocumentEvent = {
        messageId: `dedupe-fallback-${resource.id}`,
        groupJid: "dedupe-fallback",
        filename: path.basename(String(resource.file_url || "resource.pdf")) || "resource.pdf",
        mimeType: "application/pdf",
        mediaUrl: String(resource.file_url),
      };
      const extracted = await extractPdfFromEvent(fallbackEvent, sha256Bytes);
      const normalizedFallback = normalizeOcrText(
        extracted.extracted.fullTextSample || extracted.extracted.textSample || "",
      );
      if (normalizedFallback.length >= 120) {
        const fallbackFingerprint: OcrFingerprint = {
          hash: sha256(normalizedFallback),
          sample: safeTextSample(normalizedFallback, 280),
          provider: "google_vision",
        };
        setCachedResourceOcrFingerprint(resource, fallbackFingerprint);
        return fallbackFingerprint;
      }
    } catch {
      // Ignore fallback extraction failures.
    }

    setCachedResourceOcrFingerprint(resource, null);
    return null;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => {
        // Ignore temp cleanup issues.
      });
    }
  }
}

function pickKeepAndRemove(resources: StudyShareAdminResource[]): {
  keep: StudyShareAdminResource;
  remove: StudyShareAdminResource[];
} {
  const sorted = [...resources].sort((a, b) => {
    const ad = parseDateSafe(a.created_at);
    const bd = parseDateSafe(b.created_at);
    if (ad !== bd) return bd - ad; // keep latest
    return String(b.id).localeCompare(String(a.id));
  });

  return {
    keep: sorted[0],
    remove: sorted.slice(1),
  };
}

function hasSupabaseFallback(): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
}

export async function getResourceMetadataByIds(
  ids: string[],
): Promise<Record<string, ResourceMetaBrief>> {
  const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!unique.length) return {};
  if (!hasSupabaseFallback()) return {};

  const quoted = unique.map((id) => `"${id.replace(/"/g, '""')}"`).join(",");
  const query = new URLSearchParams();
  query.set("select", "id,title,branch,semester,subject,type,file_url");
  query.set("id", `in.(${quoted})`);

  const response = await fetchWithRetry(
    `${config.SUPABASE_URL!.replace(/\/+$/, "")}/rest/v1/resources?${query.toString()}`,
    {
      method: "GET",
      headers: {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY!,
        authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    },
  );

  if (!response.ok) {
    return {};
  }

  const rows = (await response.json()) as Array<{
    id: string;
    title?: string | null;
    branch?: string | null;
    semester?: string | null;
    subject?: string | null;
    type?: string | null;
    file_url?: string | null;
  }>;

  const out: Record<string, ResourceMetaBrief> = {};
  for (const row of rows ?? []) {
    if (!row?.id) continue;
    out[row.id] = {
      id: row.id,
      title: row.title ?? null,
      branch: row.branch ?? null,
      semester: row.semester ?? null,
      subject: row.subject ?? null,
      type: row.type ?? null,
      fileUrl: row.file_url ?? null,
    };
  }
  return out;
}

async function listAdminResourcesFromSupabase(args: {
  page: number;
  pageSize: number;
  collegeId?: string | null;
  status?: string | null;
}): Promise<{ resources: StudyShareAdminResource[]; count: number }> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supabase_fallback_not_configured");
  }

  const offset = (Math.max(1, args.page) - 1) * Math.min(Math.max(1, args.pageSize), 100);
  const limit = Math.min(Math.max(1, args.pageSize), 100);
  const query = new URLSearchParams();
  query.set("select", "*");
  query.set("order", "created_at.desc");
  query.set("limit", String(limit));
  query.set("offset", String(offset));
  if (args.collegeId) query.set("college_id", `eq.${args.collegeId}`);
  if (args.status) query.set("status", `eq.${args.status}`);

  const response = await fetchWithRetry(
    `${config.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/resources?${query.toString()}`,
    {
      method: "GET",
      headers: {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
        prefer: "count=exact",
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`resource_list_supabase_failed:${response.status}:${body}`);
  }

  const rows = (await response.json()) as StudyShareAdminResource[];
  const contentRange = response.headers.get("content-range") || "";
  const total = Number((contentRange.split("/")[1] || "").trim());

  return {
    resources: Array.isArray(rows) ? rows : [],
    count: Number.isFinite(total) ? total : Array.isArray(rows) ? rows.length : 0,
  };
}

function buildUrl(path: string): string {
  return `${config.STUDYSHARE_API_BASE.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("network_error") || error.message.includes("timeout");
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  const scheduleMs = [10_000, 30_000, 90_000];

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok && isRetryableStatus(response.status) && i < attempts - 1) {
        await sleep(scheduleMs[i] ?? 90_000);
        continue;
      }
      return response;
    } catch (error) {
      if (i === attempts - 1 || !isRetryableError(error)) {
        throw error;
      }
      await sleep(scheduleMs[i] ?? 90_000);
    }
  }

  throw new Error("unreachable_retry_path");
}

async function getPresignedUpload(
  fileName: string,
  category: "resource" | "notice" | "syllabus",
  idempotencyKey: string,
): Promise<{ uploadUrl: string; publicUrl: string; contentType: string } | null> {
  const response = await fetchWithRetry(buildUrl(config.STUDYSHARE_UPLOADS_PRESIGN_PATH), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      filename: fileName,
      category,
      source_channel: "whatsapp_bot",
    }),
  });

  if (response.status === 404 || response.status === 405) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`presign_failed:${response.status}:${body}`);
  }

  return (await response.json()) as { uploadUrl: string; publicUrl: string; contentType: string };
}

async function uploadBinary(uploadUrl: string, bytes: Buffer, contentType: string): Promise<void> {
  const body = new Uint8Array(bytes);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": contentType,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`upload_failed:${response.status}`);
  }
}

function decodeBase64ToBuffer(input: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("media_decode_failed:empty_media_base64");
  }

  if (trimmed.startsWith("data:")) {
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx < 0) {
      throw new Error("media_decode_failed:invalid_data_url");
    }
    const meta = trimmed.slice(0, commaIdx).toLowerCase();
    if (!meta.includes(";base64")) {
      throw new Error("media_decode_failed:data_url_not_base64");
    }
    return Buffer.from(trimmed.slice(commaIdx + 1), "base64");
  }

  return Buffer.from(trimmed, "base64");
}

async function resolveEventMediaBytes(event: OpenClawDocumentEvent): Promise<Buffer> {
  if (event.mediaBase64) {
    return decodeBase64ToBuffer(event.mediaBase64);
  }

  if (event.mediaPath) {
    try {
      return await fs.readFile(event.mediaPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "failed_to_read_media_path";
      throw new Error(`media_read_failed:${detail}`);
    }
  }

  if (event.mediaUrl) {
    const mediaResponse = await fetchWithRetry(event.mediaUrl, { method: "GET" });
    if (!mediaResponse.ok) {
      throw new Error(`media_download_for_upload_failed:${mediaResponse.status}`);
    }
    return Buffer.from(await mediaResponse.arrayBuffer());
  }

  throw new Error("media_source_missing");
}

async function tryPrimaryNoticeEndpoint(
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<PostResult | null> {
  const response = await fetchWithRetry(buildUrl(config.STUDYSHARE_NOTICES_PATH), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 404 || response.status === 405) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`notice_create_failed:${response.status}:${body}`);
  }

  const data = (await response.json()) as { notice?: { id?: string }; id?: string };
  return { entityType: "notice", entityId: data.notice?.id ?? data.id ?? "unknown" };
}

async function tryPrimarySyllabusEndpoint(
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<PostResult | null> {
  const response = await fetchWithRetry(buildUrl(config.STUDYSHARE_SYLLABUS_PATH), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 404 || response.status === 405) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`syllabus_create_failed:${response.status}:${body}`);
  }

  const data = (await response.json()) as { syllabus?: { id?: string }; id?: string };
  return { entityType: "syllabus", entityId: data.syllabus?.id ?? data.id ?? "unknown" };
}

async function callLegacyAdmin(
  action: "create_notice" | "upload_syllabus",
  data: Record<string, unknown>,
  idempotencyKey: string,
): Promise<PostResult> {
  const response = await fetchWithRetry(buildUrl(config.STUDYSHARE_LEGACY_ADMIN_PATH), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      action,
      keyHash: config.STUDYSHARE_ADMIN_BEARER,
      data,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`legacy_${action}_failed:${response.status}:${body}`);
  }

  const body = (await response.json()) as { id?: string; notice?: { id?: string } };
  if (action === "create_notice") {
    return { entityType: "notice", entityId: body.notice?.id ?? body.id ?? "unknown" };
  }

  return { entityType: "syllabus", entityId: body.id ?? "unknown" };
}

async function postResource(
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<PostResult> {
  const response = await fetchWithRetry(buildUrl(config.STUDYSHARE_RESOURCES_PATH), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`resource_create_failed:${response.status}:${body}`);
  }

  const data = (await response.json()) as { resource?: { id?: string }; id?: string };
  return { entityType: "resource", entityId: data.resource?.id ?? data.id ?? "unknown" };
}

function mapResourceType(fileName: string, caption?: string): string {
  const text = `${fileName} ${caption ?? ""}`.toLowerCase();
  if (text.includes("pyq") || text.includes("previous year")) {
    return "pyq";
  }
  return "notes";
}

function deriveOriginalTitle(fileName: string): string {
  const raw = String(fileName ?? "").trim();
  if (!raw) return "Untitled.pdf";
  return raw;
}

export async function listAdminResources(args: {
  page: number;
  pageSize: number;
  collegeId?: string | null;
  status?: string | null;
}): Promise<{ resources: StudyShareAdminResource[]; count: number }> {
  const query = new URLSearchParams();
  query.set("page", String(Math.max(1, args.page)));
  query.set("pageSize", String(Math.min(Math.max(1, args.pageSize), 100)));
  if (args.collegeId) query.set("collegeId", args.collegeId);
  if (args.status) query.set("status", args.status);

  try {
    const response = await fetchWithRetry(
      buildUrl(`${config.STUDYSHARE_RESOURCES_PATH}?${query.toString()}`),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
        },
      },
    );

    if (response.ok) {
      const payload = (await response.json()) as ListAdminResourcesResponse;
      return {
        resources: payload.resources ?? [],
        count: Number(payload.count ?? 0),
      };
    }

    if (hasSupabaseFallback()) {
      return listAdminResourcesFromSupabase(args);
    }

    const body = await response.text();
    throw new Error(`resource_list_failed:${response.status}:${body}`);
  } catch (error) {
    if (hasSupabaseFallback()) {
      return listAdminResourcesFromSupabase(args);
    }
    throw error;
  }
}

export async function updateAdminResourceMetadata(
  input: ResourceMetadataUpdateInput,
  idempotencyKey?: string,
): Promise<StudyShareAdminResource> {
  const payload = {
    branch: input.branch,
    semester: input.semester,
    subject: input.subject,
    title: input.title ?? undefined,
    description: input.description ?? undefined,
    collegeId: input.collegeId ?? undefined,
  };

  const updateViaSupabase = async (): Promise<StudyShareAdminResource> => {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("resource_update_supabase_failed:supabase_fallback_not_configured");
    }

    const query = new URLSearchParams();
    query.set("id", `eq.${input.resourceId}`);
    if (input.collegeId) {
      query.set("college_id", `eq.${input.collegeId}`);
    }
    query.set("select", "*");

    const supabaseBody: Record<string, unknown> = {
      branch: input.branch,
      semester: input.semester,
      subject: input.subject,
      updated_at: new Date().toISOString(),
    };
    if (input.title != null) supabaseBody.title = input.title;
    if (input.description != null) supabaseBody.description = input.description;

    const supabaseResponse = await fetchWithRetry(
      `${config.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/resources?${query.toString()}`,
      {
        method: "PATCH",
        headers: {
          apikey: config.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify(supabaseBody),
      },
    );

    if (!supabaseResponse.ok) {
      const supabaseText = await supabaseResponse.text();
      throw new Error(`resource_update_supabase_failed:${supabaseResponse.status}:${supabaseText}`);
    }

    const rows = (await supabaseResponse.json()) as StudyShareAdminResource[];
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }

    throw new Error("resource_update_supabase_failed:empty_result");
  };

  try {
    const response = await fetchWithRetry(
      buildUrl(`${config.STUDYSHARE_RESOURCES_PATH}/${encodeURIComponent(input.resourceId)}`),
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      },
    );

    if (response.ok) {
      const body = (await response.json()) as { resource?: StudyShareAdminResource };
      return (
        body.resource ??
        ({
          id: input.resourceId,
          title: input.title ?? "Resource",
          type: "notes",
          branch: input.branch,
          semester: input.semester,
          subject: input.subject,
          description: input.description ?? null,
          college_id: input.collegeId ?? null,
        } as StudyShareAdminResource)
      );
    }

    const bodyText = await response.text();
    const backendRouteMissing =
      response.status === 404 && /Route PATCH \/api\/admin\/resources\//i.test(bodyText);

    const backendUnavailable =
      response.status >= 500 || response.status === 429 || response.status === 522;
    if ((backendRouteMissing || backendUnavailable) && hasSupabaseFallback()) {
      return updateViaSupabase();
    }

    throw new Error(`resource_update_failed:${response.status}:${bodyText}`);
  } catch (error) {
    if (hasSupabaseFallback()) {
      return updateViaSupabase();
    }
    throw error;
  }
}

async function listAllAdminResources(args: {
  collegeId?: string | null;
  status?: string | null;
  pageSize?: number;
  maxPages?: number;
}): Promise<StudyShareAdminResource[]> {
  const pageSize = Math.min(Math.max(args.pageSize ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(args.maxPages ?? 40, 1), 200);
  const rows: StudyShareAdminResource[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const listed = await listAdminResources({
      page,
      pageSize,
      collegeId: args.collegeId,
      status: args.status,
    });

    if (!listed.resources?.length) break;

    rows.push(...listed.resources);

    if (listed.resources.length < pageSize) break;
  }

  return rows;
}

export async function deleteAdminResource(args: {
  resourceId: string;
  collegeId?: string | null;
  idempotencyKey?: string;
}): Promise<void> {
  const resourceId = String(args.resourceId || "").trim();
  if (!resourceId) {
    throw new Error("resource_delete_failed:missing_resource_id");
  }

  const deleteViaSupabase = async (): Promise<void> => {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("resource_delete_supabase_failed:supabase_fallback_not_configured");
    }

    const query = new URLSearchParams();
    query.set("id", `eq.${resourceId}`);
    if (args.collegeId) {
      query.set("college_id", `eq.${args.collegeId}`);
    }

    const response = await fetchWithRetry(
      `${config.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/resources?${query.toString()}`,
      {
        method: "DELETE",
        headers: {
          apikey: config.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
          prefer: "return=minimal",
        },
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`resource_delete_supabase_failed:${response.status}:${text}`);
    }
  };

  try {
    const response = await fetchWithRetry(
      buildUrl(`${config.STUDYSHARE_RESOURCES_PATH}/${encodeURIComponent(resourceId)}`),
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${config.STUDYSHARE_ADMIN_BEARER}`,
          ...(args.idempotencyKey ? { "x-idempotency-key": args.idempotencyKey } : {}),
        },
      },
    );

    if (response.ok) return;

    const bodyText = await response.text();
    const backendRouteMissing =
      response.status === 404 && /Route DELETE \/api\/admin\/resources\//i.test(bodyText);
    const backendUnavailable =
      response.status >= 500 || response.status === 429 || response.status === 522;

    if ((backendRouteMissing || backendUnavailable) && hasSupabaseFallback()) {
      await deleteViaSupabase();
      return;
    }

    throw new Error(`resource_delete_failed:${response.status}:${bodyText}`);
  } catch (error) {
    if (hasSupabaseFallback()) {
      await deleteViaSupabase();
      return;
    }
    throw error;
  }
}

export async function scanDuplicateResources(args?: {
  collegeId?: string | null;
  status?: string | null;
  pageSize?: number;
  maxPages?: number;
  mode?: DuplicateMode;
  recentLimit?: number | null;
}): Promise<DuplicateScanResult> {
  const selectedMode: DuplicateMode = args?.mode ?? "file";
  if (selectedMode === "ocr") {
    if (!config.enableGoogleVisionOcr) {
      throw new Error("google_vision_ocr_disabled");
    }
    if (!String(config.GOOGLE_VISION_API_KEY ?? "").trim()) {
      throw new Error("google_vision_api_key_missing");
    }
  }

  const allResources = await listAllAdminResources({
    collegeId: args?.collegeId,
    status: args?.status ?? "approved",
    pageSize: args?.pageSize ?? 100,
    maxPages: args?.maxPages ?? 40,
  });

  const normalizeRecentLimit = (raw: number | null | undefined): number | null => {
    if (raw == null) return null;
    if (!Number.isFinite(raw)) return null;
    const rounded = Math.floor(raw);
    if (rounded <= 0) return null;
    return Math.min(rounded, 5000);
  };

  const recentLimit = normalizeRecentLimit(args?.recentLimit);

  const toMillis = (value: string | null | undefined): number => {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const resources = [...allResources].sort((a, b) => {
    const left = toMillis(a.created_at) || toMillis(a.updated_at);
    const right = toMillis(b.created_at) || toMillis(b.updated_at);
    return right - left;
  });

  const scopedResources = recentLimit ? resources.slice(0, recentLimit) : resources;

  const strictMap = new Map<string, StudyShareAdminResource[]>();
  const fileMap = new Map<string, StudyShareAdminResource[]>();
  const looseMap = new Map<string, StudyShareAdminResource[]>();
  const ocrMap = new Map<string, StudyShareAdminResource[]>();

  for (const row of scopedResources) {
    const fileRef = normalizeResourceReference(row);
    const stem = fileStem(fileRef);
    const titleNorm = normalizeText(row.title);
    const titleLoose = normalizeLooseTitle(row.title) || titleNorm;
    const collegeNorm = normalizeText(row.college_id);
    const branchNorm = normalizeText(row.branch);
    const semesterNorm = normalizeText(row.semester);
    const subjectNorm = normalizeText(row.subject);

    if (fileRef) {
      const strictFingerprint = [
        collegeNorm,
        branchNorm,
        semesterNorm,
        subjectNorm,
        titleNorm,
        fileRef,
      ].join("|");
      const strictRows = strictMap.get(strictFingerprint) ?? [];
      strictRows.push(row);
      strictMap.set(strictFingerprint, strictRows);
    }

    if (fileRef || stem) {
      const fileFingerprint = [collegeNorm, fileRef || stem].join("|");
      const fileRows = fileMap.get(fileFingerprint) ?? [];
      fileRows.push(row);
      fileMap.set(fileFingerprint, fileRows);
    }

    if (titleLoose) {
      const looseFingerprint = [
        collegeNorm,
        titleLoose,
        subjectNorm,
        semesterNorm,
        branchNorm,
      ].join("|");
      const looseRows = looseMap.get(looseFingerprint) ?? [];
      looseRows.push(row);
      looseMap.set(looseFingerprint, looseRows);
    }
  }

  if (selectedMode === "ocr") {
    let ocrCandidates = 0;
    let ocrFingerprinted = 0;
    for (const row of scopedResources) {
      if (!looksLikePdfResource(row) || !row.file_url) continue;
      ocrCandidates += 1;
      const collegeNorm = normalizeText(row.college_id);
      const ocrFingerprint = await computeResourceOcrFingerprint(row);
      if (!ocrFingerprint?.hash) continue;
      ocrFingerprinted += 1;
      const key = [collegeNorm, ocrFingerprint.hash].join("|");
      const grouped = ocrMap.get(key) ?? [];
      grouped.push(row);
      ocrMap.set(key, grouped);
    }
    if (ocrCandidates > 0 && ocrFingerprinted === 0) {
      throw new Error("ocr_fingerprint_failed_for_all_resources");
    }
  }

  const toGroups = (
    mode: DuplicateMode,
    source: Map<string, StudyShareAdminResource[]>,
  ): DuplicateResourceGroup[] => {
    const groups: DuplicateResourceGroup[] = [];
    for (const [fingerprint, grouped] of source.entries()) {
      if (grouped.length < 2) continue;
      const picked = pickKeepAndRemove(grouped);
      groups.push({
        fingerprint,
        mode,
        keep: picked.keep,
        remove: picked.remove,
      });
    }
    groups.sort((a, b) => b.remove.length - a.remove.length);
    return groups;
  };

  const strictGroups = toGroups("strict", strictMap);
  const fileGroups = toGroups("file", fileMap);
  const looseGroups = toGroups("loose", looseMap);
  const ocrGroups = toGroups("ocr", ocrMap);

  const strictRemoveCount = strictGroups.reduce((sum, group) => sum + group.remove.length, 0);
  const fileRemoveCount = fileGroups.reduce((sum, group) => sum + group.remove.length, 0);
  const looseRemoveCount = looseGroups.reduce((sum, group) => sum + group.remove.length, 0);
  const ocrRemoveCount = ocrGroups.reduce((sum, group) => sum + group.remove.length, 0);

  const selectedGroups =
    selectedMode === "strict"
      ? strictGroups
      : selectedMode === "loose"
        ? looseGroups
        : selectedMode === "ocr"
          ? ocrGroups
          : fileGroups;
  const selectedRemoveCount = selectedGroups.reduce((sum, group) => sum + group.remove.length, 0);

  return {
    mode: selectedMode,
    scanned: scopedResources.length,
    totalAvailable: allResources.length,
    recentLimit,
    strictGroupCount: strictGroups.length,
    strictRemoveCount,
    fileGroupCount: fileGroups.length,
    fileRemoveCount,
    looseGroupCount: looseGroups.length,
    looseRemoveCount,
    ocrGroupCount: ocrGroups.length,
    ocrRemoveCount,
    selectedGroupCount: selectedGroups.length,
    selectedRemoveCount,
    selectedGroups,
    strictGroups,
    fileGroups,
    looseGroups,
    ocrGroups,
  };
}

export async function deleteDuplicateResources(args?: {
  collegeId?: string | null;
  status?: string | null;
  pageSize?: number;
  maxPages?: number;
  maxDeletes?: number;
  mode?: DuplicateMode;
  recentLimit?: number | null;
}): Promise<DuplicateDeleteResult> {
  const scan = await scanDuplicateResources(args);

  const maxDeletes = Math.min(Math.max(args?.maxDeletes ?? 200, 1), 5000);
  let deletedCount = 0;
  let failedCount = 0;
  const failedIds: Array<{ id: string; reason: string }> = [];

  for (const group of scan.selectedGroups) {
    for (const row of group.remove) {
      if (deletedCount >= maxDeletes) {
        return {
          ...scan,
          deletedCount,
          failedCount,
          failedIds,
        };
      }

      try {
        await deleteAdminResource({
          resourceId: row.id,
          collegeId: row.college_id ?? args?.collegeId ?? null,
          idempotencyKey: `dedupe:${scan.mode}:${row.id}:${Date.now()}`,
        });
        deletedCount += 1;
      } catch (error) {
        failedCount += 1;
        failedIds.push({
          id: row.id,
          reason: error instanceof Error ? error.message : "delete_failed",
        });
      }
    }
  }

  return {
    ...scan,
    deletedCount,
    failedCount,
    failedIds,
  };
}
export async function postToStudyShare(args: {
  event: OpenClawDocumentEvent;
  classification: ClassificationResult;
  binding: GroupBinding;
  idempotencyKey: string;
}): Promise<PostResult> {
  const { event, classification, binding, idempotencyKey } = args;

  const youtubeUrl = extractYoutubeUrl(event.mediaUrl) || extractYoutubeUrl(event.caption);
  if (youtubeUrl) {
    if (classification.category === "resource" && config.studysharePostMode === "browser") {
      return postResourceViaBrowser({
        event,
        classification,
        binding,
        videoUrl: youtubeUrl,
      } as any);
    }

    const commonSource = {
      source_channel: "whatsapp_bot",
      source_group_jid: event.groupJid,
      source_message_id: event.messageId,
    };

    return postResource(
      {
        title:
          event.filename && event.filename !== "youtube-video"
            ? event.filename
            : classification.title || "Educational Video",
        description: classification.summary || event.caption,
        type: "video",
        fileUrl: null,
        videoUrl: youtubeUrl,
        branch: classification.branch ?? binding.default_branch,
        semester: classification.semester ?? binding.default_semester,
        subject: classification.subject ?? binding.default_subject,
        collegeId: binding.college_id,
        ...commonSource,
      },
      idempotencyKey,
    );
  }

  if (classification.category === "resource" && config.studysharePostMode === "browser") {
    return postResourceViaBrowser({
      event,
      classification,
      binding,
    });
  }

  const mediaBytes = await resolveEventMediaBytes(event);
  const uploadCategory =
    classification.category === "resource"
      ? "resource"
      : classification.category === "notice"
        ? "notice"
        : "syllabus";

  const uploadMeta = await getPresignedUpload(event.filename, uploadCategory, idempotencyKey);
  if (uploadMeta) {
    await uploadBinary(uploadMeta.uploadUrl, mediaBytes, uploadMeta.contentType);
  }
  const fileUrl = uploadMeta?.publicUrl ?? event.mediaUrl;
  if (!fileUrl) {
    throw new Error("post_failed:no_file_url_available");
  }

  const commonSource = {
    source_channel: "whatsapp_bot",
    source_group_jid: event.groupJid,
    source_message_id: event.messageId,
  };

  if (classification.category === "resource") {
    return postResource(
      {
        title: deriveOriginalTitle(event.filename),
        description: classification.summary,
        type: mapResourceType(event.filename, event.caption),
        fileUrl,
        branch: classification.branch ?? binding.default_branch,
        semester: classification.semester ?? binding.default_semester,
        subject: classification.subject ?? binding.default_subject,
        collegeId: binding.college_id,
        ...commonSource,
      },
      idempotencyKey,
    );
  }

  if (classification.category === "notice") {
    const noticePayload = {
      title: classification.title,
      content: classification.summary || (event.caption ?? ""),
      department: classification.department ?? binding.department_code,
      priority: classification.priority,
      fileUrl,
      fileType: event.mimeType ?? "application/pdf",
      collegeId: binding.college_id,
      ...commonSource,
    };

    const primary = await tryPrimaryNoticeEndpoint(noticePayload, idempotencyKey);
    if (primary) {
      return primary;
    }

    return callLegacyAdmin("create_notice", noticePayload, idempotencyKey);
  }

  const syllabusPayload = {
    title: classification.title,
    semester: classification.semester ?? binding.default_semester,
    branch: classification.branch ?? binding.default_branch,
    subject: classification.subject ?? binding.default_subject,
    description: classification.summary,
    pdfUrl: fileUrl,
    fileSize: mediaBytes.length,
    collegeId: binding.college_id,
    ...commonSource,
  };

  const primary = await tryPrimarySyllabusEndpoint(syllabusPayload, idempotencyKey);
  if (primary) {
    return primary;
  }

  return callLegacyAdmin("upload_syllabus", syllabusPayload, idempotencyKey);
}
