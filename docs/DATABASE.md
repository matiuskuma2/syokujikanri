# データベース設計

## 概要
Cloudflare D1（SQLite）を使用。
マイグレーションファイルは `migrations/` に連番管理。

---

## テーブル一覧

| # | テーブル名 | 説明 |
|---|---|---|
| 1 | `accounts` | 契約アカウント（クリニック/サロン） |
| 2 | `account_memberships` | アカウント×ユーザーのロール紐付け |
| 3 | `subscriptions` | サブスクリプション・プラン |
| 4 | `user_service_statuses` | ユーザー単位の機能 ON/OFF |
| 5 | `line_channels` | LINE チャンネル設定 |
| 6 | `line_users` | LINE ユーザー情報 |
| 7 | `conversation_threads` | 会話スレッド |
| 8 | `conversation_messages` | 会話メッセージ |
| 9 | `message_attachments` | メッセージ添付ファイル |
| 10 | `bot_mode_sessions` | BOT セッション状態 |
| 11 | `bots` | BOT 定義 |
| 12 | `bot_versions` | BOT バージョン |
| 13 | `knowledge_bases` | ナレッジベース |
| 14 | `knowledge_documents` | ナレッジドキュメント |
| 15 | `knowledge_document_pages` | ドキュメントページ分割 |
| 16 | `knowledge_chunks` | チャンク（RAG 検索単位） |
| 17 | `knowledge_chunk_embeddings` | チャンクのベクトル（Vectorize 連携） |
| 18 | `bot_knowledge_links` | BOT × ナレッジ紐付け |
| 19 | `retrieval_logs` | RAG 検索ログ |
| 20 | `user_profiles` | ユーザープロフィール・目標 |
| 21 | `intake_forms` | ヒアリングフォーム定義 |
| 22 | `intake_answers` | ヒアリング回答 |
| 23 | `question_definitions` | 質問定義マスタ |
| 24 | `daily_logs` | 日次ログ（体重・歩数・睡眠・水分・排便） |
| 25 | `meal_entries` | 食事記録 |
| 26 | `body_metrics` | 体型測定記録 |
| 27 | `activity_logs` | 運動ログ |
| 28 | `sleep_logs` | 睡眠ログ |
| 29 | `hydration_logs` | 水分ログ |
| 30 | `bowel_logs` | 排便ログ |
| 31 | `image_intake_results` | 画像解析結果 |
| 32 | `progress_photos` | 進捗写真 |
| 33 | `weekly_reports` | 週次レポート |
| 34 | `audit_logs` | 監査ログ |

---

## テーブル詳細定義

### accounts（契約アカウント）
```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,          -- UUID
  type        TEXT NOT NULL DEFAULT 'clinic',  -- 'clinic' | 'salon' | 'personal'
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'cancelled'
  timezone    TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  locale      TEXT NOT NULL DEFAULT 'ja',
  settings    TEXT,                      -- JSON: BOT設定等
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### account_memberships（ロール紐付け）
```sql
CREATE TABLE account_memberships (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  user_id     TEXT NOT NULL,             -- auth ユーザーID
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,             -- 'superadmin' | 'admin' | 'staff'
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, user_id)
);
```

### subscriptions（サブスクリプション）
```sql
CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  plan            TEXT NOT NULL,         -- 'free' | 'starter' | 'pro' | 'enterprise'
  status          TEXT NOT NULL DEFAULT 'active',
  max_users       INTEGER NOT NULL DEFAULT 10,
  current_period_start  TEXT NOT NULL,
  current_period_end    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### user_service_statuses（ユーザー単位 ON/OFF）
```sql
CREATE TABLE user_service_statuses (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  line_user_id    TEXT NOT NULL,
  bot_enabled     INTEGER NOT NULL DEFAULT 1,     -- 0/1
  record_enabled  INTEGER NOT NULL DEFAULT 1,
  consult_enabled INTEGER NOT NULL DEFAULT 1,
  intake_completed INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);
```

### line_channels（LINE チャンネル）
```sql
CREATE TABLE line_channels (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  channel_id            TEXT NOT NULL UNIQUE,
  channel_secret        TEXT NOT NULL,    -- 暗号化保存
  access_token          TEXT NOT NULL,    -- 暗号化保存
  webhook_path          TEXT NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### line_users（LINE ユーザー）
```sql
CREATE TABLE line_users (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  line_user_id    TEXT NOT NULL,
  display_name    TEXT,
  picture_url     TEXT,
  status_message  TEXT,
  follow_status   TEXT NOT NULL DEFAULT 'following',  -- 'following' | 'blocked'
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  UNIQUE(account_id, line_user_id)
);
```

### conversation_threads（会話スレッド）
```sql
CREATE TABLE conversation_threads (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  line_user_id    TEXT NOT NULL,
  thread_date     TEXT NOT NULL,          -- YYYY-MM-DD
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, thread_date)
);
```

### conversation_messages（会話メッセージ）
```sql
CREATE TABLE conversation_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES conversation_threads(id),
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  direction       TEXT NOT NULL,          -- 'inbound' | 'outbound'
  message_type    TEXT NOT NULL,          -- 'text' | 'image' | 'sticker' | 'template'
  content         TEXT,                   -- テキスト内容
  bot_mode        TEXT,                   -- 処理時のBOTモード
  step_code       TEXT,                   -- 処理時のステップコード
  metadata        TEXT,                   -- JSON: LINE message ID等
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conv_messages_thread ON conversation_messages(thread_id);
CREATE INDEX idx_conv_messages_user   ON conversation_messages(account_id, line_user_id, created_at);
```

### message_attachments（添付ファイル）
```sql
CREATE TABLE message_attachments (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES conversation_messages(id),
  r2_key          TEXT NOT NULL,          -- R2 オブジェクトキー
  content_type    TEXT NOT NULL,
  file_size       INTEGER,
  image_type      TEXT,                   -- 'meal_photo' | 'nutrition_label' | 'body_scale' | 'progress_photo'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### bot_mode_sessions（BOT セッション）
```sql
CREATE TABLE bot_mode_sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  current_mode    TEXT NOT NULL,          -- 'intake' | 'record' | 'consult' | 'knowledge'
  current_step    TEXT NOT NULL,          -- ステップコード
  session_data    TEXT,                   -- JSON: 途中入力データ
  turn_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);
CREATE INDEX idx_bot_sessions_user ON bot_mode_sessions(account_id, line_user_id);
CREATE INDEX idx_bot_sessions_expires ON bot_mode_sessions(expires_at);
```

### bots・bot_versions
```sql
CREATE TABLE bots (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  name            TEXT NOT NULL,
  bot_key         TEXT NOT NULL UNIQUE,
  bot_type        TEXT NOT NULL DEFAULT 'diet',
  active_version_id TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bot_versions (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  version         INTEGER NOT NULL,
  system_prompt   TEXT,                   -- カスタムシステムプロンプト
  settings        TEXT,                   -- JSON
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, version)
);
```

### knowledge_bases・knowledge_documents
```sql
CREATE TABLE knowledge_bases (
  id              TEXT PRIMARY KEY,
  account_id      TEXT,                   -- NULLはシステム共通
  name            TEXT NOT NULL,
  description     TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_documents (
  id              TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  title           TEXT NOT NULL,
  source_type     TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'url' | 'file'
  source_url      TEXT,
  content         TEXT NOT NULL,
  token_count     INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  indexed_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### RAG 用テーブル
```sql
CREATE TABLE knowledge_document_pages (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES knowledge_documents(id),
  page_number     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER
);

CREATE TABLE knowledge_chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES knowledge_documents(id),
  page_id         TEXT REFERENCES knowledge_document_pages(id),
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER
);

CREATE TABLE knowledge_chunk_embeddings (
  id              TEXT PRIMARY KEY,
  chunk_id        TEXT NOT NULL REFERENCES knowledge_chunks(id) UNIQUE,
  vectorize_id    TEXT NOT NULL,          -- Vectorize のベクトルID
  model           TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE retrieval_logs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  retrieved_chunk_ids TEXT,              -- JSON配列
  response_text   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### user_profiles（ユーザープロフィール）
```sql
CREATE TABLE user_profiles (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  nickname        TEXT,
  gender          TEXT,                   -- 'male' | 'female' | 'other'
  age_range       TEXT,                   -- '20s' | '30s' | '40s' | '50s+'
  height_cm       REAL,
  current_weight_kg REAL,
  target_weight_kg  REAL,
  goal_summary    TEXT,
  concern_tags    TEXT,                   -- JSON配列
  medical_notes   TEXT,
  activity_level  TEXT,                   -- 'sedentary' | 'light' | 'moderate' | 'active'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id)
);
```

### intake_forms・intake_answers・question_definitions
```sql
CREATE TABLE question_definitions (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,   -- 'nickname', 'gender', 'age_range', ...
  question_text   TEXT NOT NULL,
  input_type      TEXT NOT NULL,          -- 'text' | 'select' | 'number'
  options         TEXT,                   -- JSON配列（select の場合）
  order_index     INTEGER NOT NULL,
  is_required     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE intake_forms (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  name            TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE intake_answers (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  question_code   TEXT NOT NULL,
  answer_text     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, question_code)
);
```

### daily_logs（日次ログ）
```sql
CREATE TABLE daily_logs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  log_date        TEXT NOT NULL,          -- YYYY-MM-DD
  weight_kg       REAL,
  waist_cm        REAL,
  steps           INTEGER,
  water_ml        INTEGER,
  sleep_hours     REAL,
  sleep_quality   INTEGER,                -- 1-5
  bowel_count     INTEGER,
  mood            INTEGER,                -- 1-5
  notes           TEXT,
  ai_feedback     TEXT,                   -- 当日のAIフィードバック
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, log_date)
);
CREATE INDEX idx_daily_logs_user_date ON daily_logs(account_id, line_user_id, log_date);
```

### meal_entries（食事記録）
```sql
CREATE TABLE meal_entries (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  log_date        TEXT NOT NULL,          -- YYYY-MM-DD
  meal_type       TEXT NOT NULL,          -- 'breakfast' | 'lunch' | 'dinner' | 'snack'
  description     TEXT,                   -- ユーザー入力テキスト
  r2_key          TEXT,                   -- 食事写真R2キー
  calories        REAL,
  protein_g       REAL,
  fat_g           REAL,
  carbs_g         REAL,
  is_ai_parsed    INTEGER NOT NULL DEFAULT 0,
  ai_confidence   REAL,                   -- 0.0-1.0
  ai_raw_result   TEXT,                   -- JSON: AI生解析結果
  user_confirmed  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_meal_entries_user_date ON meal_entries(account_id, line_user_id, log_date);
```

### image_intake_results（画像解析結果）
```sql
CREATE TABLE image_intake_results (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  message_id      TEXT NOT NULL,          -- LINE メッセージID
  r2_key          TEXT NOT NULL,
  image_type      TEXT NOT NULL,          -- 'meal_photo' | 'nutrition_label' | 'body_scale' | 'progress_photo'
  analysis_result TEXT,                   -- JSON: 解析結果
  linked_entry_id TEXT,                   -- meal_entries.id or daily_logs.id
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### progress_photos（進捗写真）
```sql
CREATE TABLE progress_photos (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  photo_date      TEXT NOT NULL,          -- YYYY-MM-DD
  r2_key          TEXT NOT NULL,
  weight_kg       REAL,                   -- 撮影時の体重
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_progress_photos_user ON progress_photos(account_id, line_user_id, photo_date);
```

### weekly_reports（週次レポート）
```sql
CREATE TABLE weekly_reports (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  line_user_id    TEXT NOT NULL,
  week_start      TEXT NOT NULL,          -- YYYY-MM-DD（月曜日）
  week_end        TEXT NOT NULL,          -- YYYY-MM-DD（日曜日）
  avg_weight_kg   REAL,
  min_weight_kg   REAL,
  max_weight_kg   REAL,
  weight_change   REAL,                   -- 前週比
  total_steps     INTEGER,
  avg_steps       INTEGER,
  avg_sleep_hours REAL,
  avg_water_ml    INTEGER,
  meal_log_count  INTEGER,
  ai_summary      TEXT,                   -- AI生成サマリーテキスト
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, line_user_id, week_start)
);
```

### audit_logs（監査ログ）
```sql
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT,
  user_id         TEXT,
  action          TEXT NOT NULL,          -- 'create' | 'update' | 'delete' | 'login' | ...
  resource_type   TEXT NOT NULL,          -- 'account' | 'user' | 'knowledge' | ...
  resource_id     TEXT,
  old_value       TEXT,                   -- JSON
  new_value       TEXT,                   -- JSON
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_logs_account ON audit_logs(account_id, created_at);
```

---

## マイグレーション管理

| ファイル | 内容 |
|---|---|
| `0001_accounts.sql` | accounts, account_memberships, subscriptions |
| `0002_line.sql` | line_channels, line_users, user_service_statuses |
| `0003_bot.sql` | bots, bot_versions, bot_mode_sessions, conversation_threads, conversation_messages, message_attachments |
| `0004_knowledge.sql` | knowledge_bases, knowledge_documents, knowledge_document_pages, knowledge_chunks, knowledge_chunk_embeddings, bot_knowledge_links, retrieval_logs |
| `0005_user_data.sql` | question_definitions, intake_forms, intake_answers, user_profiles, daily_logs, meal_entries, body_metrics, activity_logs, sleep_logs, hydration_logs, bowel_logs, image_intake_results, progress_photos |
| `0006_reports.sql` | weekly_reports, audit_logs |

### ローカル開発
```bash
npx wrangler d1 migrations apply diet-bot-production --local
```

### 本番適用
```bash
npx wrangler d1 migrations apply diet-bot-production
```
