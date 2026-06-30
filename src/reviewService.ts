import { z } from "zod";
import { detectSubjectFromCatalog, normalizeSubjectFromCatalog } from "./classification.js";
import {
  getReviewById,
  markReviewStatus,
  markEventPosted,
  savePostIdempotency,
  updateEventStatus,
} from "./db.js";
import { inferDrivePathMapping } from "./drivePathInference.js";
import { postToStudyShare, updateAdminResourceMetadata } from "./studyshareClient.js";
import { ClassificationResult, GroupBinding, OpenClawDocumentEvent } from "./types.js";
import { buildIdempotencyKey, sha256 } from "./utils.js";

const reviewPayloadSchema = z.object({
  reviewMode: z.enum(["ingest", "resource_backfill"]).optional(),
  resourceId: z.string().optional(),
  proposedMapping: z
    .object({
      branch: z.string().nullable().optional(),
      semester: z.string().nullable().optional(),
      subject: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .optional(),
  current: z
    .object({
      branch: z.string().nullable().optional(),
      semester: z.string().nullable().optional(),
      subject: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .optional(),
  event: z.object({
    messageId: z.string(),
    groupJid: z.string(),
    groupTitle: z.string().optional(),
    sender: z.string().optional(),
    filename: z.string(),
    mimeType: z.string().optional(),
    caption: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mediaBase64: z.string().optional(),
    mediaPath: z.string().optional(),
    timestamp: z.string().optional(),
  }),
  binding: z.object({
    group_jid: z.string(),
    group_title: z.string(),
    college_id: z.string(),
    department_code: z.string(),
    default_branch: z.string().nullable(),
    default_semester: z.string().nullable(),
    default_subject: z.string().nullable(),
    subject_catalog: z.array(z.string()).nullable().optional(),
    allowed_categories: z.array(z.string()).nullable().optional(),
    only_useful_resources: z.boolean().nullable().optional(),
    is_active: z.boolean().default(true),
  }),
  classification: z
    .object({
      category: z.enum(["syllabus", "resource", "notice"]),
      confidence: z.number().min(0).max(1),
      title: z.string(),
      summary: z.string(),
      department: z.string().nullable(),
      branch: z.string().nullable(),
      semester: z.string().nullable(),
      subject: z.string().nullable(),
      priority: z.enum(["low", "normal", "high"]),
      source: z.enum(["rules", "llm"]).default("rules"),
    })
    .optional(),
});

function pickNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSemesterFromSignals(signalParts: string[]): string | null {
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

const aimlPreferredSemesterBySubject = new Map<string, string>([
  ["calculus for engineers", "1"],
  ["semiconductor physics and devices", "1"],
  ["semiconductor physics and devices lab", "1"],
  ["environmental chemistry", "2"],
  ["programming for problem solving", "1"],
  ["programming for problem solving lab", "1"],
  ["discrete structures and theory of logic", "1"],
  ["computer organization and logic design", "1"],
  ["computer organization and logic design lab", "1"],
  ["design thinking", "1"],
  ["introduction to iot", "1"],
  ["web designing", "1"],
  ["communication skills", "1"],
  ["foreign language", "1"],
  ["indian knowledge system", "1"],
  ["basic proficiency in spanish", "2"],
  ["data structure", "2"],
  ["linear algebra for engineers", "2"],
  ["python for engineers", "2"],
  ["innovation and entrepreneurship", "2"],
  ["introduction to ai", "2"],
]);

function resolveResourceClassification(args: {
  classification: ClassificationResult;
  event: OpenClawDocumentEvent;
  binding: GroupBinding;
  proposed?: {
    branch?: string | null;
    semester?: string | null;
    subject?: string | null;
  };
  current?: {
    branch?: string | null;
    semester?: string | null;
    subject?: string | null;
  };
  overrides?: Partial<ClassificationResult>;
}): ClassificationResult {
  const { classification, event, binding, proposed, current, overrides } = args;
  const catalog = binding.subject_catalog ?? [];
  const signalParts = [
    event.filename,
    event.caption ?? "",
    event.groupTitle ?? "",
    binding.group_title,
  ];
  const driveHint = inferDrivePathMapping({
    event,
    fallbackBranch: binding.default_branch,
  });

  const subjectCandidate = pickNonEmpty(
    overrides?.subject,
    proposed?.subject,
    classification.subject,
    current?.subject,
    binding.default_subject,
    driveHint.subject,
  );

  const normalizedSubject =
    normalizeSubjectFromCatalog(subjectCandidate || null, catalog) ??
    detectSubjectFromCatalog(signalParts, catalog) ??
    (driveHint.subject && normalizeSubjectFromCatalog(driveHint.subject, catalog)) ??
    driveHint.subject ??
    subjectCandidate;

  const explicitSemester = pickNonEmpty(
    overrides?.semester,
    proposed?.semester,
    classification.semester,
    current?.semester,
    binding.default_semester,
  );

  let semester =
    explicitSemester || detectSemesterFromSignals(signalParts) || driveHint.semester || "";
  if (!semester && normalizedSubject) {
    semester = aimlPreferredSemesterBySubject.get(normalizeForMatch(normalizedSubject)) ?? "";
  }

  const branch = pickNonEmpty(
    overrides?.branch,
    proposed?.branch,
    classification.branch,
    current?.branch,
    driveHint.branch,
    binding.default_branch,
  );

  return {
    ...classification,
    branch: branch || null,
    semester: semester || null,
    subject: normalizedSubject || null,
  };
}

export async function approveReview(
  reviewId: string,
  reviewer: string,
  overrides?: Partial<ClassificationResult>,
): Promise<{ entityType: string; entityId: string }> {
  const review = await getReviewById(reviewId);
  if (!review) {
    throw new Error("review_not_found");
  }
  if (review.status !== "pending") {
    throw new Error("review_not_pending");
  }

  const parsed = reviewPayloadSchema.parse(review.payload_json);

  const classification: ClassificationResult = {
    category:
      overrides?.category ??
      parsed.classification?.category ??
      (review.proposed_category as ClassificationResult["category"]) ??
      "resource",
    confidence:
      overrides?.confidence ?? parsed.classification?.confidence ?? review.confidence ?? 0.5,
    title: overrides?.title ?? parsed.classification?.title ?? parsed.event.filename,
    summary: overrides?.summary ?? parsed.classification?.summary ?? parsed.event.caption ?? "",
    department:
      overrides?.department ?? parsed.classification?.department ?? parsed.binding.department_code,
    branch: overrides?.branch ?? parsed.classification?.branch ?? parsed.binding.default_branch,
    semester:
      overrides?.semester ?? parsed.classification?.semester ?? parsed.binding.default_semester,
    subject: overrides?.subject ?? parsed.classification?.subject ?? parsed.binding.default_subject,
    priority: overrides?.priority ?? parsed.classification?.priority ?? "normal",
    source: parsed.classification?.source ?? "rules",
  };

  const event = parsed.event as OpenClawDocumentEvent;
  const binding = parsed.binding as GroupBinding;
  const reviewMode = parsed.reviewMode ?? "ingest";

  if (reviewMode === "resource_backfill") {
    const resourceId = (parsed.resourceId || "").trim();
    if (!resourceId) {
      throw new Error("review_resource_id_missing");
    }

    const branch = pickNonEmpty(
      overrides?.branch,
      parsed.proposedMapping?.branch,
      classification.branch,
      parsed.current?.branch,
      binding.default_branch,
    );
    const semester = pickNonEmpty(
      overrides?.semester,
      parsed.proposedMapping?.semester,
      classification.semester,
      parsed.current?.semester,
      binding.default_semester,
    );
    const subject = pickNonEmpty(
      overrides?.subject,
      parsed.proposedMapping?.subject,
      classification.subject,
      parsed.current?.subject,
      binding.default_subject,
    );

    if (!branch || !semester || !subject) {
      throw new Error("review_resource_mapping_incomplete");
    }

    const title = pickNonEmpty(
      event.filename,
      overrides?.title,
      parsed.proposedMapping?.title,
      parsed.current?.title,
      classification.title,
    );
    const description = pickNonEmpty(
      overrides?.summary,
      parsed.proposedMapping?.description,
      parsed.current?.description,
      classification.summary,
    );

    await updateAdminResourceMetadata(
      {
        resourceId,
        branch,
        semester,
        subject,
        title,
        description,
        collegeId: binding.college_id,
      },
      buildIdempotencyKey(
        event.groupJid,
        `review-backfill-${resourceId}`,
        sha256(`${resourceId}:${branch}:${semester}:${subject}`),
      ),
    );

    const remapIdempotency = `backfill:${resourceId}:${branch}:${semester}:${subject}`;
    await savePostIdempotency(remapIdempotency, "resource_update", resourceId);
    await markEventPosted(review.ingest_event_id, "resource_update", resourceId);
    await markReviewStatus(
      reviewId,
      "approved",
      reviewer,
      "Approved remap and updated existing resource",
    );

    return { entityType: "resource_update", entityId: resourceId };
  }

  // Manual approvals use deterministic key derived from message fields.
  const fallbackHash = sha256(`${event.groupJid}:${event.messageId}:${event.filename}`);
  const idempotencyKey = buildIdempotencyKey(event.groupJid, event.messageId, fallbackHash);

  const effectiveClassification =
    classification.category === "resource"
      ? resolveResourceClassification({
          classification,
          event,
          binding,
          proposed: parsed.proposedMapping,
          current: parsed.current,
          overrides,
        })
      : classification;

  if (effectiveClassification.category === "resource") {
    const filenameTitle = String(event.filename || "").trim();
    if (filenameTitle) {
      effectiveClassification.title = filenameTitle;
    }
  }

  if (
    effectiveClassification.category === "resource" &&
    (!effectiveClassification.branch ||
      !effectiveClassification.semester ||
      !effectiveClassification.subject)
  ) {
    throw new Error("review_resource_mapping_incomplete");
  }

  await updateEventStatus(review.ingest_event_id, "posting");

  const result = await postToStudyShare({
    event,
    binding,
    classification: effectiveClassification,
    idempotencyKey,
  });

  await savePostIdempotency(idempotencyKey, result.entityType, result.entityId);
  await markEventPosted(review.ingest_event_id, result.entityType, result.entityId);
  await markReviewStatus(reviewId, "approved", reviewer, "Approved and posted");

  return result;
}

export async function rejectReview(
  reviewId: string,
  reviewer: string,
  note?: string,
): Promise<void> {
  const review = await getReviewById(reviewId);
  if (!review) {
    throw new Error("review_not_found");
  }
  if (review.status !== "pending") {
    throw new Error("review_not_pending");
  }

  await markReviewStatus(reviewId, "rejected", reviewer, note ?? "Rejected by reviewer");
  await updateEventStatus(
    review.ingest_event_id,
    "failed",
    "validation_failed",
    note ?? "Rejected in manual review",
  );
}
