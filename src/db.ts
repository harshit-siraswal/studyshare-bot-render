import { Pool, PoolClient } from "pg";
import { config } from "./config.js";
import {
  ClassificationResult,
  GroupBinding,
  IngestErrorCode,
  IngestStatus,
  OpenClawDocumentEvent,
} from "./types.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });

export function getDb() {
  return pool;
}

let schemaEnsured = false;

export async function ensureRuntimeSchema(): Promise<void> {
  if (schemaEnsured) return;

  await withTransaction(async (client) => {
    await client.query(`
      ALTER TABLE wa_group_bindings
      ADD COLUMN IF NOT EXISTS allowed_categories TEXT[] NOT NULL DEFAULT ARRAY['syllabus', 'resource', 'notice']::TEXT[],
      ADD COLUMN IF NOT EXISTS subject_catalog TEXT[],
      ADD COLUMN IF NOT EXISTS only_useful_resources BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query(
      `ALTER TYPE wa_ingest_error_code ADD VALUE IF NOT EXISTS 'filtered_by_group_policy'`,
    );
    await client.query(
      `ALTER TYPE wa_ingest_error_code ADD VALUE IF NOT EXISTS 'filtered_non_useful_resource'`,
    );
    await client.query(
      `ALTER TYPE wa_ingest_error_code ADD VALUE IF NOT EXISTS 'subject_unmapped'`,
    );
  });

  schemaEnsured = true;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getGroupBinding(groupJid: string): Promise<GroupBinding | null> {
  const query = `
    SELECT
      group_jid,
      group_title,
      college_id,
      department_code,
      default_branch,
      default_semester,
      default_subject,
      allowed_categories,
      subject_catalog,
      only_useful_resources,
      is_active
    FROM wa_group_bindings
    WHERE group_jid = $1
      AND is_active = true
    LIMIT 1
  `;

  const result = await pool.query<GroupBinding>(query, [groupJid]);
  return result.rows[0] ?? null;
}

interface CreateEventArgs {
  event: OpenClawDocumentEvent;
  idempotencyKey: string;
  fileSha256: string;
  payload: Record<string, unknown>;
}

export async function createIngestEvent(
  args: CreateEventArgs,
): Promise<{ id: string; duplicate: boolean }> {
  const { event, idempotencyKey, fileSha256, payload } = args;

  const query = `
    INSERT INTO wa_ingest_events (
      wa_message_id,
      group_jid,
      sender,
      file_name,
      mime_type,
      file_sha256,
      caption,
      status,
      idempotency_key,
      payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', $8, $9::jsonb)
    ON CONFLICT (idempotency_key)
    DO UPDATE SET
      updated_at = NOW(),
      status = 'duplicate',
      error_code = 'duplicate_event',
      error_detail = 'Duplicate idempotency key'
    RETURNING id,
      (xmax::text::int > 0) AS duplicate
  `;

  const values = [
    event.messageId,
    event.groupJid,
    event.sender ?? null,
    event.filename,
    event.mimeType ?? null,
    fileSha256,
    event.caption ?? null,
    idempotencyKey,
    JSON.stringify(payload),
  ];

  const result = await pool.query<{ id: string; duplicate: boolean }>(query, values);
  return result.rows[0];
}

export async function updateEventStatus(
  eventId: string,
  status: IngestStatus,
  errorCode: IngestErrorCode = "none",
  errorDetail?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE wa_ingest_events
     SET status = $2,
         error_code = $3,
         error_detail = $4
     WHERE id = $1`,
    [eventId, status, errorCode, errorDetail ?? null],
  );
}

export async function updateEventClassification(
  eventId: string,
  classification: ClassificationResult,
  extractedTextHash: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE wa_ingest_events
     SET category = $2,
         confidence = $3,
         title = $4,
         summary = $5,
         extracted_text_hash = $6,
         status = 'classification_pending'
     WHERE id = $1`,
    [
      eventId,
      classification.category,
      classification.confidence,
      classification.title,
      classification.summary,
      extractedTextHash,
    ],
  );
}

export async function markEventPosted(
  eventId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await pool.query(
    `UPDATE wa_ingest_events
     SET status = 'posted',
         error_code = 'none',
         error_detail = NULL,
         posted_entity_type = $2,
         posted_entity_id = $3
     WHERE id = $1`,
    [eventId, entityType, entityId],
  );
}

export async function enqueueManualReview(
  eventId: string,
  classification: ClassificationResult,
  payload: Record<string, unknown>,
): Promise<string> {
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO wa_manual_review_queue (
        ingest_event_id,
        proposed_category,
        confidence,
        payload_json,
        status
      )
      VALUES ($1, $2, $3, $4::jsonb, 'pending')
      ON CONFLICT (ingest_event_id)
      DO UPDATE SET
        proposed_category = EXCLUDED.proposed_category,
        confidence = EXCLUDED.confidence,
        payload_json = EXCLUDED.payload_json,
        status = 'pending',
        reviewer = NULL,
        reviewed_at = NULL,
        review_note = NULL
      RETURNING id`,
      [eventId, classification.category, classification.confidence, JSON.stringify(payload)],
    );

    await client.query(
      `UPDATE wa_ingest_events
       SET status = 'queued_review',
           error_code = 'none',
           error_detail = NULL
       WHERE id = $1`,
      [eventId],
    );

    return inserted.rows[0]?.id ?? "";
  });
}

export interface PendingReviewItem {
  id: string;
  ingest_event_id: string;
  proposed_category: string | null;
  confidence: number | null;
  payload_json: Record<string, unknown>;
  status: string;
  created_at: string;
}

export async function getPendingReviews(limit = 20): Promise<PendingReviewItem[]> {
  const result = await pool.query<PendingReviewItem>(
    `SELECT id, ingest_event_id, proposed_category, confidence, payload_json, status, created_at
     FROM wa_manual_review_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

export async function getReviewById(reviewId: string): Promise<PendingReviewItem | null> {
  const result = await pool.query<PendingReviewItem>(
    `SELECT id, ingest_event_id, proposed_category, confidence, payload_json, status, created_at
     FROM wa_manual_review_queue
     WHERE id = $1
     LIMIT 1`,
    [reviewId],
  );

  return result.rows[0] ?? null;
}

export async function markReviewStatus(
  reviewId: string,
  status: "approved" | "rejected",
  reviewer: string,
  note?: string,
): Promise<void> {
  await pool.query(
    `UPDATE wa_manual_review_queue
     SET status = $2,
         reviewer = $3,
         review_note = $4,
         reviewed_at = NOW()
     WHERE id = $1`,
    [reviewId, status, reviewer, note ?? null],
  );
}

export async function savePostIdempotency(
  idempotencyKey: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO wa_post_idempotency (idempotency_key, target_type, target_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, targetType, targetId],
  );
}

export async function getPostIdempotency(
  idempotencyKey: string,
): Promise<{ target_type: string; target_id: string | null } | null> {
  const result = await pool.query<{ target_type: string; target_id: string | null }>(
    `SELECT target_type, target_id
     FROM wa_post_idempotency
     WHERE idempotency_key = $1
     LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export interface IngestDashboardStats {
  pendingReviews: number;
  posted24h: number;
  failed24h: number;
  received24h: number;
}

export interface LiveActivityItem {
  kind: "ingest" | "review";
  id: string;
  timestamp: string;
  status: string;
  error_code: string | null;
  category: string | null;
  title: string | null;
  file_name: string | null;
  sender: string | null;
  group_jid: string | null;
  summary: string | null;
  reviewer: string | null;
  posted_entity_type: string | null;
  posted_entity_id: string | null;
}

export interface IngestSourceBreakdown {
  sender: string;
  total: number;
  posted: number;
  queued_review: number;
  ignored: number;
  failed: number;
}

export interface RecentPostedResource {
  ingest_event_id: string;
  resource_id: string;
  title: string | null;
  sender: string | null;
  category: string | null;
  posted_at: string;
}

export async function getIngestDashboardStats(): Promise<IngestDashboardStats> {
  const result = await pool.query<{
    pending_reviews: string;
    posted_24h: string;
    failed_24h: string;
    received_24h: string;
  }>(
    `SELECT
      (SELECT COUNT(*)::text FROM wa_manual_review_queue WHERE status = 'pending') AS pending_reviews,
      (SELECT COUNT(*)::text FROM wa_ingest_events WHERE status = 'posted' AND created_at >= NOW() - INTERVAL '24 hours') AS posted_24h,
      (SELECT COUNT(*)::text FROM wa_ingest_events WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours') AS failed_24h,
      (SELECT COUNT(*)::text FROM wa_ingest_events WHERE created_at >= NOW() - INTERVAL '24 hours') AS received_24h`,
  );

  const row = result.rows[0];
  return {
    pendingReviews: Number(row?.pending_reviews ?? 0),
    posted24h: Number(row?.posted_24h ?? 0),
    failed24h: Number(row?.failed_24h ?? 0),
    received24h: Number(row?.received_24h ?? 0),
  };
}

export async function getLiveActivity(limit = 30): Promise<LiveActivityItem[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const result = await pool.query<LiveActivityItem>(
    `WITH activity AS (
       SELECT
         'ingest'::text AS kind,
         e.id::text AS id,
         e.created_at AS timestamp,
         e.status::text AS status,
         e.error_code::text AS error_code,
         e.category::text AS category,
         e.title,
         e.file_name,
         e.sender,
         e.group_jid,
         e.summary,
         NULL::text AS reviewer,
         e.posted_entity_type::text AS posted_entity_type,
         e.posted_entity_id::text AS posted_entity_id
       FROM wa_ingest_events e
       WHERE e.created_at >= NOW() - INTERVAL '48 hours'

       UNION ALL

       SELECT
         'review'::text AS kind,
         r.id::text AS id,
         COALESCE(r.reviewed_at, r.created_at) AS timestamp,
         ('review_' || r.status::text)::text AS status,
         NULL::text AS error_code,
         r.proposed_category::text AS category,
         e.title,
         e.file_name,
         e.sender,
         e.group_jid,
         COALESCE(r.review_note, '') AS summary,
         r.reviewer,
         e.posted_entity_type::text AS posted_entity_type,
         e.posted_entity_id::text AS posted_entity_id
       FROM wa_manual_review_queue r
       JOIN wa_ingest_events e ON e.id = r.ingest_event_id
       WHERE COALESCE(r.reviewed_at, r.created_at) >= NOW() - INTERVAL '48 hours'
    )
    SELECT
      kind,
      id,
      timestamp::text,
      status,
      error_code,
      category,
      title,
      file_name,
      sender,
      group_jid,
      summary,
      reviewer,
      posted_entity_type,
      posted_entity_id
    FROM activity
    ORDER BY timestamp DESC
    LIMIT $1`,
    [safeLimit],
  );

  return result.rows;
}

export async function markPostedResourceRetracted(
  resourceId: string,
  reviewer: string,
): Promise<number> {
  const note = `[RETRACTED by ${reviewer} at ${new Date().toISOString()}]`;
  const result = await pool.query<{ count: string }>(
    `WITH touched AS (
       UPDATE wa_ingest_events
       SET status = 'ignored',
           error_code = 'none',
           error_detail = 'retracted_by_dashboard',
           summary = CASE
             WHEN COALESCE(summary, '') = '' THEN $2
             ELSE summary || ' ' || $2
           END,
           updated_at = NOW()
       WHERE posted_entity_id = $1
         AND posted_entity_type IN ('resource', 'resource_update')
       RETURNING id
     )
     SELECT COUNT(*)::text AS count FROM touched`,
    [resourceId, note],
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function getIngestSourceBreakdown(hours = 24): Promise<IngestSourceBreakdown[]> {
  const safeHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 168) : 24;
  const result = await pool.query<{
    sender: string | null;
    total: string;
    posted: string;
    queued_review: string;
    ignored: string;
    failed: string;
  }>(
    `SELECT
      COALESCE(NULLIF(TRIM(sender), ''), 'unknown') AS sender,
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status = 'posted')::text AS posted,
      COUNT(*) FILTER (WHERE status = 'queued_review')::text AS queued_review,
      COUNT(*) FILTER (WHERE status = 'ignored')::text AS ignored,
      COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM wa_ingest_events
     WHERE created_at >= NOW() - ($1::text || ' hours')::interval
     GROUP BY 1
     ORDER BY COUNT(*) DESC, sender ASC
     LIMIT 10`,
    [safeHours],
  );

  return result.rows.map((row) => ({
    sender: row.sender ?? "unknown",
    total: Number(row.total ?? 0),
    posted: Number(row.posted ?? 0),
    queued_review: Number(row.queued_review ?? 0),
    ignored: Number(row.ignored ?? 0),
    failed: Number(row.failed ?? 0),
  }));
}

export async function getRecentPostedResources(
  limit = 10,
  senderLike: string | null = null,
): Promise<RecentPostedResource[]> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
  const sender = senderLike && senderLike.trim().length ? senderLike.trim() : null;

  const result = await pool.query<RecentPostedResource>(
    `WITH latest AS (
       SELECT DISTINCT ON (e.posted_entity_id)
         e.id::text AS ingest_event_id,
         e.posted_entity_id::text AS resource_id,
         COALESCE(e.title, e.file_name, 'Untitled') AS title,
         e.sender,
         e.category::text AS category,
         e.created_at AS posted_at
       FROM wa_ingest_events e
       WHERE e.status = 'posted'
         AND e.posted_entity_type IN ('resource', 'resource_update')
         AND e.posted_entity_id IS NOT NULL
         AND ($2::text IS NULL OR COALESCE(e.sender, '') ILIKE ('%' || $2 || '%'))
       ORDER BY e.posted_entity_id, e.created_at DESC
     )
     SELECT
       ingest_event_id,
       resource_id,
       title,
       sender,
       category,
       posted_at::text
     FROM latest
     ORDER BY posted_at DESC
     LIMIT $1`,
    [safeLimit, sender],
  );

  return result.rows;
}
