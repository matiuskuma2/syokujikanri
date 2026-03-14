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
import { replyText, replyTextWithQuickReplies, pushText, pushWithQuickReplies } from './reply'
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
      .catch(async () => {
        await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
      })
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

    // 確定メッセージ（QuickReply付き + pushフォールバック）
    const confirmMsg = buildConfirmMessage(result)
    await replyTextWithQuickReplies(
      replyToken,
      confirmMsg,
      [
        { label: '📝 続けて記録', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(async (replyErr) => {
      console.warn('[ImageConfirm] reply failed, falling back to push:', replyErr)
      await pushWithQuickReplies(
        lineUserId,
        confirmMsg,
        [
          { label: '📝 続けて記録', text: '記録モード' },
          { label: '💬 相談する', text: '相談モード' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(e => console.error('[ImageConfirm] push fallback also failed:', e))
    })
  } catch (err) {
    console.error('[ImageConfirm] apply error:', err)
    await replyText(
      replyToken,
      '記録の保存中にエラーが発生しました。お手数ですが、もう一度お試しください。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(async (replyErr) => {
      console.warn('[ImageConfirm] error reply failed:', replyErr)
      await pushText(
        lineUserId,
        '記録の保存中にエラーが発生しました。お手数ですが、もう一度お試しください。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(() => {})
    })
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
      .catch(async () => {
        await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
      })
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
  ).catch(async (replyErr) => {
    console.warn('[ImageDiscard] reply failed, falling back to push:', replyErr)
    await pushText(
      lineUserId,
      '🗑 この記録を取り消しました。\n\n画像を再送していただくか、テキストで直接入力できます。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[ImageDiscard] push fallback also failed:', e))
  })
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
      // target_date が指定されていればそれを使う（メタデータ更新で変更される場合がある）
      const logDate = (action.target_date as string) ?? todayJst()
      const dailyLog = await ensureDailyLog(env.DB, {
        userAccountId,
        clientAccountId,
        logDate,
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

      const weightDate = (action.target_date as string) ?? todayJst()
      const dailyLog = await ensureDailyLog(env.DB, {
        userAccountId,
        clientAccountId,
        logDate: weightDate,
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
// 意図判定: pending_image_confirm 中のテキスト分類
// ===================================================================

/**
 * pending_image_confirm 中にユーザーが送ったテキストの意図を判定する。
 *
 * 分類:
 *   - "food_correction"   : 食品内容の修正（鮭→スクランブルエッグ、白米2膳 等）
 *   - "metadata_update"   : 日付・食事区分の変更（昨日の晩御飯、これは朝食 等）
 *   - "both"              : 食品修正 + メタデータ更新の両方を含む
 *   - "unrelated"         : 確認中の食事とは無関係のテキスト
 *
 * 軽量に判定するため、まずルールベースで判定し、
 * 判定不能な場合のみ AI を使う。
 */
export type PendingTextIntent = 'food_correction' | 'metadata_update' | 'both' | 'unrelated'

// ルールベース: 日付・時間帯・食事区分を示すパターン
const DATE_PATTERNS = [
  /昨日/,
  /一昨日|おととい/,
  /今日/,
  /(\d{1,2})[\/\-月](\d{1,2})/,  // 3/10, 3-10, 3月10日
  /先週/,
  /今週/,
  /(月|火|水|木|金|土|日)曜/,
]

const MEAL_TYPE_PATTERNS = [
  /朝(食|ごはん|ご飯|メシ|めし|飯)/,
  /昼(食|ごはん|ご飯|メシ|めし|飯)/,
  /ランチ/,
  /晩(御飯|ごはん|ご飯|メシ|めし|飯)/,
  /夕(食|飯|ごはん|ご飯|メシ|めし)/,
  /夜(ご飯|ごはん|食|飯)/,
  /ディナー/,
  /間食|おやつ|スナック/,
  /夜食/,
]

// ルールベース: 食品修正を示すパターン
const FOOD_CORRECTION_PATTERNS = [
  /ではなく|じゃなく|じゃなくて/,
  /違う|ちがう/,
  /ではない|じゃない/,
  /実は|じつは/,
  /正しくは/,
  /(\d+)(膳|杯|個|枚|切れ|本|皿|パック|袋)/,
  /量[はが]|多め|少なめ|大盛|小盛/,
  /追加で|あと|それと|プラス/,
  /入って(い|な)|含まれ/,
  /なし[でに]|抜き|除い/,
]

export async function classifyPendingText(
  text: string,
  env: Bindings
): Promise<PendingTextIntent> {
  const trimmed = text.trim()

  // 短すぎるテキストは判定不要（確定/取消は既にハンドル済み）
  if (trimmed.length <= 1) return 'unrelated'

  // ルールベース判定
  const hasDatePattern = DATE_PATTERNS.some(p => p.test(trimmed))
  const hasMealTypePattern = MEAL_TYPE_PATTERNS.some(p => p.test(trimmed))
  const hasFoodCorrection = FOOD_CORRECTION_PATTERNS.some(p => p.test(trimmed))

  const hasMetadata = hasDatePattern || hasMealTypePattern

  // 明確なパターンの場合はルールベースで返す
  if (hasFoodCorrection && hasMetadata) return 'both'
  if (hasFoodCorrection && !hasMetadata) return 'food_correction'

  // メタデータのみ且つ短い（食品情報が含まれていない）→ metadata_update
  // 例: "昨日の晩御飯", "これは朝食です", "今日の昼食"
  if (hasMetadata && trimmed.length <= 30) return 'metadata_update'

  // ルールベースで判定できない場合 → AI判定
  try {
    const ai = createOpenAIClient(env)
    const raw = await ai.createResponse(
      [
        {
          role: 'system',
          content: `食事画像の解析結果を確認中のユーザーが送ったテキストを分類してください。

分類:
- "food_correction": 食品の内容・量・種類の修正（例: 「鮭ではなくスクランブルエッグ」「白米2膳」「ブロッコリーも入ってた」）
- "metadata_update": 日付や食事区分の情報（例: 「昨日の晩御飯」「これは朝食」「3/10の夕食」）
- "both": 食品修正と日付/区分の両方（例: 「昨日の夕食で白米は大盛りだった」）
- "unrelated": 確認中の食事とは無関係（例: 「ありがとう」「他の話」）

テキストの分類を1単語で返してください: food_correction, metadata_update, both, unrelated`
        },
        { role: 'user', content: trimmed }
      ],
      { temperature: 0, maxTokens: 20 }
    )

    const result = raw.trim().toLowerCase()
    if (result.includes('food_correction')) return 'food_correction'
    if (result.includes('metadata_update')) return 'metadata_update'
    if (result.includes('both')) return 'both'
    if (result.includes('unrelated')) return 'unrelated'

    // AI判定が不明確な場合、テキスト長で推定
    // 長いテキストは修正の可能性が高い
    return trimmed.length > 10 ? 'food_correction' : 'unrelated'
  } catch (err) {
    console.error('[classifyPendingText] AI classification failed:', err)
    // AI失敗時のフォールバック: メタデータパターンがあればそれ、なければ食品修正
    if (hasMetadata) return 'metadata_update'
    return trimmed.length > 5 ? 'food_correction' : 'unrelated'
  }
}

// ===================================================================
// メタデータ更新ハンドラー（日付・食事区分の変更）
// ===================================================================

/**
 * pending_image_confirm 中にユーザーが日付・食事区分の変更を送った場合のハンドラー
 *
 * 例: "昨日の晩御飯", "これは朝食です", "3/10の夕食"
 *
 * proposed_action_json の meal_type と target_date を更新し、
 * 更新後の内容を再度提示する。
 */
export async function handleImageMetadataUpdate(
  replyToken: string,
  metadataText: string,
  intakeResultId: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const result = await findIntakeResultById(env.DB, intakeResultId)

  if (!result || result.applied_flag !== 0) {
    await replyText(replyToken, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN)
      .catch(async () => {
        await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
      })
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  try {
    let originalAction: Record<string, unknown> = {}
    try {
      originalAction = result.proposed_action_json
        ? (typeof result.proposed_action_json === 'string'
          ? JSON.parse(result.proposed_action_json)
          : result.proposed_action_json)
        : {}
    } catch { /* ignore */ }

    let originalExtracted: Record<string, unknown> = {}
    try {
      originalExtracted = result.extracted_json
        ? (typeof result.extracted_json === 'string'
          ? JSON.parse(result.extracted_json)
          : result.extracted_json)
        : {}
    } catch { /* ignore */ }

    // AI でテキストから日付・食事区分を抽出
    const ai = createOpenAIClient(env)
    const today = todayJst()
    const raw = await ai.createResponse(
      [
        {
          role: 'system',
          content: `今日は${today}です。ユーザーの発言から日付と食事区分を抽出してください。

必ず以下のJSON形式のみで返答してください:
{
  "target_date": "YYYY-MM-DD形式の日付。不明なら null",
  "meal_type": "breakfast|lunch|dinner|snack|other のいずれか。不明なら null",
  "reasoning": "判定理由"
}

例:
- "昨日の晩御飯" → {"target_date": "${getDateOffset(-1)}", "meal_type": "dinner", "reasoning": "昨日=前日、晩御飯=dinner"}
- "これは朝食です" → {"target_date": null, "meal_type": "breakfast", "reasoning": "朝食=breakfast"}
- "3月10日の夕食" → {"target_date": "2026-03-10", "meal_type": "dinner", "reasoning": "3月10日, 夕食=dinner"}`
        },
        { role: 'user', content: metadataText }
      ],
      { temperature: 0, maxTokens: 200 }
    )

    let parsed: { target_date?: string | null; meal_type?: string | null; reasoning?: string } = {}
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      parsed = {}
    }

    // 変更があった項目だけ更新
    let changed = false
    const newAction = { ...originalAction }
    const newExtracted = { ...originalExtracted }

    if (parsed.target_date) {
      newAction.target_date = parsed.target_date
      newExtracted.target_date = parsed.target_date
      changed = true
    }

    if (parsed.meal_type && ['breakfast', 'lunch', 'dinner', 'snack', 'other'].includes(parsed.meal_type)) {
      newAction.meal_type = parsed.meal_type
      newExtracted.meal_type_guess = parsed.meal_type
      changed = true
    }

    if (changed) {
      newExtracted.metadata_update_applied = true
      newExtracted.metadata_update_text = metadataText
      await updateIntakeResultProposedAction(env.DB, result.id, newAction, newExtracted)
    }

    // 更新後の内容を提示
    const mealType = (newAction.meal_type as string) ?? 'other'
    const mealTypeJa =
      mealType === 'breakfast' ? '朝食' :
      mealType === 'lunch' ? '昼食' :
      mealType === 'dinner' ? '夕食' :
      mealType === 'snack' ? '間食' : '食事'

    const targetDate = (newAction.target_date as string) ?? today
    const dateDisplay = targetDate === today
      ? '今日'
      : targetDate === getDateOffset(-1) ? '昨日' : targetDate

    const desc = (newAction.meal_text as string) ?? '食事'
    const cal = newAction.calories_kcal as number | null

    let replyMessage =
      `📅 ${dateDisplay}の${mealTypeJa}に変更しました！\n\n` +
      `📝 ${desc}\n` +
      (cal ? `🔥 推定カロリー: ${cal} kcal\n` : '') +
      (newAction.protein_g ? `💪 P: ${newAction.protein_g}g` : '') +
      (newAction.fat_g ? ` / F: ${newAction.fat_g}g` : '') +
      (newAction.carbs_g ? ` / C: ${newAction.carbs_g}g` : '') +
      '\n\n↓ この内容で記録しますか？'

    await replyTextWithQuickReplies(
      replyToken,
      replyMessage,
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(async (replyErr) => {
      console.warn('[ImageMetadataUpdate] reply failed, falling back to push:', replyErr)
      await pushWithQuickReplies(
        lineUserId,
        replyMessage,
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(e => console.error('[ImageMetadataUpdate] push fallback also failed:', e))
    })

    console.log(`[ImageMetadataUpdate] metadata updated for ${intakeResultId}: date=${parsed.target_date}, type=${parsed.meal_type}`)
  } catch (err) {
    console.error('[ImageMetadataUpdate] error:', err)
    await replyText(
      replyToken,
      '情報の更新中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(async () => {
      await pushText(
        lineUserId,
        '情報の更新中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(() => {})
    })
  }
}

/** 今日から offset 日分ずらした日付を YYYY-MM-DD で返す */
function getDateOffset(offset: number): string {
  const d = new Date()
  // JST (UTC+9)
  d.setHours(d.getHours() + 9)
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
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
      .catch(async () => {
        await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
      })
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
    ).catch(async (replyErr) => {
      console.warn('[ImageCorrection] reply failed, falling back to push:', replyErr)
      await pushWithQuickReplies(
        lineUserId,
        replyMessage,
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(e => console.error('[ImageCorrection] push fallback also failed:', e))
    })

    console.log(`[ImageCorrection] correction applied for ${intakeResultId}: "${correctionText}"`)
  } catch (err) {
    console.error('[ImageCorrection] error:', err)
    await replyText(
      replyToken,
      '修正の処理中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(async (replyErr) => {
      console.warn('[ImageCorrection] error reply failed, falling back to push:', replyErr)
      await pushText(
        lineUserId,
        '修正の処理中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(e => console.error('[ImageCorrection] error push fallback also failed:', e))
    })
  }
}
