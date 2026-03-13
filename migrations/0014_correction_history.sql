-- =============================================================
-- Migration 0014: correction_history テーブル追加
-- 目的: 記録修正の監査ログ
-- 正本: docs/12_記録確認フローSSOT.md §4
-- =============================================================

CREATE TABLE correction_history (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),

  -- 修正対象
  target_table      TEXT NOT NULL,           -- 'meal_entries' | 'body_metrics' | 'daily_logs'
  target_record_id  TEXT NOT NULL,           -- 修正対象のレコードID

  -- 修正内容
  correction_type   TEXT NOT NULL,           -- 'meal_type_change' | 'content_change' | 'date_change' | 'nutrition_change' | 'delete' | 'weight_change'
  old_value_json    TEXT NOT NULL,           -- 修正前の値 (JSON)
  new_value_json    TEXT,                    -- 修正後の値 (JSON)、deleteの場合はnull

  -- メタデータ
  triggered_by      TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'system' | 'admin'
  message_id        TEXT REFERENCES conversation_messages(id),
  reason            TEXT,                    -- 修正理由（ユーザーの元メッセージ等）

  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_correction_history_user
  ON correction_history(user_account_id, created_at);

CREATE INDEX idx_correction_history_target
  ON correction_history(target_table, target_record_id);
