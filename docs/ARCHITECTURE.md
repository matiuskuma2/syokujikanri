# システムアーキテクチャ設計

## 概要

LINE ユーザーが送信したメッセージ・画像を Cloudflare Workers で受け取り、  
Queue 経由で非同期処理し、OpenAI で解析・応答生成を行う。  
全データは D1（SQLite）に永続化し、R2 に画像を保存する。

---

## システム全体図

```
[LINE ユーザー]
    │ メッセージ / 画像
    ▼
[LINE Messaging API]
    │ Webhook POST
    ▼
[Cloudflare Workers]
[POST /api/webhooks/line]
    │ X-Line-Signature 検証（HMAC-SHA256）
    │ イベントを Queue に enqueue
    ▼
[Cloudflare Queues]
[LINE_EVENTS_QUEUE]
    │ コンシューマー起動
    ▼
[Bot Dispatcher]  src/bot/dispatcher.ts
    ├── セッション確認（D1: bot_mode_sessions）
    ├── モード判定（intake / record / consult / knowledge）
    │
    ├─── [Intake Flow]  src/bot/intake-flow.ts
    │       ├── 質問ステップ管理（D1: bot_mode_sessions）
    │       ├── 回答保存（D1: intake_answers）
    │       └── プロフィール生成（D1: user_profiles）
    │
    ├─── [Record Mode]  src/bot/record-mode.ts
    │       ├── テキスト解析（食事・体重・歩数等）
    │       ├── 画像分類（OpenAI Vision → IMAGE_CATEGORY_PROMPT）
    │       ├── 食事画像解析（MEAL_IMAGE_ESTIMATION_PROMPT）
    │       ├── 栄養ラベル解析（NUTRITION_LABEL_PROMPT）
    │       ├── 体重計解析（BODY_SCALE_PROMPT）
    │       ├── 進捗写真判定（PROGRESS_PHOTO_PROMPT）
    │       ├── D1 保存（daily_logs, meal_entries, body_metrics, progress_photos）
    │       ├── R2 保存（画像ファイル）
    │       └── 日次フィードバック生成（buildDailyFeedbackPrompt）→ LINE 返信
    │
    ├─── [Consult Mode]  src/bot/consult-mode.ts
    │       ├── RAG 検索（Vectorize → knowledge_chunks）
    │       ├── コンテキスト構築（src/services/ai/rag.ts）
    │       ├── OpenAI 応答生成（buildConsultPrompt）
    │       ├── retrieval_logs に記録
    │       └── LINE 返信
    │
    └─── [Knowledge Mode]  （consult-mode.ts と共有）
            └── RAG 検索 + 回答生成

[Cron Triggers]  src/jobs/
    ├── 毎日 08:00 JST → daily-reminder.ts → 日次リマインダー送信
    └── 毎週月曜 09:00 JST → weekly-report.ts → 週次レポート生成・送信
                                └── buildWeeklyReportPrompt → weekly_reports 保存

[Admin / User Dashboard]
[Cloudflare Pages]
    ├── GET /admin → 管理者ダッシュボード HTML（src/index.ts）
    ├── GET /dashboard → ユーザー PWA HTML（src/index.ts）
    ├── /api/admin/* → 管理者 API（JWT 認証）  src/routes/admin/
    └── /api/user/* → ユーザー API（クエリパラメータ認証）  src/routes/user/
```

---

## データフロー詳細

### 1. LINE メッセージ受信フロー

```
1. LINE → POST /api/webhooks/line
2. X-Line-Signature ヘッダー検証（HMAC-SHA256）
3. 各イベントを Queue にエンキュー
   {
     accountId, channelId, event, receivedAt
   }
4. 200 OK を即座に返却（LINE の 1秒タイムアウト対策）
```

### 2. Queue コンシューマーフロー

```
1. Queue からメッセージ取得
2. accountId → account, line_channel 取得（accounts-repo.ts）
3. line_user_id → user 取得 or 新規作成（line-users-repo.ts）
4. イベントタイプで分岐:
   - follow   → welcome メッセージ + intake_flow 開始
   - unfollow → user_service_status 更新（follow_status = 'blocked'）
   - message  → Bot Dispatcher へ
   - postback → アクション処理（確認・修正・キャンセル等）
5. conversation_messages に記録（conversations-repo.ts）
```

### 3. Bot セッション管理

```
bot_mode_sessions テーブル:
  - line_user_id
  - client_account_id
  - current_mode: 'intake' | 'record' | 'consult' | 'knowledge'
  - current_step: ステップコード（BOT_FLOW.md 参照）
  - session_data: JSON（途中入力データ）
  - turn_count: 連続ターン数
  - expires_at: セッション有効期限

セッション TTL: デフォルト 4時間（BOT_SESSION_TTL_HOURS）
相談モード最大ターン数: 10（CONSULT_MAX_TURNS）
期限切れセッション削除: Cron で定期実行
```

### 4. 画像解析フロー

```
1. LINE から画像メッセージ受信
2. LINE Content API で画像バイナリ取得
3. R2 に保存 → message_attachments に記録
4. image_analysis_jobs に 'queued' ジョブを作成
5. OpenAI Vision で画像分類（IMAGE_CATEGORY_PROMPT）:
   - meal_photo         → MEAL_IMAGE_ESTIMATION_PROMPT で食事解析
   - nutrition_label    → NUTRITION_LABEL_PROMPT で栄養値抽出
   - body_scale         → BODY_SCALE_PROMPT で体重値抽出
   - progress_body_photo → PROGRESS_PHOTO_PROMPT で判定 → progress_photos に保存
   - other / unknown    → 「内容を確認できませんでした」返信
6. image_intake_results に解析結果保存
7. daily_logs / meal_entries / body_metrics を更新
```

### 5. RAG ナレッジ検索フロー

```
1. ユーザー質問を受信
2. src/services/ai/embeddings.ts で OpenAI Embeddings ベクトル化
   モデル: text-embedding-3-small
3. Cloudflare Vectorize で Top-K（デフォルト 5）検索
4. knowledge-repo.ts で knowledge_chunks から関連チャンク取得
5. src/services/ai/rag.ts で buildContextStrings() 実行:
   - profileSummary（user_profiles）
   - recentDailySummary（daily_logs 直近 7 日）
   - weeklySummary（weekly_reports 最新 1 件）
   - retrievedKnowledge（取得チャンク）
6. buildConsultPrompt() でシステム/ユーザーメッセージ構築
7. OpenAI GPT-4o で回答生成（温度 0.7）
8. retrieval_logs に記録
9. LINE 返信
```

---

## セキュリティ設計

### 認証フロー

```
管理者:
  POST /api/admin/auth/login
  → email + password 検証（account_memberships テーブル）
  → JWT 発行（ペイロード: userId, accountId, role, exp）
  → Authorization: Bearer <token> で各 API を保護
  → JWT_SECRET（Cloudflare Pages Secret）で署名

ユーザー:
  LINE ユーザーID を識別子として使用
  → line_users テーブルで管理
  → ダッシュボードアクセス時はマジックリンク
    （line_user_id + account_id のクエリパラメータ）
```

### LINE Webhook 署名検証

```typescript
// HMAC-SHA256 で検証（src/routes/line/webhook.ts）
const signature = request.headers.get('X-Line-Signature')
const body = await request.text()
const expectedSignature = createHmac('sha256', channelSecret)
  .update(body)
  .digest('base64')
if (signature !== expectedSignature) return 401
```

### ロール制御（RBAC）

```
superadmin:
  - /api/admin/accounts/*（全操作）
  - /api/admin/users/*（全操作）
  - /api/admin/bots/*（全操作）
  - /api/admin/knowledge/*（全操作）
  - /api/admin/dashboard/*（読み取り）

admin:
  - /api/admin/users/*（自アカウントのユーザーのみ）
  - /api/admin/bots/*（読み取りのみ）
  - /api/admin/knowledge/*（読み取りのみ）
  - /api/admin/dashboard/*（読み取り）

user:
  - /api/user/*（自分のデータのみ）
```

---

## 環境変数一覧

`.dev.vars.example` 参照。本番は Cloudflare Pages Secrets で管理。

| 変数名 | 説明 | 開発デフォルト |
|---|---|---|
| `LINE_CHANNEL_SECRET` | LINE チャンネルシークレット | - |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE アクセストークン | - |
| `LINE_WEBHOOK_PATH` | Webhook パス | `/api/webhooks/line` |
| `OPENAI_API_KEY` | OpenAI API キー | - |
| `OPENAI_MODEL` | 使用モデル | `gpt-4o` |
| `OPENAI_MAX_TOKENS` | 最大トークン数 | `2048` |
| `OPENAI_TEMPERATURE_RECORD` | 記録モード温度 | `0.3` |
| `OPENAI_TEMPERATURE_CONSULT` | 相談モード温度 | `0.7` |
| `JWT_SECRET` | JWT 署名シークレット | （開発用のみ設定） |
| `JWT_EXPIRES_IN` | JWT 有効期限 | `24h` |
| `APP_ENV` | 環境 | `development` |
| `APP_URL` | アプリ URL | `http://localhost:3000` |
| `CORS_ORIGINS` | CORS 許可オリジン | `*`（開発時） |
| `BOT_SESSION_TTL_HOURS` | セッション TTL（時間） | `4` |
| `CONSULT_MAX_TURNS` | 相談最大ターン数 | `10` |
| `R2_BUCKET_URL` | R2 パブリック URL | - |
| `R2_MAX_FILE_SIZE_MB` | R2 最大ファイルサイズ | `10` |
| `CRON_SECRET` | Cron 呼び出し検証シークレット | （開発用のみ設定） |

### Cloudflare Bindings（wrangler.jsonc）

| Binding | 型 | 説明 |
|---|---|---|
| `DB` | `D1Database` | メイン DB |
| `R2` | `R2Bucket` | 画像ストレージ |
| `LINE_EVENTS_QUEUE` | `Queue` | LINE イベントキュー |
| `VECTORIZE` | `VectorizeIndex` | ナレッジ RAG 検索 |
| `AI` | `Ai` | Cloudflare AI（将来使用） |

---

## パフォーマンス・制約

| 制約 | 値 | 対策 |
|---|---|---|
| Workers CPU 時間 | 10ms（無料）/ 30ms（有料） | 重処理は Queue で非同期化 |
| Workers サイズ | 10MB 圧縮後 | 軽量ライブラリのみ使用 |
| D1 クエリ | 同期実行 | `prepare().bind().run()` パターン |
| LINE Webhook タイムアウト | 1秒 | Webhook で即 200、Queue で処理 |
| R2 アップロード | 同期 | Queue コンシューマー内で処理 |
| Vectorize Top-K | デフォルト 5 | チューニング可能 |

---

## ローカル開発構成

```
ローカル開発（wrangler pages dev --local）:
  - D1: .wrangler/state/v3/d1/ に SQLite ファイルを自動生成
  - R2: モック（実際のアップロードは省略可）
  - Queue: wrangler pages dev でローカルエミュレート
  - Vectorize: 開発時はモックまたはスキップ

PM2 起動設定: ecosystem.config.cjs
  args: 'wrangler pages dev dist --d1=diet-bot-production --local --ip 0.0.0.0 --port 3000'
```

---

## ⚠️ 現在のコード状態と修正方針（2026-03-10）

### 誤実装ファイル

以下のファイルが**本アーキテクチャ仕様と乖離した状態**で存在している。  
実装フェーズ開始前に必ず削除し、正しい構造で再作成すること。

| ファイル | 問題 | 対処 |
|---|---|---|
| `src/repository/index.ts` | 単一ファイルに全 Repository が混在。`user_account_id` ではなく `account_id + line_user_id` の複合キーを使用しており `DATABASE.md` 仕様と乖離 | 削除 → `src/repositories/` 配下に分割再実装 |
| `src/types/models.ts` | `daily_logs`・`user_profiles` 等の型定義が DB スキーマと異なる。`weight_kg` が `daily_logs` に直接紐付いているが実際は `body_metrics` テーブルに存在。`BotModeSession.mode` → 正規は `current_mode`。`AccountMembership.role: 'member'` → 正規は `'staff'`。全体的にカラム名・FK 参照先が異なる | 削除 → `src/types/db.ts` に置き換え |
| `src/ai/prompts.ts` | 配置パスが誤り。`src/services/ai/prompts.ts` が正規パス。エクスポート名も仕様外（`buildConsultSystemPrompt` → 正規は `buildConsultPrompt` 等）。`models.ts` の誤った型を import している | 削除して `src/services/ai/prompts.ts` に再作成 |
| `src/ai/client.ts` | 同上。`models.ts` の誤った型を import している | 削除して `src/services/ai/client.ts` に再作成 |
| `src/bot/dispatcher.ts` | 誤った `src/repository/index.ts` と `models.ts` を import。仕様の Bot Dispatcher 設計と乖離 | 削除して正規 Repository・型を使って再実装 |
| `src/bot/consumer.ts` | 骨格（43行）は存在するが誤 import あり | 誤 import を除去し正規 Repository に差し替え |
| `src/bot/cron.ts` | Cron 処理（116行）は存在するが誤 import あり。配置先は `src/jobs/` が正規 | `src/jobs/daily-reminder.ts` / `src/jobs/weekly-report.ts` として再配置 |
| `src/routes/webhooks/line.ts` | パスが誤り。正規は `src/routes/line/webhook.ts` | 内容を `src/routes/line/webhook.ts` に移植して削除 |

### 正規のディレクトリ構造

```
src/
├── types/
│   ├── db.ts          ← 【要作成】DATABASE.md DDL に対応した全型定義
│   ├── line.ts        ← 【要作成】LINE Webhook イベント型
│   ├── api.ts         ← 【要作成】ApiResponse<T> / エラーコード型
│   ├── bindings.ts    ← 【既存・要確認】Cloudflare Bindings 型
│   └── index.ts       ← 【既存】re-export
│                         ※ models.ts は削除対象
│
├── repositories/      ← 【要作成】11 ファイル（src/repository/index.ts は削除対象）
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
│       ├── prompts.ts     ← 【要作成】正規パス（src/ai/prompts.ts は削除対象）
│       ├── client.ts      ← 【要作成】正規パス（src/ai/client.ts は削除対象）
│       ├── rag.ts         ← 【要作成】新規
│       └── embeddings.ts  ← 【要作成】新規
│
├── bot/
│   ├── dispatcher.ts  ← 【要再実装】現行は削除対象
│   ├── intake-flow.ts ← 【要作成】新規
│   ├── record-mode.ts ← 【要作成】新規
│   ├── consult-mode.ts← 【要作成】新規
│   ├── consumer.ts    ← 【既存・要修正】誤 import 除去（43行の骨格あり）
│   └── cron.ts        ← 【既存・要整理】src/jobs/ 配下に移動・再配置
│
├── routes/
│   ├── line/
│   │   └── webhook.ts ← 【要作成】src/routes/webhooks/line.ts から移植
│   ├── admin/
│   │   ├── auth.ts      ← 【既存・要修正】誤 import 除去（55行の骨格あり）
│   │   ├── accounts.ts  ← 【要作成】新規
│   │   ├── users.ts     ← 【既存・要修正】誤 import 除去（96行の骨格あり）
│   │   ├── bots.ts      ← 【要作成】新規
│   │   ├── knowledge.ts ← 【要作成】新規
│   │   └── dashboard.ts ← 【既存・要修正】誤 import 除去（80行の骨格あり）
│   └── user/
│       ├── dashboard.ts       ← 【要作成】新規（index.ts は内容確認・整理）
│       ├── records.ts         ← 【要作成】新規
│       ├── progress-photos.ts ← 【要作成】新規
│       └── weekly-reports.ts  ← 【要作成】新規
│
├── middleware/
│   ├── auth.ts   ← 【既存・要確認】JWT ミドルウェア（48行あり）
│   └── rbac.ts   ← 【要作成】新規
│
├── utils/
│   ├── line.ts       ← 【既存・要確認】LINE API ヘルパー（154行あり、仕様名は line-api.ts）
│   ├── jwt.ts        ← 【既存・要確認】JWT ユーティリティ（89行あり）
│   └── response.ts   ← 【既存・要確認】レスポンスユーティリティ（34行あり）
│
├── jobs/              ← 【要作成】src/bot/cron.ts の内容を分割・移動
│   ├── daily-reminder.ts
│   ├── weekly-report.ts
│   └── image-analysis.ts
│
└── index.ts           ← 【既存・要確認】メインエントリポイント（Hono app、595行あり）
```
