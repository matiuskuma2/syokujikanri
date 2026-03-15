/**
 * worker/src/ai/classifier.ts
 * 意図分類 AI（gpt-4o-mini, <8秒）
 *
 * テキストメッセージを受け取り、意図を分類する。
 * 軽量モデルで高速に処理する。
 */

import type { WorkerEnv } from '../types'

export type ClassifiedIntent = {
  primary: string    // 'record_meal' | 'record_weight' | 'switch_consult' | 'switch_record' | 'consult' | 'greeting' | 'trigger_intake' | 'trigger_weight_input' | 'correct_record' | 'delete_record' | 'unclear'
  confidence: number
  target_date?: string       // YYYY-MM-DD
  meal_type?: string         // 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'night_snack'
  food_description?: string
  weight_value?: number
}

const SYSTEM_PROMPT = `あなたはダイエット支援BOTの意図分類エンジンです。
ユーザーのメッセージを以下のいずれかに分類してください。

## 分類カテゴリ
- record_meal: 食事記録（食べた物の報告）
- record_weight: 体重記録（例: "58.5kg"）
- switch_consult: 相談モードへ切替（例: "相談する"）
- switch_record: 記録モードへ切替（例: "記録する"）
- consult: 相談（質問、悩み、アドバイス要求）
- greeting: 挨拶
- trigger_intake: 問診開始
- trigger_weight_input: 体重入力要求
- unclear: 判別不能

## 出力形式（JSON）
{"primary":"カテゴリ名","confidence":0.0-1.0,"target_date":"YYYY-MM-DD or null","meal_type":"breakfast|lunch|snack|dinner|night_snack or null","food_description":"食品テキスト or null","weight_value":数値 or null}

## ルール
- 「相談する」「相談モード」「💬 相談する」→ switch_consult
- 「記録する」「記録モード」「📝 記録する」→ switch_record
- 「戻る」→ switch_record
- 体重数値パターン (例: "58.5kg") → record_weight
- 食品名を含むテキスト → record_meal
- 質問・悩み・アドバイス要求 → consult
- confidence は 0.0〜1.0 で設定
`

/**
 * テキストの意図を分類する（gpt-4o-mini, 8秒タイムアウト）
 */
export async function classifyIntent(
  text: string,
  env: WorkerEnv,
  context?: { currentMode?: string; recentMessages?: string[] }
): Promise<ClassifiedIntent> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ]

    if (context?.recentMessages?.length) {
      messages.push({
        role: 'system',
        content: `現在のモード: ${context.currentMode ?? 'record'}\n直近の会話:\n${context.recentMessages.join('\n')}`,
      })
    }

    messages.push({ role: 'user', content: text })

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenAI classifier failed: ${res.status} ${errText}`)
    }

    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content) as ClassifiedIntent

    return {
      primary: parsed.primary || 'unclear',
      confidence: parsed.confidence ?? 0.5,
      target_date: parsed.target_date || undefined,
      meal_type: parsed.meal_type || undefined,
      food_description: parsed.food_description || undefined,
      weight_value: parsed.weight_value || undefined,
    }
  } catch (err) {
    console.error('[Classifier] error:', err)
    // フォールバック: キーワードマッチ
    return classifyByKeyword(text)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * AI失敗時のフォールバック: キーワードベースの分類
 */
function classifyByKeyword(text: string): ClassifiedIntent {
  const t = text.trim()

  // モード切替
  if (['相談する', '相談モード', '💬 相談する', '相談にして', '相談続ける'].includes(t)) {
    return { primary: 'switch_consult', confidence: 1.0 }
  }
  if (['記録する', '記録モード', '📝 記録する', '記録にして', '戻る'].includes(t)) {
    return { primary: 'switch_record', confidence: 1.0 }
  }

  // 体重パターン
  const weightMatch = t.match(/(\d+\.?\d*)\s*(kg|キロ)/i)
  if (weightMatch) {
    return { primary: 'record_weight', confidence: 0.9, weight_value: parseFloat(weightMatch[1]) }
  }

  // 問診系
  if (['問診', 'ヒアリング', '初期設定', '問診やり直し', '問診リセット', '問診再開'].includes(t)) {
    return { primary: 'trigger_intake', confidence: 1.0 }
  }

  // 招待コード
  if (/^[A-Z]{3}-\d{4}$/i.test(t)) {
    return { primary: 'unclear', confidence: 0.3 }  // webhook 側で処理済みのはず
  }

  return { primary: 'unclear', confidence: 0.3 }
}

/**
 * 画像確認中のテキスト分類
 * 修正テキスト / メタデータ変更 / 確定 / 取消 / 無関係 を判別
 */
export type PendingTextClassification = 'confirm' | 'cancel' | 'food_correction' | 'metadata_update' | 'both' | 'unrelated'

export async function classifyPendingText(
  text: string,
  env: WorkerEnv
): Promise<PendingTextClassification> {
  const t = text.trim()

  // ルールベース: 確定 / 取消
  const confirmKws = ['確定', 'はい', 'yes', 'ok', 'OK', '記録', '保存']
  const cancelKws = ['取消', 'キャンセル', 'cancel', 'いいえ', 'no', 'やめる', '削除']

  if (confirmKws.some(kw => t === kw) || (t.length <= 4 && confirmKws.some(kw => t.includes(kw)))) {
    return 'confirm'
  }
  if (cancelKws.some(kw => t === kw) || (t.length <= 6 && cancelKws.some(kw => t.includes(kw)))) {
    return 'cancel'
  }

  // ルールベース: 日付・時間パターン
  const datePatterns = /今日|昨日|一昨日|おととい|朝食|昼食|夕食|間食|夜食|朝ごはん|昼ごはん|夜ごはん|晩ごはん/
  const hasMealType = datePatterns.test(t)

  // ルールベース: 食品修正パターン
  const correctionPatterns = /ではなく|じゃなく|ではない|でした|です$|変更|修正|追加|削除|なし|抜き|入り|グラム|g$/i
  const hasCorrection = correctionPatterns.test(t)

  if (hasMealType && hasCorrection) return 'both'
  if (hasMealType && !hasCorrection && t.length <= 20) return 'metadata_update'
  if (hasCorrection) return 'food_correction'

  // AI 分類（短いタイムアウト）
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

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
            content: '食事画像の解析結果を確認中のユーザーからのテキストです。分類してください。\n回答は1単語のみ: food_correction / metadata_update / both / unrelated',
          },
          { role: 'user', content: t },
        ],
        temperature: 0,
        max_tokens: 20,
      }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error('AI failed')
    const data = await res.json() as any
    const result = (data.choices?.[0]?.message?.content ?? '').trim().toLowerCase()
    if (['food_correction', 'metadata_update', 'both', 'unrelated'].includes(result)) {
      return result as PendingTextClassification
    }
    return 'unrelated'
  } catch {
    // フォールバック: テキスト長で推測
    return t.length > 5 ? 'food_correction' : 'unrelated'
  } finally {
    clearTimeout(timeoutId)
  }
}
