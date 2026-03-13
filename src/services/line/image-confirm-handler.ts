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
  updateIntakeResultProposedAction,
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
import { replyText, replyTextWithQuickReplies, pushWithQuickReplies } from './reply'
import { deleteModeSession } from '../../repositories/mode-sessions-repo'
import { todayJst } from '../../utils/id'
import { createOpenAIClient } from '../ai/openai-client'
import {
  matchFoodItems,
  calculateTotalNutrition,
} from '../../repositories/food-master-repo'

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

// ===================================================================
// テキスト修正ハンドラー
// ===================================================================

const CORRECTION_PROMPT = `あなたは栄養士AIです。
ユーザーが食事写真のAI解析結果を修正しました。

【元のAI解析結果】
{original}

【ユーザーの修正内容】
{correction}

ユーザーの修正を反映した正しい食事情報を出力してください。
ユーザーが言及していない項目は元の解析結果を維持してください。

必ず以下のJSON形式のみで返答してください（説明文は不要）:
{
  "meal_description": "修正後の料理名・食材の説明（日本語、100文字以内）",
  "food_items": ["個別食品名1", "個別食品名2", ...],
  "estimated_calories_kcal": <整数またはnull>,
  "estimated_protein_g": <数値またはnull>,
  "estimated_fat_g": <数値またはnull>,
  "estimated_carbs_g": <数値またはnull>,
  "meal_type_guess": "breakfast|lunch|dinner|snack|other",
  "correction_note": "修正した点の要約"
}`

/**
 * 画像確認待ち(S3)中にユーザーがテキスト修正を送った場合のハンドラー
 *
 * フロー:
 *   1. 元の解析結果を取得
 *   2. AI に元結果 + 修正テキストを送って再解析
 *   3. proposed_action_json を更新
 *   4. 修正後の内容を提示 → 確定/取消を再度求める
 */
export async function handleImageCorrection(
  replyToken: string,
  correctionText: string,
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
    // 1. 元の解析結果を復元
    let originalExtracted: Record<string, unknown> = {}
    try {
      originalExtracted = result.extracted_json
        ? (typeof result.extracted_json === 'string'
          ? JSON.parse(result.extracted_json)
          : result.extracted_json)
        : {}
    } catch { /* ignore */ }

    let originalAction: Record<string, unknown> = {}
    try {
      originalAction = result.proposed_action_json
        ? (typeof result.proposed_action_json === 'string'
          ? JSON.parse(result.proposed_action_json)
          : result.proposed_action_json)
        : {}
    } catch { /* ignore */ }

    // 2. AI に修正を反映させる
    const ai = createOpenAIClient(env)
    const originalSummary = [
      originalExtracted.meal_description || originalAction.meal_text || '不明',
      originalExtracted.food_items ? `食品: ${(originalExtracted.food_items as string[]).join(', ')}` : '',
      originalAction.calories_kcal ? `推定カロリー: ${originalAction.calories_kcal}kcal` : '',
    ].filter(Boolean).join('\n')

    const prompt = CORRECTION_PROMPT
      .replace('{original}', originalSummary)
      .replace('{correction}', correctionText)

    const raw = await ai.createResponse(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: correctionText },
      ],
      { temperature: 0.3, maxTokens: 512 }
    )

    let parsed: Record<string, unknown> = {}
    try {
      // JSON部分を抽出（説明文が混じる場合に対応）
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      parsed = {}
    }

    // 3. 修正後の値を決定（AIが返さなかった項目は元の値を維持）
    const desc = (parsed.meal_description as string) || (originalAction.meal_text as string) || '食事'
    const foodItems = (parsed.food_items as string[]) || (originalExtracted.food_items as string[]) || []
    let finalCalories = (parsed.estimated_calories_kcal as number) ?? (originalAction.calories_kcal as number) ?? null
    let finalProtein = (parsed.estimated_protein_g as number) ?? (originalAction.protein_g as number) ?? null
    let finalFat = (parsed.estimated_fat_g as number) ?? (originalAction.fat_g as number) ?? null
    let finalCarbs = (parsed.estimated_carbs_g as number) ?? (originalAction.carbs_g as number) ?? null
    const mealType = (parsed.meal_type_guess as string) || (originalAction.meal_type as string) || 'other'

    // 4. food_master マッチング（修正後の食品リストで再照合）
    let foodMatchData: Record<string, unknown> | null = null
    let matchSummaryText = ''

    if (foodItems.length > 0) {
      try {
        const matches = await matchFoodItems(env.DB, foodItems)
        const nutrition = calculateTotalNutrition(matches)

        const matchDetails: Array<Record<string, unknown>> = []
        for (const [name, matchResult] of matches) {
          if (matchResult) {
            matchDetails.push({
              ai_name: name,
              master_name: matchResult.food.name,
              master_id: matchResult.food.id,
              match_score: matchResult.matchScore,
              calories_kcal: matchResult.food.calories_kcal,
              serving_label: matchResult.food.serving_label,
            })
          } else {
            matchDetails.push({ ai_name: name, master_name: null, match_score: 0 })
          }
        }

        foodMatchData = {
          matched_count: nutrition.matchedCount,
          total_count: foodItems.length,
          unmatched_names: nutrition.unmatchedNames,
          items: matchDetails,
        }

        if (nutrition.matchedCount > 0) {
          const matchRate = nutrition.matchedCount / foodItems.length
          if (matchRate >= 0.5) {
            const unmatchedRatio = nutrition.unmatchedNames.length / foodItems.length
            const aiCal = finalCalories ?? 0
            finalCalories = nutrition.totalCalories + Math.round(aiCal * unmatchedRatio)
            finalProtein = Math.round((nutrition.totalProtein + (finalProtein ?? 0) * unmatchedRatio) * 10) / 10
            finalFat = Math.round((nutrition.totalFat + (finalFat ?? 0) * unmatchedRatio) * 10) / 10
            finalCarbs = Math.round((nutrition.totalCarbs + (finalCarbs ?? 0) * unmatchedRatio) * 10) / 10
          }

          const matchedNames = matchDetails
            .filter(d => d.master_name)
            .map(d => `${d.ai_name}→${d.master_name}`)
            .slice(0, 3)
          matchSummaryText = `\n📊 食品DB照合: ${nutrition.matchedCount}/${foodItems.length}品マッチ`
          if (matchedNames.length > 0) {
            matchSummaryText += `\n   ${matchedNames.join(', ')}`
          }
        }
      } catch (err) {
        console.warn('[ImageCorrection] food_master matching failed:', err)
      }
    }

    // 5. proposed_action_json を更新
    const newProposedAction = {
      ...originalAction,
      action: 'create_or_update_meal_entry',
      meal_type: mealType,
      meal_text: desc,
      calories_kcal: finalCalories,
      protein_g: finalProtein,
      fat_g: finalFat,
      carbs_g: finalCarbs,
      food_match_data: foodMatchData,
    }

    const newExtracted = {
      ...originalExtracted,
      ...parsed,
      food_match_data: foodMatchData,
      correction_applied: true,
      correction_text: correctionText,
    }

    await updateIntakeResultProposedAction(env.DB, result.id, newProposedAction, newExtracted)

    // 6. 修正後の内容を提示
    const mealTypeJa =
      mealType === 'breakfast' ? '朝食' :
      mealType === 'lunch' ? '昼食' :
      mealType === 'dinner' ? '夕食' :
      mealType === 'snack' ? '間食' : '食事'

    const correctionNote = (parsed.correction_note as string) || ''

    let replyMessage =
      `✏️ 修正を反映しました！\n\n` +
      `🍽 ${mealTypeJa}\n` +
      `📝 ${desc}\n` +
      (finalCalories ? `🔥 推定カロリー: ${finalCalories} kcal\n` : '') +
      (finalProtein ? `💪 P: ${finalProtein}g` : '') +
      (finalFat ? ` / F: ${finalFat}g` : '') +
      (finalCarbs ? ` / C: ${finalCarbs}g` : '') +
      matchSummaryText +
      (correctionNote ? `\n\n📌 ${correctionNote}` : '') +
      '\n\n↓ この内容で記録しますか？'

    await replyTextWithQuickReplies(
      replyToken,
      replyMessage,
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )

    console.log(`[ImageCorrection] correction applied for ${intakeResultId}: "${correctionText}"`)
  } catch (err) {
    console.error('[ImageCorrection] error:', err)
    await replyText(
      replyToken,
      '修正の処理中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
  }
}
