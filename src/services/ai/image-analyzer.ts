/**
 * src/services/ai/image-analyzer.ts
 * OpenAI Vision API による画像解析
 * 対応カテゴリ: meal（食事）/ scale（体重計）/ progress（体型写真）/ nutrition_label（栄養ラベル）
 */

import { fetchWithTimeout, TIMEOUT } from '../../utils/fetch-with-timeout'

export type ImageCategory = 'meal' | 'scale' | 'progress' | 'nutrition_label' | 'unknown'

export interface MealAnalysis {
  category: 'meal'
  items: Array<{ name: string; estimatedCalories: number; estimatedWeight?: number }>
  totalCalories: number
  protein: number
  fat: number
  carbs: number
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other'
  comment: string
}

export interface ScaleAnalysis {
  category: 'scale'
  weightKg: number | null
  unit: 'kg' | 'lbs'
  confidence: number
  comment: string
}

export interface NutritionLabelAnalysis {
  category: 'nutrition_label'
  productName?: string
  servingSize?: string
  calories: number
  protein: number
  fat: number
  carbs: number
  sodium?: number
  comment: string
}

export interface ProgressAnalysis {
  category: 'progress'
  bodyPart: string
  comment: string
}

export type ImageAnalysisResult =
  | MealAnalysis
  | ScaleAnalysis
  | NutritionLabelAnalysis
  | ProgressAnalysis
  | { category: 'unknown'; comment: string }

/** 画像URLを解析して構造化データを返す */
export async function analyzeImage(
  imageBase64OrUrl: string,
  apiKey: string,
  model = 'gpt-4o'
): Promise<ImageAnalysisResult> {
  const systemPrompt = `You are a diet-support AI. Analyze the image and classify it as one of: meal, scale, nutrition_label, progress, unknown.
Return ONLY valid JSON matching the appropriate schema below.

meal: {"category":"meal","items":[{"name":"...","estimatedCalories":0,"estimatedWeight":0}],"totalCalories":0,"protein":0,"fat":0,"carbs":0,"mealType":"breakfast|lunch|dinner|snack|other","comment":"..."}
scale: {"category":"scale","weightKg":0.0,"unit":"kg","confidence":0.0-1.0,"comment":"..."}
nutrition_label: {"category":"nutrition_label","productName":"...","servingSize":"...","calories":0,"protein":0,"fat":0,"carbs":0,"sodium":0,"comment":"..."}
progress: {"category":"progress","bodyPart":"...","comment":"..."}
unknown: {"category":"unknown","comment":"..."}

Rules:
- All text in Japanese
- weightKg: float with 1 decimal (e.g. 72.5), null if unreadable
- calories/macros: integer grams
- Be concise in comment (max 80 chars)`

  const isUrl = imageBase64OrUrl.startsWith('http')
  const imageContent = isUrl
    ? { type: 'image_url', image_url: { url: imageBase64OrUrl, detail: 'high' } }
    : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64OrUrl}`, detail: 'high' } }

  try {
    const res = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [imageContent, { type: 'text', text: '画像を解析してJSONを返してください' }] },
          ],
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
      },
      TIMEOUT.OPENAI_CHAT
    )

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error(`[ImageAnalyzer] API error ${res.status}: ${err}`)
      return { category: 'unknown', comment: '解析に失敗しました' }
    }

    const data = await res.json<any>()
    const raw = data.choices?.[0]?.message?.content ?? '{}'
    return JSON.parse(raw) as ImageAnalysisResult
  } catch (e) {
    console.error('[ImageAnalyzer] error:', e)
    return { category: 'unknown', comment: '解析エラーが発生しました' }
  }
}

/** 解析結果をユーザー向けテキストメッセージに変換 */
export function buildAnalysisReplyText(result: ImageAnalysisResult): string {
  switch (result.category) {
    case 'meal': {
      const r = result as MealAnalysis
      const items = r.items.map(i => `・${i.name}（約${i.estimatedCalories}kcal）`).join('\n')
      return `🍽️ 食事を記録しました！\n\n${items}\n\n合計: 約${r.totalCalories}kcal\nP: ${r.protein}g / F: ${r.fat}g / C: ${r.carbs}g\n\n${r.comment}`
    }
    case 'scale': {
      const r = result as ScaleAnalysis
      if (r.weightKg === null) return '⚖️ 体重計の数値が読み取れませんでした。もう少し近づいて撮影してみてください。'
      return `⚖️ 体重を記録しました！\n\n**${r.weightKg}kg**\n\n${r.comment}`
    }
    case 'nutrition_label': {
      const r = result as NutritionLabelAnalysis
      return `📋 栄養成分を読み取りました！\n\n${r.productName ? `商品: ${r.productName}\n` : ''}カロリー: ${r.calories}kcal\nP: ${r.protein}g / F: ${r.fat}g / C: ${r.carbs}g\n\n${r.comment}`
    }
    case 'progress': {
      const r = result as ProgressAnalysis
      return `📸 体型写真を保存しました！\n\n${r.comment}`
    }
    default:
      return '画像を受け取りました。食事・体重計・栄養ラベルの写真を送ると自動で記録できます！'
  }
}
