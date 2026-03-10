# Repository 層 設計・実装仕様

## 概要

Cloudflare D1（SQLite）の prepared statement を TypeScript でラップした  
Repository 層の設計・SQL 実装仕様書。  
実装ファイルは `src/repositories/` 以下に配置する。

---

## ⚠️ 現在のコード状態と修正方針（2026-03-10）

### 誤実装ファイルの存在

現在のリポジトリには以下の**仕様外ファイル**が存在する。実装フェーズ開始前に削除すること。

| ファイル | 問題 |
|---|---|
| `src/repository/index.ts` | 単一ファイルに全 Repository が混在。DB キー名が仕様と異なる（例: `account_id + line_user_id` 複合キー vs 正規 `user_account_id`）。`RETURNING *` 未使用・TTL 計算方法も独自実装 |
| `src/types/models.ts` | `DATABASE.md` スキーマとカラム定義が乖離。`user_profiles` の主キーが `user_account_id` ではなく `account_id + line_user_id` になっている。`daily_logs` も同様 |

### 正規の型定義ファイル

本ドキュメントの仕様は **`src/types/db.ts`** を参照先とする。  
`src/types/models.ts` は削除し、`src/types/db.ts` に置き換える。

```typescript
// src/types/db.ts に定義する型の命名規則
// DATABASE.md のカラム名をそのまま snake_case で TypeScript interface に変換する

// NG: src/types/models.ts の誤った定義例
interface DailyLog {
  line_user_id: string   // ← 誤：direct FK でなく user_account_id を使う
  account_id: string     // ← 誤：同上
  weight_kg: number      // ← 誤：daily_logs テーブルに weight_kg カラムは存在しない
}                        //         weight_kg は body_metrics テーブルにある

// OK: src/types/db.ts の正しい定義
interface DailyLog {
  id: string
  user_account_id: string    // ← user_accounts.id を参照
  client_account_id: string  // ← accounts.id を参照（顧客側）
  log_date: string           // YYYY-MM-DD
  source: string             // 'line' | 'web' | 'import' | 'staff'
  completion_status: string  // 'partial' | 'complete' | 'reviewed'
  notes: string | null
  ai_feedback: string | null
  created_at: string
  updated_at: string
}
```

### `user_account_id` の概念説明

`user_account_id` = `user_accounts.id` の値であり、「LINE ユーザー × 契約アカウント」の組み合わせを識別する内部 ID。

```
LINE ユーザー (U1234...) が
  → クリニックA (accounts.id = abc...) の顧客として
  → user_accounts テーブルに登録される
  → その user_accounts.id = "xyz..." を user_account_id と呼ぶ

daily_logs.user_account_id = "xyz..."  ← このユーザーの日次ログ
meal_entries は daily_logs 経由なので直接 user_account_id を持たない
```

---

## 設計方針

| 項目 | 方針 |
|---|---|
| **ファイル分割** | テーブルグループ単位で 1 ファイル |
| **SQL スタイル** | `DB.prepare(sql).bind(...).run() / .first() / .all()` |
| **ID 生成** | `crypto.randomUUID()` を呼び出し元（または repo 内）で生成 |
| **日時** | ISO8601 文字列で保存・返却。JST 変換は呼び出し元が行う |
| **エラーハンドリング** | D1 エラーをそのまま throw（上位で catch） |
| **型定義** | `src/types/db.ts` の型を使用 |

---

## ファイル構成

```
src/repositories/
├── daily-logs-repo.ts        # daily_logs, body_metrics テーブル
├── meal-entries-repo.ts      # meal_entries テーブル
├── body-metrics-repo.ts      # body_metrics テーブル（upsert 専用）
├── conversations-repo.ts     # conversation_threads, conversation_messages
├── image-intake-repo.ts      # image_analysis_jobs, image_intake_results
├── progress-photos-repo.ts   # progress_photos テーブル
├── knowledge-repo.ts         # knowledge_chunks（RAG 用取得のみ）
│
│   ── 以下は Phase 1 後半で実装 ──
├── accounts-repo.ts          # accounts, account_memberships, subscriptions
├── line-users-repo.ts        # line_users, user_accounts, user_service_statuses
├── bot-sessions-repo.ts      # bot_mode_sessions
└── weekly-reports-repo.ts    # weekly_reports
```

---

## 1. `src/repositories/daily-logs-repo.ts`

### 使用テーブル
- `daily_logs`

### 実装仕様

#### 1-1. `findDailyLog` — 日次ログ取得

```typescript
interface FindDailyLogParams {
  userAccountId: string
  logDate: string  // YYYY-MM-DD
}

async function findDailyLog(
  db: D1Database,
  params: FindDailyLogParams
): Promise<DailyLog | null>
```

**SQL**
```sql
SELECT *
FROM daily_logs
WHERE user_account_id = ?1
  AND log_date = ?2
LIMIT 1
```

**bind 順序**: `[params.userAccountId, params.logDate]`  
**戻り値**: `DailyLog | null`（`db.prepare(...).bind(...).first<DailyLog>()`）

---

#### 1-2. `createDailyLog` — 日次ログ新規作成

```typescript
interface CreateDailyLogParams {
  id: string            // crypto.randomUUID() で生成済み
  userAccountId: string
  clientAccountId: string
  logDate: string       // YYYY-MM-DD
  source?: string       // 'line' | 'web' | 'import' | 'staff'（デフォルト 'line'）
}

async function createDailyLog(
  db: D1Database,
  params: CreateDailyLogParams
): Promise<DailyLog>
```

**SQL**
```sql
INSERT INTO daily_logs (
  id, user_account_id, client_account_id, log_date,
  source, completion_status, created_at, updated_at
) VALUES (
  ?1, ?2, ?3, ?4,
  ?5, 'partial', datetime('now'), datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, userAccountId, clientAccountId, logDate, source ?? 'line']`

---

#### 1-3. `ensureDailyLog` — 取得 or 作成（upsert パターン）

```typescript
async function ensureDailyLog(
  db: D1Database,
  params: {
    userAccountId: string
    clientAccountId: string
    logDate: string
    source?: string
  }
): Promise<DailyLog>
```

**処理フロー**
1. `findDailyLog` で取得
2. null なら `createDailyLog` で作成
3. 作成したレコードを返す

---

#### 1-4. `updateDailyLog` — 日次ログ更新

```typescript
interface UpdateDailyLogParams {
  id: string
  aiFeedback?: string
  completionStatus?: 'partial' | 'complete' | 'reviewed'
  notes?: string
}

async function updateDailyLog(
  db: D1Database,
  params: UpdateDailyLogParams
): Promise<void>
```

**SQL**
```sql
UPDATE daily_logs
SET
  ai_feedback        = COALESCE(?2, ai_feedback),
  completion_status  = COALESCE(?3, completion_status),
  notes              = COALESCE(?4, notes),
  updated_at         = datetime('now')
WHERE id = ?1
```

**bind 順序**: `[id, aiFeedback ?? null, completionStatus ?? null, notes ?? null]`

---

## 2. `src/repositories/meal-entries-repo.ts`

### 使用テーブル
- `meal_entries`

#### 2-1. `findMealEntriesByDailyLog` — 食事記録一覧取得

```typescript
async function findMealEntriesByDailyLog(
  db: D1Database,
  dailyLogId: string
): Promise<MealEntry[]>
```

**SQL**
```sql
SELECT *
FROM meal_entries
WHERE daily_log_id = ?1
ORDER BY created_at ASC
```

**bind 順序**: `[dailyLogId]`  
**戻り値**: `db.prepare(...).bind(...).all<MealEntry>()`の `.results`

---

#### 2-2. `createMealEntry` — 食事記録作成

```typescript
interface CreateMealEntryParams {
  id: string
  dailyLogId: string
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other'
  mealText?: string
  caloriesKcal?: number
  proteinG?: number
  fatG?: number
  carbsG?: number
  fiberG?: number
  confirmationStatus?: 'draft' | 'confirmed' | 'corrected'
}

async function createMealEntry(
  db: D1Database,
  params: CreateMealEntryParams
): Promise<MealEntry>
```

**SQL**
```sql
INSERT INTO meal_entries (
  id, daily_log_id, meal_type,
  meal_text, calories_kcal, protein_g, fat_g, carbs_g, fiber_g,
  confirmation_status, photo_count,
  created_at, updated_at
) VALUES (
  ?1, ?2, ?3,
  ?4, ?5, ?6, ?7, ?8, ?9,
  ?10, 0,
  datetime('now'), datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, dailyLogId, mealType, mealText??null, caloriesKcal??null, proteinG??null, fatG??null, carbsG??null, fiberG??null, confirmationStatus??'draft']`

---

#### 2-3. `updateMealEntry` — 食事記録更新

```typescript
interface UpdateMealEntryParams {
  id: string
  mealText?: string
  caloriesKcal?: number
  proteinG?: number
  fatG?: number
  carbsG?: number
  confirmationStatus?: 'draft' | 'confirmed' | 'corrected'
}

async function updateMealEntry(
  db: D1Database,
  params: UpdateMealEntryParams
): Promise<void>
```

**SQL**
```sql
UPDATE meal_entries
SET
  meal_text           = COALESCE(?2, meal_text),
  calories_kcal       = COALESCE(?3, calories_kcal),
  protein_g           = COALESCE(?4, protein_g),
  fat_g               = COALESCE(?5, fat_g),
  carbs_g             = COALESCE(?6, carbs_g),
  confirmation_status = COALESCE(?7, confirmation_status),
  updated_at          = datetime('now')
WHERE id = ?1
```

**bind 順序**: `[id, mealText??null, caloriesKcal??null, proteinG??null, fatG??null, carbsG??null, confirmationStatus??null]`

---

## 3. `src/repositories/body-metrics-repo.ts`

### 使用テーブル
- `body_metrics`

#### 3-1. `upsertBodyMetrics` — 体型測定 upsert

```typescript
interface UpsertBodyMetricsParams {
  id: string            // 新規作成時のみ使用（既存の場合は daily_log_id で照合）
  dailyLogId: string
  weightKg?: number
  waistCm?: number
  bodyFatPercent?: number
  temperatureC?: number
  edemaFlag?: 0 | 1
}

async function upsertBodyMetrics(
  db: D1Database,
  params: UpsertBodyMetricsParams
): Promise<void>
```

**処理フロー**  
1. `SELECT id FROM body_metrics WHERE daily_log_id = ?1` で既存確認
2. 存在すれば UPDATE、なければ INSERT

**INSERT SQL**
```sql
INSERT INTO body_metrics (
  id, daily_log_id,
  weight_kg, waist_cm, body_fat_percent, temperature_c, edema_flag,
  created_at, updated_at
) VALUES (
  ?1, ?2,
  ?3, ?4, ?5, ?6, ?7,
  datetime('now'), datetime('now')
)
```

**UPDATE SQL**
```sql
UPDATE body_metrics
SET
  weight_kg        = COALESCE(?2, weight_kg),
  waist_cm         = COALESCE(?3, waist_cm),
  body_fat_percent = COALESCE(?4, body_fat_percent),
  temperature_c    = COALESCE(?5, temperature_c),
  edema_flag       = COALESCE(?6, edema_flag),
  updated_at       = datetime('now')
WHERE daily_log_id = ?1
```

> **Note**: `upsertWeight` は `upsertBodyMetrics` の薄いラッパーとして実装可。  
> `weightKg` のみを渡す呼び出しパターンを `upsertWeight(db, dailyLogId, newId, weightKg)` として公開する。

---

## 4. `src/repositories/conversations-repo.ts`

### 使用テーブル
- `conversation_threads`
- `conversation_messages`

#### 4-1. `findOpenThread` — オープンスレッド取得

```typescript
async function findOpenThread(
  db: D1Database,
  params: {
    lineUserId: string
    clientAccountId: string
  }
): Promise<ConversationThread | null>
```

**SQL**
```sql
SELECT *
FROM conversation_threads
WHERE line_user_id      = ?1
  AND client_account_id = ?2
  AND status            = 'open'
ORDER BY started_at DESC
LIMIT 1
```

**bind 順序**: `[lineUserId, clientAccountId]`

---

#### 4-2. `createThread` — スレッド作成

```typescript
interface CreateThreadParams {
  id: string
  lineChannelId: string
  lineUserId: string
  clientAccountId: string
  userAccountId?: string
  currentMode?: 'record' | 'consult' | 'system'
}

async function createThread(
  db: D1Database,
  params: CreateThreadParams
): Promise<ConversationThread>
```

**SQL**
```sql
INSERT INTO conversation_threads (
  id, line_channel_id, line_user_id, client_account_id,
  user_account_id, current_mode, status,
  started_at, created_at, updated_at
) VALUES (
  ?1, ?2, ?3, ?4,
  ?5, ?6, 'open',
  datetime('now'), datetime('now'), datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, lineChannelId, lineUserId, clientAccountId, userAccountId??null, currentMode??'record']`

---

#### 4-3. `createMessage` — メッセージ保存

```typescript
interface CreateMessageParams {
  id: string
  threadId: string
  senderType: 'user' | 'bot' | 'staff' | 'system'
  sourcePlatform: 'line' | 'web_admin'
  messageType: 'text' | 'image' | 'audio' | 'template' | 'quick_reply' | 'system_event'
  rawText?: string
  normalizedText?: string
  intentLabel?: string
  modeAtSend?: string
  lineMessageId?: string
  sentAt: string  // ISO8601
}

async function createMessage(
  db: D1Database,
  params: CreateMessageParams
): Promise<ConversationMessage>
```

**SQL**
```sql
INSERT INTO conversation_messages (
  id, thread_id, sender_type, source_platform,
  message_type, raw_text, normalized_text, intent_label,
  mode_at_send, line_message_id,
  sent_at, created_at
) VALUES (
  ?1, ?2, ?3, ?4,
  ?5, ?6, ?7, ?8,
  ?9, ?10,
  ?11, datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, threadId, senderType, sourcePlatform, messageType, rawText??null, normalizedText??null, intentLabel??null, modeAtSend??null, lineMessageId??null, sentAt]`

---

## 5. `src/repositories/image-intake-repo.ts`

### 使用テーブル
- `image_analysis_jobs`
- `image_intake_results`

#### 5-1. `createImageAnalysisJob` — 解析ジョブ作成

```typescript
interface CreateImageAnalysisJobParams {
  id: string
  messageAttachmentId: string
  providerRoute?: string  // デフォルト 'openai_vision'
}

async function createImageAnalysisJob(
  db: D1Database,
  params: CreateImageAnalysisJobParams
): Promise<ImageAnalysisJob>
```

**SQL**
```sql
INSERT INTO image_analysis_jobs (
  id, message_attachment_id, job_status, provider_route, created_at
) VALUES (
  ?1, ?2, 'queued', ?3, datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, messageAttachmentId, providerRoute ?? 'openai_vision']`

---

#### 5-2. `saveImageIntakeResult` — 解析結果保存

```typescript
interface SaveImageIntakeResultParams {
  id: string
  messageAttachmentId: string
  userAccountId?: string
  dailyLogId?: string
  imageCategory: string    // ImageCategory 型
  confidenceScore?: number
  extractedJson?: string   // JSON 文字列
  proposedActionJson?: string  // JSON 文字列
}

async function saveImageIntakeResult(
  db: D1Database,
  params: SaveImageIntakeResultParams
): Promise<ImageIntakeResult>
```

**SQL**
```sql
INSERT INTO image_intake_results (
  id, message_attachment_id, user_account_id, daily_log_id,
  image_category, confidence_score,
  extracted_json, proposed_action_json,
  applied_flag, created_at, updated_at
) VALUES (
  ?1, ?2, ?3, ?4,
  ?5, ?6,
  ?7, ?8,
  0, datetime('now'), datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, messageAttachmentId, userAccountId??null, dailyLogId??null, imageCategory, confidenceScore??null, extractedJson??null, proposedActionJson??null]`

---

## 6. `src/repositories/progress-photos-repo.ts`

### 使用テーブル
- `progress_photos`

#### 6-1. `createProgressPhoto` — 進捗写真作成

```typescript
interface CreateProgressPhotoParams {
  id: string
  userAccountId: string
  dailyLogId?: string
  photoDate: string       // YYYY-MM-DD
  photoType?: 'before' | 'progress' | 'after'
  storageProvider?: string
  storageKey: string
  poseLabel?: string
  bodyPartLabel?: string
  note?: string
}

async function createProgressPhoto(
  db: D1Database,
  params: CreateProgressPhotoParams
): Promise<ProgressPhoto>
```

**SQL**
```sql
INSERT INTO progress_photos (
  id, user_account_id, daily_log_id,
  photo_date, photo_type,
  storage_provider, storage_key,
  pose_label, body_part_label, note,
  is_public_use_allowed,
  created_at, updated_at
) VALUES (
  ?1, ?2, ?3,
  ?4, ?5,
  ?6, ?7,
  ?8, ?9, ?10,
  0,
  datetime('now'), datetime('now')
)
RETURNING *
```

**bind 順序**: `[id, userAccountId, dailyLogId??null, photoDate, photoType??'progress', storageProvider??'r2', storageKey, poseLabel??null, bodyPartLabel??null, note??null]`

---

#### 6-2. `listProgressPhotos` — 進捗写真一覧取得

```typescript
interface ListProgressPhotosParams {
  userAccountId: string
  limit?: number   // デフォルト 20
  offset?: number  // デフォルト 0
}

async function listProgressPhotos(
  db: D1Database,
  params: ListProgressPhotosParams
): Promise<ProgressPhoto[]>
```

**SQL**
```sql
SELECT *
FROM progress_photos
WHERE user_account_id = ?1
ORDER BY photo_date DESC
LIMIT ?2 OFFSET ?3
```

**bind 順序**: `[userAccountId, limit ?? 20, offset ?? 0]`  
**戻り値**: `.all<ProgressPhoto>()` の `.results`

---

## 7. `src/repositories/knowledge-repo.ts`

### 使用テーブル
- `knowledge_chunks`

#### 7-1. `getKnowledgeChunksByIds` — チャンク一括取得（RAG 用）

```typescript
async function getKnowledgeChunksByIds(
  db: D1Database,
  chunkIds: string[]
): Promise<KnowledgeChunk[]>
```

**SQL（IN 句は動的生成）**
```sql
SELECT *
FROM knowledge_chunks
WHERE id IN (/* ? プレースホルダーを chunkIds.length 分生成 */)
ORDER BY chunk_index ASC
```

**実装注意**  
D1 の prepared statement は動的な IN 句をサポートしないため、  
`chunkIds.length` に応じてプレースホルダー文字列を動的生成する。

```typescript
// 実装例（コード記述は実装フェーズで行う）
const placeholders = chunkIds.map((_, i) => `?${i + 1}`).join(', ')
const sql = `SELECT * FROM knowledge_chunks WHERE id IN (${placeholders}) ORDER BY chunk_index ASC`
```

**戻り値**: `.all<KnowledgeChunk>()` の `.results`

---

## Phase 1 後半で実装予定の Repository

### `src/repositories/accounts-repo.ts`

| 関数名 | 説明 |
|---|---|
| `findAccountById` | アカウント取得 |
| `findAccountMembership` | スタッフロール取得 |
| `createAccount` | アカウント作成 |
| `updateAccountStatus` | アカウントステータス更新 |
| `updateSubscription` | サブスクリプション更新 |

### `src/repositories/line-users-repo.ts`

| 関数名 | 説明 |
|---|---|
| `findLineUser` | LINE ユーザー取得（channel_id + line_user_id） |
| `upsertLineUser` | LINE ユーザー作成 or 更新 |
| `findUserAccount` | user_accounts 取得 |
| `ensureUserAccount` | user_accounts 取得 or 作成 |
| `findUserServiceStatus` | ユーザー ON/OFF 取得 |
| `upsertUserServiceStatus` | ユーザー ON/OFF 更新 |
| `listActiveLineUsers` | アクティブユーザー一覧（Cron 用） |

### `src/repositories/bot-sessions-repo.ts`

| 関数名 | 説明 |
|---|---|
| `findActiveSession` | 有効セッション取得 |
| `upsertSession` | セッション作成 or 更新 |
| `deleteSession` | セッション削除 |
| `deleteExpiredSessions` | 期限切れセッション一括削除（Cron 用） |

### `src/repositories/weekly-reports-repo.ts`

| 関数名 | 説明 |
|---|---|
| `findWeeklyReport` | 週次レポート取得（user_account_id + week_start） |
| `createWeeklyReport` | 週次レポート作成 |
| `listRecentWeeklyReports` | 直近 N 件取得（トレンド計算用） |

---

## 型定義の参照先

各 repository で使用する型は `src/types/db.ts` に定義する。  
主要な型一覧:

```typescript
// src/types/db.ts に定義予定の型（抜粋）

interface DailyLog {
  id: string
  user_account_id: string
  client_account_id: string
  log_date: string
  source: string
  completion_status: string
  notes: string | null
  ai_feedback: string | null
  created_at: string
  updated_at: string
}

interface MealEntry {
  id: string
  daily_log_id: string
  meal_type: string
  consumed_at: string | null
  meal_text: string | null
  photo_count: number
  calories_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  fiber_g: number | null
  alcohol_kcal: number | null
  confirmation_status: string
  created_at: string
  updated_at: string
}

interface BodyMetrics {
  id: string
  daily_log_id: string
  weight_kg: number | null
  waist_cm: number | null
  body_fat_percent: number | null
  temperature_c: number | null
  edema_flag: number | null
  created_at: string
  updated_at: string
}

interface ConversationThread {
  id: string
  line_channel_id: string
  line_user_id: string
  client_account_id: string
  user_account_id: string | null
  current_mode: string
  status: string
  started_at: string
  last_message_at: string | null
  created_at: string
  updated_at: string
}

interface ConversationMessage {
  id: string
  thread_id: string
  sender_type: string
  sender_account_id: string | null
  source_platform: string
  line_message_id: string | null
  message_type: string
  raw_text: string | null
  normalized_text: string | null
  intent_label: string | null
  mode_at_send: string | null
  sent_at: string
  created_at: string
}

interface ImageAnalysisJob {
  id: string
  message_attachment_id: string
  job_status: string
  provider_route: string
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface ImageIntakeResult {
  id: string
  message_attachment_id: string
  user_account_id: string | null
  daily_log_id: string | null
  image_category: string
  confidence_score: number | null
  extracted_json: string | null
  proposed_action_json: string | null
  applied_flag: number
  created_at: string
  updated_at: string
}

interface ProgressPhoto {
  id: string
  user_account_id: string
  daily_log_id: string | null
  photo_date: string
  photo_type: string
  storage_provider: string
  storage_key: string
  pose_label: string | null
  body_part_label: string | null
  note: string | null
  is_public_use_allowed: number
  created_at: string
  updated_at: string
}

interface KnowledgeChunk {
  id: string
  knowledge_document_id: string
  page_id: string | null
  chunk_index: number
  content: string
  token_count: number | null
}
```

---

## D1 パターン早見表

| 操作 | メソッド | 戻り値 |
|---|---|---|
| 1 件取得 | `.first<T>()` | `T \| null` |
| 複数取得 | `.all<T>()` → `.results` | `T[]` |
| 挿入・更新 | `.run()` | `D1Result` |
| RETURNING 付き INSERT | `.first<T>()` | `T` |

---

## 実装時の注意事項

1. **`RETURNING *` は SQLite ≥ 3.35 が必要** — Cloudflare D1 は対応済み
2. **`COALESCE(?N, column_name)` パターン** — NULL を渡すと既存値を保持する PATCH 動作
3. **トランザクション** — D1 は `DB.batch([stmt1, stmt2])` でバッチ実行が可能（原子性あり）
4. **IN 句の動的生成** — プレースホルダーを `?1, ?2, ...` の形で動的結合する
5. **`crypto.randomUUID()`** — Cloudflare Workers 環境では `globalThis.crypto.randomUUID()` が使用可能
