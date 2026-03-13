# diet-bot — ダイエットサポート LINE BOT

## プロジェクト概要
- **名前**: diet-bot（食事指導BOT）
- **目的**: LINE経由でダイエット（食事・体重・運動）を記録・サポートするAI BOT
- **フェーズ**: Phase 2.1 — 実装前確定ルール12項目明文化 + コード反映 **(v2.1.0)**

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

> **SSoT**: 招待コードのビジネスルール詳細は [`docs/04_招待コード_ビジネスルール.md`](docs/04_招待コード_ビジネスルール.md) を参照。

**基本ルール**:
| # | ルール |
|---|--------|
| R1 | 1 LINEユーザーは 1 アカウント（admin）にのみ紐付く |
| R2 | 初回の招待コード使用で紐付けが確定する |
| R3 | 紐付け確定後、別のコードを送信しても紐付けは変わらない |
| R4 | 紐付け確定後に再送信した場合、問診未完了なら問診を再開する |
| R5 | コードの使用回数は `max_uses` で制限（デフォルト=1） |

**主要パターン**:
| パターン | 状況 | BOT応答 |
|----------|------|---------|
| P1 | 登録済み + 問診完了 | 「既に登録済み。そのままご利用ください」 |
| P2 | 登録済み + 問診未完了 | 「登録済み」+「問診 質問1」同時送信 |
| P3 | 無効なコード（新規ユーザー） | 「この招待コードは無効です」 |
| P5 | 別の人が使用済みコード（max_uses=1）を入力 | 「使用上限に達しています」 |
| P7b | 別アカウントのコードを入力（登録済みユーザー） | 現在の紐付けを維持し、問診状態に応じた応答 |
| P9 | 新規ユーザーが有効コードを入力 | 「登録完了」+「問診 質問1」同時送信 |

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
- **🆕 SSOT v2.0 会話解釈パイプライン（Phase A → B → C）**:
  - **Phase A**: AI解釈 — `interpretMessage()` がテキストを Unified Intent JSON に変換（gpt-4o）
  - **Phase B**: 明確化 — 不足フィールド（日付/食事区分/内容/体重値）をユーザーに質問
  - **Phase C**: 永続化 — `persistRecord()` が daily_logs/meal_entries/body_metrics に保存
  - **即時保存**: 日付+食事区分+内容が揃った食事、20-300kgの体重は Phase C 直行
  - **確認付き保存**: timestamp由来の日付/食事区分は保存+確認メッセージ
  - **修正/削除**: 「鮭じゃなくて卵焼き」「昨日の記録消して」等に対応
  - **フォールバック**: AI失敗時は regex ベースの簡易解釈
- **🆕 パーソナルメモリ（Layer 3）**: 会話からアレルギー・食習慣・目標等を自動抽出・蓄積
- **相談モード**: GPT-4o によるAI返信（メモリ・ナレッジ注入済み）
  - 相談中の体重・食事記録も副次意図として検出・自動保存
- **画像解析**: 食事写真/体重計/経過写真を R2 → OpenAI Vision → 確認フロー
- **food_master マッチング**: AI解析結果の食品名を food_master DB と照合、DB値優先でPFC補正

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
| GET | `/api/admin/users/:id/logs` | ユーザーの食事記録一覧 |
| GET | `/api/admin/users/:id/photos` | ユーザーの写真一覧 |
| GET | `/api/admin/users/:id/reports` | ユーザーの週次レポート一覧 |
| GET | `/api/admin/dashboard/bots` | **[superadmin]** BOT一覧 |
| GET | `/api/admin/dashboard/bots/:id/versions` | **[superadmin]** BOTバージョン一覧 |
| POST | `/api/admin/dashboard/bots/:id/versions` | **[superadmin]** System Prompt保存+公開 |
| GET | `/api/admin/dashboard/knowledge-bases` | **[superadmin]** ナレッジベース一覧 |
| GET | `/api/admin/dashboard/knowledge-bases/:id/documents` | **[superadmin]** ドキュメント一覧 |
| POST | `/api/admin/dashboard/knowledge-bases/:id/documents` | **[superadmin]** ドキュメント作成 |
| GET | `/api/admin/dashboard/bot-knowledge-links` | **[superadmin]** BOT↔ナレッジ紐付け一覧 |

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

SSOT v2.0 追加テーブル:
  pending_clarifications  (Phase B: 明確化待ち状態管理)
  correction_history      (記録修正の監査ログ)
  user_memory_items       (Layer 3: パーソナルメモリ)

SSOT v2.0 データフロー:
  ユーザーメッセージ → Phase A (AI解釈: UnifiedIntent JSON)
                     → Phase B (不足フィールド質問: pending_clarifications)
                     → Phase C (永続化: daily_logs / meal_entries / body_metrics)
                     → Background (メモリ抽出: user_memory_items)

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
5. `72.5kg` のように体重を送信 → AI解釈 → 自動記録（Phase A→C直行）
6. 食事の写真を送信 → AI がカロリー・PFC を自動分析 → food_master DB照合でPFC補正 → 「確定」で保存
7. `朝食 トースト・コーヒー` → AI解釈 → 即時保存（日付・区分・内容が揃っている場合）
8. 不足情報があれば BOT が質問（「いつの記録ですか？」等）→ 回答で補完・保存
9. `鮭じゃなくて卵焼き` → AI が修正意図を検出 → 対象レコードを自動修正
10. `相談` → AI 栄養相談モードに切替（パーソナルメモリ込み）
11. `記録モード` → 記録モードに戻る
12. LIFF URL: https://liff.line.me/2009409790-DekZRh4t → ダッシュボード表示

## LINE Developers での追加設定（手動）
1. **LIFFエンドポイントURL設定**: `https://diet-bot.pages.dev/liff`
2. **Webhook URL確認**: `https://diet-bot.pages.dev/api/webhooks/line`

## デプロイ
- **プラットフォーム**: Cloudflare Pages
- **ステータス**: ✅ 本番稼働中
- **技術スタック**: Hono + TypeScript + Cloudflare D1/R2/Queue + OpenAI GPT-4o
- **GitHub**: https://github.com/matiuskuma2/syokujikanri
- **最終デプロイ**: 2026-03-13（v2.1.0: 実装前確定ルール12項目 + R5 idempotency + R6-2,3 pending cancel）
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
| [`docs/04_招待コード_ビジネスルール.md`](docs/04_招待コード_ビジネスルール.md) | **SSoT**: 招待コードの全パターン分岐表、フローチャート、ビジネスルール定義、エッジケース対処方針 |
| [`docs/05_LINE会話フローSSOT.md`](docs/05_LINE会話フローSSOT.md) | 旧版SSOT（v1.0）。`docs/07` に置き換え済み |
| [`docs/06_実装タスク一覧.md`](docs/06_実装タスク一覧.md) | 優先順位付き実装タスク（Phase1.3-2.0）、依存関係マップ、推奨実装順序 |
| [`docs/07_diet-bot_LINE_運用フロー_画面要件_SSOT.md`](docs/07_diet-bot_LINE_運用フロー_画面要件_SSOT.md) | **SSOT（正本 v2.0）**: 5状態(S0-S4)遷移図、メッセージ優先順位(①-⑧)、完全入力分岐テーブル(T01-T19, I01-I03, E01-E04)、AI vs 決定論的境界、画像S3ブロック設計、相談プロンプト構成、管理者スコープ |
| [`docs/11_会話解釈SSOT.md`](docs/11_会話解釈SSOT.md) | Phase A 会話解釈エンジン設計: UnifiedIntent スキーマ、プロンプト構成、日付/食事区分解決ルール |
| [`docs/12_記録確認フローSSOT.md`](docs/12_記録確認フローSSOT.md) | Phase B 明確化 + Phase C 保存: pending_clarifications 設計、record-persister 設計、correction_history 連携 |
| [`docs/13_パーソナルメモリSSOT.md`](docs/13_パーソナルメモリSSOT.md) | Layer3 パーソナルメモリ: user_memory_items 設計、抽出プロンプト、UPSERT ルール |
| [`docs/14_技術設計チェックリストSSOT.md`](docs/14_技術設計チェックリストSSOT.md) | 実装前設計チェック21項目: pending運用、相談記録順序、複数記録、削除、メモリ管理、AI フォールバック |
| [`docs/15_実装前確定ルールSSOT.md`](docs/15_実装前確定ルールSSOT.md) | **SSOT（正本）**: **実装前確定12ルール** — 保存ルール(R1-R4)、競合ルール(R5-R7)、訂正ルール(R8-R10)、障害時ルール(R11-R12)。相談と記録の責務境界、confidence閾値、idempotency、pending管理、修正対象特定を明文化 |

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

## 次のステップ

> **詳細**: [`docs/06_実装タスク一覧.md`](docs/06_実装タスク一覧.md) 参照

### 完了済み
- ✅ Phase 1.1: Cloudflareデプロイ、LINE連携不具合修正、admin画面改善
- ✅ Phase 1.2: ナレッジDB接続、食品マスター、個人コンテキスト注入、バグ修正(v1.1.0)
- ✅ SSOT会話フロー定義 (`docs/05_LINE会話フローSSOT.md` → `docs/07` v2.0)
- ✅ Phase 1.4: 会話フロー安定化（v1.2.0）
  - ✅ メッセージ優先順位修正（S3画像確認→招待コード→問診→モード切替→体重→相談→テキスト）
  - ✅ 問診フロー簡素化（常に現在の質問を返す、「続けますか？」除去）
  - ✅ 招待コード再送応答統一（未完了→途中の質問、完了→利用案内）
  - ✅ 画像確認中ブロック強化（S3中は全入力ブロック+画像送信もブロック）
  - ✅ CONSULT_KEYWORDS 暗黙的モード切替統合

### Phase 1.3 — 本番検証（P0: 即時対応）
1. ⬜ E2E実機テスト（全フロー通し確認）
2. ⬜ 本番D1マイグレーション (0011_food_master)
3. ⬜ 本番seed投入 (ナレッジ8件+食品35品目)
4. ⬜ Cron/Queue 本番動作確認

### Phase 1.4 — 会話フロー安定化（✅ 完了）
5. ✅ メッセージ処理優先順位の修正（SSOT §2 準拠）
6. ✅ CONSULT_KEYWORDS をモード自動切替に組み込み
7. ✅ pending_image_confirm中の入力ブロック強化（S3 全入力ブロック）
8. ✅ 招待コード再送時の問診を「途中から」に統一

### Phase 2.1 — 実装前確定ルール明文化（✅ 完了 v2.1.0）
- ✅ docs/15_実装前確定ルールSSOT.md: 12項目を4カテゴリ(保存/競合/訂正/障害)で明文化
- ✅ R1: 相談と記録の責務境界確定（confidence >= 0.8 + canSaveImmediately のみ自動保存）
- ✅ R5: Webhook Idempotency（line_message_id UNIQUE制約 + migration 0016）
- ✅ R6-2,3: モード切替・画像受信時の pending_clarification 自動キャンセル
- ✅ 全定数をintent.tsに集約（CONSULT_SECONDARY_SAVE_THRESHOLD, WEIGHT_MIN/MAX, DATE_LOOKBACK_DAYS 等）

### Phase 2.0 — 機能拡張（P2: 今月）
9. ✅ 画像解析結果 × food_master マッチング統合
   - analyzeMealPhoto: AI food_items → matchFoodItems → DB PFC 優先ブレンド
   - analyzeNutritionLabel: product_name → findFoodByName で補完
   - confirm時: food_match_json カラムに保存
   - Migration 0012: meal_entries に food_match_json 追加
10. ✅ T7: User LIFF Dashboard 完成
   - 記録詳細モーダル（体型データ・PFC分解・food_matchDB照合表示）
   - リッチプロフィールページ（アイコン付き・concern_tagsタグ表示・goal表示）
   - 体重チャートをbulk API（weight-history）で一括取得（N+1解消）
11. ✅ T8: Admin ユーザー詳細画面完成
   - 体重推移チャート（Chart.js）をモーダル概要タブに追加
   - 食事記録・写真・レポートタブの動作確認
12. ✅ T9: Superadmin BOT/ナレッジ設定画面
   - BOT一覧（状態・バージョン・プロンプトエディタ）
   - System Promptエディタ + バージョン管理 + 即時公開
   - ナレッジベース一覧 + ドキュメントビューア
   - BOT↔ナレッジ紐付け表示
   - 新API: bots, bot-versions, knowledge-bases, documents, bot-kb-links
13. ⬜ LINE Rich Menu 設定
14. ⬜ RAG実装（ベクトル検索）
15. ⬜ サブスクリプション・課金管理 (Stripe)
