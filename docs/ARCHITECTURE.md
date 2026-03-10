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
    │ 署名検証
    │ イベントを Queue に enqueue
    ▼
[Cloudflare Queues]
[LINE_EVENTS_QUEUE]
    │ コンシューマー起動
    ▼
[Bot Dispatcher]
    ├── セッション確認（D1: bot_mode_sessions）
    ├── モード判定（record / consult / intake / knowledge）
    │
    ├─── [Record Mode]
    │       ├── テキスト解析（食事・体重・歩数等）
    │       ├── 画像分類（Vision API）
    │       ├── D1 保存（daily_logs, meal_entries）
    │       ├── R2 保存（画像ファイル）
    │       └── 日次フィードバック生成 → LINE 返信
    │
    ├─── [Consult Mode]
    │       ├── RAG 検索（Vectorize）
    │       ├── ナレッジ取得（D1: knowledge_chunks）
    │       ├── OpenAI 応答生成
    │       └── LINE 返信
    │
    └─── [Intake Flow]
            ├── 質問ステップ管理（D1: bot_mode_sessions）
            ├── 回答保存（D1: intake_answers）
            └── プロフィール生成（D1: user_profiles）

[Cron Triggers]
    ├── 毎日 08:00 JST → 日次リマインダー送信
    └── 毎週月曜 09:00 JST → 週次レポート生成・送信

[Admin / User Dashboard]
[Cloudflare Pages]
    ├── GET /admin → 管理者ダッシュボード HTML
    ├── GET /dashboard → ユーザー PWA HTML
    ├── /api/admin/* → 管理者 API（JWT 認証）
    └── /api/user/* → ユーザー API（JWT 認証）
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
2. accountId → account, line_channel 取得
3. line_user_id → user 取得 or 新規作成
4. イベントタイプで分岐
   - follow   → welcome メッセージ + intake_flow 開始
   - unfollow → user_service_status 更新
   - message  → Bot Dispatcher へ
   - postback → アクション処理
5. conversation_messages に記録
```

### 3. Bot セッション管理

```
bot_mode_sessions テーブル:
  - line_user_id
  - account_id
  - current_mode: 'intake' | 'record' | 'consult' | 'knowledge'
  - current_step: ステップコード（下記参照）
  - session_data: JSON（途中入力データ）
  - turn_count: 連続ターン数
  - expires_at: セッション有効期限

セッション TTL: デフォルト 4時間
相談モード最大ターン数: 10
```

### 4. 画像解析フロー

```
1. LINE から画像メッセージ受信
2. LINE Content API で画像バイナリ取得
3. R2 に一時保存
4. OpenAI Vision で画像分類:
   - meal_photo: 食事写真
   - nutrition_label: 栄養ラベル
   - body_scale: 体重計
   - progress_photo: 進捗写真
5. 分類結果に応じた解析実行
6. image_intake_results に結果保存
7. daily_logs / meal_entries を更新
```

### 5. RAG ナレッジ検索フロー

```
1. ユーザー質問を受信
2. OpenAI Embeddings でベクトル化
3. Cloudflare Vectorize で Top-K 検索
4. knowledge_chunks から関連チャンク取得
5. ユーザープロフィール + チャンク + 質問を結合
6. OpenAI でコンテキスト付き回答生成
7. retrieval_logs に記録
```

---

## セキュリティ設計

### 認証フロー

```
管理者:
  POST /api/admin/auth/login
  → email + password 検証
  → JWT 発行（ペイロード: userId, accountId, role）
  → Authorization: Bearer <token>

ユーザー:
  LINE ユーザーID を識別子として使用
  → line_users テーブルで管理
  → ダッシュボードアクセス時はマジックリンク or LINE ログイン
```

### LINE Webhook 署名検証

```typescript
// HMAC-SHA256 で検証
const signature = request.headers.get('X-Line-Signature');
const body = await request.text();
const expectedSignature = createHmac('sha256', channelSecret)
  .update(body)
  .digest('base64');
if (signature !== expectedSignature) return 401;
```

---

## 環境変数一覧

`.dev.vars.example` 参照。本番は Cloudflare Pages Secrets で管理。

| 変数名 | 説明 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE チャンネルシークレット |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE アクセストークン |
| `LINE_WEBHOOK_PATH` | Webhook パス（例: `/api/webhooks/line`） |
| `OPENAI_API_KEY` | OpenAI API キー |
| `OPENAI_MODEL` | 使用モデル（例: `gpt-4o`） |
| `OPENAI_MAX_TOKENS` | 最大トークン数 |
| `OPENAI_TEMPERATURE_RECORD` | 記録モード温度（0.3推奨） |
| `OPENAI_TEMPERATURE_CONSULT` | 相談モード温度（0.7推奨） |
| `JWT_SECRET` | JWT 署名シークレット |
| `JWT_EXPIRES_IN` | JWT 有効期限（例: `24h`） |
| `APP_ENV` | 環境（`development` / `production`） |
| `APP_URL` | アプリ URL |
| `CORS_ORIGINS` | CORS 許可オリジン |
| `BOT_SESSION_TTL_HOURS` | セッション TTL（時間） |
| `CONSULT_MAX_TURNS` | 相談最大ターン数 |
| `R2_BUCKET_URL` | R2 パブリック URL |
| `R2_MAX_FILE_SIZE_MB` | R2 最大ファイルサイズ（MB） |
| `R2_ALLOWED_CONTENT_TYPES` | R2 許可コンテンツタイプ |

### Cloudflare Bindings

| Binding | 型 | 説明 |
|---|---|---|
| `DB` | `D1Database` | メイン DB |
| `R2` | `R2Bucket` | 画像ストレージ |
| `LINE_EVENTS_QUEUE` | `Queue` | LINE イベントキュー |
| `AI` | `Ai` | Cloudflare AI（将来使用） |
| `VECTORIZE` | `VectorizeIndex` | ナレッジ RAG 検索 |

---

## パフォーマンス・制約

| 制約 | 値 | 対策 |
|---|---|---|
| Workers CPU 時間 | 10ms（無料）/ 30ms（有料） | 重処理は Queue で非同期化 |
| Workers サイズ | 10MB 圧縮後 | 軽量ライブラリのみ使用 |
| D1 クエリ | 同期実行 | prepare().bind().run() パターン |
| LINE Webhook タイムアウト | 1秒 | Webhook で即 200、Queue で処理 |
| R2 アップロード | 同期 | Queue コンシューマー内で処理 |
