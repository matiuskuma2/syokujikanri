/**
 * src/services/line/image-confirm.ts
 * 画像解析結果の確認/取消ハンドラー
 *
 * M3-6: ユーザーが「確定」「取消」と応答した時に
 *   - 確定 → proposed_action_json に基づきメインテーブルに反映、applied_flag=1
 *   - 取消 → applied_flag=2、メインテーブルには反映しない
 *
 * mode_session の current_step === 'pending_image_confirm' の時に呼ばれる
 */

import type { Bindings } from '../../types/bindings'
import type { ImageIntakeResult, BotModeSession } from '../../types/db'
import {
  findIntakeResultById,
  markIntakeResultApplied,
  markIntakeResultDiscarded,
} from '../../repositories/image-intake-repo'
import { ensureDailyLog } from '../../repositories/daily-logs-repo'
import {
  createMealEntry,
  findMealEntryByDailyLogAndType,
  updateMealEntryFromEstimate,
  incrementMealPhotoCount,
} from '../../repositories/meal-entries-repo'
import { upsertBodyMetrics } from '../../repositories/body-metrics-repo'
import { createProgressPhoto } from '../../repositories/progress-photos-repo'
import { deleteModeSession } from '../../repositories/mode-sessions-repo'
import { replyText, replyWithQuickReplies } from './reply'
import { todayJst } from '../../utils/id'

// ===================================================================
// 確認応答のディスパッチ
// ===================================================================

/**
 * pending_image_confirm セッション中のテキスト応答を処理
 *
 * @returns true: 処理完了（呼び出し元で return） / false: 未処理（通常フローへ）
 */
export async function handleImageConfirmResponse(
  replyToken: string,
  text: string,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  session: BotModeSession,
  env: Bindings
): Promise<boolean> {
  // session_data から intakeResultId を取得
  let sessionData: { intakeResultId?: string; category?: string } = {}
  if (session.session_data) {
    try {
      sessionData = JSON.parse(session.session_data)
    } catch {
      sessionData = {}
    }
  }

  const resultId = sessionData.intakeResultId
  if (!resultId) {
    // セッションデータが壊れている → セッション削除して通常フローへ
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return false
  }

  const textLower = text.toLowerCase()

  // ----- 確定 -----
  if (['確定', 'ok', 'はい', 'yes', '記録', '保存'].some(kw => textLower.includes(kw))) {
    await applyIntakeResult(replyToken, resultId, userAccountId, clientAccountId, lineUserId, env)
    return true
  }

  // ----- 取消 -----
  if (['取消', 'キャンセル', 'cancel', 'いいえ', 'no', 'やめる', '削除'].some(kw => textLower.includes(kw))) {
    await discardIntakeResult(replyToken, resultId, clientAccountId, lineUserId, env)
    return true
  }

  // ----- 判定できない → 再度確認を促す -----
  await replyWithQuickReplies(
    replyToken,
    '画像の解析結果を記録しますか？\n「確定」または「取消」で応答してください。',
    [
      { label: '✅ 確定', text: '確定' },
      { label: '❌ 取消', text: '取消' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
  return true
}

// ===================================================================
// 確定処理: proposed_action_json → メインテーブルに反映
// ===================================================================

async function applyIntakeResult(
  replyToken: string,
  resultId: string,
  userAccountId: string,
  clientAccountId: string,
  lineUserId: string,
  env: Bindings
): Promise<void> {
  const result = await findIntakeResultById(env.DB, resultId)
  if (!result || result.applied_flag !== 0) {
    await replyText(replyToken, '該当する解析結果が見つからないか、既に処理済みです。', env.LINE_CHANNEL_ACCESS_TOKEN)
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  let action: Record<string, unknown> = {}
  if (result.proposed_action_json) {
    try {
      action = JSON.parse(result.proposed_action_json)
    } catch {
      action = {}
    }
  }

  let replyMessage = ''

  try {
    switch (action.action) {
      case 'create_or_update_meal_entry':
        replyMessage = await applyMealEntry(action, userAccountId, clientAccountId, env)
        break

      case 'upsert_weight':
        replyMessage = await applyWeight(action, userAccountId, clientAccountId, env)
        break

      case 'create_progress_photo':
        replyMessage = await applyProgressPhoto(action, userAccountId, clientAccountId, env)
        break

      case 'none':
        replyMessage = '記録する内容がありませんでした。'
        break

      default:
        replyMessage = '記録を確定しました ✅'
        break
    }

    // applied_flag = 1 に更新
    await markIntakeResultApplied(env.DB, resultId)
  } catch (err) {
    console.error('[ImageConfirm] apply failed:', err)
    replyMessage = '記録の保存中にエラーが発生しました。お手数ですが、もう一度お試しください。'
  }

  // mode_session を解除
  await deleteModeSession(env.DB, clientAccountId, lineUserId)

  await replyText(replyToken, replyMessage, env.LINE_CHANNEL_ACCESS_TOKEN)
}

// ===================================================================
// 取消処理
// ===================================================================

async function discardIntakeResult(
  replyToken: string,
  resultId: string,
  clientAccountId: string,
  lineUserId: string,
  env: Bindings
): Promise<void> {
  await markIntakeResultDiscarded(env.DB, resultId)
  await deleteModeSession(env.DB, clientAccountId, lineUserId)

  await replyText(
    replyToken,
    '❌ 画像の解析結果を取り消しました。\n記録されていません。',
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// メインテーブル反映ヘルパー
// ===================================================================

async function applyMealEntry(
  action: Record<string, unknown>,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<string> {
  const today = todayJst()
  const dailyLog = await ensureDailyLog(env.DB, {
    userAccountId,
    clientAccountId,
    logDate: today,
  })

  const mealType = (action.meal_type as string) ?? 'other'
  const validTypes = ['breakfast', 'lunch', 'dinner', 'snack', 'other']
  const safeMealType = validTypes.includes(mealType)
    ? (mealType as 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other')
    : 'other'

  const existing = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, safeMealType)

  if (existing) {
    await updateMealEntryFromEstimate(env.DB, existing.id, {
      mealText: (action.meal_text as string) ?? null,
      caloriesKcal: (action.calories_kcal as number) ?? null,
      proteinG: (action.protein_g as number) ?? null,
      fatG: (action.fat_g as number) ?? null,
      carbsG: (action.carbs_g as number) ?? null,
      confirmationStatus: 'confirmed',
    })
    await incrementMealPhotoCount(env.DB, existing.id)
  } else {
    await createMealEntry(env.DB, {
      dailyLogId: dailyLog.id,
      mealType: safeMealType,
      mealText: (action.meal_text as string) ?? null,
      caloriesKcal: (action.calories_kcal as number) ?? null,
      proteinG: (action.protein_g as number) ?? null,
      fatG: (action.fat_g as number) ?? null,
      carbsG: (action.carbs_g as number) ?? null,
      confirmationStatus: 'confirmed',
    })
  }

  const mealTypeJa =
    safeMealType === 'breakfast' ? '朝食' :
    safeMealType === 'lunch' ? '昼食' :
    safeMealType === 'dinner' ? '夕食' :
    safeMealType === 'snack' ? '間食' : '食事'

  return `✅ ${mealTypeJa}を記録しました！`
}

async function applyWeight(
  action: Record<string, unknown>,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<string> {
  const weightKg = action.weight_kg as number
  if (!weightKg || weightKg <= 20 || weightKg >= 300) {
    return '体重の値が不正です。テキストで「体重○○kg」と送ってください。'
  }

  const today = todayJst()
  const dailyLog = await ensureDailyLog(env.DB, {
    userAccountId,
    clientAccountId,
    logDate: today,
  })

  await upsertBodyMetrics(env.DB, {
    dailyLogId: dailyLog.id,
    weightKg,
  })

  return `✅ 体重 ${weightKg}kg を記録しました！📈`
}

async function applyProgressPhoto(
  action: Record<string, unknown>,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<string> {
  const r2Key = action.r2_key as string
  const photoDate = (action.photo_date as string) ?? todayJst()

  if (!r2Key) {
    return '写真データが見つかりませんでした。'
  }

  const dailyLog = await ensureDailyLog(env.DB, {
    userAccountId,
    clientAccountId,
    logDate: photoDate,
  })

  await createProgressPhoto(env.DB, {
    userAccountId,
    dailyLogId: dailyLog.id,
    photoDate,
    storageKey: r2Key,
    photoType: 'progress',
  })

  return '✅ 体型写真を保存しました！📸\nダッシュボードで進捗を確認できます。'
}
