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
INSERT OR IGNORE INTO line_channels (
  id, account_id, channel_id, channel_secret, access_token,
  webhook_path, is_active, created_at, updated_at
)
VALUES (
  'ch_default_replace_me',
  'acc_client_00000000000000000000000000000001',
  '1656660870',
  '1dc7f90ab6bb265fd9a6f9eb2bf06e6c',
  'wpO2bsNwKwIz1vhVAouJAlMfLipXwiq8HAGeeSuWbvwVe77FKQVh1DpJzfUbPxpJJMz9MY3z4x/J4gDitrUMljwNamL0O/30SYCh1TwgTRffZ7kXvYPnUCTYXCdngdLOq11Syo72UKhcMJe2CBz5cgdB04t89/1O/w1cDnyilFU=',
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
