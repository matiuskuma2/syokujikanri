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
| **Durable Objects** | ステートフルなセッション管理（将来拡張） |

### AI / 外部
| サービス | 用途 |
|---|---|
| **OpenAI GPT-4o / Vision** | テキスト応答・画像解析 |
| **OpenAI Embeddings** | RAG 用ベクトル生成 |
| **Cloudflare Vectorize** | ベクトル検索（ナレッジ RAG） |
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
8. ユーザーダッシュボード（個人ログ閲覧）
9. 管理者ダッシュボード（顧客一覧・詳細・会話閲覧）
10. 会話・記録履歴の永続化

## 将来拡張（スコープ外）
- 高精度食事画像 API（FatSecret 等）
- デバイス連携（体重計・歩数計）
- 自動課金・OEM 多店舗
- Instagram 自動投稿・販促素材自動生成
- 音声入力フロー
- 医療診断機能

---

## ディレクトリ構造

```
diet-bot/
├── docs/                          # 設計ドキュメント（本ファイル等）
│   ├── README.md                  # 本ファイル
│   ├── ARCHITECTURE.md            # システムアーキテクチャ
│   ├── DATABASE.md                # DB 設計・テーブル定義
│   ├── API.md                     # API エンドポイント定義
│   ├── PROMPTS.md                 # OpenAI プロンプト設計
│   ├── BOT_FLOW.md                # BOT フロー・ステップコード定義
│   └── DEPLOYMENT.md             # デプロイ手順
├── migrations/                    # D1 マイグレーション SQL
│   ├── 0001_accounts.sql
│   ├── 0002_line.sql
│   ├── 0003_bot.sql
│   ├── 0004_knowledge.sql
│   ├── 0005_user_data.sql
│   └── 0006_reports.sql
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
│   │   │   └── consumer.ts        # Queue コンシューマー
│   │   ├── admin/
│   │   │   ├── auth.ts            # 管理者認証
│   │   │   ├── accounts.ts        # 契約・アカウント管理
│   │   │   ├── users.ts           # ユーザー管理
│   │   │   ├── bot.ts             # BOT 設定
│   │   │   ├── knowledge.ts       # ナレッジ管理
│   │   │   └── dashboard.ts       # ダッシュボード
│   │   └── user/
│   │       ├── auth.ts            # ユーザー認証
│   │       ├── profile.ts         # プロフィール
│   │       ├── records.ts         # ログ記録
│   │       └── dashboard.ts       # ユーザーダッシュボード
│   ├── bot/
│   │   ├── dispatcher.ts          # モード判定・ディスパッチ
│   │   ├── session.ts             # セッション管理
│   │   ├── record-mode.ts         # 記録モード処理
│   │   ├── consult-mode.ts        # 相談モード処理
│   │   └── intake-flow.ts         # 初回ヒアリングフロー
│   ├── ai/
│   │   ├── client.ts              # OpenAI クライアント
│   │   ├── prompts/
│   │   │   ├── consult.ts         # 相談モードプロンプト
│   │   │   ├── daily-feedback.ts  # 日次フィードバックプロンプト
│   │   │   ├── weekly-report.ts   # 週次レポートプロンプト
│   │   │   ├── image-classify.ts  # 画像分類プロンプト
│   │   │   ├── meal-analysis.ts   # 食事画像解析プロンプト
│   │   │   ├── label-analysis.ts  # 栄養ラベル解析プロンプト
│   │   │   └── scale-analysis.ts  # 体重計画像解析プロンプト
│   │   ├── rag.ts                 # RAG 検索・回答生成
│   │   └── embeddings.ts          # ベクトル生成
│   ├── repository/
│   │   ├── accounts.ts            # アカウント CRUD
│   │   ├── line-users.ts          # LINE ユーザー CRUD
│   │   ├── conversations.ts       # 会話スレッド/メッセージ CRUD
│   │   ├── bot-sessions.ts        # BOT セッション CRUD
│   │   ├── daily-logs.ts          # 日次ログ CRUD
│   │   ├── meal-entries.ts        # 食事記録 CRUD
│   │   ├── image-intake.ts        # 画像解析結果 CRUD
│   │   ├── progress-photos.ts     # 進捗写真 CRUD
│   │   ├── knowledge.ts           # ナレッジ CRUD
│   │   └── weekly-reports.ts      # 週次レポート CRUD
│   ├── jobs/
│   │   ├── daily-reminder.ts      # 日次リマインダー（Cron）
│   │   ├── weekly-report.ts       # 週次レポート生成（Cron）
│   │   └── image-analysis.ts      # 画像解析ジョブ（Queue）
│   └── utils/
│       ├── line-api.ts            # LINE API ヘルパー
│       ├── response.ts            # API レスポンスヘルパー
│       ├── validator.ts           # バリデーション
│       └── date.ts                # 日付ユーティリティ
├── public/
│   └── static/
│       ├── admin.js               # 管理者ダッシュボード JS
│       ├── user.js                # ユーザー PWA JS
│       └── styles.css             # 共通スタイル
├── .dev.vars                      # ローカル環境変数（git 除外）
├── .dev.vars.example              # 環境変数サンプル
├── .gitignore
├── ecosystem.config.cjs           # PM2 設定
├── package.json
├── tsconfig.json
├── vite.config.ts
└── wrangler.jsonc                 # Cloudflare 設定
```

---

## 公開 URL
- **Production**: （デプロイ後に記載）
- **GitHub**: （設定後に記載）

## デプロイ状況
- **Platform**: Cloudflare Pages + Workers
- **Status**: 🔧 開発中（MVP Phase 1）
- **Last Updated**: 2026-03-10
