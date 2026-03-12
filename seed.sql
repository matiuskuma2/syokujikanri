-- =============================================================
-- seed.sql
-- ローカル開発用テストデータ（--local フラグで投入）
-- 本番環境には絶対に投入しないこと！
--
-- 使用方法:
--   npx wrangler d1 execute diet-bot-production --local --file=./seed.sql
-- =============================================================

-- ===================================================================
-- 1. Accounts（契約アカウント）
-- ===================================================================

-- システムアカウント（内部管理用）
INSERT OR IGNORE INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
VALUES (
  'acc_system_00000000000000000000000000000001',
  'demo',
  '[SYSTEM] diet-bot Internal',
  'active',
  'Asia/Tokyo',
  'ja',
  datetime('now'),
  datetime('now')
);

-- クライアントアカウント（テスト用クリニック）
INSERT OR IGNORE INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
VALUES (
  'acc_client_00000000000000000000000000000001',
  'clinic',
  'テストクリニック（ローカル開発用）',
  'active',
  'Asia/Tokyo',
  'ja',
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 2. Account Memberships（管理ユーザー）
-- ===================================================================

-- スーパー管理者
INSERT OR IGNORE INTO account_memberships (id, account_id, user_id, email, role, status, created_at)
VALUES (
  'mem_superadmin_0000000000000000000000000001',
  'acc_system_00000000000000000000000000000001',
  'usr_superadmin_000000000000000000000000001',
  'admin@diet-bot.local',
  'superadmin',
  'active',
  datetime('now')
);

-- クライアントアカウント管理者
INSERT OR IGNORE INTO account_memberships (id, account_id, user_id, email, role, status, created_at)
VALUES (
  'mem_admin_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'usr_admin_0000000000000000000000000000001',
  'clinic-admin@diet-bot.local',
  'admin',
  'active',
  datetime('now')
);

-- ===================================================================
-- 3. Subscriptions（プラン）
-- ===================================================================

INSERT OR IGNORE INTO subscriptions (
  id, account_id, plan, status, max_users,
  current_period_start, current_period_end, created_at, updated_at
)
VALUES (
  'sub_client_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'pro',
  'active',
  100,
  datetime('now'),
  datetime('now', '+365 days'),
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 4. LINE Channels（LINEチャンネル設定）
-- ===================================================================

-- LINE チャンネル（Messaging API: 食事指導BOT）
-- Messaging API Channel ID: 1656660870
-- LIFF Channel ID: 2009409790 (LINE Login), LIFF ID: 2009409790-DekZRh4t
--
-- WARNING: 'ch_default_replace_me' はプレースホルダー。
--          .dev.vars の LINE_CHANNEL_ID と必ず一致させること。
--          本番では実際の UUID に置き換えること。
--
-- NOTE: channel_secret / access_token はダミー値。
--       実際の値は .dev.vars (ローカル) または wrangler secret (本番) で管理する。
--       seed.sql は DB スキーマの初期レコード挿入のみを目的とする。
INSERT OR IGNORE INTO line_channels (
  id, account_id, channel_id, channel_secret, access_token,
  webhook_path, is_active, created_at, updated_at
)
VALUES (
  'ch_default_replace_me',
  'acc_client_00000000000000000000000000000001',
  '1656660870',
  'DUMMY_CHANNEL_SECRET_REPLACE_IN_DEV_VARS',
  'DUMMY_ACCESS_TOKEN_REPLACE_IN_DEV_VARS',
  '/api/webhooks/line',
  1,
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 5. BOT 設定
-- ===================================================================

-- クライアント用 BOT
INSERT OR IGNORE INTO bots (
  id, account_id, name, bot_key, type, is_active, created_at, updated_at
)
VALUES (
  'bot_client_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'ダイエットサポートBOT',
  'diet-support-bot-v1',
  'line',
  1,
  datetime('now'),
  datetime('now')
);

-- BOT バージョン 1（初期プロンプト）
INSERT OR IGNORE INTO bot_versions (
  id, bot_id, version_number, system_prompt, is_published, created_at
)
VALUES (
  'bv_client_000000000000000000000000000001v1',
  'bot_client_00000000000000000000000000000001',
  1,
  'あなたはダイエットをサポートするAIアシスタントです。ユーザーの食事・体重・体型の記録を支援し、栄養バランスや健康的な生活習慣について親切・丁寧にアドバイスします。医療的な診断や処方は行わず、必要な場合は医師への相談を勧めます。',
  1,
  datetime('now')
);

-- ===================================================================
-- 6. ナレッジベース
-- ===================================================================

-- 共通ナレッジベース（全アカウント共通）
INSERT OR IGNORE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_common_000000000000000000000000000001',
  NULL,  -- NULL = システム共通
  '栄養・ダイエット基礎知識',
  '一般的なダイエット・栄養に関する基礎知識',
  1,
  10,
  datetime('now'),
  datetime('now')
);

-- クライアント固有ナレッジベース
INSERT OR IGNORE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_client_000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'テストクリニック独自FAQ',
  'クリニック固有のFAQ・指導方針',
  1,
  20,
  datetime('now'),
  datetime('now')
);

-- BOT ↔ ナレッジ紐付け
INSERT OR IGNORE INTO bot_knowledge_links (
  id, bot_id, knowledge_base_id, priority, created_at
)
VALUES (
  'bkl_0000000000000000000000000000000001',
  'bot_client_00000000000000000000000000000001',
  'kb_common_000000000000000000000000000001',
  10,
  datetime('now')
);

INSERT OR IGNORE INTO bot_knowledge_links (
  id, bot_id, knowledge_base_id, priority, created_at
)
VALUES (
  'bkl_0000000000000000000000000000000002',
  'bot_client_00000000000000000000000000000001',
  'kb_client_000000000000000000000000000001',
  20,
  datetime('now')
);

-- ===================================================================
-- 6.5 ナレッジドキュメント（初期知識データ）
-- ===================================================================

-- 共通知識: PFCバランス基礎
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000001',
  'kb_common_000000000000000000000000000001',
  'PFCバランスの基礎',
  'PFCバランスとは、タンパク質(Protein)・脂質(Fat)・炭水化物(Carbohydrate)の摂取比率のこと。一般的なダイエットの推奨比率はP:F:C=30:20:50。タンパク質は体重×1.2〜2.0g/日（運動量により変動）。脂質は総カロリーの20〜25%。炭水化物は残りで調整。極端な糖質制限は長期的にリバウンドリスクが高い。',
  1, 10, datetime('now'), datetime('now')
);

-- 共通知識: 基礎代謝と消費カロリー
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000002',
  'kb_common_000000000000000000000000000001',
  '基礎代謝と消費カロリー計算',
  '基礎代謝(BMR)の計算式（Harris-Benedict改良版）: 男性=13.397×体重kg+4.799×身長cm-5.677×年齢+88.362。女性=9.247×体重kg+3.098×身長cm-4.330×年齢+447.593。活動代謝(TDEE)=BMR×活動係数。活動係数: 座り仕事中心=1.2、軽い運動=1.375、週3-5回運動=1.55、毎日激しく運動=1.725。減量には1日あたりTDEE-500kcal程度の摂取カロリーが目安（週0.5kg減ペース）。',
  1, 10, datetime('now'), datetime('now')
);

-- 共通知識: 食事タイミングと頻度
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000003',
  'kb_common_000000000000000000000000000001',
  '食事タイミングと頻度のポイント',
  '1日3食を基本とし規則正しい時間に食べる。朝食を抜くと昼食での過食リスクが上がる。夕食は就寝3時間前までに済ませるのが理想。間食は200kcal以内を目安にし、タンパク質を含むもの（ヨーグルト、ナッツ等）が望ましい。空腹時間が長すぎると筋肉分解が進むため、6時間以上空けないことを推奨。水分は1日2L以上を目安に（水・お茶が中心）。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 運動とダイエット
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000004',
  'kb_common_000000000000000000000000000001',
  '運動とダイエットの関係',
  '有酸素運動（ウォーキング、ジョギング、水泳等）は脂肪燃焼に効果的。週150分以上の中程度の有酸素運動が推奨。筋トレは基礎代謝の維持・向上に不可欠。食事制限のみでは筋肉量が減少し、リバウンドしやすくなる。NEAT（非運動性活動熱産生）の増加も重要：階段を使う、歩く距離を増やす等。運動後30分以内のタンパク質摂取が筋肉回復に効果的。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 体重の変動について
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000005',
  'kb_common_000000000000000000000000000001',
  '体重の日内変動と正しい測り方',
  '体重は1日で1〜2kg変動するのが正常。水分、食事、排泄、運動で変わる。毎日同じ条件（朝起きてトイレ後、食事前）で測定するのがベスト。週単位の平均値で推移を見ることが重要。生理周期（女性）では2〜3kg増えることもある。1日で1kg体重が増えても、それは脂肪ではなく水分の可能性が高い。1kgの脂肪を蓄えるには約7200kcalの過剰摂取が必要。',
  1, 9, datetime('now'), datetime('now')
);

-- 共通知識: 日本食のカロリー目安
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000006',
  'kb_common_000000000000000000000000000001',
  '日本食の一般的なカロリー目安',
  '白米1膳(150g)=234kcal。食パン1枚(6枚切り)=158kcal。味噌汁1杯=50kcal。焼き魚(鮭1切れ)=130kcal。鶏胸肉100g=120kcal。牛丼=700kcal前後。カレーライス=750kcal前後。ラーメン=500〜800kcal。サラダ(ドレッシング込み)=100〜200kcal。コンビニおにぎり1個=170〜250kcal。コンビニサンドイッチ=250〜350kcal。コンビニサラダ=70〜150kcal。',
  1, 9, datetime('now'), datetime('now')
);

-- 共通知識: 外食・コンビニメニューの選び方
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000007',
  'kb_common_000000000000000000000000000001',
  '外食・コンビニでのヘルシー選択',
  'コンビニ: サラダチキン(110kcal/高タンパク)、ゆで卵(80kcal)、豆腐(60kcal)がおすすめ。揚げ物・菓子パンは避ける。ファミレス: グリルチキン、魚定食を選択。ご飯は少なめに。ファストフード: セットよりも単品＋サラダ。ドリンクは水かお茶。居酒屋: 枝豆、冷奴、刺身、焼き鳥（塩）がダイエット向き。ビールは1杯140kcal、ハイボール70kcal。',
  1, 7, datetime('now'), datetime('now')
);

-- 共通知識: よくある質問
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000008',
  'kb_common_000000000000000000000000000001',
  'ダイエットFAQ',
  'Q:停滞期はどうすれば？ A:体重が2〜4週間変わらないのは正常。食事内容を見直し、運動の種類を変えてみる。チートデイ（週1回普通に食べる日）も有効。Q:お酒は飲んでいい？ A:週2日以下、1回2杯以内なら大きな影響は少ない。蒸留酒（ハイボール、焼酎）が低カロリー。Q:夜食は太る？ A:時間帯より総カロリーが重要。ただし就寝前の食事は消化不良の原因に。Q:サプリメントは必要？ A:バランスの良い食事が基本。不足しがちなのはビタミンD、鉄分、食物繊維。',
  1, 7, datetime('now'), datetime('now')
);

-- ===================================================================
-- 7. テスト用 LINE ユーザー・UserAccount
-- ===================================================================

-- テストユーザー 1（フォロー済み）
INSERT OR IGNORE INTO line_users (
  id, line_channel_id, line_user_id, display_name, picture_url,
  follow_status, first_seen_at, last_seen_at
)
VALUES (
  'lu_test_0000000000000000000000000000001',
  'ch_default_replace_me',
  'U_test_line_user_id_000001',
  'テストユーザー田中',
  NULL,
  'following',
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 1 の UserAccount
INSERT OR IGNORE INTO user_accounts (
  id, line_user_id, client_account_id, status, joined_at, created_at, updated_at
)
VALUES (
  'ua_test_0000000000000000000000000000001',
  'U_test_line_user_id_000001',
  'acc_client_00000000000000000000000000000001',
  'active',
  datetime('now', '-7 days'),
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 1 のサービスステータス
INSERT OR IGNORE INTO user_service_statuses (
  id, account_id, line_user_id,
  bot_enabled, record_enabled, consult_enabled, intake_completed,
  created_at, updated_at
)
VALUES (
  'uss_test_000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'U_test_line_user_id_000001',
  1, 1, 1, 1,
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 2（新規ユーザー）
INSERT OR IGNORE INTO line_users (
  id, line_channel_id, line_user_id, display_name, picture_url,
  follow_status, first_seen_at, last_seen_at
)
VALUES (
  'lu_test_0000000000000000000000000000002',
  'ch_default_replace_me',
  'U_test_line_user_id_000002',
  'テストユーザー鈴木',
  NULL,
  'following',
  datetime('now', '-1 days'),
  datetime('now')
);

-- テストユーザー 2 の UserAccount
INSERT OR IGNORE INTO user_accounts (
  id, line_user_id, client_account_id, status, joined_at, created_at, updated_at
)
VALUES (
  'ua_test_0000000000000000000000000000002',
  'U_test_line_user_id_000002',
  'acc_client_00000000000000000000000000000001',
  'active',
  datetime('now', '-1 days'),
  datetime('now', '-1 days'),
  datetime('now')
);

-- テストユーザー 2 のサービスステータス（未インテーク）
INSERT OR IGNORE INTO user_service_statuses (
  id, account_id, line_user_id,
  bot_enabled, record_enabled, consult_enabled, intake_completed,
  created_at, updated_at
)
VALUES (
  'uss_test_000000000000000000000000000002',
  'acc_client_00000000000000000000000000000001',
  'U_test_line_user_id_000002',
  1, 1, 1, 0,
  datetime('now', '-1 days'),
  datetime('now')
);

-- ===================================================================
-- 8. テスト用 DailyLog・BodyMetrics（過去7日分）
-- ===================================================================

-- テストユーザー1の今日の日次ログ
INSERT OR IGNORE INTO daily_logs (
  id, user_account_id, client_account_id, log_date, source, completion_status, created_at, updated_at
)
VALUES (
  'dl_test_00000000000000000000000000000001',
  'ua_test_0000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  date('now'),
  'line',
  'partial',
  datetime('now'),
  datetime('now')
);

-- 今日の体型測定（体重）
INSERT OR IGNORE INTO body_metrics (
  id, daily_log_id, weight_kg, created_at, updated_at
)
VALUES (
  'bm_test_00000000000000000000000000000001',
  'dl_test_00000000000000000000000000000001',
  65.2,
  datetime('now'),
  datetime('now')
);

-- 今日の食事記録（朝食）
INSERT OR IGNORE INTO meal_entries (
  id, daily_log_id, meal_type, meal_text, calories_kcal,
  protein_g, fat_g, carbs_g, confirmation_status, created_at, updated_at
)
VALUES (
  'me_test_00000000000000000000000000000001',
  'dl_test_00000000000000000000000000000001',
  'breakfast',
  '玄米ご飯、味噌汁、納豆',
  450,
  18.5,
  8.2,
  72.0,
  'confirmed',
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 確認クエリ（コメントアウト済み — 必要に応じて有効化）
-- ===================================================================
-- SELECT 'accounts:', count(*) FROM accounts;
-- SELECT 'line_channels:', count(*) FROM line_channels;
-- SELECT 'line_users:', count(*) FROM line_users;
-- SELECT 'user_accounts:', count(*) FROM user_accounts;
-- SELECT 'bots:', count(*) FROM bots;
-- SELECT 'knowledge_bases:', count(*) FROM knowledge_bases;
-- SELECT 'daily_logs:', count(*) FROM daily_logs;
-- SELECT 'body_metrics:', count(*) FROM body_metrics;
-- SELECT 'meal_entries:', count(*) FROM meal_entries;
