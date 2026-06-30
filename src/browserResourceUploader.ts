import { promises as fs } from "fs";
import path from "path";
import { chromium, type LaunchOptions } from "playwright-core";
import { config } from "./config.js";
import type { ClassificationResult, GroupBinding, OpenClawDocumentEvent } from "./types.js";
import { sleep } from "./utils.js";

type BrowserPostResult = {
  entityType: "resource";
  entityId: string;
};

type VerifiedAdminSession = {
  id: string;
  key_hash: string;
  admin_name: string;
  role: string | null;
  department: string | null;
  subject: string | null;
  college_id: string | null;
  capabilities: Record<string, boolean>;
  scope_all_colleges: boolean;
  scope_branches: string[];
  scope_subjects: string[];
  scope_semesters: string[];
};

type BrowserFilePayload = {
  base64: string;
  fileName: string;
  mimeType: string;
};

let browserUploadQueue = Promise.resolve();

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function deriveOriginalTitle(fileName: string): string {
  const raw = normalizeString(fileName);
  return raw || "Untitled.pdf";
}

function mapResourceType(fileName: string, caption?: string): "notes" | "pyq" {
  const text = `${fileName} ${caption ?? ""}`.toLowerCase();
  return text.includes("pyq") || text.includes("previous year") ? "pyq" : "notes";
}

function buildStoredSession(admin: VerifiedAdminSession) {
  return {
    id: admin.id,
    admin_name: admin.admin_name,
    role: admin.role,
    department: admin.department,
    subject: admin.subject,
    college_id: admin.college_id,
    capabilities: admin.capabilities,
    scope_all_colleges: admin.scope_all_colleges,
    scope_branches: admin.scope_branches,
    scope_subjects: admin.scope_subjects,
    scope_semesters: admin.scope_semesters,
    expires_at: Date.now() + 24 * 60 * 60 * 1000,
    logged_in_at: Date.now(),
  };
}

async function runWithBrowserUploadLock<T>(task: () => Promise<T>): Promise<T> {
  // Keep resource uploads serialized so one browser session cannot trample another.
  const next = browserUploadQueue.then(task, task);
  browserUploadQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function assertExecutablePath(executablePath: string): Promise<void> {
  if (!executablePath) {
    return;
  }
  await fs.access(executablePath);
}

function guessMimeType(fileName: string, fallback?: string): string {
  const normalizedFallback = normalizeString(fallback);
  if (normalizedFallback) {
    return normalizedFallback;
  }
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

function decodeBase64ToBuffer(input: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("browser_upload_missing_media");
  }

  if (trimmed.startsWith("data:")) {
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("browser_upload_invalid_data_url");
    }
    return Buffer.from(trimmed.slice(commaIndex + 1), "base64");
  }

  return Buffer.from(trimmed, "base64");
}

async function fetchBufferWithRetry(url: string): Promise<Buffer> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`browser_upload_download_failed:${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep((attempt + 1) * 1000);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("browser_upload_download_failed");
}

async function buildFilePayload(event: OpenClawDocumentEvent): Promise<BrowserFilePayload> {
  let buffer: Buffer;
  if (event.mediaBase64) {
    buffer = decodeBase64ToBuffer(event.mediaBase64);
  } else if (event.mediaPath) {
    buffer = await fs.readFile(event.mediaPath);
  } else if (event.mediaUrl) {
    buffer = await fetchBufferWithRetry(event.mediaUrl);
  } else {
    throw new Error("browser_upload_missing_media");
  }

  return {
    base64: buffer.toString("base64"),
    fileName: deriveOriginalTitle(event.filename),
    mimeType: guessMimeType(event.filename, event.mimeType),
  };
}

async function verifyAdminSession(): Promise<VerifiedAdminSession> {
  const response = await fetch(
    `${normalizeBaseUrl(config.STUDYSHARE_ADMIN_APP_BASE)}/api/admin/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: config.STUDYSHARE_ADMIN_BEARER }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    admin?: Partial<VerifiedAdminSession>;
    error?: string;
    success?: boolean;
  };

  if (!response.ok || payload.success === false || !payload.admin?.id || !payload.admin?.key_hash) {
    throw new Error(payload.error || `browser_admin_verify_failed:${response.status}`);
  }

  return {
    id: normalizeString(payload.admin.id),
    key_hash: normalizeString(payload.admin.key_hash),
    admin_name: normalizeString(payload.admin.admin_name),
    role: normalizeString(payload.admin.role) || null,
    department: normalizeString(payload.admin.department) || null,
    subject: normalizeString(payload.admin.subject) || null,
    college_id: normalizeString(payload.admin.college_id) || null,
    capabilities: payload.admin.capabilities ?? {},
    scope_all_colleges: payload.admin.scope_all_colleges === true,
    scope_branches: Array.isArray(payload.admin.scope_branches)
      ? payload.admin.scope_branches.map(String)
      : [],
    scope_subjects: Array.isArray(payload.admin.scope_subjects)
      ? payload.admin.scope_subjects.map(String)
      : [],
    scope_semesters: Array.isArray(payload.admin.scope_semesters)
      ? payload.admin.scope_semesters.map(String)
      : [],
  };
}

function resolveCollegeId(binding: GroupBinding, admin: VerifiedAdminSession): string {
  const collegeId =
    normalizeString(binding.college_id) ||
    normalizeString(config.STUDYSHARE_ADMIN_DEFAULT_COLLEGE_ID) ||
    normalizeString(admin.college_id);

  if (!collegeId && admin.role === "super_admin") {
    throw new Error("browser_upload_missing_college_id");
  }

  return collegeId;
}

function createLaunchOptions(): LaunchOptions {
  const launchOptions: LaunchOptions = {
    headless: config.studyshareBrowserHeadless,
    timeout: config.STUDYSHARE_BROWSER_TIMEOUT_MS,
    args: ["--disable-dev-shm-usage"],
  };

  if (process.platform === "linux") {
    launchOptions.args = ["--no-sandbox", ...(launchOptions.args ?? [])];
  }

  const executablePath = normalizeString(config.STUDYSHARE_BROWSER_EXECUTABLE_PATH);
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  return launchOptions;
}

export async function postResourceViaBrowser(args: {
  event: OpenClawDocumentEvent;
  classification: ClassificationResult;
  binding: GroupBinding;
  videoUrl?: string | null;
}): Promise<BrowserPostResult> {
  return runWithBrowserUploadLock(async () => {
    const isVideo = Boolean(args.videoUrl);
    const [admin, filePayload] = await Promise.all([
      verifyAdminSession(),
      isVideo ? null : buildFilePayload(args.event),
    ]);
    const collegeId = resolveCollegeId(args.binding, admin);
    const executablePath = normalizeString(config.STUDYSHARE_BROWSER_EXECUTABLE_PATH);
    await assertExecutablePath(executablePath);

    const browser = await chromium.launch(createLaunchOptions());
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(config.STUDYSHARE_BROWSER_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(config.STUDYSHARE_BROWSER_TIMEOUT_MS);

    try {
      const storedSession = buildStoredSession(admin);
      await page.addInitScript(
        ({ injectedSession, keyHash, selectedCollegeId }) => {
          localStorage.setItem("admin_session", JSON.stringify(injectedSession));
          if (selectedCollegeId) {
            localStorage.setItem("admin_selected_college", selectedCollegeId);
            localStorage.setItem(
              "admin_selected_college_meta",
              JSON.stringify({ id: selectedCollegeId, name: "", domain: "" }),
            );
          }
          sessionStorage.setItem("admin_session_key_hash", keyHash);
        },
        {
          injectedSession: storedSession,
          keyHash: admin.key_hash,
          selectedCollegeId: collegeId,
        },
      );

      await page.goto(config.STUDYSHARE_ADMIN_APP_BASE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const runtime = window as Window &
          typeof globalThis & {
            uploadToCloudinary?: (file: File, subfolder?: string) => Promise<string>;
            resolveApiUrl?: (path: string) => string;
            authFunctions?: {
              getAdminSession?: () => { key_hash?: string };
            };
          };
        return (
          (typeof runtime.uploadToCloudinary === "function" ||
            typeof runtime.resolveApiUrl === "function") &&
          typeof runtime.resolveApiUrl === "function" &&
          Boolean(runtime.authFunctions?.getAdminSession?.()?.key_hash) &&
          document.getElementById("dashboardPage")?.classList.contains("active") === true
        );
      });

      const resourceTitle = isVideo
        ? args.event.filename && args.event.filename !== "youtube-video"
          ? args.event.filename
          : args.classification.title || "Educational Video"
        : deriveOriginalTitle(args.event.filename);
      const resourceType = isVideo
        ? "video"
        : mapResourceType(args.event.filename, args.event.caption);
      const branch =
        normalizeString(args.classification.branch) || normalizeString(args.binding.default_branch);
      const semester =
        normalizeString(args.classification.semester) ||
        normalizeString(args.binding.default_semester);
      const subject =
        normalizeString(args.classification.subject) ||
        normalizeString(args.binding.default_subject);

      if (!branch || !semester || !subject) {
        throw new Error("browser_upload_missing_resource_mapping");
      }

      const uploadResult = await page.evaluate(
        async (params) => {
          const runtime = window as Window &
            typeof globalThis & {
              uploadToCloudinary?: (file: File, subfolder?: string) => Promise<string>;
              resolveApiUrl?: (path: string) => string;
              authFunctions?: {
                getAdminSession?: () => { key_hash?: string };
              };
            };
          if (typeof runtime.resolveApiUrl !== "function") {
            throw new Error("browser_upload_runtime_missing");
          }

          let fileUrl = null;
          if (!params.videoUrl) {
            if (typeof runtime.uploadToCloudinary !== "function") {
              throw new Error("browser_upload_runtime_missing");
            }
            const binary = atob(params.base64);
            const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            const file = new File([bytes], params.fileName, { type: params.mimeType });
            fileUrl = await runtime.uploadToCloudinary(file, "teacher-resources");
          }

          const adminKeyHash = runtime.authFunctions?.getAdminSession?.()?.key_hash || "";
          if (!adminKeyHash) {
            throw new Error("browser_upload_session_missing");
          }

          const response = await fetch(runtime.resolveApiUrl("/api/admin/resources"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${adminKeyHash}`,
            },
            body: JSON.stringify({
              title: params.title,
              type: params.type,
              description: params.description,
              fileUrl,
              videoUrl: params.videoUrl || null,
              branch: params.branch,
              semester: params.semester,
              subject: params.subject,
              chapter: null,
              topic: null,
              collegeId: params.collegeId,
            }),
          });

          const body = await response.json().catch(() => ({}));
          return {
            ok: response.ok,
            status: response.status,
            error:
              typeof body?.error === "string"
                ? body.error
                : typeof body?.message === "string"
                  ? body.message
                  : "",
            resourceId:
              typeof body?.resource?.id === "string"
                ? body.resource.id
                : typeof body?.id === "string"
                  ? body.id
                  : "",
          };
        },
        {
          ...(filePayload || { base64: "", fileName: "", mimeType: "" }),
          title: resourceTitle,
          type: resourceType,
          description: normalizeString(args.classification.summary) || null,
          branch,
          semester,
          subject,
          collegeId,
          videoUrl: args.videoUrl || null,
        },
      );

      if (!uploadResult.ok || !uploadResult.resourceId) {
        throw new Error(
          uploadResult.error ||
            `browser_resource_create_failed:${String(uploadResult.status || "unknown")}`,
        );
      }

      return {
        entityType: "resource",
        entityId: uploadResult.resourceId,
      };
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  });
}
