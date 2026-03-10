-- =============================================================
-- Migration 0007: 画像取り込み・進捗写真・週次レポート
-- =============================================================

-- 画像取り込み結果
CREATE TABLE IF NOT EXISTS image_intake_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  message_attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  intake_type TEXT NOT NULL CHECK (intake_type IN ('meal_photo','nutrition_label','body_scale','progress_body_photo')),
  raw_response TEXT,   -- OpenAI レスポンスJSONテキスト
  parsed_data TEXT,    -- 解析済みデータJSON
  confidence_score REAL,
  is_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (is_confirmed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 進捗写真
CREATE TABLE IF NOT EXISTS progress_photos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,  -- YYYY-MM-DD
  r2_key TEXT NOT NULL,
  weight_at_photo REAL,
  waist_at_photo REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 週次レポート
CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,  -- YYYY-MM-DD (月曜日)
  week_end TEXT NOT NULL,    -- YYYY-MM-DD (日曜日)
  avg_weight_kg REAL,
  avg_calories REAL,
  log_days INTEGER NOT NULL DEFAULT 0,
  summary TEXT,  -- AI生成テキスト
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, week_start)
);

-- 監査ログ
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,  -- JSON
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_image_intake_results_attachment_id ON image_intake_results(message_attachment_id);
CREATE INDEX IF NOT EXISTS idx_image_intake_results_account_line ON image_intake_results(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_progress_photos_account_line ON progress_photos(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_progress_photos_log_date ON progress_photos(log_date);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_account_line ON weekly_reports(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_week_start ON weekly_reports(week_start);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id ON audit_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
