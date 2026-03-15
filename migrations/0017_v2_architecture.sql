-- ==========================================================================
-- Migration 0017: Architecture V2 - Webhook minimization + Async processing
-- 
-- New tables:
--   1. incoming_events     - Raw event storage for idempotency
--   2. conversation_runtime_state - Canonical state (source of truth)
--   3. outbox_messages     - Outbox pattern for reliable push delivery
-- ==========================================================================

-- ----- A. incoming_events (idempotency) -----
CREATE TABLE IF NOT EXISTS incoming_events (
  id               TEXT PRIMARY KEY,
  line_message_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  event_json       TEXT NOT NULL,
  line_user_id     TEXT DEFAULT NULL,
  user_account_id  TEXT DEFAULT NULL,
  received_at      TEXT NOT NULL,
  processed_at     TEXT DEFAULT NULL,
  process_result   TEXT DEFAULT NULL,
  error_detail     TEXT DEFAULT NULL,
  UNIQUE(line_message_id)
);
CREATE INDEX IF NOT EXISTS idx_incoming_events_unprocessed
  ON incoming_events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_events_user
  ON incoming_events(user_account_id);

-- ----- B. conversation_runtime_state (canonical state) -----
CREATE TABLE IF NOT EXISTS conversation_runtime_state (
  user_account_id    TEXT PRIMARY KEY,
  line_user_id       TEXT NOT NULL,
  client_account_id  TEXT NOT NULL,
  current_mode       TEXT NOT NULL DEFAULT 'record',
  waiting_type       TEXT DEFAULT NULL,
  waiting_target_id  TEXT DEFAULT NULL,
  waiting_expires_at TEXT DEFAULT NULL,
  last_processed_message_id TEXT DEFAULT NULL,
  last_processed_at         TEXT DEFAULT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(line_user_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_state_client
  ON conversation_runtime_state(client_account_id);

-- ----- C. outbox_messages (outbox pattern) -----
CREATE TABLE IF NOT EXISTS outbox_messages (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL,
  line_user_id      TEXT NOT NULL,
  message_type      TEXT NOT NULL DEFAULT 'text',
  message_json      TEXT NOT NULL,
  quick_reply_json  TEXT DEFAULT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TEXT DEFAULT NULL,
  error_detail      TEXT DEFAULT NULL,
  source_event_id   TEXT DEFAULT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_messages(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user
  ON outbox_messages(user_account_id);
