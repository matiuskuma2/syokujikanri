-- =============================================================
-- Migration 0012: meal_entries に food_match_json カラム追加
-- 目的: AI画像解析結果の food_master マッチング情報を保存
-- food_match_json には matchedCount, items[] (master_name, match_score等) を格納
-- =============================================================

ALTER TABLE meal_entries ADD COLUMN food_match_json TEXT;
-- JSON format example:
-- {
--   "matched_count": 3,
--   "total_count": 4,
--   "unmatched_names": ["特製ソース"],
--   "db_total_calories": 450,
--   "db_total_protein": 22.5,
--   "items": [
--     { "ai_name": "白米", "master_name": "白米", "master_id": "fm_rice_white", "match_score": 1.0, ... }
--   ]
-- }
