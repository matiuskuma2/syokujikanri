# 実装前確定ルール SSOT — 12項目

> **正本**: 本文書がルール確定の唯一の正本  
> **最終更新**: 2026-03-13  
> **前提**: docs/14_技術設計チェックリストSSOT.md の設計決定を踏まえた上での、コード実装に直結する運用ルール  
> **対象ファイル**: intent.ts / process-line-event.ts / record-persister.ts / clarification-handler.ts / interpretation.ts / memory-extraction.ts

---

## 概要

Phase A(AI解釈) → Phase B(明確化) → Phase C(保存) → Layer3(メモリ) の設計は固定済み。
本文書は、この設計パイプラインの**判定ロジック・閾値・境界条件**を12項目で明文化し、
技術負債と運用インシデントを未然に防ぐ。

### 4つのルールカテゴリ

| カテゴリ | 項目 | リスク |
|----------|------|--------|
| **A. 保存ルール** | R1〜R4 | 誤保存・保存漏れ・ユーザー不信 |
| **B. 競合ルール** | R5〜R7 | 多重送信・pending暴走・レースコンディション |
| **C. 訂正ルール** | R8〜R10 | 修正対象の誤特定・データ不整合 |
| **D. 障害時ルール** | R11〜R12 | AI障害時のサービス停止・データロスト |

---

## A. 保存ルール

### R1. 「相談」と「記録」の責務境界

> **最大の技術負債**: 相談中に記録情報が含まれた場合の振る舞いが曖昧

#### 確定ルール

| 条件 | 動作 | 理由 |
|------|------|------|
| 記録モードでのテキスト | Phase A → B → C パイプラインで処理 | 記録が本来の責務 |
| 相談モードでのテキスト | Phase A で副次意図(intent_secondary)を検出。**confidence >= 0.8 かつ canSaveImmediately(intent) == true の場合のみ自動保存** | 相談の邪魔をしない |
| 相談モードで confidence < 0.8 | **保存しない**。相談応答のみ返す | 確信度不足で誤保存するリスク回避 |
| 相談モードで canSaveImmediately == false | **保存しない**。Phase B(明確化)は開始しない | 相談中に「いつの食事ですか？」と聞くのはUX崩壊 |

#### コード上の実装箇所

```typescript
// process-line-event.ts: handleConsultText 内
if (intent.intent_secondary &&
    (intent.intent_secondary === 'record_meal' || intent.intent_secondary === 'record_weight') &&
    intent.confidence >= 0.8) {          // ← R1: 閾値 0.8
  const recordIntent = { ...intent, intent_primary: intent.intent_secondary }
  if (canSaveImmediately(recordIntent)) { // ← R1: 即時保存可能な場合のみ
    // 保存実行
  }
  // canSaveImmediately == false → 何もしない（Phase B は起動しない）
}
```

#### 定数定義

```typescript
// intent.ts に追加
export const CONSULT_SECONDARY_SAVE_THRESHOLD = 0.8
```

---

### R2. 即時保存(canSaveImmediately)の判定基準

| 記録種別 | 必須条件 | 保存先 |
|----------|----------|--------|
| `record_weight` | `weight_kg` != null かつ 20 <= weight_kg <= 300 | body_metrics |
| `record_meal` | ① target_date.resolved != null かつ source が `explicit` or `inferred`<br>② meal_type.value != null かつ source が `explicit_keyword`, `time_expression`, `content_inference` のいずれか<br>③ content_summary が非空 | meal_entries |

**重要**: `source == 'timestamp'` は即時保存の条件を満たさない。→ R3 へ。

#### コード上の実装箇所

```typescript
// intent.ts: canSaveImmediately()
// 現在の実装で正しい。変更不要。
```

---

### R3. 確認付き保存(canSaveWithConfirmation)の判定基準

| 条件 | 動作 |
|------|------|
| intent_primary == `record_meal` かつ needs_clarification == [] かつ content_summary が非空 | 保存を実行 |
| target_date.source == `timestamp` | 保存後に「⏰ 日付は送信時刻から推定しました」を付記 |
| meal_type.source == `timestamp` | 保存後に「⏰ 食事区分は送信時刻から推定しました」を付記 |

**ポイント**: 「確認付き保存」は**保存してから確認**であり、**確認してから保存**ではない。
これにより UX はスムーズだが、誤りがあった場合は「訂正フロー」(R8〜R10)で対処する。

#### コード上の実装箇所

```typescript
// intent.ts: canSaveWithConfirmation()
// process-line-event.ts: handleRecordText 内の canSaveWithConfirmation ブランチ
// 現在の実装で正しい。変更不要。
```

---

### R4. 保存結果の返信テンプレート

| 種別 | テンプレート | Quick Reply |
|------|-------------|-------------|
| 食事記録（即時） | `📝 {日付}の{食事区分}を記録しました！\n🍽 {内容}` | [📝 続けて記録] [💬 相談する] |
| 食事記録（確認付き） | 上記 + `\n⏰ {推定元}は送信時刻から推定しました。違う場合は「昨日」などと教えてください。` | [📝 続けて記録] [💬 相談する] |
| 体重記録 | `📝 {日付}の体重を記録しました！\n⚖️ {体重}kg{前回比}` | [📝 続けて記録] [💬 相談する] |
| 修正完了 | `✏️ 記録を修正しました！\n📅 {日付}\n変更前: {旧値}\n変更後: {新値}` | [📝 続けて記録] [💬 相談する] |
| 削除完了 | `🗑 {日付}の{食事区分}の記録を削除しました。` | [📝 続けて記録] [💬 相談する] |
| 保存失敗 | `⚠️ 記録の保存中にエラーが発生しました。もう一度お試しください。` | なし |

---

## B. 競合ルール

### R5. 多重送信(Webhook Idempotency)

> **リスク**: LINE が同じメッセージの webhook を複数回送信する場合がある

#### 確定ルール

| # | ルール | 実装方法 |
|---|--------|----------|
| R5-1 | 同一 `line_message_id` の webhook は**2回目以降を無視** | conversation_messages テーブルの line_message_id で UNIQUE チェック。INSERT 失敗時は処理スキップ |
| R5-2 | webhook レスポンスは常に **200 OK** | LINE は 200 以外を受け取ると再送する。エラーでも 200 を返す |
| R5-3 | replyToken は**1回だけ使用可能** | 2回目の reply はサイレントに失敗する。push を使う |

#### コード上の実装箇所（要追加）

```typescript
// process-line-event.ts: handleTextMessageEvent 内のメッセージ保存時
// createConversationMessage で line_message_id の UNIQUE 制約違反を検出
// → 既に処理済みとして return

// ※現状: line_message_id は UNIQUE 制約がない → マイグレーション追加が必要
```

#### 必要なマイグレーション

```sql
-- migrations/0016_idempotency.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_messages_line_msg_id
  ON conversation_messages(line_message_id)
  WHERE line_message_id IS NOT NULL;
```

---

### R6. Pending Clarification の競合管理

| # | シナリオ | 動作 | 理由 |
|---|----------|------|------|
| R6-1 | 明確化質問中に**新しい記録テキスト**が来た | 既存 pending を `cancelled`。新テキストを Phase A から処理 | ユーザーの最新意図を優先 |
| R6-2 | 明確化質問中に**モード切替コマンド**が来た | 既存 pending を `cancelled`。モード切替を実行 | 明示的なユーザー意思 |
| R6-3 | 明確化質問中に**画像**が来た | 既存 pending を `cancelled`。画像処理を実行 | 画像は新しい記録行為 |
| R6-4 | pending が `asking` のまま 24時間経過 | Cron で `expired` に更新 | 放置 pending のクリーンアップ |
| R6-5 | Phase C 完了後の `answered` レコード | **物理削除**（deleteClarification） | DB 肥大化防止 |
| R6-6 | `expired` / `cancelled` レコード | **保持**（論理状態のまま） | 監査ログ用。30日後に物理削除（将来） |

#### 現状の実装状態

| 項目 | 状態 | 備考 |
|------|------|------|
| R6-1 | **実装済み** | process-line-event.ts の handleRecordText 冒頭で findActiveClarification → 処理 |
| R6-2 | **未実装** | モード切替コマンド処理前に cancelActiveClarifications を呼ぶ必要あり |
| R6-3 | **未実装** | handleImageMessageEvent 冒頭で cancelActiveClarifications を呼ぶ必要あり |
| R6-4 | **実装済み** | expirePendingClarifications (Cron) |
| R6-5 | **実装済み** | handleRecordText で deleteClarification |
| R6-6 | **確定済み** | 物理削除は将来 |

---

### R7. 同日同食事区分の重複保存

| シナリオ | 動作 | 理由 |
|----------|------|------|
| 同日・同区分の meal_entry が**存在しない** | 新規作成 | 通常のケース |
| 同日・同区分の meal_entry が**既に存在** | 既存の `meal_text` に `/` 区切りで**追記** | 「朝食にパンとコーヒー」→「朝食にヨーグルト」は追記。1区分に複数品目が自然 |
| 追記ではなく**置換**したい場合 | ユーザーが「朝食を卵焼きに変更」と修正指示 → `correct_record` (content_change) | 明示的な修正指示が必要 |

#### コード上の実装箇所

```typescript
// record-persister.ts: persistMealRecord 内
const existing = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, mealType)
if (existing) {
  // 追記（R7）
  const newText = [existing.meal_text, mealText].filter(Boolean).join(' / ')
  // ...
}
```

---

## C. 訂正ルール

### R8. 修正対象の特定ロジック

> **リスク**: 「鮭じゃなくて卵焼き」で**どの日のどの食事**を修正するか特定できない

#### 確定ルール

| 優先順位 | 特定方法 | 例 |
|----------|----------|-----|
| 1 | **明示指定**: 日付 + 食事区分が both 指定 | 「昨日の朝食を夕食に変更」 |
| 2 | **直前コンテキスト**: 直前に保存した記録を対象 | 「鮭じゃなくて卵焼き」（直前のBOT返信が「朝食を記録しました: 鮭」の場合 → その朝食を修正） |
| 3 | **日付のみ指定**: 日付指定 + 食事区分は直前コンテキストから | 「昨日の記録を修正: カレー」 |
| 4 | **特定不能** | 「記録を直して」→ clarification で対象を確認 |

#### AI プロンプトでの対応

interpretation.ts の `buildInterpretationPrompt` に以下の指示が含まれている:
```
- 修正は直前の会話コンテキストを参照して対象を特定
```

**追加ルール**:
- AI が `correction_target.target_date` を null で返した場合 → **今日の記録**をデフォルトとする
- AI が `correction_target.target_meal_type` を null で返した場合 → **直前に保存した食事区分**を対象とする
- 両方 null → Phase B で対象を確認

---

### R9. 修正の correction_history 記録

| フィールド | 値 | 備考 |
|-----------|-----|------|
| `target_table` | `meal_entries` / `body_metrics` / `daily_logs` | 修正対象テーブル |
| `correction_type` | `meal_type_change` / `content_change` / `date_change` / `nutrition_change` / `delete` / `weight_change` | 修正種別 |
| `old_value_json` | **修正前の値を完全に保存** | ロールバック用 |
| `new_value_json` | 修正後の値（delete の場合は null） | - |
| `triggered_by` | `user`（デフォルト） / `system` / `admin` | 誰が修正したか |
| `reason` | AI の reasoning テキスト | デバッグ・監査用 |

**重要**: correction_history は**すべての修正・削除操作**で必ず記録する。保存に失敗した場合は修正操作自体をロールバックする（Phase 2 でトランザクション化を検討）。

---

### R10. 削除時の確認フロー

#### 確定ルール

| # | ルール | 理由 |
|---|--------|------|
| R10-1 | 削除は**物理削除** | meal_entries から DELETE |
| R10-2 | 削除前に `correction_history` に `old_value_json` を保存 | 復元可能にする |
| R10-3 | 削除確認は**Quick Reply で「はい/いいえ」を提示**（Phase 2 で実装） | 誤削除防止 |
| R10-4 | 現在は**確認なしで即削除** | MVP ではシンプルさを優先。R10-3 は Phase 2 |

#### 将来（Phase 2）の削除確認フロー

```
ユーザー: 「昨日の朝食を消して」
BOT:      「🗑 昨日の朝食（パン・コーヒー）を削除しますか？」
          [はい] [いいえ]
ユーザー: [はい]
BOT:      「🗑 昨日の朝食の記録を削除しました。」
```

---

## D. 障害時ルール

### R11. AI API 障害時のフォールバック

| 障害パターン | フォールバック | ユーザーへの返信 |
|-------------|---------------|----------------|
| OpenAI API タイムアウト | regex フォールバック（createFallbackIntent） | フォールバック結果に基づく通常の返信 |
| OpenAI API エラー（500等） | 同上 | 同上 |
| JSON パース失敗 | 同上 | 同上 |
| regex フォールバックも失敗 | `intent_primary = 'unclear'` | 「🤔 記録内容が判定できませんでした。...」 |
| D1 Database エラー | 処理中断、エラーログ | 「⚠️ 記録の保存中にエラーが発生しました。もう一度お試しください。」 |

#### フォールバックチェーン

```
1. OpenAI GPT-4o (temperature=0.2, JSON mode)
   ↓ 失敗
2. Regex パターンマッチ (体重: /\d{2,3}\.?\d*\s*kg/i, 食事: キーワードマッチ)
   ↓ 失敗
3. intent_primary = 'unclear' + ユーザーへのリトライ案内
```

#### コード上の実装箇所

```typescript
// interpretation.ts: interpretMessage()
// try-catch で AI 呼び出し → catch で createFallbackIntent()
// 現在の実装で正しい。変更不要。
```

---

### R12. データ整合性の保証

> **リスク**: Phase C（保存）の途中でエラーが発生した場合のデータ不整合

#### 確定ルール

| # | ルール | 実装方法 |
|---|--------|----------|
| R12-1 | **daily_log は先に作成** → meal_entry / body_metrics を後から作成 | ensureDailyLog → createMealEntry の順序 |
| R12-2 | meal_entry 作成失敗時、**daily_log は残す**（空の daily_log は harm なし） | try-catch で meal_entry のみリトライ |
| R12-3 | correction_history は**修正実行と同一トランザクション内で記録** | D1 は単一 prepare().run() 内では atomic。複数ステートメントの場合は batch() を検討（Phase 2） |
| R12-4 | pending_clarifications の status 遷移は**一方向のみ** | `asking → answered → (削除)` or `asking → cancelled` or `asking → expired`。逆方向なし |
| R12-5 | 同一ユーザーの `asking` 状態は**常に最大1件** | createPendingClarification で既存 asking を cancelled にしてから INSERT |

#### D1 batch() によるトランザクション化（Phase 2 検討）

```typescript
// Phase 2: persistCorrection でのトランザクション例
await env.DB.batch([
  env.DB.prepare('UPDATE meal_entries SET ...'),
  env.DB.prepare('INSERT INTO correction_history ...'),
])
```

---

## 実装チェックリスト

### 現在の実装状態と必要なアクション

| ルール | 状態 | 必要なアクション |
|--------|------|-----------------|
| R1 | **実装済み** | intent.ts に `CONSULT_SECONDARY_SAVE_THRESHOLD` 定数を追加 |
| R2 | **実装済み** | 変更不要 |
| R3 | **実装済み** | 変更不要 |
| R4 | **実装済み** | 変更不要 |
| R5 | **一部未実装** | マイグレーション 0016 追加 + idempotency チェック追加 |
| R6-2,3 | **未実装** | モード切替・画像受信時に cancelActiveClarifications 呼び出し追加 |
| R7 | **実装済み** | 変更不要 |
| R8 | **AI依存** | interpretation.ts のプロンプトで対応済み。fallback 強化は Phase 2 |
| R9 | **実装済み** | 変更不要 |
| R10 | **MVP実装済み** | 削除確認 Quick Reply は Phase 2 |
| R11 | **実装済み** | 変更不要 |
| R12 | **一部実装** | batch() トランザクション化は Phase 2 |

---

## 定数一覧（コードに埋め込む値）

| 定数名 | 値 | ファイル | ルール |
|--------|-----|---------|--------|
| `CONSULT_SECONDARY_SAVE_THRESHOLD` | `0.8` | intent.ts | R1 |
| `WEIGHT_MIN` | `20` | intent.ts | R2 |
| `WEIGHT_MAX` | `300` | intent.ts | R2 |
| `CLARIFICATION_EXPIRY_HOURS` | `24` | pending-clarifications-repo.ts | R6-4 |
| `MAX_PENDING_PER_USER` | `1` | pending-clarifications-repo.ts | R6-5/R12-5 |
| `DATE_LOOKBACK_DAYS` | `30` | interpretation.ts | R8 (30日以上前は確認) |
| `MEMORY_EXTRACTION_MIN_LENGTH` | `5` | memory-extraction.ts | - |
| `MEMORY_CONFIDENCE_MIN` | `0.6` | interpretation.ts / knowledge-repo.ts | Layer3 |

---

## 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。12項目を4カテゴリ(保存/競合/訂正/障害)に分類して明文化 |
