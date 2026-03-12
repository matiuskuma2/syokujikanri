# diet-bot — ダイエットサポート LINE BOT

## プロジェクト概要
- **名前**: diet-bot（食事指導BOT）
- **目的**: LINE経由でダイエット（食事・体重・運動）を記録・サポートするAI BOT
- **フェーズ**: Phase 1 MVP — 本番稼働中

## 本番URL
| 用途 | URL |
|------|-----|
| **ウェルカムページ（会員サイト）** | https://diet-bot.pages.dev/welcome |
| **LINE友達追加** | https://lin.ee/n4PoXrR |
| **管理画面** | https://diet-bot.pages.dev/admin |
| **LIFF** | https://diet-bot.pages.dev/liff |
| **ユーザーダッシュボード** | https://diet-bot.pages.dev/dashboard |
| **LINE LIFF URL** | https://liff.line.me/2009409790-DekZRh4t |
| **API Health** | https://diet-bot.pages.dev/api/health |
| **Webhook** | https://diet-bot.pages.dev/api/webhooks/line |

> **Note**: `/` (ルート) は `/welcome` にリダイレクトされます

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

### ✅ 招待コードによるユーザー識別（重要）

**問題**: LINE公式アカウントを友達追加しただけでは、そのユーザーがどのadminの顧客か区別できない。
**解決策**: 招待コード方式でユーザーを正しいアカウント（admin）に紐付ける。

**フロー**:
1. admin が管理画面で招待コードを発行（例: `ABC-1234`）
2. admin が顧客にコードを伝える（LINE案内文テンプレートで配布可能）
3. 顧客がLINE友達追加 → BOTが「招待コードを送信してください」と案内
4. 顧客がコードを送信 → `user_accounts.client_account_id` が該当adminのaccountに紐付け
5. 紐付け完了後、初回問診（9問）が自動開始

**DBテーブル**:
- `invite_codes`: コード管理（code, account_id, max_uses, use_count, expires_at, status）
- `invite_code_usages`: 使用履歴（invite_code_id, line_user_id, used_at）

**API**:
| メソッド | エンドポイント | 説明 |
|----------|---------------|------|
| GET | `/api/admin/invite-codes` | 招待コード一覧 |
| POST | `/api/admin/invite-codes` | 招待コード発行 |
| PATCH | `/api/admin/invite-codes/:id/revoke` | 招待コード無効化 |

### ✅ カスケード停止（admin停止 → 従属ユーザー自動停止）

**重要な設計方針**: 支払いを止めたadminに紐づくユーザーは全員利用停止になる。

**仕組み**:
- superadmin が管理者（admin）を「停止」にすると:
  1. `account_memberships.status` → `suspended`
  2. `accounts.status` → `suspended`
  3. そのアカウントに紐づく全 `user_service_statuses.bot_enabled` → `0`
  4. → 従属ユーザーはLINE BOTからメッセージを送っても「このサービスは現在ご利用いただけません」と返される
- superadmin が「有効化」すると全て復帰

**コード**: `PATCH /api/admin/dashboard/members/:id` (dashboard.ts)

### ✅ LINE Webhook
- **follow イベント**: line_users・user_accounts 自動作成、**招待コード入力を促すメッセージ送信**
- **招待コード検出**: `ABC-1234` パターンのテキスト → `invite_codes` テーブルで検証 → アカウント紐付け
- **テキスト記録**: 体重（例: `72.5kg`）→ daily_logs・body_metrics に保存、即時返信
- **相談モード**: `相談モード` で切替 → GPT-4o による AI 返信
- **署名検証**: HMAC-SHA256 署名検証
- **画像解析**: 食事写真/体重計/経過写真を R2 保存 → Queue → OpenAI Vision 解析 → 仮保存 → ユーザー確認後に正式登録

### ✅ 問診 (Intake) フロー — M2-1
- 9問の初回問診（ニックネーム/性別/年代/身長/体重/目標/理由/気になること/活動レベル）
- `intake_completed` フラグで完了管理
- 途中離脱後の再開: `問診再開` / `問診やり直し` コマンド対応
- follow 時: 招待コード使用済みユーザーは問診再開、未使用は招待コード入力案内

### ✅ 画像確認フロー — M3-1/M3-2/M3-6/M3-7
- 画像解析結果を `image_intake_results` に仮保存 (`applied_flag=0`)
- LINE QuickReply で「確定」「取消」選択可能 (`pending_image_confirm` モード)
- 確定 → meal_entries / body_metrics / progress_photos に正式登録
- 取消 → `applied_flag=2` でマーク
- 24時間未応答 → hourly cron で `applied_flag=3` (expired) に自動更新

### ✅ LIFF認証フロー — M1-4
- `/liff` → liff.init() → ID Token取得 → `/api/auth/line` → JWT発行 → `/dashboard`
- `USER_NOT_REGISTERED`: 登録手順ガイド画面（友達追加→問診→再読み込み）
- `ACCOUNT_NOT_FOUND`: アカウント紐付け待ち画面
- `INVALID_LINE_TOKEN`: 再ログインボタン付き画面

### ✅ ユーザーPWA — M1-3 / L-1
- `/dashboard` で3状態分岐:
  - **停止中** (`botEnabled=false`): 全画面ブロック + 再読み込みボタン
  - **問診未完了** (`intakeCompleted=false`): 問診誘導画面 + LINE遷移ボタン + ナビ制限
  - **通常**: フルダッシュボード（今日のサマリー/体重グラフ/食事/記録/写真/レポート/プロフィール）

### ✅ 管理画面 — M1-5 / M2-2 / M2-3 / L-2
- `/admin` → ログイン（JWT）→ ダッシュボード統計
  - 総ユーザー数 / 今日の記録数 / 週間アクティブ / **問診未完了数**
- **初回セットアップ**: superadminが未登録の場合、ログイン画面から初期セットアップ画面に遷移可能
- **ロール別ウェルカムガイド**: 初回ログイン時に「最初にやること」を表示（superadmin/admin/staff別）
- **ロール別ナビゲーション**:
  - **superadmin**: ダッシュボード / LINEユーザー管理 / **招待コード** / 管理者管理 / LINE案内文 / アカウント設定 / システム管理
  - **admin**: ダッシュボード / LINEユーザー管理 / **招待コード** / 管理者管理 / LINE案内文 / アカウント設定
  - **staff**: ダッシュボード / LINEユーザー管理 / アカウント設定（閲覧のみ）
- **招待コード管理ページ（NEW）**:
  - 発行フォーム（ラベル/使用回数上限/有効期限を選択）
  - 発行済みコード一覧（コード/ラベル/使用状況/状態/有効期限/作成者）
  - コードの無効化操作
  - ワンクリックでコードをクリップボードにコピー
- **管理者管理ページ**:
  - 管理者一覧（メール/権限/状態/LINEユーザー数/最終ログイン）
  - 管理者追加フォーム（メール+仮パスワード+権限選択）
  - 管理者ステータス切替（有効/停止）— superadminのみ → **カスケード停止連動**
  - 権限説明カード（superadmin/admin/staff）
- **LINE案内文ページ**: QRコード表示 / LINE ID / **招待コード入力ガイド付き**メール用テンプレ / SMS用テンプレ / ウェルカムページURL
- ユーザー一覧: ステータスラベル（ブロック/停止中/問診未完了/制限中/利用中）
- ユーザー詳細モーダル（4タブ）:
  - **概要**: プロフィール + 問診回答 + サービス設定 + 直近記録
  - **記録**: 30日間の食事記録（タイプ別バッジ・カロリー表示）
  - **写真**: 進捗写真グリッド（タイプ/ポーズラベル付き）
  - **レポート**: 7日間サマリー（記録日数/食事数/ログ件数）

### ✅ Superadmin画面 — L-3
- `/admin` でsuperadmin限定「システム管理」メニュー
  - API バージョン / ランタイム / データベース情報
  - データベース統計（テーブルサイズ）— invite_codes, invite_code_usages 追加
  - 定期ジョブ一覧（リマインダー/週次レポート/期限切れ清掃/**招待コード期限切れ処理**）
  - API エンドポイント一覧

### 管理者 API
| メソッド | エンドポイント | 説明 |
|----------|---------------|------|
| POST | `/api/admin/auth/register` | 初回superadmin登録 |
| POST | `/api/admin/auth/login` | ログイン（JWT発行） |
| POST | `/api/admin/auth/invite` | メール招待（SendGrid） |
| POST | `/api/admin/auth/accept-invite` | 招待受諾 |
| POST | `/api/admin/auth/change-password` | パスワード変更 |
| POST | `/api/admin/auth/forgot-password` | パスワードリセット申請 |
| POST | `/api/admin/auth/reset-password` | パスワードリセット実行 |
| GET | `/api/admin/auth/me` | 自分の情報取得 |
| GET | `/api/admin/dashboard/stats` | ダッシュボード統計 |
| GET | `/api/admin/dashboard/members` | 管理者一覧 |
| POST | `/api/admin/dashboard/members` | 管理者直接作成（仮パスワード） |
| PATCH | `/api/admin/dashboard/members/:id` | 管理者ステータス変更 **+カスケード停止** |
| GET | `/api/admin/invite-codes` | **招待コード一覧** |
| POST | `/api/admin/invite-codes` | **招待コード発行** |
| PATCH | `/api/admin/invite-codes/:id/revoke` | **招待コード無効化** |
| GET | `/api/admin/users` | LINEユーザー一覧 |
| GET | `/api/admin/users/:id` | ユーザー詳細 |
| PATCH | `/api/admin/users/:id/service` | サービス設定変更 |

### ロール別初回フロー
1. **Superadmin**:
   - `/admin` にアクセス → ログイン画面 → 「こちら」から初期セットアップ → アカウント作成
   - ログイン → ウェルカムガイド → 「管理者管理」で admin を追加 → システム設定確認
2. **Admin**:
   - superadmin が作成した仮パスワードで `/admin` にログイン
   - ウェルカムガイド → **「招待コード」で顧客用コード発行** → 「LINE案内文」で顧客にコード付きLINE登録案内 → ユーザー記録を確認
3. **User（エンドユーザー）**:
   - LINE友達追加 → **招待コード送信** → 初回問診（9問）→ 食事写真・体重送信 → LIFF ダッシュボード

### ✅ インフラ
- Cloudflare Pages デプロイ済み
- D1 (diet-bot-production) — **10件マイグレーション適用済み**
- R2 (diet-bot-media) — 画像保存用
- Queue (diet-bot-line-events + DLQ) — 画像解析ジョブ用

## データアーキテクチャ
```
accounts → line_channels → line_users → user_accounts
         ↓                            ↓
  invite_codes → invite_code_usages   user_service_statuses (bot_enabled, intake_completed, ...)
  (admin発行)    (LINEユーザー使用)    user_profiles (nickname, height, weight, goal, ...)
                                      intake_answers (question_key, answer_value, ...)
                                      conversation_threads → conversation_messages
                                                ↓
                                      daily_logs → body_metrics
                                                 → meal_entries
                                      image_analysis_jobs → image_intake_results
                                      progress_photos
                                      weekly_reports
                                      bot_mode_sessions (intake/record/consult/pending_image_confirm)

カスケード停止の流れ:
  superadmin → admin停止 → accounts.status=suspended
                         → user_service_statuses.bot_enabled=0 (全従属ユーザー)
                         → LINEユーザーがBOTに送信 → 「利用停止」メッセージ
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
1. **ウェルカムページ** https://diet-bot.pages.dev/welcome でQRコード・使い方を確認
2. LINE で `@054eyzbj` を友だち追加（または https://lin.ee/n4PoXrR ）
3. **担当者から受け取った招待コード（例: ABC-1234）をLINEで送信**
4. 初回問診（9問）に回答 → 約2分で完了
5. `72.5kg` のように体重を送信 → 自動記録
6. 食事の写真を送信 → AI がカロリー・PFC を自動分析 → 「確定」で保存
7. `相談` → AI 栄養相談モードに切替
8. `記録モード` → 記録モードに戻る
9. LIFF URL: https://liff.line.me/2009409790-DekZRh4t → ダッシュボード表示

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
- **最終更新**: 2026-03-12

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
