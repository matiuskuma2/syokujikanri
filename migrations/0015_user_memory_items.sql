-- 0015_user_memory_items.sql
-- Layer 3: パーソナルメモリ（長期的な個人情報）
-- diet-bot v2.0 - パーソナルメモリSSOT

CREATE TABLE IF NOT EXISTS user_memory_items (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),

  -- 分類
  category          TEXT NOT NULL,           -- メモリのカテゴリ
  memory_key        TEXT NOT NULL,           -- カテゴリ内の一意キー
  
  -- 内容
  memory_value      TEXT NOT NULL,           -- メモリの値（テキスト）
  structured_json   TEXT,                    -- 構造化データ（JSON、任意）
  
  -- メタデータ
  source_type       TEXT NOT NULL DEFAULT 'conversation',  -- 'conversation' | 'intake' | 'admin' | 'system'
  source_message_id TEXT REFERENCES conversation_messages(id),
  confidence_score  REAL NOT NULL DEFAULT 0.8,  -- AIの確信度 (0.0-1.0)
  
  -- 管理
  is_active         INTEGER NOT NULL DEFAULT 1,  -- 0=無効化（論理削除）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(user_account_id, category, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_items_user 
  ON user_memory_items(user_account_id, is_active);
CREATE INDEX IF NOT EXISTS idx_memory_items_category 
  ON user_memory_items(user_account_id, category, is_active);
