# API エンドポイント定義

## 概要
Hono フレームワーク（Cloudflare Workers）で実装。
管理者 API は JWT 認証必須。
ユーザー API はクエリパラメータで `line_user_id` と `account_id` を渡す形式（マジックリンク認証）。

---

## ベースパス・共通ルール

| 項目 | 値 |
|---|---|
| **管理者 API** | `/api/admin/*` |
| **ユーザー API** | `/api/user/*` |
| **LINE Webhook** | `/api/webhooks/line` |
| **システムジョブ** | `/api/jobs/*` |
| **ヘルスチェック** | `/health`, `/api/health` |
| **認証方式（管理者）** | `Authorization: Bearer <JWT>` |
| **認証方式（ユーザー）** | クエリパラメータ `line_user_id` + `account_id` |
| **レスポンス形式** | `{ success: boolean, data?: any, error?: string, message?: string }` |

---

## 認証

### POST /api/admin/auth/login
管理者ログイン。

**Request**
```json
{ "email": "admin@example.com", "password": "password123" }
```
**Response 200**
```json
{
  "success": true,
  "data": {
    "token": "eyJ...",
    "user": {
      "id": "superadmin-001",
      "email": "admin@diet-bot.local",
      "role": "superadmin",
      "accountId": "account-001"
    }
  }
}
```

### GET /api/me
ログイン中ユーザー情報取得。`Authorization: Bearer <token>` 必須。

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "...",
    "email": "...",
    "role": "admin",
    "accountId": "..."
  }
}
```

---

## LINE Webhook

### POST /api/webhooks/line
LINE からの Webhook 受信。署名検証後、Queue にエンキュー。

**Headers**
- `X-Line-Signature`: HMAC-SHA256 署名

**処理フロー**
1. `X-Line-Signature` ヘッダーで署名検証（HMAC-SHA256）
2. `LINE_EVENTS_QUEUE` にイベントをエンキュー
3. 即座に `200 OK` を返す（LINE の 1 秒タイムアウト対策）

**Response**: `200 OK`（即座に返却）
```json
{ "success": true }
```

---

## 管理者 API（全て `Authorization: Bearer <token>` 必須）

### アカウント管理

#### GET /api/admin/accounts
契約アカウント一覧（superadmin のみ）。

**Query Params**: `page`（デフォルト 1）、`limit`（デフォルト 20）

**Response 200**
```json
{
  "success": true,
  "data": {
    "accounts": [
      {
        "id": "...",
        "name": "〇〇クリニック",
        "type": "clinic",
        "status": "active",
        "createdAt": "2026-03-10T00:00:00Z"
      }
    ],
    "total": 5
  }
}
```

#### POST /api/admin/accounts
新規アカウント作成（superadmin のみ）。

**Request**
```json
{ "name": "〇〇クリニック", "type": "clinic" }
```

#### PATCH /api/admin/accounts/:id/service
アカウント単位の BOT ON/OFF 切り替え（superadmin のみ）。

**Request**
```json
{
  "botEnabled": true,
  "recordEnabled": true,
  "consultEnabled": true
}
```

---

### ユーザー管理

#### GET /api/admin/users
顧客（LINE ユーザー）一覧取得。

**Query Params**
| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `page` | number | 1 | ページ番号 |
| `limit` | number | 20 | 件数（最大 100） |
| `active_only` | boolean | false | フォロー中のみ |
| `search` | string | - | 名前検索 |

**Response 200**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "...",
        "lineUserId": "U1234abcd",
        "displayName": "山田花子",
        "pictureUrl": "https://...",
        "followStatus": "following",
        "intakeCompleted": true,
        "lastSeenAt": "2026-03-10T10:00:00Z",
        "latestWeight": 58.2,
        "weightChange7d": -0.3
      }
    ],
    "total": 50,
    "page": 1,
    "limit": 20
  }
}
```

#### GET /api/admin/users/:lineUserId
顧客詳細取得（プロフィール・直近ログ・会話履歴）。

**Response 200**
```json
{
  "success": true,
  "data": {
    "lineUser": { "lineUserId": "U...", "displayName": "..." },
    "profile": {
      "nickname": "はなちゃん",
      "gender": "female",
      "ageRange": "30s",
      "heightCm": 162,
      "currentWeightKg": 58.2,
      "targetWeightKg": 55.0,
      "goalSummary": "3ヶ月で-3kg",
      "activityLevel": "light"
    },
    "recentLogs": [
      {
        "logDate": "2026-03-10",
        "weightKg": 58.2,
        "steps": 8500,
        "completionStatus": "complete"
      }
    ],
    "recentMessages": [
      {
        "senderType": "user",
        "rawText": "今日の体重です",
        "sentAt": "2026-03-10T07:30:00Z"
      }
    ]
  }
}
```

#### PATCH /api/admin/users/:lineUserId/service
ユーザー単位の機能 ON/OFF。

**Request**
```json
{
  "botEnabled": true,
  "recordEnabled": true,
  "consultEnabled": false
}
```

---

### BOT 管理

#### GET /api/admin/bots
BOT 一覧取得。

#### POST /api/admin/bots
新規 BOT 作成。

**Request**
```json
{
  "name": "ダイエット支援BOT",
  "botKey": "diet-bot-main",
  "botType": "diet"
}
```

#### PATCH /api/admin/bots/:id
BOT 設定更新（システムプロンプトのカスタマイズ含む）。

**Request**
```json
{
  "name": "更新BOT名",
  "systemPrompt": "カスタムシステムプロンプト（NULLでデフォルト使用）"
}
```

#### DELETE /api/admin/bots/:id
BOT 削除。

---

### ナレッジ管理

#### GET /api/admin/knowledge/bases
ナレッジベース一覧。

**Response 200**
```json
{
  "success": true,
  "data": {
    "bases": [
      {
        "id": "...",
        "name": "基本ダイエット知識",
        "documentCount": 15,
        "isActive": true,
        "priority": 10
      }
    ]
  }
}
```

#### POST /api/admin/knowledge/bases
ナレッジベース作成。

**Request**
```json
{
  "name": "糖質制限知識ベース",
  "knowledgeType": "diet",
  "description": "糖質制限に関するナレッジ"
}
```

#### GET /api/admin/knowledge/bases/:id/documents
ドキュメント一覧取得。

#### POST /api/admin/knowledge/bases/:id/documents
ドキュメント追加。

**Request**
```json
{
  "title": "糖質制限の基本",
  "content": "糖質制限とは...",
  "sourceType": "manual"
}
```

#### POST /api/admin/knowledge/bases/:id/documents/:docId/index
ドキュメントをチャンク化 → ベクトル化 → Vectorize 登録。

**処理フロー**
1. ドキュメントをチャンクに分割 → `knowledge_chunks` に保存
2. 各チャンクを OpenAI Embeddings でベクトル化
3. Vectorize インデックスに登録 → `knowledge_chunk_embeddings` に保存

#### DELETE /api/admin/knowledge/documents/:docId
ドキュメント削除（Vectorize からも削除）。

---

### ダッシュボード

#### GET /api/admin/dashboard/stats
管理者ダッシュボード統計。

> **Note**: 旧エンドポイント `/api/admin/dashboard/summary` も互換のため維持するが、  
> 新設計では `/api/admin/dashboard/stats` を正式とする。

**Response 200**
```json
{
  "success": true,
  "data": {
    "totalActiveUsers": 42,
    "todayLogCount": 18,
    "weeklyActiveUsers": 35,
    "intakeCompletedCount": 38,
    "recentUsers": [
      {
        "lineUserId": "U...",
        "displayName": "山田花子",
        "latestWeight": 58.2,
        "weightChange": -0.5,
        "lastLogDate": "2026-03-10"
      }
    ]
  }
}
```

#### GET /api/admin/dashboard/conversations
最近の会話一覧。

**Query Params**: `page`、`limit`、`lineUserId`（フィルタ用）

---

## ユーザー API

ユーザーは LINE アプリから QR コード / マジックリンクでダッシュボードへアクセス。  
クエリパラメータ `line_user_id` と `account_id` で識別する。

### GET /api/user/dashboard
ユーザーダッシュボードデータ取得。

**Query Params**: `line_user_id`（必須）、`account_id`（必須）

**Response 200**
```json
{
  "success": true,
  "data": {
    "profile": {
      "nickname": "はなちゃん",
      "currentWeight": 58.2,
      "targetWeight": 55.0,
      "goalSummary": "3ヶ月で-3kg"
    },
    "todayLog": {
      "date": "2026-03-10",
      "weightKg": 58.2,
      "steps": 8500,
      "waterMl": 1200,
      "sleepHours": 7.5,
      "totalCalories": 1650,
      "proteinG": 72.0,
      "fatG": 48.0,
      "carbsG": 210.0
    },
    "todayMeals": [
      {
        "mealType": "breakfast",
        "description": "ご飯・味噌汁・卵焼き",
        "calories": 480,
        "confirmationStatus": "confirmed"
      }
    ],
    "weightTrend14d": [
      { "date": "2026-02-25", "weight": 58.8 },
      { "date": "2026-02-26", "weight": 58.6 }
    ],
    "progressPhotos": [
      {
        "id": "...",
        "photoDate": "2026-03-01",
        "photoType": "progress",
        "storageKey": "progress/U1234/2026-03-01.jpg"
      }
    ],
    "currentStreak": 7
  }
}
```

### GET /api/user/records
日次ログ一覧（ページネーション）。

**Query Params**: `line_user_id`、`account_id`、`limit`（デフォルト 20）、`offset`（デフォルト 0）

### GET /api/user/records/:date
特定日のログ詳細（食事含む）。

**Path Params**: `date`（YYYY-MM-DD）  
**Query Params**: `line_user_id`、`account_id`

### GET /api/user/progress-photos
進捗写真一覧。

**Query Params**: `line_user_id`、`account_id`、`limit`（デフォルト 20）、`offset`（デフォルト 0）

**Response 200**
```json
{
  "success": true,
  "data": {
    "photos": [
      {
        "id": "...",
        "photoDate": "2026-03-01",
        "photoType": "progress",
        "poseLabel": "front",
        "bodyPartLabel": "full_body",
        "note": null
      }
    ],
    "total": 5
  }
}
```

### GET /api/user/weekly-reports
週次レポート一覧。

**Query Params**: `line_user_id`、`account_id`、`limit`（デフォルト 10）

---

## システムジョブ API（内部 Cron 用）

### POST /api/jobs/daily-reminder
日次リマインダー送信（Cron Trigger から呼び出し）。

**Headers**: `X-Cron-Secret: <CRON_SECRET>`

**処理フロー**
1. アクティブユーザー一覧取得
2. 前日のログ未記録ユーザーを抽出
3. パーソナライズされたリマインダーメッセージを LINE 送信

### POST /api/jobs/weekly-report
週次レポート生成・送信（Cron Trigger から呼び出し）。

**Headers**: `X-Cron-Secret: <CRON_SECRET>`

**処理フロー**
1. アクティブユーザー一覧取得
2. 先週（月〜日）のデータ集計
3. `buildWeeklyReportPrompt` で AI サマリー生成
4. `weekly_reports` テーブルに保存
5. LINE で週次レポート送信

---

## ヘルスチェック

### GET /health
```json
{ "status": "ok", "timestamp": "2026-03-10T10:00:00Z" }
```

### GET /api/health
```json
{ "status": "ok", "version": "1.0.0", "env": "development" }
```

---

## エラーレスポンス形式

```json
{
  "success": false,
  "error": "UNAUTHORIZED",
  "message": "認証が必要です"
}
```

| エラーコード | HTTP ステータス | 説明 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未認証・トークン無効 |
| `FORBIDDEN` | 403 | 権限不足（ロール不一致） |
| `NOT_FOUND` | 404 | リソース未存在 |
| `VALIDATION_ERROR` | 400 | バリデーションエラー |
| `INTERNAL_ERROR` | 500 | サーバーエラー |

---

## 未実装エンドポイント（Phase 1 後半）

以下は設計済みだが、Phase 1 後半で実装予定:

| エンドポイント | 説明 |
|---|---|
| `GET /api/admin/knowledge/bases/:id/documents/:docId` | ドキュメント詳細 |
| `PATCH /api/admin/knowledge/documents/:docId` | ドキュメント更新 |
| `GET /api/admin/users/:lineUserId/weekly-reports` | ユーザー週次レポート一覧 |
| `POST /api/user/records/:date/meals` | 食事記録の手動追加 |
| `PATCH /api/user/records/:date/meals/:id` | 食事記録の手動修正 |
