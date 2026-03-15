/**
 * src/services/line/clarification-handler.ts
 * Phase B: 明確化フロー
 *
 * Unified Intent JSON に不足フィールドがある場合、
 * ユーザーに質問を送り、回答を収集する。
 *
 * 正本: docs/12_記録確認フローSSOT.md §1
 */

import type { Bindings } from '../../types/bindings'
import type {
  UnifiedIntent,
  ClarificationField,
  MealTypeValue,
  PendingClarification,
} from '../../types/intent'
import { WEIGHT_MIN, WEIGHT_MAX } from '../../types/intent'
import { replyTextWithQuickReplies, replyText, pushText, pushWithQuickReplies } from './reply'
import { upsertModeSession } from '../../repositories/mode-sessions-repo'
import {
  createPendingClarification,
  findActiveClarification,
  findClarificationById,
  updateClarificationAnswer,
  cancelActiveClarifications,
} from '../../repositories/pending-clarifications-repo'
import { todayJst } from '../../utils/id'

// ===================================================================
// 質問テンプレート・優先順位
// ===================================================================

/** 不足フィールドの質問優先順位（SSOT §1.3） */
const CLARIFICATION_PRIORITY: ClarificationField[] = [
  'content',       // 何を食べたかが最も重要
  'target_date',   // 日付が決まらないと保存先が決まらない
  'meal_type',     // 日付が決まった後に食事区分を確認
  'weight_value',  // 体重値の確認
]

/** フィールドごとの質問テンプレート */
function buildClarificationQuestion(field: ClarificationField, intent: UnifiedIntent): {
  text: string
  quickReplies: Array<{ label: string; text: string }>
} {
  switch (field) {
    case 'target_date':
      return {
        text: `🤔 いつの記録ですか？${intent.content_summary ? `\n（「${intent.content_summary}」）` : ''}`,
        quickReplies: [
          { label: '今日', text: '今日' },
          { label: '昨日', text: '昨日' },
          { label: 'おととい', text: 'おととい' },
          { label: '日付を入力', text: '日付を入力' },
        ],
      }

    case 'meal_type': {
      const dateStr = intent.target_date.resolved
        ? `${intent.target_date.resolved.substring(5).replace('-', '/')}の`
        : ''
      return {
        text: `🤔 ${dateStr}何の食事ですか？${intent.content_summary ? `\n（「${intent.content_summary}」）` : ''}`,
        quickReplies: [
          { label: '🌅 朝食', text: '朝食' },
          { label: '☀️ 昼食', text: '昼食' },
          { label: '🌙 夕食', text: '夕食' },
          { label: '🍪 間食', text: '間食' },
          { label: '🌃 その他', text: 'その他' },
        ],
      }
    }

    case 'content':
      return {
        text: '🤔 何を食べましたか？（テキストで教えてください）',
        quickReplies: [],
      }

    case 'weight_value':
      return {
        text: '🤔 体重は何kgですか？（数字で教えてください）\n\n例: 58.5',
        quickReplies: [],
      }

    default:
      return {
        text: '🤔 もう少し教えてください。',
        quickReplies: [],
      }
  }
}

// ===================================================================
// 明確化フロー開始
// ===================================================================

/**
 * 明確化フローを開始する
 * pending_clarifications にレコードを作成し、最優先のフィールドについて質問する
 */
export async function startClarificationFlow(
  replyToken: string,
  intent: UnifiedIntent,
  originalMessage: string,
  userAccountId: string,
  clientAccountId: string,
  messageId: string | null,
  lineUserId: string,
  env: Bindings
): Promise<void> {
  // 優先順位に従って最初の質問フィールドを決定
  const sortedFields = intent.needs_clarification.sort(
    (a, b) => CLARIFICATION_PRIORITY.indexOf(a) - CLARIFICATION_PRIORITY.indexOf(b)
  )
  const currentField = sortedFields[0]

  // pending_clarifications に保存
  const pending = await createPendingClarification(env.DB, {
    userAccountId,
    clientAccountId,
    intentJson: JSON.stringify(intent),
    originalMessage,
    messageId,
    missingFields: sortedFields,
    currentField,
  })

  // bot_mode_sessions を更新
  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'record',
    currentStep: 'pending_clarification',
    sessionData: { clarificationId: pending.id },
  })

  // 質問を送信（reply + push フォールバック）
  const question = buildClarificationQuestion(currentField, intent)
  try {
    if (question.quickReplies.length > 0) {
      await replyTextWithQuickReplies(
        replyToken,
        question.text,
        question.quickReplies,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } else {
      await replyText(replyToken, question.text, env.LINE_CHANNEL_ACCESS_TOKEN)
    }
  } catch (replyErr) {
    console.warn('[Clarification] reply failed, falling back to push:', replyErr)
    try {
      if (question.quickReplies.length > 0 && lineUserId) {
        await pushWithQuickReplies(lineUserId, question.text, question.quickReplies, env.LINE_CHANNEL_ACCESS_TOKEN)
      } else if (lineUserId) {
        await pushText(lineUserId, question.text, env.LINE_CHANNEL_ACCESS_TOKEN)
      }
    } catch (pushErr) {
      console.error('[Clarification] push fallback also failed:', pushErr)
    }
  }

  console.log(`[Clarification] started: id=${pending.id}, field=${currentField}, fields=[${sortedFields.join(',')}]`)
}

// ===================================================================
// 明確化回答処理
// ===================================================================

/**
 * 明確化質問に対するユーザーの回答を処理する
 * @returns 処理結果: { complete: boolean, updatedIntent?: UnifiedIntent }
 */
export async function handleClarificationAnswer(
  text: string,
  userAccountId: string,
  clientAccountId: string,
  lineUserId: string,
  env: Bindings
): Promise<{
  complete: boolean
  updatedIntent: UnifiedIntent | null
  pendingId: string | null
}> {
  // アクティブな明確化を取得
  const pending = await findActiveClarification(env.DB, userAccountId)
  if (!pending) {
    return { complete: false, updatedIntent: null, pendingId: null }
  }

  // Intent JSON を復元
  let intent: UnifiedIntent
  try {
    intent = JSON.parse(pending.intent_json)
  } catch {
    await cancelActiveClarifications(env.DB, userAccountId)
    return { complete: false, updatedIntent: null, pendingId: pending.id }
  }

  // 回答をパース
  const currentField = pending.current_field as ClarificationField
  const parseResult = parseClarificationAnswer(currentField, text)

  if (!parseResult.success) {
    // パース失敗 → 再質問
    return { complete: false, updatedIntent: null, pendingId: pending.id }
  }

  // 回答を Intent に反映
  const answers = JSON.parse(pending.answers_json) as Record<string, unknown>
  answers[currentField] = parseResult.value
  applyAnswerToIntent(intent, currentField, parseResult.value)

  // 残りの不足フィールドを計算
  const missingFields = JSON.parse(pending.missing_fields) as ClarificationField[]
  const remainingFields = missingFields.filter(f => !(f in answers))

  if (remainingFields.length === 0) {
    // 全フィールド回答済み → Phase C へ
    intent.needs_clarification = []
    await updateClarificationAnswer(env.DB, pending.id, {
      answersJson: JSON.stringify(answers),
      currentField: null,
      intentJson: JSON.stringify(intent),
    })

    return {
      complete: true,
      updatedIntent: intent,
      pendingId: pending.id,
    }
  } else {
    // まだ不足あり → 次の質問
    const nextField = remainingFields.sort(
      (a, b) => CLARIFICATION_PRIORITY.indexOf(a) - CLARIFICATION_PRIORITY.indexOf(b)
    )[0]

    // intent の needs_clarification を更新
    intent.needs_clarification = remainingFields

    await updateClarificationAnswer(env.DB, pending.id, {
      answersJson: JSON.stringify(answers),
      currentField: nextField,
      intentJson: JSON.stringify(intent),
    })

    return {
      complete: false,
      updatedIntent: intent,
      pendingId: pending.id,
    }
  }
}

/**
 * 次の質問を送信する（handleClarificationAnswer の後に呼ぶ）
 */
/**
 * 次の質問を送信する（handleClarificationAnswer の後に呼ぶ）
 */
export async function sendNextClarificationQuestion(
  replyToken: string,
  intent: UnifiedIntent,
  pendingId: string,
  env: Bindings,
  lineUserId?: string
): Promise<void> {
  // pending_clarifications から現在のフィールドを取得
  const pending = await findClarificationById(env.DB, pendingId)
  if (!pending) return

  const currentField = pending.current_field as ClarificationField
  if (!currentField) return

  const question = buildClarificationQuestion(currentField, intent)
  try {
    if (question.quickReplies.length > 0) {
      await replyTextWithQuickReplies(
        replyToken,
        question.text,
        question.quickReplies,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } else {
      await replyText(replyToken, question.text, env.LINE_CHANNEL_ACCESS_TOKEN)
    }
  } catch (replyErr) {
    console.warn('[Clarification] sendNext reply failed, falling back to push:', replyErr)
    try {
      if (question.quickReplies.length > 0 && lineUserId) {
        await pushWithQuickReplies(lineUserId, question.text, question.quickReplies, env.LINE_CHANNEL_ACCESS_TOKEN)
      } else if (lineUserId) {
        await pushText(lineUserId, question.text, env.LINE_CHANNEL_ACCESS_TOKEN)
      }
    } catch (pushErr) {
      console.error('[Clarification] sendNext push fallback also failed:', pushErr)
    }
  }
}

// ===================================================================
// 回答パース
// ===================================================================

type ParseResult = { success: true; value: unknown } | { success: false }

function parseClarificationAnswer(field: ClarificationField, answer: string): ParseResult {
  switch (field) {
    case 'target_date':
      return parseDateAnswer(answer)
    case 'meal_type':
      return parseMealTypeAnswer(answer)
    case 'content':
      return { success: true, value: answer.trim() }
    case 'weight_value':
      return parseWeightAnswer(answer)
    default:
      return { success: false }
  }
}

function parseDateAnswer(answer: string): ParseResult {
  const text = answer.trim()
  const today = todayJst()
  const todayDate = new Date(today + 'T00:00:00+09:00')

  if (/^(今日|きょう|today)$/i.test(text)) {
    return { success: true, value: today }
  }
  if (/^(昨日|きのう|yesterday)$/i.test(text)) {
    const d = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000)
    return { success: true, value: d.toISOString().substring(0, 10) }
  }
  if (/^(おととい|一昨日)$/i.test(text)) {
    const d = new Date(todayDate.getTime() - 2 * 24 * 60 * 60 * 1000)
    return { success: true, value: d.toISOString().substring(0, 10) }
  }

  // M/D 形式
  const mdMatch = text.match(/(\d{1,2})[\/月](\d{1,2})/)
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10)
    const day = parseInt(mdMatch[2], 10)
    const year = todayDate.getFullYear()
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    // 未来日付の場合は前年
    const parsed = new Date(dateStr + 'T00:00:00+09:00')
    if (parsed > todayDate) {
      return { success: true, value: `${year - 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
    }
    return { success: true, value: dateStr }
  }

  return { success: false }
}

function parseMealTypeAnswer(answer: string): ParseResult {
  const text = answer.trim()
  const mapping: Record<string, MealTypeValue> = {
    '朝食': 'breakfast', 'morning': 'breakfast', 'モーニング': 'breakfast',
    '朝ごはん': 'breakfast', '朝ご飯': 'breakfast',
    '昼食': 'lunch', 'ランチ': 'lunch', 'lunch': 'lunch',
    '昼ごはん': 'lunch', '昼ご飯': 'lunch',
    '夕食': 'dinner', 'ディナー': 'dinner', 'dinner': 'dinner',
    '夕飯': 'dinner', '晩ご飯': 'dinner', '夕ご飯': 'dinner',
    '間食': 'snack', 'おやつ': 'snack', 'snack': 'snack',
    'その他': 'other', '夜食': 'other',
  }

  for (const [key, value] of Object.entries(mapping)) {
    if (text.includes(key)) return { success: true, value }
  }

  return { success: false }
}

function parseWeightAnswer(answer: string): ParseResult {
  const match = answer.match(/(\d{2,3}(?:\.\d{1,2})?)/)
  if (match) {
    const weight = parseFloat(match[1])
    if (weight >= WEIGHT_MIN && weight <= WEIGHT_MAX) {
      return { success: true, value: weight }
    }
  }
  return { success: false }
}

// ===================================================================
// Intent への回答反映
// ===================================================================

function applyAnswerToIntent(intent: UnifiedIntent, field: ClarificationField, value: unknown): void {
  switch (field) {
    case 'target_date':
      intent.target_date = {
        resolved: value as string,
        original_expression: null,
        source: 'explicit',
        needs_confirmation: false,
      }
      break

    case 'meal_type':
      intent.meal_type = {
        value: value as MealTypeValue,
        raw_text: null,
        source: 'explicit_keyword',
        needs_confirmation: false,
      }
      break

    case 'content':
      intent.content_summary = value as string
      intent.meal_description = value as string
      break

    case 'weight_value':
      intent.weight_kg = value as number
      break
  }
}
