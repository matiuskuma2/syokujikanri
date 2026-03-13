# 会話解釈 SSOT（Single Source of Truth）

> **最終更新**: 2026-03-13  
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
  meal_type: MealType | null

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
  source: 'explicit'    // ユーザーが明示（「昨日」「3/10」等）
        | 'inferred'    // 文脈から推定（「さっき」→今日）
        | 'timestamp'   // メッセージ送信時刻から推定
        | 'unknown'     // 不明（確認が必要）
}

/** 食事区分 */
type MealType =
  | 'breakfast'    // 朝食
  | 'lunch'        // 昼食
  | 'dinner'       // 夕食
  | 'snack'        // 間食
  | 'other'        // その他

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
  target_meal_type: MealType | null

  /** 修正内容の種別 */
  correction_type: 'meal_type_change'    // 食事区分の変更（朝食→夕食等）
                 | 'content_change'      // 内容の変更（鮭→卵焼き等）
                 | 'date_change'         // 日付の変更
                 | 'nutrition_change'    // 栄養値の変更
                 | 'delete'             // 削除

  /** 変更後の値 */
  new_value: {
    meal_type?: MealType
    content?: string
    target_date?: string
    weight_kg?: number
  } | null
}
```

### 2.3 日付解決ルール（SSOT）

| ユーザー表現 | 解決方法 | source | resolved |
|-------------|---------|--------|----------|
| 「昨日」「きのう」 | 送信時刻 - 1日 | explicit | YYYY-MM-DD |
| 「おととい」「一昨日」 | 送信時刻 - 2日 | explicit | YYYY-MM-DD |
| 「3/10」「3月10日」 | 直接パース | explicit | YYYY-MM-DD |
| 「今日」「さっき」「今」 | 送信時刻の日付 | explicit | YYYY-MM-DD |
| 「朝」「昼」「夜」（本日のメッセージ） | 送信時刻の日付 + 時間帯推定 | inferred | YYYY-MM-DD |
| 「月曜日の」 | 直近の該当曜日 | explicit | YYYY-MM-DD |
| 日付表現なし + 送信時刻あり | メッセージ送信時刻の日付（**推定**） | timestamp | YYYY-MM-DD |
| 日付表現なし + 文脈不明 | **null（確認必要）** | unknown | null |

**重要ルール**:
- `source = 'unknown'` の場合は**保存しない**。Phase B で確認する
- `source = 'timestamp'` の場合は**推定であることをユーザーに提示**し確認する
- `source = 'explicit'` または `source = 'inferred'` の場合は確認なしで進める

### 2.4 食事区分解決ルール（SSOT）

**優先順位**（上から順に適用）:

| # | 判定方法 | 例 | 結果 |
|---|---------|---|------|
| 1 | **明示的キーワード** | 「朝食」「昼ご飯」「おやつ」「間食」 | 該当区分 |
| 2 | **時間表現** | 「3時に」「15時ごろ」「夜9時に」 | 時間帯マッピング |
| 3 | **食事内容から推定** | 「ポテチ」「チョコ」「クッキー」→ snack | AI推定 |
| 4 | **メッセージ送信時刻** | 12:30送信 → lunch（推定） | timestamp推定 |
| 5 | **不明** | 上記で判定不可 | null（確認必要） |

**時間帯 → 食事区分マッピング**:

| 時間帯 | 食事区分 | 備考 |
|--------|---------|------|
| 05:00 - 09:59 | breakfast | |
| 10:00 - 13:59 | lunch | |
| 14:00 - 16:59 | snack | |
| 17:00 - 20:59 | dinner | |
| 21:00 - 04:59 | snack | 夜食は間食扱い |

**重要ルール**:
- 優先度1（明示キーワード）の場合は確認なしで確定
- 優先度2-3の場合は「〇〇の間食として記録しますか？」と提示（確認は求めない。修正は可能）
- 優先度4（送信時刻のみ）の場合は「お昼ご飯ですか？」と確認する
- 優先度5の場合は**保存しない**。Phase B で確認する

---

## 3. Phase A: 解釈レイヤー

### 3.1 処理フロー

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
│       - INTERPRETATION_PROMPT（§3.2）                     │
│       - message_text + コンテキスト                       │
│       - temp=0.2, json_object                             │
│    2. JSON パース + バリデーション                         │
│    3. 日付解決（§2.3 ルール適用）                          │
│    4. 食事区分解決（§2.4 ルール適用）                      │
│                                                           │
│  出力:                                                    │
│    UnifiedIntent JSON                                     │
│                                                           │
│  エラー時:                                                │
│    - AI応答パース失敗 → intent_primary='unclear' で返す    │
│    - API呼び出し失敗 → フォールバックメッセージ            │
└──────────────────────────────────────────────────────────┘
```

### 3.2 INTERPRETATION_PROMPT（システムプロンプト）

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

## ルール
- 日付が明示されていない場合、文脈から推定してください
- 推定できない場合は target_date.source を "unknown" にしてください
- 食事区分が不明な場合は meal_type を null にしてください
- 「お菓子」「スナック」「ポテチ」「チョコ」等は snack（間食）です
- 「鮭じゃなくて卵焼き」等は correct_record（修正）意図です
- 相談モードでも「昨日58kgだった」等は record_weight として検出してください
- 1メッセージに複数の記録がある場合は、最も重要なものを intent_primary、
  次を intent_secondary にしてください
- confidence は 0.0-1.0 で、確信度を示してください（0.8未満は要確認の目安）

## 出力形式
以下のJSON形式で出力してください:
{
  "intent_primary": "record_meal" | "record_weight" | "correct_record" | "delete_record" | "consult" | "greeting" | "unclear",
  "intent_secondary": null | (同上),
  "target_date": {
    "resolved": "YYYY-MM-DD" | null,
    "original_expression": "昨日" | null,
    "source": "explicit" | "inferred" | "timestamp" | "unknown"
  },
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack" | "other" | null,
  "record_type": "meal" | "weight" | "progress_photo" | null,
  "content_summary": "...",
  "meal_description": "...",
  "weight_kg": null | number,
  "needs_clarification": [],
  "correction_target": null | { ... },
  "confidence": 0.0-1.0,
  "reasoning": "..."
}
```

### 3.3 UserContext（コンテキスト情報）

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
}
```

### 3.4 AI使用パラメータ

| パラメータ | 値 | 備考 |
|-----------|---|------|
| model | gpt-4o | 日本語の文脈理解に十分な精度が必要 |
| temperature | 0.2 | 安定した構造化出力のため低温度 |
| response_format | json_object | JSON強制 |
| max_tokens | 1024 | Intent JSON に十分 |

---

## 4. Phase A の入出力例

### 4.1 基本的な食事記録

**入力**: 「昼にラーメン食べた」（送信時刻: 2026-03-13 14:30 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": "昼",
    "source": "inferred"
  },
  "meal_type": "lunch",
  "record_type": "meal",
  "content_summary": "ラーメン",
  "meal_description": "ラーメン",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.95,
  "reasoning": "「昼に」から本日の昼食と推定。ラーメンは明確な食事内容。"
}
```

### 4.2 過去日付の食事記録

**入力**: 「昨日の夜ラーメン食べた」（送信時刻: 2026-03-13 10:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日の夜",
    "source": "explicit"
  },
  "meal_type": "dinner",
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

### 4.3 間食の記録

**入力**: 「3時にポテチ食べちゃった」（送信時刻: 2026-03-13 16:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": "3時",
    "source": "explicit"
  },
  "meal_type": "snack",
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

### 4.4 日付不明の記録

**入力**: 「カレー食べた」（送信時刻: 2026-03-13 20:00 JST）

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": null,
    "source": "timestamp"
  },
  "meal_type": "dinner",
  "record_type": "meal",
  "content_summary": "カレー",
  "meal_description": "カレー",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.7,
  "reasoning": "日付表現なし。20時の送信なので本日の夕食と推定。ただし過去の可能性もあるため確信度は低め。"
}
```

### 4.5 記録の修正

**入力**: 「昨日登録した夕食の写真、朝食の間違いだった」

```json
{
  "intent_primary": "correct_record",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日",
    "source": "explicit"
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
    "new_value": {
      "meal_type": "breakfast"
    }
  },
  "confidence": 0.95,
  "reasoning": "昨日の夕食記録を朝食に変更する修正リクエスト。"
}
```

### 4.6 相談モード中の記録検出

**入力**: 「最近太ってきて悩んでる。昨日58kgだった」（mode=consult）

```json
{
  "intent_primary": "consult",
  "intent_secondary": "record_weight",
  "target_date": {
    "resolved": "2026-03-12",
    "original_expression": "昨日",
    "source": "explicit"
  },
  "meal_type": null,
  "record_type": "weight",
  "content_summary": "体重増加の悩み + 昨日の体重58kg",
  "meal_description": null,
  "weight_kg": 58.0,
  "needs_clarification": [],
  "correction_target": null,
  "confidence": 0.9,
  "reasoning": "相談モードだが「昨日58kgだった」は体重記録の意図あり。相談が主、記録が副。"
}
```

### 4.7 内容不明で確認が必要

**入力**: 「食べた」

```json
{
  "intent_primary": "record_meal",
  "intent_secondary": null,
  "target_date": {
    "resolved": null,
    "original_expression": null,
    "source": "unknown"
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

### 4.8 内容変更の修正

**入力**: 「鮭じゃなくて卵焼き」（直前に鮭の朝食を記録した文脈あり）

```json
{
  "intent_primary": "correct_record",
  "intent_secondary": null,
  "target_date": {
    "resolved": "2026-03-13",
    "original_expression": null,
    "source": "inferred"
  },
  "meal_type": "breakfast",
  "record_type": "meal",
  "content_summary": "鮭→卵焼きに修正",
  "meal_description": "卵焼き",
  "weight_kg": null,
  "needs_clarification": [],
  "correction_target": {
    "target_date": "2026-03-13",
    "target_meal_type": "breakfast",
    "correction_type": "content_change",
    "new_value": {
      "content": "卵焼き"
    }
  },
  "confidence": 0.9,
  "reasoning": "直前の会話で鮭の朝食を記録。「鮭じゃなくて卵焼き」は内容修正。"
}
```

---

## 5. 画像入力への適用

### 5.1 画像解析 → Phase A 統合

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
  │
  ├─ progress_body_photo
  │     → intent_primary = 'record_progress_photo'
  │     → target_date = { source: 'timestamp', resolved: 今日 }
  │
  └─ other / unknown
        → intent_primary = 'unclear'
```

### 5.2 画像の日付・食事区分の確認

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

## 6. モード別の処理方針

### 6.1 記録モード（mode=record）

```
テキスト入力
  ↓
Phase A: interpretMessage()
  ↓
intent_primary による分岐:
  ├─ record_meal / record_weight → Phase B → Phase C
  ├─ correct_record → 修正フロー（§7参照）
  ├─ delete_record → 削除確認フロー
  ├─ consult → 「相談モードに切り替えますか？」+ そのまま回答
  ├─ greeting → 簡単な返答 + 「記録したい内容を送ってください」
  └─ unclear → 「記録したい内容を教えてください（食事・体重・写真）」
```

### 6.2 相談モード（mode=consult）

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

## 7. 修正フロー設計

### 7.1 修正対象の特定

```
「昨日の夕食を朝食に直して」
  ↓
Phase A: correction_target を生成
  {
    target_date: "2026-03-12",
    target_meal_type: "dinner",
    correction_type: "meal_type_change",
    new_value: { meal_type: "breakfast" }
  }
  ↓
Phase B: 修正対象のレコードをDBから検索
  SELECT * FROM meal_entries me
  JOIN daily_logs dl ON me.daily_log_id = dl.id
  WHERE dl.user_account_id = ? 
    AND dl.log_date = '2026-03-12'
    AND me.meal_type = 'dinner'
  ↓
  ├─ レコード見つかった
  │     → 修正内容を提示 + 確認
  │     → 確定 → UPDATE meal_entries
  │     → correction_history に記録
  │
  └─ レコード見つからない
        → 「昨日の夕食の記録が見つかりませんでした。」
```

### 7.2 修正可能な範囲

| 修正種別 | 対象テーブル | 操作 |
|---------|------------|------|
| meal_type_change | meal_entries | UPDATE meal_type |
| content_change | meal_entries | UPDATE meal_text + 栄養値再計算 |
| date_change | meal_entries + daily_logs | レコード移動（旧daily_log→新daily_log） |
| nutrition_change | meal_entries | UPDATE calories_kcal, protein_g 等 |
| delete | meal_entries | DELETE（確認必須） |
| weight_change | body_metrics | UPDATE weight_kg |

---

## 8. データフロー全体図

### 8.1 3層データストア設計

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
│  例: 「甘い物が好き」「毎朝コーヒーを飲む」              │
│  → 08_パーソナルメモリSSOT.md で詳細定義                 │
└─────────────────────────────────────────────────────────┘
```

### 8.2 conversation_messages の拡張

既存の `intent_label` カラムを活用し、Phase A の解釈結果を保存する。

```sql
-- 既存カラムの活用（スキーマ変更不要）
UPDATE conversation_messages
SET intent_label = 'record_meal',          -- Phase A の intent_primary
    normalized_text = '{"intent":...}'     -- Unified Intent JSON 全体（デバッグ用）
WHERE id = ?
```

---

## 9. 実装フェーズ

### Phase A（解釈レイヤー）— 最優先

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| A1 | `src/types/intent.ts` 作成 | 新規 | Unified Intent Schema 型定義 |
| A2 | `src/services/ai/interpret.ts` 作成 | 新規 | interpretMessage() + INTERPRETATION_PROMPT |
| A3 | `src/services/ai/interpret-image.ts` 作成 | 新規 | interpretImageResult() |
| A4 | `process-line-event.ts` 修正 | 既存 | handleRecordText → Phase A 呼び出しに変更 |
| A5 | `process-line-event.ts` 修正 | 既存 | handleConsultText → Phase A で副次記録を検出 |

### Phase B（明確化フロー）— 次優先

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| B1 | `pending_clarifications` テーブル作成 | マイグレーション | 明確化待ち状態の保存 |
| B2 | `src/services/line/clarification-handler.ts` 作成 | 新規 | 質問送信・回答受付 |
| B3 | `bot_mode_sessions` 拡張 | 既存 | pending_clarification ステップ追加 |

### Phase C（永続化レイヤー）— Phase A/B と同時

| # | タスク | 影響範囲 | 備考 |
|---|--------|---------|------|
| C1 | `src/services/line/record-persister.ts` 作成 | 新規 | Intent → DB保存の統一ハンドラ |
| C2 | `correction_history` テーブル作成 | マイグレーション | 修正履歴の記録 |
| C3 | 既存 `handleRecordText` のリファクタ | 既存 | Phase A/B/C パイプラインに置換 |

---

## 10. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。会話解釈アーキテクチャ（Phase A/B/C）、Unified Intent Schema、日付/食事区分解決ルール、入出力例、画像統合、モード別処理、修正フロー、データフロー設計を文書化 |
