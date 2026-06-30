CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wa_doc_category') THEN
    CREATE TYPE wa_doc_category AS ENUM ('syllabus', 'resource', 'notice');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wa_ingest_status') THEN
    CREATE TYPE wa_ingest_status AS ENUM (
      'received',
      'ignored',
      'duplicate',
      'classification_pending',
      'queued_review',
      'posting',
      'posted',
      'failed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wa_ingest_error_code') THEN
    CREATE TYPE wa_ingest_error_code AS ENUM (
      'none',
      'unmapped_group',
      'duplicate_event',
      'unsupported_file_type',
      'filtered_by_group_policy',
      'filtered_non_useful_resource',
      'subject_unmapped',
      'download_failed',
      'pdf_password_protected',
      'extraction_failed',
      'extraction_empty',
      'classification_failed',
      'invalid_confidence',
      'validation_failed',
      'post_failed',
      'non_retryable_post_failure',
      'unknown_error'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wa_review_status') THEN
    CREATE TYPE wa_review_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wa_group_bindings (
  group_jid TEXT PRIMARY KEY,
  group_title TEXT NOT NULL,
  college_id UUID NOT NULL,
  department_code TEXT NOT NULL,
  default_branch TEXT,
  default_semester TEXT,
  default_subject TEXT,
  allowed_categories TEXT[] NOT NULL DEFAULT ARRAY['syllabus', 'resource', 'notice']::TEXT[],
  subject_catalog TEXT[],
  only_useful_resources BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_ingest_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id TEXT NOT NULL,
  group_jid TEXT NOT NULL,
  sender TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_sha256 TEXT,
  extracted_text_hash TEXT,
  caption TEXT,
  title TEXT,
  summary TEXT,
  category wa_doc_category,
  confidence NUMERIC(4,3),
  status wa_ingest_status NOT NULL DEFAULT 'received',
  error_code wa_ingest_error_code NOT NULL DEFAULT 'none',
  error_detail TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  posted_entity_type TEXT,
  posted_entity_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ingest_message UNIQUE (group_jid, wa_message_id),
  CONSTRAINT uq_ingest_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wa_ingest_events_status_created_at
  ON wa_ingest_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_ingest_events_error_code
  ON wa_ingest_events (error_code);

CREATE TABLE IF NOT EXISTS wa_manual_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_event_id UUID NOT NULL REFERENCES wa_ingest_events(id) ON DELETE CASCADE,
  proposed_category wa_doc_category,
  confidence NUMERIC(4,3),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status wa_review_status NOT NULL DEFAULT 'pending',
  reviewer TEXT,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_manual_review_event UNIQUE (ingest_event_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_manual_review_status_created_at
  ON wa_manual_review_queue (status, created_at DESC);

CREATE TABLE IF NOT EXISTS wa_post_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wa_group_bindings_updated_at ON wa_group_bindings;
CREATE TRIGGER trg_wa_group_bindings_updated_at
BEFORE UPDATE ON wa_group_bindings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_wa_ingest_events_updated_at ON wa_ingest_events;
CREATE TRIGGER trg_wa_ingest_events_updated_at
BEFORE UPDATE ON wa_ingest_events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_wa_manual_review_queue_updated_at ON wa_manual_review_queue;
CREATE TRIGGER trg_wa_manual_review_queue_updated_at
BEFORE UPDATE ON wa_manual_review_queue
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();
