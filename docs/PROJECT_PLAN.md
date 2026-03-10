# 実装計画（PROJECT PLAN）

> **このドキュメントの目的**  
> ドキュメント整備状況・現在のコード状態・実装フェーズのロードマップを管理する。  
> 各タスクには「依存関係」「実装ファイル」「完了条件」を明記する。

---

## ドキュメント整備ステータス

| ドキュメント | 状態 | 備考 |
|---|---|---|
| `docs/README.md` | ✅ 完了 | プロジェクト概要・ディレクトリ構造 |
| `docs/ARCHITECTURE.md` | ✅ 完了 | システム全体図・データフロー・セキュリティ |
| `docs/DATABASE.md` | ✅ 完了 | テーブル定義・マイグレーション対応表・ID 体系 |
| `docs/REPOSITORY.md` | ✅ 完了 | Repository 層 SQL 実装仕様（型定義含む） |
| `docs/API.md` | ✅ 完了 | エンドポイント定義・リクエスト/レスポンス形式 |
| `docs/PROMPTS.md` | ✅ 完了 | 全プロンプト定義（TypeScript 仕様） |
| `docs/BOT_FLOW.md` | ✅ 完了 | モード・ステップコード・キーワード定義 |
| `docs/DEPLOYMENT.md` | ✅ 完了 | ローカル・本番デプロイ手順 |
| `docs/PROJECT_PLAN.md` | ✅ 完了（本ファイル） | フェーズ別実装計画 |

**✅ ドキュメント整備完了**

---

## ⚠️ 現在のコード状態（2026-03-10 時点）

### 誤実装ファイル一覧

以下のファイルが**ドキュメント仕様と乖離した状態で実装されてしまっている**。  
実装フェーズ開始前に必ず下記の方針で対処すること。

| ファイル | 状態 | 問題点 | 対処方針 |
|---|---|---|---|
| `src/repository/index.ts` | ❌ 誤実装 | 単一ファイルに全 Repository が混在。型名・カラム名が `DATABASE.md` と乖離（例: `account_id + line_user_id` vs `user_account_id`）。`src/repositories/` 分割構成ではない | **全削除して `src/repositories/` 配下に再実装** |
| `src/types/models.ts` | ⚠️ 要修正 | `user_profiles` の主キー参照が `account_id + line_user_id` になっているが、正しくは `user_account_id`。`DailyLog` の主キー参照も同様に乖離 | **`src/types/db.ts` に置き換え。`models.ts` は削除** |
| `src/ai/prompts.ts` | ❓ 要確認 | ファイルは存在するが中身が空または旧版の可能性あり | **`src/services/ai/prompts.ts` に正しく配置** |
| `src/ai/client.ts` | ❓ 要確認 | 同上 | **`src/services/ai/client.ts` に正しく配置** |

### 正しいディレクトリ構造（ドキュメント仕様）

```
src/
├── types/
│   ├── db.ts          ← DATABASE.md のスキーマに対応した型定義（新規作成）
│   ├── bindings.ts    ← Cloudflare Bindings 型（既存）
│   └── index.ts       ← re-export（既存）
│
├── repositories/      ← 新規作成（現在は index.ts のみ・誤実装）
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
│   └── weekly-reports-repo.ts
│
├── services/
│   └── ai/
│       ├── prompts.ts     ← src/ai/prompts.ts を移動・修正
│       ├── client.ts      ← src/ai/client.ts を移動・修正
│       ├── rag.ts         ← 新規作成
│       └── embeddings.ts  ← 新規作成
│
├── bot/               ← 未実装
├── routes/            ← 未実装
├── middleware/        ← 未実装
├── utils/             ← 未実装
└── jobs/              ← 未実装
```

### 実装前に必ず行う前処理

```bash
# 1. 誤実装ファイルの削除
rm src/repository/index.ts
rm src/types/models.ts
rm src/ai/prompts.ts
rm src/ai/client.ts

# 2. 正しいディレクトリの作成
mkdir -p src/repositories
mkdir -p src/services/ai
mkdir -p src/bot
mkdir -p src/routes/line
mkdir -p src/routes/admin
mkdir -p src/routes/user
mkdir -p src/utils
mkdir -p src/jobs
```

---

## 実装フェーズ概要

```
Phase 1a: 基盤・型定義・Repository 層（全 11 ファイル）
    ↓（依存）
Phase 1b: AI サービス層（prompts.ts / client.ts / rag.ts / embeddings.ts）
    ↓（依存）
Phase 1c: Bot ディスパッチャー・LINE Webhook（Queue 含む）
    ↓（依存）
Phase 1d: Admin API / User API / ダッシュボード
    ↓（依存）
Phase 1e: Cron ジョブ・週次レポート・テスト・デプロイ
```

---

## Phase 1a: 基盤・型定義・Repository 層

**目的**: 全レイヤーが依存する型と DB アクセス層を確立する  
**前提**: 上記「前処理」を完了済みであること

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1a-1 | DB テーブル型定義 | `src/types/db.ts` | `DATABASE.md` の全テーブルスキーマに対応した TypeScript interface が定義済み。`user_account_id` / `client_account_id` の命名規則が一致している |
| 1a-2 | LINE イベント型定義 | `src/types/line.ts` | follow / unfollow / message / postback イベントが型付き |
| 1a-3 | API 共通型定義 | `src/types/api.ts` | `ApiResponse<T>` / エラーコード型が定義済み |
| 1a-4 | daily-logs-repo 実装 | `src/repositories/daily-logs-repo.ts` | `findDailyLog` / `createDailyLog` / `ensureDailyLog` / `updateDailyLog` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-5 | meal-entries-repo 実装 | `src/repositories/meal-entries-repo.ts` | `findMealEntriesByDailyLog` / `createMealEntry` / `updateMealEntry` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-6 | body-metrics-repo 実装 | `src/repositories/body-metrics-repo.ts` | `upsertBodyMetrics` / `upsertWeight` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-7 | conversations-repo 実装 | `src/repositories/conversations-repo.ts` | `findOpenThread` / `createThread` / `createMessage` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-8 | image-intake-repo 実装 | `src/repositories/image-intake-repo.ts` | `createImageAnalysisJob` / `saveImageIntakeResult` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-9 | progress-photos-repo 実装 | `src/repositories/progress-photos-repo.ts` | `createProgressPhoto` / `listProgressPhotos` が REPOSITORY.md SQL 仕様通りに動作 |
| 1a-10 | knowledge-repo 実装 | `src/repositories/knowledge-repo.ts` | `getKnowledgeChunksByIds` が REPOSITORY.md SQL 仕様通りに動作（動的 IN 句実装済み） |
| 1a-11 | accounts-repo 実装 | `src/repositories/accounts-repo.ts` | `findAccountById` / `findAccountMembership` / `createAccount` / `updateAccountStatus` |
| 1a-12 | line-users-repo 実装 | `src/repositories/line-users-repo.ts` | `findLineUser` / `upsertLineUser` / `findUserAccount` / `ensureUserAccount` / `findUserServiceStatus` / `upsertUserServiceStatus` / `listActiveLineUsers` |
| 1a-13 | bot-sessions-repo 実装 | `src/repositories/bot-sessions-repo.ts` | `findActiveSession` / `upsertSession` / `deleteSession` / `deleteExpiredSessions` |
| 1a-14 | weekly-reports-repo 実装 | `src/repositories/weekly-reports-repo.ts` | `findWeeklyReport` / `createWeeklyReport` / `listRecentWeeklyReports` |

**依存関係**: 1a-1 → 1a-4〜1a-14（型定義が全 repo の前提）  
**参照ドキュメント**: `docs/DATABASE.md`、`docs/REPOSITORY.md`

### `src/types/db.ts` の型命名規則（DATABASE.md 準拠）

```
テーブル主キー識別子:
  - user_accounts.id    → 変数名は user_account_id
  - accounts.id         → 変数名は client_account_id（顧客側）または account_id（管理者側）
  - line_users.id       → 変数名は line_user_record_id（内部ID、通常は不使用）
  - line_user_id        → LINE プラットフォームの U xxxxxxx 文字列（外部ID）

型命名規則:
  - テーブル名をパスカルケースに変換
  - daily_logs       → DailyLog
  - meal_entries     → MealEntry
  - body_metrics     → BodyMetrics
  - user_accounts    → UserAccount
  - bot_mode_sessions → BotModeSession
```

---

## Phase 1b: AI サービス層

**目的**: OpenAI との通信層と全プロンプト定義を実装する

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1b-1 | プロンプト定数・型・ビルダー実装 | `src/services/ai/prompts.ts` | `PROMPTS.md` の全定数・型・ビルダー関数が実装済み。`src/ai/prompts.ts`（旧）は削除済み |
| 1b-2 | OpenAI クライアント実装 | `src/services/ai/client.ts` | `callOpenAI()` / `callVisionAPI()` が動作。`src/ai/client.ts`（旧）は削除済み |
| 1b-3 | Embeddings 実装 | `src/services/ai/embeddings.ts` | `text-embedding-3-small` でベクトル生成可能 |
| 1b-4 | RAG コンテキスト構築実装 | `src/services/ai/rag.ts` | `buildContextStrings()` が全プロンプト変数（profileSummary / recentDailySummary 等）を生成 |

**依存関係**: 1a-1（db.ts）→ 1b-1 → 1b-2 → 1b-4  
**参照ドキュメント**: `docs/PROMPTS.md`、`docs/ARCHITECTURE.md`（RAG フロー）

### `src/services/ai/prompts.ts` エクスポート一覧

```typescript
// 定数
export const SYSTEM_GUARDRAILS
export const IMAGE_CATEGORY_PROMPT
export const MEAL_IMAGE_ESTIMATION_PROMPT
export const NUTRITION_LABEL_PROMPT
export const BODY_SCALE_PROMPT
export const PROGRESS_PHOTO_PROMPT
export const WELCOME_MESSAGE
export const SESSION_TIMEOUT_MESSAGE
export const UNRECOGNIZED_INPUT_MESSAGE

// ビルダー関数
export function buildConsultPrompt(input: ConsultPromptInput)
export function buildDailyFeedbackPrompt(input: DailyFeedbackPromptInput)
export function buildWeeklyReportPrompt(input: WeeklyReportPromptInput)
export function buildMealTypeInferencePrompt(input: MealTypeInferenceInput)
export function buildMissingQuestionPrompt(input: MissingQuestionInput)
```

---

## Phase 1c: Bot ディスパッチャー・LINE Webhook

**目的**: LINE メッセージを受信し、適切な処理に振り分ける

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1c-1 | LINE Webhook 受信 | `src/routes/line/webhook.ts` | X-Line-Signature 検証 + Queue エンキュー + 即時 200 返却 |
| 1c-2 | Queue コンシューマー | `src/routes/line/consumer.ts` | follow / unfollow / message / postback イベント処理 |
| 1c-3 | Bot ディスパッチャー | `src/bot/dispatcher.ts` | セッション確認・モード判定・ルーティング |
| 1c-4 | Intake フロー | `src/bot/intake-flow.ts` | 全ステップ（`intake_start` → `intake_complete`）動作 |
| 1c-5 | Record モード | `src/bot/record-mode.ts` | テキスト解析 + 画像解析 + D1 保存 + 日次フィードバック |
| 1c-6 | Consult モード | `src/bot/consult-mode.ts` | RAG 検索 + OpenAI 回答生成 + 返信 |
| 1c-7 | LINE API ヘルパー | `src/utils/line-api.ts` | `sendMessage` / `replyMessage` / `getMessageContent` |

**依存関係**: Phase 1a + 1b 完了後  
**参照ドキュメント**: `docs/BOT_FLOW.md`、`docs/ARCHITECTURE.md`

---

## Phase 1d: Admin API / User API / ダッシュボード

**目的**: 管理者・ユーザー向けの API とダッシュボード UI を実装する

### 管理者 API タスク

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1d-1 | JWT 認証ミドルウェア | `src/middleware/auth.ts` | Bearer トークン検証 |
| 1d-2 | RBAC ミドルウェア | `src/middleware/rbac.ts` | superadmin / admin ロール制御 |
| 1d-3 | 管理者認証 API | `src/routes/admin/auth.ts` | POST /api/admin/auth/login |
| 1d-4 | アカウント管理 API | `src/routes/admin/accounts.ts` | GET/POST/PATCH |
| 1d-5 | ユーザー管理 API | `src/routes/admin/users.ts` | GET 一覧・詳細 / PATCH ON/OFF |
| 1d-6 | BOT 管理 API | `src/routes/admin/bots.ts` | CRUD |
| 1d-7 | ナレッジ管理 API | `src/routes/admin/knowledge.ts` | CRUD + インデックス登録 |
| 1d-8 | ダッシュボード API | `src/routes/admin/dashboard.ts` | GET stats / conversations |

### ユーザー API タスク

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1d-9 | ユーザーダッシュボード API | `src/routes/user/dashboard.ts` | GET /api/user/dashboard |
| 1d-10 | 日次ログ API | `src/routes/user/records.ts` | GET 一覧 / GET 日別詳細 |
| 1d-11 | 進捗写真 API | `src/routes/user/progress-photos.ts` | GET 一覧 |
| 1d-12 | 週次レポート API | `src/routes/user/weekly-reports.ts` | GET 一覧 |

### フロントエンド（ダッシュボード UI）タスク

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1d-13 | 管理者ダッシュボード HTML | `src/index.ts`（インライン） | ログイン・サマリー・ユーザー一覧 |
| 1d-14 | ユーザー PWA HTML | `src/index.ts`（インライン） | 体重グラフ・食事ログ・進捗写真 |
| 1d-15 | 管理者 JS | `public/static/admin.js` | API 呼び出し・UI 更新 |
| 1d-16 | ユーザー JS | `public/static/user.js` | API 呼び出し・グラフ表示 |

**依存関係**: Phase 1a + 1b 完了後（1c は並行可）  
**参照ドキュメント**: `docs/API.md`

---

## Phase 1e: Cron ジョブ・テスト・デプロイ

**目的**: 自動化ジョブを実装し、本番環境へデプロイする

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1e-1 | 日次リマインダー Cron | `src/jobs/daily-reminder.ts` | 未記録ユーザーへ LINE 送信 |
| 1e-2 | 週次レポート生成 Cron | `src/jobs/weekly-report.ts` | データ集計 + AI 生成 + LINE 送信 |
| 1e-3 | 画像解析ジョブ | `src/jobs/image-analysis.ts` | Queue からジョブ取得・処理 |
| 1e-4 | ビルド確認 | `npm run build` | ビルドエラーなし |
| 1e-5 | ローカル動作確認 | PM2 + wrangler pages dev | 全エンドポイント正常応答 |
| 1e-6 | D1 本番 DB 作成 | `npx wrangler d1 create diet-bot-production` | database_id 取得・wrangler.jsonc に反映 |
| 1e-7 | 本番マイグレーション | `npx wrangler d1 migrations apply diet-bot-production` | 全 7 マイグレーション適用 |
| 1e-8 | Cloudflare Pages デプロイ | `npx wrangler pages deploy dist` | 本番 URL で動作確認 |
| 1e-9 | Secrets 設定 | `npx wrangler pages secret put` | OPENAI_API_KEY / LINE / JWT 設定済み |

**依存関係**: Phase 1a〜1d 完了後  
**参照ドキュメント**: `docs/DEPLOYMENT.md`

---

## 実装開始前チェックリスト

```
□ src/repository/index.ts を削除済み
□ src/types/models.ts を削除済み
□ src/ai/prompts.ts を削除済み（または src/services/ai/prompts.ts に移動済み）
□ src/ai/client.ts を削除済み（または src/services/ai/client.ts に移動済み）
□ src/repositories/ ディレクトリ作成済み
□ src/services/ai/ ディレクトリ作成済み
□ src/types/db.ts の型定義が DATABASE.md と一致していることを確認
□ 全型の user_account_id 命名が REPOSITORY.md 仕様と一致していることを確認
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

## スコープ外（Phase 2 以降）

| 機能 | Phase |
|---|---|
| 高精度食事画像 API（FatSecret 等） | Phase 2 |
| バーコード読み取り連携 | Phase 3 |
| 体重計・歩数計デバイス連携 | Phase 3+ |
| 自動課金・多店舗管理 | Phase 3+ |
| Instagram 自動投稿・販促素材生成 | Phase 3+ |
| 音声入力フロー | Phase 3+ |
| 医療診断機能 | スコープ外 |
