/**
 * OpenAI プロンプトテンプレート集
 * diet-bot - AI アシスタント用プロンプト
 */

import type { UserProfile, MealEntry, DailyLog } from '../types/models'

// ===================================================================
// 共通ユーティリティ
// ===================================================================

const BASE_PERSONA = `あなたはダイエット専門のAIアシスタントです。
ユーザーの食事・運動・体重記録を管理し、科学的根拠に基づいたアドバイスを提供します。
- 常に励ましながら、具体的で実践的なアドバイスをしてください
- 医療診断は行わず、気になる症状は専門医への相談を促してください
- 日本語で、丁寧かつ親しみやすい口調で応答してください`

function formatProfile(profile: UserProfile | null): string {
  if (!profile) return '（プロファイル未設定）'
  const parts = []
  if (profile.nickname) parts.push(`名前: ${profile.nickname}`)
  if (profile.gender) parts.push(`性別: ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : 'その他'}`)
  if (profile.age_range) parts.push(`年代: ${profile.age_range}`)
  if (profile.height_cm) parts.push(`身長: ${profile.height_cm}cm`)
  if (profile.current_weight_kg) parts.push(`現在の体重: ${profile.current_weight_kg}kg`)
  if (profile.target_weight_kg) parts.push(`目標体重: ${profile.target_weight_kg}kg`)
  if (profile.goal_summary) parts.push(`目標: ${profile.goal_summary}`)
  if (profile.activity_level) parts.push(`活動レベル: ${profile.activity_level}`)
  return parts.join(' / ')
}

// ===================================================================
// 1. 相談モード（Consult Mode）
// ===================================================================

export function buildConsultSystemPrompt(profile: UserProfile | null): string {
  return `${BASE_PERSONA}

【ユーザー情報】
${formatProfile(profile)}

【相談モードのルール】
- ユーザーのダイエットや健康に関する質問に答えてください
- 1回の返答は200文字以内を目安にしてください
- 必要に応じて具体的な食事例や運動メニューを提案してください
- 医療的な判断が必要な場合は、かかりつけ医への相談を勧めてください
- 答えられない質問（投資・法律・医療診断等）はその旨を伝えてください`
}

export function buildConsultUserMessage(
  userMessage: string,
  recentHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return [
    ...recentHistory,
    { role: 'user', content: userMessage }
  ]
}

// ===================================================================
// 2. 日次フィードバック（Daily Feedback）
// ===================================================================

export function buildDailyFeedbackPrompt(
  profile: UserProfile | null,
  dailyLog: DailyLog,
  meals: MealEntry[]
): string {
  const totalCalories = meals.reduce((sum, m) => sum + (m.estimated_calories || 0), 0)
  const totalProtein = meals.reduce((sum, m) => sum + (m.estimated_protein_g || 0), 0)
  const totalFat = meals.reduce((sum, m) => sum + (m.estimated_fat_g || 0), 0)
  const totalCarbs = meals.reduce((sum, m) => sum + (m.estimated_carbs_g || 0), 0)

  const mealSummary = meals.length > 0
    ? meals.map(m => `・${m.meal_type}：${m.description || '記録あり'}（${m.estimated_calories || '?'}kcal）`).join('\n')
    : '食事記録なし'

  return `${BASE_PERSONA}

【本日の記録】
日付: ${dailyLog.log_date}
体重: ${dailyLog.weight_kg ? `${dailyLog.weight_kg}kg` : '未記録'}
歩数: ${dailyLog.steps ? `${dailyLog.steps}歩` : '未記録'}
睡眠: ${dailyLog.sleep_hours ? `${dailyLog.sleep_hours}時間` : '未記録'}
水分: ${dailyLog.water_ml ? `${dailyLog.water_ml}ml` : '未記録'}
気分: ${dailyLog.mood_score ? `${dailyLog.mood_score}/5` : '未記録'}
コメント: ${dailyLog.notes || 'なし'}

【食事記録】
${mealSummary}
合計: ${totalCalories}kcal / タンパク質${totalProtein.toFixed(1)}g / 脂質${totalFat.toFixed(1)}g / 炭水化物${totalCarbs.toFixed(1)}g

【ユーザー情報】
${formatProfile(profile)}

上記の記録をもとに、今日の振り返りと明日への励ましメッセージを200文字以内で生成してください。
良かった点を称え、改善点は具体的かつ前向きに伝えてください。`
}

// ===================================================================
// 3. 週次レポート（Weekly Report）
// ===================================================================

export function buildWeeklyReportPrompt(
  profile: UserProfile | null,
  weekStart: string,
  weekEnd: string,
  logs: DailyLog[],
  allMeals: MealEntry[]
): string {
  const avgWeight = logs.filter(l => l.weight_kg).reduce((sum, l, _, arr) =>
    sum + (l.weight_kg || 0) / arr.length, 0)
  const avgCalories = allMeals.length > 0
    ? allMeals.reduce((sum, m) => sum + (m.estimated_calories || 0), 0) / 7
    : 0
  const logDays = logs.length

  return `${BASE_PERSONA}

【週次レポート期間】
${weekStart} 〜 ${weekEnd}

【週の統計】
記録日数: ${logDays}/7日
平均体重: ${avgWeight > 0 ? `${avgWeight.toFixed(1)}kg` : '記録なし'}
1日平均カロリー: ${avgCalories > 0 ? `${Math.round(avgCalories)}kcal` : '記録なし'}
開始体重: ${logs[0]?.weight_kg ? `${logs[0].weight_kg}kg` : '記録なし'}
最終体重: ${logs[logs.length - 1]?.weight_kg ? `${logs[logs.length - 1].weight_kg}kg` : '記録なし'}

【ユーザー情報】
${formatProfile(profile)}

上記データをもとに、週次レポートのサマリーを作成してください。
・今週の振り返り（良かった点、課題）
・来週に向けたアドバイス（具体的な行動提案を1〜2つ）
全体で300文字以内にまとめてください。`
}

// ===================================================================
// 4. 画像分類（Image Classification）
// ===================================================================

export const IMAGE_CLASSIFICATION_PROMPT = `あなたは画像認識AIです。送られてきた画像を以下のカテゴリのいずれかに分類してください。

カテゴリ:
- meal_photo: 食事・食べ物の写真
- nutrition_label: 食品の栄養成分表示ラベル
- body_scale: 体重計の画面（数値が表示されているもの）
- progress_body_photo: 人物の体型確認写真（進捗確認用）
- other: 上記以外

必ず以下のJSON形式で回答してください:
{
  "type": "カテゴリ名",
  "confidence": 0.0〜1.0,
  "reason": "判断理由（日本語で30文字以内）"
}`

// ===================================================================
// 5. 食事画像解析（Meal Image Analysis）
// ===================================================================

export const MEAL_IMAGE_ANALYSIS_SYSTEM = `あなたは日本食・洋食・中華料理等に精通した栄養士AIです。
食事の写真から料理名・量・栄養価を推定します。
不明な場合は一般的な量・栄養価を参考に推定し、必ず回答してください。`

export function buildMealImageAnalysisPrompt(mealType: string): string {
  const mealTypeJa: Record<string, string> = {
    breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食', drink: '飲み物'
  }
  return `この${mealTypeJa[mealType] || '食事'}の写真を解析してください。

以下のJSON形式で回答してください:
{
  "dishes": [
    {
      "name": "料理名",
      "quantity": "量の目安（例:1人前、茶碗1杯）",
      "estimated_calories": カロリー数値,
      "protein_g": タンパク質g,
      "fat_g": 脂質g,
      "carbs_g": 炭水化物g,
      "confidence": 信頼度0.0-1.0
    }
  ],
  "total_calories": 合計カロリー,
  "total_protein_g": 合計タンパク質g,
  "total_fat_g": 合計脂質g,
  "total_carbs_g": 合計炭水化物g,
  "nutrition_score": 栄養バランススコア0-100,
  "ai_comment": "この食事についての短いコメント（日本語、50文字以内）"
}`
}

// ===================================================================
// 6. 栄養成分ラベル解析（Nutrition Label Analysis）
// ===================================================================

export const NUTRITION_LABEL_ANALYSIS_PROMPT = `この食品の栄養成分表示ラベルを読み取ってください。

以下のJSON形式で回答してください:
{
  "product_name": "商品名（読み取れない場合はnull）",
  "serving_size": "1食分の量（例:100g, 1袋）",
  "calories_per_serving": 1食分カロリー,
  "protein_g": タンパク質g,
  "fat_g": 脂質g,
  "carbs_g": 炭水化物g,
  "sodium_mg": ナトリウムmg（読み取れない場合はnull）,
  "confidence": 読み取り信頼度0.0-1.0
}`

// ===================================================================
// 7. 体重計画像解析（Scale Image Analysis）
// ===================================================================

export const SCALE_IMAGE_ANALYSIS_PROMPT = `この体重計の画面から数値を読み取ってください。

以下のJSON形式で回答してください:
{
  "weight_kg": 体重の数値（読み取れない場合はnull）,
  "body_fat_pct": 体脂肪率の数値（表示されていない場合はnull）,
  "confidence": 読み取り信頼度0.0-1.0,
  "raw_text": "画面に表示されていたテキスト全て"
}`

// ===================================================================
// 8. 進捗写真判定（Progress Photo Judgment）
// ===================================================================

export const PROGRESS_PHOTO_SYSTEM = `あなたはダイエット進捗写真の管理AIです。
送られてきた写真が進捗確認用の体型写真かどうかを判定し、適切に保存案内をします。`

export const PROGRESS_PHOTO_PROMPT = `この写真を確認しました。

以下のJSON形式で回答してください:
{
  "is_body_photo": true/false,
  "confidence": 0.0-1.0,
  "message": "ユーザーへの返信メッセージ（日本語、50文字以内）"
}`

// ===================================================================
// 9. ナレッジBOT（Knowledge Q&A）
// ===================================================================

export function buildKnowledgePrompt(
  userQuestion: string,
  knowledgeContext: string,
  profile: UserProfile | null
): string {
  return `${BASE_PERSONA}

【参考情報（ナレッジベース）】
${knowledgeContext || '（関連情報なし）'}

【ユーザー情報】
${formatProfile(profile)}

上記の参考情報とユーザー情報をもとに、以下の質問に回答してください。
参考情報に答えがない場合は、一般的なダイエット知識を使って回答してください。

質問: ${userQuestion}

200文字以内で回答してください。`
}

// ===================================================================
// 10. ヒアリングBOT（Intake Mode）
// ===================================================================

export const INTAKE_WELCOME_MESSAGE = `こんにちは！ダイエットサポートBOTです🌿

まずはあなたのことを教えてください。
いくつか質問させていただきます（全部で約5〜7問、2〜3分で完了します）。

準備ができたら「はじめる」と送ってください✨`

export const INTAKE_QUESTIONS: Record<string, { message: string; key: string }> = {
  nickname: {
    key: 'nickname',
    message: 'お名前またはニックネームを教えてください😊'
  },
  gender: {
    key: 'gender',
    message: '性別を選んでください：\n\n1️⃣ 男性\n2️⃣ 女性\n3️⃣ 答えたくない'
  },
  age_range: {
    key: 'age_range',
    message: '年代を教えてください：\n\n1️⃣ 10代\n2️⃣ 20代\n3️⃣ 30代\n4️⃣ 40代\n5️⃣ 50代\n6️⃣ 60代以上'
  },
  height_cm: {
    key: 'height_cm',
    message: '身長を数字で教えてください（例: 160）\n単位はcmです📏'
  },
  current_weight_kg: {
    key: 'current_weight_kg',
    message: '現在の体重を数字で教えてください（例: 65.5）\n単位はkgです⚖️'
  },
  target_weight_kg: {
    key: 'target_weight_kg',
    message: '目標体重を数字で教えてください（例: 58）\n単位はkgです🎯'
  },
  goal_summary: {
    key: 'goal_summary',
    message: 'ダイエットを始めようと思ったきっかけや、どんな自分になりたいかを教えてください✨\n（自由にどうぞ、スキップする場合は「スキップ」と送ってください）'
  }
}

export const INTAKE_COMPLETE_MESSAGE = (nickname: string, targetWeight: number, currentWeight: number) =>
  `ありがとうございます、${nickname}さん！🎉

プロフィールの設定が完了しました✅

📊 目標まで: ${(currentWeight - targetWeight).toFixed(1)}kg減
🗓️ これから一緒に頑張りましょう！

毎日の食事や体重を記録することで、より精度の高いアドバイスができます。
記録するときは「記録」と送ってください📝`

// ===================================================================
// 11. デイリーリマインダー（Daily Reminder）
// ===================================================================

export function buildReminderMessage(nickname: string, hasLoggedToday: boolean): string {
  if (hasLoggedToday) {
    return `${nickname}さん、今日の記録を確認しました✅
引き続き素晴らしい取り組みですね！
何かご相談があれば「相談」と送ってください😊`
  }
  return `${nickname}さん、こんにちは！🌞
今日の食事や体重の記録はお済みですか？

「記録」と送ると記録を開始できます📝
記録を続けることが目標達成への近道です！`
}
