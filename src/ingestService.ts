import { z } from "zod";
import { sendOpsAlert, sendReviewApprovalRequest } from "./alert.js";
import {
  classifyDocument,
  detectSubjectFromCatalog,
  normalizeSubjectFromCatalog,
} from "./classification.js";
import { config } from "./config.js";
import {
  createIngestEvent,
  enqueueManualReview,
  getGroupBinding,
  getPostIdempotency,
  markEventPosted,
  savePostIdempotency,
  updateEventClassification,
  updateEventStatus,
} from "./db.js";
import { inferDrivePathMapping, isStructuredDriveImport } from "./drivePathInference.js";
import { extractPdfFromEvent } from "./pdfExtractor.js";
import { postToStudyShare } from "./studyshareClient.js";
import { ClassificationResult, OpenClawDocumentEvent } from "./types.js";
import { buildIdempotencyKey, isPdfFilename, sha256, extractYoutubeUrl } from "./utils.js";

const eventSchema = z
  .object({
    messageId: z.string().min(1),
    groupJid: z.string().min(1),
    groupTitle: z.string().optional(),
    sender: z.string().optional(),
    filename: z.string().min(1),
    mimeType: z.string().optional(),
    caption: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mediaBase64: z.string().optional(),
    mediaPath: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mediaUrl || value.mediaBase64 || value.mediaPath) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mediaUrl"],
      message: "Either mediaUrl, mediaBase64, or mediaPath must be provided",
    });
  });

function isConfidenceValid(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function makeManualReviewClassification(
  category: ClassificationResult["category"],
): ClassificationResult {
  return {
    category,
    confidence: 0.1,
    title: "Manual review required",
    summary: "The document needs operator review before posting.",
    department: null,
    branch: null,
    semester: null,
    subject: null,
    priority: "normal",
    source: "rules",
  };
}

function isNonRetryablePostError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /:(400|401|403|404|405|409|422):/.test(error.message);
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AIML_SEMESTER_SUBJECTS: Record<string, string[]> = {
  "1": [
    "Calculus for Engineers",
    "Semiconductor Physics and Devices",
    "Programming for Problem Solving",
    "Discrete Structures and Theory of Logic",
    "Computer Organization and Logic Design",
    "Design Thinking",
    "Introduction to IoT",
    "Semiconductor Physics and Devices Lab",
    "Computer Organization and Logic Design Lab",
    "Programming for Problem Solving Lab",
    "Web Designing",
    "Communication Skills",
    "Foreign Language",
    "Indian Knowledge System",
  ],
  "2": [
    "Basic Proficiency in Spanish",
    "Computer Organization and Logic Design",
    "Computer Organization and Logic Design Lab",
    "Data Structure",
    "Environmental Chemistry",
    "Linear Algebra for Engineers",
    "Python for Engineers",
    "Innovation and Entrepreneurship",
    "Introduction to AI",
  ],
};

const aimlSubjectSemesterIndex = (() => {
  const index = new Map<string, Set<string>>();
  for (const [semester, subjects] of Object.entries(AIML_SEMESTER_SUBJECTS)) {
    for (const subject of subjects) {
      const key = normalizeForMatch(subject);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key)?.add(semester);
    }
  }
  return index;
})();

function detectSemesterFromText(signalParts: string[]): string | null {
  const text = normalizeForMatch(signalParts.filter(Boolean).join(" "));
  if (!text) return null;

  const patterns: Array<[RegExp, string]> = [
    [/\bsemester\s*1\b|\bsem\s*1\b|\b1st\s*sem\b/, "1"],
    [/\bsemester\s*2\b|\bsem\s*2\b|\b2nd\s*sem\b/, "2"],
    [/\bsemester\s*3\b|\bsem\s*3\b|\b3rd\s*sem\b/, "3"],
    [/\bsemester\s*4\b|\bsem\s*4\b|\b4th\s*sem\b/, "4"],
    [/\bsemester\s*5\b|\bsem\s*5\b|\b5th\s*sem\b/, "5"],
    [/\bsemester\s*6\b|\bsem\s*6\b|\b6th\s*sem\b/, "6"],
    [/\bsemester\s*7\b|\bsem\s*7\b|\b7th\s*sem\b/, "7"],
    [/\bsemester\s*8\b|\bsem\s*8\b|\b8th\s*sem\b/, "8"],
  ];

  for (const [pattern, semester] of patterns) {
    if (pattern.test(text)) return semester;
  }
  return null;
}

function normalizeBranchForSemesterInference(branch: string | null | undefined): string {
  const normalized = normalizeForMatch(branch ?? "");
  if (["aiml", "cse aiml", "cse_aiml", "cse-aiml"].includes(normalized)) {
    return "aiml";
  }
  if (["cse ai", "cse_ai", "cse-ai"].includes(normalized)) {
    return "aiml";
  }
  return normalized;
}

function inferSemesterForResource(
  classification: ClassificationResult,
  signalParts: string[],
): string | null {
  const explicitSemester = classification.semester?.trim();
  if (explicitSemester && /^[1-8]$/.test(explicitSemester)) {
    return explicitSemester;
  }

  const semesterFromText = detectSemesterFromText(signalParts);
  if (semesterFromText) return semesterFromText;

  const normalizedBranch = normalizeBranchForSemesterInference(classification.branch);
  if (normalizedBranch !== "aiml") return explicitSemester ?? null;

  const normalizedSubject = normalizeForMatch(classification.subject ?? "");
  if (!normalizedSubject) return null;

  const semesters = aimlSubjectSemesterIndex.get(normalizedSubject);
  if (!semesters || semesters.size !== 1) return null;

  return [...semesters][0] ?? null;
}

function isResourceUseful(signalParts: string[]): boolean {
  const text = normalizeForMatch(signalParts.filter(Boolean).join(" "));
  if (!text) return false;

  const usefulSignals = [
    "notes",
    "study material",
    "unit",
    "chapter",
    "module",
    "lecture",
    "handout",
    "tutorial",
    "assignment",
    "question bank",
    "pyq",
    "previous year",
    "lab manual",
    "worksheet",
    "slides",
    "syllabus",
    "important questions",
    "mid sem",
    "end sem",
  ];

  const nonUsefulSignals = [
    "receipt",
    "fee receipt",
    "fees receipt",
    "payment receipt",
    "bank slip",
    "invoice",
    "certificate",
    "id card",
    "aadhaar",
    "pan card",
    "birthday",
    "invitation",
    "admission form",
    "leave application",
    "selfie",
    "photo",
    "wallpaper",
    "meme",
    "sticker",
  ];

  const hasUsefulSignal = usefulSignals.some((keyword) => text.includes(keyword));
  const hasNonUsefulSignal = nonUsefulSignals.some((keyword) => text.includes(keyword));

  // If there is clear non-study intent and no useful study signal, skip posting.
  if (hasNonUsefulSignal && !hasUsefulSignal) {
    return false;
  }

  // Documents with enough educational content generally exceed this word count.
  const approxWordCount = text.split(" ").filter(Boolean).length;
  return hasUsefulSignal || approxWordCount >= 60;
}

function isLikelyAdministrativeDoc(signalParts: string[]): boolean {
  const text = normalizeForMatch(signalParts.filter(Boolean).join(" "));
  if (!text) return false;
  return [
    "rules",
    "regulation",
    "regulations",
    "policy",
    "policies",
    "notice",
    "circular",
    "datesheet",
    "date sheet",
    "schedule",
    "exam schedule",
    "holiday",
    "attendance policy",
    "ordinance",
  ].some((token) => text.includes(token));
}

function getAllowedCategories(binding: Awaited<ReturnType<typeof getGroupBinding>>): Set<string> {
  const defaults = ["syllabus", "resource", "notice"];
  const raw = binding?.allowed_categories?.length ? binding.allowed_categories : defaults;
  const normalized = raw.map((entry) => {
    const token = entry.toLowerCase().trim();
    if (token === "resources") return "resource";
    if (token === "notices") return "notice";
    if (token === "syllabi" || token === "syllabuses") return "syllabus";
    return token;
  });
  return new Set(normalized);
}

function applyBindingDefaults(
  classification: ClassificationResult,
  binding: NonNullable<Awaited<ReturnType<typeof getGroupBinding>>>,
): ClassificationResult {
  return {
    ...classification,
    department: classification.department ?? binding.department_code,
    branch: classification.branch ?? binding.default_branch,
    semester: classification.semester ?? binding.default_semester,
    subject: classification.subject ?? binding.default_subject,
  };
}

async function queueManualReviewWithNotification(args: {
  eventId: string;
  classification: ClassificationResult;
  payload: Record<string, unknown>;
  reason: string;
  event: OpenClawDocumentEvent;
  binding: NonNullable<Awaited<ReturnType<typeof getGroupBinding>>>;
}): Promise<string> {
  const reviewId = await enqueueManualReview(args.eventId, args.classification, args.payload);
  if (reviewId) {
    await sendReviewApprovalRequest({
      reviewId,
      eventId: args.eventId,
      reason: args.reason,
      groupJid: args.event.groupJid,
      groupTitle: args.binding.group_title,
      fileName: args.event.filename,
      category: args.classification.category,
      confidence: args.classification.confidence,
    });
  }
  return reviewId;
}

export async function ingestOpenClawEvent(rawEvent: unknown): Promise<{
  status: string;
  eventId?: string;
  reason?: string;
}> {
  const event = eventSchema.parse(rawEvent) as OpenClawDocumentEvent;
  const payloadForAudit = event.mediaBase64
    ? {
        ...(rawEvent as Record<string, unknown>),
        mediaBase64: `[redacted:${Math.ceil(event.mediaBase64.length / 1024)}KB]`,
      }
    : (rawEvent as Record<string, unknown>);

  const youtubeUrl = extractYoutubeUrl(event.mediaUrl) || extractYoutubeUrl(event.caption);

  // Placeholder hash to construct idempotency key before download.
  const preHash = youtubeUrl
    ? sha256(youtubeUrl)
    : sha256(`${event.groupJid}:${event.messageId}:${event.filename}`);
  const preIdempotencyKey = buildIdempotencyKey(event.groupJid, event.messageId, preHash);

  const created = await createIngestEvent({
    event,
    idempotencyKey: preIdempotencyKey,
    fileSha256: preHash,
    payload: payloadForAudit,
  });

  if (created.duplicate) {
    return { status: "duplicate", eventId: created.id, reason: "Duplicate idempotency key" };
  }

  const binding = await getGroupBinding(event.groupJid);
  if (!binding) {
    await updateEventStatus(
      created.id,
      "ignored",
      "unmapped_group",
      "No active group binding found",
    );
    await sendOpsAlert("Unmapped WhatsApp group event", {
      groupJid: event.groupJid,
      groupTitle: event.groupTitle,
      messageId: event.messageId,
    });
    return { status: "ignored", eventId: created.id, reason: "unmapped_group" };
  }

  let fileSha256 = preHash;
  let extracted: Awaited<ReturnType<typeof extractPdfFromEvent>>["extracted"];

  if (youtubeUrl) {
    extracted = {
      heading:
        event.filename && event.filename !== "youtube-video" ? event.filename : "Educational Video",
      textSample: event.caption || "",
      fullTextSample: event.caption || "",
      textHash: fileSha256,
      extractionMode: "text",
      isEmpty: false,
    } as any;
  } else {
    if (!isPdfFilename(event.filename)) {
      const nonPdfSignalParts = [event.filename, event.caption ?? ""];
      if (!isResourceUseful(nonPdfSignalParts)) {
        await updateEventStatus(
          created.id,
          "ignored",
          "filtered_non_useful_resource",
          "Non-PDF attachment did not match study-resource signals",
        );
        return { status: "ignored", eventId: created.id, reason: "filtered_non_useful_resource" };
      }

      const fallback = makeManualReviewClassification("notice");
      await updateEventStatus(
        created.id,
        "failed",
        "unsupported_file_type",
        "Only PDF files are auto-processed",
      );
      await queueManualReviewWithNotification({
        eventId: created.id,
        classification: fallback,
        reason: "unsupported_file_type",
        event,
        binding,
        payload: {
          reason: "unsupported_file_type",
          event,
          binding,
        },
      });
      return { status: "queued_review", eventId: created.id, reason: "unsupported_file_type" };
    }

    try {
      const extraction = await extractPdfFromEvent(event, sha256);
      fileSha256 = extraction.fileSha256;
      extracted = extraction.extracted;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown extraction error";
      const mappedCode = detail.includes("pdf_password_protected")
        ? "pdf_password_protected"
        : detail.includes("download_failed")
          ? "download_failed"
          : "extraction_failed";

      await updateEventStatus(created.id, "failed", mappedCode, detail);
      await queueManualReviewWithNotification({
        eventId: created.id,
        classification: makeManualReviewClassification("notice"),
        reason: mappedCode,
        event,
        binding,
        payload: {
          reason: mappedCode,
          event,
          binding,
          detail,
        },
      });

      return { status: "queued_review", eventId: created.id, reason: mappedCode };
    }
  }

  const finalIdempotencyKey = buildIdempotencyKey(event.groupJid, event.messageId, fileSha256);

  if (extracted.isEmpty) {
    await updateEventStatus(
      created.id,
      "failed",
      "extraction_empty",
      "PDF extraction returned empty text",
    );
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification: makeManualReviewClassification("resource"),
      reason: "extraction_empty",
      event,
      binding,
      payload: {
        reason: "extraction_empty",
        event,
        binding,
      },
    });
    return { status: "queued_review", eventId: created.id, reason: "extraction_empty" };
  }

  let classification: ClassificationResult;
  try {
    classification = await classifyDocument({
      event,
      heading: extracted.heading,
      textSample: extracted.textSample,
      fullTextSample: extracted.fullTextSample,
      groupBinding: binding,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "classification error";
    await updateEventStatus(created.id, "failed", "classification_failed", detail);
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification: makeManualReviewClassification("resource"),
      reason: "classification_failed",
      event,
      binding,
      payload: {
        reason: "classification_failed",
        event,
        binding,
        detail,
        extractedHeading: extracted.heading,
        extractedTextSample: extracted.textSample,
      },
    });
    return { status: "queued_review", eventId: created.id, reason: "classification_failed" };
  }

  classification = applyBindingDefaults(classification, binding);
  if (youtubeUrl) {
    classification.category = "resource";
    if (!classification.title || classification.title === "Manual review required") {
      classification.title =
        event.filename && event.filename !== "youtube-video" ? event.filename : "Educational Video";
    }
  }

  const driveStructuredImport = isStructuredDriveImport(event);
  const driveInference = inferDrivePathMapping({
    event,
    heading: extracted.heading,
    textSample: extracted.textSample,
    fallbackBranch: binding.default_branch,
  });

  if (
    driveStructuredImport &&
    classification.category !== "resource" &&
    !isLikelyAdministrativeDoc([event.filename, event.caption ?? "", extracted.heading])
  ) {
    classification = {
      ...classification,
      category: "resource",
      priority: "normal",
      confidence: Math.max(classification.confidence, 0.82),
      source: "rules",
      summary: (classification.summary || "Drive import auto-routed as resource").slice(0, 280),
    };
  }

  if (driveStructuredImport && classification.category === "resource") {
    if (driveInference.branch) {
      classification.branch = driveInference.branch;
    }
    if (driveInference.semester) {
      classification.semester = driveInference.semester;
    }
    if (driveInference.subject) {
      classification.subject = driveInference.subject;
    }
    classification.confidence = Math.max(classification.confidence, 0.92);
    classification.source = "rules";
  }

  const allowedCategories = getAllowedCategories(binding);
  if (!allowedCategories.has(classification.category)) {
    await updateEventStatus(
      created.id,
      "ignored",
      "filtered_by_group_policy",
      `Category ${classification.category} is disabled for this group`,
    );
    return { status: "ignored", eventId: created.id, reason: "filtered_by_group_policy" };
  }

  const signalParts = [
    event.filename,
    event.caption ?? "",
    extracted.heading,
    extracted.textSample,
    extracted.fullTextSample,
  ];

  if (
    classification.category === "resource" &&
    binding.only_useful_resources &&
    !isResourceUseful(signalParts)
  ) {
    await updateEventStatus(
      created.id,
      "ignored",
      "filtered_non_useful_resource",
      "Resource did not pass usefulness gate",
    );
    return { status: "ignored", eventId: created.id, reason: "filtered_non_useful_resource" };
  }

  if (classification.category === "resource" && binding.subject_catalog?.length) {
    const normalizedFromDrive =
      driveStructuredImport && driveInference.subject
        ? normalizeSubjectFromCatalog(driveInference.subject, binding.subject_catalog)
        : null;
    const normalizedFromClassifier = normalizeSubjectFromCatalog(
      classification.subject,
      binding.subject_catalog,
    );
    const detectedFromText = detectSubjectFromCatalog(signalParts, binding.subject_catalog);
    classification.subject =
      normalizedFromDrive ??
      normalizedFromClassifier ??
      detectedFromText ??
      (driveStructuredImport
        ? (driveInference.subject ?? classification.subject)
        : classification.subject);
  }

  if (classification.category === "resource") {
    classification.semester = inferSemesterForResource(classification, signalParts);
    const filenameTitle = String(event.filename || "").trim();
    if (filenameTitle) {
      // Keep resource title deterministic and user-friendly.
      classification.title = filenameTitle;
    }
  }

  if (classification.category === "resource" && !classification.subject) {
    await updateEventStatus(
      created.id,
      "failed",
      "subject_unmapped",
      "Unable to map resource to allowed subject catalog",
    );
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification,
      reason: "subject_unmapped",
      event,
      binding,
      payload: {
        reason: "subject_unmapped",
        event,
        binding,
        extractedHeading: extracted.heading,
        extractedTextSample: extracted.textSample,
        extractedFullTextSample: extracted.fullTextSample,
        classification,
      },
    });
    return { status: "queued_review", eventId: created.id, reason: "subject_unmapped" };
  }

  if (!isConfidenceValid(classification.confidence)) {
    await updateEventStatus(
      created.id,
      "failed",
      "invalid_confidence",
      "Classifier produced invalid confidence",
    );
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification: makeManualReviewClassification(classification.category),
      reason: "invalid_confidence",
      event,
      binding,
      payload: {
        reason: "invalid_confidence",
        event,
        binding,
        classification,
      },
    });
    return { status: "queued_review", eventId: created.id, reason: "invalid_confidence" };
  }

  if (
    classification.category === "resource" &&
    (!classification.branch || !classification.semester || !classification.subject)
  ) {
    await updateEventStatus(
      created.id,
      "failed",
      "validation_failed",
      "Missing branch/semester/subject for resource posting",
    );
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification,
      reason: "validation_failed",
      event,
      binding,
      payload: {
        reason: "validation_failed",
        detail: "Missing branch/semester/subject for resource posting",
        event,
        binding,
        classification,
      },
    });
    return { status: "queued_review", eventId: created.id, reason: "validation_failed" };
  }

  await updateEventClassification(created.id, classification, extracted.textHash);

  const shouldAutoPost =
    classification.category === "resource" &&
    driveStructuredImport &&
    Boolean(classification.branch && classification.semester && classification.subject)
      ? true
      : classification.source === "rules"
        ? classification.confidence >= 0.9
        : classification.confidence >= config.AUTO_POST_CONFIDENCE_THRESHOLD;

  if (!shouldAutoPost) {
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification,
      reason: "low_confidence",
      event,
      binding,
      payload: {
        reason: "low_confidence",
        threshold: config.AUTO_POST_CONFIDENCE_THRESHOLD,
        event,
        binding,
        extractedHeading: extracted.heading,
        extractedTextSample: extracted.textSample,
        classification,
      },
    });

    return { status: "queued_review", eventId: created.id, reason: "low_confidence" };
  }

  const existingPost = await getPostIdempotency(finalIdempotencyKey);
  if (existingPost) {
    await markEventPosted(
      created.id,
      existingPost.target_type,
      existingPost.target_id ?? "existing",
    );
    return { status: "posted", eventId: created.id, reason: "idempotency_hit" };
  }

  await updateEventStatus(created.id, "posting");

  try {
    const postResult = await postToStudyShare({
      event,
      classification,
      binding,
      idempotencyKey: finalIdempotencyKey,
    });

    await savePostIdempotency(finalIdempotencyKey, postResult.entityType, postResult.entityId);
    await markEventPosted(created.id, postResult.entityType, postResult.entityId);

    return { status: "posted", eventId: created.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "post failed";
    const code = isNonRetryablePostError(error) ? "non_retryable_post_failure" : "post_failed";

    await updateEventStatus(created.id, "failed", code, detail);
    await queueManualReviewWithNotification({
      eventId: created.id,
      classification,
      reason: code,
      event,
      binding,
      payload: {
        reason: code,
        event,
        binding,
        classification,
        detail,
      },
    });

    await sendOpsAlert("StudyShare post failed", {
      eventId: created.id,
      groupJid: event.groupJid,
      messageId: event.messageId,
      error: detail,
      retryable: code !== "non_retryable_post_failure",
    });

    return { status: "queued_review", eventId: created.id, reason: code };
  }
}
