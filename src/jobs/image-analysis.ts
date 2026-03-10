/**
 * src/jobs/image-analysis.ts
 * Cloudflare Queue Consumer — 画像解析ジョブ処理
 *
 * Phase 1:
 *   - Queue から ImageAnalysisQueueMessage を受け取る
 *   - R2 から画像を取得し OpenAI Vision で解析
 *   - image_intake_results に結果を保存
 *   - image_analysis_jobs のステータスを更新
 *
 * Phase 2+ (将来拡張):
 *   - 日本食品辞書との照合
 *   - 高精度食事解析 API との連携
 */

import type { Bindings, LineQueueMessage, ImageAnalysisQueueMessage } from '../types/bindings'
import { updateJobStatus, saveImageIntakeResult, findJobByAttachmentId } from '../repositories/image-intake-repo'
import { createOpenAIClient } from '../services/ai/openai-client'
import { pushText } from '../services/line/reply'
import { nowIso } from '../utils/id'

// ===================================================================
// Queue Consumer エクスポート
// Cloudflare Workers の queue ハンドラーとして export する
// ===================================================================

export async function lineQueueConsumer(
  batch: MessageBatch<LineQueueMessage>,
  env: Bindings
): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body

    try {
      if (payload.type === 'image_analysis') {
        await handleImageAnalysis(payload, env)
        message.ack()
      } else {
        // 未知のメッセージタイプは ack して捨てる（リトライしない）
        console.warn('[Queue] Unknown message type:', (payload as { type: string }).type)
        message.ack()
      }
    } catch (err) {
      console.error('[Queue] Message processing failed:', err)
      // nack すると Cloudflare が自動リトライする
      message.retry()
    }
  }
}

// ===================================================================
// 画像解析ジョブ本体
// ===================================================================

async function handleImageAnalysis(
  payload: ImageAnalysisQueueMessage,
  env: Bindings
): Promise<void> {
  const { attachmentId, userAccountId, clientAccountId, threadId, r2Key, lineUserId } = payload

  // ------------------------------------------------------------------
  // 1. ジョブステータスを 'processing' に更新
  // ------------------------------------------------------------------
  const job = await findJobByAttachmentId(env.DB, attachmentId)
  if (!job) {
    console.warn(`[ImageAnalysis] job not found for attachment: ${attachmentId}`)
    return
  }

  await updateJobStatus(env.DB, job.id, 'processing')

  try {
    // ------------------------------------------------------------------
    // 2. R2 から画像を取得し Base64 に変換
    // ------------------------------------------------------------------
    const r2Object = await env.R2.get(r2Key)
    if (!r2Object) {
      throw new Error(`R2 object not found: ${r2Key}`)
    }
    const arrayBuffer = await r2Object.arrayBuffer()
    const base64 = arrayBufferToBase64(arrayBuffer)
    const contentType = r2Object.httpMetadata?.contentType ?? 'image/jpeg'
    const dataUrl = `data:${contentType};base64,${base64}`

    // ------------------------------------------------------------------
    // 3. OpenAI Vision で画像カテゴリを判定
    // ------------------------------------------------------------------
    const ai = createOpenAIClient(env)

    const categoryResult = await ai.createVisionResponse(
      IMAGE_CATEGORY_SYSTEM_PROMPT,
      IMAGE_CATEGORY_USER_PROMPT,
      dataUrl,
      { responseFormat: 'json_object', maxTokens: 256, imageDetail: 'low' }
    )

    let categoryJson: ImageCategoryResult
    try {
      categoryJson = JSON.parse(categoryResult) as ImageCategoryResult
    } catch {
      categoryJson = { category: 'unknown', confidence: 0, reason: 'parse error' }
    }

    const category = VALID_IMAGE_CATEGORIES.includes(categoryJson.category as ImageCategory)
      ? (categoryJson.category as ImageCategory)
      : 'unknown'

    // ------------------------------------------------------------------
    // 4. カテゴリに応じた詳細解析
    // ------------------------------------------------------------------
    let extractedJson: Record<string, unknown> = {}
    let proposedActionJson: Record<string, unknown> = {}
    let replyMessage = ''

    if (category === 'meal_photo' || category === 'food_package') {
      const mealResult = await analyzeMealImage(ai, dataUrl, category)
      extractedJson = mealResult.extracted
      proposedActionJson = mealResult.proposed
      replyMessage = buildMealReplyMessage(mealResult.extracted)
    } else if (category === 'nutrition_label') {
      const labelResult = await analyzeNutritionLabel(ai, dataUrl)
      extractedJson = labelResult.extracted
      proposedActionJson = labelResult.proposed
      replyMessage = buildNutritionLabelReplyMessage(labelResult.extracted)
    } else if (category === 'body_scale') {
      const scaleResult = await analyzeBodyScale(ai, dataUrl)
      extractedJson = scaleResult.extracted
      proposedActionJson = scaleResult.proposed
      replyMessage = buildScaleReplyMessage(scaleResult.extracted)
    } else if (category === 'progress_body_photo') {
      extractedJson = { category: 'progress_body_photo', note: '経過写真を保存しました' }
      proposedActionJson = { action: 'store_progress_photo', userAccountId }
      replyMessage = '📸 経過写真を保存しました！継続は力なりです 💪'
    } else {
      extractedJson = { category, note: '解析対象外の画像です' }
      replyMessage = '画像を受け取りましたが、食事・体重・栄養ラベルの画像を送ると詳細な記録ができます 📷'
    }

    // ------------------------------------------------------------------
    // 5. image_intake_results に保存
    // ------------------------------------------------------------------
    await saveImageIntakeResult(env.DB, {
      messageAttachmentId: attachmentId,
      userAccountId,
      imageCategory: category,
      confidenceScore: categoryJson.confidence ?? null,
      extractedJson,
      proposedActionJson,
      appliedFlag: 0,
    })

    // ------------------------------------------------------------------
    // 6. ジョブステータスを 'completed' に更新
    // ------------------------------------------------------------------
    await updateJobStatus(env.DB, job.id, 'completed')

    // ------------------------------------------------------------------
    // 7. LINE プッシュ通知で結果をユーザーに返却
    // ------------------------------------------------------------------
    await pushText(lineUserId, replyMessage, env.LINE_CHANNEL_ACCESS_TOKEN)

    console.log(`[ImageAnalysis] completed: attachment=${attachmentId} category=${category}`)

  } catch (err) {
    // ------------------------------------------------------------------
    // エラー処理
    // ------------------------------------------------------------------
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[ImageAnalysis] failed: attachment=${attachmentId}`, err)

    await updateJobStatus(env.DB, job.id, 'failed', errorMessage)

    // ユーザーにエラー通知
    try {
      await pushText(
        lineUserId,
        '画像の解析に失敗しました。テキストで入力をお試しください 🙇',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } catch {
      // push 失敗は無視
    }

    throw err // nack → retry
  }
}

// ===================================================================
// 画像カテゴリ判定プロンプト
// ===================================================================

const VALID_IMAGE_CATEGORIES = [
  'meal_photo',
  'nutrition_label',
  'body_scale',
  'food_package',
  'progress_body_photo',
  'other',
  'unknown',
] as const

type ImageCategory = (typeof VALID_IMAGE_CATEGORIES)[number]

type ImageCategoryResult = {
  category: string
  confidence: number
  reason: string
}

const IMAGE_CATEGORY_SYSTEM_PROMPT = `あなたは画像分類AIです。
送られた画像を以下のカテゴリのいずれか1つに分類し、JSONで返してください。

カテゴリ一覧:
- meal_photo: 食事・料理の写真
- nutrition_label: 栄養成分表示ラベル
- body_scale: 体重計・体組成計の画面
- food_package: 食品パッケージ（栄養ラベルなし）
- progress_body_photo: 体型・身体の経過写真
- other: その他の写真
- unknown: 判別不能

必ず以下のJSON形式で返してください:
{"category": "カテゴリ名", "confidence": 0.0〜1.0の確信度, "reason": "判断理由（簡潔に）"}`

const IMAGE_CATEGORY_USER_PROMPT = 'この画像を分類してください。'

// ===================================================================
// 食事画像解析
// ===================================================================

type MealAnalysisResult = {
  extracted: Record<string, unknown>
  proposed: Record<string, unknown>
}

async function analyzeMealImage(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  category: ImageCategory
): Promise<MealAnalysisResult> {
  const systemPrompt = `あなたは栄養士AIです。食事の写真から食品名と推定栄養素を抽出してください。
以下のJSON形式で返してください:
{
  "foods": [{"name": "食品名", "amount_g": 推定グラム数, "calories": 推定カロリー, "protein_g": タンパク質, "fat_g": 脂質, "carbs_g": 炭水化物}],
  "total_calories": 合計カロリー,
  "meal_type_guess": "breakfast/lunch/dinner/snack/other",
  "confidence": 0.0〜1.0
}
不明な項目はnullにしてください。`

  try {
    const result = await ai.createVisionResponse(
      systemPrompt,
      `この${category === 'food_package' ? '食品パッケージ' : '食事の写真'}から食品情報を抽出してください。`,
      dataUrl,
      { responseFormat: 'json_object', maxTokens: 512, imageDetail: 'high' }
    )
    const parsed = JSON.parse(result)
    return {
      extracted: parsed,
      proposed: {
        action: 'create_meal_entry',
        meal_type: parsed.meal_type_guess ?? 'other',
        calories: parsed.total_calories,
      },
    }
  } catch {
    return {
      extracted: { error: 'parse_failed' },
      proposed: { action: 'manual_entry' },
    }
  }
}

function buildMealReplyMessage(extracted: Record<string, unknown>): string {
  if (extracted.error) {
    return '🍽 食事写真を受け取りました。詳細はテキストで教えてください。'
  }
  const calories = extracted.total_calories
  const foods = extracted.foods as Array<{ name: string }> | undefined
  const foodNames = foods?.map(f => f.name).slice(0, 3).join('、') ?? '不明'
  return `🍽 食事を解析しました！\n\n主な食品: ${foodNames}\n推定カロリー: ${calories ?? '不明'} kcal\n\n記録を確定しますか？`
}

// ===================================================================
// 栄養ラベル解析
// ===================================================================

async function analyzeNutritionLabel(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string
): Promise<MealAnalysisResult> {
  const systemPrompt = `栄養成分表示ラベルから数値を正確に読み取ってください。
以下のJSON形式で返してください:
{
  "product_name": "商品名（読み取れる場合）",
  "serving_size_g": 1食分の量（g）,
  "calories": カロリー（kcal）,
  "protein_g": タンパク質（g）,
  "fat_g": 脂質（g）,
  "carbs_g": 炭水化物（g）,
  "sodium_mg": 食塩相当量をナトリウムmgに換算,
  "confidence": 0.0〜1.0
}
読み取れない項目はnullにしてください。`

  try {
    const result = await ai.createVisionResponse(
      systemPrompt,
      'この栄養成分表示ラベルを読み取ってください。',
      dataUrl,
      { responseFormat: 'json_object', maxTokens: 512, imageDetail: 'high' }
    )
    const parsed = JSON.parse(result)
    return {
      extracted: parsed,
      proposed: {
        action: 'create_nutrition_intake',
        calories: parsed.calories,
        serving_size_g: parsed.serving_size_g,
      },
    }
  } catch {
    return {
      extracted: { error: 'parse_failed' },
      proposed: { action: 'manual_entry' },
    }
  }
}

function buildNutritionLabelReplyMessage(extracted: Record<string, unknown>): string {
  if (extracted.error) {
    return '🏷 栄養ラベルを受け取りました。読み取りに失敗しました。テキストで入力してください。'
  }
  const calories = extracted.calories
  const protein = extracted.protein_g
  const carbs = extracted.carbs_g
  return `🏷 栄養ラベルを読み取りました！\n\nカロリー: ${calories ?? '不明'} kcal\nタンパク質: ${protein ?? '不明'} g\n炭水化物: ${carbs ?? '不明'} g`
}

// ===================================================================
// 体重計画面解析
// ===================================================================

async function analyzeBodyScale(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string
): Promise<MealAnalysisResult> {
  const systemPrompt = `体重計・体組成計の画面から数値を読み取ってください。
以下のJSON形式で返してください:
{
  "weight_kg": 体重（kg）,
  "body_fat_percent": 体脂肪率（%）または null,
  "muscle_mass_kg": 筋肉量（kg）または null,
  "bmi": BMI または null,
  "confidence": 0.0〜1.0
}
読み取れない項目はnullにしてください。`

  try {
    const result = await ai.createVisionResponse(
      systemPrompt,
      'この体重計の画面を読み取ってください。',
      dataUrl,
      { responseFormat: 'json_object', maxTokens: 256, imageDetail: 'high' }
    )
    const parsed = JSON.parse(result)
    return {
      extracted: parsed,
      proposed: {
        action: 'upsert_weight',
        weight_kg: parsed.weight_kg,
        body_fat_percent: parsed.body_fat_percent,
      },
    }
  } catch {
    return {
      extracted: { error: 'parse_failed' },
      proposed: { action: 'manual_entry' },
    }
  }
}

function buildScaleReplyMessage(extracted: Record<string, unknown>): string {
  if (extracted.error) {
    return '⚖️ 体重計の写真を受け取りました。テキストで体重を入力してください（例: 65.2kg）'
  }
  const weight = extracted.weight_kg
  const fat = extracted.body_fat_percent
  let msg = `⚖️ 体重を読み取りました！\n\n体重: ${weight ?? '不明'} kg`
  if (fat != null) msg += `\n体脂肪率: ${fat} %`
  msg += '\n\n記録を確定しますか？'
  return msg
}

// ===================================================================
// ユーティリティ
// ===================================================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
