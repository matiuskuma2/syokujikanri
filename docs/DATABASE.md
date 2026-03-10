# データベース設計

## 概要
Cloudflare D1（SQLite）を使用。
マイグレーションファイルは `migrations/` に連番管理。

---

## テーブル一覧

| # | テーブル名 | 説明 |
|---|---|---|
| 1 | `accounts` | 契約アカウント（クリニック/サロン） |
| 2 | `account_memberships` | アカウント×スタッフのロール紐付け |
| 3 | `subscriptions` | サブスクリプション・プラン |
| 4 | `user_service_statuses` | ユーザー単位の機能 ON/OFF |
| 5 | `line_channels` | LINE チャンネル設定 |
| 6 | `line_users` | LINE ユーザー情報 |
| 7 | `user_accounts` | LINE ユーザーと契約アカウントの紐付け（独立管理） |
| 8 | `conversation_threads` | 会話スレッド |
| 9 | `conversation_messages` | 会話メッセージ |
| 10 | `message_attachments` | メッセージ添付ファイル |
| 11 | `image_analysis_jobs` | 画像解析ジョブキュー |
| 12 | `image_intake_results` | 画像解析結果 |
| 13 | `bot_mode_sessions` | BOT セッション状態 |
| 14 | `bots` | BOT 定義 |
| 15 | `bot_versions` | BOT バージョン |
| 16 | `knowledge_bases` | ナレッジベース |
| 17 | `knowledge_documents` | ナレッジドキュメント |
| 18 | `knowledge_document_pages` | ドキュメントページ分割 |
| 19 | `knowledge_chunks` | チャンク（RAG 検索単位） |
| 20 | `knowledge_chunk_embeddings` | チャンクのベクトル（Vectorize 連携） |
| 21 | `bot_knowledge_links` | BOT × ナレッジ紐付け |
| 22 | `retrieval_logs` | RAG 検索ログ |
| 23 | `user_profiles` | ユーザープロフィール・目標 |
| 24 | `intake_forms` | ヒアリングフォーム定義 |
| 25 | `intake_answers` | ヒアリング回答 |
| 26 | `question_definitions` | 質問定義マスタ |
| 27 | `daily_logs` | 日次ログ（体重・歩数・睡眠・水分・排便） |
| 28 | `meal_entries` | 食事記録 |
| 29 | `body_metrics` | 体型測定記録 |
| 30 | `activity_logs` | 運動ログ |
| 31 | `sleep_logs` | 睡眠ログ |
| 32 | `hydration_logs` | 水分ログ |
| 33 | `bowel_logs` | 排便ログ |
| 34 | `progress_photos` | 進捗写真 |
| 35 | `weekly_reports` | 週次レポート |
| 36 | `audit_logs` | 監査ログ |

---

## テーブル詳細定義

### accounts（契約アカウント）
```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'clinic',  -- 'clinic' | 'salon' | 'personal'
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'cancelled'
  timezone    TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  locale      TEXT NOT NULL DEFAULT 'ja',
  settings    TEXT,   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### account_memberships（スタッフロール紐付け）
```sql
CREATE TABLE account_memberships (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  user_id     TEXT NOT NULL,   -- 認証ユーザーID（管理者・スタッフ）
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,   -- 'superadmin' | 'admin' | 'staff'
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, user_id)
);
```

### subscriptions（サブスクリプション）
```sql
CREATE TABLE subscriptions (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  plan                  TEXT NOT NULL,  -- 'free' | 'starter' | 'pro' | 'enterprise'
  status                TEXT NOT NULL DEFAULT 'active',
  max_users             INTEGER NOT NULL DEFAULT 10,
  current_period_start  TEXT NOT NULL,
  current_period_end    TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### user_service_statuses（ユーザー単位 ON/OFF）
```sql
CREATE TABLE user_service_statuses (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  line_user_id      TEXT NOT NULL,
  bot_enabled       INTEGER NOT NULL DEFAULT 1,
  record_enabled    INTEGER NOT NULL DEFAULT 1,
  consult_enabled   INTEGER NOT NULL DEFAULT 1,
  intake_completed  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);
```

### line_channels（LINE チャンネル）
```sql
CREATE TABLE line_channels (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  channel_id        TEXT NOT NULL UNIQUE,
  channel_secret    TEXT NOT NULL,  -- 暗号化保存
  access_token      TEXT NOT NULL,  -- 暗号化保存
  webhook_path      TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### line_users（LINE ユーザー）
```sql
CREATE TABLE line_users (
  id              TEXT PRIMARY KEY,
  line_channel_id TEXT NOT NULL REFERENCES line_channels(id),
  line_user_id    TEXT NOT NULL,
  display_name    TEXT,
  picture_url     TEXT,
  status_message  TEXT,
  follow_status   TEXT NOT NULL DEFAULT 'following',  -- 'following' | 'blocked'
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  UNIQUE(line_channel_id, line_user_id)
);
```

### user_accounts（LINE ユーザー × 契約アカウント 紐付け）
```sql
-- LINE ユーザーを契約アカウントの「顧客」として紐付ける中間テーブル
CREATE TABLE user_accounts (
  id                TEXT PRIMARY KEY,
  line_user_id      TEXT NOT NULL,    -- LINE の user ID 文字列
  client_account_id TEXT NOT NULL REFERENCES accounts(id),
  status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'left' | 'blocked'
  joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
  left_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(line_user_id, client_account_id)
);
```

> **Note**: `user_accounts.id` を各 repository 層では `user_account_id` として参照する。
> これは LINE ユーザーを契約アカウント内で一意に識別するための内部ID。

### conversation_threads（会話スレッド）
```sql
CREATE TABLE conversation_threads (
  id                TEXT PRIMARY KEY,
  line_channel_id   TEXT NOT NULL REFERENCES line_channels(id),
  line_user_id      TEXT NOT NULL,
  client_account_id TEXT NOT NULL REFERENCES accounts(id),
  user_account_id   TEXT REFERENCES user_accounts(id),
  current_mode      TEXT NOT NULL DEFAULT 'record',  -- 'record' | 'consult' | 'system'
  status            TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'closed'
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_threads_line_user ON conversation_threads(line_user_id, status);
```

### conversation_messages（会話メッセージ）
```sql
CREATE TABLE conversation_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES conversation_threads(id),
  sender_type       TEXT NOT NULL,  -- 'user' | 'bot' | 'staff' | 'system'
  sender_account_id TEXT,
  source_platform   TEXT NOT NULL,  -- 'line' | 'web_admin'
  line_message_id   TEXT,
  message_type      TEXT NOT NULL,  -- 'text' | 'image' | 'audio' | 'template' | 'quick_reply' | 'system_event'
  raw_text          TEXT,
  normalized_text   TEXT,
  intent_label      TEXT,
  mode_at_send      TEXT,           -- 'record' | 'consult' | 'system'
  sent_at           TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_thread    ON conversation_messages(thread_id, sent_at);
CREATE INDEX idx_messages_line_user ON conversation_messages(thread_id);
```

### message_attachments（添付ファイル）
```sql
CREATE TABLE message_attachments (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL REFERENCES conversation_messages(id),
  storage_provider TEXT NOT NULL DEFAULT 'r2',  -- 'r2' | 'images' | 's3'
  storage_key      TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  file_size_bytes  INTEGER,
  original_filename TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### image_analysis_jobs（画像解析ジョブ）
```sql
CREATE TABLE image_analysis_jobs (
  id                    TEXT PRIMARY KEY,
  message_attachment_id TEXT NOT NULL REFERENCES message_attachments(id),
  job_status            TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'processing' | 'done' | 'failed'
  provider_route        TEXT NOT NULL DEFAULT 'openai_vision',  -- 'openai_vision' | 'mixed'
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  started_at            TEXT,
  finished_at           TEXT
);
```

### image_intake_results（画像解析結果）
```sql
CREATE TABLE image_intake_results (
  id                    TEXT PRIMARY KEY,
  message_attachment_id TEXT NOT NULL REFERENCES message_attachments(id),
  user_account_id       TEXT REFERENCES user_accounts(id),
  daily_log_id          TEXT REFERENCES daily_logs(id),
  image_category        TEXT NOT NULL,  -- 'meal_photo' | 'nutrition_label' | 'body_scale' | 'food_package' | 'progress_body_photo' | 'other' | 'unknown'
  confidence_score      REAL,
  extracted_json        TEXT,           -- JSON: AI 解析生結果
  proposed_action_json  TEXT,           -- JSON: 次アクション提案
  applied_flag          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### bot_mode_sessions（BOT セッション）
```sql
CREATE TABLE bot_mode_sessions (
  id              TEXT PRIMARY KEY,
  client_account_id TEXT NOT NULL REFERENCES accounts(id),
  line_user_id    TEXT NOT NULL,
  current_mode    TEXT NOT NULL,   -- 'intake' | 'record' | 'consult' | 'knowledge'
  current_step    TEXT NOT NULL,   -- ステップコード
  session_data    TEXT,            -- JSON: 途中入力データ
  turn_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_account_id, line_user_id)
);
CREATE INDEX idx_sessions_user    ON bot_mode_sessions(client_account_id, line_user_id);
CREATE INDEX idx_sessions_expires ON bot_mode_sessions(expires_at);
```

### bots・bot_versions
```sql
CREATE TABLE bots (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  name              TEXT NOT NULL,
  bot_key           TEXT NOT NULL UNIQUE,
  bot_type          TEXT NOT NULL DEFAULT 'diet',
  active_version_id TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bot_versions (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL REFERENCES bots(id),
  version        INTEGER NOT NULL,
  system_prompt  TEXT,  -- カスタムシステムプロンプト（NULL = デフォルト使用）
  settings       TEXT,  -- JSON
  is_active      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, version)
);
```

### knowledge_bases・knowledge_documents
```sql
CREATE TABLE knowledge_bases (
  id              TEXT PRIMARY KEY,
  account_id      TEXT,    -- NULL = システム共通
  knowledge_type  TEXT NOT NULL DEFAULT 'diet',
  name            TEXT NOT NULL,
  description     TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_documents (
  id                TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  title             TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'url' | 'file'
  source_url        TEXT,
  content           TEXT NOT NULL,
  token_count       INTEGER,
  is_active         INTEGER NOT NULL DEFAULT 1,
  indexed_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### RAG 用テーブル
```sql
CREATE TABLE knowledge_document_pages (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES knowledge_documents(id),
  page_number  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  token_count  INTEGER
);

CREATE TABLE knowledge_chunks (
  id                   TEXT PRIMARY KEY,
  knowledge_document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
  page_id              TEXT REFERENCES knowledge_document_pages(id),
  chunk_index          INTEGER NOT NULL,
  content              TEXT NOT NULL,
  token_count          INTEGER
);

CREATE TABLE knowledge_chunk_embeddings (
  id            TEXT PRIMARY KEY,
  chunk_id      TEXT NOT NULL REFERENCES knowledge_chunks(id) UNIQUE,
  vectorize_id  TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bot_knowledge_links (
  id                TEXT PRIMARY KEY,
  bot_id            TEXT NOT NULL REFERENCES bots(id),
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  priority          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, knowledge_base_id)
);

CREATE TABLE retrieval_logs (
  id                   TEXT PRIMARY KEY,
  client_account_id    TEXT NOT NULL,
  line_user_id         TEXT NOT NULL,
  query_text           TEXT NOT NULL,
  retrieved_chunk_ids  TEXT,  -- JSON 配列
  response_text        TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### user_profiles（ユーザープロフィール）
```sql
CREATE TABLE user_profiles (
  id               TEXT PRIMARY KEY,
  user_account_id  TEXT NOT NULL REFERENCES user_accounts(id) UNIQUE,
  nickname         TEXT,
  gender           TEXT,         -- 'male' | 'female' | 'other'
  age_range        TEXT,         -- '20s' | '30s' | '40s' | '50s+'
  height_cm        REAL,
  current_weight_kg REAL,
  target_weight_kg  REAL,
  goal_summary     TEXT,
  concern_tags     TEXT,         -- JSON 配列
  medical_notes    TEXT,
  activity_level   TEXT,         -- 'sedentary' | 'light' | 'moderate' | 'active'
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### intake_forms・intake_answers・question_definitions
```sql
CREATE TABLE question_definitions (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  question_text TEXT NOT NULL,
  input_type    TEXT NOT NULL,   -- 'text' | 'select' | 'number'
  options       TEXT,            -- JSON 配列（select の場合）
  order_index   INTEGER NOT NULL,
  is_required   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE intake_forms (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE intake_answers (
  id               TEXT PRIMARY KEY,
  user_account_id  TEXT NOT NULL REFERENCES user_accounts(id),
  question_code    TEXT NOT NULL,
  answer_text      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, question_code)
);
```

### daily_logs（日次ログ）
```sql
CREATE TABLE daily_logs (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),
  client_account_id TEXT NOT NULL REFERENCES accounts(id),
  log_date          TEXT NOT NULL,   -- YYYY-MM-DD
  source            TEXT NOT NULL DEFAULT 'line',  -- 'line' | 'web' | 'import' | 'staff'
  completion_status TEXT NOT NULL DEFAULT 'partial',  -- 'partial' | 'complete' | 'reviewed'
  notes             TEXT,
  ai_feedback       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, log_date)
);
CREATE INDEX idx_daily_logs_user_date ON daily_logs(user_account_id, log_date);
```

### meal_entries（食事記録）
```sql
CREATE TABLE meal_entries (
  id                  TEXT PRIMARY KEY,
  daily_log_id        TEXT NOT NULL REFERENCES daily_logs(id),
  meal_type           TEXT NOT NULL,  -- 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other'
  consumed_at         TEXT,           -- ISO8601 任意
  meal_text           TEXT,
  photo_count         INTEGER NOT NULL DEFAULT 0,
  calories_kcal       REAL,
  protein_g           REAL,
  fat_g               REAL,
  carbs_g             REAL,
  fiber_g             REAL,
  alcohol_kcal        REAL,
  confirmation_status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'confirmed' | 'corrected'
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_meal_entries_daily_log ON meal_entries(daily_log_id);
```

### body_metrics（体型測定）
```sql
CREATE TABLE body_metrics (
  id               TEXT PRIMARY KEY,
  daily_log_id     TEXT NOT NULL REFERENCES daily_logs(id),
  weight_kg        REAL,
  waist_cm         REAL,
  body_fat_percent REAL,
  temperature_c    REAL,
  edema_flag       INTEGER,    -- 0/1
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### activity_logs / sleep_logs / hydration_logs / bowel_logs
```sql
CREATE TABLE activity_logs (
  id           TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
  steps        INTEGER,
  distance_m   REAL,
  active_min   INTEGER,
  calories_burned REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sleep_logs (
  id            TEXT PRIMARY KEY,
  daily_log_id  TEXT NOT NULL REFERENCES daily_logs(id),
  sleep_start   TEXT,
  sleep_end     TEXT,
  duration_min  INTEGER,
  quality       INTEGER,    -- 1〜5
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE hydration_logs (
  id           TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
  total_ml     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bowel_logs (
  id           TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
  count        INTEGER,
  consistency  TEXT,    -- 'hard' | 'normal' | 'soft' | 'loose'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### progress_photos（進捗写真）
```sql
CREATE TABLE progress_photos (
  id                    TEXT PRIMARY KEY,
  user_account_id       TEXT NOT NULL REFERENCES user_accounts(id),
  daily_log_id          TEXT REFERENCES daily_logs(id),
  photo_date            TEXT NOT NULL,   -- YYYY-MM-DD
  photo_type            TEXT NOT NULL DEFAULT 'progress',  -- 'before' | 'progress' | 'after'
  storage_provider      TEXT NOT NULL DEFAULT 'r2',
  storage_key           TEXT NOT NULL,
  pose_label            TEXT,            -- 'front' | 'side' | 'mirror' | 'unknown'
  body_part_label       TEXT,            -- 'full_body' | 'upper_body' | 'torso' | 'unknown'
  note                  TEXT,
  is_public_use_allowed INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_progress_photos_user ON progress_photos(user_account_id, photo_date);
```

### weekly_reports（週次レポート）
```sql
CREATE TABLE weekly_reports (
  id               TEXT PRIMARY KEY,
  user_account_id  TEXT NOT NULL REFERENCES user_accounts(id),
  week_start       TEXT NOT NULL,   -- YYYY-MM-DD（月曜日）
  week_end         TEXT NOT NULL,   -- YYYY-MM-DD（日曜日）
  avg_weight_kg    REAL,
  min_weight_kg    REAL,
  max_weight_kg    REAL,
  weight_change    REAL,            -- 前週比
  total_steps      INTEGER,
  avg_steps        INTEGER,
  avg_sleep_hours  REAL,
  avg_water_ml     INTEGER,
  meal_log_count   INTEGER,
  log_days         INTEGER,
  ai_summary       TEXT,
  sent_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_account_id, week_start)
);
```

### audit_logs（監査ログ）
```sql
CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT,
  user_id       TEXT,
  action        TEXT NOT NULL,        -- 'create' | 'update' | 'delete' | 'login' | ...
  resource_type TEXT NOT NULL,        -- 'account' | 'user' | 'knowledge' | ...
  resource_id   TEXT,
  old_value     TEXT,                 -- JSON
  new_value     TEXT,                 -- JSON
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_logs_account ON audit_logs(account_id, created_at);
```

---

## ID 体系

| テーブル | ID 生成方法 | 例 |
|---|---|---|
| 全テーブル | `crypto.randomUUID()` | `550e8400-e29b-41d4-a716-446655440000` |
| `user_account_id` | `user_accounts.id` のこと | repository 層で参照する内部ID |

## カラム名規約

| 規約 | 例 |
|---|---|
| 外部キーは `{テーブル単数形}_id` | `daily_log_id`, `account_id` |
| LINE ユーザーIDは文字列で `line_user_id` | `U1234abcd` |
| ユーザー×契約の内部IDは `user_account_id` | `user_accounts.id` の参照 |
| 顧客側契約は `client_account_id` | `accounts.id` の参照 |
| 真偽値は INTEGER (0/1) | `is_active`, `applied_flag` |
| 日時は TEXT ISO8601 | `"2026-03-10T08:00:00Z"` |
| 日付は TEXT YYYY-MM-DD | `"2026-03-10"` |

---

## マイグレーション管理

> **⚠️ 実装済みファイル名との対応**  
> 現在 `migrations/` に適用済みのファイルは以下の通り。
> 設計時の命名と一部異なるため、必ず実ファイル名を優先すること。

| 設計上の名前 | 実際のファイル名 | 内容 |
|---|---|---|
| `0001_accounts.sql` | `0001_init_accounts.sql` | accounts, account_memberships, subscriptions |
| `0002_line.sql` | `0002_line_users.sql` | line_channels, line_users, user_accounts, user_service_statuses |
| `0003_bot.sql` | `0003_conversations.sql` | conversation_threads, conversation_messages, message_attachments |
| `0004_conversations.sql` | `0004_bots_knowledge.sql` | bots, bot_versions, bot_mode_sessions, knowledge_bases, knowledge_documents, bot_knowledge_links |
| `0005_knowledge.sql` | `0005_profiles_intake.sql` | user_profiles, question_definitions, intake_forms, intake_answers |
| `0006_user_data.sql` | `0006_daily_logs.sql` | daily_logs, meal_entries, body_metrics, activity_logs, sleep_logs, hydration_logs, bowel_logs |
| `0007_reports.sql` | `0007_images_reports.sql` | image_analysis_jobs, image_intake_results, progress_photos, weekly_reports, audit_logs, knowledge_document_pages, knowledge_chunks, knowledge_chunk_embeddings, retrieval_logs |

> **Note**: マイグレーション追加時は `0008_` から連番で命名する。

### ローカル開発
```bash
npx wrangler d1 migrations apply diet-bot-production --local
```

### 本番適用
```bash
npx wrangler d1 migrations apply diet-bot-production
```

### DB リセット（ローカル開発用）
```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply diet-bot-production --local
```

---

## Repository 層との対応

各テーブルのカラム名は `src/types/db.ts` の型定義と一致させること。
詳細な SQL クエリ実装は `docs/REPOSITORY.md` を参照。

| テーブル | Repository ファイル | 主な関数 |
|---|---|---|
| `accounts` | `accounts-repo.ts` | findAccountById, findAccountMembership, createAccount, updateAccountStatus |
| `account_memberships` | `accounts-repo.ts` | findAccountMembership |
| `subscriptions` | `accounts-repo.ts` | updateSubscription |
| `line_channels` | `line-users-repo.ts` | findLineChannelByAccountId |
| `line_users` | `line-users-repo.ts` | findLineUser, upsertLineUser |
| `user_accounts` | `line-users-repo.ts` | findUserAccount, ensureUserAccount |
| `user_service_statuses` | `line-users-repo.ts` | findUserServiceStatus, upsertUserServiceStatus |
| `bot_mode_sessions` | `bot-sessions-repo.ts` | findActiveSession, upsertSession, deleteSession, deleteExpiredSessions |
| `daily_logs` | `daily-logs-repo.ts` | findDailyLog, createDailyLog, ensureDailyLog, updateDailyLog |
| `meal_entries` | `meal-entries-repo.ts` | findMealEntriesByDailyLog, createMealEntry, updateMealEntry |
| `body_metrics` | `body-metrics-repo.ts` | upsertBodyMetrics, upsertWeight |
| `conversation_threads` | `conversations-repo.ts` | findOpenThread, createThread |
| `conversation_messages` | `conversations-repo.ts` | createMessage |
| `image_analysis_jobs` | `image-intake-repo.ts` | createImageAnalysisJob |
| `image_intake_results` | `image-intake-repo.ts` | saveImageIntakeResult |
| `progress_photos` | `progress-photos-repo.ts` | createProgressPhoto, listProgressPhotos |
| `knowledge_chunks` | `knowledge-repo.ts` | getKnowledgeChunksByIds |
| `weekly_reports` | `weekly-reports-repo.ts` | findWeeklyReport, createWeeklyReport, listRecentWeeklyReports |

> **⚠️ 注意**: 上記の Repository ファイルはすべて `src/repositories/` 配下に新規作成する。  
> 現在存在する `src/repository/index.ts` は誤実装のため削除対象。詳細は `docs/PROJECT_PLAN.md` 参照。

---

## `user_account_id` の概念・使い方

### 概要

`user_account_id` とは `user_accounts.id` の値のこと。  
**「LINE ユーザー × 契約アカウント（クリニック/サロン）」の組み合わせを識別する内部 ID** として機能する。

### なぜこの ID が必要か

- LINE ユーザー（`line_user_id = "U1234..."` 等）は複数の契約アカウントと紐付く可能性がある
- そのため、LINE ユーザー ID 単体では「どの契約アカウントの顧客か」が特定できない
- `user_accounts` テーブルが `(line_user_id, client_account_id)` の組み合わせを持ち、その主キーが `user_account_id` となる

### テーブル関連図（ID の流れ）

```
line_users
  id: "LU_abc..."               ← 内部管理ID（通常は使わない）
  line_user_id: "Uxxx..."       ← LINE プラットフォームの外部ID
  line_channel_id: "LC_abc..."

user_accounts
  id: "UA_xyz..."               ← ★ これが user_account_id
  line_user_id: "Uxxx..."       ← LINE の外部ID
  client_account_id: "AC_001..."  ← クリニックAのID

user_profiles
  id: "UP_xxx..."
  user_account_id: "UA_xyz..."  ← user_accounts.id を参照

daily_logs
  id: "DL_xxx..."
  user_account_id: "UA_xyz..."  ← user_accounts.id を参照
  client_account_id: "AC_001..."
```

### ⚠️ 注意：`src/types/models.ts` は誤実装

旧ファイル `src/types/models.ts`（削除対象）では `user_profiles` や `daily_logs` の
参照キーが `account_id + line_user_id` の複合形式になっているが、これは**誤り**。

正しくは `user_account_id` 単体で参照する。  
`src/types/db.ts` を新規作成する際は本ドキュメントの DDL を正とすること。

### Repository 層での使用パターン

```typescript
// 正しい使い方（user_account_id を主キーとして検索）
async function findDailyLog(
  db: D1Database,
  params: { userAccountId: string; logDate: string }
): Promise<DailyLog | null> {
  return db.prepare(
    'SELECT * FROM daily_logs WHERE user_account_id = ?1 AND log_date = ?2'
  ).bind(params.userAccountId, params.logDate).first<DailyLog>()
}

// 間違った使い方（line_user_id + account_id での検索は非推奨）
// ← src/repository/index.ts の現行コードがこのパターンを使っているが誤り
```
