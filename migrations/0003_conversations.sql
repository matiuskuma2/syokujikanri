-- =============================================================
-- Migration 0003: 会話・メッセージ・セッション
-- =============================================================

-- 会話スレッド
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  line_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed')) DEFAULT 'active',
  bot_mode TEXT CHECK (bot_mode IN ('intake','record','consult','knowledge')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会話メッセージ
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_type TEXT NOT NULL CHECK (message_type IN ('text','image','template','flex','system')) DEFAULT 'text',
  content TEXT,
  bot_mode TEXT CHECK (bot_mode IN ('intake','record','consult','knowledge')),
  step_code TEXT,
  metadata TEXT, -- JSON: reply_token, message_id 等
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メッセージ添付ファイル（画像等）
CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  file_type TEXT NOT NULL CHECK (file_type IN ('image','video','audio','file')),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size INTEGER,
  intake_type TEXT CHECK (intake_type IN ('meal_photo','nutrition_label','body_scale','progress_body_photo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BOTモードセッション
CREATE TABLE IF NOT EXISTS bot_mode_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('intake','record','consult','knowledge')),
  step_code TEXT NOT NULL DEFAULT 'start',
  session_data TEXT, -- JSON: context, partial answers etc.
  turn_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_conversation_threads_account_id ON conversation_threads(account_id);
CREATE INDEX IF NOT EXISTS idx_conversation_threads_line_user_id ON conversation_threads(line_user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_id ON conversation_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_created_at ON conversation_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_bot_mode_sessions_account_line ON bot_mode_sessions(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_bot_mode_sessions_expires_at ON bot_mode_sessions(expires_at);
