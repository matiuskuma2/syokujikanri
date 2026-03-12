/**
 * src/services/line/image-confirm-handler.ts
 * 画像解析結果の確認/取消ハンドラー
 *
 * M3-6: ユーザーが「確定」「取消」と応答したときに、
 * pending の image_intake_results を処理する。
 *
 * 確定 → proposed_action_json の内容をメインテーブルに反映
 * 取消 → applied_flag=2 (discarded) に設定
 */

import type { Bindings } from '../../types/bindings'
import type { ImageIntakeResult } from '../../types/db'
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
import { replyText } from './reply'
import { deleteModeSession } from '../../repositories/mode-sessions-repo'
import { todayJst } from '../../utils/id'

// ===================================================================
// 確定ハンドラー
// ===================================================================

/**
 * ユーザーが「確定」と応答 → pending 結果をメインテーブルに反映
 */
export async function handleImageConfirm(
  replyToken: string,
  intakeResultId: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const result = await findIntakeResultById(env.DB, intakeResultId)

  if (!result || result.applied_flag !== 0) {
    await replyText(replyToken, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN)
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  try {
    // proposed_action_json をパースして実行
    await applyProposedAction(result, env)

    // applied_flag を 1 (confirmed) に更新
    await markIntakeResultApplied(env.DB, result.id)

    // mode_session をクリア
    await deleteModeSession(env.DB, clientAccountId, lineUserId)

    // 確定メッセージ
    const confirmMsg = buildConfirmMessage(result)
    await replyText(replyToken, confirmMsg, env.LINE_CHANNEL_ACCESS_TOKEN)
  } catch (err) {
    console.error('[ImageConfirm] apply error:', err)
    await replyText(
      replyToken,
      '記録の保存中にエラーが発生しました。お手数ですが、もう一度お試しください。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
  }
}

// ===================================================================
// 取消ハンドラー
// ===================================================================

/**
 * ユーザーが「取消」と応答 → pending 結果を破棄
 */
export async function handleImageDiscard(
  replyToken: string,
  intakeResultId: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const result = await findIntakeResultById(env.DB, intakeResultId)

  if (!result || result.applied_flag !== 0) {
    await replyText(replyToken, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN)
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  // applied_flag を 2 (discarded) に設定
  await markIntakeResultDiscarded(env.DB, result.id)

  // mode_session をクリア
  await deleteModeSession(env.DB, clientAccountId, lineUserId)

  await replyText(
    replyToken,
    '🗑 この記録を取り消しました。\n\n画像を再送していただくか、テキストで直接入力できます。',
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// proposed_action_json → メインテーブル反映
// ===================================================================

async function applyProposedAction(
  result: ImageIntakeResult,
  env: Bindings
): Promise<void> {
  if (!result.proposed_action_json) return

  let action: Record<string, unknown>
  try {
    action = JSON.parse(result.proposed_action_json)
  } catch {
    console.warn('[ImageConfirm] invalid proposed_action_json:', result.proposed_action_json)
    return
  }

  const actionType = action.action as string
  const userAccountId = (action.user_account_id as string) ?? result.user_account_id
  const clientAccountId = action.client_account_id as string

  if (!userAccountId || !clientAccountId) {
    console.warn('[ImageConfirm] missing user/client account id')
    return
  }

  switch (actionType) {
    case 'create_or_update_meal_entry': {
      const today = todayJst()
      const dailyLog = await ensureDailyLog(env.DB, {
        userAccountId,
        clientAccountId,
        logDate: today,
      })

      const mealType = (action.meal_type as string) ?? 'other'
      const validTypes = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const
      const safeMealType = validTypes.includes(mealType as typeof validTypes[number])
        ? (mealType as typeof validTypes[number])
        : 'other'

      // food_master マッチ結果を JSON 文字列化
      const foodMatchJson = action.food_match_data
        ? JSON.stringify(action.food_match_data)
        : null

      const existing = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, safeMealType)
      if (existing) {
        await updateMealEntryFromEstimate(env.DB, existing.id, {
          mealText: (action.meal_text as string) ?? null,
          caloriesKcal: (action.calories_kcal as number) ?? null,
          proteinG: (action.protein_g as number) ?? null,
          fatG: (action.fat_g as number) ?? null,
          carbsG: (action.carbs_g as number) ?? null,
          confirmationStatus: 'confirmed',
          foodMatchJson,
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
          foodMatchJson,
        })
      }
      break
    }

    case 'upsert_weight': {
      const weightKg = action.weight_kg as number
      if (!weightKg || weightKg <= 20 || weightKg >= 300) return

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
      break
    }

    case 'create_progress_photo': {
      const r2Key = action.r2_key as string
      const photoDate = (action.photo_date as string) ?? todayJst()
      if (!r2Key) return

      const today = todayJst()
      const dailyLog = await ensureDailyLog(env.DB, {
        userAccountId,
        clientAccountId,
        logDate: today,
      })
      await createProgressPhoto(env.DB, {
        userAccountId,
        dailyLogId: dailyLog.id,
        photoDate,
        storageKey: r2Key,
        photoType: 'progress',
      })
      break
    }

    case 'none':
      // 数値が読み取れなかった場合など。何もしない。
      break

    default:
      console.warn(`[ImageConfirm] unknown action type: ${actionType}`)
  }
}

// ===================================================================
// 確定メッセージ組み立て
// ===================================================================

function buildConfirmMessage(result: ImageIntakeResult): string {
  let matchNote = ''
  // food_match_data が extractedJson にある場合、マッチ情報を追記
  try {
    if (result.extracted_json) {
      const extracted = typeof result.extracted_json === 'string'
        ? JSON.parse(result.extracted_json)
        : result.extracted_json
      const fmd = extracted?.food_match_data
      if (fmd && fmd.matched_count > 0) {
        matchNote = `\n📊 食品DB照合済み（${fmd.matched_count}/${fmd.total_count}品マッチ）`
      }
    }
  } catch { /* ignore */ }

  switch (result.image_category) {
    case 'meal_photo':
    case 'nutrition_label':
      return `✅ 食事記録を保存しました！${matchNote}\n\n写真をもっと送ると、1日の栄養バランスが見えてきます 📊`
    case 'body_scale':
      return '✅ 体重を記録しました！\n\n継続して記録することで体重推移を可視化できます 📈'
    case 'progress_body_photo':
      return '✅ 体型写真を保存しました！\n\nダッシュボードから進捗写真を確認できます 📸'
    default:
      return '✅ 記録を保存しました！'
  }
}
