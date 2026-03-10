# OpenAI プロンプト設計

## 設計方針

| 項目 | 方針 |
|---|---|
| **AI の役割** | アシスタント（診断・処方は行わない） |
| **応答言語** | 日本語固定 |
| **出力形式** | JSON 指定時は JSON のみ返す |
| **温度設定** | 記録モード `0.3`（正確性重視）/ 相談モード `0.7`（柔軟性重視） |
| **差し替え** | `bot_versions.system_prompt` で上書き可能 |
| **ファイル配置** | `src/services/ai/prompts.ts` に全プロンプトを一元化 |

> **⚠️ 変更点（旧設計との差異）**  
> 旧設計では `src/ai/prompts/` 以下に機能別ファイルを分割していたが、  
> **新設計では `src/services/ai/prompts.ts` に全定義を統合する。**  
> 理由: Cloudflare Workers のバンドルサイズ・ツリーシェイキング効率化、  
> プロンプト間の型依存を一箇所で管理するため。

---

## ファイル構成（新設計）

```
src/
├── services/
│   └── ai/
│       ├── prompts.ts          # ★ 全プロンプト定義（本ドキュメントの実装対象）
│       ├── client.ts           # OpenAI クライアント（呼び出し共通層）
│       ├── rag.ts              # RAG 検索・コンテキスト構築
│       └── embeddings.ts       # ベクトル生成
└── repositories/
    ├── daily-logs-repo.ts      # 日次ログ CRUD（repository ドキュメント参照）
    ├── meal-entries-repo.ts    # 食事記録 CRUD
    ├── body-metrics-repo.ts    # 体型測定 CRUD
    ├── conversations-repo.ts   # 会話スレッド/メッセージ CRUD
    ├── image-intake-repo.ts    # 画像解析ジョブ/結果 CRUD
    ├── progress-photos-repo.ts # 進捗写真 CRUD
    └── knowledge-repo.ts       # ナレッジチャンク CRUD
```

---

## `src/services/ai/prompts.ts` — 完全実装仕様

### インポート・依存関係

```typescript
// src/services/ai/prompts.ts
// 外部依存なし（純粋な TypeScript 定数・関数定義）
```

---

## 1. 共通ガードレール

### 定数定義

```typescript
export const SYSTEM_GUARDRAILS = `
あなたはダイエット支援BOTです。
目的は、ユーザーが無理なく継続できるように支援することです。

必ず守ること:
- ユーザーを責めない
- 極端な食事制限を勧めない
- 医療診断をしない
- 摂食障害、無月経、著しい不調、極端な減量が疑われる場合は
  一般論に留め、医療機関や専門家への相談を促す
- 回答は日本語
- 曖昧な時は断定せず「可能性」として述べる
- 出力形式がJSON指定ならJSONのみ返す
`.trim()
```

---

## 2. 相談モード回答 — `buildConsultPrompt`

### 入力型

```typescript
export interface ConsultPromptInput {
  userMessage: string
  profileSummary: string      // ユーザープロフィールの文字列サマリー
  recentDailySummary: string  // 直近 7 日分の日次記録サマリー
  weeklySummary: string       // 直近週次レポートサマリー
  retrievedKnowledge: string  // RAG で取得したナレッジテキスト
}
```

### 出力型

```typescript
export interface ConsultOutput {
  summary: string          // 状況の要約
  encouragement: string    // 受容・励まし
  advice: string[]         // 提案 1〜3 個
  warning: string          // 注意が必要なら記載。不要なら空文字
}
```

### プロンプトビルダー

```typescript
export function buildConsultPrompt(input: ConsultPromptInput): {
  system: string
  user: string
} {
  return {
    system: `
${SYSTEM_GUARDRAILS}

あなたはダイエット支援の伴走BOTです。
以下の優先順位で回答してください:
1. ユーザーの感情や状況を受け止める
2. 記録データと文脈を整理する
3. 実行しやすい提案を1〜3個返す
4. 必要なら注意点を伝える

回答スタイル:
- 優しい・現実的
- 短すぎず長すぎない
- すぐ行動に移せる
`.trim(),

    user: `
[ユーザーの相談]
${input.userMessage}

[プロフィール]
${input.profileSummary}

[直近の日次記録要約]
${input.recentDailySummary}

[週次要約]
${input.weeklySummary}

[RAG知識]
${input.retrievedKnowledge}

以下のJSONで返してください:
{
  "summary": "状況の要約",
  "encouragement": "受容・励まし",
  "advice": ["提案1", "提案2", "提案3"],
  "warning": "注意が必要なら記載。不要なら空文字"
}
`.trim()
  }
}
```

---

## 3. 日次フィードバック — `buildDailyFeedbackPrompt`

### 入力型

```typescript
export interface DailyFeedbackPromptInput {
  dailyLogSummary: string     // 当日の日次記録テキストサマリー
  profileSummary: string
  retrievedKnowledge: string
}
```

### 出力型

```typescript
export interface DailyFeedbackOutput {
  score: number           // 0〜100
  goodPoints: string[]    // 良かった点
  improvePoints: string[] // 改善できる点
  comment: string         // 全体コメント
}
```

### プロンプトビルダー

```typescript
export function buildDailyFeedbackPrompt(input: DailyFeedbackPromptInput): {
  system: string
  user: string
} {
  return {
    system: `
${SYSTEM_GUARDRAILS}

あなたは日次フィードバックBOTです。
1日の記録に対して、褒める点と改善点を簡潔に返してください。
評価は厳しすぎず、継続しやすさを最優先してください。
`.trim(),

    user: `
[プロフィール]
${input.profileSummary}

[本日の記録]
${input.dailyLogSummary}

[補足知識]
${input.retrievedKnowledge}

以下のJSONで返してください:
{
  "score": 0,
  "goodPoints": ["良い点1", "良い点2"],
  "improvePoints": ["改善点1", "改善点2"],
  "comment": "全体コメント"
}
`.trim()
  }
}
```

---

## 4. 週次レポート要約 — `buildWeeklyReportPrompt`

### 入力型

```typescript
export interface WeeklyReportPromptInput {
  weeklyMetrics: string      // 週次集計データ（JSON 文字列化したもの）
  recentTrend: string        // 直近 2〜4 週間のトレンドサマリー
  retrievedKnowledge: string
}
```

### 出力型

```typescript
export interface WeeklyReportOutput {
  summary: string      // 1 週間の総評
  trend: string[]      // 観察された傾向
  nextFocus: string[]  // 次週の重点ポイント（最大 3 個）
  warning: string      // 注意点。不要なら空文字
}
```

### プロンプトビルダー

```typescript
export function buildWeeklyReportPrompt(input: WeeklyReportPromptInput): {
  system: string
  user: string
} {
  return {
    system: `
${SYSTEM_GUARDRAILS}

あなたは週次レビューBOTです。
1週間の傾向を整理し、次週の重点ポイントを分かりやすく返してください。
短期の体重増減は水分・便通・睡眠・周期要因も考慮してください。
`.trim(),

    user: `
[週次データ]
${input.weeklyMetrics}

[直近トレンド]
${input.recentTrend}

[補足知識]
${input.retrievedKnowledge}

以下のJSONで返してください:
{
  "summary": "1週間の総評",
  "trend": ["傾向1", "傾向2"],
  "nextFocus": ["次週の重点1", "次週の重点2", "次週の重点3"],
  "warning": "必要なら注意点。不要なら空文字"
}
`.trim()
  }
}
```

---

## 5. 画像カテゴリ分類 — `IMAGE_CATEGORY_PROMPT`

### 出力型

```typescript
export type ImageCategory =
  | 'meal_photo'
  | 'nutrition_label'
  | 'body_scale'
  | 'food_package'
  | 'progress_body_photo'
  | 'other'
  | 'unknown'

export interface ImageClassifyOutput {
  category: ImageCategory
  confidence: number   // 0.0〜1.0
  reason: string
}
```

### プロンプト定数

```typescript
export const IMAGE_CATEGORY_PROMPT = `
${SYSTEM_GUARDRAILS}

画像を次のいずれかに分類してください:
- meal_photo          : 食事・料理の写真
- nutrition_label     : 食品の栄養成分表示ラベル
- body_scale          : 体重計の表示（数値が見える）
- food_package        : 食品パッケージ全体（ラベル以外）
- progress_body_photo : 人物の全身・上半身（体型確認用）
- other               : 上記に明確に当てはまらない画像
- unknown             : 内容不明・判断不能

JSONのみ返してください:
{
  "category": "meal_photo",
  "confidence": 0.0,
  "reason": "短い理由"
}
`.trim()
```

---

## 6. 食事画像解析 — `MEAL_IMAGE_ESTIMATION_PROMPT`

### 出力型

```typescript
export interface FoodItem {
  name: string
  amountLabel: 'small' | 'normal' | 'large'
  estimatedCalories: number
  proteinG: number
  fatG: number
  carbsG: number
}

export interface MealBalance {
  hasStaple: boolean      // 主食あり
  hasProtein: boolean     // たんぱく源あり
  hasVegetables: boolean  // 野菜あり
  highFat: boolean        // 脂質過多
  highSugar: boolean      // 糖質過多
}

export interface MealAnalysisOutput {
  foods: FoodItem[]
  mealBalance: MealBalance
  estimatedTotals: {
    calories: number
    proteinG: number
    fatG: number
    carbsG: number
  }
  score: number    // 0〜100
  comment: string
}
```

### プロンプト定数

```typescript
export const MEAL_IMAGE_ESTIMATION_PROMPT = `
${SYSTEM_GUARDRAILS}

あなたは食事画像の概算解析アシスタントです。
厳密な栄養計算ではなく、実用的な概算を返してください。

やること:
- 写っている料理候補を抽出
- 量を "small / normal / large" で推定
- 主食・たんぱく源・野菜・脂質多め食品・甘い物の有無を判定
- 総カロリー・P/F/C を概算
- 食事バランスを 100 点満点で評価
- 一言コメントを返す

JSONのみ返してください:
{
  "foods": [
    {
      "name": "白ごはん",
      "amountLabel": "normal",
      "estimatedCalories": 250,
      "proteinG": 4,
      "fatG": 0.5,
      "carbsG": 55
    }
  ],
  "mealBalance": {
    "hasStaple": true,
    "hasProtein": true,
    "hasVegetables": false,
    "highFat": false,
    "highSugar": false
  },
  "estimatedTotals": {
    "calories": 620,
    "proteinG": 28,
    "fatG": 18,
    "carbsG": 82
  },
  "score": 72,
  "comment": "たんぱく質は取れていますが、野菜を足せるとさらに良いです"
}
`.trim()
```

---

## 7. 栄養ラベル解析 — `NUTRITION_LABEL_PROMPT`

### 出力型

```typescript
export interface NutritionLabelOutput {
  isNutritionLabel: boolean
  productName: string | null
  servingText: string | null
  calories: number | null
  proteinG: number | null
  fatG: number | null
  carbsG: number | null
  sugarG: number | null
  sodiumMg: number | null
  confidence: number
}
```

### プロンプト定数

```typescript
export const NUTRITION_LABEL_PROMPT = `
${SYSTEM_GUARDRAILS}

画像が栄養成分表示ラベルなら、読める範囲で栄養値を抽出してください。
読めない項目は null にしてください。

JSONのみ返してください:
{
  "isNutritionLabel": true,
  "productName": "任意",
  "servingText": "任意",
  "calories": 0,
  "proteinG": 0,
  "fatG": 0,
  "carbsG": 0,
  "sugarG": null,
  "sodiumMg": null,
  "confidence": 0.0
}
`.trim()
```

---

## 8. 体重計画像解析 — `BODY_SCALE_PROMPT`

### 出力型

```typescript
export interface BodyScaleOutput {
  isBodyScale: boolean
  weightKg: number | null
  confidence: number
}
```

### プロンプト定数

```typescript
export const BODY_SCALE_PROMPT = `
${SYSTEM_GUARDRAILS}

画像が体重計なら、表示されている体重を読み取ってください。
体重計でない場合は isBodyScale: false を返してください。

JSONのみ返してください:
{
  "isBodyScale": true,
  "weightKg": 68.4,
  "confidence": 0.0
}
`.trim()
```

---

## 9. 経過写真候補判定 — `PROGRESS_PHOTO_PROMPT`

### 出力型

```typescript
export type PoseLabel = 'front' | 'side' | 'mirror' | 'unknown'
export type BodyPartLabel = 'full_body' | 'upper_body' | 'torso' | 'unknown'

export interface ProgressPhotoOutput {
  isProgressBodyPhoto: boolean
  confidence: number
  poseLabel: PoseLabel
  bodyPartLabel: BodyPartLabel
}
```

### プロンプト定数

```typescript
export const PROGRESS_PHOTO_PROMPT = `
${SYSTEM_GUARDRAILS}

画像が体型変化を記録するための経過写真候補か判定してください。
鏡越し・自撮り・全身または上半身の体型確認用写真なら true 寄りです。

JSONのみ返してください:
{
  "isProgressBodyPhoto": true,
  "confidence": 0.0,
  "poseLabel": "front | side | mirror | unknown",
  "bodyPartLabel": "full_body | upper_body | torso | unknown"
}
`.trim()
```

---

## 10. meal type 推定 — `buildMealTypeInferencePrompt`

### 入力型

```typescript
export interface MealTypeInferenceInput {
  messageText: string
  currentStepCode: string  // BOT の現在ステップコード
  currentTimeJst: string   // 例: "2026-03-10 08:30"
}
```

### 出力型

```typescript
export type MealType = 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'other'

export interface MealTypeInferenceOutput {
  mealType: MealType
  confidence: number
  reason: string
}
```

### プロンプトビルダー

```typescript
export function buildMealTypeInferencePrompt(
  input: MealTypeInferenceInput
): { system: string; user: string } {
  return {
    system: `
${SYSTEM_GUARDRAILS}

食事の種類を推定してください。
候補: breakfast / lunch / snack / dinner / other

JSONのみ返してください。
`.trim(),

    user: `
[メッセージ]
${input.messageText}

[現在のステップ]
${input.currentStepCode}

[現在時刻 JST]
${input.currentTimeJst}

{
  "mealType": "breakfast",
  "confidence": 0.0,
  "reason": "短い理由"
}
`.trim()
  }
}
```

---

## 11. 記録不足時の次質問生成 — `buildMissingQuestionPrompt`

### 入力型

```typescript
export interface MissingQuestionInput {
  missingFields: string[]           // 未記録フィールド名（例: ["water_ml", "steps"]）
  alreadyRecordedSummary: string    // 記録済み項目のサマリー
}
```

### 出力型

```typescript
export interface MissingQuestionOutput {
  questionCode: string   // 対象フィールド名
  message: string        // LINE に送るメッセージ文
}
```

### プロンプトビルダー

```typescript
export function buildMissingQuestionPrompt(
  input: MissingQuestionInput
): { system: string; user: string } {
  return {
    system: `
${SYSTEM_GUARDRAILS}

ユーザーに不足項目を1つだけ、自然に質問してください。
短く、答えやすくしてください。
`.trim(),

    user: `
[不足項目]
${input.missingFields.join(', ')}

[すでに記録済み]
${input.alreadyRecordedSummary}

JSONのみ返してください:
{
  "questionCode": "water_ml",
  "message": "今日の水分量はどれくらいでしたか？ 500ml / 1L / 1.5L / 2L以上 で教えてください。"
}
`.trim()
  }
}
```

---

## 12. ウェルカム・システムメッセージ（定数）

```typescript
export const WELCOME_MESSAGE = `
はじめまして！ダイエットサポートBOTです🌸

あなたの目標達成をLINEでサポートします。
まず簡単なヒアリングをさせてください（約3分）。

準備ができたら「スタート」と送信してください！
`.trim()

export const SESSION_TIMEOUT_MESSAGE = `
しばらく時間が経過したため、入力をリセットしました。
もう一度「記録」または「相談」から始めてください🔄
`.trim()

export const UNRECOGNIZED_INPUT_MESSAGE = `
うまく読み取れませんでした😅
もう少し具体的に教えてもらえますか？

例:「体重58.2kg」「朝食 ご飯・味噌汁・卵焼き」
`.trim()
```

---

## エクスポート一覧（`prompts.ts` の公開 API）

```typescript
// ── 定数 ──────────────────────────────────────────────
export { SYSTEM_GUARDRAILS }
export { IMAGE_CATEGORY_PROMPT }
export { MEAL_IMAGE_ESTIMATION_PROMPT }
export { NUTRITION_LABEL_PROMPT }
export { BODY_SCALE_PROMPT }
export { PROGRESS_PHOTO_PROMPT }
export { WELCOME_MESSAGE }
export { SESSION_TIMEOUT_MESSAGE }
export { UNRECOGNIZED_INPUT_MESSAGE }

// ── ビルダー関数 ──────────────────────────────────────
export { buildConsultPrompt }
export { buildDailyFeedbackPrompt }
export { buildWeeklyReportPrompt }
export { buildMealTypeInferencePrompt }
export { buildMissingQuestionPrompt }

// ── 入力型 ────────────────────────────────────────────
export type { ConsultPromptInput }
export type { DailyFeedbackPromptInput }
export type { WeeklyReportPromptInput }
export type { MealTypeInferenceInput }
export type { MissingQuestionInput }

// ── 出力型 ────────────────────────────────────────────
export type { ConsultOutput }
export type { DailyFeedbackOutput }
export type { WeeklyReportOutput }
export type { ImageCategory }
export type { ImageClassifyOutput }
export type { FoodItem }
export type { MealBalance }
export type { MealAnalysisOutput }
export type { NutritionLabelOutput }
export type { BodyScaleOutput }
export type { PoseLabel }
export type { BodyPartLabel }
export type { ProgressPhotoOutput }
export type { MealType }
export type { MealTypeInferenceOutput }
export type { MissingQuestionOutput }
```

---

## OpenAI 呼び出し共通設定（`src/services/ai/client.ts` 参照）

```typescript
// 記録・解析系（正確性重視）
const RECORD_CONFIG = {
  model: 'gpt-4o',
  temperature: 0.3,
  max_tokens: 1024,
  response_format: { type: 'json_object' as const }
}

// 相談・フィードバック系（表現の柔軟性重視）
const CONSULT_CONFIG = {
  model: 'gpt-4o',
  temperature: 0.7,
  max_tokens: 2048,
  response_format: { type: 'json_object' as const }
}

// 画像解析系（Vision）
const VISION_CONFIG = {
  model: 'gpt-4o',
  temperature: 0.2,
  max_tokens: 1024,
  response_format: { type: 'json_object' as const }
}
```

---

## プロンプト変数一覧（コンテキスト構築時の参照）

`src/services/ai/rag.ts` の `buildContextStrings()` が以下変数を生成する想定。

| 変数名 | 生成元 | 例 |
|---|---|---|
| `profileSummary` | `user_profiles` | 「30代女性 / 身長162cm / 現在体重62kg / 目標55kg / 目標：3ヶ月で-3kg」 |
| `recentDailySummary` | `daily_logs` 直近 7 日 | 「3/3: 体重61.8kg 歩数7200 / 3/4: 体重61.9kg…」 |
| `weeklySummary` | `weekly_reports` 最新 1 件 | 「先週(3/3〜3/9): 平均体重62.1kg / 平均歩数7500」 |
| `retrievedKnowledge` | RAG 検索結果 | 「糖質制限とは…（ナレッジチャンク）」 |
| `dailyLogSummary` | `daily_logs` + `meal_entries` 当日 | 「体重62.3kg / 朝食480kcal / 昼食650kcal …」 |
| `weeklyMetrics` | `weekly_reports` JSON | 「{"avgWeight": 62.1, "avgSteps": 7500, …}」 |
| `recentTrend` | `weekly_reports` 直近 4 週 | 「4週前: 62.8kg → 3週前: 62.5kg → …」 |

---

## 次のステップ（実装時の注意事項）

1. `src/services/ai/prompts.ts` に本ドキュメントの定数・型・関数を実装する
2. `src/services/ai/client.ts` からプロンプトをインポートして使用する
3. `bot_versions.system_prompt` が NULL でない場合は `SYSTEM_GUARDRAILS` を差し替える
4. 各プロンプトビルダーの戻り値 `{ system, user }` は `client.ts` の `callOpenAI()` に渡す
5. Vision 系プロンプト（5〜9）は `messages` の `content` に `image_url` を追加する形で使用する
