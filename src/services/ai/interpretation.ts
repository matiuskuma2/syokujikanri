/**
 * src/services/ai/interpretation.ts
 * Phase A: 会話解釈サービス — interpretMessage()
 *
 * ユーザーのテキストメッセージを AI で解析し、
 * Unified Intent JSON に変換する。
 *
 * 正本: docs/11_会話解釈SSOT.md §7
 */

import type { Bindings } from '../../types/bindings'
import type {
  UnifiedIntent,
  UserContext,
  MealTypeValue,
  MealTypeResolution,
} from '../../types/intent'
import {
  validateAndNormalizeIntent,
  DATE_LOOKBACK_DAYS,
  MEMORY_CONFIDENCE_MIN,
  MIDNIGHT_BOUNDARY_HOUR,
  MEAL_TIME_BREAKFAST_START,
  MEAL_TIME_LUNCH_START,
  MEAL_TIME_SNACK_START,
  MEAL_TIME_DINNER_START,
  MEAL_TIME_NIGHT_START,
  resolveBaseDateFromTimestamp,
} from '../../types/intent'
import { createOpenAIClient } from './openai-client'
import { todayJst } from '../../utils/id'

// ===================================================================
// INTERPRETATION_PROMPT（システムプロンプト）
// ===================================================================

function buildInterpretationPrompt(ctx: UserContext): string {
  const recentMsgs = ctx.recent_messages
    .map(m => `[${m.role === 'user' ? 'ユーザー' : 'BOT'}] ${m.text}`)
    .join('\n') || '（なし）'

  const memoryContext = ctx.user_memories.length > 0
    ? ctx.user_memories.map(m => `- [${m.category}] ${m.memory_value}`).join('\n')
    : '（まだ蓄積されていません）'

  return `あなたはダイエット支援BOTの会話解釈エンジンです。
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
${ctx.message_timestamp_jst}（日本時間）

## 今日の日付
${ctx.today_jst}

## 現在のモード
${ctx.current_mode}（record=記録モード、consult=相談モード）

## ユーザーの直近の会話（参考）
${recentMsgs}

## ユーザーの既知情報（参考）
${memoryContext}

## 日付解決ルール
- 「昨日」「きのう」→ 今日 - 1日
- 「おととい」「一昨日」→ 今日 - 2日
- 「今日」「きょう」「今朝」→ 今日
- 「さっき」「今」「たった今」→ 今日（inferred）
- 「3/10」「3月10日」→ 直接パース（年は送信年）
- 「月曜日の」「先週の水曜」→ 直近の該当曜日
- 「朝」「昼」「夜」（単独）→ 今日（inferred）。ただし午前に「夜」→昨日の夜
- 日付が一切不明 → source="unknown"
- **R6: 深夜・早朝ルール**: JST 0:00〜4:59 のメッセージで日付が不明な場合、timestamp推定の基準日は「前日」とする（深夜の食事報告は「昨日の夜食」が自然）
- JST 5:00〜23:59 のメッセージ→ timestamp推定の基準日は「当日」
- **日付をデフォルトで今日にしない**。表現がない場合は timestamp を使用

## 食事区分解決ルール（優先順位順）
1. 明示的キーワード: 朝食/朝ごはん/朝ご飯/モーニング/breakfast → breakfast, 昼食/昼ごはん/ランチ/lunch → lunch, 夕食/夕飯/晩ご飯/ディナー/dinner → dinner, 間食/おやつ/お菓子/スナック/snack → snack, 夜食/深夜メシ → other
2. 時間表現: 「3時に」→ snack、「夜9時に」→ dinner（05:00-10:29→breakfast, 10:30-14:59→lunch, 15:00-17:29→snack, 17:30-22:59→dinner, 23:00-04:59→other）
3. 内容推定: 「ポテチ」「チョコ」→ snack
4. 送信時刻: 上記の時間帯マッピングを使用（source=timestamp, needs_confirmation=true）
5. 不明 → null

## モード切替・操作コマンドの検出
- 「記録する」「記録モード」「記録にして」「戻る」→ switch_record
- 「相談する」「相談モード」「相談にして」「相談続ける」→ switch_consult
- 「問診」「ヒアリング」「登録」「問診やり直し」「問診再開」→ trigger_intake
- 「写真を送る」→ trigger_photo
- 「体重記録」「体重を記録」→ trigger_weight_input
- 注意: 「今日の体重58.5kg」→ record_weight（具体的な数値がある場合は記録であり、切替ではない）
- 注意: 「今日の昧にトースト」→ record_meal（具体的な内容がある場合は記録であり、切替ではない）
- switch/trigger 系は「まだ具体的な記録内容がない」場合にのみ使う

## 修正の検出
- 「鮭じゃなくて卵焼き」→ correct_record (content_change)
- 「朝食じゃなくて夕食」→ correct_record (meal_type_change)
- 「昨日の記録消して」→ delete_record
- 修正は直前の会話コンテキストを参照して対象を特定

## ルール
- 食事区分が不明な場合は meal_type.value を null にしてください
- 「お菓子」「スナック」「ポテチ」「チョコ」等は snack（間食）です
- 相談モードでも「昨日58kgだった」等は intent_secondary=record_weight として検出
- 1メッセージに複数の記録がある場合は、最も重要なものを intent_primary、次を intent_secondary に
- confidence は 0.0-1.0（0.8未満は要確認の目安）
- reply_policy.notify_save: 記録系で明確化不要ならtrue
- reply_policy.generate_consult_reply: 相談モードまたは相談意図ありならtrue
- reply_policy.ask_clarification: needs_clarification が空でないならtrue

## 出力形式（JSON）
{
  "intent_primary": "record_meal" | "record_weight" | "correct_record" | "delete_record" | "consult" | "greeting" | "switch_record" | "switch_consult" | "trigger_intake" | "trigger_photo" | "trigger_weight_input" | "unclear",
  "intent_secondary": null | (同上),
  "target_date": {
    "resolved": "YYYY-MM-DD" | null,
    "original_expression": "昨日" | null,
    "source": "explicit" | "inferred" | "timestamp" | "unknown",
    "needs_confirmation": true | false
  },
  "meal_type": {
    "value": "breakfast" | "lunch" | "dinner" | "snack" | "other" | null,
    "raw_text": "昼ご飯" | null,
    "source": "explicit_keyword" | "time_expression" | "content_inference" | "timestamp" | "unknown",
    "needs_confirmation": true | false
  } | null,
  "record_type": "meal" | "weight" | "progress_photo" | null,
  "content_summary": "...",
  "meal_description": "...",
  "weight_kg": null | number,
  "needs_clarification": [],
  "correction_target": null | {
    "target_date": "YYYY-MM-DD" | null,
    "target_meal_type": "...",
    "correction_type": "meal_type_change" | "content_change" | "date_change" | "nutrition_change" | "delete" | "weight_change",
    "new_value": { ... }
  },
  "confidence": 0.0-1.0,
  "reasoning": "...",
  "reply_policy": { "notify_save": true, "generate_consult_reply": false, "ask_clarification": false }
}`
}

// ===================================================================
// メインエントリ: interpretMessage
// ===================================================================

/**
 * テキストメッセージを AI で解釈し、Unified Intent JSON に変換する。
 *
 * @param messageText  ユーザーのテキスト
 * @param ctx          ユーザーコンテキスト
 * @param env          Cloudflare Bindings
 * @returns Unified Intent JSON
 */
export async function interpretMessage(
  messageText: string,
  ctx: UserContext,
  env: Bindings
): Promise<UnifiedIntent> {
  try {
    const ai = createOpenAIClient(env)
    const systemPrompt = buildInterpretationPrompt(ctx)

    const raw = await ai.createResponse(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: messageText },
      ],
      {
        temperature: 0.2,
        maxTokens: 1024,
        responseFormat: 'json_object',
      }
    )

    // JSON パース
    let parsed: Record<string, unknown>
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      console.warn('[Interpretation] JSON parse failed, raw:', raw.substring(0, 200))
      return createFallbackIntent(messageText, ctx)
    }

    // バリデーション・正規化
    const intent = validateAndNormalizeIntent(parsed)

    // 日付バリデーション: 未来日付チェック
    if (intent.target_date.resolved) {
      const resolvedDate = new Date(intent.target_date.resolved + 'T00:00:00+09:00')
      const todayDate = new Date(ctx.today_jst + 'T23:59:59+09:00')
      const thirtyDaysAgo = new Date(todayDate.getTime() - DATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

      if (resolvedDate > todayDate) {
        // 未来日付 → 要確認
        intent.target_date.resolved = null
        intent.target_date.source = 'unknown'
        intent.target_date.needs_confirmation = true
        if (!intent.needs_clarification.includes('target_date')) {
          intent.needs_clarification.push('target_date')
        }
        intent.reasoning += ' [未来日付を検出: 確認が必要]'
      } else if (resolvedDate < thirtyDaysAgo) {
        // 30日以上前 → 要確認
        intent.target_date.resolved = null
        intent.target_date.source = 'unknown'
        intent.target_date.needs_confirmation = true
        if (!intent.needs_clarification.includes('target_date')) {
          intent.needs_clarification.push('target_date')
        }
        intent.reasoning += ' [30日以上前の日付: 確認が必要]'
      }
    }

    // R6: 深夜ルール — timestamp 推定時に基準日を補正
    if (intent.target_date.source === 'timestamp' && intent.target_date.resolved) {
      const baseDate = resolveBaseDateFromTimestamp(ctx.message_timestamp_jst, ctx.today_jst)
      if (intent.target_date.resolved !== baseDate) {
        console.log(`[Interpretation] R6: adjusting timestamp date from ${intent.target_date.resolved} to ${baseDate}`)
        intent.target_date.resolved = baseDate
      }
    }

    console.log(`[Interpretation] intent=${intent.intent_primary}, confidence=${intent.confidence}, clarify=[${intent.needs_clarification.join(',')}]`)
    return intent
  } catch (err) {
    console.error('[Interpretation] AI error:', err)
    return createFallbackIntent(messageText, ctx)
  }
}

// ===================================================================
// フォールバック: regex ベースの簡易解釈
// ===================================================================

const WEIGHT_PATTERN = /(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|ｋｇ|キロ|Kg|KG)/i

/** AI 失敗時のフォールバック — 従来の regex パターンマッチ
 * R14: fallback_used = 'regex' として監査ログに記録される
 */
export function createFallbackIntent(messageText: string, ctx: UserContext): UnifiedIntent {
  const text = messageText.trim()

  // R6: 深夜ルール適用
  const fallbackBaseDate = resolveBaseDateFromTimestamp(ctx.message_timestamp_jst, ctx.today_jst)

  // ---------------------------------------------------------------
  // R8: 修正パターン検出（「〜じゃなくて〜」「〜ではなく〜」等）
  // ---------------------------------------------------------------
  const correctionMatch = text.match(/(.+?)(?:じゃなくて|ではなく|じゃなく|ではなくて)(.+)/)
  if (correctionMatch) {
    const oldPart = correctionMatch[1].trim()
    const newPart = correctionMatch[2].trim()

    // 食事区分修正の検出
    const oldMealType = classifyMealTypeFallback(oldPart)
    const newMealType = classifyMealTypeFallback(newPart)
    if (oldMealType && newMealType) {
      return {
        intent_primary: 'correct_record',
        intent_secondary: null,
        target_date: { resolved: fallbackBaseDate, original_expression: null, source: 'timestamp', needs_confirmation: false },
        meal_type: null,
        record_type: 'meal',
        content_summary: `${oldPart} → ${newPart}`,
        meal_description: null,
        weight_kg: null,
        needs_clarification: [],
        correction_target: {
          target_date: fallbackBaseDate,
          target_meal_type: oldMealType,
          correction_type: 'meal_type_change',
          new_value: { meal_type: newMealType },
        },
        confidence: 0.8,
        reasoning: 'フォールバック: regex による食事区分修正パターンマッチ',
        reply_policy: { notify_save: true, generate_consult_reply: false, ask_clarification: false },
      }
    }

    // 内容修正の検出（「鮭じゃなくて卵焼き」等）
    return {
      intent_primary: 'correct_record',
      intent_secondary: null,
      target_date: { resolved: fallbackBaseDate, original_expression: null, source: 'timestamp', needs_confirmation: false },
      meal_type: null,
      record_type: 'meal',
      content_summary: `${oldPart} → ${newPart}`,
      meal_description: newPart,
      weight_kg: null,
      needs_clarification: [],
      correction_target: {
        target_date: fallbackBaseDate,
        target_meal_type: null,
        correction_type: 'content_change',
        new_value: { content: newPart },
      },
      confidence: 0.7,
      reasoning: 'フォールバック: regex による内容修正パターンマッチ',
      reply_policy: { notify_save: true, generate_consult_reply: false, ask_clarification: false },
    }
  }

  // 体重パターン
  const weightMatch = text.match(WEIGHT_PATTERN)
  if (weightMatch) {
    const weightKg = parseFloat(weightMatch[1])
    return {
      intent_primary: 'record_weight',
      intent_secondary: null,
      target_date: {
        resolved: fallbackBaseDate,
        original_expression: null,
        source: 'timestamp',
        needs_confirmation: false,
      },
      meal_type: null,
      record_type: 'weight',
      content_summary: `体重 ${weightKg}kg`,
      meal_description: null,
      weight_kg: weightKg,
      needs_clarification: [],
      correction_target: null,
      confidence: 0.9,
      reasoning: 'フォールバック: regex による体重パターンマッチ',
      reply_policy: { notify_save: true, generate_consult_reply: false, ask_clarification: false },
    }
  }

  // ---------------------------------------------------------------
  // R5: 日付表現の解決（regex フォールバック）
  // ---------------------------------------------------------------
  const dateResult = resolveDateFromTextFallback(text, ctx.today_jst)

  // 食事キーワードパターン
  const mealType = classifyMealTypeFallback(text)
  // 食べ物関連動詞の検出でしきい値を下げる
  const hasFoodVerb = /食べ|飲ん|飲み|たべ|のん|のみ|つまみ|かじ/.test(text)
  if (mealType !== null || text.length >= 8 || (hasFoodVerb && text.length >= 3)) {
    return {
      intent_primary: 'record_meal',
      intent_secondary: null,
      target_date: dateResult ?? {
        resolved: fallbackBaseDate,
        original_expression: null,
        source: 'timestamp',
        needs_confirmation: true,
      },
      meal_type: mealType
        ? { value: mealType, raw_text: null, source: 'explicit_keyword', needs_confirmation: false }
        : getMealTypeFromTimestamp(ctx.message_timestamp_jst),
      record_type: 'meal',
      content_summary: text,
      meal_description: text,
      weight_kg: null,
      needs_clarification: mealType ? [] : ['meal_type'],
      correction_target: null,
      confidence: 0.5,
      reasoning: 'フォールバック: regex による食事パターンマッチ',
      reply_policy: { notify_save: false, generate_consult_reply: false, ask_clarification: !mealType },
    }
  }

  // 判定不能
  return {
    intent_primary: 'unclear',
    intent_secondary: null,
    target_date: { resolved: null, original_expression: null, source: 'unknown', needs_confirmation: true },
    meal_type: null,
    record_type: null,
    content_summary: null,
    meal_description: null,
    weight_kg: null,
    needs_clarification: [],
    correction_target: null,
    confidence: 0.1,
    reasoning: 'フォールバック: パターンマッチ不成立',
    reply_policy: { notify_save: false, generate_consult_reply: false, ask_clarification: false },
  }
}

/** R5: テキストから日付表現を解決するフォールバック */
function resolveDateFromTextFallback(text: string, todayJst: string): import('../../types/intent').TargetDate | null {
  const todayDate = new Date(todayJst + 'T00:00:00+09:00')

  if (/昨日|きのう/.test(text)) {
    const d = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000)
    return { resolved: d.toISOString().substring(0, 10), original_expression: '昨日', source: 'explicit', needs_confirmation: false }
  }
  if (/おととい|一昨日/.test(text)) {
    const d = new Date(todayDate.getTime() - 2 * 24 * 60 * 60 * 1000)
    return { resolved: d.toISOString().substring(0, 10), original_expression: 'おととい', source: 'explicit', needs_confirmation: false }
  }
  if (/今日|きょう|今朝/.test(text)) {
    return { resolved: todayJst, original_expression: '今日', source: 'explicit', needs_confirmation: false }
  }
  if (/さっき|たった今|今/.test(text)) {
    return { resolved: todayJst, original_expression: 'さっき', source: 'inferred', needs_confirmation: false }
  }

  // M/D パターン
  const mdMatch = text.match(/(\d{1,2})[月/](\d{1,2})/)
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10)
    const day = parseInt(mdMatch[2], 10)
    const year = todayDate.getFullYear()
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const parsed = new Date(dateStr + 'T00:00:00+09:00')
    const finalDate = parsed > todayDate ? `${year - 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : dateStr
    return { resolved: finalDate, original_expression: `${month}/${day}`, source: 'explicit', needs_confirmation: false }
  }

  return null
}

/** フォールバック用の食事区分分類（従来 regex） */
function classifyMealTypeFallback(text: string): MealTypeValue | null {
  if (/朝食|朝ご飯|朝ごはん|朝飯|モーニング|breakfast/i.test(text)) return 'breakfast'
  if (/昼食|昼ご飯|昼ごはん|昼飯|ランチ|lunch/i.test(text)) return 'lunch'
  if (/夕食|夕飯|夕ご飯|夕ごはん|晩ご飯|晩飯|ディナー|dinner/i.test(text)) return 'dinner'
  if (/間食|おやつ|お菓子|スナック|snack|3時のおやつ/i.test(text)) return 'snack'
  if (/夜食|深夜メシ/i.test(text)) return 'other'
  return null
}

/** メッセージ送信時刻から食事区分を推定 */
function getMealTypeFromTimestamp(timestampJst: string): MealTypeResolution {
  try {
    const hour = parseInt(timestampJst.substring(11, 13), 10)
    const minute = parseInt(timestampJst.substring(14, 16), 10)
    const totalMinutes = hour * 60 + minute

    // R7: 食事区分の時間帯推定ルール (docs/15 §4)
    let value: MealTypeValue
    if (totalMinutes >= MEAL_TIME_BREAKFAST_START && totalMinutes < MEAL_TIME_LUNCH_START) value = 'breakfast'
    else if (totalMinutes >= MEAL_TIME_LUNCH_START && totalMinutes < MEAL_TIME_SNACK_START) value = 'lunch'
    else if (totalMinutes >= MEAL_TIME_SNACK_START && totalMinutes < MEAL_TIME_DINNER_START) value = 'snack'
    else if (totalMinutes >= MEAL_TIME_DINNER_START && totalMinutes < MEAL_TIME_NIGHT_START) value = 'dinner'
    else value = 'other'  // 23:00-04:59

    return {
      value,
      raw_text: null,
      source: 'timestamp',
      needs_confirmation: true,
    }
  } catch {
    return { value: null, raw_text: null, source: 'unknown', needs_confirmation: true }
  }
}

// ===================================================================
// ユーザーコンテキスト構築ヘルパー
// ===================================================================

/**
 * DB から UserContext を構築するヘルパー
 */
export async function buildUserContextForInterpretation(
  db: D1Database,
  threadId: string,
  userAccountId: string,
  currentMode: 'record' | 'consult',
  messageTimestamp: number
): Promise<UserContext> {
  // JST タイムスタンプを計算
  const jstDate = new Date(messageTimestamp + 9 * 60 * 60 * 1000)
  const messageTimestampJst = jstDate.toISOString().replace('T', ' ').substring(0, 19)

  // 直近の会話を取得
  const { listRecentMessages } = await import('../../repositories/conversations-repo')
  const history = await listRecentMessages(db, threadId, 10)
  const recent_messages = history
    .filter(m => m.sender_type === 'user' || m.sender_type === 'bot')
    .slice(-5)
    .map(m => ({
      role: (m.sender_type === 'user' ? 'user' : 'bot') as 'user' | 'bot',
      text: m.raw_text ?? '',
      sent_at: m.sent_at,
    }))

  // ユーザーメモリを取得（存在する場合のみ）
  let user_memories: Array<{ category: string; memory_value: string }> = []
  try {
    const memRows = await db
      .prepare(`
        SELECT category, memory_value FROM user_memory_items
        WHERE user_account_id = ?1 AND is_active = 1 AND confidence_score >= ${MEMORY_CONFIDENCE_MIN}
        ORDER BY updated_at DESC LIMIT 20
      `)
      .bind(userAccountId)
      .all<{ category: string; memory_value: string }>()
    user_memories = memRows.results ?? []
  } catch {
    // テーブルがまだ存在しない場合は無視
  }

  // pending_clarification を取得
  let pending_clarification = null
  try {
    const pending = await db
      .prepare(`
        SELECT * FROM pending_clarifications
        WHERE user_account_id = ?1 AND status = 'asking' AND expires_at > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `)
      .bind(userAccountId)
      .first<Record<string, unknown>>()
    if (pending) {
      pending_clarification = {
        id: pending.id as string,
        intent_json: JSON.parse(pending.intent_json as string),
        missing_fields: JSON.parse(pending.missing_fields as string),
        current_field: pending.current_field as string,
        answers: JSON.parse(pending.answers_json as string),
      }
    }
  } catch {
    // テーブルがまだ存在しない場合は無視
  }

  return {
    current_mode: currentMode,
    message_timestamp_jst: messageTimestampJst,
    today_jst: todayJst(),
    recent_messages,
    pending_clarification,
    user_memories,
  }
}
