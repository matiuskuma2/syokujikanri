# ダイエット支援 BOT サービス — プロジェクト概要

## プロジェクト名
**Diet Bot** (`diet-bot`)

## 目的・ゴール
クリニック／サロン向けに LINE だけで完結する半自動ダイエット支援サービスを提供する。  
スタッフの手作業（スプレッドシート入力 + LINE 手動返信）を BOT に置き換え、  
顧客継続率・LTV 向上・指導品質の標準化を実現する。

---

## 現状 → 理想ワークフロー

| 現状 | 理想（本システム） |
|---|---|
| スタッフが LINE で手動返信 | BOT が自動ヒアリング・記録・アドバイス |
| スプレッドシートに手入力 | D1 DB に自動保存 |
| データがバラバラ | ダッシュボードで一元管理 |
| 分析・販促は手動 | データ蓄積 → 自動分析・素材生成 |

---

## ロール・権限

| ロール | 主な権限 |
|---|---|
| **superadmin** | 契約管理・ユーザー管理・ON/OFF・ナレッジ/BOT 管理・LINE 設定 |
| **admin**（店舗） | 顧客一覧・記録閲覧・会話履歴・BOT 設定閲覧・ダッシュボード |
| **user**（顧客） | LINE で記録送信・相談・個人データ閲覧・推移確認・アドバイス受信 |

ON/OFF は契約単位（admin）とユーザー単位の両方で制御可能。

---

## 技術スタック

### Primary（Cloudflare）
| サービス | 用途 |
|---|---|
| **Workers / Pages** | アプリケーションホスティング・エッジ API |
| **D1 (SQLite)** | メインデータベース |
| **R2** | 画像・メディアストレージ |
| **Queues** | LINE イベント非同期処理 |
| **Cron Triggers** | 日次リマインダー・週次レポート |
| **Vectorize** | ナレッジ RAG ベクトル検索 |
| **Durable Objects** | ステートフルなセッション管理（将来拡張） |

### AI / 外部
| サービス | 用途 |
|---|---|
| **OpenAI GPT-4o / Vision** | テキスト応答・画像解析 |
| **OpenAI Embeddings** (`text-embedding-3-small`) | RAG 用ベクトル生成 |
| **LINE Messaging API** | ユーザー向けインターフェース |

### AWS（将来・条件付き）
高精度 OCR・重バッチ処理・音声/映像 ML が必要な場合のみ追加。

---

## MVP Phase 1 スコープ

1. アカウント管理（superadmin / admin / user）
2. 契約 ON/OFF・ユーザー ON/OFF
3. LINE Webhook 連携
4. 記録モード／相談モード 切り替え
5. 食事記録受付（画像 + テキスト）・基本指標（体重・歩数・睡眠・水分・排便）
6. AI 簡易解析 + 確認メッセージ
7. ナレッジ BOT（RAG）
8. ユーザーダッシュボード（個人ログ閲覧・進捗写真）
9. 管理者ダッシュボード（顧客一覧・詳細・会話閲覧）
10. 会話・記録履歴の永続化

## 将来拡張（Phase 2 以降）
- 高精度食事解析（日本食品辞書・標準成分表との連携）
- デバイス連携（体重計・歩数計）
- 自動課金・OEM 多店舗
- Instagram 自動投稿・販促素材自動生成
- 音声入力フロー
- 医療診断機能

> **食事解析の方針（フェーズ別）**
> - **Phase 1**: OpenAI Vision のみで概算解析（外部 API 不使用）
> - **Phase 2**: 日本食品辞書（日本食品標準成分表等）との連携を検討
> - **Phase 3以降**: 必要に応じて外部食品 DB API を追加
>
> **進捗写真の方針**: 写真送信 → 当日記録に紐付け → ダッシュボード閲覧は **Phase 1 スコープ内**。  
> 比較 UI 強化・週次との紐付け・素材化は Phase 2 で対応。

---

## ドキュメント一覧

| ファイル | 内容 |
|---|---|
| `docs/README.md` | 本ファイル（プロジェクト概要） |
| `docs/ARCHITECTURE.md` | システムアーキテクチャ・データフロー・セキュリティ設計 |
| `docs/DATABASE.md` | DB 設計・テーブル定義・マイグレーション管理（**正本**） |
| `docs/REPOSITORY.md` | Repository 層 SQL 実装仕様（D1 prepared statements）（**正本**） |
| `docs/API.md` | API エンドポイント定義（リクエスト/レスポンス形式）（**正本**） |
| `docs/PROMPTS.md` | OpenAI プロンプト設計（`src/services/ai/prompts.ts` 実装仕様）（**正本**） |
| `docs/BOT_FLOW.md` | BOT フロー・ステップコード・キーワードトリガー定義 |
| `docs/DEPLOYMENT.md` | デプロイ手順（ローカル・本番） |
| `docs/PROJECT_PLAN.md` | フェーズ別実装計画・タスク管理 |
| `docs/IMPLEMENTATION_GUIDE.md` | 実装雛形・コードスニペット・依存関係グラフ（**実装者向け正本**） |

---

## ディレクトリ構造

```
diet-bot/
├── docs/                          # 設計ドキュメント
│   ├── README.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── REPOSITORY.md
│   ├── API.md
│   ├── PROMPTS.md
│   ├── BOT_FLOW.md
│   ├── DEPLOYMENT.md
│   ├── PROJECT_PLAN.md
│   └── IMPLEMENTATION_GUIDE.md
├── migrations/                    # D1 マイグレーション SQL
│   ├── 0001_init_accounts.sql
│   ├── 0002_line_users.sql
│   ├── 0003_conversations.sql
│   ├── 0004_bots_knowledge.sql
│   ├── 0005_profiles_intake.sql
│   ├── 0006_daily_logs.sql
│   └── 0007_images_reports.sql
├── src/
│   ├── index.ts                   # Hono アプリエントリーポイント
│   ├── types/
│   │   ├── env.ts                 # Cloudflare Bindings 型定義
│   │   ├── db.ts                  # DB テーブル型定義
│   │   ├── line.ts                # LINE イベント型定義
│   │   └── api.ts                 # API リクエスト/レスポンス型
│   ├── middleware/
│   │   ├── auth.ts                # JWT 認証ミドルウェア
│   │   ├── rbac.ts                # ロール制御
│   │   └── logger.ts              # ロギング
│   ├── routes/
│   │   ├── line/
│   │   │   ├── webhook.ts         # LINE Webhook 受信
│   │   │   ├── auth.ts            # LINE LIFF トークン認証 & JWT 発行（Phase 1d）
│   │   │   └── consumer.ts        # Queue コンシューマー
│   │   ├── admin/
│   │   │   ├── auth.ts
│   │   │   ├── accounts.ts
│   │   │   ├── users.ts
│   │   │   ├── bots.ts
│   │   │   ├── knowledge.ts
│   │   │   └── dashboard.ts
│   │   └── user/
│   │       ├── me.ts              # /api/users/me/* 全ルート（JWT 認証・Phase 1d）
│   │       ├── files.ts           # /api/files/* 画像プロキシ（R2・Phase 1d）
│   │       ├── dashboard.ts
│   │       ├── records.ts
│   │       ├── progress-photos.ts
│   │       └── weekly-reports.ts
│   ├── bot/
│   │   ├── dispatcher.ts          # モード判定・ディスパッチ
│   │   ├── session.ts             # セッション管理
│   │   ├── record-mode.ts         # 記録モード処理
│   │   ├── consult-mode.ts        # 相談モード処理
│   │   └── intake-flow.ts         # 初回ヒアリングフロー
│   ├── services/
│   │   └── ai/
│   │       ├── prompts.ts         # ★ 全プロンプト定義（統合ファイル）
│   │       ├── client.ts          # OpenAI クライアント
│   │       ├── rag.ts             # RAG 検索・回答生成
│   │       └── embeddings.ts      # ベクトル生成
│   ├── repositories/
│   │   ├── daily-logs-repo.ts     # ★ Phase 1 優先実装
│   │   ├── meal-entries-repo.ts   # ★ Phase 1 優先実装
│   │   ├── body-metrics-repo.ts   # ★ Phase 1 優先実装
│   │   ├── conversations-repo.ts  # ★ Phase 1 優先実装
│   │   ├── image-intake-repo.ts   # ★ Phase 1 優先実装
│   │   ├── progress-photos-repo.ts # ★ Phase 1 優先実装
│   │   ├── knowledge-repo.ts      # ★ Phase 1 優先実装
│   │   ├── accounts-repo.ts       # Phase 1 後半
│   │   ├── line-users-repo.ts     # Phase 1 後半
│   │   ├── bot-sessions-repo.ts   # Phase 1 後半
│   │   ├── weekly-reports-repo.ts # Phase 1 後半
│   │   └── attachments-repo.ts    # ★ Phase 1d（画像配信 API 用）
│   ├── jobs/
│   │   ├── daily-reminder.ts
│   │   ├── weekly-report.ts
│   │   └── image-analysis.ts
│   └── utils/
│       ├── line-api.ts
│       ├── response.ts
│       ├── validator.ts
│       └── date.ts
├── public/
│   └── static/
│       ├── admin.js
│       ├── user.js
│       └── styles.css
├── .dev.vars                      # ローカル環境変数（git 除外）
├── .dev.vars.example
├── .gitignore
├── ecosystem.config.cjs           # PM2 設定
├── package.json
├── tsconfig.json
├── vite.config.ts
└── wrangler.jsonc
```

---

## 公開 URL
- **Production**: （デプロイ後に記載）
- **GitHub**: （設定後に記載）

## デプロイ状況
- **Platform**: Cloudflare Pages + Workers
- **Status**: 🔧 開発中（MVP Phase 1）
- **Tech Stack**: Hono v4 + TypeScript + Cloudflare Workers + OpenAI GPT-4o
- **Last Updated**: 2026-03-10

---

## ドキュメント正本ルール

> 複数ドキュメントで定義が重複している場合は、以下を正本とする。

| 分野 | 正本ファイル | 備考 |
|---|---|---|
| テーブル定義・スキーマ | `docs/DATABASE.md` | 要件定義書には概要のみ残す |
| API エンドポイント | `docs/API.md` | レスポンス形式・エラーコードも本ファイル |
| 実装雛形・コードパターン | `docs/IMPLEMENTATION_GUIDE.md` | フェーズ別優先順も本ファイル |
| プロンプト定義 | `docs/PROMPTS.md` | 型定義・定数名・ビルダー名の基準 |
| 画像カテゴリ定義（正規7種） | `docs/PROMPTS.md` §5 | `meal_photo / nutrition_label / body_scale / food_package / progress_body_photo / other / unknown` |
