-- =============================================================
-- Migration 0002: LINE連携・ユーザー管理
-- src/types/db.ts: LineChannel / LineUser / UserAccount
-- =============================================================

-- LINEチャンネル設定
CREATE TABLE IF NOT EXISTS line_channels (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,        -- LINE の Messaging API Channel ID（数字）
  channel_secret    TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  webhook_path      TEXT NOT NULL DEFAULT '/api/webhooks/line',
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, channel_id)
);

-- LINE ユーザー（BOTを友達追加したエンドユーザー）
CREATE TABLE IF NOT EXISTS line_users (
  id              TEXT PRIMARY KEY,
  line_channel_id TEXT NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
  line_user_id    TEXT NOT NULL,   -- LINE の userId
  display_name    TEXT,
  picture_url     TEXT,
  status_message  TEXT,
  follow_status   TEXT NOT NULL CHECK (follow_status IN ('following','blocked')) DEFAULT 'following',
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(line_channel_id, line_user_id)
);

-- ユーザーアカウント（LINE ユーザー ↔ クライアントアカウントの紐付け）
CREATE TABLE IF NOT EXISTS user_accounts (
  id                TEXT PRIMARY KEY,
  line_user_id      TEXT NOT NULL,
  client_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('active','left','blocked')) DEFAULT 'active',
  joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
  left_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(line_user_id, client_account_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_line_channels_account_id       ON line_channels(account_id);
CREATE INDEX IF NOT EXISTS idx_line_users_channel_id          ON line_users(line_channel_id);
CREATE INDEX IF NOT EXISTS idx_line_users_line_user_id        ON line_users(line_user_id);
CREATE INDEX IF NOT EXISTS idx_user_accounts_line_user_id     ON user_accounts(line_user_id);
CREATE INDEX IF NOT EXISTS idx_user_accounts_client_account   ON user_accounts(client_account_id);
