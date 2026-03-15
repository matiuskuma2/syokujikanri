# diet-bot アーキテクチャ V2 設計書

**ステータス: 承認済み（2026-03-15）**
**正本**: この文書がアーキテクチャの正本。実装はこの文書に従う。

---

## 0. 固定事項（実装前に確定）

| # | 項目 | 決定 | 理由 |
|---|---|---|---|
| 1 | **Queue Consumer の実体** | 別 Worker (`diet-bot-worker`) | Pages は consumer を持てない。既に Queue + DLQ が存在するため Queue + Consumer Worker が自然 |
| 2 | **直列化単位** | `user_account_id` | LINE 再連携・将来の接続経路追加に強い。line_user_id ではなく user_account_id を正本キーとする |
| 3 | **状態の正本** | `conversation_runtime_state` テーブル | 既存の bot_mode_sessions, pending_clarifications は「履歴・補助」に降格。runtime_state のみを参照して分岐する |
| 4 | **送信責務** | Consumer Worker から `push` のみ | Webhook では reply も返さない（200 のみ）。reply と push の混在を完全排除 |

---

## 1. 現行アーキテクチャの問題

### 1.1 致命的な構造欠陥

| # | 問題 | 影響 |
|---|---|---|
| 1 | **Webhook で全処理を同期実行** | AI判定(5-15s) + AI応答(5-15s) + DB更新 = 30s超→Worker強制終了→無応答 |
| 2 | **reply と push が場当たりで混在** | replyToken期限切れ、push失敗、フォールバック漏れ→無応答 |
| 3 | **状態が5箇所に分散** | mode_sessions, thread.current_mode, pending_image_confirm, pending_clarification, intake_step → race condition |
| 4 | **連投に弱い** | 「相談する」→ テキスト → 画像 を素早く送ると、並列 Worker が状態を壊す |
| 5 | **パッチの累積** | 10回以上の「止血」修正で、process-line-event.ts が 2200行超。見通し不能 |

### 1.2 Cloudflare Pages 制約

- **Worker 実行時間**: 30秒（Free）/ 50秒（Paid）→ OpenAI 2回呼び出しで超過
- **Queue Consumer**: Pages Functions では **不可**。Producer のみ
- **Cron Triggers**: Pages Functions では **不可**
- **Durable Objects**: Pages Functions から **利用可能**（バインディング対応）

### 1.3 既存インフラ資産（活用可能）

- `diet-bot-line-events` Queue: 作成済み、Producer 1台接続、Consumer 0台
- `diet-bot-line-events-dlq` DLQ: 作成済み
- `LINE_EVENTS_QUEUE` バインディング: wrangler.jsonc に定義済み
- `LineWebhookQueueMessage` 型: bindings.ts に定義済み

---

## 2. 新アーキテクチャ概要

```
┌─────────┐     ┌───────────────────────────┐     ┌──────────────────────┐
│  LINE   │────▶│  Pages Function (webhook) │────▶│  Cloudflare Queue    │
│  Server │     │  - 署名検証               │     │  diet-bot-line-events│
└─────────┘     │  - incoming_events 保存   │     └──────────┬───────────┘
                │  - Queue 投入             │                │
                │  - 200 返却（reply なし） │     ┌──────────▼───────────┐
                └───────────────────────────┘     │  Worker (consumer)   │
                                                  │  diet-bot-worker     │
                ┌───────────────────────────┐     │  - 冪等性チェック    │
                │  Pages Function (API/UI)  │     │  - state ロード      │
                │  - 管理画面              │     │  - AI判定(classifier)│
                │  - LIFF                  │     │  - AI応答(responder) │
                │  - REST API              │     │  - DB更新            │
                │  - debug-state 可視化    │     │  - outbox 書込       │
                └───────────────────────────┘     │  - push 送信         │
                                                  └──────────────────────┘
```

### 2.1 責務分離

| コンポーネント | 責務 | 実行時間目標 |
|---|---|---|
| **Pages Function (webhook)** | 署名検証 → incoming_events 保存 → queue投入 → 200 | **<1秒** |
| **Worker (consumer)** | 冪等性チェック → state → AI → DB → outbox → push | **<25秒** |
| **Pages Function (API/UI)** | 管理画面、LIFF、REST API（変更なし） | N/A |

### 2.2 送信ルールの統一（固定事項 #4）

| 場面 | 方法 | 内容 |
|---|---|---|
| Webhook | **reply なし** | 200 を返すのみ。一切の reply/push をしない |
| AI 処理結果 | Consumer から `push` **のみ** | 全ての実質応答（相談回答、修正結果、記録確認、エラー通知） |
| push 失敗時 | outbox に `failed` 記録 → Queue retry | 最大3回再試行。3回失敗で DLQ 行き |

**replyToken は一切使わない。** reply と push を混在させない。

---

## 3. 詳細設計

### 3.1 新規テーブル

#### A. incoming_events（冪等性保証 — §追記A）

```sql
CREATE TABLE IF NOT EXISTS incoming_events (
  id               TEXT PRIMARY KEY,                  -- UUID
  line_message_id  TEXT NOT NULL,                     -- LINE のメッセージ ID（冪等性キー）
  event_type       TEXT NOT NULL,                     -- 'message' | 'follow' | 'unfollow'
  event_json       TEXT NOT NULL,                     -- raw JSON
  received_at      TEXT NOT NULL,                     -- webhook 受信時刻
  processed_at     TEXT DEFAULT NULL,                 -- consumer 処理完了時刻（null = 未処理）
  process_result   TEXT DEFAULT NULL,                 -- 'success' | 'failed' | 'skipped'
  UNIQUE(line_message_id)
);
CREATE INDEX IF NOT EXISTS idx_incoming_events_unprocessed
  ON incoming_events(processed_at) WHERE processed_at IS NULL;
```

#### B. conversation_runtime_state（状態の正本 — 固定事項 #3）

```sql
CREATE TABLE IF NOT EXISTS conversation_runtime_state (
  user_account_id    TEXT PRIMARY KEY,                 -- 直列化単位（固定事項 #2）
  line_user_id       TEXT NOT NULL,
  client_account_id  TEXT NOT NULL,

  -- 状態（正本）
  current_mode       TEXT NOT NULL DEFAULT 'record',   -- 'record' | 'consult' | 'intake'
  waiting_type       TEXT DEFAULT NULL,                 -- null | 'image_confirm' | 'clarification' | 'intake_step'
  waiting_target_id  TEXT DEFAULT NULL,                 -- pending 対象の ID
  waiting_expires_at TEXT DEFAULT NULL,                 -- ISO8601。期限切れ → null に自動リセット

  -- 冪等性
  last_processed_message_id TEXT DEFAULT NULL,
  last_processed_at         TEXT DEFAULT NULL,

  -- 楽観的ロック
  version            INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(line_user_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_state_client
  ON conversation_runtime_state(client_account_id);
```

#### C. outbox_messages（Outbox パターン — §追記B）

```sql
CREATE TABLE IF NOT EXISTS outbox_messages (
  id                TEXT PRIMARY KEY,                  -- UUID
  user_account_id   TEXT NOT NULL,
  line_user_id      TEXT NOT NULL,
  message_type      TEXT NOT NULL DEFAULT 'text',      -- 'text' | 'quick_reply' | 'flex'
  message_json      TEXT NOT NULL,                     -- push 送信するメッセージ内容
  quick_reply_json  TEXT DEFAULT NULL,                 -- quick reply ボタン定義（JSON）
  status            TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'sent' | 'failed'
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TEXT DEFAULT NULL,
  error_detail      TEXT DEFAULT NULL,
  source_event_id   TEXT DEFAULT NULL,                 -- incoming_events.id への参照
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_messages(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user
  ON outbox_messages(user_account_id);
```

### 3.2 Webhook Handler（Pages Function）

```typescript
// 新しい webhook handler（全体で <1秒）
export async function handleWebhook(c: Context) {
  const env = c.env
  const body = await c.req.text()
  const signature = c.req.header('x-line-signature') ?? ''

  // 1. 署名検証
  if (!verifySignature(body, signature, env.LINE_CHANNEL_SECRET)) {
    return c.json({ error: 'invalid signature' }, 401)
  }

  const parsed = JSON.parse(body)
  const events = parsed.events ?? []

  // 2. イベントごとに保存 + Queue投入
  for (const event of events) {
    const messageId = event.message?.id ?? event.webhookEventId ?? crypto.randomUUID()

    // 2a. incoming_events に保存（冪等性: UNIQUE(line_message_id)）
    try {
      await env.DB.prepare(`
        INSERT INTO incoming_events (id, line_message_id, event_type, event_json, received_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).bind(
        crypto.randomUUID(),
        messageId,
        event.type,
        JSON.stringify(event),
        new Date().toISOString()
      ).run()
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        console.log(`[Webhook] duplicate event ${messageId}, skipping`)
        continue  // 重複はスキップ
      }
      console.error(`[Webhook] saveRawEvent error:`, err)
    }

    // 2b. Queue に投入
    await env.LINE_EVENTS_QUEUE.send({
      type: 'webhook_event',
      accountId: env.CLIENT_ACCOUNT_ID,
      channelId: env.LINE_CHANNEL_ID,
      event,
      receivedAt: new Date().toISOString(),
    })
  }

  // 3. 即 200（reply なし — 固定事項 #4）
  return c.json({ status: 'ok' })
}
```

**Webhook は以下を一切やらない**:
- AI 呼び出し
- reply / push 送信
- 状態変更
- 複雑な分岐

### 3.3 Consumer Worker 処理フロー

```
Queue Message 到着
        │
        ▼
┌─ 1. 冪等性チェック ──────────────────────────────┐
│  incoming_events.processed_at が非null → skip    │
│  runtime_state.last_processed_message_id と一致  │
│  → skip                                         │
└──────────────────────┬───────────────────────────┘
                       │
        ▼
┌─ 2. runtime_state ロード ────────────────────────┐
│  user_account_id で SELECT                       │
│  未存在 → 新規作成（mode=record, waiting=null）  │
│  version を取得（楽観的ロック用）                 │
└──────────────────────┬───────────────────────────┘
                       │
        ▼
┌─ 3. State Machine ルーティング ──────────────────┐
│  waiting_type に応じてハンドラー選択             │
│  (§3.4 状態遷移表 参照)                         │
└──────────────────────┬───────────────────────────┘
                       │
        ▼
┌─ 4. ハンドラー実行 ─────────────────────────────┐
│  AI 判定 (classifier, gpt-4o-mini, <8秒)        │
│  AI 応答生成 (responder, gpt-4o, <15秒) ※必要時│
│  DB 更新（meal_entries, body_metrics 等）        │
└──────────────────────┬───────────────────────────┘
                       │
        ▼
┌─ 5. outbox + state 更新（1トランザクション）────┐
│  outbox_messages INSERT (status='pending')       │
│  runtime_state UPDATE (version+1)                │
│  incoming_events UPDATE (processed_at=now)        │
└──────────────────────┬───────────────────────────┘
                       │
        ▼
┌─ 6. push 送信 ──────────────────────────────────┐
│  outbox から pending を取得                      │
│  LINE push API 呼び出し                          │
│  成功 → status='sent'                           │
│  失敗 → status='failed', error_detail 記録      │
│         Queue retry で再実行                     │
└──────────────────────────────────────────────────┘
```

### 3.4 状態遷移表（正本 — §追記C）

#### 状態一覧

| state | current_mode | waiting_type | 説明 |
|---|---|---|---|
| **S0_IDLE_RECORD** | record | null | 記録モード・待機中 |
| **S1_IDLE_CONSULT** | consult | null | 相談モード・待機中 |
| **S2_IMAGE_CONFIRM** | record | image_confirm | 画像解析結果の確認待ち |
| **S3_CLARIFICATION** | record | clarification | 不足項目の追加質問中 |
| **S4_INTAKE** | intake | intake_step | 初回問診の進行中 |

#### 遷移表

| 現在 state | 入力 | 処理 | 次の state | outbox 応答 | キャンセル条件 |
|---|---|---|---|---|---|
| **S0** | テキスト（食事記録） | classifier→record_meal | S0 or S3 | 記録結果 or 質問 | — |
| **S0** | テキスト（体重） | classifier→record_weight | S0 | 記録結果 | — |
| **S0** | テキスト（相談意図） | classifier→consult | **S1** | 相談応答 | — |
| **S0** | テキスト（モード切替） | keyword match | **S1** | モード変更通知 | — |
| **S0** | 画像 | 画像解析→結果push | **S2** | 解析結果＋確認ボタン | — |
| **S1** | テキスト（相談） | responder | S1 | AI相談回答 | — |
| **S1** | テキスト（記録意図） | classifier→record | **S0** | 記録結果 | — |
| **S1** | テキスト（モード切替） | keyword match | **S0** | モード変更通知 | — |
| **S1** | 画像 | 画像解析→結果push | **S2** | 解析結果＋確認ボタン | — |
| **S2** | 「確定」 | apply + 記録保存 | **S0** | 保存完了 | — |
| **S2** | 「取消」 | discard | **S0** | 取消完了 | — |
| **S2** | 修正テキスト | AI修正→更新 | **S2** | 修正結果＋確認ボタン | — |
| **S2** | 日付変更テキスト | AI抽出→更新 | **S2** | 日付変更結果＋確認ボタン | — |
| **S2** | 無関係テキスト | — | **S2** | リマインドpush | 30分経過→自動 S0 |
| **S2** | 新規画像 | 前の confirm を破棄→新解析 | **S2** | 新解析結果 | 前の pending 自動キャンセル |
| **S3** | 回答テキスト | 解析→不足チェック | **S0** or **S3** | 記録結果 or 次の質問 | 5分無応答→ S0 |
| **S4** | 回答テキスト | 次の問診ステップ | **S4** or **S0** | 次の質問 or 完了通知 | 30分無応答→ S0 |
| **any** | follow | ユーザー初期化 | **S4** or **S0** | ウェルカム or 問診開始 | — |
| **any** | unfollow | 状態クリア | — | — | — |

#### 期限切れ自動リセット

| waiting_type | 期限 | リセット先 |
|---|---|---|
| image_confirm | 30分 | S0（waiting=null） |
| clarification | 5分 | S0（waiting=null） |
| intake_step | 30分 | S0（waiting=null） |

Consumer は処理開始時に `waiting_expires_at` をチェックし、期限切れなら自動で waiting=null にリセットする。

### 3.5 AI 呼び出し分離

| 役割 | モデル | タイムアウト | maxTokens | 用途 |
|---|---|---|---|---|
| **Classifier** | gpt-4o-mini | 8秒 | 500 | 意図判定、テキスト分類、修正分類 |
| **Responder** | gpt-4o | 15秒 | 300 | 相談応答、食事修正解析 |

Consumer Worker 内の合計処理時間バジェット:
- Classifier: 最大 8秒
- DB 操作: 最大 3秒
- Responder: 最大 15秒
- Outbox + Push: 最大 2秒
- **合計: 最大 28秒** → Worker 30秒制限内 ✅

### 3.6 冪等性設計（§追記A）

| レイヤー | 冪等性キー | 防止対象 |
|---|---|---|
| Webhook → incoming_events | `line_message_id` UNIQUE | 同一 webhook の再送 |
| Queue → Consumer | `incoming_events.processed_at IS NULL` チェック | Queue の再配信 |
| Consumer → outbox | `source_event_id` + 処理結果チェック | Consumer の二重実行 |

### 3.7 Outbox パターン（§追記B）

処理フローの step 5 で、**DB更新と送信を分離**する。

```
NG（現行）: DB更新 → push送信 → 片方だけ失敗して不整合
OK（V2）:  DB更新 + outbox INSERT （1トランザクション）→ outbox から push 実行
```

- 「保存されたが送信されない」→ outbox に pending が残る → 再実行で送信される
- 「送信されたが保存されない」→ 起きない（先に保存するため）
- 「送信失敗」→ outbox.status = 'failed' → Queue retry で再実行

---

## 4. プロジェクト構造

```
/home/user/webapp/
├── src/                              # Pages Function（既存・webhook 書き換え）
│   ├── index.ts                      # Hono エントリ
│   ├── routes/line/webhook.ts        # ★ 書き換え: 保存 + queue + 200 のみ
│   ├── routes/admin/                 # 管理画面（変更なし）
│   ├── routes/user/                  # LIFF（変更なし）
│   ├── repositories/                 # DB操作（Pages/Worker 共有）
│   ├── services/ai/                  # OpenAI（Worker から参照）
│   └── types/                        # 型定義（共有）
├── worker/                           # Consumer Worker（新規）
│   ├── src/
│   │   ├── index.ts                  # Worker エントリ（queue handler）
│   │   ├── dispatcher.ts             # メッセージタイプ振り分け
│   │   ├── handlers/
│   │   │   ├── text-handler.ts       # テキスト処理
│   │   │   ├── image-handler.ts      # 画像解析
│   │   │   ├── confirm-handler.ts    # 確定/取消/修正/日付変更
│   │   │   └── follow-handler.ts     # フォロー/アンフォロー
│   │   ├── state/
│   │   │   └── runtime-state.ts      # conversation_runtime_state CRUD
│   │   ├── ai/
│   │   │   ├── classifier.ts         # 意図分類（gpt-4o-mini）
│   │   │   └── responder.ts          # 応答生成（gpt-4o）
│   │   └── send/
│   │       └── push-sender.ts        # outbox → LINE push（統一）
│   ├── wrangler.jsonc                # Consumer Worker 設定
│   ├── tsconfig.json
│   └── package.json
├── migrations/
│   └── XXXX_v2_tables.sql            # incoming_events + runtime_state + outbox
├── wrangler.jsonc                    # Pages 設定（既存）
└── docs/
    └── ARCHITECTURE_V2.md            # この文書
```

### 4.1 Consumer Worker wrangler.jsonc

```jsonc
{
  "name": "diet-bot-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-10",
  "compatibility_flags": ["nodejs_compat"],

  "queues": {
    "consumers": [
      {
        "queue": "diet-bot-line-events",
        "max_batch_size": 1,
        "max_batch_timeout": 0,
        "max_retries": 3,
        "dead_letter_queue": "diet-bot-line-events-dlq",
        "retry_delay": "5"
      }
    ]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "diet-bot-production",
      "database_id": "72e33989-d529-4a07-b907-d883c3e85614"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "diet-bot-media"
    }
  ]
}
```

---

## 5. Pages ↔ Worker のバインディング共有

| リソース | Pages | Worker | 備考 |
|---|---|---|---|
| D1 (DB) | ✅ | ✅ | 同じ database_id |
| R2 (media) | ✅ | ✅ | 同じ bucket_name |
| Queue Producer | ✅ | — | Pages → Queue |
| Queue Consumer | — | ✅ | Queue → Worker |
| LINE_CHANNEL_ACCESS_TOKEN | ✅ | ✅ | Worker にも secret 設定必要 |
| OPENAI_API_KEY | ✅ | ✅ | 両方で必要（Pagesは管理画面、Workerは処理） |

Worker の secret は `wrangler secret put` で設定:
```bash
cd worker && npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
cd worker && npx wrangler secret put OPENAI_API_KEY
cd worker && npx wrangler secret put LINE_CHANNEL_SECRET
# ... 他の secret も同様
```

---

## 6. 正本と補助の関係

| テーブル | V2 での役割 | 備考 |
|---|---|---|
| **conversation_runtime_state** | **正本** | Consumer が参照する唯一の状態源 |
| bot_mode_sessions | 補助（履歴） | V2 移行後は書き込みのみ。読み取りは runtime_state |
| pending_clarifications | 補助（詳細データ） | runtime_state.waiting_type='clarification' の詳細 |
| image_intake_results | 補助（詳細データ） | runtime_state.waiting_type='image_confirm' の詳細 |
| conversation_threads | 補助（会話履歴） | current_mode は runtime_state が正本 |
| **incoming_events** | **正本**（受信記録） | 冪等性の唯一のソース |
| **outbox_messages** | **正本**（送信記録） | 送信状態の唯一のソース |

---

## 7. 実装順序

| Step | 内容 | 完了条件 |
|---|---|---|
| 1 | マイグレーション作成・適用（incoming_events, runtime_state, outbox_messages） | テーブル作成成功 |
| 2 | Webhook 書き換え（保存 + Queue投入 + 200） | webhook が 200 を <1秒で返す |
| 3 | Consumer Worker 作成（state machine + dispatcher + handlers） | Queue からメッセージを受信して処理できる |
| 4 | outbox → push 送信の実装 | outbox に書いた内容が LINE に push される |
| 5 | admin に debug-state / outbox / failure 可視化 | 管理画面で状態を確認できる |
| 6 | **固定シナリオ 10本の実機テスト** | **全10本 PASS** |

---

## 8. 完了条件（§追記D）

**「ビルド成功」「デプロイ成功」は完了条件ではない。**

### 実機完了条件

| # | シナリオ | 完了条件 |
|---|---|---|
| 1 | 「記録する」タップ | push で「記録モードです」が届く |
| 2 | 「相談する」タップ | push で「相談モードです」が届く |
| 3 | 相談テキスト送信 | push で AI 回答が届く |
| 4 | 食事テキスト送信（例: 朝食 トースト） | push で記録確認が届く |
| 5 | 体重テキスト送信（例: 58.5kg） | push で記録確認が届く |
| 6 | 食事写真送信 | push で解析結果 + 確認ボタンが届く |
| 7 | 画像修正テキスト送信（例: 卵とハム） | push で修正結果 + 確認ボタンが届く |
| 8 | 画像日付変更テキスト送信（例: 昨日の夕食） | push で変更結果 + 確認ボタンが届く |
| 9 | 「確定」送信 | push で保存完了通知が届く |
| 10 | 「取消」送信 | push で取消完了通知が届く |

**全10本 PASS = V2 完了。1本でも FAIL = 修正して再テスト。**

補助確認:
- incoming_events に全メッセージが記録されている
- outbox_messages に全送信が記録されている
- conversation_runtime_state が正しい状態になっている
- DLQ にメッセージが溜まっていない

---

## 9. リスクと対策

| リスク | 対策 |
|---|---|
| Queue 遅延（通常 <1秒、最大数秒） | ユーザー体感は「数秒で返答」。許容範囲 |
| Consumer Worker デプロイ忘れ | デプロイスクリプトで Pages + Worker を同時実行 |
| D1 同時アクセス競合 | `max_batch_size: 1` + version による楽観的ロック |
| Consumer 障害 | DLQ + retry で自動復旧 |
| gpt-4o-mini の分類精度 | ログ監視。精度不足なら判定ルール強化で補完 |
| outbox 滞留 | admin 画面で pending/failed を可視化。アラート設定 |
