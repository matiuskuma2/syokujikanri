# 実装計画（PROJECT PLAN）

> **このドキュメントの目的**  
> ドキュメント整備が完了したことを確認し、実装フェーズへ移行するためのロードマップを定義する。  
> 各タスクには「依存関係」「実装ファイル」「完了条件」を明記する。

---

## ドキュメント整備ステータス

| ドキュメント | 状態 | 備考 |
|---|---|---|
| `docs/README.md` | ✅ 完了 | プロジェクト概要・ディレクトリ構造 |
| `docs/ARCHITECTURE.md` | ✅ 完了 | システム全体図・データフロー・セキュリティ |
| `docs/DATABASE.md` | ✅ 完了 | テーブル定義・マイグレーション対応表 |
| `docs/REPOSITORY.md` | ✅ 完了 | **NEW** Repository 層 SQL 実装仕様 |
| `docs/API.md` | ✅ 完了 | エンドポイント定義・リクエスト/レスポンス形式 |
| `docs/PROMPTS.md` | ✅ 完了 | **UPDATED** 全プロンプト定義（TypeScript 仕様） |
| `docs/BOT_FLOW.md` | ✅ 完了 | モード・ステップコード・キーワード定義 |
| `docs/DEPLOYMENT.md` | ✅ 完了 | ローカル・本番デプロイ手順 |
| `docs/PROJECT_PLAN.md` | ✅ 完了（本ファイル） | フェーズ別実装計画 |

**✅ ドキュメント整備完了 → 実装フェーズへ移行可能**

---

## 実装フェーズ概要

```
Phase 1a: 基盤・型定義・Repository 層
    ↓（依存）
Phase 1b: AI サービス層（prompts.ts / client.ts / rag.ts）
    ↓（依存）
Phase 1c: Bot ディスパッチャー・LINE Webhook
    ↓（依存）
Phase 1d: Admin API / User API / ダッシュボード
    ↓（依存）
Phase 1e: Cron ジョブ・週次レポート・テスト・デプロイ
```

---

## Phase 1a: 基盤・型定義・Repository 層

**目的**: 全レイヤーが依存する型と DB アクセス層を確立する

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1a-1 | Cloudflare Bindings 型定義 | `src/types/env.ts` | wrangler.jsonc の Bindings が型付きで参照可能 |
| 1a-2 | DB テーブル型定義 | `src/types/db.ts` | REPOSITORY.md の全型が定義済み |
| 1a-3 | LINE イベント型定義 | `src/types/line.ts` | follow/message/postback イベントが型付き |
| 1a-4 | API 型定義 | `src/types/api.ts` | リクエスト/レスポンス共通型が定義済み |
| 1a-5 | daily-logs-repo 実装 | `src/repositories/daily-logs-repo.ts` | findDailyLog / createDailyLog / ensureDailyLog / updateDailyLog |
| 1a-6 | meal-entries-repo 実装 | `src/repositories/meal-entries-repo.ts` | find / create / update |
| 1a-7 | body-metrics-repo 実装 | `src/repositories/body-metrics-repo.ts` | upsertBodyMetrics / upsertWeight |
| 1a-8 | conversations-repo 実装 | `src/repositories/conversations-repo.ts` | findOpenThread / createThread / createMessage |
| 1a-9 | image-intake-repo 実装 | `src/repositories/image-intake-repo.ts` | createImageAnalysisJob / saveImageIntakeResult |
| 1a-10 | progress-photos-repo 実装 | `src/repositories/progress-photos-repo.ts` | createProgressPhoto / listProgressPhotos |
| 1a-11 | knowledge-repo 実装 | `src/repositories/knowledge-repo.ts` | getKnowledgeChunksByIds |
| 1a-12 | accounts-repo 実装 | `src/repositories/accounts-repo.ts` | findAccountById / findAccountMembership |
| 1a-13 | line-users-repo 実装 | `src/repositories/line-users-repo.ts` | findLineUser / upsertLineUser / findUserAccount / ensureUserAccount / findUserServiceStatus |
| 1a-14 | bot-sessions-repo 実装 | `src/repositories/bot-sessions-repo.ts` | findActiveSession / upsertSession / deleteSession |

**依存関係**: 1a-1 → 1a-2 → 1a-5〜1a-14  
**参照ドキュメント**: `docs/DATABASE.md`, `docs/REPOSITORY.md`

---

## Phase 1b: AI サービス層

**目的**: OpenAI との通信層と全プロンプト定義を実装する

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1b-1 | プロンプト定数・型・ビルダー実装 | `src/services/ai/prompts.ts` | PROMPTS.md の全定義が TypeScript で実装済み |
| 1b-2 | OpenAI クライアント実装 | `src/services/ai/client.ts` | callOpenAI() / callVisionAPI() が動作する |
| 1b-3 | Embeddings 実装 | `src/services/ai/embeddings.ts` | text-embedding-3-small でベクトル生成可能 |
| 1b-4 | RAG コンテキスト構築実装 | `src/services/ai/rag.ts` | buildContextStrings() が全プロンプト変数を生成 |

**依存関係**: 1a-2 → 1b-1 → 1b-2 → 1b-4  
**参照ドキュメント**: `docs/PROMPTS.md`, `docs/ARCHITECTURE.md`（RAG フロー）

### `src/services/ai/prompts.ts` 実装対象（全エクスポート）

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
| 1c-1 | LINE Webhook 受信 | `src/routes/line/webhook.ts` | 署名検証 + Queue エンキュー |
| 1c-2 | Queue コンシューマー | `src/routes/line/consumer.ts` | follow/message/postback イベント処理 |
| 1c-3 | セッション管理 | `src/bot/session.ts` | getSession / updateSession / deleteSession |
| 1c-4 | Bot ディスパッチャー | `src/bot/dispatcher.ts` | モード判定・ルーティング |
| 1c-5 | Intake フロー | `src/bot/intake-flow.ts` | 全ステップ（nickname → complete）動作 |
| 1c-6 | Record モード | `src/bot/record-mode.ts` | テキスト解析 + 画像解析 + D1 保存 |
| 1c-7 | Consult モード | `src/bot/consult-mode.ts` | RAG 検索 + OpenAI 回答生成 |
| 1c-8 | LINE API ヘルパー | `src/utils/line-api.ts` | sendMessage / replyMessage |

**依存関係**: Phase 1a + 1b 完了後  
**参照ドキュメント**: `docs/BOT_FLOW.md`, `docs/ARCHITECTURE.md`

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

## Phase 1e: Cron ジョブ・週次レポート・テスト・デプロイ

**目的**: 自動化ジョブを実装し、本番環境へデプロイする

### タスク一覧

| # | タスク | 実装ファイル | 完了条件 |
|---|---|---|---|
| 1e-1 | weekly-reports-repo 実装 | `src/repositories/weekly-reports-repo.ts` | create / find / listRecent |
| 1e-2 | 日次リマインダー Cron | `src/jobs/daily-reminder.ts` | 未記録ユーザーへ LINE 送信 |
| 1e-3 | 週次レポート生成 Cron | `src/jobs/weekly-report.ts` | データ集計 + AI 生成 + LINE 送信 |
| 1e-4 | 画像解析ジョブ | `src/jobs/image-analysis.ts` | Queue からジョブ取得・処理 |
| 1e-5 | ビルド確認 | `npm run build` | ビルドエラーなし |
| 1e-6 | ローカル動作確認 | PM2 + wrangler pages dev | 全エンドポイント正常応答 |
| 1e-7 | D1 本番 DB 作成 | `npx wrangler d1 create diet-bot-production` | database_id 取得 |
| 1e-8 | 本番マイグレーション | `npx wrangler d1 migrations apply diet-bot-production` | 全 7 マイグレーション適用 |
| 1e-9 | Cloudflare Pages デプロイ | `npx wrangler pages deploy dist` | 本番 URL で動作確認 |
| 1e-10 | Secrets 設定 | `npx wrangler pages secret put` | OPENAI_API_KEY / LINE / JWT 設定済み |

**依存関係**: Phase 1a〜1d 完了後  
**参照ドキュメント**: `docs/DEPLOYMENT.md`

---

## 即座に着手すべき次のステップ（推奨順）

```
Step 1: src/types/db.ts を作成
  → REPOSITORY.md の全型定義を TypeScript で実装
  → 全 repository ファイルがこれに依存する

Step 2: src/services/ai/prompts.ts を作成
  → PROMPTS.md の全定数・型・ビルダー関数を実装
  → Bot ディスパッチャーと AI クライアントがこれに依存する

Step 3: src/repositories/ 優先 7 ファイルを実装
  → daily-logs-repo, meal-entries-repo, body-metrics-repo
  → conversations-repo, image-intake-repo
  → progress-photos-repo, knowledge-repo
  → REPOSITORY.md の SQL 仕様通りに実装する

Step 4: src/repositories/ 後半 4 ファイルを実装
  → accounts-repo, line-users-repo, bot-sessions-repo
  → weekly-reports-repo
  → これにより Bot ディスパッチャーが完全に動作可能になる

Step 5: Phase 1b の AI サービス層を実装
  → prompts.ts 完成後に client.ts / rag.ts を実装

Step 6: Phase 1c の LINE Webhook + Bot ディスパッチャーを実装

Step 7: Phase 1d の Admin / User API を実装

Step 8: Phase 1e でデプロイ
```

---

## 実装時の共通ルール

### ファイル命名規則

| カテゴリ | 規則 | 例 |
|---|---|---|
| Repository | `{テーブル名}-repo.ts` | `daily-logs-repo.ts` |
| Routes | `{機能名}.ts` | `dashboard.ts`, `users.ts` |
| Bot 処理 | `{モード名}-mode.ts` or `{処理名}.ts` | `record-mode.ts` |
| Services | `{サービス名}.ts` | `prompts.ts`, `client.ts` |
| Jobs | `{ジョブ名}.ts` | `daily-reminder.ts` |

### エラーハンドリング方針

- Repository 層: D1 エラーをそのまま throw
- Routes 層: try/catch → `src/utils/response.ts` の `errorResponse()` で統一
- Bot 処理: エラー時はユーザーに「処理に失敗しました」を LINE 返信

### テスト方針（Phase 1 MVP）

- 単体テストは必須としない（MVP フェーズ）
- `curl` / Postman での手動テストで動作確認
- ローカルの `wrangler pages dev --local` 環境で検証
- D1 の動作確認は `npx wrangler d1 execute diet-bot-production --local --command="SELECT..."`

---

## スコープ外（Phase 2 以降）

| 機能 | Phase |
|---|---|
| 日本語栄養 DB（主食・一般料理・タンパク源・野菜・コンビニ品） | Phase 2 |
| バーコード読み取り連携 | Phase 3 |
| 外部 DB（FatSecret 等）連携 | Phase 3 |
| 体重計・歩数計デバイス連携 | Phase 3+ |
| 自動課金・多店舗管理 | Phase 3+ |
| Instagram 自動投稿・販促素材生成 | Phase 3+ |
| 音声入力フロー | Phase 3+ |
| 医療診断機能 | スコープ外 |
