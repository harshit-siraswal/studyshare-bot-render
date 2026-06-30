import { planChatAction } from "./chatAgent.js";
import { config } from "./config.js";
import {
  getIngestDashboardStats,
  getPendingReviews,
  getRecentPostedResources,
  getReviewById,
  markPostedResourceRetracted,
} from "./db.js";
import { approveReview, rejectReview } from "./reviewService.js";
import {
  deleteAdminResource,
  deleteDuplicateResources,
  scanDuplicateResources,
  type DuplicateMode,
} from "./studyshareClient.js";

export interface ChatReply {
  text: string;
  meta?: Record<string, unknown>;
}

function helpText(): string {
  return [
    "StudyShareClaw control commands:",
    "/help - show commands",
    "/health - runtime health + integrations",
    "/status - pipeline stats (24h + pending)",
    "/pending - list pending review queue items",
    "/review <reviewId> - inspect one pending review payload",
    "/view <reviewId> - get direct file/view link for a review item",
    "/duplicates [strict|file|loose|ocr] [recent <count>] - scan duplicates (default: file, full set)",
    "/duplicates delete [strict|file|loose|ocr] [maxDeletes] [recent <count>] - delete by mode",
    "/approve <reviewId> - approve and post a queued item",
    "/reject <reviewId> [note] - reject a queued item",
    "/retract <resourceId> - retract one posted resource by id",
    "/retract last [count] [source] - retract most recent posted resources (default count: 5)",
    "",
    'Natural language mode: ask in plain English (e.g., "scan OCR duplicates for last 20 and remove them").',
    "If no command is used, message can be proxied to MOLTBOT_CHAT_WEBHOOK_URL when configured.",
  ].join("\n");
}

function normalizeNaturalLanguage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;

  const lower = trimmed.toLowerCase();

  if (/\b(help|commands|what can you do|how to use)\b/.test(lower)) {
    return "/help";
  }

  if (/\b(status|health|stats|statistics|pipeline status)\b/.test(lower)) {
    return "/status";
  }

  if (/\b(runtime health|service health|system health)\b/.test(lower)) {
    return "/health";
  }

  if (/\b(pending|review queue|queued items|manual review)\b/.test(lower)) {
    return "/pending";
  }

  const viewMatch = lower.match(/\b(view|open)\s+([a-f0-9-]{8,})\b/);
  if (viewMatch?.[2]) {
    return `/view ${viewMatch[2]}`;
  }

  const duplicateRecentMatch = lower.match(
    /\b(?:duplicate|duplicates|dedupe).*(?:recent|latest|last)\s+(\d{1,4})\b/,
  );
  if (duplicateRecentMatch?.[1]) {
    return `/duplicates recent ${duplicateRecentMatch[1]}`;
  }

  if (/\b(duplicate|duplicates|dedupe|remove duplicates)\b/.test(lower)) {
    return "/duplicates";
  }

  const approveMatch = lower.match(/\b(approve|accept|post)\s+([a-f0-9-]{8,})\b/);
  if (approveMatch?.[2]) {
    return `/approve ${approveMatch[2]}`;
  }

  const rejectMatch = lower.match(/\b(reject|deny|discard)\s+([a-f0-9-]{8,})(?:\s+(.+))?$/);
  if (rejectMatch?.[2]) {
    const note = rejectMatch[3]?.trim();
    return note ? `/reject ${rejectMatch[2]} ${note}` : `/reject ${rejectMatch[2]}`;
  }

  const retractLastMatch = lower.match(
    /\b(retract|delete|remove)\s+(last|latest)\s+(\d{1,2})(?:\s+(whatsapp|drive))?\b/,
  );
  if (retractLastMatch?.[3]) {
    const count = retractLastMatch[3];
    const source = retractLastMatch[4] ? ` ${retractLastMatch[4]}` : "";
    return `/retract last ${count}${source}`;
  }

  const retractIdMatch = lower.match(/\b(retract|delete|remove)\s+([a-f0-9-]{8,})\b/);
  if (retractIdMatch?.[2]) {
    return `/retract ${retractIdMatch[2]}`;
  }

  return trimmed;
}

function resolveReviewViewTarget(payload: Record<string, any>): string | null {
  const event = payload?.event ?? {};
  const current = payload?.current ?? {};
  const proposed = payload?.proposedMapping ?? {};

  const candidates: unknown[] = [
    event.mediaUrl,
    current.fileUrl,
    current.file_url,
    proposed.fileUrl,
    proposed.file_url,
  ];

  for (const candidate of candidates) {
    const url = typeof candidate === "string" ? candidate.trim() : "";
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
  }

  const mediaBase64 = typeof event.mediaBase64 === "string" ? event.mediaBase64.trim() : "";
  if (mediaBase64) {
    if (mediaBase64.startsWith("data:")) {
      return mediaBase64;
    }
    const mimeType =
      typeof event.mimeType === "string" && event.mimeType.trim()
        ? event.mimeType
        : "application/pdf";
    return `data:${mimeType};base64,${mediaBase64}`;
  }

  return null;
}

function parseDuplicateMode(raw: string | undefined): DuplicateMode | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (value === "strict" || value === "file" || value === "loose" || value === "ocr") return value;
  return null;
}

function parsePositiveInt(raw: string | undefined, min: number, max: number): number | null {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  if (rounded < min) return null;
  return Math.min(rounded, max);
}

function parseDuplicateCommandArgs(
  tokens: string[],
  options: { allowDelete: boolean; defaultMode?: DuplicateMode; defaultMaxDeletes?: number },
): { mode: DuplicateMode; recentLimit: number | null; maxDeletes: number } {
  const defaultMode = options.defaultMode ?? "file";
  const defaultMaxDeletes = options.defaultMaxDeletes ?? 200;

  let mode: DuplicateMode = defaultMode;
  let recentLimit: number | null = null;
  let maxDeletes = defaultMaxDeletes;
  let hasMaxDeletes = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] ?? "")
      .trim()
      .toLowerCase();
    if (!token) continue;

    const parsedMode = parseDuplicateMode(token);
    if (parsedMode) {
      mode = parsedMode;
      continue;
    }

    if (token === "recent" || token === "latest" || token === "last") {
      const value = parsePositiveInt(tokens[i + 1], 1, 5000);
      if (value != null) {
        recentLimit = value;
        i += 1;
      }
      continue;
    }

    const numericValue = parsePositiveInt(token, 1, 5000);
    if (numericValue == null) continue;

    if (options.allowDelete && !hasMaxDeletes) {
      maxDeletes = Math.min(Math.max(numericValue, 1), 5000);
      hasMaxDeletes = true;
      continue;
    }

    if (recentLimit == null) {
      recentLimit = numericValue;
    }
  }

  return { mode, recentLimit, maxDeletes };
}

async function proxyToWebhook(message: string): Promise<ChatReply> {
  if (!config.MOLTBOT_CHAT_WEBHOOK_URL) {
    return {
      text: "No external chat webhook configured. Use /help for built-in workflow commands.",
    };
  }

  const response = await fetch(config.MOLTBOT_CHAT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return { text: `Webhook chat failed (${response.status}): ${detail}` };
  }

  const payload = (await response.json()) as { text?: string; reply?: string; message?: string };
  return {
    text:
      payload.text ?? payload.reply ?? payload.message ?? "Webhook responded with empty message.",
    meta: payload as Record<string, unknown>,
  };
}

async function tryChatAgentRoute(message: string): Promise<ChatReply | null> {
  if (!config.enableChatAgent || !config.GEMINI_API_KEY) {
    return null;
  }

  try {
    const stats = await getIngestDashboardStats().catch(() => null);
    const plan = await planChatAction(message, { stats });

    if (plan.type === "answer") {
      return {
        text: plan.answer ?? "No actionable command found.",
        meta: {
          agent: true,
          plannerType: "answer",
          confidence: plan.confidence ?? null,
        },
      };
    }

    const command = String(plan.command ?? "").trim();
    if (!command.startsWith("/")) {
      return null;
    }

    const executed = await handleChatMessage(command);
    return {
      ...executed,
      meta: {
        ...(executed.meta ?? {}),
        agent: true,
        plannerType: "command",
        plannerCommand: command,
        plannerConfidence: plan.confidence ?? null,
      },
    };
  } catch {
    return null;
  }
}

export async function handleChatMessage(rawMessage: string): Promise<ChatReply> {
  const message = rawMessage.trim();
  if (!message) {
    return { text: "Send a command or message. Use /help." };
  }

  if (!message.startsWith("/")) {
    const agentReply = await tryChatAgentRoute(message);
    if (agentReply) {
      return agentReply;
    }
  }

  const normalized = normalizeNaturalLanguage(message);
  const [commandRaw, ...rest] = normalized.split(" ");
  const command = commandRaw.toLowerCase();

  if (command === "/help") {
    return { text: helpText() };
  }

  if (command === "/status") {
    const stats = await getIngestDashboardStats();
    return {
      text: [
        "Pipeline status:",
        `- Received (24h): ${stats.received24h}`,
        `- Posted (24h): ${stats.posted24h}`,
        `- Failed (24h): ${stats.failed24h}`,
        `- Pending review: ${stats.pendingReviews}`,
      ].join("\n"),
      meta: stats as unknown as Record<string, unknown>,
    };
  }

  if (command === "/health") {
    return {
      text: [
        "Runtime health:",
        "- Service: online",
        `- Uptime: ${Math.floor(process.uptime())}s`,
        `- LLM classifier: ${config.enableLlmClassifier ? "enabled" : "disabled"}`,
        `- Chat agent: ${config.enableChatAgent ? "enabled" : "disabled"}`,
        `- Chat webhook: ${config.MOLTBOT_CHAT_WEBHOOK_URL ? "configured" : "not configured"}`,
        `- Review notify webhook: ${config.MOLTBOT_REVIEW_NOTIFY_WEBHOOK_URL ? "configured" : "not configured"}`,
      ].join("\n"),
      meta: {
        uptimeSeconds: Math.floor(process.uptime()),
        llmEnabled: config.enableLlmClassifier,
        chatAgentEnabled: config.enableChatAgent,
        chatWebhookConfigured: Boolean(config.MOLTBOT_CHAT_WEBHOOK_URL),
        reviewWebhookConfigured: Boolean(config.MOLTBOT_REVIEW_NOTIFY_WEBHOOK_URL),
      },
    };
  }

  if (command === "/pending") {
    const items = await getPendingReviews(10);
    if (!items.length) {
      return { text: "No pending manual review items." };
    }

    const lines = items.map(
      (item, idx) =>
        `${idx + 1}. ${item.id} | event=${item.ingest_event_id} | category=${item.proposed_category ?? "n/a"} | confidence=${item.confidence ?? "n/a"}`,
    );

    return {
      text: ["Pending reviews (top 10):", ...lines].join("\n"),
      meta: { count: items.length, items },
    };
  }

  if (command === "/duplicates") {
    const subcommand = (rest[0] ?? "").trim().toLowerCase();
    if (subcommand === "delete" || subcommand === "remove") {
      const parsed = parseDuplicateCommandArgs(rest.slice(1), {
        allowDelete: true,
        defaultMode: "file",
        defaultMaxDeletes: 200,
      });
      const result = await deleteDuplicateResources({
        status: "approved",
        mode: parsed.mode,
        maxDeletes: parsed.maxDeletes,
        recentLimit: parsed.recentLimit,
      });

      return {
        text: [
          "Duplicate delete result:",
          `- mode: ${result.mode}`,
          `- scanned: ${result.scanned}`,
          `- scope: ${result.recentLimit ? `latest ${result.recentLimit} of ${result.totalAvailable}` : `all ${result.totalAvailable}`}`,
          `- strict duplicate groups: ${result.strictGroupCount}`,
          `- strict duplicate candidates: ${result.strictRemoveCount}`,
          `- file duplicate groups: ${result.fileGroupCount}`,
          `- file duplicate candidates: ${result.fileRemoveCount}`,
          `- loose duplicate groups: ${result.looseGroupCount}`,
          `- loose duplicate candidates: ${result.looseRemoveCount}`,
          `- ocr duplicate groups: ${result.ocrGroupCount}`,
          `- ocr duplicate candidates: ${result.ocrRemoveCount}`,
          `- selected groups (${result.mode}): ${result.selectedGroupCount}`,
          `- selected candidates (${result.mode}): ${result.selectedRemoveCount}`,
          `- deleted: ${result.deletedCount}`,
          `- failed: ${result.failedCount}`,
        ].join("\n"),
        meta: result as unknown as Record<string, unknown>,
      };
    }

    const parsed = parseDuplicateCommandArgs(rest, { allowDelete: false, defaultMode: "file" });
    const scan = await scanDuplicateResources({
      status: "approved",
      mode: parsed.mode,
      recentLimit: parsed.recentLimit,
    });
    if (!scan.selectedGroupCount) {
      return {
        text: [
          "Duplicate scan complete.",
          `- mode: ${scan.mode}`,
          `- scanned: ${scan.scanned}`,
          `- scope: ${scan.recentLimit ? `latest ${scan.recentLimit} of ${scan.totalAvailable}` : `all ${scan.totalAvailable}`}`,
          `- strict duplicates: ${scan.strictGroupCount}`,
          `- file duplicates: ${scan.fileGroupCount}`,
          `- loose duplicates: ${scan.looseGroupCount}`,
          `- ocr duplicates: ${scan.ocrGroupCount}`,
          `- selected duplicates (${scan.mode}): 0`,
        ].join("\n"),
        meta: scan as unknown as Record<string, unknown>,
      };
    }

    const preview = scan.selectedGroups.slice(0, 8).map((group, index) => {
      const keepId = group.keep.id;
      const removeIds = group.remove.map((item) => item.id).join(", ");
      return `${index + 1}. [${group.mode}] keep=${keepId} | remove=[${removeIds}] | title="${group.keep.title}"`;
    });

    return {
      text: [
        `Duplicate scan complete (${scan.mode} mode):`,
        `- scanned: ${scan.scanned}`,
        `- scope: ${scan.recentLimit ? `latest ${scan.recentLimit} of ${scan.totalAvailable}` : `all ${scan.totalAvailable}`}`,
        `- strict duplicate groups: ${scan.strictGroupCount}`,
        `- strict duplicate candidates: ${scan.strictRemoveCount}`,
        `- file duplicate groups: ${scan.fileGroupCount}`,
        `- file duplicate candidates: ${scan.fileRemoveCount}`,
        `- loose duplicate groups: ${scan.looseGroupCount}`,
        `- loose duplicate candidates: ${scan.looseRemoveCount}`,
        `- ocr duplicate groups: ${scan.ocrGroupCount}`,
        `- ocr duplicate candidates: ${scan.ocrRemoveCount}`,
        `- selected groups (${scan.mode}): ${scan.selectedGroupCount}`,
        `- selected candidates (${scan.mode}): ${scan.selectedRemoveCount}`,
        "",
        "Preview (top 8):",
        ...preview,
        "",
        `Run \`/duplicates delete ${scan.mode}\` to remove selected duplicates.`,
      ].join("\n"),
      meta: scan as unknown as Record<string, unknown>,
    };
  }

  if (command === "/review") {
    const reviewId = rest[0];
    if (!reviewId) {
      return { text: "Usage: /review <reviewId>" };
    }

    const row = await getReviewById(reviewId);
    if (!row) {
      return { text: `Review ${reviewId} not found.` };
    }

    const payload = (row.payload_json ?? {}) as Record<string, any>;
    const summary = {
      id: row.id,
      status: row.status,
      ingestEventId: row.ingest_event_id,
      category: row.proposed_category,
      confidence: row.confidence,
      title: payload.title ?? payload?.proposedMapping?.title ?? null,
      fileName: payload?.event?.filename ?? null,
      groupTitle: payload?.event?.groupTitle ?? null,
      branch: payload?.proposedMapping?.branch ?? payload?.binding?.default_branch ?? null,
      semester: payload?.proposedMapping?.semester ?? payload?.binding?.default_semester ?? null,
      subject: payload?.proposedMapping?.subject ?? payload?.binding?.default_subject ?? null,
    };

    return {
      text: [
        `Review ${row.id}`,
        `- status: ${summary.status}`,
        `- ingestEventId: ${summary.ingestEventId}`,
        `- category: ${summary.category ?? "n/a"} (confidence=${summary.confidence ?? "n/a"})`,
        `- title: ${summary.title ?? "n/a"}`,
        `- file: ${summary.fileName ?? "n/a"}`,
        `- group: ${summary.groupTitle ?? "n/a"}`,
        `- mapping: branch=${summary.branch ?? "n/a"}, sem=${summary.semester ?? "n/a"}, subject=${summary.subject ?? "n/a"}`,
      ].join("\n"),
      meta: {
        ...summary,
        viewUrl: resolveReviewViewTarget(payload),
        payload,
      },
    };
  }

  if (command === "/view") {
    const reviewId = rest[0];
    if (!reviewId) {
      return { text: "Usage: /view <reviewId>" };
    }

    const row = await getReviewById(reviewId);
    if (!row) {
      return { text: `Review ${reviewId} not found.` };
    }

    const payload = (row.payload_json ?? {}) as Record<string, any>;
    const viewUrl = resolveReviewViewTarget(payload);
    if (!viewUrl) {
      return {
        text: `No direct media link found for review ${reviewId}.`,
        meta: { reviewId, viewUrl: null, payload },
      };
    }

    return {
      text: `View link for ${reviewId}:\n${viewUrl}`,
      meta: { reviewId, viewUrl },
    };
  }

  if (command === "/approve") {
    const reviewId = rest[0];
    if (!reviewId) {
      return { text: "Usage: /approve <reviewId>" };
    }

    const result = await approveReview(reviewId, "chat-ui");
    return {
      text: `Approved and posted: ${result.entityType} ${result.entityId}`,
      meta: result,
    };
  }

  if (command === "/reject") {
    const reviewId = rest[0];
    if (!reviewId) {
      return { text: "Usage: /reject <reviewId> [note]" };
    }

    const note = rest.slice(1).join(" ").trim() || "Rejected from chat UI";
    await rejectReview(reviewId, "chat-ui", note);
    return {
      text: `Rejected review ${reviewId}`,
      meta: { reviewId, note },
    };
  }

  if (command === "/retract") {
    const target = (rest[0] ?? "").trim();
    if (!target) {
      return { text: "Usage: /retract <resourceId> OR /retract last [count] [source]" };
    }

    if (target.toLowerCase() === "last" || target.toLowerCase() === "latest") {
      const countRaw = Number(rest[1] ?? 5);
      const count = Number.isFinite(countRaw) ? Math.min(Math.max(countRaw, 1), 30) : 5;
      const source = String(rest[2] ?? "")
        .trim()
        .toLowerCase();
      const senderLike = source === "drive" ? "gdrive" : source === "whatsapp" ? "whatsapp" : null;

      const recent = await getRecentPostedResources(count, senderLike);
      if (!recent.length) {
        return {
          text: `No recently posted resources found${senderLike ? ` for source=${source}` : ""}.`,
        };
      }

      const outcome: Array<{
        resourceId: string;
        title: string | null;
        ok: boolean;
        error?: string;
      }> = [];
      for (let i = 0; i < recent.length; i += 1) {
        const row = recent[i];
        try {
          await deleteAdminResource({
            resourceId: row.resource_id,
            collegeId: null,
            idempotencyKey: `chat:retract:last:${row.resource_id}:${Date.now()}:${i}`,
          });
          await markPostedResourceRetracted(row.resource_id, "chat-ui");
          outcome.push({ resourceId: row.resource_id, title: row.title ?? null, ok: true });
        } catch (error) {
          outcome.push({
            resourceId: row.resource_id,
            title: row.title ?? null,
            ok: false,
            error: error instanceof Error ? error.message : "unknown_error",
          });
        }
      }

      const success = outcome.filter((row) => row.ok);
      const failed = outcome.filter((row) => !row.ok);
      return {
        text: [
          `Retract last ${count}${source ? ` (${source})` : ""}:`,
          `- matched: ${recent.length}`,
          `- retracted: ${success.length}`,
          `- failed: ${failed.length}`,
          "",
          ...success
            .slice(0, 10)
            .map((row, idx) => `${idx + 1}. ${row.resourceId} | ${row.title ?? "Untitled"}`),
          ...(failed.length
            ? [
                "",
                "Failures:",
                ...failed
                  .slice(0, 10)
                  .map((row) => `- ${row.resourceId}: ${row.error ?? "unknown_error"}`),
              ]
            : []),
        ].join("\n"),
        meta: { count, source: source || null, outcome },
      };
    }

    const resourceId = target;
    await deleteAdminResource({
      resourceId,
      collegeId: null,
      idempotencyKey: `chat:retract:single:${resourceId}:${Date.now()}`,
    });
    const touched = await markPostedResourceRetracted(resourceId, "chat-ui");
    return {
      text: `Retracted resource ${resourceId} (events updated: ${touched})`,
      meta: { resourceId, touchedEvents: touched },
    };
  }

  return proxyToWebhook(message);
}
