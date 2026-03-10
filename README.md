# diet-bot

## プロジェクト概要

LINE連携ダイエット支援BOTシステム（Phase 1 MVP）

**目的**: クリニック・サロン向けの半自動化・可視化ダイエット支援サービス。LINEだけで食事写真・テキスト送信 → BOTがヒアリング・記録・アドバイス → ダッシュボードで管理

---

## 動作確認URL（ローカル開発環境）

| URL | 説明 |
|-----|------|
| `http://localhost:3000/health` | ヘルスチェック |
| `http://localhost:3000/admin` | 管理ダッシュボード |
| `http://localhost:3000/dashboard` | ユーザーPWA |
| `http://localhost:3000/api/admin/auth/login` | 管理者ログイン |
| `http://localhost:3000/api/admin/dashboard/summary` | ダッシュボード集計 |
| `http://localhost:3000/api/admin/users` | ユーザー一覧 |
| `http://localhost:3000/api/user/dashboard` | ユーザーダッシュボード |
| `http://localhost:3000/api/webhooks/line` | LINE Webhook |

---

## 技術スタック

- **Runtime**: Cloudflare Workers / Pages
- **Framework**: Hono v4 + TypeScript
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (画像・メディア)
- **Queue**: Cloudflare Queues (LINEイベント非同期処理)
- **AI**: OpenAI GPT-4o (食事解析・相談・レポート)
- **LINE**: LINE Messaging API
- **Build**: Vite + @hono/vite-build
- **Wrangler**: v4.71.0

---

## プロジェクト構造

```
diet-bot/
├── src/
│   ├── index.ts              # メインエントリーポイント
│   ├── types/
│   │   ├── bindings.ts       # Cloudflare環境変数・LINE型
│   │   └── models.ts         # DBエンティティ型
│   ├── middleware/
│   │   └── auth.ts           # JWT認証ミドルウェア
│   ├── routes/
│   │   ├── webhooks/line.ts  # LINE Webhookルーター
│   │   ├── admin/            # 管理者API
│   │   └── user/             # ユーザーAPI
│   ├── bot/
│   │   ├── dispatcher.ts     # BOTメッセージディスパッチャー
│   │   ├── consumer.ts       # Queueコンシューマー
│   │   └── cron.ts           # Cronジョブ
│   ├── ai/
│   │   ├── client.ts         # OpenAIクライアント
│   │   └── prompts.ts        # プロンプトテンプレート
│   ├── repository/
│   │   └── index.ts          # DBリポジトリ層
│   └── utils/
│       ├── line.ts           # LINE APIユーティリティ
│       ├── jwt.ts            # JWT処理
│       └── response.ts       # APIレスポンスヘルパー
├── migrations/               # D1マイグレーションSQL（7ファイル）
├── public/static/            # 静的ファイル
├── .dev.vars                 # ローカル開発用環境変数（要設定）
├── wrangler.jsonc            # Cloudflare設定
└── ecosystem.config.cjs      # PM2設定
```

---

## データモデル

| テーブル | 説明 |
|---------|------|
| `accounts` | 契約アカウント（クリニック等） |
| `account_memberships` | アカウント↔管理者紐付け |
| `subscriptions` | 契約プラン |
| `line_channels` | LINEチャンネル設定 |
| `line_users` | LINEユーザー |
| `user_service_statuses` | ユーザーごとのON/OFF制御 |
| `conversation_threads` | 会話スレッド |
| `conversation_messages` | メッセージ履歴 |
| `message_attachments` | 添付ファイル（R2キー） |
| `bot_mode_sessions` | BOTセッション管理 |
| `bots` / `bot_versions` | BOT設定・バージョン |
| `knowledge_bases` / `knowledge_documents` | ナレッジ管理 |
| `user_profiles` | ユーザープロファイル |
| `intake_forms` / `intake_answers` | ヒアリング |
| `daily_logs` | 日次記録 |
| `meal_entries` | 食事記録 |
| `image_intake_results` | 画像解析結果 |
| `progress_photos` | 進捗写真 |
| `weekly_reports` | 週次レポート |
| `question_definitions` | 質問定義マスタ |
| `audit_logs` | 監査ログ |

---

## BOTフロー

```
LINE メッセージ受信
  └── Webhook (/api/webhooks/line)
      └── 署名検証 → Queue送信
          └── Queue Consumer
              ├── follow → ウェルカム + ヒアリング開始
              ├── message
              │   ├── テキスト
              │   │   ├── コマンド（記録/相談/ヘルプ等）
              │   │   └── セッション継続（ヒアリング/記録/相談）
              │   └── 画像 → AI分類
              │       ├── meal_photo → 食事解析 + 記録
              │       ├── body_scale → 体重読取 + 記録
              │       ├── nutrition_label → ラベル解析
              │       └── progress_body_photo → 進捗写真保存
              └── unfollow → BOT無効化
```

---

## ロール・権限

| ロール | 権限 |
|--------|------|
| `superadmin` | 契約管理、ユーザー管理、全機能 |
| `admin` | 店舗顧客一覧・記録閲覧、ダッシュボード |
| `user` | LINE記録・相談、個人データ閲覧 |

---

## ローカル開発

### 1. 環境変数設定
```bash
cp .dev.vars .dev.vars.local
# .dev.varsを編集してAPIキーを設定
```

### 2. DBマイグレーション
```bash
npm run db:migrate:local
```

### 3. サービス起動
```bash
npm run build
pm2 start ecosystem.config.cjs
```

### 4. 管理者ログイン（開発環境）
- Email: `admin@diet-bot.local`
- Password: `admin123`

---

## Cloudflare本番デプロイ

### 1. D1データベース作成
```bash
npx wrangler d1 create diet-bot-production
# 出力されたdatabase_idをwrangler.jsoncに設定
```

### 2. R2バケット作成
```bash
npx wrangler r2 bucket create diet-bot-media
```

### 3. シークレット設定
```bash
npx wrangler pages secret put LINE_CHANNEL_SECRET --project-name diet-bot
npx wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name diet-bot
npx wrangler pages secret put OPENAI_API_KEY --project-name diet-bot
npx wrangler pages secret put JWT_SECRET --project-name diet-bot
```

### 4. デプロイ
```bash
npm run deploy:prod
```

---

## 実装済み機能（Phase 1 MVP）

- [x] Wrangler v4 + Hono + Cloudflare Pages セットアップ
- [x] TypeScript型定義（全モデル・バインディング）
- [x] D1マイグレーション（7ファイル・全テーブル）
- [x] LINE Webhook + Queueコンシューマー
- [x] BOTディスパッチャー（ヒアリング/記録/相談/ナレッジ）
- [x] OpenAIプロンプトテンプレート（8種類）
- [x] 画像AI解析（食事/体重計/栄養ラベル/進捗写真）
- [x] JWT認証（Web Crypto API使用）
- [x] 管理者API（認証/ユーザー管理/ダッシュボード）
- [x] ユーザーAPI（ダッシュボード/記録一覧）
- [x] 管理ダッシュボードUI（SPA）
- [x] ユーザーPWA
- [x] Cronジョブ（デイリーリマインダー/週次レポート）
- [x] Repository層（全テーブルCRUD）

## 未実装（今後の優先事項）

- [ ] Cloudflare Vectorize（RAGナレッジ検索）
- [ ] 管理者テーブル（DB管理型認証）
- [ ] LINEチャンネル管理UI
- [ ] ナレッジ管理UI
- [ ] ユーザー詳細ページ（会話履歴・グラフ）
- [ ] Cloudflare本番環境デプロイ
- [ ] 高精度食事画像APIとの連携（Phase 2）

---

## 開発状況

- **プラットフォーム**: Cloudflare Pages (ローカル開発中)
- **ステータス**: ✅ ローカル動作確認済み
- **最終更新**: 2026-03-10
