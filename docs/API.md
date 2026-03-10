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

---

## LINE ユーザー認証 API

LINE ユーザー向けの認証フロー。LIFF (LINE Front-end Framework) 上で動作する PWA/Web アプリから呼び出す。  
管理者 JWT とは独立した、LINE ユーザー専用の JWT を発行する。

### POST /api/auth/line

LIFF の `liff.getAccessToken()` で取得した LINE Access Token を検証し、ユーザー専用 JWT を発行する。

**Request**
```json
{ "lineAccessToken": "eyJ..." }
```

**処理フロー**
1. `lineAccessToken` を LINE Profile API (`GET https://api.line.me/v2/profile`) で検証
2. `{ userId, displayName, pictureUrl }` を取得
3. `line_users` テーブルから `userId` で `user_account_id` を逆引き
4. ユーザーが未登録（`line_users` に存在しない）の場合は `404` を返す
5. `signJwt({ sub: userAccountId, role: 'user', accountId: clientAccountId, exp: 24h })` で JWT を発行

**Response 200**
```json
{
  "success": true,
  "data": {
    "token": "eyJ...",
    "userAccountId": "ua-xxxx"
  }
}
```

**エラーレスポンス**

| コード | HTTP | 説明 |
|---|---|---|
| `INVALID_LINE_TOKEN` | 401 | LINE Access Token が無効または期限切れ |
| `USER_NOT_REGISTERED` | 404 | LINE 友達追加済みだが `line_users` に存在しない |

---

## ユーザー認証付き API（`/api/users/me`）

> **認証方式**: `Authorization: Bearer <JWT>`  
> JWT は `POST /api/auth/line` で発行したユーザー専用トークン。  
> `jwt.sub` = `user_account_id`（`user_accounts.id`）。  
> `jwt.role` = `'user'`。

### JWT ペイロード構造

```typescript
type JwtPayload = {
  sub:       string  // user_accounts.id（userAccountId）
  role:      'superadmin' | 'admin' | 'staff' | 'user'
  accountId: string  // user の場合: user_accounts.client_account_id
                     // admin の場合: account_memberships.account_id
  iat:       number
  exp:       number
}
```

### ルーティング概要

| メソッド | パス | 説明 | 実装ファイル |
|---|---|---|---|
| `GET` | `/api/users/me` | 自分の基本情報 | `src/routes/user/me.ts` |
| `GET` | `/api/users/me/dashboard` | ダッシュボードデータ | `src/routes/user/me.ts` |
| `GET` | `/api/users/me/progress` | 進捗写真一覧 | `src/routes/user/me.ts` |
| `GET` | `/api/users/me/records` | 日次記録一覧 | `src/routes/user/me.ts` |
| `GET` | `/api/users/me/records/:date` | 特定日の詳細 | `src/routes/user/me.ts` |
| `GET` | `/api/users/me/weekly-reports` | 週次レポート一覧 | `src/routes/user/me.ts` |

---

### GET /api/users/me

ログイン中ユーザーの基本情報を返す。`Authorization: Bearer <JWT>` 必須。

**Response 200**
```json
{
  "success": true,
  "data": {
    "userAccountId": "ua-xxxx",
    "displayName": "山田花子",
    "pictureUrl": "https://profile.line-scdn.net/...",
    "profile": {
      "nickname": "はなちゃん",
      "gender": "female",
      "ageRange": "30s",
      "heightCm": 162,
      "currentWeightKg": 58.2,
      "targetWeightKg": 55.0,
      "goalSummary": "3ヶ月で-3kg",
      "activityLevel": "light"
    }
  }
}
```

**RBAC**: `role = 'user'` かつ `jwt.sub === userAccountId` のみ許可（他人の情報は取得不可）。

---

### GET /api/users/me/dashboard

ユーザーダッシュボード表示に必要なデータを一括返却する。

**Response 200**
```json
{
  "success": true,
  "data": {
    "profile": {
      "nickname": "はなちゃん",
      "currentWeightKg": 58.2,
      "targetWeightKg": 55.0,
      "goalSummary": "3ヶ月で-3kg"
    },
    "recentDailyLogs": [
      {
        "id": "dl-xxxx",
        "logDate": "2026-03-10",
        "completionStatus": "complete",
        "weightKg": 58.2,
        "waistCm": null,
        "stepsCount": 8500,
        "sleepHours": 7.5,
        "waterBucketLabel": "1l",
        "bowelStatus": "normal"
      }
    ],
    "weeklyReports": [
      {
        "id": "wr-xxxx",
        "weekStart": "2026-03-03",
        "weekEnd": "2026-03-09",
        "summaryText": "今週は全体的に体重が安定していました...",
        "totalCalories": 11200,
        "avgWeight": 58.5
      }
    ],
    "latestProgressPhoto": {
      "id": "ma-xxxx",
      "photoDate": "2026-03-08",
      "photoType": "progress",
      "poseLabel": "front",
      "bodyPartLabel": "full_body",
      "fileUrl": "/api/files/progress/ma-xxxx"
    }
  }
}
```

**依存 Repository**
- `listRecentDailyLogsSummary(db, userAccountId, 7)` — `dashboard-repo.ts`
- `listWeeklyReportsByUser(db, userAccountId, 4)` — `weekly-reports-repo.ts`
- `getLatestProgressPhotoByUser(db, userAccountId)` — `dashboard-repo.ts`

---

### GET /api/users/me/progress

進捗写真の一覧を返す（最新順）。

**Query Params**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `limit` | number | 20 | 件数（最大 50） |
| `offset` | number | 0 | オフセット |

**Response 200**
```json
{
  "success": true,
  "data": {
    "photos": [
      {
        "id": "ma-xxxx",
        "photoDate": "2026-03-08",
        "photoType": "progress",
        "poseLabel": "front",
        "bodyPartLabel": "full_body",
        "note": null,
        "fileUrl": "/api/files/progress/ma-xxxx"
      }
    ],
    "total": 5
  }
}
```

> **注意**: `fileUrl` は Workers プロキシ経由の URL。クライアントは `Authorization: Bearer <JWT>` を付与してアクセスする（`<img>` タグでは Fetch API + Object URL に変換して使用）。

---

### GET /api/users/me/records

日次記録の一覧を返す（最新順）。

**Query Params**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `limit` | number | 20 | 件数（最大 50） |
| `offset` | number | 0 | オフセット |

**Response 200**
```json
{
  "success": true,
  "data": {
    "records": [
      {
        "logDate": "2026-03-10",
        "completionStatus": "complete",
        "weightKg": 58.2,
        "stepsCount": 8500,
        "sleepHours": 7.5,
        "waterBucketLabel": "1l",
        "mealCount": 3
      }
    ],
    "total": 30
  }
}
```

---

### GET /api/users/me/records/:date

特定日の詳細（食事含む）。

**Path Params**: `date`（YYYY-MM-DD）

**Response 200**
```json
{
  "success": true,
  "data": {
    "logDate": "2026-03-10",
    "completionStatus": "complete",
    "weightKg": 58.2,
    "stepsCount": 8500,
    "sleepHours": 7.5,
    "waterBucketLabel": "1l",
    "bowelStatus": "normal",
    "aiFeedback": "今日の記録を確認しました。たんぱく質が少し不足しています...",
    "meals": [
      {
        "id": "me-xxxx",
        "mealType": "breakfast",
        "mealText": "ご飯・味噌汁・卵焼き",
        "caloriesKcal": 480,
        "proteinG": 20,
        "fatG": 12,
        "carbsG": 65,
        "confirmationStatus": "confirmed",
        "imageFileUrl": "/api/files/meals/ma-yyyy"
      }
    ]
  }
}
```

---

### GET /api/users/me/weekly-reports

週次レポート一覧（最新順）。

**Query Params**: `limit`（デフォルト 10）

**Response 200**
```json
{
  "success": true,
  "data": {
    "reports": [
      {
        "id": "wr-xxxx",
        "weekStart": "2026-03-03",
        "weekEnd": "2026-03-09",
        "summaryText": "今週は全体的に体重が安定していました...",
        "totalCalories": 11200,
        "avgWeight": 58.5,
        "avgSteps": 7800,
        "recordDays": 6
      }
    ]
  }
}
```

---

## ファイル配信 API（`/api/files`）

R2 に保存された画像ファイルを認証済みユーザーに配信する。  
R2 のパブリック URL を直接公開せず、Workers 経由でプロキシすることでアクセス制御を行う。

> **認証方式**: `Authorization: Bearer <JWT>`（ユーザー専用トークン）  
> 所有者チェック: `conversation_threads.user_account_id === jwt.sub`  
> ファイルは `message_attachments` テーブルで管理し、`storage_key` で R2 オブジェクトを参照する。

### エンドポイント一覧

| メソッド | パス | 説明 | 実装ファイル |
|---|---|---|---|
| `GET` | `/api/files/progress/:attachmentId` | 進捗写真を配信 | `src/routes/user/files.ts` |
| `GET` | `/api/files/meals/:attachmentId` | 食事写真を配信 | `src/routes/user/files.ts` |
| `GET` | `/api/files/progress/:attachmentId/signed-url` | 署名付き URL を取得（将来対応） | `src/routes/user/files.ts` |

---

### GET /api/files/progress/:attachmentId

進捗写真（`progress_photos` 紐付き）を R2 から取得してレスポンスボディで返す。

**Path Params**: `attachmentId`（`message_attachments.id`）  
**Headers**: `Authorization: Bearer <JWT>`

**処理フロー**
1. `getMessageAttachmentById(db, attachmentId)` → `message_attachments` レコード取得
2. `getThreadByAttachmentId(db, attachmentId)` → `conversation_threads` レコード取得
3. 所有者チェック: `thread.user_account_id !== jwt.sub` の場合 `403` を返す
4. `env.R2.get(attachment.storage_key)` → R2 オブジェクト取得
5. `Content-Type: attachment.content_type`（デフォルト: `image/jpeg`）でレスポンス
6. `Cache-Control: private, max-age=300` を設定

**Response 200**  
`Content-Type: image/jpeg`（または `image/png`、`image/webp`）  
Body: バイナリ画像データ

**エラーレスポンス**

| コード | HTTP | 説明 |
|---|---|---|
| `UNAUTHORIZED` | 401 | JWT なし・無効 |
| `FORBIDDEN` | 403 | 他人のファイルへのアクセス |
| `NOT_FOUND` | 404 | `message_attachments` に存在しない / R2 にファイルなし |

---

### GET /api/files/meals/:attachmentId

食事写真（`meal_entries.image_key` 紐付き）を R2 から取得してレスポンスボディで返す。

**Path Params**: `attachmentId`（`message_attachments.id`）  
**Headers**: `Authorization: Bearer <JWT>`

処理フローは `GET /api/files/progress/:attachmentId` と同一。  
`meal_entries.image_key` = `message_attachments.storage_key` として紐付く。

---

### GET /api/files/progress/:attachmentId/signed-url

> **ステータス**: Phase 2 対応予定（現時点では未実装）

R2 署名付き URL（TTL: 60 秒）を生成して返す。フロントエンドが `<img src>` に直接使用できる。

**Response 200**
```json
{
  "success": true,
  "data": {
    "url": "https://r2.your-bucket.example.com/progress/ua-xxxx/2026-03-08.jpg?X-Amz-Expires=60&...",
    "expiresAt": "2026-03-10T10:01:00Z"
  }
}
```

---

### ファイル配信に関する設計メモ

#### R2 ストレージキーの命名規則

| 種別 | R2 キーパターン | 例 |
|---|---|---|
| 進捗写真 | `progress/{userAccountId}/{YYYY-MM-DD}-{uuid}.jpg` | `progress/ua-xxxx/2026-03-08-abcd.jpg` |
| 食事写真 | `meals/{userAccountId}/{YYYY-MM-DD}-{mealType}-{uuid}.jpg` | `meals/ua-xxxx/2026-03-10-breakfast-efgh.jpg` |
| 画像解析ジョブ入力 | `intake/{userAccountId}/{attachmentId}.jpg` | `intake/ua-xxxx/ma-ijkl.jpg` |

#### フロントエンドでの画像表示方法

Bearer トークンを `<img src>` タグで使用できないため、Fetch API + Object URL に変換して使用する:

```javascript
// /api/files/progress/:id を Fetch して Blob URL に変換
async function loadImage(attachmentId, token) {
  const res = await fetch(`/api/files/progress/${attachmentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error('file load failed')
  const blob = await res.blob()
  return URL.createObjectURL(blob)  // <img src> に設定
}
```

#### 依存 Repository

| Repository 関数 | テーブル | 説明 |
|---|---|---|
| `getMessageAttachmentById(db, id)` | `message_attachments` | `storage_key`, `content_type` を取得 |
| `getThreadByAttachmentId(db, attachmentId)` | `conversation_threads` | `user_account_id` を取得（所有者チェック用） |

SQL は `IMPLEMENTATION_GUIDE.md` セクション 20-B を参照。
