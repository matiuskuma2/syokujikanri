-- =============================================================
-- Migration 0003: 会話・メッセージ・添付・ジョブ・セッション
-- src/types/db.ts: ConversationThread / ConversationMessage /
--                  MessageAttachment / ImageAnalysisJob / BotModeSession
-- =============================================================

-- 会話スレッド
CREATE TABLE IF NOT EXISTS conversation_threads (
  id                TEXT PRIMARY KEY,
  line_channel_id   TEXT NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
  line_user_id      TEXT NOT NULL,
  client_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_account_id   TEXT REFERENCES user_accounts(id) ON DELETE SET NULL,
  current_mode      TEXT NOT NULL CHECK (current_mode IN ('record','consult','system')) DEFAULT 'record',
  status            TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会話メッセージ
CREATE TABLE IF NOT EXISTS conversation_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  sender_type       TEXT NOT NULL CHECK (sender_type IN ('user','bot','staff','system')),
  sender_account_id TEXT,
  source_platform   TEXT NOT NULL CHECK (source_platform IN ('line','web_admin')) DEFAULT 'line',
  line_message_id   TEXT,
  message_type      TEXT NOT NULL CHECK (message_type IN ('text','image','audio','template','quick_reply','system_event')) DEFAULT 'text',
  raw_text          TEXT,
  normalized_text   TEXT,
  intent_label      TEXT,
  mode_at_send      TEXT,
  sent_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メッセージ添付ファイル
CREATE TABLE IF NOT EXISTS message_attachments (
  id                TEXT PRIMARY KEY,
  message_id        TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  storage_provider  TEXT NOT NULL CHECK (storage_provider IN ('r2','images','s3')) DEFAULT 'r2',
  storage_key       TEXT NOT NULL,
  content_type      TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size_bytes   INTEGER,
  original_filename TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 画像解析ジョブ
CREATE TABLE IF NOT EXISTS image_analysis_jobs (
  id                     TEXT PRIMARY KEY,
  message_attachment_id  TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  job_status             TEXT NOT NULL CHECK (job_status IN ('queued','processing','done','failed')) DEFAULT 'queued',
  provider_route         TEXT NOT NULL CHECK (provider_route IN ('openai_vision','mixed')) DEFAULT 'openai_vision',
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  started_at             TEXT,
  finished_at            TEXT
);

-- BOT モードセッション
CREATE TABLE IF NOT EXISTS bot_mode_sessions (
  id                TEXT PRIMARY KEY,
  client_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  line_user_id      TEXT NOT NULL,
  current_mode      TEXT NOT NULL CHECK (current_mode IN ('intake','record','consult','knowledge')) DEFAULT 'record',
  current_step      TEXT NOT NULL DEFAULT 'idle',
  session_data      TEXT,   -- JSON
  turn_count        INTEGER NOT NULL DEFAULT 0,
  expires_at        TEXT NOT NULL DEFAULT (datetime('now', '+24 hours')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_account_id, line_user_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_conv_threads_line_user    ON conversation_threads(line_user_id, status);
CREATE INDEX IF NOT EXISTS idx_conv_threads_client_acct  ON conversation_threads(client_account_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_thread_id   ON conversation_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_sent_at     ON conversation_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_attachments_message   ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_img_jobs_attachment_id    ON image_analysis_jobs(message_attachment_id);
CREATE INDEX IF NOT EXISTS idx_img_jobs_status           ON image_analysis_jobs(job_status);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_account_line ON bot_mode_sessions(client_account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_expires_at   ON bot_mode_sessions(expires_at);
