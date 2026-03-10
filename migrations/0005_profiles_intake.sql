-- =============================================================
-- Migration 0005: ユーザープロファイル・ヒアリング
-- src/types/db.ts: UserProfile / BotModeSession (intake_forms, etc.)
-- =============================================================

-- ユーザープロファイル（健康・目標情報）
-- user_accounts に紐づく（user_account_id を主キー参照）
CREATE TABLE IF NOT EXISTS user_profiles (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  nickname          TEXT,
  gender            TEXT CHECK (gender IN ('male','female','other')),
  age_range         TEXT,  -- '20s','30s','40s','50s+','60s+'
  height_cm         REAL,
  current_weight_kg REAL,
  target_weight_kg  REAL,
  goal_summary      TEXT,
  concern_tags      TEXT,  -- JSON array: ['腹部脂肪','むくみ','体力']
  medical_notes     TEXT,
  activity_level    TEXT CHECK (activity_level IN ('sedentary','light','moderate','active')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id)
);

-- ヒアリングフォーム定義
CREATE TABLE IF NOT EXISTS intake_forms (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ヒアリング回答
CREATE TABLE IF NOT EXISTS intake_answers (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_account_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  intake_form_id  TEXT NOT NULL REFERENCES intake_forms(id) ON DELETE CASCADE,
  question_key    TEXT NOT NULL,
  answer_value    TEXT,
  answered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, intake_form_id, question_key)
);

-- 質問定義マスタ
CREATE TABLE IF NOT EXISTS question_definitions (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  question_key  TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL CHECK (category IN ('intake','daily_check')),
  label_ja      TEXT NOT NULL,
  input_type    TEXT NOT NULL CHECK (input_type IN ('text','number','select','multiselect','image')),
  options_json  TEXT,  -- JSON array of options
  is_required   INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0,1)),
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_account    ON user_profiles(user_account_id);
CREATE INDEX IF NOT EXISTS idx_intake_forms_account_id       ON intake_forms(account_id);
CREATE INDEX IF NOT EXISTS idx_intake_answers_user_account   ON intake_answers(user_account_id);

-- 初期質問定義データ
INSERT OR IGNORE INTO question_definitions (question_key, category, label_ja, input_type, is_required, order_index) VALUES
  ('nickname',           'intake',       'お名前（ニックネームOK）',   'text',        1, 1),
  ('gender',             'intake',       '性別',                        'select',      1, 2),
  ('age_range',          'intake',       '年代',                        'select',      1, 3),
  ('height_cm',          'intake',       '身長（cm）',                  'number',      1, 4),
  ('current_weight_kg',  'intake',       '現在の体重（kg）',            'number',      1, 5),
  ('target_weight_kg',   'intake',       '目標体重（kg）',              'number',      1, 6),
  ('goal_summary',       'intake',       'ダイエットの目標・理由',      'text',        0, 7),
  ('concern_tags',       'intake',       '気になること（複数可）',      'multiselect', 0, 8),
  ('activity_level',     'intake',       '普段の活動レベル',            'select',      0, 9),
  ('medical_notes',      'intake',       '持病・注意事項（任意）',      'text',        0, 10),
  ('daily_weight',       'daily_check',  '今日の体重（kg）',            'number',      0, 1),
  ('daily_mood',         'daily_check',  '今日の体調・気分（1〜5）',    'number',      0, 2),
  ('daily_notes',        'daily_check',  '今日のコメント・気づき',      'text',        0, 3);
