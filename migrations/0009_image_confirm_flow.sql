-- =============================================================
-- Migration 0009: 画像確認フロー対応
-- M3-1: pending_image_confirm 状態基盤
-- M3-2: 即DB反映停止 → ユーザー確認後に反映
--
-- applied_flag の値:
--   0 = pending (AI解析済み、ユーザー未確認)
--   1 = confirmed (ユーザーが確定 → メインテーブルに反映済み)
--   2 = discarded (ユーザーが取消)
--   3 = expired (24時間自動破棄)
--
-- SQLite の CHECK 制約は ALTER TABLE で変更不可のため、
-- テーブルを再作成して制約を拡張する。
-- =============================================================

-- 1. 既存テーブルをバックアップ
ALTER TABLE image_intake_results RENAME TO image_intake_results_backup;

-- 2. 新しいテーブル定義（applied_flag に 0-3 を許可、新カラム追加）
CREATE TABLE image_intake_results (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  message_attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  user_account_id       TEXT REFERENCES user_accounts(id) ON DELETE SET NULL,
  daily_log_id          TEXT REFERENCES daily_logs(id) ON DELETE SET NULL,
  line_user_id          TEXT,
  image_category        TEXT NOT NULL CHECK (image_category IN (
    'meal_photo','nutrition_label','body_scale',
    'food_package','progress_body_photo','other','unknown'
  )) DEFAULT 'unknown',
  confidence_score      REAL,
  extracted_json        TEXT,
  proposed_action_json  TEXT,
  applied_flag          INTEGER NOT NULL DEFAULT 0 CHECK (applied_flag IN (0,1,2,3)),
  confirmed_at          TEXT,
  expires_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. 既存データを移行
INSERT INTO image_intake_results
  (id, message_attachment_id, user_account_id, daily_log_id,
   image_category, confidence_score, extracted_json, proposed_action_json,
   applied_flag, created_at, updated_at)
SELECT
  id, message_attachment_id, user_account_id, daily_log_id,
  image_category, confidence_score, extracted_json, proposed_action_json,
  applied_flag, created_at, updated_at
FROM image_intake_results_backup;

-- 4. バックアップテーブルを削除
DROP TABLE image_intake_results_backup;

-- 5. インデックスを再作成（元のインデックスはバックアップテーブル削除で消える）
CREATE INDEX IF NOT EXISTS idx_img_intake_results_attachment  ON image_intake_results(message_attachment_id);
CREATE INDEX IF NOT EXISTS idx_img_intake_results_user_acct   ON image_intake_results(user_account_id);

-- 6. 新しいインデックス
CREATE INDEX IF NOT EXISTS idx_img_intake_pending
  ON image_intake_results(user_account_id, applied_flag)
  WHERE applied_flag = 0;

CREATE INDEX IF NOT EXISTS idx_img_intake_expires
  ON image_intake_results(expires_at)
  WHERE applied_flag = 0;
