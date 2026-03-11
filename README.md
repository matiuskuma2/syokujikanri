# diet-bot — ダイエットサポート LINE BOT

## プロジェクト概要
- **名前**: diet-bot（食事指導BOT）
- **目的**: LINE経由でダイエット（食事・体重・運動）を記録・サポートするAI BOT
- **フェーズ**: Phase 1 MVP — 本番稼働中

## 本番URL
| 用途 | URL |
|------|-----|
| **本番サイト** | https://diet-bot.pages.dev |
| **管理画面** | https://diet-bot.pages.dev/admin |
| **LIFF** | https://diet-bot.pages.dev/liff |
| **ユーザーダッシュボード** | https://diet-bot.pages.dev/dashboard |
| **LINE LIFF URL** | https://liff.line.me/2009409790-DekZRh4t |
| **API Health** | https://diet-bot.pages.dev/api/health |
| **Webhook** | https://diet-bot.pages.dev/api/webhooks/line |

## LINE チャンネル情報
| 種別 | ID |
|------|-----|
| **Messaging API Channel ID** | 1656660870 |
| **Bot UserID** | U690780eb88b08bda9b461d51d99c705f |
| **Basic ID** | @054eyzbj |
| **Bot名** | 食事指導BOT |
| **LIFF Channel ID (Login)** | 2009409790 |
| **LIFF ID** | 2009409790-DekZRh4t |

## 動作確認済み機能（Phase 1）

### ✅ LINE Webhook
- **follow イベント**: line_users・user_accounts・conversation_threads 自動作成、ウェルカムメッセージ送信
- **テキスト記録**: 体重（例: `72.5kg`）→ daily_logs・body_metrics に保存、即時返信
- **相談モード**: `相談モード` で切替 → GPT-4o による AI 返信
- **署名検証**: HMAC-SHA256 署名検証

### ✅ LIFF認証フロー
- `/liff` → liff.init() → ID Token取得 → `/api/auth/line` → JWT発行 → `/dashboard`

### ✅ 管理画面
- `/admin` → ログイン（JWT）→ ダッシュボード（統計）・ユーザー一覧

### ✅ インフラ
- Cloudflare Pages デプロイ済み
- D1 (diet-bot-production) — 7件マイグレーション適用済み
- R2 (diet-bot-media) — 画像保存用
- Queue (diet-bot-line-events + DLQ) — 画像解析ジョブ用

## データアーキテクチャ
```
accounts → line_channels → line_users → user_accounts
                                      ↓
                            conversation_threads → conversation_messages
                                      ↓
                            daily_logs → body_metrics
                                       → meal_entries
                            image_analysis_jobs → image_intake_results
                            progress_photos
                            weekly_reports
```

## 環境変数（Cloudflare Pages Secrets設定済み）
| 変数名 | 内容 |
|--------|------|
| LINE_CHANNEL_SECRET | Messaging API Channel Secret |
| LINE_CHANNEL_ACCESS_TOKEN | Messaging API Access Token |
| LINE_LIFF_CHANNEL_ID | 2009409790 (Login Channel) |
| LINE_LIFF_ID | 2009409790-DekZRh4t |
| LINE_CHANNEL_ID | ch_default_replace_me (D1 line_channels.id) |
| CLIENT_ACCOUNT_ID | acc_client_00000000000000000000000000000001 |
| OPENAI_API_KEY | GPT-4o API Key |
| JWT_SECRET | (auto-generated secure key) |

## ユーザーガイド
1. LINE で `@054eyzbj` を友だち追加
2. `72.5kg` のように体重を送信 → 自動記録
3. `相談モード` → AI 相談に切替
4. `記録モード` → 記録に戻る
5. LIFF URL: https://liff.line.me/2009409790-DekZRh4t → ダッシュボード表示

## LINE Developers での追加設定（手動）
> **重要**: 以下はLINE Developersコンソールで手動設定が必要

1. **LIFFエンドポイントURL設定**（Login Channel 2009409790 → LIFF → 編集）
   ```
   エンドポイントURL: https://diet-bot.pages.dev/liff
   ```
2. **Webhook URL確認**（Messaging API → Webhook設定）
   ```
   Webhook URL: https://diet-bot.pages.dev/api/webhooks/line ✅ 設定済み
   ```

## デプロイ
- **プラットフォーム**: Cloudflare Pages
- **ステータス**: ✅ 本番稼働中
- **技術スタック**: Hono + TypeScript + Cloudflare D1/R2/Queue + OpenAI GPT-4o
- **最終更新**: 2026-03-11

## ローカル開発
```bash
# 依存インストール
npm install

# D1マイグレーション（初回）
npm run db:migrate:local

# シードデータ投入
npm run db:seed

# 開発サーバー起動
npm run build
pm2 start ecosystem.config.cjs

# ヘルスチェック
curl http://localhost:3000/api/health
```
