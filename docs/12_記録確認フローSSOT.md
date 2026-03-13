# 記録確認フロー SSOT（Single Source of Truth）

> **最終更新**: 2026-03-13 v1.1  
> **対象**: diet-bot v2.0（設計段階）  
> **前提**: `11_会話解釈SSOT.md` の Phase A 出力（Unified Intent JSON）を入力とする  
> **本ドキュメントが記録確認・明確化・永続化フローの正本**。

---

## 0. 概要

Phase A（会話解釈）で生成された Unified Intent JSON を受け取り、  
不足情報の確認（Phase B）→ DB保存（Phase C）を行うフローを定義する。

**SSOTルール**: 日付 + 区分 + 内容 の3要素が揃わない限り記録を保存しない。

---

## 0.5 保存判定フロー（即時保存 vs 確認 vs 明確化）

```
Unified Intent JSON（Phase A 出力）
  │
  ├─ record_type == 'weight' && weight_kg != null
  │     → **即時保存**（体重は数値さえあればOK）
  │
  ├─ record_type == 'meal' 
  │   && target_date.source ∈ {'explicit', 'inferred'}
  │   && meal_type.source ∈ {'keyword', 'time_expression', 'content_inference'}
  │   && content_summary != null
  │     → **即時保存**
  │
  ├─ record_type == 'meal'
  │   && (target_date.source == 'timestamp' || meal_type.source == 'timestamp')
  │   && content_summary != null
  │     → **確認付き保存**
  │       「今日の夕食として記録しました。修正が必要な場合は教えてください」
  │       ※保存はするが、推定であることを提示
  │
  ├─ needs_clarification ≠ []
  │     → **明確化フロー**（Phase B）
  │       不足フィールドについてユーザーに質問
  │
  └─ intent_primary == 'correct_record'
        → **修正フロー**（§4.5 参照）
```

---

## 1. Phase B: 明確化フロー

### 1.1 フロー全体図

```
Unified Intent JSON（Phase A出力）
  │
  ├── needs_clarification = [] （不足なし）
  │     └── → Phase C へ直行
  │
  └── needs_clarification ≠ [] （不足あり）
        │
        ▼
  ┌───────────────────────────────────────────┐
  │  明確化フロー開始                          │
  │                                            │
  │  1. pending_clarifications テーブルに保存    │
  │     - intent JSON（途中状態）               │
  │     - missing_fields リスト                 │
  │     - 質問送信済みフラグ                    │
  │                                            │
  │  2. bot_mode_sessions を更新                │
  │     - current_step = 'pending_clarification'│
  │     - session_data に clarification_id      │
  │                                            │
  │  3. ユーザーに質問を送信                    │
  │     - 不足フィールドに対応する質問文        │
  │     - Quick Reply で選択肢を提示            │
  │                                            │
  │  4. ユーザーの回答を待つ                    │
  └───────────────────────────────────────────┘
        │
        ▼ （ユーザー回答受信）
  ┌───────────────────────────────────────────┐
  │  回答処理                                  │
  │                                            │
  │  1. pending_clarifications からデータ取得    │
  │  2. 回答を Intent JSON にマージ             │
  │  3. まだ不足あり？                          │
  │     ├── YES → 次の質問を送信               │
  │     └── NO  → Phase C へ                   │
  └───────────────────────────────────────────┘
```

### 1.2 質問テンプレート

| 不足フィールド | 質問文 | Quick Reply |
|--------------|--------|-------------|
| `target_date` | 「いつの記録ですか？」 | [今日] [昨日] [おととい] [日付を入力] |
| `meal_type` | 「何の食事ですか？」 | [朝食] [昼食] [夕食] [間食] [その他] |
| `content` | 「何を食べましたか？（テキストで教えてください）」 | なし（テキスト入力待ち） |
| `weight_value` | 「体重は何kgですか？（数字で教えてください）」 | なし（テキスト入力待ち） |

### 1.3 質問の優先順位

複数フィールドが不足している場合、以下の順番で1つずつ質問する。

| 優先度 | フィールド | 理由 |
|--------|----------|------|
| 1 | `content` | 何を食べたかが最も重要 |
| 2 | `target_date` | 日付が決まらないと保存先が決まらない |
| 3 | `meal_type` | 日付が決まった後に食事区分を確認 |
| 4 | `weight_value` | 体重値の確認 |

**注意**: 1回のメッセージで1つの質問のみ送信する（ユーザー負荷軽減）。

### 1.4 回答のパース処理

```typescript
/**
 * 明確化質問に対するユーザー回答をパースする
 * Quick Reply のテキスト or 自由入力テキストを処理
 */
function parseClarificationAnswer(
  field: ClarificationField,
  answer: string,
  context: { today_jst: string }
): ParseResult {
  switch (field) {
    case 'target_date':
      // Quick Reply: 「今日」「昨日」「おととい」
      // 自由入力: 「3/10」「3月10日」「月曜日」等
      return parseDateAnswer(answer, context.today_jst)

    case 'meal_type':
      // Quick Reply: 「朝食」「昼食」「夕食」「間食」「その他」
      return parseMealTypeAnswer(answer)

    case 'content':
      // 自由テキスト → そのまま meal_description に設定
      return { success: true, value: answer }

    case 'weight_value':
      // 数値パース: 「58」「58.5」「58.5kg」等
      return parseWeightAnswer(answer)
  }
}
```

### 1.5 タイムアウト処理

| 条件 | 動作 |
|------|------|
| 明確化質問後 30分以内に回答なし | 次のメッセージ受信時に「先ほどの記録の確認です。」と再度質問 |
| 明確化質問後 24時間経過 | Cron ジョブで `pending_clarifications` を期限切れ破棄。ユーザーには通知しない |
| 明確化待ち中に別の記録メッセージ | 現在の pending を破棄し、新しい記録を Phase A から処理 |
| 明確化待ち中にモード切替コマンド | 現在の pending を破棄し、モード切替を実行 |

### 1.6 process-line-event.ts への統合

```
handleTextMessageEvent(text)
  │
  │ ① 招待コード検出                    ← 従来通り（変更なし）
  │ ② checkServiceAccess               ← 従来通り
  │ ③ ensureUserAccount + メッセージ保存 ← 従来通り
  │ ④ コマンド判定                       ← 従来通り
  │
  │ ⑤ セッション状態による分岐
  │   ├── step = 'pending_image_confirm'
  │   │     ├── 確定 → handleImageConfirm   ← 従来通り
  │   │     ├── 取消 → handleImageDiscard   ← 従来通り
  │   │     └── other → handleImageCorrection ← 従来通り
  │   │
  │   ├── step = 'pending_clarification'    ★ 新規
  │   │     └── handleClarificationAnswer()
  │   │           → 回答をパース → Intent更新
  │   │           → 不足なし → Phase C
  │   │           → 不足あり → 次の質問
  │   │
  │   ├── mode = 'intake'                   ← 従来通り
  │   │
  │   ├── mode = 'consult'                  ★ 変更
  │   │     └── Phase A: interpretMessage()
  │   │           → intent_secondary あり → Phase B/C で記録
  │   │           → 相談応答も並行して生成
  │   │
  │   └── mode = 'record' (default)         ★ 変更
  │         └── Phase A: interpretMessage()
  │               → Phase B（明確化）→ Phase C（保存）
```

---

## 2. Phase C: 永続化レイヤー

### 2.1 処理フロー

```
Unified Intent JSON（Phase A/B で確定済み）
  │
  ├── intent_primary = 'record_meal'
  │     │
  │     ├── 1. ensureDailyLog(user_account_id, target_date)
  │     │     → daily_logs に INSERT OR IGNORE
  │     │
  │     ├── 2. 同日・同区分の既存 meal_entry を検索
  │     │     ├── 既存あり → 追記/更新するか確認
  │     │     └── 既存なし → 新規作成
  │     │
  │     ├── 3. createMealEntry() or updateMealEntry()
  │     │     - meal_type
  │     │     - meal_text = content_summary
  │     │     - consumed_at = target_date + 推定時刻
  │     │     - calories_kcal, protein_g, fat_g, carbs_g
  │     │       → food_master マッチング（既存ロジック活用）
  │     │     - confirmation_status = 'confirmed'
  │     │
  │     ├── 4. conversation_messages.intent_label を更新
  │     │
  │     └── 5. BOT返信
  │           「📝 {日付}の{食事区分}を記録しました。
  │            {内容} — 推定{cal}kcal
  │            P:{p}g / F:{f}g / C:{c}g」
  │
  ├── intent_primary = 'record_weight'
  │     │
  │     ├── 1. バリデーション: weight_kg が 20-300 の範囲
  │     ├── 2. ensureDailyLog(user_account_id, target_date)
  │     ├── 3. upsertBodyMetrics(daily_log_id, weight_kg)
  │     └── 4. BOT返信
  │           「📝 {日付}の体重 {weight}kg を記録しました。」
  │
  ├── intent_primary = 'correct_record'
  │     │
  │     ├── 1. correction_target から対象レコードを検索
  │     │     → meal_entries or body_metrics
  │     ├── 2. レコードが見つからない場合
  │     │     → 「記録が見つかりませんでした」
  │     ├── 3. 修正内容を適用
  │     │     → UPDATE 対象テーブル
  │     ├── 4. correction_history に修正履歴を記録
  │     ├── 5. 栄養値の再計算（content_change の場合）
  │     └── 6. BOT返信
  │           「✏️ {日付}の{区分}を修正しました。
  │            {変更前} → {変更後}」
  │
  └── intent_primary = 'delete_record'
        │
        ├── 1. 対象レコードを検索
        ├── 2. 削除確認（Quick Reply: はい/いいえ）
        ├── 3. 確認後 DELETE
        ├── 4. correction_history に削除履歴を記録
        └── 5. BOT返信
              「🗑 {日付}の{区分}の記録を削除しました。」
```

### 2.2 日次集計の再計算

記録の追加・修正・削除後、対象日の集計を再計算する。

```typescript
/**
 * 日次集計を再計算する
 * meal_entries の合計を daily_logs に反映
 */
async function recalculateDailySummary(
  db: D1Database,
  dailyLogId: string
): Promise<void> {
  const result = await db.prepare(`
    SELECT 
      COUNT(*) as meal_count,
      SUM(calories_kcal) as total_calories,
      SUM(protein_g) as total_protein,
      SUM(fat_g) as total_fat,
      SUM(carbs_g) as total_carbs
    FROM meal_entries 
    WHERE daily_log_id = ?
  `).bind(dailyLogId).first()

  await db.prepare(`
    UPDATE daily_logs 
    SET notes = ?,
        completion_status = CASE 
          WHEN ? >= 3 THEN 'complete'
          ELSE 'partial'
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    JSON.stringify(result),
    result?.meal_count ?? 0,
    dailyLogId
  ).run()
}
```

### 2.3 BOT返信テンプレート

#### 食事記録完了

```
📝 {日付}の{食事区分}を記録しました！

🍽 {内容}
🔥 推定カロリー: {cal} kcal
💪 P: {p}g / F: {f}g / C: {c}g
📊 食品DB照合: {match_count}/{total_count}品マッチ

※修正が必要な場合はテキストで教えてください
  例: 「鮭じゃなくて卵焼き」「夕食じゃなくて朝食」
```

#### 体重記録完了

```
📝 {日付}の体重を記録しました！

⚖️ {weight} kg
{前回比: +0.5kg / -0.5kg / 変化なし}

写真をもっと送ると、1日の栄養バランスが見えてきます 📊
```

#### 修正完了

```
✏️ 記録を修正しました！

📅 {日付}の{食事区分}
変更前: {old_value}
変更後: {new_value}
```

#### 明確化質問

```
🤔 いくつか確認させてください。

{質問文}
```

---

## 3. pending_clarifications テーブル設計

### 3.1 DDL

```sql
CREATE TABLE pending_clarifications (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),
  client_account_id TEXT NOT NULL REFERENCES accounts(id),

  -- Phase A の途中結果
  intent_json       TEXT NOT NULL,           -- Unified Intent JSON
  original_message  TEXT NOT NULL,           -- 元のユーザーメッセージ
  message_id        TEXT REFERENCES conversation_messages(id),

  -- 明確化状態
  missing_fields    TEXT NOT NULL,           -- JSON配列: ["target_date", "meal_type"]
  current_field     TEXT NOT NULL,           -- 現在質問中のフィールド
  answers_json      TEXT NOT NULL DEFAULT '{}',  -- 回答済みの値: {"target_date":"2026-03-12"}

  -- ステータス
  status            TEXT NOT NULL DEFAULT 'asking',  -- 'asking' | 'answered' | 'expired' | 'cancelled'
  ask_count         INTEGER NOT NULL DEFAULT 0,      -- 質問回数（同一フィールドの再質問含む）

  -- タイムスタンプ
  expires_at        TEXT NOT NULL,           -- 24時間後
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pending_clarifications_user 
  ON pending_clarifications(user_account_id, status);
CREATE INDEX idx_pending_clarifications_expires 
  ON pending_clarifications(expires_at) WHERE status = 'asking';
```

### 3.2 ライフサイクル

```
┌──────────┐   質問送信   ┌──────────┐   回答受信   ┌──────────┐
│  created  │ ──────────→ │  asking   │ ──────────→ │ answered  │
└──────────┘              └──────────┘              └──────────┘
                               │                        │
                               │ 24h経過               Phase C 保存成功
                               ▼                        ▼
                          ┌──────────┐            ┌──────────┐
                          │ expired   │            │ (削除)    │
                          └──────────┘            └──────────┘
                               │
                          ※ 別の記録メッセージ受信
                               ▼
                          ┌──────────┐
                          │ cancelled │
                          └──────────┘
```

---

## 4. correction_history テーブル設計

### 4.1 DDL

```sql
CREATE TABLE correction_history (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),

  -- 修正対象
  target_table      TEXT NOT NULL,           -- 'meal_entries' | 'body_metrics' | 'daily_logs'
  target_record_id  TEXT NOT NULL,           -- 修正対象のレコードID
  
  -- 修正内容
  correction_type   TEXT NOT NULL,           -- 'meal_type_change' | 'content_change' | 'date_change' | 'nutrition_change' | 'delete'
  old_value_json    TEXT NOT NULL,           -- 修正前の値 (JSON)
  new_value_json    TEXT,                    -- 修正後の値 (JSON)、deleteの場合はnull
  
  -- メタデータ
  triggered_by      TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'system' | 'admin'
  message_id        TEXT REFERENCES conversation_messages(id),
  reason            TEXT,                    -- 修正理由（ユーザーの元メッセージ等）
  
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_correction_history_user 
  ON correction_history(user_account_id, created_at);
CREATE INDEX idx_correction_history_target 
  ON correction_history(target_table, target_record_id);
```

### 4.2 記録例

```json
// 食事区分の修正
{
  "id": "CH_001",
  "user_account_id": "UA_xyz",
  "target_table": "meal_entries",
  "target_record_id": "ME_123",
  "correction_type": "meal_type_change",
  "old_value_json": "{\"meal_type\": \"dinner\"}",
  "new_value_json": "{\"meal_type\": \"breakfast\"}",
  "triggered_by": "user",
  "message_id": "CM_456",
  "reason": "昨日登録した夕食の写真、朝食の間違いだった"
}

// 内容の修正
{
  "id": "CH_002",
  "user_account_id": "UA_xyz",
  "target_table": "meal_entries",
  "target_record_id": "ME_124",
  "correction_type": "content_change",
  "old_value_json": "{\"meal_text\": \"鮭の塩焼き\", \"calories_kcal\": 200}",
  "new_value_json": "{\"meal_text\": \"卵焼き\", \"calories_kcal\": 150}",
  "triggered_by": "user",
  "message_id": "CM_457",
  "reason": "鮭じゃなくて卵焼き"
}
```

---

## 4.5 修正ターゲット特定フロー

### 4.5.1 検索優先順位（SSOT）

```
correction_target 受信
  │
  ├─ ①  session.current_step == 'pending_image_confirm'
  │       → 画像確認中のエントリを修正対象とする
  │       → proposed_action_json を更新
  │
  ├─ ②  pending_clarifications WHERE status='asking'
  │       → 明確化待ちの intent_json を修正対象とする
  │       → intent_json を更新
  │
  ├─ ③  correction_target に target_date + target_meal_type あり
  │       → meal_entries WHERE 
  │           daily_log.user_account_id = ?
  │           AND daily_log.log_date = target_date
  │           AND meal_type = target_meal_type
  │         ORDER BY updated_at DESC LIMIT 1
  │
  ├─ ④  correction_target に target_date のみ（meal_type なし）
  │       → 同日の全 meal_entries を候補として取得
  │       → 1件 → そのまま修正
  │       → 2件以上 → ユーザーに選択を求める
  │
  └─ ⑤  correction_target が不完全（date も不明）
          → 24時間以内の meal_entries を検索
          → 内容テキストマッチ（「鮭」を含むエントリ等）
          → 1件 → 修正確認
          → 2件以上 → 候補提示
          → 0件 → 「記録が見つかりませんでした」
```

### 4.5.2 候補提示テンプレート

```
🤔 どの記録を修正しますか？

1️⃣ 3/12 夕食 — ラーメン・餃子
2️⃣ 3/12 昼食 — カレーライス
3️⃣ 3/11 夕食 — 鮭の塩焼き・味噌汁

番号で教えてください。
```

### 4.5.3 削除の確認

削除（correction_type='delete'）の場合は常に確認を求める:

```
🗑 以下の記録を削除しますか？

📅 3/12 夕食
📝 ラーメン・餃子
🔥 推定 850 kcal

[はい] [いいえ]
```

---

## 5. Phase B/C の統合シーケンス図

### 5.1 不足なし → 即時保存

```
ユーザー                    BOT                         DB
  │                          │                           │
  │  「昨日の昼にラーメン」   │                           │
  │ ──────────────────────→  │                           │
  │                          │  Phase A: interpret        │
  │                          │  → needs_clarification=[]  │
  │                          │                           │
  │                          │  Phase C: persist          │
  │                          │  ──────────────────────→  │
  │                          │  daily_logs UPSERT         │
  │                          │  meal_entries INSERT        │
  │                          │  ←──────────────────────  │
  │                          │                           │
  │  ← 「📝 3/12の昼食…」    │                           │
  │                          │                           │
```

### 5.2 不足あり → 明確化 → 保存

```
ユーザー                    BOT                         DB
  │                          │                           │
  │  「カレー食べた」         │                           │
  │ ──────────────────────→  │                           │
  │                          │  Phase A: interpret        │
  │                          │  → needs_clarification     │
  │                          │    = ['meal_type']         │
  │                          │  (日付はtimestampで推定済) │
  │                          │                           │
  │                          │  pending_clarifications    │
  │                          │  ──────────────────────→  │
  │                          │  INSERT                    │
  │                          │  ←──────────────────────  │
  │                          │                           │
  │  ← 「🤔 何の食事ですか？」│                           │
  │     [朝食][昼食][夕食]    │                           │
  │     [間食][その他]         │                           │
  │                          │                           │
  │  「夕食」                 │                           │
  │ ──────────────────────→  │                           │
  │                          │  handleClarificationAnswer │
  │                          │  → meal_type = 'dinner'   │
  │                          │  → needs_clarification=[] │
  │                          │                           │
  │                          │  Phase C: persist          │
  │                          │  ──────────────────────→  │
  │                          │  daily_logs UPSERT         │
  │                          │  meal_entries INSERT        │
  │                          │  pending_clarifications    │
  │                          │    DELETE                   │
  │                          │  ←──────────────────────  │
  │                          │                           │
  │  ← 「📝 今日の夕食…」    │                           │
  │                          │                           │
```

### 5.3 修正フロー

```
ユーザー                    BOT                         DB
  │                          │                           │
  │  「昨日の夕食を朝食に    │                           │
  │   直して」               │                           │
  │ ──────────────────────→  │                           │
  │                          │  Phase A: interpret        │
  │                          │  → intent = correct_record │
  │                          │  → correction_target       │
  │                          │                           │
  │                          │  対象レコード検索          │
  │                          │  ──────────────────────→  │
  │                          │  SELECT meal_entries       │
  │                          │  WHERE date='3/12'         │
  │                          │    AND meal_type='dinner'  │
  │                          │  ←──────────────────────  │
  │                          │                           │
  │                          │  レコード発見              │
  │                          │  UPDATE meal_type          │
  │                          │  ──────────────────────→  │
  │                          │  meal_entries UPDATE        │
  │                          │  correction_history INSERT  │
  │                          │  ←──────────────────────  │
  │                          │                           │
  │  ← 「✏️ 修正しました     │                           │
  │   3/12の夕食→朝食」      │                           │
  │                          │                           │
```

---

## 6. エッジケース対応

### 6.0 明確化待ち中の新規記録メッセージ

| 状況 | 動作 |
|------|------|
| pending_clarification あり + 新しい食事報告テキスト | 現在の pending を `cancelled` にし、新しいメッセージを Phase A から処理 |
| pending_clarification あり + 新しい体重テキスト | 現在の pending を `cancelled` にし、体重を即時保存 |
| pending_clarification のユーザー上限 | 1ユーザー1件まで（新規作成時に既存の asking を cancelled に） |

### 6.1 同日・同区分の重複記録

| 状況 | 動作 |
|------|------|
| 同日・同区分に既存記録あり + 新しい食事内容 | 既存に追記（meal_text を結合、栄養値を合算） |
| 同日・同区分に既存記録あり + 同じ食事内容 | 「既に記録済みです。上書きしますか？」と確認 |
| 同日に異なる区分の記録 | 別の meal_entry として新規作成（問題なし） |

### 6.2 日付の矛盾

| 状況 | 動作 |
|------|------|
| 未来日付を指定 | 「未来の日付は記録できません。正しい日付を教えてください。」 |
| 30日以上前の日付 | 「30日以上前の記録は登録できません。」 |
| 曖昧な日付（「この前」等） | needs_clarification に target_date を追加 |

### 6.3 相談モードでの記録検出（G9対応）

| 状況 | 確信度 | 動作 |
|------|--------|------|
| 相談中に「昨日58kgだった」 | 高（≥0.8） | 相談応答を返しつつ、体重を**即時記録**。「📝 体重58kgも記録しました」を末尾に付加 |
| 相談中に「昼にサラダ食べた」 | 高（≥0.8） | 相談応答を返しつつ、食事を**即時記録** |
| 相談中に「カレー食べた」 | 低（<0.8） | 相談応答を返す。「🤔 カレーを今日の夕食として記録しますか？」と確認 |
| 相談中に「朝ご飯食べてない」 | — | 記録としては扱わない（「食べていない」は記録対象外） |
| 相談中に複数の記録情報 | — | 主要な1件のみ intent_secondary で処理。他は無視 |

**相談モードの返信順序**:
1. 相談応答を生成（従来通り）
2. intent_secondary の記録処理（Phase C）
3. 返信を結合:
   - 高確信度: 「{相談回答}\n\n📝 {記録内容}を記録しました」
   - 低確信度: 「{相談回答}\n\n🤔 {記録内容}を記録しますか？」+ Quick Reply

### 6.4 画像確認中の明確化

| 状況 | 動作 |
|------|------|
| 画像確認待ち中に「昨日の夕食」 | 画像の日付・区分を更新して再提示 |
| 画像確認待ち中に「これは間食」 | 画像の食事区分を snack に更新して再提示 |
| 画像確認待ち中に別の食事テキスト | 画像の pending を維持しつつ、テキストを先に処理するか確認 |

---

## 7. Cron ジョブとの連携

### 7.1 期限切れ pending_clarifications のクリーンアップ

```sql
-- 毎時0分に実行（既存の cleanup ジョブに追加）
UPDATE pending_clarifications
SET status = 'expired',
    updated_at = datetime('now')
WHERE status = 'asking'
  AND expires_at < datetime('now');
```

### 7.2 日次リマインダーとの連携

日次リマインダー（21:00 JST）送信時に、当日の記録状況を考慮する。

```
記録状況チェック:
  ├── 朝食・昼食・夕食すべて記録あり → 「今日も完璧です！」
  ├── 一部未記録 → 「{未記録区分}の記録がまだです。写真やテキストで送ってください」
  └── 記録なし → 「今日の食事をまだ記録していませんね。遅くても大丈夫です」
```

---

## 8. 実装ファイルマッピング

| コンポーネント | ファイルパス | 主な関数 |
|-------------|------------|---------|
| 明確化ハンドラ | `src/services/line/clarification-handler.ts` | handleClarificationAnswer, sendClarificationQuestion, parseClarificationAnswer |
| 記録永続化 | `src/services/line/record-persister.ts` | persistRecord, persistMealRecord, persistWeightRecord, persistCorrection |
| 修正ハンドラ | `src/services/line/correction-handler.ts` | handleCorrection, findTargetRecord, applyCorrection |
| 日次集計 | `src/services/line/daily-summary.ts` | recalculateDailySummary |
| Repository | `src/repositories/pending-clarifications-repo.ts` | createPendingClarification, findActiveClarification, updateClarification, expirePendingClarifications |
| Repository | `src/repositories/correction-history-repo.ts` | createCorrectionHistory, findCorrectionsByUser |

---

## 9. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。Phase B（明確化フロー）、Phase C（永続化レイヤー）、pending_clarifications / correction_history テーブル設計、シーケンス図、エッジケース対応、BOT返信テンプレートを文書化 |
| 2026-03-13 | v1.1 | 保存判定フロー新設（§0.5: 即時保存/確認付き保存/明確化の3分岐）。修正ターゲット特定フロー新設（§4.5: 5段階検索優先順位、候補提示、削除確認）。相談モード記録検出を確信度ベースに拡張（§6.3: 高/低確信度分岐、返信順序定義）。明確化待ち中の新規記録対応（§6.0: ユーザー上限、cancelled遷移）。複数記録情報のハンドリング追加 |
