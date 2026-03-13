# 会話解釈 SSOT（Single Source of Truth）

> **最終更新**: 2026-03-13 v1.1  
> **対象**: diet-bot v2.0（設計段階）  
> **前提**: `05_LINE会話フローSSOT.md` の G6-G9 問題を解決する新アーキテクチャ  
> **本ドキュメントが会話解釈設計の正本**。実装時は必ずここを先に更新する。

---

## 0. 背景と目的

### 0.1 現行の問題点（v1.x）

| # | 問題 | 影響 |
|---|------|------|
| G6 | 食事記録の日付が常に「今日」固定 | 「昨日の夕食」「おとといの焼肉」等の過去日付が反映されない |
| G7 | 食事区分がキーワード正規表現のみで文脈理解なし | 「3時にポテチ食べた」→間食と判定されない。時間帯推定もなし |
| G8 | 過去記録の修正ができない | 「昨日の朝食の写真、夕食の間違いだった」等に対応不可 |
| G9 | 相談モード中の体重・食事報告が記録されない | 相談中に「昨日58kgだった」と言っても記録されない |

### 0.2 解決方針

**全メッセージをAIで解釈し、構造化されたIntent JSONに変換する**。  
日付・食事区分・内容のいずれかが不明な場合は**保存せずユーザーに確認する**。

---

## 1. 3フェーズアーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                     LINE メッセージ受信                        │
│                                                               │
│  ① 決定論的プリフィルタ（AI不使用）                            │
│     ├─ 招待コード → handleInviteCode（従来通り）               │
│     ├─ 問診中 → handleIntakeStep（従来通り）                   │
│     ├─ モード切替コマンド → switchMode（従来通り）              │
│     ├─ 画像確認中の確定/取消 → handleConfirm/Discard           │
│     └─ 上記以外 ↓                                             │
│                                                               │
│  ② Phase A: 解釈レイヤー（AI使用）                             │
│     └─ メッセージ → OpenAI → Unified Intent JSON               │
│                                                               │
│  ③ Phase B: 明確化フロー（条件分岐）                           │
│     ├─ 全要素確定 → Phase C へ                                 │
│     └─ 不明要素あり → ユーザーに質問 → 回答待ち                │
│                                                               │
│  ④ Phase C: 永続化レイヤー（DB書込）                           │
│     └─ daily_logs / meal_entries / body_metrics 等を更新       │
│         → 日次集計を再計算                                     │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 決定論的プリフィルタとの境界

以下は**従来通りAI不使用の決定論的ロジック**で処理する（変更なし）：

| 処理 | 判定方法 | 備考 |
|------|---------|------|
| 招待コード検出 | regex `/^[A-Z]{3}-\d{4}$/i` | 最優先 |
| サービスアクセス判定 | DB `user_service_statuses` | 未認証ブロック |
| 問診フロー進行 | `bot_mode_sessions.current_step` | intake_* ステップ |
| モード切替コマンド | キーワード完全一致 | 「記録する」「相談する」等 |
| 画像確認中の確定/取消 | キーワード一致 | 「確定」「取消」等 |

**Phase A（AI解釈）に回すもの**:

| 条件 | 入力 |
|------|------|
| mode=record で上記に該当しないテキスト | 食事報告、体重報告、修正依頼等 |
| mode=consult のテキスト | 相談 + 記録情報が混在する可能性 |
| 画像確認中の確定/取消以外のテキスト | テキスト修正（従来の handleImageCorrection に代わる） |
| 画像解析結果の食事区分・日付推定 | Phase A で統一的に処理 |

---

## 2. Unified Intent Schema（統一意図スキーマ）

### 2.1 JSON 定義

```typescript
/**
 * Phase A の出力: 1メッセージにつき1つの Intent JSON
 * AIが生成し、バリデーション後に Phase B / Phase C で使用
 */
type UnifiedIntent = {
  /** メッセージの主要な意図 */
  intent_primary: IntentPrimary

  /** 副次的な意図（相談中に記録情報が含まれる場合等） */
  intent_secondary: IntentPrimary | null

  /** 記録対象の日付 */
  target_date: TargetDate

  /** 食事区分（食事記録の場合） */
  meal_type: MealTypeResolution | null

  /** 記録種別 */
  record_type: RecordType | null

  /** 内容の要約（BOT返信用） */
  content_summary: string | null

  /** 食事の詳細記述（AI解析テキスト） */
  meal_description: string | null

  /** 体重値（kg） */
  weight_kg: number | null

  /** 明確化が必要なフィールド一覧 */
  needs_clarification: ClarificationField[]

  /** 修正対象（既存レコードの修正の場合） */
  correction_target: CorrectionTarget | null

  /** AIの確信度（0.0-1.0） */
  confidence: number

  /** AIの判断根拠メモ（デバッグ用） */
  reasoning: string

  /** 返信ポリシー（Phase C で使用） */
  reply_policy: ReplyPolicy
}
```

### 2.2 型定義

```typescript
/** 主要な意図の分類 */
type IntentPrimary =
  | 'record_meal'           // 食事記録
  | 'record_weight'         // 体重記録
  | 'record_progress_photo' // 体型写真記録
  | 'correct_record'        // 既存記録の修正
  | 'delete_record'         // 既存記録の削除
  | 'consult'               // 相談・質問
  | 'greeting'              // 挨拶・雑談
  | 'unclear'               // 意図不明

/** 日付の解決状態 */
type TargetDate = {
  /** 解決済みの日付 (YYYY-MM-DD) */
  resolved: string | null

  /** ユーザーの原文表現 */
  original_expression: string | null

  /** 日付の推定方法 */
  source: DateSource

  /** 日付確認が必要か */
  needs_confirmation: boolean
}

type DateSource =
  | 'explicit'    // ユーザーが明示（「昨日」「3/10」等）
  | 'inferred'    // 文脈から推定（「さっき」→今日）
  | 'timestamp'   // メッセージ送信時刻から推定
  | 'unknown'     // 不明（確認が必要）

/** 食事区分の解決状態 */
type MealTypeResolution = {
  /** 解決済みの食事区分 */
  value: MealTypeValue | null

  /** ユーザーの原文表現 */
  raw_text: string | null

  /** 解決方法 */
  source: MealTypeSource

  /** 確認が必要か */
  needs_confirmation: boolean
}

type MealTypeValue =
  | 'breakfast'    // 朝食
  | 'lunch'        // 昼食
  | 'dinner'       // 夕食
  | 'snack'        // 間食
  | 'other'        // その他（夜食等）

type MealTypeSource =
  | 'explicit_keyword'    // 明示的キーワード（「朝食」「昼ご飯」等）
  | 'time_expression'     // 時間表現（「3時に」「夜9時」等）
  | 'content_inference'   // 内容から推定（「ポテチ」→ snack）
  | 'timestamp'           // メッセージ送信時刻から推定
  | 'unknown'             // 不明（確認が必要）

/** 記録種別 */
type RecordType =
  | 'meal'         // 食事
  | 'weight'       // 体重
  | 'progress_photo' // 体型写真

/** 明確化が必要なフィールド */
type ClarificationField =
  | 'target_date'  // いつの記録か不明
  | 'meal_type'    // 食事区分が不明
  | 'content'      // 内容が不明（何を食べたか等）
  | 'weight_value' // 体重値が不明

/** 修正対象の指定 */
type CorrectionTarget = {
  /** 修正対象の日付 (YYYY-MM-DD) */
  target_date: string | null

  /** 修正対象の食事区分 */
  target_meal_type: MealTypeValue | null

  /** 修正内容の種別 */
  correction_type: CorrectionType

  /** 変更後の値 */
  new_value: {
    meal_type?: MealTypeValue
    content?: string
    target_date?: string
    weight_kg?: number
  } | null
}

type CorrectionType =
  | 'meal_type_change'    // 食事区分の変更（朝食→夕食等）
  | 'content_change'      // 内容の変更（鮭→卵焼き等）
  | 'date_change'         // 日付の変更
  | 'nutrition_change'    // 栄養値の変更
  | 'delete'              // 削除
  | 'weight_change'       // 体重値の変更

/** 返信ポリシー */
type ReplyPolicy = {
  /** 保存完了を返信に含めるか */
  notify_save: boolean

  /** 相談応答を生成するか */
  generate_consult_reply: boolean

  /** 明確化質問を送るか（needs_clarification と連動） */
  ask_clarification: boolean
}
```

---

## 3. 保存確認ルール（SSOT）

### 3.1 即時保存ルール

以下の条件を**すべて**満たす場合、Phase B をスキップして Phase C で即時保存する:

| 記録種別 | 即時保存条件 | 備考 |
|---------|------------|------|
| **体重** | `weight_kg` が 20.0〜300.0 の範囲 | 体重計画像の読み取り値も同様 |
| **食事** | `target_date.resolved` ≠ null **かつ** `target_date.source` ∈ {explicit, inferred} **かつ** `meal_type.value` ≠ null **かつ** `meal_type.source` ∈ {explicit_keyword, time_expression, content_inference} **かつ** `content_summary` ≠ null | 3要素すべて確定 |
| **体重（timestamp推定日）** | 体重値が明確 + 日付が timestamp 推定 | 即時保存OK（体重は日付不明でもリスク低い） |

### 3.2 明確化が必要なケース（Phase B に回す）

| 条件 | 動作 |
|------|------|
| `target_date.source = 'unknown'` | 日付を質問 |
| `target_date.source = 'timestamp'` かつ食事記録 | 「今日の{推定区分}として記録しますか？」（体重は除外） |
| `meal_type = null` または `meal_type.source = 'unknown'` | 食事区分を質問 |
| `content_summary = null` かつ intent が record_meal | 食事内容を質問 |
| `weight_kg = null` かつ intent が record_weight | 体重値を質問 |

### 3.3 相談モードでの保存ルール

| 条件 | 動作 |
|------|------|
| `intent_secondary` が record系 + confidence ≥ 0.8 | 即時保存 + 返信末尾に「📝 〇〇も記録しました」 |
| `intent_secondary` が record系 + confidence < 0.8 | 「〇〇を記録しますか？」と確認してから保存 |
| `intent_secondary = null` | 相談応答のみ（従来通り） |

---

## 4. 日付解決ルール（SSOT）

### 4.1 タイムゾーン

**すべての日付処理は JST (Asia/Tokyo, UTC+9) で行う。**

### 4.2 優先順位: explicit > inferred > timestamp > unknown

| # | ユーザー表現 | source | resolved | needs_confirmation |
|---|-------------|--------|----------|--------------------|
| D1 | 「昨日」「きのう」 | explicit | 送信時刻(JST) - 1日 | false |
| D2 | 「おととい」「一昨日」 | explicit | 送信時刻(JST) - 2日 | false |
| D3 | 「今日」「きょう」 | explicit | 送信時刻(JST)の日付 | false |
| D4 | 「3/10」「3月10日」 | explicit | 直接パース（年は送信年） | false |
| D5 | 「月曜日の」「先週の水曜」 | explicit | 直近の該当曜日 | false |
| D6 | 「今朝」「今日の朝」 | explicit | 送信時刻(JST)の日付 | false |
| D7 | 「さっき」「今」「たった今」 | inferred | 送信時刻(JST)の日付 | false |
| D8 | 「朝」「昼」「夜」（単独） | inferred | 送信時刻(JST)の日付 | false（※注1） |
| D9 | 「夜中」「3時」（早朝0:00-4:59のメッセージ） | inferred | 送信時刻(JST)の日付（※注2） | false |
| D10 | 日付表現なし + 送信時刻あり | timestamp | 送信時刻(JST)の日付 | **true（食事のみ）** |
| D11 | 日付表現なし + 文脈不明 | unknown | null | **true** |

**注1**: 「朝」で午後のメッセージの場合は「今日の朝」と解釈（今朝）。  
ただし「夜」で午前のメッセージの場合は「昨日の夜」と解釈する（AI が文脈判断）。

**注2**: JST 0:00〜4:59 のメッセージは、前日の深夜を指す可能性が高い。  
「夜中にラーメン食べた」が 1:00 送信 → 当日 (1:00 は前日の延長) として記録。

### 4.3 日付バリデーション

| ルール | 動作 |
|--------|------|
| 未来日付 | 「未来の日付は記録できません」 → needs_clarification に追加 |
| 30日以上前 | 「30日以上前の記録は登録できません」 → needs_clarification に追加 |
| 年の推定 | 「3/10」→ 送信年の3月10日。過去なら当年、未来なら前年 |

---

## 5. 食事区分解決ルール（SSOT）

### 5.1 優先順位（上から順に適用）

| # | 判定方法 | 例 | 結果 | needs_confirmation |
|---|---------|---|------|--------------------|
| M1 | **明示的キーワード** | 「朝食」「昼ご飯」「おやつ」「間食」「夜食」 | 該当区分 | false |
| M2 | **時間表現** | 「3時に」「15時ごろ」「夜9時に」 | 時間帯マッピング(§5.2) | false |
| M3 | **食事内容からAI推定** | 「ポテチ」「チョコ」→ snack | AI推定 | false（返信で「間食として記録」と明示） |
| M4 | **メッセージ送信時刻** | 12:30送信 → lunch | 時間帯マッピング(§5.2) | **true**（「お昼ご飯ですか？」と確認） |
| M5 | **不明** | 判定不可 | null | **true**（Phase B で質問） |

### 5.2 時間帯 → 食事区分マッピング

| 時間帯（JST） | 食事区分 | 備考 |
|---------------|---------|------|
| 05:00 - 10:29 | breakfast | 朝食 |
| 10:30 - 14:59 | lunch | 昼食 |
| 15:00 - 17:29 | snack | 間食 |
| 17:30 - 22:59 | dinner | 夕食 |
| 23:00 - 04:59 | other | 夜食（その他） |

### 5.3 明示的キーワードマッピング

| キーワード群 | 食事区分 |
|-------------|---------|
| 朝食, 朝ごはん, 朝ご飯, 朝飯, モーニング, breakfast | breakfast |
| 昼食, 昼ごはん, 昼ご飯, 昼飯, ランチ, lunch | lunch |
| 夕食, 夕飯, 夕ごはん, 夕ご飯, 晩ご飯, 晩飯, ディナー, dinner | dinner |
| 間食, おやつ, お菓子, スナック, snack, 3時のおやつ | snack |
| 夜食, 夜のおやつ, 深夜メシ | other |

---

## 6. 修正ターゲット特定ルール（SSOT）

### 6.1 修正対象の優先順位

修正意図（`correct_record` / `delete_record`）が検出された場合、以下の順序で対象レコードを特定する:

| 優先度 | 対象 | 条件 | 例 |
|--------|------|------|---|
| P1 | **pending_image_confirm 中の画像** | session.current_step = 'pending_image_confirm' | 画像確認中に「夕食じゃなくて朝食」 |
| P2 | **pending_clarification 中のレコード** | pending_clarifications.status = 'asking' | 質問中に「やっぱり昨日の」 |
| P3 | **同日・同食事区分の最新エントリ** | 当日 + 指定meal_type + 24h以内 | 「さっきの朝食、鮭じゃなくて卵焼き」 |
| P4 | **24h以内の候補** | 指定date + 指定meal_type | 「昨日の夕食を朝食に直して」 |
| P5 | **複数候補** | 上記で一意に特定不可 | 「〇〇の記録を修正したいのですが、以下のどれですか？」 |

### 6.2 特定不可時の動作

```
修正対象の特定に失敗した場合:
  ├── 候補が0件 → 「該当する記録が見つかりませんでした」
  ├── 候補が1件 → 「この記録を修正しますか？」+ 内容表示 + Quick Reply
  └── 候補が複数 → 「以下のどれですか？」+ 候補リスト + Quick Reply
```

---

## 7. Phase A: 解釈レイヤー

### 7.1 処理フロー

```
┌──────────────────────────────────────────────────────────┐
│  Phase A: interpretMessage()                              │
│                                                           │
│  入力:                                                    │
│    - message_text: string          ← ユーザーのテキスト   │
│    - current_mode: 'record'|'consult'                     │
│    - message_timestamp: string     ← ISO8601              │
│    - user_context: UserContext      ← 直近の会話履歴等    │
│                                                           │
│  処理:                                                    │
│    1. OpenAI Chat Completion 呼び出し                     │
│       - INTERPRETATION_PROMPT（§7.2）                     │
│       - message_text + コンテキスト                       │
│       - temp=0.2, json_object                             │
│    2. JSON パース + バリデーション                         │
│    3. 日付解決（§4 ルール適用）                            │
│    4. 食事区分解決（§5 ルール適用）                        │
│    5. 保存確認ルール適用（§3）                             │
│                                                           │
│  出力:                                                    │
│    UnifiedIntent JSON                                     │
│                                                           │
│  エラー時:                                                │
│    - AI応答パース失敗 → intent_primary='unclear' で返す    │
│    - API呼び出し失敗 → フォールバックメッセージ            │
│      「申し訳ありません、メッセージの解析に失敗しました。  │
│       もう一度送っていただけますか？」                     │
└──────────────────────────────────────────────────────────┘
```

### 7.2 INTERPRETATION_PROMPT（システムプロンプト）

```
あなたはダイエット支援BOTの会話解釈エンジンです。
ユーザーからのLINEメッセージを解析し、以下のJSON形式で構造化してください。

## タスク
ユーザーのメッセージから以下の情報を抽出してください:
1. 意図（食事記録、体重記録、修正、相談、挨拶 等）
2. 対象日付（「昨日」「おととい」「3/10」等を具体的なYYYY-MM-DDに変換）
3. 食事区分（朝食/昼食/夕食/間食/その他）
4. 内容の要約
5. 体重値（記載がある場合）
6. 明確化が必要な項目

## 現在の日時
{current_datetime_jst}（日本時間）

## 現在のモード
{current_mode}（record=記録モード、consult=相談モード）

## ユーザーの直近の会話（参考）
{recent_messages}

## ユーザーの既知情報（参考）
{user_memory_context}

## 日付解決ルール
- 「昨日」「きのう」→ 今日 - 1日
- 「おととい」「一昨日」→ 今日 - 2日
- 「今日」「きょう」「今朝」→ 今日
- 「さっき」「今」→ 今日（inferred）
- 「3/10」「3月10日」→ 直接パース
- 「月曜日の」→ 直近の該当曜日
- 「朝」「昼」「夜」（単独）→ 今日（inferred）。ただし午前に「夜」→昨日の夜
- 日付が一切不明 → source="unknown"
- JST 0:00〜4:59 のメッセージで「夜中」等 → 当日として扱う
- **日付をデフォルトで今日にしない**。表現がない場合は timestamp を使用

## 食事区分解決ルール（優先順位順）
1. 明示的キーワード: 朝食/昼食/夕食/間食/夜食 等
2. 時間表現: 「3時に」→ snack、「夜9時に」→ dinner
3. 内容推定: 「ポテチ」「チョコ」→ snack
4. 送信時刻: 05:00-10:29→breakfast, 10:30-14:59→lunch, 15:00-17:29→snack, 17:30-22:59→dinner, 23:00-04:59→other
5. 不明 → null

## 修正の検出
- 「鮭じゃなくて卵焼き」→ correct_record (content_change)
- 「朝食じゃなくて夕食」→ correct_record (meal_type_change)
- 「昨日の記録消して」→ delete_record
- 修正は直前の会話コンテキストを参照して対象を特定

## ルール
- 食事区分が不明な場合は meal_type.value を null にしてください
- 「お菓子」「スナック」「ポテチ」「チョコ」等は snack（間食）です
- 相談モードでも「昨日58kgだった」等は intent_secondary=record_weight として検出
- 1メッセージに複数の記録がある場合は、最も重要なものを intent_primary、次を intent_secondary に
- confidence は 0.0-1.0（0.8未満は要確認の目安）

## 出力形式（JSON）
{
  "intent_primary": "record_meal" | "record_weight" | "correct_record" | "delete_record" | "consult" | "greeting" | "unclear",
  "intent_secondary": null | (同上),
  "target_date": {
    "resolved": "YYYY-MM-DD" | null,
    "original_expression": "昨日" | null,
    "source": "explicit" | "inferred" | "timestamp" | "unknown",
    "needs_confirmation": true | false
  },
  "meal_type": {
    "value": "breakfast" | "lunch" | "dinner" | "snack" | "other" | null,
    "raw_text": "昼ご飯" | null,
    "source": "explicit_keyword" | "time_expression" | "content_inference" | "timestamp" | "unknown",
    "needs_confirmation": true | false
  } | null,
  "record_type": "meal" | "weight" | "progress_photo" | null,
  "content_summary": "...",
  "meal_description": "...",
  "weight_kg": null | number,
  "needs_clarification": [],
  "correction_target": null | {
    "target_date": "YYYY-MM-DD" | null,
    "target_meal_type": "...",
    "correction_type": "...",
    "new_value": { ... }
  },
  "confidence": 0.0-1.0,
  "reasoning": "..."
}
```

### 7.3 UserContext（コンテキスト情報）

```typescript
type UserContext = {
  /** 現在のモード */
  current_mode: 'record' | 'consult'

  /** メッセージ送信時刻 (JST) */
  message_timestamp_jst: string

  /** 今日の日付 (JST) YYYY-MM-DD */
  today_jst: string

  /** 直近5件の会話メッセージ（ユーザー+BOT） */
  recent_messages: Array<{
    role: 'user' | 'bot'
    text: string
    sent_at: string
  }>

  /** 明確化待ちの pending 状態（Phase B からの復帰時） */
  pending_clarification: PendingClarification | null

  /** ユーザーメモリ（嗜好・アレルギー等） */
  user_memories: Array<{
    category: string
    memory_value: string
  }>
}
```

### 7.4 AI使用パラメータ

| パラメータ | 値 | 備考 |
|-----------|---|------|
| model | gpt-4o | 日本語の文脈理解に十分な精度が必要 |
| temperature | 0.2 | 安定した構造化出力のため低温度 |
| response_format | json_object | JSON強制 |
| max_tokens | 1024 | Intent JSON に十分 |

### 7.5 AIフォールバック

| エラー | フォールバック動作 |
|--------|------------------|
| API タイムアウト（5秒） | 従来の regex パターンマッチにフォールバック |
| JSON パース失敗 | intent_primary='unclear' として処理 |
| API 429 (Rate Limit) | 「現在混み合っています。少し待ってから再度お送りください」 |
| API 5xx エラー | 「一時的なエラーが発生しました。もう一度お試しください」 |

---

## 8. Phase A の入出力例

### 8.1 基本的な食事記録

**入力**: 「昼にラーメン食べた」（送信時刻: 2026-03-13 14:30 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": "昼",
    "source": "inferred",
    "needs_confirmation": false
  },
  "meal_type": {
    "value": "lunch",
    "raw_text": "昼",
    "source": "explicit_keyword",
    "needs_confirmation": false
  },
  "record_type": "meal",
  "content_summary": "ラーメン",
  "meal_description": "ラーメン",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.95,
  "reasoning": "「昼に」から本日の昼食と推定。ラーメンは明確な食事内容。",
  "reply_policy": { "notify_save": true, "generate_consult_reply": false, "ask_clarification": false }
}
```

### 8.2 過去日付の食事記録

**入力**: 「昨日の夜ラーメン食べた」（送信時刻: 2026-03-13 10:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日の夜",
    "source": "explicit",
    "needs_confirmation": false
  },
  "meal_type": {
    "value": "dinner",
    "raw_text": "夜",
    "source": "explicit_keyword",
    "needs_confirmation": false
  },
  "record_type": "meal",
  "content_summary": "ラーメン",
  "meal_description": "ラーメン",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.98,
  "reasoning": "「昨日の夜」から2026-03-12の夕食と確定。"
}
```

### 8.3 間食の記録

**入力**: 「3時にポテチ食べちゃった」（送信時刻: 2026-03-13 16:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": "3時",
    "source": "explicit",
    "needs_confirmation": false
  },
  "meal_type": {
    "value": "snack",
    "raw_text": "3時",
    "source": "time_expression",
    "needs_confirmation": false
  },
  "record_type": "meal",
  "content_summary": "ポテトチップス",
  "meal_description": "ポテトチップス",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.95,
  "reasoning": "「3時」は15時と推定（本日のメッセージ）。ポテチはスナック菓子なので間食。"
}
```

### 8.4 日付 timestamp 推定の記録（明確化が必要）

**入力**: 「カレー食べた」（送信時刻: 2026-03-13 20:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": null,
    "source": "timestamp",
    "needs_confirmation": true
  },
  "meal_type": {
    "value": "dinner",
    "raw_text": null,
    "source": "timestamp",
    "needs_confirmation": true
  },
  "record_type": "meal",
  "content_summary": "カレー",
  "meal_description": "カレー",
  "weight_kg": null,
  "needs_clarification": ["meal_type"],
  "correction_target": null,
  "confidence": 0.7,
  "reasoning": "日付表現なし。20時の送信なので本日の夕食と推定。ただし確信度は低め。"
}
```

### 8.5 記録の修正

**入力**: 「昨日登録した夕食の写真、朝食の間違いだった」

```json
{
  "intent_primary": "correct_record",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日",
    "source": "explicit",
    "needs_confirmation": false
  },
  "meal_type": null,
  "record_type": "meal",
  "content_summary": "夕食→朝食に修正",
  "meal_description": null,
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": {
    "target_date": "2026-03-12",
    "target_meal_type": "dinner",
    "correction_type": "meal_type_change",
    "new_value": { "meal_type": "breakfast" }
  },
  "confidence": 0.95,
  "reasoning": "昨日の夕食記録を朝食に変更する修正リクエスト。"
}
```

### 8.6 相談モード中の記録検出

**入力**: 「最近太ってきて悩んでる。昨日58kgだった」（mode=consult）

```json
{
  "intent_primary": "consult",
  "intent_secondary": "record_weight",
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日",
    "source": "explicit",
    "needs_confirmation": false
  },
  "meal_type": null,
  "record_type": "weight",
  "content_summary": "体重増加の悩み + 昨日の体重58kg",
  "meal_description": null,
  "weight_kg": 58.0,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.9,
  "reasoning": "相談モードだが「昨日58kgだった」は体重記録の意図あり。相談が主、記録が副。",
  "reply_policy": { "notify_save": true, "generate_consult_reply": true, "ask_clarification": false }
}
```

### 8.7 内容不明で確認が必要

**入力**: 「食べた」

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": null,
    "original_expression": null,
    "source": "unknown",
    "needs_confirmation": true
  },
  "meal_type": null,
  "record_type": "meal",
  "content_summary": null,
  "meal_description": null,
  "weight_kg": null,
  "needs_clarification": ["target_date", "meal_type", "content"],
  "correction_target": null,
  "confidence": 0.3,
  "reasoning": "「食べた」だけでは日付・食事区分・内容すべて不明。確認が必要。"
}
```

### 8.8 内容変更の修正

**入力**: 「鮭じゃなくて卵焼き」（直前に鮭の朝食を記録した文脈あり）

```json
{
  "intent_primary": "correct_record",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": null,
    "source": "inferred",
    "needs_confirmation": false
  },
  "meal_type": {
    "value": "breakfast",
    "raw_text": null,
    "source": "explicit_keyword",
    "needs_confirmation": false
  },
  "record_type": "meal",
  "content_summary": "鮭→卵焼きに修正",
  "meal_description": "卵焼き",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": {
    "target_date": "2026-03-13",
    "target_meal_type": "breakfast",
    "correction_type": "content_change",
    "new_value": { "content": "卵焼き" }
  },
  "confidence": 0.9,
  "reasoning": "直前の会話で鮭の朝食を記録。「鮭じゃなくて卵焼き」は内容修正。"
}
```

---

## 9. 画像入力への適用

### 9.1 画像解析 → Phase A 統合

画像解析結果も Unified Intent Schema に変換する。

```
画像受信
  │
  ▼
OpenAI Vision（従来の分類・解析）
  │ カテゴリ + 解析結果JSON
  ▼
Phase A 統合（interpretImageResult）
  │
  ├─ meal_photo / nutrition_label / food_package
  │     → intent_primary = 'record_meal'
  │     → meal_type = AIが推定 or null（確認必要）
  │     → target_date = { source: 'timestamp', resolved: 今日 }
  │
  ├─ body_scale
  │     → intent_primary = 'record_weight'
  │     → weight_kg = 解析値
  │     → target_date = { source: 'timestamp', resolved: 今日 }
  │     → **即時保存**（体重は timestamp でもOK）
  │
  ├─ progress_body_photo
  │     → intent_primary = 'record_progress_photo'
  │     → target_date = { source: 'timestamp', resolved: 今日 }
  │
  └─ other / unknown
        → intent_primary = 'unclear'
```

### 9.2 画像の日付・食事区分の確認

画像の場合、日付と食事区分は基本的に `timestamp`（送信時刻）で推定する。  
ユーザー確認フローは Phase B で統一的に処理する。

```
画像解析結果を提示（食事内容・栄養推定）
  │
  ├─ 「これは今日の昼食として記録しますか？」
  │     ├─ 確定 → Phase C で保存
  │     ├─ 「昨日の夕食」→ Phase A で再解釈 → 日付・区分を更新
  │     └─ 取消 → 破棄
  │
  └─ 食事区分が不明な場合
        → 「いつの食事ですか？」（Phase B の明確化フロー）
```

---

## 10. モード別の処理方針

### 10.1 記録モード（mode=record）

```
テキスト入力
  ↓
Phase A: interpretMessage()
  ↓
intent_primary による分岐:
  ├─ record_meal / record_weight → Phase B → Phase C
  ├─ correct_record → 修正フロー（§6参照）
  ├─ delete_record → 削除確認フロー
  ├─ consult → 「相談モードに切り替えますか？」+ そのまま回答
  ├─ greeting → 簡単な返答 + 「記録したい内容を送ってください」
  └─ unclear → 「記録したい内容を教えてください（食事・体重・写真）」
```

### 10.2 相談モード（mode=consult）

```
テキスト入力
  ↓
Phase A: interpretMessage()
  ↓
intent_primary / intent_secondary による分岐:

  intent_primary = 'consult':
    ├─ intent_secondary = 'record_meal' | 'record_weight'
    │     → 相談応答を生成（従来通り）
    │     → **同時に** intent_secondary を Phase B → Phase C で記録
    │     → 返信: 「{相談の回答}\n\n📝 {記録内容}も記録しました」
    │
    └─ intent_secondary = null
          → 相談応答のみ（従来通り）

  intent_primary = 'record_meal' | 'record_weight':
    → Phase B → Phase C で記録
    → 返信: 「📝 記録しました。他に相談したいことはありますか？」
```

---

## 11. データフロー全体図

### 11.1 3層データストア設計

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 生会話ログ（conversation_messages）             │
│  ─────────────────────────────────────                   │
│  全メッセージの生テキスト・タイムスタンプを保存           │
│  intent_label カラムに Phase A の結果を記録               │
│  ※削除・編集しない。監査ログとしても機能                 │
└─────────────────────────────────────────────────────────┘
         │ Phase A の解釈結果
         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: 構造化記録（daily_logs / meal_entries /         │
│           body_metrics / progress_photos）               │
│  ─────────────────────────────────────                   │
│  Phase C で確定した記録のみ保存                           │
│  日付 × ユーザー × 区分 で一意                           │
│  ダッシュボード・週次レポートのデータソース               │
└─────────────────────────────────────────────────────────┘
         │ 長期パターン
         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3: パーソナルナレッジ（user_memory_items）         │
│  ─────────────────────────────────────                   │
│  ユーザーの嗜好・習慣・アレルギー等を蓄積                │
│  AI相談時のコンテキストとして活用                         │
│  → 13_パーソナルメモリSSOT.md で詳細定義                 │
└─────────────────────────────────────────────────────────┘
```

### 11.2 conversation_messages の拡張

既存の `intent_label` カラムを活用し、Phase A の解釈結果を保存する。

```sql
-- 既存カラムの活用（スキーマ変更不要）
UPDATE conversation_messages
SET intent_label = 'record_meal',          -- Phase A の intent_primary
    normalized_text = '{"intent":...}'     -- Unified Intent JSON 全体（デバッグ用）
WHERE id = ?
```

---

## 12. 実装フェーズ

### Phase A（解釈レイヤー）— 最優先

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| A1 | `src/types/intent.ts` 作成 | 新規 | Unified Intent Schema 型定義 |
| A2 | `src/services/ai/interpretation.ts` 作成 | 新規 | interpretMessage() + INTERPRETATION_PROMPT |
| A3 | `src/services/ai/interpret-image.ts` 作成 | 新規 | interpretImageResult() |
| A4 | `process-line-event.ts` 修正 | 既存 | handleRecordText → Phase A 呼び出しに変更 |
| A5 | `process-line-event.ts` 修正 | 既存 | handleConsultText → Phase A で副次記録を検出 |

### Phase B（明確化フロー）— 次優先

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| B1 | `pending_clarifications` テーブル作成 | マイグレーション 0013 | 明確化待ち状態の保存 |
| B2 | `src/services/line/clarification-handler.ts` 作成 | 新規 | 質問送信・回答受付 |
| B3 | `bot_mode_sessions` 拡張 | 既存 | pending_clarification ステップ追加 |

### Phase C（永続化レイヤー）— Phase A/B と同時

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| C1 | `src/services/line/record-persister.ts` 作成 | 新規 | Intent → DB保存の統一ハンドラ |
| C2 | `correction_history` テーブル作成 | マイグレーション 0014 | 修正履歴の記録 |
| C3 | `user_memory_items` テーブル作成 | マイグレーション 0015 | パーソナルメモリ |
| C4 | 既存 `handleRecordText` のリファクタ | 既存 | Phase A/B/C パイプラインに置換 |

---

## 13. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。会話解釈アーキテクチャ（Phase A/B/C）、Unified Intent Schema、日付/食事区分解決ルール、入出力例、画像統合、モード別処理、修正フロー、データフロー設計を文書化 |
| 2026-03-13 | v1.1 | 保存確認ルール(§3)追加。日付解決ルール(§4)精緻化（JST明記、夜中/早朝ルール、バリデーション追加）。食事区分(§5)時間帯マッピング更新（5:00-10:29/10:30-14:59/15:00-17:29/17:30-22:59/23:00-4:59）。修正ターゲット特定ルール(§6)追加。MealTypeResolution型追加（value+source+needs_confirmation）。ReplyPolicy型追加。AIフォールバック(§7.5)追加。相談モード保存ルール(§3.3)追加 |
