export type DocCategory = "syllabus" | "resource" | "notice";

export type IngestStatus =
  | "received"
  | "ignored"
  | "duplicate"
  | "classification_pending"
  | "queued_review"
  | "posting"
  | "posted"
  | "failed";

export type IngestErrorCode =
  | "none"
  | "unmapped_group"
  | "duplicate_event"
  | "unsupported_file_type"
  | "filtered_by_group_policy"
  | "filtered_non_useful_resource"
  | "subject_unmapped"
  | "download_failed"
  | "pdf_password_protected"
  | "extraction_failed"
  | "extraction_empty"
  | "classification_failed"
  | "invalid_confidence"
  | "validation_failed"
  | "post_failed"
  | "non_retryable_post_failure"
  | "unknown_error";

export interface OpenClawDocumentEvent {
  messageId: string;
  groupJid: string;
  groupTitle?: string;
  sender?: string;
  filename: string;
  mimeType?: string;
  caption?: string;
  mediaUrl?: string;
  mediaBase64?: string;
  mediaPath?: string;
  timestamp?: string;
}

export interface GroupBinding {
  group_jid: string;
  group_title: string;
  college_id: string;
  department_code: string;
  default_branch: string | null;
  default_semester: string | null;
  default_subject: string | null;
  allowed_categories: string[] | null;
  subject_catalog: string[] | null;
  only_useful_resources: boolean | null;
  is_active: boolean;
}

export interface ExtractedPdf {
  heading: string;
  textSample: string;
  fullTextSample: string;
  textHash: string | null;
  extractionMode: "text" | "ocr";
  isEmpty: boolean;
}

export interface ClassificationResult {
  category: DocCategory;
  confidence: number;
  title: string;
  summary: string;
  department: string | null;
  branch: string | null;
  semester: string | null;
  subject: string | null;
  priority: "low" | "normal" | "high";
  source: "rules" | "llm";
}
