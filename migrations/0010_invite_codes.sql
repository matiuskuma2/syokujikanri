-- =====================================================
-- 0010_invite_codes.sql
-- 招待コード管理テーブル
--
-- 目的:
--   admin が発行した招待コードを LINE ユーザーが送信することで
--   正しい client_account_id に紐付ける仕組み
-- =====================================================

-- invite_codes テーブル
CREATE TABLE IF NOT EXISTS invite_codes (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,         -- 招待コード (例: ABC-1234)
  account_id       TEXT NOT NULL,                -- 紐付け先 account.id
  created_by       TEXT NOT NULL,                -- 作成した admin の membership.id
  label            TEXT,                         -- 管理用ラベル (例: 顧客名、メモ)
  max_uses         INTEGER DEFAULT 1,            -- 最大使用回数 (NULL=無制限)
  use_count        INTEGER DEFAULT 0,            -- 現在の使用回数
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK(status IN ('active','expired','revoked')),
  expires_at       TEXT,                         -- 有効期限 (ISO 8601, NULL=無期限)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id)  REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by)  REFERENCES account_memberships(id)
);

-- invite_code_usages テーブル (使用履歴)
CREATE TABLE IF NOT EXISTS invite_code_usages (
  id               TEXT PRIMARY KEY,
  invite_code_id   TEXT NOT NULL,
  line_user_id     TEXT NOT NULL,                -- 使用した LINE ユーザー
  used_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_account ON invite_codes(account_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_status ON invite_codes(status);
CREATE INDEX IF NOT EXISTS idx_invite_code_usages_code ON invite_code_usages(invite_code_id);
CREATE INDEX IF NOT EXISTS idx_invite_code_usages_line_user ON invite_code_usages(line_user_id);
