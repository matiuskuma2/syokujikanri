-- =============================================================
-- Migration 0002: LINE連携・ユーザー管理
-- =============================================================

-- LINEチャンネル設定（アカウントごとの連携設定）
CREATE TABLE IF NOT EXISTS line_channels (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_secret TEXT NOT NULL,
  channel_access_token TEXT NOT NULL,
  webhook_path TEXT NOT NULL DEFAULT '/api/webhooks/line',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, channel_id)
);

-- LINEユーザー（友達追加したエンドユーザー）
CREATE TABLE IF NOT EXISTS line_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  line_channel_id TEXT NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
  line_user_id TEXT NOT NULL,  -- LINEのuserID
  display_name TEXT,
  picture_url TEXT,
  status_message TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);

-- ユーザーサービス制御（ON/OFF per user）
CREATE TABLE IF NOT EXISTS user_service_statuses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bot_enabled INTEGER NOT NULL DEFAULT 1 CHECK (bot_enabled IN (0,1)),
  record_enabled INTEGER NOT NULL DEFAULT 1 CHECK (record_enabled IN (0,1)),
  consult_enabled INTEGER NOT NULL DEFAULT 1 CHECK (consult_enabled IN (0,1)),
  intake_enabled INTEGER NOT NULL DEFAULT 1 CHECK (intake_enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_line_channels_account_id ON line_channels(account_id);
CREATE INDEX IF NOT EXISTS idx_line_users_account_id ON line_users(account_id);
CREATE INDEX IF NOT EXISTS idx_line_users_line_user_id ON line_users(line_user_id);
CREATE INDEX IF NOT EXISTS idx_user_service_statuses_account_line ON user_service_statuses(account_id, line_user_id);
