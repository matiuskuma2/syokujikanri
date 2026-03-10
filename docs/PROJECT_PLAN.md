# 実装計画（PROJECT PLAN）

> **このドキュメントの目的**  
> ドキュメント整備状況・現在のコード状態・実装フェーズのロードマップを管理する。  
> 各タスクには「依存関係」「実装ファイル」「完了条件」を明記する。  
> **最終更新: 2026-03-10（users/me 認証ルーティング & 画像配信 API を正式仕様に昇格。API.md に `/api/auth/line` / `/api/users/me/*` / `/api/files/*` の完全仕様を追加。IMPLEMENTATION_GUIDE.md セクション20 を正式仕様に昇格・詳細化）**

---

## ドキュメント整備ステータス

| ドキュメント | 状態 | 備考 |
|---|---|---|
| `docs/README.md` | ✅ 完了 | プロジェクト概要・ディレクトリ構造 |
| `docs/ARCHITECTURE.md` | ✅ 完了 | システム全体図・データフロー・セキュリティ |
| `docs/DATABASE.md` | ✅ 完了 | テーブル定義・マイグレーション対応表・ID 体系・`user_account_id` 概念説明 |
| `docs/REPOSITORY.md` | ✅ 完了 | Repository 層 SQL 実装仕様（正規型定義含む） |
| `docs/API.md` | ✅ 完了 | エンドポイント定義・リクエスト/レスポンス形式（`/api/auth/line` / `/api/users/me/*` 全 6 エンドポイント / `/api/files/progress|meals/:id` / 署名付き URL（Phase 2）追加済み） |
| `docs/PROMPTS.md` | ✅ 完了 | 全プロンプト定義（TypeScript 仕様） |
| `docs/BOT_FLOW.md` | ✅ 完了 | モード・ステップコード・キーワード定義 |
| `docs/DEPLOYMENT.md` | ✅ 完了 | ローカル・本番デプロイ手順 |
| `docs/PROJECT_PLAN.md` | ✅ 完了（本ファイル） | フェーズ別実装計画 |
| `docs/IMPLEMENTATION_GUIDE.md` | ✅ 完了 | 実装雛形・ロジック仕様・ユーティリティ集（セクション 20: 20-A 認証フロー・JWT ペイロード設計 / 20-B Workers プロキシ方式・R2 キー命名規則 / 20-C 依存関係グラフ を正式仕様として確定） |

---

## ⚠️ 現在のコード状態（2026-03-10 時点）

### 誤実装ファイル一覧

以下のファイルが**ドキュメント仕様と乖離した状態で存在する**。  
実装フェーズ開始前に必ず下記の方針で対処すること。

| ファイル | 状態 | 問題点 | 対処方針 |
|---|---|---|---|
| `src/repository/index.ts` | ❌ 誤実装・削除対象 | 単一ファイルに全 Repository が混在。型名・カラム名が `DATABASE.md` と乖離（`account_id + line_user_id` 複合キー vs 正規 `user_account_id`）。`src/repositories/` 分割構成ではない | **削除して `src/repositories/` 配下に再実装** |
| `src/types/models.ts` | ❌ 誤実装・削除対象 | `user_profiles` / `daily_logs` の主キー参照が `line_user_id + account_id` 複合形式。`DailyLog` に `weight_kg` 等 `body_metrics` テーブルのカラムが混入。`BotModeSession.mode` は `DATABASE.md` では `current_mode`。`AccountMembership.role` に `'member'` が存在するが正規は `'staff'` | **削除して `src/types/db.ts` に置き換え** |
| `src/ai/prompts.ts` | ❌ 誤配置・削除対象 | `src/ai/` 配下にあるが仕様は `src/services/ai/` 配下。エクスポート名も `PROMPTS.md` 仕様と異なる（例: `buildConsultSystemPrompt` vs `buildConsultPrompt`）。`src/types/models.ts` の誤った型を import している | **削除して `src/services/ai/prompts.ts` に正規実装** |
| `src/ai/client.ts` | ❌ 誤配置・削除対象 | 上記と同様。`src/services/ai/` 配下に移動が必要。`src/types/models.ts` の誤った型を import している | **削除して `src/services/ai/client.ts` に正規実装** |
| `src/bot/dispatcher.ts` | ❌ 誤実装・削除対象 | `src/repository/index.ts` の誤った Repository を import。誤った型（`models.ts`）を使用。`ARCHITECTURE.md` の設計と構造が乖離 | **削除して正規 Repository・型を使って再実装** |
| `src/bot/consumer.ts` | ⚠️ 要修正 | Queue コンシューマーの骨格は存在（43行）。ただし `src/repository/index.ts` / `models.ts` への依存あり | **誤 import を除去し正規 Repository に差し替え** |
| `src/bot/cron.ts` | ⚠️ 要修正 | Cron 処理の骨格は存在（116行）。ただし同様の誤 import あり | **誤 import を除去し正規 Repository に差し替え** |
| `src/routes/admin/auth.ts` | ⚠️ 要修正 | 骨格あり（55行）。`models.ts` への依存を確認・修正が必要 |  **誤 import を確認・除去** |
| `src/routes/admin/dashboard.ts` | ⚠️ 要修正 | 骨格あり（80行）。同上 | **誤 import を確認・除去** |
| `src/routes/admin/users.ts` | ⚠️ 要修正 | 骨格あり（96行）。同上 | **誤 import を確認・除去** |
| `src/routes/user/index.ts` | ⚠️ 要修正 | 骨格あり（107行）。同上 | **誤 import を確認・除去** |
| `src/routes/webhooks/line.ts` | ⚠️ 要修正 | Webhook 受信骨格あり（61行）。`src/routes/line/webhook.ts` に移動が必要 | **移動 + 誤 import 除去** |
| `src/middleware/auth.ts` | 🔍 要確認 | JWT 認証ミドルウェア骨格あり（48行）。`ARCHITECTURE.md` 設計と整合か確認が必要 | **内容確認後、必要なら修正** |
| `src/utils/jwt.ts` | 🔍 要確認 | JWT ユーティリティ（89行）。仕様との整合確認が必要 | **内容確認後、必要なら修正** |
| `src/utils/line.ts` | 🔍 要確認 | LINE API ヘルパー（154行）。`replyText` / `pushText` 等は `ARCHITECTURE.md` 仕様と一致するか確認 | **内容確認後、必要なら修正** |
| `src/utils/response.ts` | 🔍 要確認 | レスポンスユーティリティ（34行）。小規模なので仕様確認 | **内容確認後、必要なら修正** |

### 現在存在するが仕様に定義されていないファイル

| ファイル | 状況 | 方針 |
|---|---|---|
| `src/routes/line/` | ディレクトリのみ、ファイルなし | `webhook.ts` を新規作成 |
| `src/routes/webhooks/line.ts` | 仕様では `src/routes/line/webhook.ts` が正規 | 内容を移動して削除 |

### 仕様に定義されているが存在しないファイル

| ファイル | フェーズ | 優先度 |
|---|---|---|
| `src/types/db.ts` | Phase 1a | ⭐ 最高（全層の前提） |
| `src/repositories/` 以下 11 ファイル | Phase 1a | ⭐ 最高 |
| `src/services/ai/prompts.ts` | Phase 1b | ⭐ 高 |
| `src/services/ai/client.ts` | Phase 1b | ⭐ 高 |
| `src/services/ai/rag.ts` | Phase 1b | 高 |
| `src/services/ai/embeddings.ts` | Phase 1b | 高 |
| `src/bot/intake-flow.ts` | Phase 1c | 高 |
| `src/bot/record-mode.ts` | Phase 1c | 高 |
| `src/bot/consult-mode.ts` | Phase 1c | 高 |
| `src/routes/line/webhook.ts` | Phase 1c | 高 |
| `src/routes/admin/accounts.ts` | Phase 1d | 中 |
| `src/routes/admin/bots.ts` | Phase 1d | 中 |
| `src/routes/admin/knowledge.ts` | Phase 1d | 中 |
| `src/routes/user/dashboard.ts` | Phase 1d | 中 |
| `src/routes/user/records.ts` | Phase 1d | 中 |
| `src/routes/user/progress-photos.ts` | Phase 1d | 中 |
| `src/routes/user/weekly-reports.ts` | Phase 1d | 中 |
| `src/jobs/daily-reminder.ts` | Phase 1e | 中 |
| `src/jobs/weekly-report.ts` | Phase 1e | 中 |
| `src/jobs/image-analysis.ts` | Phase 1e | 中 |
| `src/middleware/rbac.ts` | Phase 1d | 中 |
| `src/routes/line/auth.ts` | Phase 1d | 中（LINE Access Token 認証 → JWT 発行） |
| `src/routes/user/me.ts` | Phase 1d | 中（`/api/users/me/*` 全ルート） |
| `src/routes/user/files.ts` | Phase 1d | 中（画像配信プロキシ） |
| `src/repositories/attachments-repo.ts` | Phase 1d | 中（`getMessageAttachmentById` / `getThreadByAttachmentId`） |

---

## 目標ディレクトリ構造（仕様通り）

```
src/
├── types/
│   ├── db.ts          ← 【未作成】DATABASE.md スキーマに対応した型定義
│   ├── bindings.ts    ← 【既存・要確認】Cloudflare Bindings 型
│   └── index.ts       ← 【既存】re-export
│                         ※ models.ts は削除対象
│
├── repositories/      ← 【未作成】11 ファイル全て新規
│   ├── daily-logs-repo.ts
│   ├── meal-entries-repo.ts
│   ├── body-metrics-repo.ts
│   ├── conversations-repo.ts
│   ├── image-intake-repo.ts
│   ├── progress-photos-repo.ts
│   ├── knowledge-repo.ts
│   ├── accounts-repo.ts
│   ├── line-users-repo.ts
│   ├── bot-sessions-repo.ts
│   ├── weekly-reports-repo.ts
│   ├── subscriptions-repo.ts  ← 【未作成】新規（checkServiceAccess）
│   └── attachments-repo.ts    ← 【未作成】新規（getMessageAttachmentById / getThreadByAttachmentId）
│
├── services/
│   └── ai/
│       ├── prompts.ts     ← 【未作成】src/ai/prompts.ts を削除して新規作成
│       ├── client.ts      ← 【未作成】src/ai/client.ts を削除して新規作成
│       ├── rag.ts         ← 【未作成】新規
│       └── embeddings.ts  ← 【未作成】新規
│
├── bot/
│   ├── dispatcher.ts  ← 【要再実装】現在のものは削除対象
│   ├── intake-flow.ts ← 【未作成】新規
│   ├── record-mode.ts ← 【未作成】新規
│   ├── consult-mode.ts← 【未作成】新規
│   ├── consumer.ts    ← 【要修正】誤 import 除去
│   └── cron.ts        ← 【要修正】誤 import 除去（または src/jobs/ に移動）
│
├── routes/
│   ├── line/
│   │   ├── webhook.ts ← 【未作成】src/routes/webhooks/line.ts の内容を移動
│   │   └── auth.ts    ← 【未作成】新規（LINE Access Token → JWT 発行）
│   ├── admin/
│   │   ├── auth.ts      ← 【要修正】誤 import 除去
│   │   ├── accounts.ts  ← 【未作成】新規
│   │   ├── users.ts     ← 【要修正】誤 import 除去
│   │   ├── bots.ts      ← 【未作成】新規
│   │   ├── knowledge.ts ← 【未作成】新規
│   │   └── dashboard.ts ← 【要修正】誤 import 除去
│   └── user/
│       ├── dashboard.ts       ← 【未作成】新規（index.ts は削除対象か要確認）
│       ├── records.ts         ← 【未作成】新規
│       ├── progress-photos.ts ← 【未作成】新規
│       ├── weekly-reports.ts  ← 【未作成】新規
│       ├── me.ts              ← 【未作成】新規（/api/users/me/* 全ルート）
│       └── files.ts           ← 【未作成】新規（/api/files/* 画像配信プロキシ）
│
├── middleware/
│   ├── auth.ts   ← 【要確認/修正】JWT 検証に差し替え（現在はデバッグヘッダー認証）
│   └── rbac.ts   ← 【未作成】新規（user ロールの userAccountId 一致チェック）
│
├── utils/
│   ├── jwt.ts        ← 【要確認】仕様整合確認
│   ├── line.ts       ← 【要確認】仕様整合確認（LINE API ヘルパー）
│   └── response.ts   ← 【要確認】仕様整合確認
│
└── jobs/              ← 【未作成】3 ファイル新規
    ├── daily-reminder.ts
    ├── weekly-report.ts
    └── image-analysis.ts
```

---

## 実装前に必ず行う前処理

```bash
# 1. 誤実装ファイルの削除
rm src/repository/index.ts
rm src/types/models.ts
rm src/ai/prompts.ts
rm src/ai/client.ts
rmdir src/ai
rmdir src/repository
rm src/bot/dispatcher.ts   # 誤実装。正規版は src/bot/dispatcher.ts として再実装

# 2. 仕様通りのディレクトリ作成
mkdir -p src/repositories
mkdir -p src/services/ai
mkdir -p src/jobs

# 3. 既存 routes/webhooks/line.ts の内容を routes/line/webhook.ts に移動
#    （src/routes/line/ ディレクトリは既に存在）
```

---

## 実装フェーズ概要

```
Phase 1a: 基盤・型定義・Repository 層（14 タスク）
    ↓（依存）
Phase 1b: AI サービス層（4 タスク）
    ↓（依存）
Phase 1c: Bot ディスパッチャー・LINE Webhook（7 タスク）
    ↓（依存）
Phase 1d: Admin API / User API / ダッシュボード（16 タスク）
    ↓（依存）
Phase 1e: Cron ジョブ・テスト・デプロイ（9 タスク）
```

---

## Phase 1a: 基盤・型定義・Repository 層

**目的**: 全レイヤーが依存する型と DB アクセス層を確立する  
**前提**: 上記「前処理」を完了済みであること

### タスク一覧

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1a-1 | DB テーブル型定義 | `src/types/db.ts` | ❌ 未作成 | `DATABASE.md` の全テーブルスキーマに対応した TypeScript interface が定義済み。`user_account_id` / `client_account_id` の命名規則が一致している |
| 1a-2 | LINE イベント型定義 | `src/types/line.ts` | ❌ 未作成 | follow / unfollow / message / postback イベントが型付き |
| 1a-3 | API 共通型定義 | `src/types/api.ts` | ❌ 未作成（※`response.ts` に一部あり） | `ApiResponse<T>` / エラーコード型が定義済み |
| 1a-4 | daily-logs-repo 実装 | `src/repositories/daily-logs-repo.ts` | ❌ 未作成 | `findDailyLog` / `createDailyLog` / `ensureDailyLog` / `updateDailyLog` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-5 | meal-entries-repo 実装 | `src/repositories/meal-entries-repo.ts` | ❌ 未作成 | `findMealEntriesByDailyLog` / `createMealEntry` / `updateMealEntry` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-6 | body-metrics-repo 実装 | `src/repositories/body-metrics-repo.ts` | ❌ 未作成 | `upsertBodyMetrics` / `upsertWeight` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-7 | conversations-repo 実装 | `src/repositories/conversations-repo.ts` | ❌ 未作成 | `findOpenThread` / `createThread` / `createMessage` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-8 | image-intake-repo 実装 | `src/repositories/image-intake-repo.ts` | ❌ 未作成 | `createImageAnalysisJob` / `saveImageIntakeResult` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-9 | progress-photos-repo 実装 | `src/repositories/progress-photos-repo.ts` | ❌ 未作成 | `createProgressPhoto` / `listProgressPhotos` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-10 | knowledge-repo 実装 | `src/repositories/knowledge-repo.ts` | ❌ 未作成 | `getKnowledgeChunksByIds` が REPOSITORY.md SQL 仕様通りに動作（動的 IN 句実装済み） |
| 1a-11 | accounts-repo 実装 | `src/repositories/accounts-repo.ts` | ❌ 未作成 | `findAccountById` / `findAccountMembership` / `createAccount` / `updateAccountStatus` |
| 1a-12 | line-users-repo 実装 | `src/repositories/line-users-repo.ts` | ❌ 未作成 | `findLineUser` / `upsertLineUser` / `findUserAccount` / `ensureUserAccount` / `findUserServiceStatus` / `upsertUserServiceStatus` / `listActiveLineUsers` |
| 1a-13 | bot-sessions-repo 実装 | `src/repositories/bot-sessions-repo.ts` | ❌ 未作成 | `findActiveSession` / `upsertSession` / `deleteSession` / `deleteExpiredSessions` |
| 1a-14 | weekly-reports-repo 実装 | `src/repositories/weekly-reports-repo.ts` | ❌ 未作成 | `findWeeklyReport` / `createWeeklyReport` / `listRecentWeeklyReports` |

**依存関係**: 1a-1 → 1a-4〜1a-14（型定義が全 repo の前提）  
**参照ドキュメント**: `docs/DATABASE.md`、`docs/REPOSITORY.md`

### `src/types/db.ts` の型命名規則（DATABASE.md 準拠）

```
テーブル主キー識別子:
  - user_accounts.id    → 変数名は user_account_id
  - accounts.id         → 変数名は client_account_id（顧客側）または account_id（管理者側）
  - line_users.id       → 変数名は line_user_record_id（内部ID、通常は不使用）
  - line_user_id        → LINE プラットフォームの U xxxxxxx 文字列（外部ID）

型命名規則（pascal case）:
  - daily_logs          → DailyLog
  - meal_entries        → MealEntry
  - body_metrics        → BodyMetrics
  - user_accounts       → UserAccount
  - bot_mode_sessions   → BotModeSession
  - user_service_statuses → UserServiceStatus

⚠️ models.ts との差異（削除理由）:
  - UserProfile: line_user_id + account_id → 正規は user_account_id
  - DailyLog: weight_kg等 body_metricsカラムが混入 → 正規は body_metrics テーブルに分離
  - BotModeSession: mode → 正規は current_mode
  - AccountMembership: role 'member' → 正規は 'staff'
  - LineUser: account_id → 正規は line_channel_id（line_channels への FK）
  - ConversationThread: account_id → 正規は client_account_id
  - IntakeAnswer: line_user_id + account_id → 正規は user_account_id
```

---

## Phase 1b: AI サービス層

**目的**: OpenAI との通信層と全プロンプト定義を実装する

### タスク一覧

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1b-1 | プロンプト定数・型・ビルダー実装 | `src/services/ai/prompts.ts` | ❌ 未作成（`src/ai/prompts.ts` は削除対象） | `PROMPTS.md` の全定数・型・ビルダー関数が実装済み。`src/ai/prompts.ts`（旧）は削除済み |
| 1b-2 | OpenAI クライアント実装 | `src/services/ai/client.ts` | ❌ 未作成（`src/ai/client.ts` は削除対象） | `callOpenAI()` / `callVisionAPI()` が動作。`src/ai/client.ts`（旧）は削除済み |
| 1b-3 | Embeddings 実装 | `src/services/ai/embeddings.ts` | ❌ 未作成 | `text-embedding-3-small` でベクトル生成可能 |
| 1b-4 | RAG コンテキスト構築実装 | `src/services/ai/rag.ts` | ❌ 未作成 | `buildContextStrings()` が全プロンプト変数（profileSummary / recentDailySummary 等）を生成 |

**依存関係**: 1a-1（db.ts）→ 1b-1 → 1b-2 → 1b-4  
**参照ドキュメント**: `docs/PROMPTS.md`、`docs/ARCHITECTURE.md`（RAG フロー）

### `src/services/ai/prompts.ts` エクスポート一覧（PROMPTS.md 準拠）

```typescript
// 定数
export const SYSTEM_GUARDRAILS           // 共通ガードレール
export const IMAGE_CATEGORY_PROMPT       // 画像分類
export const MEAL_IMAGE_ESTIMATION_PROMPT // 食事画像解析
export const NUTRITION_LABEL_PROMPT      // 栄養ラベル解析
export const BODY_SCALE_PROMPT           // 体重計解析
export const PROGRESS_PHOTO_PROMPT       // 進捗写真判定
export const WELCOME_MESSAGE             // ウェルカムメッセージ
export const SESSION_TIMEOUT_MESSAGE     // セッションタイムアウト
export const UNRECOGNIZED_INPUT_MESSAGE  // 未認識入力

// ビルダー関数（PROMPTS.md の Input 型・Output 型に準拠）
export function buildConsultPrompt(input: ConsultPromptInput)
export function buildDailyFeedbackPrompt(input: DailyFeedbackPromptInput)
export function buildWeeklyReportPrompt(input: WeeklyReportPromptInput)
export function buildMealTypeInferencePrompt(input: MealTypeInferenceInput)
export function buildMissingQuestionPrompt(input: MissingQuestionInput)
```

> ⚠️ `src/ai/prompts.ts` の現行エクスポート名（`buildConsultSystemPrompt` 等）は仕様外。  
> 正規の名前は `buildConsultPrompt` 等（PROMPTS.md 参照）。

---

## Phase 1c: Bot ディスパッチャー・LINE Webhook

**目的**: LINE メッセージを受信し、適切な処理に振り分ける

### タスク一覧

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1c-1 | LINE Webhook 受信 | `src/routes/line/webhook.ts` | ❌ 未作成（`webhooks/line.ts` の内容を移植・修正） | X-Line-Signature 検証 + Queue エンキュー + 即時 200 返却 |
| 1c-2 | Queue コンシューマー | `src/bot/consumer.ts` | ⚠️ 要修正（43行の骨格あり） | follow / unfollow / message / postback イベント処理。正規 Repository を使用 |
| 1c-3 | Bot ディスパッチャー | `src/bot/dispatcher.ts` | ❌ 再実装（現行は削除対象） | セッション確認・モード判定・ルーティング。正規 Repository・型を使用 |
| 1c-4 | Intake フロー | `src/bot/intake-flow.ts` | ❌ 未作成 | 全ステップ（`intake_start` → `intake_complete`）動作 |
| 1c-5 | Record モード | `src/bot/record-mode.ts` | ❌ 未作成 | テキスト解析 + 画像解析 + D1 保存 + 日次フィードバック |
| 1c-6 | Consult モード | `src/bot/consult-mode.ts` | ❌ 未作成 | RAG 検索 + OpenAI 回答生成 + 返信 |
| 1c-7 | LINE API ヘルパー | `src/utils/line.ts` | 🔍 要確認（154行あり） | `sendMessage` / `replyMessage` / `getMessageContent` が ARCHITECTURE.md 仕様と一致 |

**依存関係**: Phase 1a + 1b 完了後  
**参照ドキュメント**: `docs/BOT_FLOW.md`、`docs/ARCHITECTURE.md`

---

## Phase 1d: Admin API / User API / ダッシュボード

**目的**: 管理者・ユーザー向けの API とダッシュボード UI を実装する

### 管理者 API タスク

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1d-1 | JWT 認証ミドルウェア | `src/middleware/auth.ts` | 🔍 要確認（48行あり） | Bearer トークン検証が仕様通りに動作 |
| 1d-2 | RBAC ミドルウェア | `src/middleware/rbac.ts` | ❌ 未作成 | superadmin / admin ロール制御 |
| 1d-3 | 管理者認証 API | `src/routes/admin/auth.ts` | ⚠️ 要修正（55行の骨格あり） | POST /api/admin/auth/login が正規 Repository を使用 |
| 1d-4 | アカウント管理 API | `src/routes/admin/accounts.ts` | ❌ 未作成 | GET/POST/PATCH |
| 1d-5 | ユーザー管理 API | `src/routes/admin/users.ts` | ⚠️ 要修正（96行の骨格あり） | GET 一覧・詳細 / PATCH ON/OFF が正規 Repository を使用 |
| 1d-6 | BOT 管理 API | `src/routes/admin/bots.ts` | ❌ 未作成 | CRUD |
| 1d-7 | ナレッジ管理 API | `src/routes/admin/knowledge.ts` | ❌ 未作成 | CRUD + インデックス登録 |
| 1d-8 | ダッシュボード API | `src/routes/admin/dashboard.ts` | ⚠️ 要修正（80行の骨格あり） | GET stats / conversations が正規 Repository を使用 |

### ユーザー API タスク

> **注記（2026-03-10）**: `/api/user/*`（マジックリンク方式）と `/api/users/me/*`（JWT 方式）の 2 系統が存在する。  
> MVP では `/api/users/me/*` を正式とし、`/api/user/*` は後方互換のため維持する。  
> 詳細は `docs/API.md`「ユーザー API」「LINE ユーザー認証 API」「ユーザー認証付き API」を参照。

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1d-9 | ユーザーダッシュボード API（マジックリンク） | `src/routes/user/dashboard.ts` | ❌ 未作成（`user/index.ts` は要確認・整理） | GET /api/user/dashboard（後方互換） |
| 1d-10 | 日次ログ API（マジックリンク） | `src/routes/user/records.ts` | ❌ 未作成 | GET 一覧 / GET 日別詳細 |
| 1d-11 | 進捗写真 API（マジックリンク） | `src/routes/user/progress-photos.ts` | ❌ 未作成 | GET 一覧 |
| 1d-12 | 週次レポート API（マジックリンク） | `src/routes/user/weekly-reports.ts` | ❌ 未作成 | GET 一覧 |
| 1d-13a | LINE LIFF トークン認証 & JWT 発行 | `src/routes/line/auth.ts` | ❌ 未作成 | POST /api/auth/line が LINE Profile API 検証 → JWT 発行。`INVALID_LINE_TOKEN` / `USER_NOT_REGISTERED` エラーハンドリング済み |
| 1d-13b | ユーザー認証付き API（JWT 方式） | `src/routes/user/me.ts` | ❌ 未作成 | GET /api/users/me 全 6 エンドポイントが requireAuth + RBAC 経由で動作。`jwt.sub = userAccountId` で絞り込み |
| 1d-13c | 画像配信プロキシ | `src/routes/user/files.ts` | ❌ 未作成 | GET /api/files/progress/:id と /api/files/meals/:id が所有者チェック + R2 プロキシで動作 |
| 1d-13d | 添付ファイル Repository | `src/repositories/attachments-repo.ts` | ❌ 未作成 | `getMessageAttachmentById` / `getThreadByAttachmentId` が IMPLEMENTATION_GUIDE.md 20-B の SQL 通りに動作 |

### フロントエンド（ダッシュボード UI）タスク

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1d-14 | 管理者ダッシュボード HTML | `src/index.ts`（インライン） | 🔍 要確認（595行あり） | ログイン・サマリー・ユーザー一覧が正規 API エンドポイントを呼び出す |
| 1d-15 | ユーザー PWA HTML | `src/index.ts`（インライン） | 🔍 要確認（上記と同） | 体重グラフ・食事ログ・進捗写真。画像表示は Fetch API + Object URL を使用（Bearer トークン付与のため） |
| 1d-16 | 管理者 JS | `public/static/admin.js` | 🔍 要確認 | API 呼び出し・UI 更新 |
| 1d-17 | ユーザー JS | `public/static/user.js` | 🔍 要確認 | API 呼び出し・グラフ表示。`/api/files/*` の画像は Fetch + Object URL 変換パターンで実装 |

**依存関係**: Phase 1a + 1b 完了後（1c は並行可）  
**参照ドキュメント**: `docs/API.md`

---

## Phase 1e: Cron ジョブ・テスト・デプロイ

**目的**: 自動化ジョブを実装し、本番環境へデプロイする

### タスク一覧

| # | タスク | 実装ファイル | 状態 | 完了条件 |
|---|---|---|---|---|
| 1e-1 | 日次リマインダー Cron | `src/jobs/daily-reminder.ts` | ❌ 未作成（`src/bot/cron.ts` に骨格あり・要整理） | 未記録ユーザーへ LINE 送信 |
| 1e-2 | 週次レポート生成 Cron | `src/jobs/weekly-report.ts` | ❌ 未作成（同上） | データ集計 + AI 生成 + LINE 送信 |
| 1e-3 | 画像解析ジョブ | `src/jobs/image-analysis.ts` | ❌ 未作成 | Queue からジョブ取得・処理 |
| 1e-4 | ビルド確認 | `npm run build` | - | ビルドエラーなし |
| 1e-5 | ローカル動作確認 | PM2 + wrangler pages dev | - | 全エンドポイント正常応答 |
| 1e-6 | D1 本番 DB 作成 | `npx wrangler d1 create diet-bot-production` | ❌ 未実行 | database_id 取得・wrangler.jsonc に反映 |
| 1e-7 | 本番マイグレーション | `npx wrangler d1 migrations apply diet-bot-production` | ❌ 未実行 | 全 7 マイグレーション適用 |
| 1e-8 | Cloudflare Pages デプロイ | `npx wrangler pages deploy dist` | ❌ 未実行 | 本番 URL で動作確認 |
| 1e-9 | Secrets 設定 | `npx wrangler pages secret put` | ❌ 未実行 | OPENAI_API_KEY / LINE / JWT 設定済み |

**依存関係**: Phase 1a〜1d 完了後  
**参照ドキュメント**: `docs/DEPLOYMENT.md`

---

## 実装開始前チェックリスト

```
□ src/repository/index.ts を削除済み
□ src/types/models.ts を削除済み
□ src/ai/prompts.ts を削除済み
□ src/ai/client.ts を削除済み
□ src/ai/ ディレクトリを削除済み
□ src/bot/dispatcher.ts（現行）を削除済み
□ src/repositories/ ディレクトリ作成済み
□ src/services/ai/ ディレクトリ作成済み
□ src/jobs/ ディレクトリ作成済み
□ src/types/db.ts の型定義が DATABASE.md と一致していることを確認
□ 全型の user_account_id 命名が REPOSITORY.md 仕様と一致していることを確認
□ src/routes/webhooks/line.ts の内容を src/routes/line/webhook.ts に移植済み
```

---

## 実装時の共通ルール

### ファイル命名規則

| カテゴリ | 規則 | 例 |
|---|---|---|
| Repository | `{テーブルグループ}-repo.ts` | `daily-logs-repo.ts` |
| Routes | `{機能名}.ts` | `dashboard.ts`, `users.ts` |
| Bot 処理 | `{モード名}-mode.ts` or `{処理名}.ts` | `record-mode.ts` |
| Services | `{サービス名}.ts` | `prompts.ts`, `client.ts` |
| Jobs | `{ジョブ名}.ts` | `daily-reminder.ts` |

### エラーハンドリング方針

- **Repository 層**: D1 エラーをそのまま throw（上位で catch）
- **Routes 層**: try/catch → `src/utils/response.ts` の `errorResponse()` で統一
- **Bot 処理**: エラー時はユーザーに「処理に失敗しました」を LINE 返信

### テスト方針（Phase 1 MVP）

- 単体テストは必須としない（MVP フェーズ）
- `curl` / Postman での手動テストで動作確認
- ローカルの `wrangler pages dev --local` 環境で検証
- D1 動作確認: `npx wrangler d1 execute diet-bot-production --local --command="SELECT ..."`

---

## 次フェーズ優先タスク（Phase 1d 後半〜1e）

> **最終更新: 2026-03-10**  
> `docs/IMPLEMENTATION_GUIDE.md` セクション 17〜20 の追加を受けて更新。

### 最優先: users/me 認証ルーティング

| タスク | 実装ファイル | 依存 | 状態 |
|---|---|---|---|
| LINE LIFF トークン検証エンドポイント | `src/routes/line/auth.ts` | `src/utils/jwt.ts` / line-users-repo | ❌ 未作成 |
| auth middleware を JWT 検証に差し替え | `src/middleware/auth.ts` | `src/utils/jwt.ts` | ⚠️ デバッグヘッダー実装中 |
| RBAC middleware 作成 | `src/middleware/rbac.ts` | auth.ts | ❌ 未作成 |
| `/api/users/me` ルート定義 | `src/routes/user/me.ts` | auth.ts / dashboard-repo | ❌ 未作成 |
| `/api/users/me/dashboard` | `src/routes/user/dashboard.ts` | dashboard-repo | ❌ 未作成 |
| `/api/users/me/progress` | `src/routes/user/dashboard.ts` | progress-photos-repo | ❌ 未作成 |
| `/api/users/me/records` | `src/routes/user/records.ts` | daily-logs-repo | ❌ 未作成 |
| `/api/users/me/weekly-reports` | `src/routes/user/weekly-reports.ts` | weekly-reports-repo | ❌ 未作成 |

**設計メモ**: `IMPLEMENTATION_GUIDE.md` セクション 20-A 参照。  
JWT ペイロードは `{ sub: userAccountId, role: 'user', accountId: clientAccountId }` とする。

---

### 次優先: 添付・進捗画像配信 API

| タスク | 実装ファイル | 依存 | 状態 |
|---|---|---|---|
| 添付ファイル Repository | `src/repositories/attachments-repo.ts` | types/db.ts | ❌ 未作成 |
| 画像プロキシエンドポイント | `src/routes/user/files.ts` | attachments-repo / R2 / auth.ts | ❌ 未作成 |
| conversation_threads に user_account_id カラム確認 | `migrations/0008_*.sql` | DATABASE.md DDL | 🔍 要確認 |

**設計メモ**: `IMPLEMENTATION_GUIDE.md` セクション 20-B 参照。  
MVP は Workers プロキシ方式（方針 A）で実装する。R2 署名付き URL（`GET /api/files/progress/:id/signed-url`）は Phase 2 対応。

**所有者チェックの流れ**:
```
requireAuth(request, env) → jwt.sub = userAccountId
  ↓
getThreadByAttachmentId(db, attachmentId) → thread.user_account_id
  ↓
thread.user_account_id !== jwt.sub → 403 FORBIDDEN
  ↓ 一致
env.R2.get(attachment.storage_key) → Response(body)
```

---

### ドキュメント更新ログ（2026-03-10）

| ドキュメント | 更新内容 |
|---|---|
| `IMPLEMENTATION_GUIDE.md` セクション 17 | `src/services/ai/response-parser.ts` 完全実装雛形 |
| `IMPLEMENTATION_GUIDE.md` セクション 18 | `src/services/ai/schemas.ts` 全 Zod スキーマ完全実装雛形 |
| `IMPLEMENTATION_GUIDE.md` セクション 19 | `src/services/daily-logs/classify-input.ts` 完全実装雛形 |
| `IMPLEMENTATION_GUIDE.md` セクション 20 | `/api/users/me` 認証フロー（20-A）/ 画像配信 API（20-B）/ 依存関係グラフ（20-C）を正式仕様として確定 |
| `API.md` | `POST /api/auth/line`・`GET /api/users/me` 全 6 エンドポイント・`GET /api/files/progress|meals/:id`・署名付き URL（Phase 2）の仕様を追加 |
| `PROJECT_PLAN.md`（本ファイル） | Phase 1d ユーザー API タスクに 1d-13a〜1d-13d を追加。フロントエンドタスクに画像配信の注意点を追記 |

---

## スコープ外（Phase 2 以降）

> **食事解析の方針（重要）**: Phase 1 は **OpenAI Vision のみ**で実装。  
> 外部食品 DB 連携は Phase 2 以降で検討する。FatSecret は採用しない（OpenAI → 日本食品辞書 → 必要なら外部 DB の順で段階的に強化）。

| 機能 | Phase |
|---|---|
| 高精度食事画像 API（日本食品辞書・FoodData Central 等） | Phase 2 |
| バーコード読み取り連携 | Phase 3 |
| 体重計・歩数計デバイス連携 | Phase 3+ |
| 自動課金・多店舗管理 | Phase 3+ |
| Instagram 自動投稿・販促素材生成 | Phase 3+ |
| 音声入力フロー | Phase 3+ |
| 医療診断機能 | スコープ外 |
| R2 署名付き URL（`/api/files/*/signed-url`） | Phase 2 |
| 進捗写真 比較 UI 強化・週次との紐付け | Phase 2 |
