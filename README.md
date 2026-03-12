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

---

## 操作開始ガイド

### ロール別責務（確定版）

| ロール | 責務 | できること |
|--------|------|-----------|
| **superadmin** | adminの作成・無効化、全体監視 | admin作成/停止（カスケード停止）、全LINEユーザーの所属admin確認、システム管理 |
| **admin** | LINE登録案内の送信、ユーザーの閲覧・管理 | 招待コード発行、LINE案内文コピー、ユーザー一覧（ステータスタブ）、ユーザー詳細閲覧、サービスON/OFF |
| **user（LINE）** | LINEで記録、LIFFダッシュボード閲覧 | 招待コード入力、問診回答、体重記録、食事写真送信、AI相談、ダッシュボード閲覧 |

> **⚠️ 運用ルール**: 初期運用は **superadmin（1人固定） + admin（複数可）の2ロール構成のみ**を使用してください。staffロールはコード上の互換性のため残していますが、管理画面では非表示です。staffが将来必要になった場合はDB直接操作またはAPI経由で追加可能です。superadminは初回セットアップ時に1人だけ作成され、追加作成はできません。

### Superadmin → Admin → User 完全フロー

```
1. 【superadmin】 /admin にアクセス
   ↓ 初回: 「初回セットアップはこちら（superadmin用）」リンクをクリック
   ↓ → メール+パスワードでsuperadminアカウント作成
   ↓ → ログイン画面に自動で戻り、入力済み
   
2. 【superadmin】 ログイン → 「管理者管理」でadminを作成
   ↓ → メール+仮パスワードで即時作成
   ↓ → 新しいadminアカウントが自動生成される

3. 【admin】 仮パスワードでログイン → ウェルカムガイド表示
   ↓ → 「招待コード」で顧客用コードを発行（例: ABC-1234）
   ↓ → 「LINE案内文」でテンプレートをコピーし、顧客に送信

4. 【user】 顧客がLINE友達追加 → BOTが「招待コードを送信してください」
   ↓ → 顧客がコード送信 → 自動でadminに紐付け
   ↓ → 問診開始 → 9問回答 → 完了

5. 【user】 日常利用開始
   ↓ → 体重記録、食事写真、AI相談、LIFFダッシュボード
   ↓ → adminは「LINEユーザー管理」で記録を確認
```

### 実運用チェックリスト（管理画面内に組み込み済み）
`/admin` → サイドバー「フローチェック」で全17項目のインタラクティブチェックリストを利用できます。
- **Phase 1**: superadmin セットアップ（3項目）
- **Phase 2**: admin 作成・ログイン・招待コード発行・LINE案内文コピー（4項目）
- **Phase 3**: user の LINE 操作（友達追加→招待コード→問診→体重→食事→AI相談→LIFF）（7項目）
- **Phase 4**: admin 画面でユーザー反映確認（3項目）

---

## 動作確認済み機能（Phase 1）

### 招待コードによるユーザー識別

**問題**: LINE公式アカウントを友達追加しただけでは、そのユーザーがどのadminの顧客か区別できない。
**解決策**: 招待コード方式でユーザーを正しいアカウント（admin）に紐付ける。

**フロー**:
1. admin が管理画面で招待コードを発行（例: `ABC-1234`）
2. admin が顧客にコードを伝える（LINE案内文テンプレートで配布可能）
3. 顧客がLINE友達追加 → BOTが「招待コードを送信してください」と案内
4. 顧客がコードを送信 → `user_accounts.client_account_id` が該当adminのaccountに紐付け
5. 紐付け完了後、初回問診（9問）が自動開始

**API**:
| メソッド | エンドポイント | 説明 |
|----------|---------------|------|
| GET | `/api/admin/invite-codes` | 招待コード一覧 |
| POST | `/api/admin/invite-codes` | 招待コード発行 |
| PATCH | `/api/admin/invite-codes/:id/revoke` | 招待コード無効化 |

### カスケード停止（admin停止 → 従属ユーザー自動停止）

- superadmin が admin を「停止」→ `accounts.status=suspended` + 全従属ユーザー `bot_enabled=0`
- superadmin が「有効化」→ 全て復帰

### 管理画面 — 最新機能

| 機能 | 説明 |
|------|------|
| **初回セットアップフロー** | ログイン画面に「初回セットアップはこちら」リンク表示（`/api/admin/auth/setup-status` でsuperadmin未登録時のみ表示） |
| **ステータスタブ** | LINEユーザー一覧に「全件/未問診/利用中/停止中」タブフィルター |
| **ロール表示強化** | サイドバーに色付きロールバッジ（amber: superadmin, blue: admin） |
| **所属admin表示** | superadminのLINEユーザー一覧で各ユーザーの所属admin（メール）を表示 |
| **実運用チェックリスト** | Phase1〜4構成の17項目チェックリスト（操作・期待結果・ボタン付き、進捗バー付き） |
| **2ロール簡素化** | 権限カードをsuperadmin/adminの2構成に簡素化（staff作成は非推奨化） |

### LINE Webhook
- **follow イベント**: line_users・user_accounts 自動作成、招待コード入力を促すメッセージ送信
- **招待コード検出**: `ABC-1234` パターンのテキスト → 検証 → アカウント紐付け
- **テキスト記録**: 体重（例: `72.5kg`）→ daily_logs・body_metrics に保存
- **相談モード**: GPT-4o による AI 返信
- **画像解析**: 食事写真/体重計/経過写真を R2 → Queue → OpenAI Vision → 確認フロー

### 問診 (Intake) フロー
- 9問の初回問診（ニックネーム/性別/年代/身長/体重/目標/理由/気になること/活動レベル）
- 途中離脱後の再開対応

### LIFF認証フロー
- `/liff` → LINE Login → JWT発行 → `/dashboard`
- `USER_NOT_REGISTERED`, `ACCOUNT_NOT_FOUND`, `INVALID_LINE_TOKEN` の各状態に対応

### ユーザーPWA
- `/dashboard` で3状態分岐（停止中/問診未完了/通常）

---

## 管理者 API

| メソッド | エンドポイント | 説明 |
|----------|---------------|------|
| GET | `/api/admin/auth/setup-status` | **superadmin存在チェック（認証不要）** |
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
| PATCH | `/api/admin/dashboard/members/:id` | 管理者ステータス変更+カスケード停止 |
| GET | `/api/admin/invite-codes` | 招待コード一覧 |
| POST | `/api/admin/invite-codes` | 招待コード発行 |
| PATCH | `/api/admin/invite-codes/:id/revoke` | 招待コード無効化 |
| GET | `/api/admin/users` | LINEユーザー一覧（superadmin:全件+admin情報） |
| GET | `/api/admin/users/:id` | ユーザー詳細 |
| PATCH | `/api/admin/users/:id/service` | サービス設定変更 |

---

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
| LINE_CHANNEL_ID | ch_default_replace_me (D1 line_channels.id 内部UUID) |
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
1. **LIFFエンドポイントURL設定**: `https://diet-bot.pages.dev/liff`
2. **Webhook URL確認**: `https://diet-bot.pages.dev/api/webhooks/line`

## デプロイ
- **プラットフォーム**: Cloudflare Pages
- **ステータス**: ✅ 本番稼働中
- **技術スタック**: Hono + TypeScript + Cloudflare D1/R2/Queue + OpenAI GPT-4o
- **GitHub**: https://github.com/matiuskuma2/syokujikanri
- **最終デプロイ**: 2026-03-12（LINE連携不具合修正 + 仕様書追加）
- **デプロイURL**: https://diet-bot.pages.dev

## ローカル開発
```bash
npm install
npm run db:migrate:local
npm run db:seed
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

## デプロイ後検証チェックリスト

本番デプロイ後に以下を実機で確認してください。管理画面の「フローチェック」ページにもインタラクティブ版があります。

### ① 管理画面（/admin）検証
| # | 操作 | 期待結果 | 確認 |
|---|------|----------|------|
| 1 | `/admin` にアクセス | ログイン画面が表示される | ☐ |
| 2 | superadmin でログイン | ダッシュボードに amber ロールバッジ表示 | ☐ |
| 3 | 「管理者管理」→ admin作成（メール+仮パスワード） | admin一覧に追加される | ☐ |
| 4 | ログアウト → 作成したadminでログイン | blue ロールバッジ、admin用メニュー表示 | ☐ |
| 5 | 「招待コード」→ コード発行 | コードが生成される | ☐ |
| 6 | 「LINE案内文」→ テンプレートコピー | クリップボードにコピーされる | ☐ |
| 7 | 「LINEユーザー管理」→ ステータスタブ切替 | 全件/未問診/利用中/停止中 でフィルター | ☐ |
| 8 | superadminでログイン → ユーザー一覧 | 「所属admin」列が表示される | ☐ |
| 9 | 「フローチェック」ページ | チェックリスト表示、チェック＆進捗バー動作 | ☐ |

### ② LINE ユーザーフロー検証
| # | 操作 | 期待結果 | 確認 |
|---|------|----------|------|
| 1 | LINE で `@054eyzbj` を友達追加 | 「招待コードを送信してください」メッセージ受信 | ☐ |
| 2 | 招待コード（例: `ABC-1234`）を送信 | 「紐付け完了」→ 問診開始メッセージ | ☐ |
| 3 | 問診9問に順番に回答 | 各問ごとに次の質問表示 → 完了メッセージ | ☐ |
| 4 | `72.5kg` と送信 | 体重記録完了メッセージ | ☐ |
| 5 | 食事写真を送信 | AI分析 → 「確定/取消」の確認メッセージ | ☐ |
| 6 | `相談` と送信 | AIチャットモード開始 | ☐ |
| 7 | LIFF URL にアクセス | ダッシュボード表示（体重/食事/記録一覧） | ☐ |

### ③ 管理画面からユーザー確認
| # | 操作 | 期待結果 | 確認 |
|---|------|----------|------|
| 1 | admin で「LINEユーザー管理」 | 友達追加したユーザーが表示 | ☐ |
| 2 | ユーザーをクリック | 詳細モーダル（プロフィール/ログ/写真/レポート） | ☐ |
| 3 | 「利用中」タブ | 問診完了ユーザーが表示 | ☐ |

---

## 詳細仕様書（docs/ ディレクトリ）

| ドキュメント | 内容 |
|-------------|------|
| [`docs/01_LINE動き仕様書.md`](docs/01_LINE動き仕様書.md) | LINE上の全イベント処理フロー、メッセージ例、BOT応答文言、DB保存先テーブル、テキスト処理優先順位 |
| [`docs/02_画像解析記録反映確認表.md`](docs/02_画像解析記録反映確認表.md) | 画像パイプライン全体図、カテゴリ別抽出データ、proposed_action_json構造、エラーハンドリング |
| [`docs/03_計画vs現状_差分比較.md`](docs/03_計画vs現状_差分比較.md) | 54項目の実装チェックリスト、ナレッジ・プロンプト設計の差分、推奨次ステップ（優先順位付き） |

---

## 修正履歴（2026-03-12）

### LINE連携不具合の修正
| # | 問題 | 原因 | 対応 |
|---|------|------|------|
| 1 | 招待コードが「使用済み」エラー | max_uses=1で1回使用後にブロック | use_countリセット、フロー修正 |
| 2 | 「このサービスは現在ご利用いただけません」 | checkServiceAccessが招待コード処理の前に実行 | 招待コード検出を最優先に移動 |
| 3 | line_usersにレコードが作成されない | LINE_CHANNEL_IDとline_channels.idの不一致（数値vs内部UUID） | webhook.tsでline_channelsテーブルLookup追加 |
| 4 | 別アカウントに紐付けた後もブロック | checkServiceAccessがCLIENT_ACCOUNT_IDのみで検索 | lineUserIdフォールバック検索を追加 |

---

## 次のステップ（未実装）

### Phase 1.1 — 即時対応（運用開始前に必須）
1. ✅ ~~Cloudflare API key設定後の本番デプロイ~~ 完了（2026-03-12）
2. ✅ ~~admin画面の文言改善（LINE登録案内に統一）~~ 完了（2026-03-12）
3. ✅ ~~LINE連携不具合修正（招待コード・アカウント紐付け）~~ 完了（2026-03-12）
4. E2Eテスト実施: LINE実機で友達追加→招待コード→問診→記録→画像→相談の全フロー検証
5. LINE Developers Webhook設定確認（Webhook URLが有効かつON）

### Phase 1.2 — 品質向上（運用開始後2週間以内）
6. knowledge_documents にコンテンツ投入（基礎栄養知識、FAQ、指導方針）
7. 相談AIにDB上のプロンプトを接続（bot_versions.system_prompt → ハードコード置換）
8. 個人コンテキスト注入（相談時にuser_profiles + 直近記録をプロンプトに追加）
9. SendGridパスワードリセットメール動作確認

### Phase 2 — 機能拡張
10. RAG実装（knowledge_documents のembedding検索）
11. 管理画面プロンプトエディタ
12. サブスクリプション管理・課金
13. LINE Rich Menu 設定
14. 運動記録機能
