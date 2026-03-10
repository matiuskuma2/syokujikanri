-- =============================================================
-- Migration 0006: 日次記録・体型測定・食事記録
-- src/types/db.ts: DailyLog / BodyMetrics / MealEntry
-- =============================================================

-- 日次ログ（体重・歩数・睡眠・水分等）
-- user_accounts に紐づく設計に統一
CREATE TABLE IF NOT EXISTS daily_logs (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  client_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  log_date          TEXT NOT NULL,  -- YYYY-MM-DD
  source            TEXT NOT NULL CHECK (source IN ('line','web','import','staff')) DEFAULT 'line',
  completion_status TEXT NOT NULL CHECK (completion_status IN ('partial','complete','reviewed')) DEFAULT 'partial',
  notes             TEXT,
  ai_feedback       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, log_date)
);

-- 体型測定値（daily_log に 1:1 で紐づく）
CREATE TABLE IF NOT EXISTS body_metrics (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  daily_log_id     TEXT NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  weight_kg        REAL,
  waist_cm         REAL,
  body_fat_percent REAL,
  temperature_c    REAL,
  edema_flag       INTEGER CHECK (edema_flag IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(daily_log_id)
);

-- 食事記録
CREATE TABLE IF NOT EXISTS meal_entries (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  daily_log_id        TEXT NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  meal_type           TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner','snack','other')) DEFAULT 'snack',
  consumed_at         TEXT,
  meal_text           TEXT,
  photo_count         INTEGER NOT NULL DEFAULT 0,
  calories_kcal       REAL,
  protein_g           REAL,
  fat_g               REAL,
  carbs_g             REAL,
  fiber_g             REAL,
  alcohol_kcal        REAL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('draft','confirmed','corrected')) DEFAULT 'draft',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_account    ON daily_logs(user_account_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_client_account  ON daily_logs(client_account_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_log_date        ON daily_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date       ON daily_logs(user_account_id, log_date);
CREATE INDEX IF NOT EXISTS idx_body_metrics_daily_log     ON body_metrics(daily_log_id);
CREATE INDEX IF NOT EXISTS idx_meal_entries_daily_log_id  ON meal_entries(daily_log_id);
