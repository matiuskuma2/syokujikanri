/**
 * src/jobs/image-analysis.ts
 * Cloudflare Queue Consumer — 画像解析ジョブ処理
 *
 * Queue から受け取るメッセージ型:
 *   ImageAnalysisQueueMessage { type: 'image_analysis', attachmentId, userAccountId,
 *                                clientAccountId, threadId, r2Key, lineUserId }
 *
 * 処理フロー:
 *   1. image_analysis_jobs を 'processing' に更新
 *   2. R2 から画像を取得 → base64 Data URL に変換
 *   3. OpenAI Vision で画像カテゴリ・内容を解析
 *   4. カテゴリに応じたアクションを実行（meal / scale / label / progress / other）
 *   5. image_intake_results を保存
 *   6. image_analysis_jobs を 'done' / 'failed' に更新
 *   7. LINE push で結果をユーザーに通知
 *
 * エラーポリシー:
 *   - 各メッセージ単位で try/catch → 失敗は job を 'failed' に更新してログ出力
 *   - Queue 全体はクラッシュさせない
 */

import type { Bindings, LineQueueMessage, ImageAnalysisQueueMessage } from '../types/bindings'
import { getMessageAttachmentById } from '../repositories/attachments-repo'
import { findJobByAttachmentId, updateJobStatus, saveImageIntakeResult } from '../repositories/image-intake-repo'
import { ensureDailyLog } from '../repositories/daily-logs-repo'
import { createMealEntry, updateMealEntryFromEstimate } from '../repositories/meal-entries-repo'
import { upsertWeight } from '../repositories/body-metrics-repo'
import { createConversationMessage } from '../repositories/conversations-repo'
import { createOpenAIClient } from '../services/ai/openai-client'
import { pushText } from '../services/line/reply'
import { nowIso, todayJst } from '../utils/id'
import type { ImageCategory } from '../types/db'

// ===================================================================
// Queue Consumer エクスポート
// Cloudflare Workers の queue ハンドラとして index.ts から
//   export { lineQueueConsumer as queue }
// する形で使う
// ===================================================================

export async function lineQueueConsumer(
  batch: MessageBatch<LineQueueMessage>,
  env: Bindings
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const payload = msg.body

      if (payload.type === 'image_analysis') {
        await processImageAnalysis(payload, env)
      } else {
        console.log(`[Queue] Unhandled message type: ${(payload as { type: string }).type}`)
      }

      msg.ack()
    } catch (err) {
      console.error('[Queue] Message processing failed:', err)
      msg.retry()
    }
  }
}

// ===================================================================
// 画像解析メインロジック
// ===================================================================

async function processImageAnalysis(
  payload: ImageAnalysisQueueMessage,
  env: Bindings
): Promise<void> {
  const { attachmentId, userAccountId, clientAccountId, threadId, r2Key, lineUserId } = payload

  // ------------------------------------------------------------------
  // 1. ジョブを 'processing' に更新
  // ------------------------------------------------------------------
  const job = await findJobByAttachmentId(env.DB, attachmentId)
  if (!job) {
    console.error(`[ImageAnalysis] Job not found for attachment=${attachmentId}`)
    return
  }
  await updateJobStatus(env.DB, job.id, 'processing')

  try {
    // ------------------------------------------------------------------
    // 2. R2 から画像バイナリ取得
    // ------------------------------------------------------------------
    const r2Object = await env.R2.get(r2Key)
    if (!r2Object) {
      throw new Error(`R2 object not found: ${r2Key}`)
    }
    const imageBuffer = await r2Object.arrayBuffer()
    const contentType = r2Object.httpMetadata?.contentType ?? 'image/jpeg'

    // base64 Data URL に変換（OpenAI Vision に渡すため）
    const base64 = arrayBufferToBase64(imageBuffer)
    const dataUrl = `data:${contentType};base64,${base64}`

    // ------------------------------------------------------------------
    // 3. OpenAI Vision で画像分類
    // ------------------------------------------------------------------
    const ai = createOpenAIClient(env)

    const classifyPrompt = `あなたは食事・健康管理アプリの画像分類AIです。
送られてきた画像を以下のカテゴリのいずれか1つに分類し、JSONで回答してください。

カテゴリ:
- meal_photo        : 食事・料理の写真
- nutrition_label   : 栄養成分表示ラベル
- body_scale        : 体重計の数値が写った画像
- food_package      : 食品パッケージ（原材料・栄養情報含む）
- progress_body_photo : 体型・体の変化を記録する写真
- other             : 上記以外

回答形式（JSON）:
{
  "category": "<上記カテゴリのいずれか>",
  "confidence": <0.0〜1.0の確信度>,
  "description": "<画像の内容を1〜2文で説明（日本語）>"
}`

    const classifyResult = await ai.createVisionResponse(
      classifyPrompt,
      '添付画像を分類してください。',
      dataUrl,
      { responseFormat: 'json_object', imageDetail: 'low', maxTokens: 256 }
    )

    let category: ImageCategory = 'unknown'
    let confidence = 0.5
    let description = ''

    try {
      const parsed = JSON.parse(classifyResult) as {
        category?: string
        confidence?: number
        description?: string
      }
      const validCategories: ImageCategory[] = [
        'meal_photo', 'nutrition_label', 'body_scale',
        'food_package', 'progress_body_photo', 'other', 'unknown'
      ]
      if (parsed.category && validCategories.includes(parsed.category as ImageCategory)) {
        category = parsed.category as ImageCategory
      }
      confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
      description = parsed.description ?? ''
    } catch {
      console.warn('[ImageAnalysis] Category parse failed, defaulting to unknown')
    }

    // ------------------------------------------------------------------
    // 4. カテゴリ別アクション実行
    // ------------------------------------------------------------------
    const today = todayJst()
    const dailyLog = await ensureDailyLog(env.DB, {
      userAccountId,
      clientAccountId,
      logDate: today,
    })

    let proposedAction: Record<string, unknown> = {}
    let extractedData: Record<string, unknown> = { description }
    let replyMessage = ''

    switch (category) {
      case 'meal_photo': {
        const result = await analyzeMealPhoto(ai, dataUrl, dailyLog.id, userAccountId, env)
        extractedData = { ...extractedData, ...result.extracted }
        proposedAction = result.proposed
        replyMessage = result.message
        break
      }

      case 'body_scale': {
        const result = await analyzeBodyScale(ai, dataUrl, dailyLog.id, env)
        extractedData = { ...extractedData, ...result.extracted }
        proposedAction = result.proposed
        replyMessage = result.message
        break
      }

      case 'nutrition_label': {
        const result = await analyzeNutritionLabel(ai, dataUrl)
        extractedData = { ...extractedData, ...result.extracted }
        proposedAction = result.proposed
        replyMessage = result.message
        break
      }

      case 'food_package': {
        const result = await analyzeNutritionLabel(ai, dataUrl)
        extractedData = { ...extractedData, ...result.extracted }
        proposedAction = result.proposed
        replyMessage = result.message
        break
      }

      case 'progress_body_photo': {
        // Phase 1: 受け取り確認のみ（比較UIは Phase 2）
        replyMessage = `📸 体型写真を保存しました！\n継続して記録することで変化を確認できます。\n\n記録日: ${today}`
        proposedAction = { action: 'store_progress_photo' }
        break
      }

      default: {
        replyMessage = `📷 画像を受け取りました。\n\n食事・体重計・栄養ラベルの写真を送ると自動で記録できます！`
        proposedAction = { action: 'none' }
        break
      }
    }

    // ------------------------------------------------------------------
    // 5. image_intake_results を保存
    // ------------------------------------------------------------------
    await saveImageIntakeResult(env.DB, {
      messageAttachmentId: attachmentId,
      userAccountId,
      dailyLogId: dailyLog.id,
      imageCategory: category,
      confidenceScore: confidence,
      extractedJson: extractedData,
      proposedActionJson: proposedAction,
    })

    // ------------------------------------------------------------------
    // 6. BOT の発言として conversation_messages に保存
    // ------------------------------------------------------------------
    await createConversationMessage(env.DB, {
      threadId,
      senderType: 'bot',
      messageType: 'text',
      rawText: replyMessage,
      modeAtSend: 'record',
      sentAt: nowIso(),
    })

    // ------------------------------------------------------------------
    // 7. ジョブを 'done' に更新
    // ------------------------------------------------------------------
    await updateJobStatus(env.DB, job.id, 'done')

    // ------------------------------------------------------------------
    // 8. LINE push で結果通知
    // ------------------------------------------------------------------
    await pushText(lineUserId, replyMessage, env.LINE_CHANNEL_ACCESS_TOKEN)

    console.log(`[ImageAnalysis] Done: attachment=${attachmentId} category=${category}`)
  } catch (err) {
    console.error(`[ImageAnalysis] Failed: attachment=${attachmentId}`, err)
    await updateJobStatus(env.DB, job.id, 'failed', String(err))

    // エラー時もユーザーに通知
    try {
      await pushText(
        lineUserId,
        '画像の解析に失敗しました。もう一度お試しいただくか、テキストで記録してください。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } catch (notifyErr) {
      console.error('[ImageAnalysis] Push notification failed:', notifyErr)
    }
    throw err
  }
}

// ===================================================================
// カテゴリ別解析関数
// ===================================================================

/** 食事写真解析 */
async function analyzeMealPhoto(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  dailyLogId: string,
  userAccountId: string,
  env: Bindings
): Promise<{ extracted: Record<string, unknown>; proposed: Record<string, unknown>; message: string }> {
  const prompt = `あなたは食事記録AIです。添付の食事写真を分析し、以下のJSON形式で回答してください。

{
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack" | "other",
  "food_items": ["食品名1", "食品名2", ...],
  "estimated_calories": <推定カロリー（kcal）、不明な場合はnull>,
  "estimated_protein_g": <推定タンパク質（g）、不明な場合はnull>,
  "estimated_fat_g": <推定脂質（g）、不明な場合はnull>,
  "estimated_carbs_g": <推定炭水化物（g）、不明な場合はnull>,
  "confidence": <0.0〜1.0>,
  "notes": "<特記事項（日本語）、なければ空文字>"
}`

  const raw = await ai.createVisionResponse(
    prompt,
    '添付の食事写真を分析してください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 512 }
  )

  let extracted: Record<string, unknown> = {}
  let mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other' = 'other'
  let calories: number | null = null
  let foodItems: string[] = []

  try {
    const parsed = JSON.parse(raw) as {
      meal_type?: string
      food_items?: string[]
      estimated_calories?: number | null
      estimated_protein_g?: number | null
      estimated_fat_g?: number | null
      estimated_carbs_g?: number | null
      confidence?: number
      notes?: string
    }

    const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const
    if (parsed.meal_type && validMealTypes.includes(parsed.meal_type as typeof validMealTypes[number])) {
      mealType = parsed.meal_type as typeof mealType
    }
    foodItems = parsed.food_items ?? []
    calories = parsed.estimated_calories ?? null
    extracted = {
      meal_type: mealType,
      food_items: foodItems,
      estimated_calories: calories,
      estimated_protein_g: parsed.estimated_protein_g ?? null,
      estimated_fat_g: parsed.estimated_fat_g ?? null,
      estimated_carbs_g: parsed.estimated_carbs_g ?? null,
      confidence: parsed.confidence ?? 0.5,
      notes: parsed.notes ?? '',
    }

    // meal_entries に保存
    await createMealEntry(env.DB, {
      dailyLogId,
      mealType,
      mealText: foodItems.join('、'),
      confirmationStatus: 'estimated',
    })

    // 栄養推定値を更新
    if (calories !== null) {
      const { findMealEntryByDailyLogAndType } = await import('../repositories/meal-entries-repo')
      const entry = await findMealEntryByDailyLogAndType(env.DB, dailyLogId, mealType)
      if (entry) {
        await updateMealEntryFromEstimate(env.DB, entry.id, {
          estimatedCaloriesKcal: calories ?? undefined,
          estimatedProteinG: (parsed.estimated_protein_g ?? undefined) as number | undefined,
          estimatedFatG: (parsed.estimated_fat_g ?? undefined) as number | undefined,
          estimatedCarbsG: (parsed.estimated_carbs_g ?? undefined) as number | undefined,
        })
      }
    }
  } catch (e) {
    console.warn('[ImageAnalysis] Meal parse failed:', e)
    extracted = { raw }
  }

  const mealLabel = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : mealType === 'dinner' ? '夕食' : mealType === 'snack' ? '間食' : '食事'
  const caloriesText = calories !== null ? `\n推定カロリー: 約${calories}kcal` : ''
  const itemsText = foodItems.length > 0 ? `\n${foodItems.join('・')}` : ''

  const message = `🍽 ${mealLabel}を記録しました ✅${itemsText}${caloriesText}\n\n内容が違う場合はテキストで修正できます。`

  return {
    extracted,
    proposed: { action: 'meal_recorded', meal_type: mealType },
    message,
  }
}

/** 体重計写真解析 */
async function analyzeBodyScale(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  dailyLogId: string,
  env: Bindings
): Promise<{ extracted: Record<string, unknown>; proposed: Record<string, unknown>; message: string }> {
  const prompt = `体重計の画像から数値を読み取り、以下のJSON形式で回答してください。

{
  "weight_kg": <体重（kg、小数点第1位まで）、読み取れない場合はnull>,
  "body_fat_percent": <体脂肪率（%）、表示がない場合はnull>,
  "confidence": <0.0〜1.0>,
  "notes": "<特記事項>"
}`

  const raw = await ai.createVisionResponse(
    prompt,
    '体重計の数値を読み取ってください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 256 }
  )

  let weightKg: number | null = null
  let bodyFatPercent: number | null = null
  let extracted: Record<string, unknown> = {}

  try {
    const parsed = JSON.parse(raw) as {
      weight_kg?: number | null
      body_fat_percent?: number | null
      confidence?: number
      notes?: string
    }
    weightKg = parsed.weight_kg ?? null
    bodyFatPercent = parsed.body_fat_percent ?? null
    extracted = { weight_kg: weightKg, body_fat_percent: bodyFatPercent, confidence: parsed.confidence ?? 0.5 }

    if (weightKg !== null && weightKg > 20 && weightKg < 300) {
      await upsertWeight(env.DB, { dailyLogId, weightKg, bodyFatPercent: bodyFatPercent ?? undefined })
    }
  } catch (e) {
    console.warn('[ImageAnalysis] Scale parse failed:', e)
    extracted = { raw }
  }

  if (weightKg !== null) {
    const fatText = bodyFatPercent !== null ? `　体脂肪率: ${bodyFatPercent}%` : ''
    return {
      extracted,
      proposed: { action: 'weight_recorded', weight_kg: weightKg },
      message: `⚖️ 体重を記録しました ✅\n${weightKg}kg${fatText}\n\n継続して記録することで変化が分かります！`,
    }
  }

  return {
    extracted,
    proposed: { action: 'none' },
    message: '⚖️ 体重計の数値が読み取れませんでした。\nテキストで「体重○○kg」と入力してください。',
  }
}

/** 栄養ラベル / 食品パッケージ解析 */
async function analyzeNutritionLabel(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string
): Promise<{ extracted: Record<string, unknown>; proposed: Record<string, unknown>; message: string }> {
  const prompt = `栄養成分表示ラベルまたは食品パッケージの画像から情報を読み取り、以下のJSON形式で回答してください。

{
  "product_name": "<商品名、不明の場合はnull>",
  "serving_size_g": <1食分の量（g）、不明の場合はnull>,
  "calories_kcal": <カロリー（kcal）、不明の場合はnull>,
  "protein_g": <タンパク質（g）、不明の場合はnull>,
  "fat_g": <脂質（g）、不明の場合はnull>,
  "carbs_g": <炭水化物（g）、不明の場合はnull>,
  "sodium_mg": <ナトリウム（mg）、不明の場合はnull>,
  "confidence": <0.0〜1.0>,
  "notes": "<特記事項>"
}`

  const raw = await ai.createVisionResponse(
    prompt,
    '栄養成分表示を読み取ってください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 512 }
  )

  let extracted: Record<string, unknown> = {}
  let productName: string | null = null
  let calories: number | null = null

  try {
    const parsed = JSON.parse(raw) as {
      product_name?: string | null
      serving_size_g?: number | null
      calories_kcal?: number | null
      protein_g?: number | null
      fat_g?: number | null
      carbs_g?: number | null
      sodium_mg?: number | null
      confidence?: number
      notes?: string
    }
    productName = parsed.product_name ?? null
    calories = parsed.calories_kcal ?? null
    extracted = { ...parsed }
  } catch (e) {
    console.warn('[ImageAnalysis] Nutrition label parse failed:', e)
    extracted = { raw }
  }

  const nameText = productName ? `「${productName}」` : '商品'
  const calText = calories !== null ? `\nカロリー: ${calories}kcal/食` : ''

  return {
    extracted,
    proposed: { action: 'nutrition_label_scanned', product_name: productName },
    message: `🏷 ${nameText}の栄養情報を読み取りました ✅${calText}\n\n食事記録に追加しますか？`,
  }
}

// ===================================================================
// ユーティリティ
// ===================================================================

/** ArrayBuffer を base64 文字列に変換（Cloudflare Workers 対応） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
