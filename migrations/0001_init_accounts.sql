-- =============================================================
-- Migration 0001: アカウント・メンバーシップ・サブスクリプション
-- src/types/db.ts: Account / AccountMembership / Subscription / UserServiceStatus
-- =============================================================

-- アカウント（契約単位：クリニック・サロン等）
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('clinic','salon','personal','demo')) DEFAULT 'clinic',
  name            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','suspended','cancelled')) DEFAULT 'active',
  timezone        TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  locale          TEXT NOT NULL DEFAULT 'ja',
  settings        TEXT,           -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メンバーシップ（アカウント↔管理ユーザー）
CREATE TABLE IF NOT EXISTS account_memberships (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,   -- 管理者ユーザーID
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('superadmin','admin','staff')) DEFAULT 'staff',
  status      TEXT NOT NULL CHECK (status IN ('active','inactive')) DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- サブスクリプション（契約プラン）
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL CHECK (plan IN ('free','starter','pro','enterprise')) DEFAULT 'free',
  status                 TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','cancelled')) DEFAULT 'trialing',
  max_users              INTEGER NOT NULL DEFAULT 10,
  current_period_start   TEXT NOT NULL DEFAULT (datetime('now')),
  current_period_end     TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id)
);

-- ユーザーサービス制御（BOT機能ON/OFF per user）
CREATE TABLE IF NOT EXISTS user_service_statuses (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  line_user_id      TEXT NOT NULL,
  bot_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (bot_enabled IN (0,1)),
  record_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (record_enabled IN (0,1)),
  consult_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (consult_enabled IN (0,1)),
  intake_completed  INTEGER NOT NULL DEFAULT 0 CHECK (intake_completed IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_account_memberships_account_id ON account_memberships(account_id);
CREATE INDEX IF NOT EXISTS idx_account_memberships_user_id    ON account_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_id        ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_user_service_statuses_account   ON user_service_statuses(account_id, line_user_id);
