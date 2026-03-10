# API エンドポイント定義

## 概要
Hono フレームワーク（Cloudflare Workers）で実装。
管理者 API は JWT 認証必須。

---

## 認証

### POST /api/admin/auth/login
管理者ログイン。

**Request**
```json
{ "email": "admin@example.com", "password": "password123" }
```
**Response**
```json
{
  "success": true,
  "data": {
    "token": "eyJ...",
    "user": { "id": "...", "email": "...", "role": "admin", "accountId": "..." }
  }
}
```

### GET /api/me
ログイン中ユーザー情報取得。`Authorization: Bearer <token>` 必須。

---

## LINE Webhook

### POST /api/webhooks/line
LINE からの Webhook 受信。署名検証後、Queue にエンキュー。

**Headers**
- `X-Line-Signature`: HMAC-SHA256 署名

**Response**: `200 OK`（即座に返却）

---

## 管理者 API（全て `Authorization: Bearer <token>` 必須）

### アカウント管理

#### GET /api/admin/accounts
契約アカウント一覧（superadmin のみ）。

#### POST /api/admin/accounts
新規アカウント作成（superadmin のみ）。

#### PATCH /api/admin/accounts/:id/service
アカウントの BOT ON/OFF 切り替え。

**Request**
```json
{ "botEnabled": true, "recordEnabled": true, "consultEnabled": true }
```

---

### ユーザー管理

#### GET /api/admin/users
顧客（LINE ユーザー）一覧取得。

**Query Params**
- `page`: ページ番号（デフォルト 1）
- `limit`: 件数（デフォルト 20、最大 100）
- `active_only`: true/false
- `search`: 名前検索

**Response**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "...",
        "lineUserId": "U...",
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

#### PATCH /api/admin/bots/:id
BOT 設定更新。

#### DELETE /api/admin/bots/:id
BOT 削除。

---

### ナレッジ管理

#### GET /api/admin/knowledge/bases
ナレッジベース一覧。

**Response**
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

#### DELETE /api/admin/knowledge/documents/:docId
ドキュメント削除（Vectorize からも削除）。

---

### ダッシュボード

#### GET /api/admin/dashboard/stats
管理者ダッシュボード統計。

**Response**
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

**Query Params**: `page`, `limit`, `lineUserId`

---

## ユーザー API

ユーザーは LINE アプリから QR コードでダッシュボードへアクセス（マジックリンク）。

### GET /api/user/dashboard
ユーザーダッシュボードデータ取得。

**Query Params**: `line_user_id`, `account_id`

**Response**
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
        "isAiParsed": true
      }
    ],
    "weightTrend14d": [
      { "date": "2026-02-25", "weight": 58.8 },
      { "date": "2026-02-26", "weight": 58.6 }
    ],
    "currentStreak": 7
  }
}
```

### GET /api/user/records
日次ログ一覧（ページネーション）。

**Query Params**: `line_user_id`, `account_id`, `limit`, `offset`

### GET /api/user/records/:date
特定日のログ詳細（食事含む）。

### GET /api/user/progress-photos
進捗写真一覧。

### GET /api/user/weekly-reports
週次レポート一覧。

---

## システムジョブ API（内部 Cron 用）

### POST /api/jobs/daily-reminder
日次リマインダー送信（Cron Trigger から呼び出し）。

**Headers**: `X-Cron-Secret: <CRON_SECRET>`

### POST /api/jobs/weekly-report
週次レポート生成・送信（Cron Trigger から呼び出し）。

**Headers**: `X-Cron-Secret: <CRON_SECRET>`

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
| `FORBIDDEN` | 403 | 権限不足 |
| `NOT_FOUND` | 404 | リソース未存在 |
| `VALIDATION_ERROR` | 400 | バリデーションエラー |
| `INTERNAL_ERROR` | 500 | サーバーエラー |

---

## ヘルスチェック

### GET /health
```json
{ "status": "ok", "timestamp": "2026-03-10T10:00:00Z" }
```

### GET /api/health
```json
{ "status": "ok", "version": "1.0.0", "env": "production" }
```
