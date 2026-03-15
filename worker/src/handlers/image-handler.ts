/**
 * worker/src/handlers/image-handler.ts
 * 画像メッセージハンドラ
 *
 * 1. LINE から画像バイナリを取得
 * 2. R2 に保存
 * 3. OpenAI Vision で解析
 * 4. 結果を DB に保存
 * 5. runtime_state を S2 (image_confirm) に遷移
 * 6. push で結果 + 確認ボタンを送信
 */

import type { WorkerEnv, LineEvent, RuntimeState } from '../types'
import { updateRuntimeState } from '../state/runtime-state'
import { sendPushText } from '../send/push-sender'

const LINE_CONTENT_API = 'https://api-data.line.me/v2/bot/message'

/**
 * 画像メッセージを処理する
 */
export async function handleImageMessage(
  event: LineEvent,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  const messageId = event.message?.id
  if (!messageId) return

  try {
    // --- 1. LINE から画像取得 ---
    const imageRes = await fetch(`${LINE_CONTENT_API}/${messageId}/content`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    })

    if (!imageRes.ok) {
      throw new Error(`LINE content API failed: ${imageRes.status}`)
    }

    const imageData = await imageRes.arrayBuffer()
    const contentType = imageRes.headers.get('content-type') ?? 'image/jpeg'

    // --- 2. R2 に保存 ---
    const r2Key = `images/${userAccountId}/${messageId}.${contentType === 'image/png' ? 'png' : 'jpg'}`
    await env.R2.put(r2Key, imageData, {
      httpMetadata: { contentType },
    })

    console.log(`[ImageHandler] saved to R2: ${r2Key} (${imageData.byteLength} bytes)`)

    // --- 3. OpenAI Vision で解析 ---
    const base64 = arrayBufferToBase64(imageData)
    const dataUrl = `data:${contentType};base64,${base64}`

    const analysis = await analyzeImage(dataUrl, env)

    // --- 4. image_intake_results に保存 ---
    const resultId = crypto.randomUUID()
    const todayStr = getTodayJST()
    const mealType = analysis.meal_type || guessMealType()

    await env.DB.prepare(`
      INSERT INTO image_intake_results
        (id, user_account_id, r2_key, category, analysis_json,
         proposed_action_json, status, target_date, meal_type,
         created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_confirm', ?7, ?8, datetime('now'), datetime('now'))
    `).bind(
      resultId,
      userAccountId,
      r2Key,
      analysis.category || 'meal_photo',
      JSON.stringify(analysis),
      JSON.stringify({
        description: analysis.description,
        food_items: analysis.food_items,
        calories: analysis.calories,
        protein: analysis.protein,
        fat: analysis.fat,
        carbs: analysis.carbs,
      }),
      todayStr,
      mealType
    ).run()

    // --- 5. runtime_state を S2 に遷移 ---
    // 30分後に期限切れ
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      waitingType: 'image_confirm',
      waitingTargetId: resultId,
      waitingExpiresAt: expiresAt,
      currentMode: 'record',
    })

    // --- 6. push で結果送信 ---
    const mealTypeJa = { breakfast: '朝食', lunch: '昼食', snack: '間食', dinner: '夕食', night_snack: '夜食' }[mealType] || mealType
    const replyText = `📸 画像を解析しました！\n\n🍽 ${analysis.description}\n🔥 ${analysis.calories} kcal\n🥩 P ${analysis.protein}g | 🧈 F ${analysis.fat}g | 🍚 C ${analysis.carbs}g\n📅 ${todayStr} ${mealTypeJa}\n\nこの内容で記録しますか？\n修正がある場合はテキストで送ってください。\n例: 「鮭ではなくスクランブルエッグ」「昨日の夕食」`

    await sendPushText(env, lineUserId, userAccountId, replyText, eventId, [
      { label: '✅ 確定', text: '確定' },
      { label: '❌ 取消', text: '取消' },
    ])

    console.log(`[ImageHandler] analysis complete: ${resultId}, ${analysis.description}`)

  } catch (err) {
    console.error('[ImageHandler] error:', err)
    await sendPushText(
      env, lineUserId, userAccountId,
      '⚠️ 画像の解析中にエラーが発生しました。もう一度送り直してください。',
      eventId
    )
    throw err
  }
}

/**
 * OpenAI Vision で画像を解析
 */
async function analyzeImage(
  dataUrl: string,
  env: WorkerEnv
): Promise<{
  category: string
  description: string
  food_items: string[]
  calories: number
  protein: number
  fat: number
  carbs: number
  meal_type?: string
}> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20000) // 20秒タイムアウト

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `あなたは食事画像の解析エンジンです。
画像から食事内容を分析し、以下のJSON形式で返してください。

{"category":"meal_photo","description":"料理の説明","food_items":["食品1","食品2"],"calories":数値,"protein":数値,"fat":数値,"carbs":数値,"meal_type":"breakfast|lunch|snack|dinner|night_snack|null"}

- category: meal_photo (食事), nutrition_label (栄養ラベル), body_scale (体重計), food_package (食品パッケージ)
- 数値は整数で、現実的な栄養価を推定してください
- food_items は個々の食品名のリスト
- meal_type は画像から推測できる場合のみ設定`,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'この食事画像を解析してください。' },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenAI Vision failed: ${res.status} ${errText}`)
    }

    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content)

    return {
      category: parsed.category || 'meal_photo',
      description: parsed.description || '不明な食事',
      food_items: parsed.food_items || [],
      calories: parsed.calories ?? 0,
      protein: parsed.protein ?? 0,
      fat: parsed.fat ?? 0,
      carbs: parsed.carbs ?? 0,
      meal_type: parsed.meal_type || undefined,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function getTodayJST(): string {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  return jstNow.toISOString().split('T')[0]
}

function guessMealType(): string {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  const hour = jstNow.getUTCHours()

  if (hour >= 5 && hour < 10) return 'breakfast'
  if (hour >= 10 && hour < 14) return 'lunch'
  if (hour >= 14 && hour < 17) return 'snack'
  if (hour >= 17 && hour < 21) return 'dinner'
  return 'night_snack'
}
