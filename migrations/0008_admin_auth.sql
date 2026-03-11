-- =============================================================
-- 0008_admin_auth.sql
-- 管理者認証強化: password_hash, invite_tokens テーブル追加
-- =============================================================

-- account_memberships に password_hash を追加
ALTER TABLE account_memberships ADD COLUMN password_hash TEXT;
ALTER TABLE account_memberships ADD COLUMN password_reset_token TEXT;
ALTER TABLE account_memberships ADD COLUMN password_reset_expires_at TEXT;
ALTER TABLE account_memberships ADD COLUMN last_login_at TEXT;

-- 招待トークンテーブル
CREATE TABLE IF NOT EXISTS invite_tokens (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','staff')) DEFAULT 'staff',
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  invited_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_token     ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_email     ON invite_tokens(email);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_account   ON invite_tokens(account_id);
