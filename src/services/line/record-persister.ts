/**
 * src/services/line/record-persister.ts
 * Phase C: 記録永続化レイヤー
 *
 * Unified Intent JSON（Phase A/B で確定済み）を
 * daily_logs / meal_entries / body_metrics 等に保存する。
 *
 * 正本: docs/12_記録確認フローSSOT.md §2
 */

import type { Bindings } from '../../types/bindings'
import type { UnifiedIntent, MealTypeValue } from '../../types/intent'
import { mealTypeToJa, WEIGHT_MIN, WEIGHT_MAX, MEAL_TEXT_MAX_LENGTH } from '../../types/intent'
import { ensureDailyLog } from '../../repositories/daily-logs-repo'
import {
  createMealEntry,
  findMealEntryByDailyLogAndType,
  updateMealEntryFromEstimate,
} from '../../repositories/meal-entries-repo'
import { upsertWeight, upsertBodyMetrics } from '../../repositories/body-metrics-repo'
import { createCorrectionHistory } from '../../repositories/correction-history-repo'
import { todayJst, nowIso } from '../../utils/id'

// ===================================================================
// メインエントリ: persistRecord
// ===================================================================

export type PersistResult = {
  success: boolean
  replyMessage: string
  error?: string
  /** R13: 監査ログ用の保存アクション */
  persist_action?: 'created' | 'updated' | 'appended' | 'rejected'
}

/**
 * Unified Intent を DB に保存し、BOT 返信メッセージを返す。
 */
export async function persistRecord(
  intent: UnifiedIntent,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<PersistResult> {
  try {
    switch (intent.intent_primary) {
      case 'record_meal':
        return await persistMealRecord(intent, userAccountId, clientAccountId, env)

      case 'record_weight':
        return await persistWeightRecord(intent, userAccountId, clientAccountId, env)

      case 'correct_record':
        return await persistCorrection(intent, userAccountId, clientAccountId, env)

      case 'delete_record':
        return await persistDeletion(intent, userAccountId, clientAccountId, env)

      default:
        return {
          success: false,
          replyMessage: '記録の種別が判定できませんでした。',
          error: `Unexpected intent_primary: ${intent.intent_primary}`,
        }
    }
  } catch (err) {
    console.error('[RecordPersister] error:', err)
    return {
      success: false,
      replyMessage: '記録の保存中にエラーが発生しました。もう一度お試しください。',
      error: String(err),
    }
  }
}

// ===================================================================
// 食事記録の保存
// ===================================================================

async function persistMealRecord(
  intent: UnifiedIntent,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<PersistResult> {
  const logDate = intent.target_date.resolved ?? todayJst()
  const mealType = intent.meal_type?.value ?? 'other'
  const mealText = intent.content_summary ?? intent.meal_description ?? ''

  // 1. ensureDailyLog
  const dailyLog = await ensureDailyLog(env.DB, {
    userAccountId,
    clientAccountId,
    logDate,
  })

  // 2. 同日・同区分の既存チェック
  const existing = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, mealType)

  if (existing) {
    // R4-2 + R9: 追記 — correction_history に correction_type='append' で記録
    const oldText = existing.meal_text ?? ''
    const newText = [oldText, mealText].filter(Boolean).join(' / ')

    // R4: meal_text 上限チェック
    if (newText.length > MEAL_TEXT_MAX_LENGTH) {
      console.log(`[RecordPersister] rejected: table=meal_entries, date=${logDate}, type=${mealType}, reason=meal_text_too_long (${newText.length}chars)`)
      return {
        success: false,
        replyMessage: '記録が長すぎます。修正で内容を整理してください。',
      }
    }

    await updateMealEntryFromEstimate(env.DB, existing.id, {
      mealText: newText,
      confirmationStatus: 'confirmed',
    })

    console.log(`[RecordPersister] updated(appended): table=meal_entries, id=${existing.id}, date=${logDate}, type=${mealType}`)

    // R9: 追記でも correction_history を残す
    try {
      await createCorrectionHistory(env.DB, {
        userAccountId,
        targetTable: 'meal_entries',
        targetRecordId: existing.id,
        correctionType: 'append',
        oldValueJson: JSON.stringify({ meal_text: oldText }),
        newValueJson: JSON.stringify({ meal_text: newText }),
        reason: 'R4: 同日同区分への追記',
      })
    } catch (e) { console.warn('[RecordPersister] append correction_history error:', e) }
  } else {
    // R4-1: 新規作成
    await createMealEntry(env.DB, {
      dailyLogId: dailyLog.id,
      mealType,
      mealText,
      confirmationStatus: 'confirmed',
    })
    console.log(`[RecordPersister] created: table=meal_entries, date=${logDate}, type=${mealType}`)
  }

  // 3. 返信メッセージ組立
  const dateDisplay = formatDateForReply(logDate)
  const mealTypeJa = mealTypeToJa(mealType)
  const replyMessage = `📝 ${dateDisplay}の${mealTypeJa}を記録しました！\n\n🍽 ${mealText}\n\n※修正が必要な場合はテキストで教えてください\n  例: 「鮭じゃなくて卵焼き」「夕食じゃなくて朝食」`

  return { success: true, replyMessage, persist_action: existing ? 'appended' : 'created' }
}

// ===================================================================
// 体重記録の保存
// ===================================================================

async function persistWeightRecord(
  intent: UnifiedIntent,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<PersistResult> {
  const weightKg = intent.weight_kg
  // R2: 体重バリデーション (docs/15_実装前確定ルールSSOT.md)
  if (!weightKg || weightKg < WEIGHT_MIN || weightKg > WEIGHT_MAX) {
    return {
      success: false,
      replyMessage: `体重の値が正しくないようです。${WEIGHT_MIN}〜${WEIGHT_MAX}kgの範囲で入力してください。`,
    }
  }

  const logDate = intent.target_date.resolved ?? todayJst()

  // 1. ensureDailyLog
  const dailyLog = await ensureDailyLog(env.DB, {
    userAccountId,
    clientAccountId,
    logDate,
  })

  // 2. upsertBodyMetrics
  await upsertBodyMetrics(env.DB, {
    dailyLogId: dailyLog.id,
    weightKg,
  })

  console.log(`[RecordPersister] created: table=body_metrics, date=${logDate}, weight=${weightKg}`)

  // 3. 前回比を計算（可能なら）
  let comparisonText = ''
  try {
    const prev = await env.DB.prepare(`
      SELECT bm.weight_kg FROM body_metrics bm
      JOIN daily_logs dl ON dl.id = bm.daily_log_id
      WHERE dl.user_account_id = ?1 AND dl.log_date < ?2 AND bm.weight_kg IS NOT NULL
      ORDER BY dl.log_date DESC LIMIT 1
    `).bind(userAccountId, logDate).first<{ weight_kg: number }>()

    if (prev?.weight_kg) {
      const diff = weightKg - prev.weight_kg
      if (Math.abs(diff) >= 0.1) {
        comparisonText = `\n前回比: ${diff > 0 ? '+' : ''}${diff.toFixed(1)}kg`
      } else {
        comparisonText = '\n前回比: 変化なし'
      }
    }
  } catch { /* ignore */ }

  const dateDisplay = formatDateForReply(logDate)
  const replyMessage = `📝 ${dateDisplay}の体重を記録しました！\n\n⚖️ ${weightKg}kg${comparisonText}`

  return { success: true, replyMessage, persist_action: 'created' }
}

// ===================================================================
// 修正の保存
// ===================================================================

async function persistCorrection(
  intent: UnifiedIntent,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<PersistResult> {
  const ct = intent.correction_target
  if (!ct) {
    return { success: false, replyMessage: '修正対象が特定できませんでした。' }
  }

  const targetDate = ct.target_date ?? todayJst()
  const targetMealType = ct.target_meal_type

  // 対象レコードを検索
  const dailyLog = await env.DB.prepare(`
    SELECT id FROM daily_logs
    WHERE user_account_id = ?1 AND log_date = ?2
    LIMIT 1
  `).bind(userAccountId, targetDate).first<{ id: string }>()

  if (!dailyLog) {
    return { success: false, replyMessage: `${formatDateForReply(targetDate)}の記録が見つかりませんでした。` }
  }

  // 修正タイプに応じて処理
  switch (ct.correction_type) {
    case 'meal_type_change': {
      if (!targetMealType || !ct.new_value?.meal_type) {
        return { success: false, replyMessage: '食事区分の修正内容が不足しています。' }
      }

      const entry = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, targetMealType)
      if (!entry) {
        return { success: false, replyMessage: `${formatDateForReply(targetDate)}の${mealTypeToJa(targetMealType)}の記録が見つかりませんでした。` }
      }

      const oldValue = { meal_type: entry.meal_type }
      await env.DB.prepare(`
        UPDATE meal_entries SET meal_type = ?1, updated_at = ?2 WHERE id = ?3
      `).bind(ct.new_value.meal_type, nowIso(), entry.id).run()

      await createCorrectionHistory(env.DB, {
        userAccountId,
        targetTable: 'meal_entries',
        targetRecordId: entry.id,
        correctionType: 'meal_type_change',
        oldValueJson: JSON.stringify(oldValue),
        newValueJson: JSON.stringify({ meal_type: ct.new_value.meal_type }),
        reason: intent.reasoning,
      })

      return {
        success: true,
        replyMessage: `✏️ 記録を修正しました！\n\n📅 ${formatDateForReply(targetDate)}\n変更前: ${mealTypeToJa(targetMealType)}\n変更後: ${mealTypeToJa(ct.new_value.meal_type)}`,
        persist_action: 'updated',
      }
    }

    case 'content_change': {
      const mealType = targetMealType ?? 'other'
      const entry = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, mealType)
      if (!entry) {
        return { success: false, replyMessage: `${formatDateForReply(targetDate)}の${mealTypeToJa(mealType)}の記録が見つかりませんでした。` }
      }

      const oldValue = { meal_text: entry.meal_text }
      const newText = ct.new_value?.content ?? intent.meal_description ?? ''

      await updateMealEntryFromEstimate(env.DB, entry.id, {
        mealText: newText,
        confirmationStatus: 'corrected',
      })

      await createCorrectionHistory(env.DB, {
        userAccountId,
        targetTable: 'meal_entries',
        targetRecordId: entry.id,
        correctionType: 'content_change',
        oldValueJson: JSON.stringify(oldValue),
        newValueJson: JSON.stringify({ meal_text: newText }),
        reason: intent.reasoning,
      })

      return {
        success: true,
        replyMessage: `✏️ 記録を修正しました！\n\n📅 ${formatDateForReply(targetDate)}の${mealTypeToJa(mealType)}\n変更前: ${entry.meal_text || '（なし）'}\n変更後: ${newText}`,
        persist_action: 'updated',
      }
    }

    case 'weight_change': {
      if (!ct.new_value?.weight_kg) {
        return { success: false, replyMessage: '体重の修正値が不足しています。' }
      }

      const bm = await env.DB.prepare(`
        SELECT bm.* FROM body_metrics bm
        JOIN daily_logs dl ON dl.id = bm.daily_log_id
        WHERE dl.user_account_id = ?1 AND dl.log_date = ?2
        LIMIT 1
      `).bind(userAccountId, targetDate).first<{ id: string; weight_kg: number }>()

      if (!bm) {
        return { success: false, replyMessage: `${formatDateForReply(targetDate)}の体重記録が見つかりませんでした。` }
      }

      const oldValue = { weight_kg: bm.weight_kg }
      await env.DB.prepare(`
        UPDATE body_metrics SET weight_kg = ?1, updated_at = ?2 WHERE id = ?3
      `).bind(ct.new_value.weight_kg, nowIso(), bm.id).run()

      await createCorrectionHistory(env.DB, {
        userAccountId,
        targetTable: 'body_metrics',
        targetRecordId: bm.id,
        correctionType: 'weight_change',
        oldValueJson: JSON.stringify(oldValue),
        newValueJson: JSON.stringify({ weight_kg: ct.new_value.weight_kg }),
        reason: intent.reasoning,
      })

      return {
        success: true,
        replyMessage: `✏️ 体重を修正しました！\n\n📅 ${formatDateForReply(targetDate)}\n変更前: ${bm.weight_kg}kg\n変更後: ${ct.new_value.weight_kg}kg`,
        persist_action: 'updated',
      }
    }

    default:
      return {
        success: false,
        replyMessage: '修正タイプがサポートされていません。',
      }
  }
}

// ===================================================================
// 削除の保存
// ===================================================================

async function persistDeletion(
  intent: UnifiedIntent,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<PersistResult> {
  const ct = intent.correction_target
  if (!ct) {
    return { success: false, replyMessage: '削除対象が特定できませんでした。' }
  }

  const targetDate = ct.target_date ?? todayJst()
  const targetMealType = ct.target_meal_type

  const dailyLog = await env.DB.prepare(`
    SELECT id FROM daily_logs
    WHERE user_account_id = ?1 AND log_date = ?2
    LIMIT 1
  `).bind(userAccountId, targetDate).first<{ id: string }>()

  if (!dailyLog) {
    return { success: false, replyMessage: `${formatDateForReply(targetDate)}の記録が見つかりませんでした。` }
  }

  if (targetMealType) {
    const entry = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, targetMealType)
    if (!entry) {
      return { success: false, replyMessage: `${formatDateForReply(targetDate)}の${mealTypeToJa(targetMealType)}の記録が見つかりませんでした。` }
    }

    await createCorrectionHistory(env.DB, {
      userAccountId,
      targetTable: 'meal_entries',
      targetRecordId: entry.id,
      correctionType: 'delete',
      oldValueJson: JSON.stringify({ meal_type: entry.meal_type, meal_text: entry.meal_text }),
      reason: intent.reasoning,
    })

    await env.DB.prepare('DELETE FROM meal_entries WHERE id = ?1').bind(entry.id).run()

    return {
      success: true,
      replyMessage: `🗑 ${formatDateForReply(targetDate)}の${mealTypeToJa(targetMealType)}の記録を削除しました。`,
      persist_action: 'updated',  // 削除もhistory的にはupdated
    }
  }

  return { success: false, replyMessage: '削除対象を特定できませんでした。具体的に教えてください。' }
}

// ===================================================================
// ヘルパー
// ===================================================================

function formatDateForReply(dateStr: string): string {
  const today = todayJst()
  if (dateStr === today) return '今日'

  const todayDate = new Date(today + 'T00:00:00+09:00')
  const targetDate = new Date(dateStr + 'T00:00:00+09:00')
  const diffDays = Math.round((todayDate.getTime() - targetDate.getTime()) / (24 * 60 * 60 * 1000))

  if (diffDays === 1) return '昨日'
  if (diffDays === 2) return 'おととい'

  // M/D 形式
  const month = targetDate.getMonth() + 1
  const day = targetDate.getDate()
  return `${month}/${day}`
}
