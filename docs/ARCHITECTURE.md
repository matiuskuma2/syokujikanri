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
