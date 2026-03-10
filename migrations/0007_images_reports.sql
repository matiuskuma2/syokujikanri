-- =============================================================
-- Migration 0007: 画像取り込み・進捗写真・週次レポート・監査ログ
-- src/types/db.ts: ImageIntakeResult / ProgressPhoto / WeeklyReport
-- =============================================================

-- 画像取り込み結果
-- message_attachments および user_accounts に紐づく
CREATE TABLE IF NOT EXISTS image_intake_results (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  message_attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  user_account_id       TEXT REFERENCES user_accounts(id) ON DELETE SET NULL,
  daily_log_id          TEXT REFERENCES daily_logs(id) ON DELETE SET NULL,
  image_category        TEXT NOT NULL CHECK (image_category IN (
    'meal_photo','nutrition_label','body_scale',
    'food_package','progress_body_photo','other','unknown'
  )) DEFAULT 'unknown',
  confidence_score      REAL,
  extracted_json        TEXT,   -- 解析済みデータ JSON
  proposed_action_json  TEXT,   -- 提案アクション JSON
  applied_flag          INTEGER NOT NULL DEFAULT 0 CHECK (applied_flag IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 進捗写真
-- user_accounts に紐づく設計に統一
CREATE TABLE IF NOT EXISTS progress_photos (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_account_id       TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  daily_log_id          TEXT REFERENCES daily_logs(id) ON DELETE SET NULL,
  photo_date            TEXT NOT NULL,  -- YYYY-MM-DD
  photo_type            TEXT NOT NULL CHECK (photo_type IN ('before','progress','after')) DEFAULT 'progress',
  storage_provider      TEXT NOT NULL CHECK (storage_provider IN ('r2')) DEFAULT 'r2',
  storage_key           TEXT NOT NULL,
  pose_label            TEXT CHECK (pose_label IN ('front','side','mirror','unknown')),
  body_part_label       TEXT CHECK (body_part_label IN ('full_body','upper_body','torso','unknown')),
  note                  TEXT,
  is_public_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK (is_public_use_allowed IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 週次レポート
-- user_accounts に紐づく設計に統一
CREATE TABLE IF NOT EXISTS weekly_reports (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_account_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  week_start      TEXT NOT NULL,  -- YYYY-MM-DD (月曜日)
  week_end        TEXT NOT NULL,  -- YYYY-MM-DD (日曜日)
  avg_weight_kg   REAL,
  min_weight_kg   REAL,
  max_weight_kg   REAL,
  weight_change   REAL,
  total_steps     INTEGER,
  avg_steps       REAL,
  avg_sleep_hours REAL,
  avg_water_ml    REAL,
  meal_log_count  INTEGER,
  log_days        INTEGER NOT NULL DEFAULT 0,
  ai_summary      TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, week_start)
);

-- 監査ログ
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id    TEXT,
  user_id       TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  details       TEXT,   -- JSON
  ip_address    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_img_intake_results_attachment  ON image_intake_results(message_attachment_id);
CREATE INDEX IF NOT EXISTS idx_img_intake_results_user_acct   ON image_intake_results(user_account_id);
CREATE INDEX IF NOT EXISTS idx_progress_photos_user_account   ON progress_photos(user_account_id);
CREATE INDEX IF NOT EXISTS idx_progress_photos_photo_date     ON progress_photos(photo_date);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_user_account    ON weekly_reports(user_account_id);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_week_start      ON weekly_reports(week_start);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id          ON audit_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at          ON audit_logs(created_at);
