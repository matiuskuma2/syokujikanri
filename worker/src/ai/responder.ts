/**
 * worker/src/ai/responder.ts
 * 応答生成 AI（gpt-4o, <15秒）
 *
 * 相談応答、食事修正解析など、品質が重要な応答を生成する。
 */

import type { WorkerEnv } from '../types'

/**
 * 相談応答を生成する（gpt-4o, 15秒タイムアウト）
 */
export async function generateConsultResponse(
  userMessage: string,
  env: WorkerEnv,
  context: {
    systemPrompt?: string
    recentMessages?: { role: string; text: string }[]
    userContext?: string
    memories?: string[]
    knowledgeDocs?: string[]
  }
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    // システムプロンプト構築
    let sysPrompt = context.systemPrompt || `あなたは栄養士のダイエットアドバイザーです。
ユーザーの食事・体重・生活習慣に関する質問に答えてください。
科学的根拠に基づいた、具体的で実行可能なアドバイスを200文字以内で提供してください。
日本語で回答してください。`

    // ナレッジドキュメントを追加
    if (context.knowledgeDocs?.length) {
      sysPrompt += `\n\n## 参考資料\n${context.knowledgeDocs.join('\n---\n')}`
    }

    // ユーザーコンテキスト追加
    if (context.userContext) {
      sysPrompt += `\n\n## ユーザー情報\n${context.userContext}`
    }

    // メモリ追加
    if (context.memories?.length) {
      sysPrompt += `\n\n## 蓄積された情報\n${context.memories.join('\n')}`
    }

    const messages: any[] = [
      { role: 'system', content: sysPrompt },
    ]

    // 直近の会話履歴
    if (context.recentMessages?.length) {
      for (const msg of context.recentMessages) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.text,
        })
      }
    }

    messages.push({ role: 'user', content: userMessage })

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        temperature: 0.7,
        max_tokens: 300,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenAI responder failed: ${res.status} ${errText}`)
    }

    const data = await res.json() as any
    return data.choices?.[0]?.message?.content ?? '申し訳ございません、回答を生成できませんでした。'
  } catch (err) {
    console.error('[Responder] error:', err)
    if (err instanceof Error && err.name === 'AbortError') {
      return '⏳ 回答の生成に時間がかかりすぎました。もう一度お試しください。'
    }
    return '⚠️ 回答の生成中にエラーが発生しました。もう一度お試しください。'
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 食事修正を解析する（gpt-4o-mini, 10秒タイムアウト）
 */
export async function analyzeFoodCorrection(
  correctionText: string,
  originalData: { description: string; calories: number; protein: number; fat: number; carbs: number },
  env: WorkerEnv
): Promise<{
  description: string
  food_items: string[]
  calories: number
  protein: number
  fat: number
  carbs: number
}> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const prompt = `元の食事: ${originalData.description} (${originalData.calories}kcal, P${originalData.protein}g, F${originalData.fat}g, C${originalData.carbs}g)
修正指示: ${correctionText}

修正後の食事データをJSON形式で返してください:
{"description":"修正後の説明","food_items":["食品1","食品2"],"calories":数値,"protein":数値,"fat":数値,"carbs":数値}

数値は整数で、現実的な栄養価を計算してください。`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '栄養データ修正エンジンです。JSONのみ返してください。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error('OpenAI failed')
    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content)

    return {
      description: parsed.description || originalData.description,
      food_items: parsed.food_items || [parsed.description || originalData.description],
      calories: parsed.calories ?? originalData.calories,
      protein: parsed.protein ?? originalData.protein,
      fat: parsed.fat ?? originalData.fat,
      carbs: parsed.carbs ?? originalData.carbs,
    }
  } catch (err) {
    console.error('[Responder] food correction error:', err)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 日付・区分をテキストから抽出する（gpt-4o-mini, 5秒タイムアウト）
 */
export async function extractMetadata(
  text: string,
  env: WorkerEnv
): Promise<{ targetDate?: string; mealType?: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  // JST の「今日」を計算
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  const todayStr = jstNow.toISOString().split('T')[0]

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
            content: `今日の日付: ${todayStr} (JST)
テキストから食事の日付と区分を抽出してJSON形式で返してください。
{"target_date":"YYYY-MM-DD or null","meal_type":"breakfast|lunch|snack|dinner|night_snack or null"}
「昨日」→ 前日の日付、「一昨日」→ 2日前の日付で計算してください。
区分: 朝食=breakfast, 昼食=lunch, 間食=snack, 夕食=dinner, 夜食=night_snack`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 50,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error('OpenAI failed')
    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content)

    return {
      targetDate: parsed.target_date || undefined,
      mealType: parsed.meal_type || undefined,
    }
  } catch (err) {
    console.error('[Responder] metadata extraction error:', err)
    // ルールベースフォールバック
    const result: { targetDate?: string; mealType?: string } = {}

    if (text.includes('昨日')) {
      const yesterday = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000)
      result.targetDate = yesterday.toISOString().split('T')[0]
    } else if (text.includes('一昨日') || text.includes('おととい')) {
      const dayBefore = new Date(jstNow.getTime() - 48 * 60 * 60 * 1000)
      result.targetDate = dayBefore.toISOString().split('T')[0]
    }

    if (text.includes('朝')) result.mealType = 'breakfast'
    else if (text.includes('昼')) result.mealType = 'lunch'
    else if (text.includes('夕') || text.includes('晩')) result.mealType = 'dinner'
    else if (text.includes('間食') || text.includes('おやつ')) result.mealType = 'snack'
    else if (text.includes('夜食')) result.mealType = 'night_snack'

    return result
  } finally {
    clearTimeout(timeoutId)
  }
}
