# 実装ガイド（雛形集）

> **このドキュメントの目的**  
> 実装フェーズで使用するコード雛形・サービス層実装仕様をまとめる。  
> **実装はしない。このドキュメントを読んで実装者が正規ファイルを作成する。**  
> 最終更新: 2026-03-10

---

## ドキュメント構成

| セクション | 内容 |
|---|---|
| [1. ディレクトリ構造（全体）](#1-ディレクトリ構造全体) | 追加ファイルを含む完全な src 構造 |
| [2. LINE Webhook 受信](#2-line-webhook-受信) | `src/routes/line/webhook.ts` 雛形 |
| [3. LINE イベント処理メイン](#3-line-イベント処理メイン) | `src/services/line/process-line-event.ts` 雛形 |
| [4. 画像解析 Queue Consumer](#4-画像解析-queue-consumer) | `src/queue/image-analysis-consumer.ts` 雛形 |
| [5. OpenAI レスポンス パーサ](#5-openai-レスポンス-パーサ) | `src/services/ai/response-parser.ts` 雛形 |
| [6. AI 出力 Zod スキーマ](#6-ai-出力-zod-スキーマ) | `src/services/ai/schemas.ts` 雛形 |
| [7. 日次記録 分類ロジック](#7-日次記録-分類ロジック) | `src/services/daily-logs/classify-input.ts` 雛形 |
| [8. 日次記録 反映ロジック](#8-日次記録-反映ロジック) | `src/services/daily-logs/apply-record-update.ts` 雛形 |
| [9. 日次不足判定](#9-日次不足判定) | `src/services/daily-logs/completion-status.ts` 雛形 |
| [10. ダッシュボード Repository](#10-ダッシュボード-repository) | `src/repositories/dashboard-repo.ts` 雛形 |
| [11. ユーザー Dashboard API](#11-ユーザー-dashboard-api) | `src/routes/user/dashboard.ts` 雛形 |
| [12. 管理者 Dashboard API](#12-管理者-dashboard-api) | `src/routes/admin/dashboard.ts` 雛形 |
| [13. Auth Middleware](#13-auth-middleware) | `src/middleware/auth.ts` 雛形 |
| [14. LINE 返信テンプレート](#14-line-返信テンプレート) | `src/services/line/reply-templates.ts` 雛形 |
| [15. フロントエンド 雛形](#15-フロントエンド-雛形) | ユーザーダッシュボード・進捗写真 画面 |
| [16. 次の実装優先順](#16-次の実装優先順) | 残タスクの順序とポイント |

---

## 1. ディレクトリ構造（全体）

このドキュメントで定義する雛形を反映した、**正規の完全ディレクトリ構造**。  
`docs/ARCHITECTURE.md` の構造に加えて、サービス層・キュー層・フロントエンドが追加される。

```
src/
├── types/
│   ├── db.ts              ← DATABASE.md DDL に対応した全型定義
│   ├── line.ts            ← LINE Webhook イベント型
│   ├── api.ts             ← ApiResponse<T> / エラーコード型
│   ├── env.ts             ← Cloudflare Bindings 型（bindings.ts から改名候補）
│   ├── bindings.ts        ← 既存（要確認）
│   └── index.ts           ← re-export
│
├── lib/                   ← ← 新規追加（共通ユーティリティ）
│   ├── db.ts              ← getDb(env) ヘルパー
│   ├── id.ts              ← createId(prefix) 生成
│   ├── time.ts            ← nowIso() / todayInJst()
│   └── json.ts            ← jsonOk() / jsonError() レスポンスヘルパー
│
├── repositories/
│   ├── daily-logs-repo.ts        ← REPOSITORY.md 仕様
│   ├── meal-entries-repo.ts      ← REPOSITORY.md 仕様（+ findMealEntryByDailyLogAndType / updateMealEntryFromEstimate を追加）
│   ├── body-metrics-repo.ts      ← REPOSITORY.md 仕様（+ upsertWeight を追加）
│   ├── conversations-repo.ts     ← REPOSITORY.md 仕様
│   ├── image-intake-repo.ts      ← REPOSITORY.md 仕様
│   ├── progress-photos-repo.ts   ← REPOSITORY.md 仕様（+ listProgressPhotosByUser を追加）
│   ├── knowledge-repo.ts         ← REPOSITORY.md 仕様
│   ├── accounts-repo.ts          ← REPOSITORY.md 仕様
│   ├── line-users-repo.ts        ← REPOSITORY.md 仕様（+ updateLineUserLastInteractedAt を追加）
│   ├── bot-sessions-repo.ts      ← REPOSITORY.md 仕様（セクション名: mode-sessions-repo.ts）
│   ├── weekly-reports-repo.ts    ← REPOSITORY.md 仕様（+ listWeeklyReportsByUser を追加）
│   ├── subscriptions-repo.ts     ← 新規: checkServiceAccess
│   ├── attachments-repo.ts       ← 新規: getMessageAttachmentById / getThreadByAttachmentId
│   └── dashboard-repo.ts         ← 新規: listRecentDailyLogsSummary / getLatestProgressPhotoByUser / listClientUsersSummary
│
├── services/
│   ├── ai/
│   │   ├── prompts.ts             ← PROMPTS.md 仕様
│   │   ├── client.ts              ← OpenAI Responses API クライアント（createResponse）
│   │   ├── rag.ts                 ← buildConsultContext
│   │   ├── embeddings.ts          ← text-embedding-3-small
│   │   ├── response-parser.ts     ← 新規: extractTextOutput / safeParseJsonText / parseResponseJson
│   │   └── schemas.ts             ← 新規: Zod スキーマ（consultResponseSchema 等）
│   │
│   ├── line/
│   │   ├── process-line-event.ts  ← 新規: LINE イベント処理メイン
│   │   ├── verify-signature.ts    ← 新規: verifyLineSignature（HMAC-SHA256）
│   │   ├── reply.ts               ← 新規: replyLineMessages / textMessage / pushText
│   │   ├── reply-templates.ts     ← 新規: tplWelcome / tplMissingField 等
│   │   ├── media.ts               ← 新規: saveLineImageToR2 / buildAttachmentAccessUrl
│   │   └── image-intake.ts        ← 新規: classifyImageCategory / estimateMealFromImage 等
│   │
│   ├── daily-logs/
│   │   ├── classify-input.ts      ← 新規: classifyRecordText（テキスト種別分類）
│   │   ├── apply-record-update.ts ← 新規: upsertWeightFromText / upsertMealTextFromClassified 等
│   │   └── completion-status.ts   ← 新規: findMissingDailyFields
│   │
│   └── knowledge/
│       └── vector-search.ts       ← 新規: searchKnowledge（Vectorize 検索）
│
├── queue/
│   └── image-analysis-consumer.ts ← 新規: Queue コンシューマー（画像解析ジョブ処理）
│
├── bot/
│   ├── dispatcher.ts  ← 再実装
│   ├── intake-flow.ts ← 未作成
│   ├── record-mode.ts ← 未作成（services/daily-logs/ を使用）
│   ├── consult-mode.ts← 未作成（services/ai/rag.ts を使用）
│   └── consumer.ts    ← 要修正
│
├── routes/
│   ├── line/
│   │   └── webhook.ts           ← 本ドキュメントの雛形を使用
│   ├── admin/
│   │   ├── auth.ts              ← 要修正
│   │   ├── accounts.ts          ← 未作成
│   │   ├── users.ts             ← 要修正
│   │   ├── bots.ts              ← 未作成
│   │   ├── knowledge.ts         ← 未作成
│   │   └── dashboard.ts         ← 本ドキュメントの雛形を使用
│   └── user/
│       ├── dashboard.ts         ← 本ドキュメントの雛形を使用
│       ├── records.ts           ← 未作成
│       ├── progress-photos.ts   ← 未作成
│       └── weekly-reports.ts    ← 未作成
│
├── middleware/
│   ├── auth.ts   ← 本ドキュメントの雛形を使用（要差し替え）
│   └── rbac.ts   ← 未作成
│
├── jobs/
│   ├── daily-reminder.ts  ← 未作成
│   ├── weekly-report.ts   ← 未作成
│   └── image-analysis.ts  ← 未作成
│
└── index.ts  ← メインエントリポイント（既存・要確認）

client/src/pages/              ← フロントエンド（React/HTML）
├── UserDashboardPage.tsx      ← 本ドキュメントの雛形を使用
└── UserProgressPage.tsx       ← 本ドキュメントの雛形を使用
```

---

## 2. LINE Webhook 受信

**ファイル（正規）**: `src/routes/line/webhook.ts`  
**役割**: X-Line-Signature 検証 → Queue エンキュー → 即時 200 返却  
**依存**: `src/lib/json.ts` / `src/services/line/verify-signature.ts` / `src/services/line/process-line-event.ts`

---

### 2-A. 既存実装（現行: `src/routes/webhooks/line.ts`）⚠️ 要移植・修正

> **注意**: このファイルは **正規パス外**（`src/routes/webhooks/line.ts`）に存在する。  
> 内容を `src/routes/line/webhook.ts` に移植し、誤 import を除去すること。

```typescript
/**
 * LINE Webhook ルーター
 * /api/webhooks/line
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import type { LineWebhookEvent } from '../../types/bindings'
import { verifyLineSignature } from '../../utils/line'
import { LineChannelRepo } from '../../repository'        // ❌ 誤 import: src/repository/index.ts（削除対象）

type HonoEnv = { Bindings: Bindings }

const webhook = new Hono<HonoEnv>()

webhook.post('/', async (c) => {
  const signature = c.req.header('x-line-signature') || ''
  const rawBody = await c.req.text()

  // シグネチャ検証
  const isValid = await verifyLineSignature(rawBody, signature, c.env.LINE_CHANNEL_SECRET)
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let body: { events: LineWebhookEvent[]; destination?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  // チャンネル確認
  const destination = body.destination || ''
  const channel = await LineChannelRepo.findByChannelId(c.env.DB, destination)  // ❌ 誤: 旧 repo 呼び出し
  if (!channel) {
    // チャンネルが見つからない場合は200を返す（LINEの仕様）
    return c.json({ status: 'channel_not_found' })
  }

  const accountId = channel.account_id
  const channelId = channel.channel_id

  // イベントをキューに送信（非同期処理）
  for (const event of body.events) {
    try {
      await c.env.LINE_EVENTS_QUEUE.send({
        accountId,
        channelId,
        event,
        receivedAt: new Date().toISOString()
      })
    } catch (err) {
      console.error('Queue send error:', err)
    }
  }

  return c.json({ status: 'ok' })
})

export default webhook
```

**現行実装の問題点**:

| 項目 | 問題 | 修正方針 |
|---|---|---|
| ファイルパス | `src/routes/webhooks/line.ts`（仕様外） | `src/routes/line/webhook.ts` に移動 |
| `LineChannelRepo` import | `src/repository/index.ts`（削除対象）を参照 | `src/repositories/line-users-repo.ts` の正規関数に差し替え |
| `LineWebhookEvent` import | `src/types/bindings.ts` から参照（`src/types/line.ts` が正規） | `src/types/line.ts` に移行後に差し替え |
| `verifyLineSignature` | `src/utils/line.ts` から参照（async 版） | `src/services/line/verify-signature.ts` に移行（同期 throw 版） |
| エラーレスポンス形式 | `c.json({ error: '...' }, 401)` | `src/lib/json.ts` の `jsonError()` に統一 |

---

### 2-B. 正規実装（目標: `src/routes/line/webhook.ts`）

```typescript
import type { Env } from '../../types/env'
import { jsonOk, jsonError } from '../../lib/json'
import { verifyLineSignature } from '../../services/line/verify-signature'
import { processLineEvent } from '../../services/line/process-line-event'

export async function handleLineWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
  try {
    const signature = request.headers.get('x-line-signature') || ''
    const rawBody = await request.text()

    verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET)

    const payload = JSON.parse(rawBody) as { events?: any[] }
    const events = payload.events ?? []

    for (const event of events) {
      ctx.waitUntil(processLineEvent(event, env))
    }

    return jsonOk({ accepted: true, eventCount: events.length })
  } catch (error: any) {
    return jsonError('LINE_WEBHOOK_ERROR', error?.message || 'line webhook error', 400)
  }
}
```

### 補足: `src/services/line/verify-signature.ts`

```typescript
// HMAC-SHA256 で X-Line-Signature を検証する
// 検証失敗時は Error を throw する（webhook.ts で catch して 400 を返す）
export function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string
): void
```

### 補足: `src/lib/json.ts`

```typescript
// 統一レスポンスヘルパー
export function jsonOk(data: unknown, status = 200): Response
export function jsonError(code: string, message: string, status: number): Response
```

---

## 3. LINE イベント処理メイン

**ファイル**: `src/services/line/process-line-event.ts`  
**役割**: Queue から呼ばれる。LINE ユーザー取得・スレッド管理・モード振り分け・Record/Consult フロー実行  

### import 一覧（依存先）

```typescript
import { getDb } from '../../lib/db'
import { nowIso, todayInJst } from '../../lib/time'
import { createId } from '../../lib/id'
import { findLineUser, createLineUser, updateLineUserLastInteractedAt }
  from '../../repositories/line-users-repo'
import { findOpenThreadByLineUser, createConversationThread, createConversationMessage }
  from '../../repositories/conversations-repo'
import { upsertModeSession }
  from '../../repositories/bot-sessions-repo'    // mode-sessions-repo.ts とも呼ぶ
import { checkServiceAccess }
  from '../../repositories/subscriptions-repo'
import { ensureDailyLog, updateDailyLogCompletionStatus, findDailyLogByUserAndDate }
  from '../../repositories/daily-logs-repo'
import { createImageAnalysisJob }
  from '../../repositories/image-intake-repo'
import { classifyRecordText }
  from '../daily-logs/classify-input'
import { findMissingDailyFields }
  from '../daily-logs/completion-status'
import {
  upsertWeightFromText, upsertWaterFromText,
  upsertSleepFromText, upsertBowelFromText,
  upsertStepsFromText, upsertMealTextFromClassified,
} from '../daily-logs/apply-record-update'
import { replyLineMessages, textMessage }
  from './reply'
import { saveLineImageToR2 }
  from './media'
import { buildConsultContext }
  from '../ai/rag'
import { buildConsultPrompt, buildDailyFeedbackPrompt }
  from '../ai/prompts'
import { createResponse }
  from '../ai/client'
import { searchKnowledge }
  from '../knowledge/vector-search'
import { getKnowledgeChunksByIds }
  from '../../repositories/knowledge-repo'
import { listWeeklyReportsByUser }
  from '../../repositories/weekly-reports-repo'
import { findAccountById }
  from '../../repositories/accounts-repo'
import { listRecentDailyLogsSummary }
  from '../../repositories/dashboard-repo'
```

### フロー概要

```
processLineEvent(event, env)
  │
  ├── event.source.userId なし → return（無視）
  ├── event.type が 'message' / 'follow' 以外 → return（無視）
  │
  ├── resolveDefaultLineChannelId(db)   ← line_channels から共有デフォルト取得
  ├── resolveDefaultClientAccountId(db) ← accounts から active クライアント取得
  │
  ├── findLineUser / createLineUser（初回作成）
  ├── findOpenThreadByLineUser / createConversationThread
  ├── upsertModeSession（デフォルト: record モード）
  │
  ├── follow イベント
  │     └── replyLineMessages（ウェルカム文 × 2行）→ return
  │
  ├── message イベント（image）
  │     ├── saveLineImageToR2 → R2 保存
  │     ├── createImageAnalysisJob
  │     ├── env.IMAGE_ANALYSIS_QUEUE.send({ attachmentId })
  │     └── reply「画像を受け取りました」→ return
  │
  └── message イベント（text）
        ├── createConversationMessage（会話ログ保存）
        ├── checkServiceAccess → 停止中なら reply して return
        ├── detectExplicitMode（「記録」「相談」キーワード）
        ├── upsertModeSession（モード確定）
        ├── currentMode === 'record' → handleRecordModeFlow
        └── currentMode === 'consult' → handleConsultModeFlow
```

### handleRecordModeFlow

```
入力: { db, env, event, thread, text, now }

1. userAccountId なし → エラーreply → return
2. ensureDailyLog（当日ログ取得or作成）
3. classifyRecordText(text)
   ├── weight → upsertWeightFromText
   ├── water  → upsertWaterFromText
   ├── sleep  → upsertSleepFromText
   ├── bowel  → upsertBowelFromText
   ├── steps  → upsertStepsFromText
   ├── meal   → upsertMealTextFromClassified
   └── unknown → reply「記録内容として受け取れません」→ return
4. findMissingDailyFields → 不足あり → reply（次に聞く項目）→ return
5. 全項目揃い → updateDailyLogCompletionStatus('complete')
6. buildDailyFeedbackPrompt → createResponse（GPT-4o）
7. updateDailyLogCompletionStatus('reviewed')
8. reply（AI フィードバック文）
```

### handleConsultModeFlow

```
入力: { db, env, event, thread, text, now }

1. userAccountId なし → エラーreply → return
2. findAccountById（プロフィール取得）
3. listRecentDailyLogsSummary（直近14日）
4. listWeeklyReportsByUser（直近4件）
5. searchKnowledge（Vectorize Top-K）→ getKnowledgeChunksByIds
6. buildConsultContext({ profile, recentLogs, weeklyReports, retrievedChunks })
7. buildConsultPrompt({ userMessage, profileSummary, recentDailySummary,
                         weeklySummary, retrievedKnowledge })
8. createResponse（GPT-4o, temp 0.7）
9. reply（AI 回答文）
```

### ユーティリティ関数

```typescript
// DB からデフォルト LINE チャンネル ID を取得
// line_channels WHERE is_shared_default = 1 ORDER BY created_at ASC LIMIT 1
async function resolveDefaultLineChannelId(db: D1Database): Promise<string | null>

// DB からデフォルトクライアントアカウント ID を取得
// accounts WHERE account_type = 'client_org' AND status = 'active' ORDER BY created_at ASC LIMIT 1
async function resolveDefaultClientAccountId(db: D1Database): Promise<string | null>

// OpenAI Responses API のレスポンスからテキストを抽出
// response.output_text → response.output[].content[].text の順に探す
function extractTextOutput(response: any): string

// 「記録」「相談」の明示的モード指定を判定
function detectExplicitMode(text: string | null): 'record' | 'consult' | null
```

---

## 4. 画像解析 Queue Consumer

**ファイル**: `src/queue/image-analysis-consumer.ts`  
**役割**: `IMAGE_ANALYSIS_QUEUE` のメッセージを受け取り、画像カテゴリ分類 → 各解析 → DB 保存 → LINE 返信

### Queue メッセージ形式

```typescript
type ImageAnalysisJobMessage = {
  attachmentId: string  // message_attachments.id
}
```

### カテゴリ別処理フロー

```
Queue メッセージ受信 { attachmentId }
  │
  ├── getMessageAttachmentById(db, attachmentId)
  ├── getThreadByAttachmentId(db, attachment.id) → thread.user_account_id 必須
  ├── buildAttachmentAccessUrl(env, attachment.storage_key) → 画像 URL 生成
  ├── classifyImageCategory(env, imageUrl) → { category, confidence, reason }
  ├── ensureDailyLog（当日ログ取得or作成）
  │
  ├── category === 'meal_photo'
  │     ├── estimateMealFromImage(env, imageUrl) → mealJson
  │     ├── createMealEntry（draft で保存）
  │     ├── saveImageIntakeResult（category: 'meal_photo'）
  │     └── pushMessage「〇〇として取り込み候補を作成しました。登録しますか？」
  │
  ├── category === 'nutrition_label' | 'food_package'
  │     ├── extractNutritionLabelWithVision(env, imageUrl) → labelJson
  │     ├── saveImageIntakeResult（category: 'nutrition_label'）
  │     └── pushMessage「栄養成分表示を読み取りました。どの食事に登録しますか？」
  │
  ├── category === 'body_scale'
  │     ├── extractWeightFromScaleImage(env, imageUrl) → { weightKg, confidence }
  │     ├── saveImageIntakeResult（category: 'body_scale'）
  │     └── pushMessage「体重 XX.Xkg と読み取りました。登録しますか？」
  │
  ├── category === 'progress_body_photo'
  │     ├── createProgressPhoto（R2 キー参照）
  │     ├── saveImageIntakeResult（category: 'progress_body_photo'）
  │     └── pushMessage「今日の経過写真として保存しました。」
  │
  └── それ以外（other / unknown）
        └── saveImageIntakeResult のみ（ユーザー通知なし）
```

### エクスポートパターン

```typescript
// wrangler.jsonc の queue consumer として登録
export default {
  async queue(
    batch: MessageBatch<ImageAnalysisJobMessage>,
    env: Env,
    _ctx: ExecutionContext
  ) {
    for (const msg of batch.messages) {
      try {
        await handleImageAnalysisJob(msg.body, env)
        msg.ack()
      } catch (error) {
        console.error(error)
        msg.retry()
      }
    }
  },
}
```

### ヘルパー関数

```typescript
function normalizeCategory(input: string):
  'meal_photo' | 'nutrition_label' | 'body_scale' | 'food_package' |
  'progress_body_photo' | 'other' | 'unknown'

function inferMealTypeFromText(text?: string | null):
  'breakfast' | 'lunch' | 'snack' | 'dinner' | 'other'
// 「朝」→ breakfast / 「昼」→ lunch / 「間食|おやつ」→ snack / 「夜|夕」→ dinner

function toMealTypeJa(mealType: string): string
// 'breakfast' → '朝食' / 'lunch' → '昼食' 等
```

---

## 5. OpenAI レスポンス パーサ

**ファイル**: `src/services/ai/response-parser.ts`  
**役割**: OpenAI Responses API のレスポンスからテキストを抽出・JSON パース・Zod バリデーション

```typescript
import { z } from 'zod'

/**
 * OpenAI Responses API レスポンスからテキスト出力を抽出する
 * 優先順: response.output_text → response.output[].content[].text
 */
export function extractTextOutput(response: any): string

/**
 * テキストを JSON としてパースする
 * 通常の JSON.parse に加えて ```json ... ``` フェンス記法にも対応
 */
export function safeParseJsonText<T = any>(text: string): T | null

/**
 * レスポンスを Zod スキーマで検証して返す
 * @returns { ok: true, data: T } | { ok: false, error: string, rawText: string }
 */
export function parseResponseJson<T>(
  response: any,
  schema: z.ZodSchema<T>
): { ok: true; data: T } | { ok: false; error: string; rawText: string }
```

### エラーコード

| コード | 意味 |
|---|---|
| `MODEL_OUTPUT_NOT_JSON` | JSON パース失敗 |
| `MODEL_OUTPUT_SCHEMA_INVALID` | Zod バリデーション失敗 |

---

## 6. AI 出力 Zod スキーマ

**ファイル**: `src/services/ai/schemas.ts`  
**役割**: OpenAI の JSON レスポンスを型安全に検証する Zod スキーマ定義

| スキーマ名 | 対応プロンプト | 主なフィールド |
|---|---|---|
| `consultResponseSchema` | `buildConsultPrompt` | summary, encouragement, advice[], warning |
| `dailyFeedbackSchema` | `buildDailyFeedbackPrompt` | score(0-100), goodPoints[], improvePoints[], comment |
| `weeklyReportSchema` | `buildWeeklyReportPrompt` | summary, trend[], nextFocus[], warning |
| `imageCategorySchema` | `IMAGE_CATEGORY_PROMPT` | category(enum), confidence(0-1), reason |
| `mealImageEstimationSchema` | `MEAL_IMAGE_ESTIMATION_PROMPT` | foods[], mealBalance{}, estimatedTotals{}, score, comment |
| `nutritionLabelSchema` | `NUTRITION_LABEL_PROMPT` | isNutritionLabel, calories, proteinG, fatG, carbsG, confidence |
| `bodyScaleSchema` | `BODY_SCALE_PROMPT` | isBodyScale, weightKg, confidence |
| `progressPhotoSchema` | `PROGRESS_PHOTO_PROMPT` | isProgressBodyPhoto, confidence, poseLabel, bodyPartLabel |

### `mealImageEstimationSchema` の `foods` 要素

```typescript
z.object({
  name: z.string(),
  amountLabel: z.enum(['small', 'normal', 'large']).default('normal'),
  estimatedCalories: z.number().nullable().optional(),
  proteinG:          z.number().nullable().optional(),
  fatG:              z.number().nullable().optional(),
  carbsG:            z.number().nullable().optional(),
})
```

---

## 7. 日次記録 分類ロジック

**ファイル**: `src/services/daily-logs/classify-input.ts`  
**役割**: ユーザーのテキストをパターンマッチングで記録種別に分類する（OpenAI 未使用・同期処理）

### 出力型

```typescript
export type RecordClassification =
  | { kind: 'weight'; value: number }                               // 体重 (kg)
  | { kind: 'water'; value: '500ml' | '1l' | '1_5l' | '2l_plus' } // 水分バケット
  | { kind: 'sleep'; value: number }                                // 睡眠時間 (時間)
  | { kind: 'bowel'; value: 'hard' | 'normal' | 'soft' | 'none' } // 便の状態
  | { kind: 'steps'; value: number }                                // 歩数
  | { kind: 'meal'; mealType: 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'other'; text: string }
  | { kind: 'unknown' }
```

### 各パーサの判定ルール

| 種別 | 判定条件 |
|---|---|
| `weight` | 数値 + `体重\|kg\|キロ` キーワード。範囲: 20〜300 |
| `water` | `500ml` / `1L` / `1.5L` / `2L以上` パターン |
| `sleep` | 数値 + `時間\|h\|H` + `時間\|睡眠\|寝` キーワード。範囲: 0〜24 |
| `bowel` | `固め\|硬め` → hard / `普通\|通常` → normal / `柔らか\|軟便` → soft / `なし\|出てない` → none |
| `steps` | 3〜6桁の数値 + `歩`。範囲: 0〜100000 |
| `meal` | 食事関連ワード（`食べ\|ごはん\|パン\|米\|...`）+ 4文字以上 |
| `unknown` | どれにも該当しない |

### `detectMealType` 判定ルール

| 入力パターン | 出力 |
|---|---|
| `朝食\|朝ごはん\|朝は` | `breakfast` |
| `昼食\|昼ごはん\|昼は` | `lunch` |
| `間食\|おやつ` | `snack` |
| `夕食\|夜ごはん\|晩ごはん\|夜は` | `dinner` |
| それ以外 | `other` |

---

## 8. 日次記録 反映ロジック

**ファイル**: `src/services/daily-logs/apply-record-update.ts`  
**役割**: 分類された記録種別ごとにDBへの upsert を実行する

### 関数一覧

| 関数名 | 対象テーブル | 動作 |
|---|---|---|
| `upsertWeightFromText` | `body_metrics` | `body-metrics-repo.ts` の `upsertWeight` を呼ぶ薄いラッパー |
| `upsertWaterFromText` | `hydration_logs` | `water_bucket_label` を upsert（既存があれば UPDATE）|
| `upsertSleepFromText` | `sleep_logs` | `sleep_hours` を upsert |
| `upsertBowelFromText` | `bowel_logs` | `bowel_status` を upsert |
| `upsertStepsFromText` | `activity_logs` | `steps_count` を upsert |
| `upsertMealTextFromClassified` | `meal_entries` | 同日同 mealType が既存なら UPDATE、なければ INSERT |

### `upsertMealTextFromClassified` の依存

`meal-entries-repo.ts` に以下の関数を追加実装すること（REPOSITORY.md の仕様に追記済み）:
- `findMealEntryByDailyLogAndType(db, dailyLogId, mealType)`
- `updateMealEntryFromEstimate(db, id, params)`

### DB カラム名マッピング（スキーマ確認用）

| ロジック変数 | テーブル | カラム |
|---|---|---|
| `waterBucketLabel` | `hydration_logs` | `water_bucket_label` |
| `sleepHours` | `sleep_logs` | `sleep_hours` |
| `bowelStatus` | `bowel_logs` | `bowel_status` |
| `stepsCount` | `activity_logs` | `steps_count` |

---

## 9. 日次不足判定

**ファイル**: `src/services/daily-logs/completion-status.ts`  
**役割**: 当日の daily_log に対して、まだ記録されていない項目を返す

```typescript
export async function findMissingDailyFields(
  db: D1Database,
  dailyLogId: string
): Promise<Array<'meal' | 'weight' | 'steps' | 'water' | 'bowel' | 'sleep'>>
```

### 判定ロジック

| 項目 | 判定クエリ | 不足条件 |
|---|---|---|
| `meal` | `SELECT id FROM meal_entries WHERE daily_log_id = ?` | 0件 |
| `weight` | `SELECT weight_kg FROM body_metrics WHERE daily_log_id = ?` | NULL または 0件 |
| `steps` | `SELECT steps_count FROM activity_logs WHERE daily_log_id = ?` | NULL または 0件 |
| `water` | `SELECT water_bucket_label FROM hydration_logs WHERE daily_log_id = ?` | NULL または 0件 |
| `bowel` | `SELECT bowel_status FROM bowel_logs WHERE daily_log_id = ?` | NULL または 0件 |
| `sleep` | `SELECT sleep_hours FROM sleep_logs WHERE daily_log_id = ?` | NULL または 0件 |

返却順序は上記の順（meal → weight → steps → water → bowel → sleep）。  
`handleRecordModeFlow` では `missing[0]` を使って次に聞く項目を1件ずつ案内する。

---

## 10. ダッシュボード Repository

**ファイル**: `src/repositories/dashboard-repo.ts`  
**役割**: ダッシュボード表示用の集計クエリ（複数テーブルの JOIN）

### 関数一覧

#### `listRecentDailyLogsSummary`

```typescript
async function listRecentDailyLogsSummary(
  db: D1Database,
  userAccountId: string,
  days: number          // 取得日数（例: 7日 / 14日）
): Promise<D1Result>
```

**SQL（5テーブル LEFT JOIN）**:
```sql
SELECT
  dl.id, dl.log_date, dl.completion_status,
  bm.weight_kg, bm.waist_cm,
  al.steps_count,
  sl.sleep_hours,
  hl.water_bucket_label,
  bl.bowel_status
FROM daily_logs dl
LEFT JOIN body_metrics   bm ON bm.daily_log_id = dl.id
LEFT JOIN activity_logs  al ON al.daily_log_id = dl.id
LEFT JOIN sleep_logs     sl ON sl.daily_log_id = dl.id
LEFT JOIN hydration_logs hl ON hl.daily_log_id = dl.id
LEFT JOIN bowel_logs     bl ON bl.daily_log_id = dl.id
WHERE dl.user_account_id = ?
ORDER BY dl.log_date DESC
LIMIT ?
```

#### `getLatestProgressPhotoByUser`

```typescript
async function getLatestProgressPhotoByUser(
  db: D1Database,
  userAccountId: string
): Promise<ProgressPhoto | null>
```

**SQL**: `SELECT * FROM progress_photos WHERE user_account_id = ? ORDER BY photo_date DESC, created_at DESC LIMIT 1`

#### `listClientUsersSummary`

```typescript
async function listClientUsersSummary(
  db: D1Database,
  clientAccountId: string,
  limit: number,
  offset: number
): Promise<D1Result>
```

**SQL（相関サブクエリで最終ログ日・最新体重を取得）**:
```sql
SELECT
  up.user_account_id,
  up.nickname,
  uss.service_enabled,
  (
    SELECT log_date FROM daily_logs dl
    WHERE dl.user_account_id = up.user_account_id
    ORDER BY log_date DESC LIMIT 1
  ) AS last_log_date,
  (
    SELECT bm.weight_kg
    FROM daily_logs dl
    JOIN body_metrics bm ON bm.daily_log_id = dl.id
    WHERE dl.user_account_id = up.user_account_id
    ORDER BY dl.log_date DESC LIMIT 1
  ) AS latest_weight_kg
FROM user_profiles up
JOIN user_service_statuses uss
  ON uss.user_account_id = up.user_account_id
 AND uss.client_account_id = up.assigned_client_account_id
WHERE up.assigned_client_account_id = ?
ORDER BY up.created_at DESC
LIMIT ? OFFSET ?
```

> ⚠️ `user_profiles.assigned_client_account_id` は DATABASE.md の DDL に存在しない。  
> 実装時に `user_profiles` テーブルにこのカラムを追加するか、  
> `user_accounts` テーブルの `client_account_id` を JOIN して代替すること。  
> 対処方針は `0008_` 以降のマイグレーションで対応。

---

## 11. ユーザー Dashboard API

**ファイル**: `src/routes/user/dashboard.ts`

### `GET /api/user/dashboard`

```typescript
export async function getUserDashboard(
  _request: Request,
  env: Env,
  userAccountId: string  // auth middleware から渡す
)
```

**レスポンス**:
```json
{
  "profile": { ... },
  "recentDailyLogs": [ ... ],   // 直近7日
  "weeklyReports": [ ... ],     // 直近4件
  "latestProgressPhoto": { ... } | null
}
```

**依存**:
- `findAccountById(db, userAccountId)` ← accounts-repo（実際には user_profiles を引くべきか要検討）
- `listRecentDailyLogsSummary(db, userAccountId, 7)` ← dashboard-repo
- `listWeeklyReportsByUser(db, userAccountId, 4)` ← weekly-reports-repo
- `getLatestProgressPhotoByUser(db, userAccountId)` ← dashboard-repo

### `GET /api/user/progress`

```typescript
export async function getUserProgress(
  _request: Request,
  env: Env,
  userAccountId: string
)
```

**レスポンス**: `{ "photos": [ ... ] }`  
**依存**: `listProgressPhotosByUser(db, userAccountId)` ← progress-photos-repo

---

## 12. 管理者 Dashboard API

**ファイル**: `src/routes/admin/dashboard.ts`

### `GET /api/admin/clients/:clientAccountId/users`

```typescript
export async function getAdminClientUsers(
  request: Request,
  env: Env,
  clientAccountId: string  // auth middleware + RBAC から渡す
)
```

**クエリパラメータ**: `page`（デフォルト: 1）/ `pageSize`（デフォルト: 20）

**レスポンス**:
```json
{
  "items": [
    {
      "user_account_id": "...",
      "nickname": "...",
      "service_enabled": 1,
      "last_log_date": "2026-03-09",
      "latest_weight_kg": 58.5
    }
  ],
  "pagination": { "page": 1, "pageSize": 20 }
}
```

**依存**: `listClientUsersSummary(db, clientAccountId, pageSize, offset)` ← dashboard-repo

---

## 13. Auth Middleware

**ファイル**: `src/middleware/auth.ts`  
**現状**: 簡易実装（ヘッダーベース）。本番前に LINE トークン or 署名付き URL 認証に差し替える。

```typescript
export type AuthContext = {
  accountId: string
  role: 'superadmin' | 'admin' | 'staff' | 'user'
}

/**
 * 認証検証。成功時は AuthContext を返す。失敗時は 401 Response を返す。
 * 現在の実装: x-debug-account-id / x-debug-role ヘッダーで簡易認証
 * TODO: JWT 検証に差し替え（src/utils/jwt.ts と組み合わせる）
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<AuthContext | Response>

/**
 * ロール検証。必要なロールを持っていない場合は 403 Response を返す。
 * null を返した場合は OK。
 */
export function requireRole(
  auth: AuthContext,
  roles: AuthContext['role'][]
): Response | null
```

### 差し替え時の実装方針

```
現行: x-debug-account-id / x-debug-role ヘッダー（開発用のみ）
       ↓ 差し替え
本番: Authorization: Bearer <JWT>
      → src/utils/jwt.ts の verifyJwt() で検証
      → ペイロードから { userId, accountId, role } を取り出す
      → src/repositories/accounts-repo.ts の findAccountMembership で DB 確認
```

---

## 14. LINE 返信テンプレート

**ファイル**: `src/services/line/reply-templates.ts`  
**役割**: ハードコードされた日本語メッセージを一元管理する定数/関数集

| 関数名 | 用途 | メッセージ概要 |
|---|---|---|
| `tplWelcome()` | 初回フォロー時 | 登録ありがとうございます。記録/相談モードの説明 |
| `tplServiceDisabled()` | サービス停止時 | 利用停止中のお知らせ |
| `tplRecordUnknown()` | 分類不明テキスト | 体重・歩数・食事などを送るよう促す |
| `tplMissingField(field)` | 記録不足項目の案内 | 6種（meal / weight / steps / water / bowel / sleep）|
| `tplImageAccepted()` | 画像受信直後 | 解析中のお知らせ |
| `tplMealConfirm(mealTypeJa)` | 食事画像解析後 | 「朝食として登録しますか？」 |
| `tplNutritionLabelConfirm()` | 栄養ラベル解析後 | どの食事に登録するか選択を促す |
| `tplWeightConfirm(weightKg)` | 体重計解析後 | 「XX.Xkg と読み取りました」 |
| `tplProgressPhotoSaved()` | 進捗写真保存後 | 保存完了のお知らせ |

### `tplMissingField` の詳細

```typescript
export function tplMissingField(
  field: 'meal' | 'weight' | 'steps' | 'water' | 'bowel' | 'sleep'
): string
```

| field | メッセージ |
|---|---|
| `meal` | 今日の食事内容も教えてください。写真でもテキストでも大丈夫です。 |
| `weight` | 今日の体重も教えてください。 |
| `steps` | 今日の歩数はどれくらいでしたか？ |
| `water` | 今日の水分量はどれくらいでしたか？ 500ml / 1L / 1.5L / 2L以上 で教えてください。 |
| `bowel` | 今日の便の状態はどうでしたか？ 固め / 普通 / 柔らかめ / なし で教えてください。 |
| `sleep` | 昨夜の睡眠時間はどれくらいでしたか？ |

---

## 15. フロントエンド 雛形

**実装スタイル**: React（TypeScript）。実際のプロジェクト構成に合わせて SPA or SSR を選択する。  
**API 呼び出し先**: `/api/users/me/dashboard` / `/api/users/me/progress`

### `UserDashboardPage.tsx`

```
表示内容:
  1. プロフィール情報（profile）
  2. 最新の経過写真（latestProgressPhoto）
     - 画像 URL: /api/files/progress/{photo.id}
  3. 直近7日の記録一覧（recentDailyLogs）
  4. 週次レポート（weeklyReports）

データ取得:
  - useEffect → fetch('/api/users/me/dashboard') → json.data をステートに格納
  - loading 中は「読み込み中...」を表示
```

### `UserProgressPage.tsx`

```
表示内容:
  - 経過写真のグリッド表示
  - 各写真: /api/files/progress/{photo.id} の画像 + photo_date

データ取得:
  - useEffect → fetch('/api/users/me/progress') → json.data.photos をステートに格納
```

### API エンドポイントの整合確認

```
フロント呼び出し先     →  実装ファイル
/api/users/me/dashboard  →  src/routes/user/dashboard.ts (getUserDashboard)
/api/users/me/progress   →  src/routes/user/dashboard.ts (getUserProgress)
/api/files/progress/:id  →  未実装（次フェーズ: attachments / progress image 配信 API）
```

---

## 16. 次の実装優先順

### 優先度 ★★★（Webhook 動作の前提）

| # | ファイル | 依存 |
|---|---|---|
| 1 | `src/lib/db.ts` / `id.ts` / `time.ts` / `json.ts` | なし |
| 2 | `src/types/db.ts` | DATABASE.md |
| 3 | `src/repositories/` 全 11 ファイル | types/db.ts |
| 4 | `src/services/ai/response-parser.ts` | zod |
| 5 | `src/services/ai/schemas.ts` | zod |
| 6 | `src/services/daily-logs/classify-input.ts` | なし |
| 7 | `src/middleware/auth.ts` | lib/json.ts |

### 優先度 ★★（LINE 処理の本体）

| # | ファイル | 依存 |
|---|---|---|
| 8 | `src/services/line/verify-signature.ts` | なし |
| 9 | `src/services/line/reply.ts` | LINE API |
| 10 | `src/services/line/reply-templates.ts` | なし |
| 11 | `src/services/daily-logs/apply-record-update.ts` | repositories |
| 12 | `src/services/daily-logs/completion-status.ts` | repositories |
| 13 | `src/services/line/process-line-event.ts` | 上記すべて |
| 14 | `src/routes/line/webhook.ts` | verify-signature / process-line-event |

### 優先度 ★（Queue・ダッシュボード）

| # | ファイル | 依存 |
|---|---|---|
| 15 | `src/services/line/media.ts` / `image-intake.ts` | R2 / OpenAI |
| 16 | `src/queue/image-analysis-consumer.ts` | 15 + repositories |
| 17 | `src/repositories/dashboard-repo.ts` | types/db.ts |
| 18 | `src/routes/user/dashboard.ts` | dashboard-repo |
| 19 | `src/routes/admin/dashboard.ts` | dashboard-repo |

### 次フェーズ（本ドキュメント範囲外）

| 機能 | 説明 |
|---|---|
| `/api/users/me` 系 認証付きルーティング | LINE ユーザー ID を識別子とした認証フロー |
| `/api/files/progress/:id` 配信 API | R2 からの画像配信（署名付き URL or プロキシ） |
| `src/services/line/media.ts` 詳細 | LINE Content API → R2 保存 + アクセス URL 生成 |
| Intake フロー完全実装 | `src/bot/intake-flow.ts` |

---

## 付記: REPOSITORY.md への追加仕様

本ドキュメントで登場する以下の関数は `REPOSITORY.md` の既存仕様に追記すること。

### `meal-entries-repo.ts` 追加関数

| 関数名 | 説明 |
|---|---|
| `findMealEntryByDailyLogAndType(db, dailyLogId, mealType)` | 同日同食事タイプの既存エントリを取得 |
| `updateMealEntryFromEstimate(db, id, params)` | AI 推定値で meal_entry を部分更新 |

**`findMealEntryByDailyLogAndType` SQL**:
```sql
SELECT * FROM meal_entries
WHERE daily_log_id = ?1 AND meal_type = ?2
ORDER BY created_at ASC
LIMIT 1
```

**`updateMealEntryFromEstimate` SQL**:
```sql
UPDATE meal_entries
SET
  meal_text           = COALESCE(?2, meal_text),
  calories_kcal       = COALESCE(?3, calories_kcal),
  protein_g           = COALESCE(?4, protein_g),
  fat_g               = COALESCE(?5, fat_g),
  carbs_g             = COALESCE(?6, carbs_g),
  fiber_g             = COALESCE(?7, fiber_g),
  confirmation_status = COALESCE(?8, confirmation_status),
  updated_at          = ?9
WHERE id = ?1
```

### `body-metrics-repo.ts` 追加関数

| 関数名 | 説明 |
|---|---|
| `upsertWeight(db, params)` | 体重のみを upsert する薄いラッパー |

```typescript
interface UpsertWeightParams {
  idFactory: () => string  // 新規作成時のみ使用
  dailyLogId: string
  weightKg: number
  now: string
}
```

### `line-users-repo.ts` 追加関数

| 関数名 | 説明 |
|---|---|
| `updateLineUserLastInteractedAt(db, id, lastInteractedAt, updatedAt)` | 最終インタラクション日時を更新 |

### `weekly-reports-repo.ts` 追加関数

| 関数名 | 説明 |
|---|---|
| `listWeeklyReportsByUser(db, userAccountId, limit)` | 直近 N 件の週次レポートを取得 |

**SQL**:
```sql
SELECT * FROM weekly_reports
WHERE user_account_id = ?1
ORDER BY week_start DESC
LIMIT ?2
```

### `progress-photos-repo.ts` 追加関数

| 関数名 | 説明 |
|---|---|
| `listProgressPhotosByUser(db, userAccountId, limit?, offset?)` | ユーザーの進捗写真一覧（既存 `listProgressPhotos` と役割同じ・命名統一） |

### 新規 Repository ファイル

| ファイル | 関数 | 説明 |
|---|---|---|
| `subscriptions-repo.ts` | `checkServiceAccess(db, { userAccountId, clientAccountId })` | サービス利用可否を判定。`user_service_statuses.service_enabled` を参照 |
| `attachments-repo.ts` | `getMessageAttachmentById(db, id)` / `getThreadByAttachmentId(db, attachmentId)` | Queue Consumer で使用 |
