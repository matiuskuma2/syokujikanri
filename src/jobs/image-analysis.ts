/**
 * src/jobs/image-analysis.ts
 * Cloudflare Queue Consumer — 画像解析ジョブ
 *
 * Queue から受け取った ImageAnalysisQueueMessage を処理し:
 *   1. R2 から画像バイナリを取得 → data URL に変換
 *   2. OpenAI Vision で画像カテゴリ判定
 *   3. カテゴリごとに詳細解析（食事 / 栄養ラベル / 体重計 / 体型写真 等）
 *   4. 解析結果を image_intake_results に保存
 *   5. カテゴリに応じてレコードを DB に反映（meal_entries / body_metrics / progress_photos）
 *   6. LINE push で結果をユーザーに通知
 *
 * エラー方針:
 *   - 1メッセージ単位で try/catch し、ジョブは 'failed' にしてリトライさせない
 *   - 致命的でないエラー（LINE通知失敗など）は警告ログのみ
 */

import type { Bindings, LineQueueMessage, ImageAnalysisQueueMessage } from '../types/bindings'
import type { ImageCategory } from '../types/db'
import { createOpenAIClient } from '../services/ai/openai-client'
import { getMessageAttachmentById } from '../repositories/attachments-repo'
import {
  findJobByAttachmentId,
  updateJobStatus,
  saveImageIntakeResult,
} from '../repositories/image-intake-repo'

import { createConversationMessage } from '../repositories/conversations-repo'
import { upsertModeSession } from '../repositories/mode-sessions-repo'
import { pushText, pushWithQuickReplies } from '../services/line/reply'
import { todayJst, nowIso } from '../utils/id'

// ===================================================================
// プロンプト定義（Phase 1 – OpenAI Vision のみ）
// ===================================================================

const CLASSIFY_PROMPT = `あなたは画像分類AIです。送られた画像を以下のカテゴリのうち最も適切なものに分類してください。

カテゴリ:
- meal_photo        : 食事・食べ物の写真（皿・弁当・料理など）
- nutrition_label   : 食品の栄養成分表示ラベル
- body_scale        : 体重計の表示（数値が写っている）
- food_package      : 食品パッケージ・袋・箱（成分表でなくパッケージ全体）
- progress_body_photo : 体型・身体の進捗写真（全身・部分問わず）
- other             : 上記以外の画像
- unknown           : 判断できない

必ず以下のJSON形式のみで返答してください（説明文は不要）:
{"category": "<カテゴリ名>", "confidence": <0.0〜1.0の数値>}`

const MEAL_ANALYSIS_PROMPT = `あなたは栄養士AIです。食事の写真を分析して栄養情報を推定してください。

以下のJSON形式のみで返答してください（説明文は不要）:
{
  "meal_description": "料理名・食材の説明（日本語、100文字以内）",
  "estimated_calories_kcal": <整数またはnull>,
  "estimated_protein_g": <数値またはnull>,
  "estimated_fat_g": <数値またはnull>,
  "estimated_carbs_g": <数値またはnull>,
  "meal_type_guess": "breakfast|lunch|dinner|snack|other",
  "confidence_note": "推定精度の補足（任意）"
}`

const NUTRITION_LABEL_PROMPT = `栄養成分表示ラベルの画像から数値を正確に読み取ってください。

以下のJSON形式のみで返答してください（読み取れない項目はnull）:
{
  "product_name": "商品名またはnull",
  "serving_size_g": <数値またはnull>,
  "calories_kcal": <数値またはnull>,
  "protein_g": <数値またはnull>,
  "fat_g": <数値またはnull>,
  "carbs_g": <数値またはnull>,
  "sodium_mg": <数値またはnull>,
  "raw_text_hint": "ラベルの主要テキスト抜粋（任意）"
}`

const SCALE_PROMPT = `体重計の表示を読み取ってください。

以下のJSON形式のみで返答してください（読み取れない場合はnull）:
{
  "weight_kg": <数値またはnull>,
  "unit": "kg|lb|null",
  "display_text": "表示されている数値のテキスト"
}`

// ===================================================================
// Queue Consumer エントリーポイント
// ===================================================================

/**
 * Cloudflare Workers の queue handler として export する
 * wrangler.jsonc の [[queues.consumers]] に対応
 */
export async function lineQueueConsumer(
  batch: MessageBatch<LineQueueMessage>,
  env: Bindings
): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body

    if (payload.type === 'image_analysis') {
      await processImageAnalysis(payload, env)
        .then(() => message.ack())
        .catch((err) => {
          console.error('[Queue] image_analysis fatal error, nacking:', err)
          message.retry()
        })
    } else {
      // webhook_event など現時点では未実装
      console.log(`[Queue] Unsupported message type: ${(payload as { type: string }).type}`)
      message.ack()
    }
  }
}

// ===================================================================
// 画像解析メインフロー
// ===================================================================

async function processImageAnalysis(
  msg: ImageAnalysisQueueMessage,
  env: Bindings
): Promise<void> {
  const { attachmentId, userAccountId, clientAccountId, threadId, r2Key, lineUserId } = msg

  // 1. ジョブを processing に更新
  const job = await findJobByAttachmentId(env.DB, attachmentId)
  if (!job) {
    console.warn(`[Queue] job not found for attachment: ${attachmentId}`)
    return
  }
  await updateJobStatus(env.DB, job.id, 'processing')

  try {
    // 2. R2 から画像バイナリを取得
    const r2Object = await env.R2.get(r2Key)
    if (!r2Object) {
      throw new Error(`R2 object not found: ${r2Key}`)
    }
    const imageBuffer = await r2Object.arrayBuffer()
    const contentType = r2Object.httpMetadata?.contentType ?? 'image/jpeg'

    // 3. base64 data URL に変換（OpenAI Vision に渡す）
    const base64 = arrayBufferToBase64(imageBuffer)
    const dataUrl = `data:${contentType};base64,${base64}`

    // 4. カテゴリ分類
    const ai = createOpenAIClient(env)
    const classifyRaw = await ai.createVisionResponse(
      CLASSIFY_PROMPT,
      '画像を分類してください。',
      dataUrl,
      { responseFormat: 'json_object', imageDetail: 'low', maxTokens: 128 }
    )

    let category: ImageCategory = 'unknown'
    let confidence = 0
    try {
      const parsed = JSON.parse(classifyRaw) as { category?: string; confidence?: number }
      const validCategories: ImageCategory[] = [
        'meal_photo', 'nutrition_label', 'body_scale',
        'food_package', 'progress_body_photo', 'other', 'unknown',
      ]
      if (parsed.category && validCategories.includes(parsed.category as ImageCategory)) {
        category = parsed.category as ImageCategory
      }
      confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    } catch {
      console.warn('[Queue] classify JSON parse failed, using unknown')
    }

    console.log(`[Queue] classified: ${category} (${confidence}) attachment=${attachmentId}`)

    // 5. カテゴリ別詳細解析
    let extractedJson: Record<string, unknown> | null = null
    let proposedActionJson: Record<string, unknown> | null = null
    let replyMessage = ''

    switch (category) {
      case 'meal_photo':
        ;({ extractedJson, proposedActionJson, replyMessage } = await analyzeMealPhoto(
          ai, dataUrl, userAccountId, clientAccountId, threadId, env
        ))
        break

      case 'nutrition_label':
        ;({ extractedJson, proposedActionJson, replyMessage } = await analyzeNutritionLabel(
          ai, dataUrl, userAccountId, clientAccountId, threadId, env
        ))
        break

      case 'body_scale':
        ;({ extractedJson, proposedActionJson, replyMessage } = await analyzeBodyScale(
          ai, dataUrl, userAccountId, clientAccountId, threadId, env
        ))
        break

      case 'progress_body_photo':
        ;({ extractedJson, proposedActionJson, replyMessage } = await analyzeProgressPhoto(
          r2Key, userAccountId, clientAccountId, threadId, env
        ))
        break

      default:
        replyMessage = `📷 画像を受け取りました（${category}）。\n現時点では自動処理に対応していない種類の画像です。`
        break
    }

    // 6. image_intake_results を pending 状態で保存（applied_flag=0, 24h 期限付き）
    const intakeResult = await saveImageIntakeResult(env.DB, {
      messageAttachmentId: attachmentId,
      userAccountId,
      lineUserId,
      imageCategory: category,
      confidenceScore: confidence,
      extractedJson,
      proposedActionJson,
    })

    // 7. ジョブを done に更新
    await updateJobStatus(env.DB, job.id, 'done')

    // 8. mode_session に pending_image_confirm を設定
    //    ユーザーの次回テキストで確認応答をハンドリング
    if (lineUserId) {
      await upsertModeSession(env.DB, {
        clientAccountId,
        lineUserId,
        currentMode: 'record',
        currentStep: 'pending_image_confirm',
        sessionData: { intakeResultId: intakeResult.id, category },
        ttlHours: 24,
      })
    }

    // 9. LINE push で確認メッセージ + QuickReply を送信
    if (replyMessage && lineUserId) {
      const confirmMessage = replyMessage + '\n\n↓ この内容で記録しますか？'

      await pushWithQuickReplies(
        lineUserId,
        confirmMessage,
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch((err) => {
        console.warn('[Queue] LINE push failed (non-fatal):', err)
      })

      // bot 発言をスレッドに保存
      await createConversationMessage(env.DB, {
        threadId,
        senderType: 'bot',
        messageType: 'text',
        rawText: confirmMessage,
        modeAtSend: 'record',
        sentAt: nowIso(),
      }).catch((err) => {
        console.warn('[Queue] saveMessage failed (non-fatal):', err)
      })
    }
  } catch (err) {
    console.error(`[Queue] processImageAnalysis failed attachment=${attachmentId}:`, err)
    await updateJobStatus(env.DB, job.id, 'failed', String(err)).catch(() => {})

    // ユーザーにエラーを通知
    if (lineUserId) {
      await pushText(
        lineUserId,
        '画像の解析に失敗しました。お手数ですが、もう一度お試しください。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(() => {})
    }
    throw err // Queue に retry させる
  }
}

// ===================================================================
// カテゴリ別解析関数
// ===================================================================

async function analyzeMealPhoto(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  userAccountId: string,
  clientAccountId: string,
  threadId: string,
  env: Bindings
): Promise<{
  extractedJson: Record<string, unknown>
  proposedActionJson: Record<string, unknown>
  replyMessage: string
}> {
  const raw = await ai.createVisionResponse(
    MEAL_ANALYSIS_PROMPT,
    '食事の栄養情報を推定してください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 512 }
  )

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { raw_response: raw }
  }

  // meal_type の判定
  const guessedType = (parsed.meal_type_guess as string) ?? 'other'
  const mealType =
    ['breakfast', 'lunch', 'dinner', 'snack', 'other'].includes(guessedType)
      ? guessedType
      : 'other'

  const cal = parsed.estimated_calories_kcal
  const desc = (parsed.meal_description as string) ?? '食事'
  const mealTypeJa =
    mealType === 'breakfast' ? '朝食' :
    mealType === 'lunch' ? '昼食' :
    mealType === 'dinner' ? '夕食' :
    mealType === 'snack' ? '間食' : '食事'

  const replyMessage =
    `🍽 ${mealTypeJa}の解析が完了しました！\n\n` +
    `📝 ${desc}\n` +
    (cal ? `🔥 推定カロリー: ${cal} kcal\n` : '') +
    (parsed.estimated_protein_g ? `💪 タンパク質: ${parsed.estimated_protein_g}g\n` : '')

  // ★ メインテーブルへの即時反映は行わない
  // proposed_action_json にデータを保存し、ユーザー確認後に反映する
  return {
    extractedJson: parsed,
    proposedActionJson: {
      action: 'create_or_update_meal_entry',
      meal_type: mealType,
      meal_text: desc,
      calories_kcal: (parsed.estimated_calories_kcal as number) ?? null,
      protein_g: (parsed.estimated_protein_g as number) ?? null,
      fat_g: (parsed.estimated_fat_g as number) ?? null,
      carbs_g: (parsed.estimated_carbs_g as number) ?? null,
      user_account_id: userAccountId,
      client_account_id: clientAccountId,
    },
    replyMessage,
  }
}

async function analyzeNutritionLabel(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  userAccountId: string,
  clientAccountId: string,
  threadId: string,
  env: Bindings
): Promise<{
  extractedJson: Record<string, unknown>
  proposedActionJson: Record<string, unknown>
  replyMessage: string
}> {
  const raw = await ai.createVisionResponse(
    NUTRITION_LABEL_PROMPT,
    '栄養成分表示を読み取ってください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 512 }
  )

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { raw_response: raw }
  }

  const name = (parsed.product_name as string) ?? '食品'
  const cal = parsed.calories_kcal

  const replyMessage =
    `🏷 栄養成分ラベルを読み取りました！\n\n` +
    `📦 ${name}\n` +
    (cal ? `🔥 カロリー: ${cal} kcal\n` : '') +
    (parsed.protein_g ? `💪 タンパク質: ${parsed.protein_g}g\n` : '') +
    (parsed.carbs_g ? `🍚 炭水化物: ${parsed.carbs_g}g\n` : '') +
    (parsed.fat_g ? `🧈 脂質: ${parsed.fat_g}g\n` : '')

  // ★ メインテーブルへの即時反映は行わない
  return {
    extractedJson: parsed,
    proposedActionJson: {
      action: 'create_or_update_meal_entry',
      meal_type: 'other',
      meal_text: name,
      calories_kcal: (parsed.calories_kcal as number) ?? null,
      protein_g: (parsed.protein_g as number) ?? null,
      fat_g: (parsed.fat_g as number) ?? null,
      carbs_g: (parsed.carbs_g as number) ?? null,
      user_account_id: userAccountId,
      client_account_id: clientAccountId,
    },
    replyMessage,
  }
}

async function analyzeBodyScale(
  ai: ReturnType<typeof createOpenAIClient>,
  dataUrl: string,
  userAccountId: string,
  clientAccountId: string,
  threadId: string,
  env: Bindings
): Promise<{
  extractedJson: Record<string, unknown>
  proposedActionJson: Record<string, unknown>
  replyMessage: string
}> {
  const raw = await ai.createVisionResponse(
    SCALE_PROMPT,
    '体重計の数値を読み取ってください。',
    dataUrl,
    { responseFormat: 'json_object', imageDetail: 'high', maxTokens: 256 }
  )

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { raw_response: raw }
  }

  const weightKg = parsed.weight_kg as number | null | undefined
  let replyMessage = ''

  if (weightKg && weightKg > 20 && weightKg < 300) {
    replyMessage =
      `⚖️ 体重計を読み取りました！\n\n` +
      `体重: ${weightKg} kg`
  } else {
    replyMessage =
      `⚖️ 体重計の画像を受け取りましたが、数値を正確に読み取れませんでした。\n\n` +
      `テキストで「体重○○kg」と送っていただくと確実に記録できます。`
  }

  // ★ メインテーブルへの即時反映は行わない
  return {
    extractedJson: parsed,
    proposedActionJson: weightKg && weightKg > 20 && weightKg < 300
      ? {
          action: 'upsert_weight',
          weight_kg: weightKg,
          user_account_id: userAccountId,
          client_account_id: clientAccountId,
        }
      : { action: 'none' },
    replyMessage,
  }
}

async function analyzeProgressPhoto(
  r2Key: string,
  userAccountId: string,
  clientAccountId: string,
  threadId: string,
  env: Bindings
): Promise<{
  extractedJson: Record<string, unknown>
  proposedActionJson: Record<string, unknown>
  replyMessage: string
}> {
  const today = todayJst()

  const replyMessage =
    `📸 体型写真を受け取りました！\n\n` +
    `保存すると、体型の変化を記録・比較できます。`

  // ★ メインテーブルへの即時反映は行わない
  return {
    extractedJson: { r2_key: r2Key, photo_date: today },
    proposedActionJson: {
      action: 'create_progress_photo',
      r2_key: r2Key,
      photo_date: today,
      user_account_id: userAccountId,
      client_account_id: clientAccountId,
    },
    replyMessage,
  }
}

// ===================================================================
// ユーティリティ
// ===================================================================

/** ArrayBuffer → Base64 文字列（Cloudflare Workers 対応） */
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
