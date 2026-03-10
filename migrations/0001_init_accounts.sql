-- =============================================================
-- Migration 0001: アカウント・メンバーシップ・サブスクリプション
-- =============================================================

-- アカウント（契約単位：クリニック・サロン等）
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  type TEXT NOT NULL CHECK (type IN ('clinic','salon','personal','demo')) DEFAULT 'clinic',
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','cancelled')) DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  locale TEXT NOT NULL DEFAULT 'ja',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メンバーシップ（アカウント↔ユーザーの紐付けとロール）
CREATE TABLE IF NOT EXISTS account_memberships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,  -- 管理者ユーザーID（外部Auth想定）
  role TEXT NOT NULL CHECK (role IN ('superadmin','admin','member')) DEFAULT 'member',
  status TEXT NOT NULL CHECK (status IN ('active','inactive')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, user_id)
);

-- サブスクリプション（契約プラン）
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('free','starter','professional','enterprise')) DEFAULT 'free',
  status TEXT NOT NULL CHECK (status IN ('trial','active','past_due','cancelled')) DEFAULT 'trial',
  trial_ends_at TEXT,
  current_period_start TEXT NOT NULL DEFAULT (datetime('now')),
  current_period_end TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
  max_users INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_account_memberships_account_id ON account_memberships(account_id);
CREATE INDEX IF NOT EXISTS idx_account_memberships_user_id ON account_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_id ON subscriptions(account_id);
