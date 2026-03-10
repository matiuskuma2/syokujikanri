-- =============================================================
-- Migration 0006: 日次記録・食事記録
-- =============================================================

-- 日次ログ（体重・歩数・睡眠・水分等）
CREATE TABLE IF NOT EXISTS daily_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,  -- YYYY-MM-DD
  weight_kg REAL,
  waist_cm REAL,
  body_fat_pct REAL,
  steps INTEGER,
  water_ml INTEGER,
  sleep_hours REAL,
  mood_score INTEGER CHECK (mood_score BETWEEN 1 AND 5),
  notes TEXT,
  ai_feedback TEXT,  -- AIによるその日のフィードバック
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, log_date)
);

-- 食事記録
CREATE TABLE IF NOT EXISTS meal_entries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  line_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  daily_log_id TEXT REFERENCES daily_logs(id) ON DELETE SET NULL,
  log_date TEXT NOT NULL,  -- YYYY-MM-DD
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner','snack','drink')) DEFAULT 'snack',
  description TEXT,
  estimated_calories INTEGER,
  estimated_protein_g REAL,
  estimated_fat_g REAL,
  estimated_carbs_g REAL,
  nutrition_score INTEGER,  -- 0-100
  ai_parsed INTEGER NOT NULL DEFAULT 0 CHECK (ai_parsed IN (0,1)),
  ai_comment TEXT,
  image_key TEXT,  -- R2 key
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_daily_logs_account_line ON daily_logs(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_log_date ON daily_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_daily_logs_account_date ON daily_logs(account_id, log_date);
CREATE INDEX IF NOT EXISTS idx_meal_entries_account_line ON meal_entries(account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_meal_entries_daily_log_id ON meal_entries(daily_log_id);
CREATE INDEX IF NOT EXISTS idx_meal_entries_log_date ON meal_entries(log_date);
