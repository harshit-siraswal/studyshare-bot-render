import { sendReviewApprovalRequest } from "./alert.js";
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
  markEventPosted,
  savePostIdempotency,
  updateEventClassification,
  updateEventStatus,
} from "./db.js";
import { extractPdfFromEvent } from "./pdfExtractor.js";
import {
  listAdminResources,
  StudyShareAdminResource,
  updateAdminResourceMetadata,
} from "./studyshareClient.js";
import { ClassificationResult, OpenClawDocumentEvent } from "./types.js";
import { buildIdempotencyKey, sha256 } from "./utils.js";

interface BackfillRunInput {
  groupJid: string;
  maxResources?: number;
  pageSize?: number;
  dryRun?: boolean;
  onlyUnmapped?: boolean;
  minConfidence?: number;
  semesters?: string[];
  branchCandidates?: string[];
  status?: string;
}

interface BackfillCounters {
  scanned: number;
  skipped: number;
  updated: number;
  queuedReview: number;
  failed: number;
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBranchCode(input: string | null | undefined): string {
  const normalized = normalizeForMatch(input ?? "").replace(/\s+/g, "_");
  if (["cse_aiml", "aiml", "ai_ml", "ai&ml"].includes(normalized)) return "aiml";
  if (["cse_ai", "cse-artificial_intelligence", "artificial_intelligence"].includes(normalized))
    return "cse_ai";
  return normalized;
}

function buildPdfFilename(resource: StudyShareAdminResource): string {
  const fromFileUrl =
    String(resource.file_url ?? "")
      .split("?")[0]
      .split("#")[0]
      .split("/")
      .pop() || "";
  if (fromFileUrl.toLowerCase().endsWith(".pdf")) return fromFileUrl;
  const fromTitle = (String(resource.title ?? "").trim() || `resource-${resource.id}`).replace(
    /[^\w.-]+/g,
    "_",
  );
  return fromTitle.toLowerCase().endsWith(".pdf") ? fromTitle : `${fromTitle}.pdf`;
}

function isPdfResource(resource: StudyShareAdminResource): boolean {
  const fileUrl = String(resource.file_url ?? "");
  return /^https?:\/\//i.test(fileUrl) && fileUrl.split("?")[0].toLowerCase().endsWith(".pdf");
}

function isConfidenceValid(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function applyBindingDefaults(
  classification: ClassificationResult,
  defaults: {
    department: string;
    branch: string | null;
    semester: string | null;
    subject: string | null;
  },
): ClassificationResult {
  return {
    ...classification,
    department: classification.department ?? defaults.department,
    branch: classification.branch ?? defaults.branch,
    semester: classification.semester ?? defaults.semester,
    subject: classification.subject ?? defaults.subject,
  };
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

  const normalizedBranch = normalizeBranchCode(classification.branch);
  if (!["aiml", "cse_ai"].includes(normalizedBranch)) return explicitSemester ?? null;

  const normalizedSubject = normalizeForMatch(classification.subject ?? "");
  if (!normalizedSubject) return null;

  const semesters = aimlSubjectSemesterIndex.get(normalizedSubject);
  if (!semesters || semesters.size !== 1) return null;
  return [...semesters][0] ?? null;
}

async function queueBackfillReview(args: {
  eventId: string;
  classification: ClassificationResult;
  payload: Record<string, unknown>;
  reason: string;
  event: OpenClawDocumentEvent;
  binding: {
    group_jid: string;
    group_title: string;
  };
}): Promise<void> {
  const reviewId = await enqueueManualReview(args.eventId, args.classification, args.payload);
  if (!reviewId) return;

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

function shouldAutoUpdate(classification: ClassificationResult, minConfidence: number): boolean {
  const threshold = classification.source === "rules" ? 0.9 : minConfidence;
  return classification.confidence >= threshold;
}

function valueChanged(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeForMatch(a ?? "") !== normalizeForMatch(b ?? "");
}

function subjectIsInCatalog(
  subject: string | null | undefined,
  subjectCatalog: string[] | null | undefined,
): boolean {
  if (!subject) return false;
  if (!subjectCatalog?.length) return true;
  const normalized = normalizeForMatch(subject);
  return subjectCatalog.some((entry) => normalizeForMatch(entry) === normalized);
}

export async function runResourceBackfill(input: BackfillRunInput): Promise<{
  ok: true;
  groupJid: string;
  collegeId: string;
  counters: BackfillCounters;
}> {
  const binding = await getGroupBinding(input.groupJid);
  if (!binding) {
    throw new Error(`backfill_failed:unmapped_group:${input.groupJid}`);
  }

  const maxResources = Math.min(Math.max(Number(input.maxResources ?? 300), 1), 2000);
  const pageSize = Math.min(Math.max(Number(input.pageSize ?? 100), 1), 100);
  const onlyUnmapped = input.onlyUnmapped !== false;
  const dryRun = input.dryRun === true;
  const minConfidence = Number.isFinite(input.minConfidence)
    ? Number(input.minConfidence)
    : config.AUTO_POST_CONFIDENCE_THRESHOLD;
  const status = (input.status || "approved").trim();
  const semesterSet = new Set(
    (input.semesters?.length ? input.semesters : ["1", "2"])
      .map((item) => String(item).trim())
      .filter(Boolean),
  );
  const branchCandidates = (
    input.branchCandidates?.length
      ? input.branchCandidates
      : [binding.default_branch || "aiml", "cse_aiml", "aiml"]
  )
    .map((entry) => normalizeBranchCode(entry))
    .filter(Boolean);
  const branchCandidateSet = new Set(branchCandidates);

  const counters: BackfillCounters = {
    scanned: 0,
    skipped: 0,
    updated: 0,
    queuedReview: 0,
    failed: 0,
  };

  const resources: StudyShareAdminResource[] = [];
  let page = 1;
  while (resources.length < maxResources) {
    const listed = await listAdminResources({
      page,
      pageSize,
      collegeId: binding.college_id,
      status,
    });

    const pageRows = listed.resources ?? [];
    if (!pageRows.length) break;

    for (const resource of pageRows) {
      if (resources.length >= maxResources) break;
      if (!isPdfResource(resource)) continue;

      const branchCode = normalizeBranchCode(String(resource.branch ?? ""));
      if (branchCandidateSet.size && branchCode && !branchCandidateSet.has(branchCode)) continue;

      resources.push(resource);
    }

    if (pageRows.length < pageSize) break;
    page += 1;
  }

  for (const resource of resources) {
    counters.scanned += 1;

    const syntheticEvent: OpenClawDocumentEvent = {
      messageId: `backfill-${resource.id}-${Date.now()}`,
      groupJid: binding.group_jid,
      groupTitle: binding.group_title,
      sender: "backfill@studyshare",
      filename: buildPdfFilename(resource),
      mimeType: "application/pdf",
      caption: `${resource.title ?? ""} ${resource.subject ?? ""}`.trim(),
      mediaUrl: String(resource.file_url ?? ""),
      timestamp: new Date().toISOString(),
    };

    const preHash = sha256(`${resource.id}:${resource.file_url ?? ""}`);
    const idempotencyKey = buildIdempotencyKey(
      syntheticEvent.groupJid,
      syntheticEvent.messageId,
      preHash,
    );
    const created = await createIngestEvent({
      event: syntheticEvent,
      idempotencyKey,
      fileSha256: preHash,
      payload: {
        reviewMode: "resource_backfill",
        source: "existing_resource",
        resourceId: resource.id,
        current: {
          branch: resource.branch ?? null,
          semester: resource.semester ?? null,
          subject: resource.subject ?? null,
          title: resource.title ?? null,
        },
      },
    });

    if (created.duplicate) {
      counters.skipped += 1;
      continue;
    }

    let extracted: Awaited<ReturnType<typeof extractPdfFromEvent>>["extracted"];
    let fileSha256 = preHash;
    try {
      const extraction = await extractPdfFromEvent(syntheticEvent, sha256);
      extracted = extraction.extracted;
      fileSha256 = extraction.fileSha256;
    } catch (error) {
      counters.failed += 1;
      const detail = error instanceof Error ? error.message : "extraction_failed";
      await updateEventStatus(created.id, "failed", "extraction_failed", detail);
      await queueBackfillReview({
        eventId: created.id,
        classification: {
          category: "resource",
          confidence: 0.1,
          title: String(resource.title ?? syntheticEvent.filename),
          summary: "Manual review required after extraction failure",
          department: binding.department_code,
          branch: binding.default_branch,
          semester: binding.default_semester,
          subject: binding.default_subject,
          priority: "normal",
          source: "rules",
        },
        reason: "extraction_failed",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "extraction_failed",
          detail,
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          event: syntheticEvent,
          binding,
        },
      });
      counters.queuedReview += 1;
      continue;
    }

    if (extracted.isEmpty) {
      counters.failed += 1;
      await updateEventStatus(
        created.id,
        "failed",
        "extraction_empty",
        "Empty extraction on resource backfill",
      );
      await queueBackfillReview({
        eventId: created.id,
        classification: {
          category: "resource",
          confidence: 0.1,
          title: String(resource.title ?? syntheticEvent.filename),
          summary: "Manual review required: empty extraction",
          department: binding.department_code,
          branch: binding.default_branch,
          semester: binding.default_semester,
          subject: binding.default_subject,
          priority: "normal",
          source: "rules",
        },
        reason: "extraction_empty",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "extraction_empty",
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          event: syntheticEvent,
          binding,
        },
      });
      counters.queuedReview += 1;
      continue;
    }

    let classification: ClassificationResult;
    try {
      classification = await classifyDocument({
        event: syntheticEvent,
        heading: extracted.heading,
        textSample: extracted.textSample,
        fullTextSample: extracted.fullTextSample,
        groupBinding: binding,
      });
    } catch (error) {
      counters.failed += 1;
      const detail = error instanceof Error ? error.message : "classification_failed";
      await updateEventStatus(created.id, "failed", "classification_failed", detail);
      await queueBackfillReview({
        eventId: created.id,
        classification: {
          category: "resource",
          confidence: 0.1,
          title: String(resource.title ?? syntheticEvent.filename),
          summary: "Manual review required after classification error",
          department: binding.department_code,
          branch: binding.default_branch,
          semester: binding.default_semester,
          subject: binding.default_subject,
          priority: "normal",
          source: "rules",
        },
        reason: "classification_failed",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "classification_failed",
          detail,
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          event: syntheticEvent,
          binding,
        },
      });
      counters.queuedReview += 1;
      continue;
    }

    classification = applyBindingDefaults(classification, {
      department: binding.department_code,
      branch: binding.default_branch,
      semester: binding.default_semester,
      subject: binding.default_subject,
    });

    const signalParts = [
      syntheticEvent.filename,
      syntheticEvent.caption ?? "",
      extracted.heading,
      extracted.textSample,
      extracted.fullTextSample,
    ];

    classification.subject =
      normalizeSubjectFromCatalog(classification.subject, binding.subject_catalog) ??
      detectSubjectFromCatalog(signalParts, binding.subject_catalog) ??
      classification.subject;

    classification.branch = binding.default_branch ?? classification.branch;
    classification.semester = inferSemesterForResource(classification, signalParts);

    await updateEventClassification(created.id, classification, extracted.textHash);

    const mappedBranch = normalizeBranchCode(
      classification.branch ?? binding.default_branch ?? resource.branch ?? "",
    );
    const mappedSemester = (classification.semester ?? "").trim();
    const mappedSubject = (classification.subject ?? "").trim();
    const currentBranch = normalizeBranchCode(String(resource.branch ?? ""));
    const currentSemester = String(resource.semester ?? "").trim();
    const currentSubject = String(resource.subject ?? "").trim();

    const hasRequired = Boolean(
      mappedBranch &&
      mappedSemester &&
      mappedSubject &&
      isConfidenceValid(classification.confidence),
    );
    const semesterAllowed = !semesterSet.size || semesterSet.has(mappedSemester);
    const subjectAllowed = subjectIsInCatalog(mappedSubject, binding.subject_catalog);

    if (
      !hasRequired ||
      !semesterAllowed ||
      !subjectAllowed ||
      classification.category !== "resource"
    ) {
      await updateEventStatus(
        created.id,
        "failed",
        "subject_unmapped",
        "Unable to confidently map branch/semester/subject",
      );
      await queueBackfillReview({
        eventId: created.id,
        classification,
        reason: "subject_unmapped",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "subject_unmapped",
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          proposedMapping: {
            branch: mappedBranch || null,
            semester: mappedSemester || null,
            subject: mappedSubject || null,
            title: resource.title ?? syntheticEvent.filename,
            description: resource.description ?? null,
          },
          event: syntheticEvent,
          binding,
          classification,
        },
      });
      counters.queuedReview += 1;
      continue;
    }

    const changed =
      valueChanged(currentBranch, mappedBranch) ||
      valueChanged(currentSemester, mappedSemester) ||
      valueChanged(currentSubject, mappedSubject);

    if (!changed && onlyUnmapped) {
      counters.skipped += 1;
      await updateEventStatus(created.id, "ignored", "none", "Already aligned with target mapping");
      continue;
    }

    if (!shouldAutoUpdate(classification, minConfidence)) {
      await queueBackfillReview({
        eventId: created.id,
        classification,
        reason: "low_confidence",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "low_confidence",
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          proposedMapping: {
            branch: mappedBranch,
            semester: mappedSemester,
            subject: mappedSubject,
            title: resource.title ?? syntheticEvent.filename,
            description: resource.description ?? null,
          },
          threshold: minConfidence,
          event: syntheticEvent,
          binding,
          classification,
        },
      });
      counters.queuedReview += 1;
      continue;
    }

    if (dryRun) {
      counters.skipped += 1;
      await updateEventStatus(created.id, "ignored", "none", "Dry-run mode; update skipped");
      continue;
    }

    try {
      await updateEventStatus(created.id, "posting");
      await updateAdminResourceMetadata(
        {
          resourceId: String(resource.id),
          branch: mappedBranch,
          semester: mappedSemester,
          subject: mappedSubject,
          title: String(syntheticEvent.filename),
          description: resource.description == null ? null : String(resource.description),
          collegeId: binding.college_id,
        },
        buildIdempotencyKey(binding.group_jid, `resource-update-${resource.id}`, fileSha256),
      );

      const postIdempotencyKey = `backfill:${resource.id}:${mappedBranch}:${mappedSemester}:${mappedSubject}`;
      await savePostIdempotency(postIdempotencyKey, "resource_update", String(resource.id));
      await markEventPosted(created.id, "resource_update", String(resource.id));
      counters.updated += 1;
    } catch (error) {
      counters.failed += 1;
      const detail = error instanceof Error ? error.message : "resource_update_failed";
      await updateEventStatus(created.id, "failed", "post_failed", detail);
      await queueBackfillReview({
        eventId: created.id,
        classification,
        reason: "post_failed",
        event: syntheticEvent,
        binding,
        payload: {
          reviewMode: "resource_backfill",
          resourceId: resource.id,
          reason: "post_failed",
          detail,
          current: {
            branch: resource.branch ?? null,
            semester: resource.semester ?? null,
            subject: resource.subject ?? null,
            title: resource.title ?? null,
          },
          proposedMapping: {
            branch: mappedBranch,
            semester: mappedSemester,
            subject: mappedSubject,
            title: resource.title ?? syntheticEvent.filename,
            description: resource.description ?? null,
          },
          event: syntheticEvent,
          binding,
          classification,
        },
      });
      counters.queuedReview += 1;
    }
  }

  return {
    ok: true,
    groupJid: binding.group_jid,
    collegeId: binding.college_id,
    counters,
  };
}
