-- =============================================================
-- Migration 0011: 食品マスターDB（food_master）
-- 目的: AI画像解析結果との食品名マッチング、PFC/塩分/野菜量の
--       標準値を提供するマスターテーブル
-- =============================================================

-- 食品マスター（日本食品標準成分表ベース + 外食・コンビニ拡張）
CREATE TABLE IF NOT EXISTS food_master (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  -- 食品名（正規化後の標準名）
  name              TEXT NOT NULL,
  -- 別名・表記ゆれ（JSON配列: ["焼きそば","やきそば","ヤキソバ"]）
  aliases           TEXT,
  -- カテゴリ
  category          TEXT NOT NULL CHECK(category IN (
    'staple',       -- 主食（ご飯・パン・麺類）
    'main_dish',    -- 主菜（肉・魚・卵・大豆）
    'side_dish',    -- 副菜（野菜・海藻・きのこ）
    'soup',         -- 汁物
    'dairy',        -- 乳製品
    'fruit',        -- 果物
    'snack',        -- 間食・お菓子
    'beverage',     -- 飲料
    'set_meal',     -- 定食・丼物・セットメニュー
    'convenience',  -- コンビニ商品
    'fast_food',    -- ファストフード
    'other'         -- その他
  )),
  -- 基準量（g または ml）
  serving_size_g    REAL NOT NULL DEFAULT 100,
  -- 基準量の表記（例: "1膳(150g)", "1切れ(80g)"）
  serving_label     TEXT,
  -- PFC + カロリー（基準量あたり）
  calories_kcal     REAL,
  protein_g         REAL,
  fat_g             REAL,
  carbs_g           REAL,
  -- 追加栄養素
  fiber_g           REAL,         -- 食物繊維
  salt_g            REAL,         -- 食塩相当量
  sugar_g           REAL,         -- 糖質
  vegetable_g       REAL,         -- 野菜量（g）
  -- メタデータ
  source            TEXT,         -- データソース（例: '食品成分表2020', 'OpenAI推定'）
  confidence        TEXT CHECK(confidence IN ('high','medium','low','estimated')) DEFAULT 'high',
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 食品名検索用インデックス
CREATE INDEX IF NOT EXISTS idx_food_master_name ON food_master(name);
CREATE INDEX IF NOT EXISTS idx_food_master_category ON food_master(category);

-- 食品名正規化マッピング（AI出力 → food_master.name）
CREATE TABLE IF NOT EXISTS food_name_mappings (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  raw_name          TEXT NOT NULL,       -- AI/ユーザーが出力した食品名（正規化前）
  food_master_id    TEXT NOT NULL REFERENCES food_master(id) ON DELETE CASCADE,
  match_score       REAL DEFAULT 1.0,    -- マッチ信頼度 (0.0〜1.0)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(raw_name, food_master_id)
);

CREATE INDEX IF NOT EXISTS idx_food_name_mappings_raw ON food_name_mappings(raw_name);

-- ===================================================================
-- 初期食品データ（日本食の基本）
-- ===================================================================

-- 主食
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_g, source, confidence) VALUES
  ('fm_rice_white', '白米', '["ご飯","白ご飯","ライス","rice"]', 'staple', 150, '1膳(150g)', 234, 3.8, 0.5, 53.4, 0.5, 0, '食品成分表', 'high'),
  ('fm_rice_brown', '玄米', '["玄米ご飯","brown rice"]', 'staple', 150, '1膳(150g)', 228, 4.2, 1.5, 51.3, 2.1, 0, '食品成分表', 'high'),
  ('fm_bread_white', '食パン', '["パン","トースト","toast","bread"]', 'staple', 60, '1枚(6枚切り)', 158, 5.6, 2.6, 28.0, 1.4, 0.8, '食品成分表', 'high'),
  ('fm_udon', 'うどん', '["ウドン","udon"]', 'staple', 230, '1玉(230g)', 242, 6.0, 0.9, 50.6, 1.4, 0.5, '食品成分表', 'high'),
  ('fm_soba', 'そば', '["蕎麦","ソバ","soba"]', 'staple', 170, '1玉(170g)', 224, 8.2, 1.5, 43.5, 2.2, 0, '食品成分表', 'high'),
  ('fm_ramen_noodle', '中華麺', '["ラーメンの麺","ramen noodle"]', 'staple', 150, '1玉(150g)', 224, 7.4, 1.2, 44.3, 1.2, 0.3, '食品成分表', 'high'),
  ('fm_pasta', 'パスタ', '["スパゲッティ","スパゲティ","spaghetti","pasta"]', 'staple', 100, '乾麺100g(茹で240g)', 378, 13.0, 1.8, 73.9, 2.7, 0, '食品成分表', 'high');

-- 主菜（肉・魚）
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, salt_g, source, confidence) VALUES
  ('fm_chicken_breast', '鶏むね肉', '["チキン","鶏胸肉","chicken breast"]', 'main_dish', 100, '100g', 121, 23.3, 1.9, 0, 0.1, '食品成分表', 'high'),
  ('fm_chicken_thigh', '鶏もも肉', '["鶏モモ","chicken thigh"]', 'main_dish', 100, '100g', 204, 16.6, 14.2, 0, 0.1, '食品成分表', 'high'),
  ('fm_pork_loin', '豚ロース', '["pork loin"]', 'main_dish', 100, '100g', 263, 19.3, 19.2, 0.2, 0.1, '食品成分表', 'high'),
  ('fm_beef_sirloin', '牛サーロイン', '["ステーキ","beef","steak"]', 'main_dish', 100, '100g', 298, 17.4, 23.7, 0.3, 0.1, '食品成分表', 'high'),
  ('fm_salmon', '鮭', '["サーモン","シャケ","salmon"]', 'main_dish', 80, '1切れ(80g)', 106, 17.8, 3.4, 0.1, 0.2, '食品成分表', 'high'),
  ('fm_egg', '卵', '["たまご","玉子","ゆで卵","egg"]', 'main_dish', 60, '1個(60g)', 85, 7.4, 5.7, 0.2, 0.2, '食品成分表', 'high'),
  ('fm_tofu', '豆腐', '["とうふ","絹豆腐","木綿豆腐","tofu"]', 'main_dish', 150, '1/2丁(150g)', 84, 7.4, 4.5, 2.4, 0, '食品成分表', 'high'),
  ('fm_natto', '納豆', '["なっとう","natto"]', 'main_dish', 50, '1パック(50g)', 100, 8.3, 5.0, 6.1, 0, '食品成分表', 'high');

-- 汁物
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, salt_g, source, confidence) VALUES
  ('fm_miso_soup', '味噌汁', '["みそ汁","miso soup"]', 'soup', 200, '1杯(200ml)', 50, 3.5, 1.5, 5.0, 1.5, '食品成分表', 'high');

-- セットメニュー・外食
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, salt_g, source, confidence) VALUES
  ('fm_gyudon', '牛丼', '["ぎゅうどん","beef bowl"]', 'set_meal', 380, '並盛(380g)', 700, 23, 22, 98, 3.5, '外食栄養調査', 'medium'),
  ('fm_curry_rice', 'カレーライス', '["カレー","curry rice"]', 'set_meal', 400, '1人前(400g)', 750, 18, 25, 110, 3.0, '外食栄養調査', 'medium'),
  ('fm_ramen', 'ラーメン', '["醤油ラーメン","味噌ラーメン","ramen"]', 'set_meal', 500, '1杯(500ml)', 500, 18, 15, 70, 6.0, '外食栄養調査', 'medium'),
  ('fm_sushi_set', '寿司セット', '["お寿司","sushi set"]', 'set_meal', 300, '8貫(300g)', 450, 22, 8, 72, 3.0, '外食栄養調査', 'medium'),
  ('fm_tempura_set', '天ぷら定食', '["てんぷら","tempura set"]', 'set_meal', 400, '1人前(400g)', 750, 18, 30, 95, 2.5, '外食栄養調査', 'medium'),
  ('fm_karaage_set', '唐揚げ定食', '["からあげ定食","fried chicken set"]', 'set_meal', 400, '1人前(400g)', 800, 28, 35, 85, 3.0, '外食栄養調査', 'medium');

-- コンビニ
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, salt_g, source, confidence) VALUES
  ('fm_onigiri', 'おにぎり', '["おむすび","onigiri","rice ball"]', 'convenience', 110, '1個(110g)', 180, 4, 1.5, 38, 1.2, 'コンビニ調査', 'medium'),
  ('fm_salad_chicken', 'サラダチキン', '["salad chicken"]', 'convenience', 115, '1パック(115g)', 110, 24, 1.5, 0.5, 1.5, 'コンビニ調査', 'medium'),
  ('fm_conv_sandwich', 'サンドイッチ', '["sandwich"]', 'convenience', 120, '1パック(120g)', 300, 10, 14, 32, 1.5, 'コンビニ調査', 'medium'),
  ('fm_conv_salad', 'コンビニサラダ', '["サラダ","salad"]', 'convenience', 120, '1パック(120g)', 100, 3, 5, 10, 1.0, 'コンビニ調査', 'medium');

-- 飲料
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, sugar_g, salt_g, source, confidence) VALUES
  ('fm_coffee_black', 'ブラックコーヒー', '["コーヒー","珈琲","coffee"]', 'beverage', 200, '1杯(200ml)', 8, 0.4, 0, 1.4, 0, 0, '食品成分表', 'high'),
  ('fm_green_tea', '緑茶', '["お茶","green tea"]', 'beverage', 200, '1杯(200ml)', 4, 0.4, 0, 0.4, 0, 0, '食品成分表', 'high'),
  ('fm_beer', 'ビール', '["生ビール","beer"]', 'beverage', 350, '1缶(350ml)', 140, 1.1, 0, 10.9, 0, 0, '食品成分表', 'high'),
  ('fm_highball', 'ハイボール', '["highball"]', 'beverage', 200, '1杯(200ml)', 70, 0, 0, 0, 0, 0, '推定', 'medium');

-- 間食
INSERT OR IGNORE INTO food_master (id, name, aliases, category, serving_size_g, serving_label, calories_kcal, protein_g, fat_g, carbs_g, sugar_g, source, confidence) VALUES
  ('fm_yogurt', 'ヨーグルト', '["yogurt"]', 'dairy', 100, '1カップ(100g)', 62, 3.6, 3.0, 4.9, 4.9, '食品成分表', 'high'),
  ('fm_banana', 'バナナ', '["banana"]', 'fruit', 100, '1本(100g)', 93, 1.1, 0.2, 22.5, 16.2, '食品成分表', 'high'),
  ('fm_chocolate', 'チョコレート', '["chocolate"]', 'snack', 50, '板チョコ半分(50g)', 280, 3.5, 17.0, 28.0, 25.0, '食品成分表', 'high');
