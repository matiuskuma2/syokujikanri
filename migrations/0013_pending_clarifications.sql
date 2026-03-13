-- =============================================================
-- Migration 0013: pending_clarifications テーブル追加
-- 目的: Phase B 明確化フローの状態管理
-- 正本: docs/12_記録確認フローSSOT.md §3
-- =============================================================

CREATE TABLE pending_clarifications (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),
  client_account_id TEXT NOT NULL REFERENCES accounts(id),

  -- Phase A の途中結果
  intent_json       TEXT NOT NULL,           -- Unified Intent JSON（Phase A 途中結果）
  original_message  TEXT NOT NULL,           -- 元のユーザーメッセージ
  message_id        TEXT REFERENCES conversation_messages(id),

  -- 明確化状態
  missing_fields    TEXT NOT NULL,           -- JSON配列: ["target_date", "meal_type"]
  current_field     TEXT NOT NULL,           -- 現在質問中のフィールド
  answers_json      TEXT NOT NULL DEFAULT '{}',  -- 回答済みの値: {"target_date":"2026-03-12"}

  -- ステータス
  status            TEXT NOT NULL DEFAULT 'asking',  -- 'asking' | 'answered' | 'expired' | 'cancelled'
  ask_count         INTEGER NOT NULL DEFAULT 0,      -- 質問回数（同一フィールドの再質問含む）

  -- タイムスタンプ
  expires_at        TEXT NOT NULL,           -- 24時間後
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pending_clarifications_user
  ON pending_clarifications(user_account_id, status);

CREATE INDEX idx_pending_clarifications_expires
  ON pending_clarifications(expires_at) WHERE status = 'asking';
