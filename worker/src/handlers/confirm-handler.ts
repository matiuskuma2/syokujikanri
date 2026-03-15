/**
 * worker/src/handlers/confirm-handler.ts
 * 画像確認フローハンドラ（state = S2: image_confirm）
 *
 * テキスト入力に応じて:
 *   - 確定 → meal_entries に保存 → S0 に遷移
 *   - 取消 → pending 破棄 → S0 に遷移
 *   - 修正テキスト → AI 修正 → 更新して S2 維持
 *   - 日付/区分変更 → AI 抽出 → 更新して S2 維持
 *   - 無関係テキスト → 案内 push → S2 維持
 */

import type { WorkerEnv, RuntimeState } from '../types'
import { updateRuntimeState } from '../state/runtime-state'
import { sendPushText } from '../send/push-sender'
import { classifyPendingText } from '../ai/classifier'
import { analyzeFoodCorrection, extractMetadata } from '../ai/responder'

const RECORD_QUICK_REPLIES = [
  { label: '📝 続けて記録', text: '記録する' },
  { label: '💬 相談する', text: '相談する' },
]

const CONFIRM_QUICK_REPLIES = [
  { label: '✅ 確定', text: '確定' },
  { label: '❌ 取消', text: '取消' },
]

/**
 * 画像確認中のテキスト処理
 */
export async function handleConfirmAction(
  text: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  const resultId = state.waiting_target_id
  if (!resultId) {
    // データ不整合 → S0 にリセット
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 確認中のデータが見つかりませんでした。もう一度画像を送り直してください。',
      eventId
    )
    return
  }

  // pending テキストの分類
  const classification = await classifyPendingText(text, env)
  console.log(`[ConfirmHandler] text="${text}" → ${classification}`)

  switch (classification) {
    case 'confirm':
      await handleConfirm(resultId, lineUserId, userAccountId, state, env, eventId)
      break
    case 'cancel':
      await handleCancel(resultId, lineUserId, userAccountId, state, env, eventId)
      break
    case 'food_correction':
    case 'both':
      await handleCorrection(text, resultId, lineUserId, userAccountId, state, env, eventId, classification === 'both')
      break
    case 'metadata_update':
      await handleMetadataUpdate(text, resultId, lineUserId, userAccountId, state, env, eventId)
      break
    default:
      // 無関係テキスト → 案内
      await sendPushText(env, lineUserId, userAccountId,
        '🔄 いま前の食事の確認待ちです。\n\n内容を修正する場合は修正内容をテキストで送ってください。\n例: 「鮭ではなくスクランブルエッグ」\n例: 「昨日の夕食」\n\nまたは「✅ 確定」「❌ 取消」で完了してください。',
        eventId,
        CONFIRM_QUICK_REPLIES
      )
  }
}

/**
 * 確定: meal_entries に保存して S0 へ
 */
async function handleConfirm(
  resultId: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  // intake result を取得
  const result = await env.DB.prepare(
    `SELECT * FROM image_intake_results WHERE id = ?1 AND user_account_id = ?2`
  ).bind(resultId, userAccountId).first<{
    id: string
    proposed_action_json: string
    target_date: string
    meal_type: string
    analysis_json: string
    r2_key: string
  }>()

  if (!result) {
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 確認データが見つかりませんでした。',
      eventId
    )
    return
  }

  try {
    const proposed = JSON.parse(result.proposed_action_json)
    const targetDate = result.target_date || getTodayJST()
    const mealType = result.meal_type || 'dinner'

    // daily_log 確保
    const dailyLogId = await ensureDailyLog(env.DB, userAccountId, targetDate)

    // meal_entries に保存
    const mealEntryId = crypto.randomUUID()
    await env.DB.prepare(`
      INSERT INTO meal_entries
        (id, daily_log_id, user_account_id, meal_type, description,
         total_calories, total_protein_g, total_fat_g, total_carbs_g,
         source_type, image_r2_key, is_confirmed, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'image', ?10, 1, datetime('now'), datetime('now'))
    `).bind(
      mealEntryId, dailyLogId, userAccountId, mealType,
      proposed.description || '',
      proposed.calories ?? 0,
      proposed.protein ?? 0,
      proposed.fat ?? 0,
      proposed.carbs ?? 0,
      result.r2_key
    ).run()

    // image_intake_results を確定済みに更新
    await env.DB.prepare(`
      UPDATE image_intake_results SET status = 'applied', updated_at = datetime('now') WHERE id = ?1
    `).bind(resultId).run()

    // runtime_state を S0 に戻す
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })

    const mealTypeJa = { breakfast: '朝食', lunch: '昼食', snack: '間食', dinner: '夕食', night_snack: '夜食' }[mealType] || mealType
    await sendPushText(env, lineUserId, userAccountId,
      `✅ ${mealTypeJa}を保存しました！\n\n🍽 ${proposed.description}\n🔥 ${proposed.calories} kcal\n🥩 P ${proposed.protein}g | 🧈 F ${proposed.fat}g | 🍚 C ${proposed.carbs}g\n📅 ${targetDate}`,
      eventId,
      RECORD_QUICK_REPLIES
    )

  } catch (err) {
    console.error('[ConfirmHandler] confirm error:', err)
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 保存中にエラーが発生しました。もう一度「確定」を送信してください。',
      eventId,
      CONFIRM_QUICK_REPLIES
    )
  }
}

/**
 * 取消: pending 破棄して S0 へ
 */
async function handleCancel(
  resultId: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  try {
    await env.DB.prepare(`
      UPDATE image_intake_results SET status = 'discarded', updated_at = datetime('now') WHERE id = ?1
    `).bind(resultId).run()

    await updateRuntimeState(env.DB, userAccountId, state.version, {
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })

    await sendPushText(env, lineUserId, userAccountId,
      '🗑️ 取り消しました。\n新しい食事記録や写真を送ってください。',
      eventId,
      RECORD_QUICK_REPLIES
    )
  } catch (err) {
    console.error('[ConfirmHandler] cancel error:', err)
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 取消処理中にエラーが発生しました。',
      eventId
    )
  }
}

/**
 * 食品修正
 */
async function handleCorrection(
  text: string,
  resultId: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null,
  includeMetadata: boolean
): Promise<void> {
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM image_intake_results WHERE id = ?1 AND user_account_id = ?2`
    ).bind(resultId, userAccountId).first<{
      proposed_action_json: string
      target_date: string
      meal_type: string
    }>()

    if (!result) {
      await sendPushText(env, lineUserId, userAccountId, '⚠️ 修正対象が見つかりませんでした。', eventId)
      return
    }

    const original = JSON.parse(result.proposed_action_json)

    // AI 修正
    const corrected = await analyzeFoodCorrection(text, {
      description: original.description || '',
      calories: original.calories ?? 0,
      protein: original.protein ?? 0,
      fat: original.fat ?? 0,
      carbs: original.carbs ?? 0,
    }, env)

    // メタデータ変更も含む場合
    let targetDate = result.target_date
    let mealType = result.meal_type
    if (includeMetadata) {
      const meta = await extractMetadata(text, env)
      if (meta.targetDate) targetDate = meta.targetDate
      if (meta.mealType) mealType = meta.mealType
    }

    // DB 更新
    await env.DB.prepare(`
      UPDATE image_intake_results
      SET proposed_action_json = ?2, target_date = ?3, meal_type = ?4, updated_at = datetime('now')
      WHERE id = ?1
    `).bind(
      resultId,
      JSON.stringify(corrected),
      targetDate,
      mealType
    ).run()

    const mealTypeJa = { breakfast: '朝食', lunch: '昼食', snack: '間食', dinner: '夕食', night_snack: '夜食' }[mealType] || mealType
    await sendPushText(env, lineUserId, userAccountId,
      `✏️ 修正を反映しました！\n\n🍽 ${corrected.description}\n🔥 ${corrected.calories} kcal\n🥩 P ${corrected.protein}g | 🧈 F ${corrected.fat}g | 🍚 C ${corrected.carbs}g\n📅 ${targetDate} ${mealTypeJa}\n\nこの内容で記録しますか？`,
      eventId,
      CONFIRM_QUICK_REPLIES
    )

  } catch (err) {
    console.error('[ConfirmHandler] correction error:', err)
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 修正処理中にエラーが発生しました。もう一度お試しください。',
      eventId,
      CONFIRM_QUICK_REPLIES
    )
  }
}

/**
 * 日付・区分変更
 */
async function handleMetadataUpdate(
  text: string,
  resultId: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM image_intake_results WHERE id = ?1 AND user_account_id = ?2`
    ).bind(resultId, userAccountId).first<{
      proposed_action_json: string
      target_date: string
      meal_type: string
    }>()

    if (!result) {
      await sendPushText(env, lineUserId, userAccountId, '⚠️ 変更対象が見つかりませんでした。', eventId)
      return
    }

    const meta = await extractMetadata(text, env)
    const targetDate = meta.targetDate || result.target_date
    const mealType = meta.mealType || result.meal_type

    // DB 更新
    await env.DB.prepare(`
      UPDATE image_intake_results
      SET target_date = ?2, meal_type = ?3, updated_at = datetime('now')
      WHERE id = ?1
    `).bind(resultId, targetDate, mealType).run()

    const proposed = JSON.parse(result.proposed_action_json)
    const mealTypeJa = { breakfast: '朝食', lunch: '昼食', snack: '間食', dinner: '夕食', night_snack: '夜食' }[mealType] || mealType

    await sendPushText(env, lineUserId, userAccountId,
      `📅 ${mealTypeJa}に変更しました！\n\n🍽 ${proposed.description}\n🔥 ${proposed.calories} kcal\n🥩 P ${proposed.protein}g | 🧈 F ${proposed.fat}g | 🍚 C ${proposed.carbs}g\n📅 ${targetDate} ${mealTypeJa}\n\nこの内容で記録しますか？`,
      eventId,
      CONFIRM_QUICK_REPLIES
    )

  } catch (err) {
    console.error('[ConfirmHandler] metadata update error:', err)
    await sendPushText(env, lineUserId, userAccountId,
      '⚠️ 日付・区分の変更中にエラーが発生しました。もう一度お試しください。',
      eventId,
      CONFIRM_QUICK_REPLIES
    )
  }
}

// === ヘルパー ===

function getTodayJST(): string {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  return jstNow.toISOString().split('T')[0]
}

async function ensureDailyLog(db: D1Database, userAccountId: string, date: string): Promise<string> {
  const existing = await db.prepare(`
    SELECT id FROM daily_logs WHERE user_account_id = ?1 AND log_date = ?2
  `).bind(userAccountId, date).first<{ id: string }>()

  if (existing) return existing.id

  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO daily_logs (id, user_account_id, log_date, created_at, updated_at)
    VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
  `).bind(id, userAccountId, date).run()
  return id
}
