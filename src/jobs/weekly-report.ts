/**
 * src/jobs/weekly-report.ts
 * 週次レポート生成 Cron ジョブ
 *
 * cron: "0 11 * * 0"  (UTC 11:00 日曜日 = JST 20:00 日曜日)
 *
 * 処理フロー:
 *   1. record_enabled = 1 の全ユーザーを取得
 *   2. 直近7日間の daily_logs / meal_entries / body_metrics を集計
 *   3. OpenAI でパーソナライズされた週次サマリー生成
 *   4. weekly_reports テーブルに upsert
 *   5. LINE push でレポートを送信
 *
 * Phase 2 拡張予定:
 *   - 体重グラフ画像の添付
 *   - 進捗写真の比較
 *   - 達成バッジの付与
 */

import type { Bindings } from '../types/bindings'
import { listActiveUserServiceStatuses } from '../repositories/subscriptions-repo'
import { listDailyLogsByDateRange } from '../repositories/daily-logs-repo'
import { findMealEntriesByDailyLog } from '../repositories/meal-entries-repo'
import { findBodyMetricsByDailyLog } from '../repositories/body-metrics-repo'
import { upsertWeeklyReport } from '../repositories/weekly-reports-repo'
import { findUserAccountById } from '../repositories/line-users-repo'
import { createOpenAIClient } from '../services/ai/openai-client'
import { pushText } from '../services/line/reply'
import { todayJst } from '../utils/id'

/**
 * 週次レポート Cron エントリーポイント
 */
export async function runWeeklyReport(env: Bindings): Promise<void> {
  console.log('[Cron] weekly-report: start')

  const clientAccountId = env.CLIENT_ACCOUNT_ID
  const activeStatuses = await listActiveUserServiceStatuses(env.DB, clientAccountId)

  console.log(`[Cron] weekly-report: ${activeStatuses.length} users to process`)

  let successCount = 0
  let failCount = 0

  for (const status of activeStatuses) {
    try {
      await generateAndSendWeeklyReport(status.line_user_id, clientAccountId, env)
      successCount++
      // LINE API レート制限回避
      await sleep(200)
    } catch (err) {
      console.error(`[Cron] weekly-report: failed for ${status.line_user_id}:`, err)
      failCount++
    }
  }

  console.log(`[Cron] weekly-report: done. success=${successCount} fail=${failCount}`)
}

// ===================================================================
// 週次レポート生成・送信（1ユーザー分）
// ===================================================================

async function generateAndSendWeeklyReport(
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  // 週の開始・終了日を計算（今日から7日前〜今日）
  const today = todayJst()
  const weekEnd = today
  const weekStartDate = new Date(today)
  weekStartDate.setDate(weekStartDate.getDate() - 6)
  const weekStart = weekStartDate.toISOString().substring(0, 10)

  // ユーザーアカウント取得
  const userAccount = await findUserAccountById(env.DB, lineUserId)
  if (!userAccount) return

  // 週間 daily_logs を取得
  const logs = await listDailyLogsByDateRange(env.DB, userAccount.id, weekStart, weekEnd)

  if (logs.length === 0) {
    // 記録ゼロでも軽い励ましメッセージを送信
    await pushText(
      lineUserId,
      `📊 今週の記録はゼロでした。\n\n来週はぜひ記録を始めてみましょう！\n少しずつでも継続することが大切です 💪`,
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // ===================================================================
  // 週間データ集計
  // ===================================================================

  let totalCalories = 0
  let totalMealCount = 0
  const weights: number[] = []

  for (const log of logs) {
    const [meals, metrics] = await Promise.all([
      findMealEntriesByDailyLog(env.DB, log.id),
      findBodyMetricsByDailyLog(env.DB, log.id),
    ])

    // 食事カロリー集計
    for (const meal of meals) {
      if (meal.calories_kcal) {
        totalCalories += meal.calories_kcal
        totalMealCount++
      }
    }

    // 体重記録
    if (metrics?.weight_kg) {
      weights.push(metrics.weight_kg)
    }
  }

  const logDays = logs.length
  const avgCalories = totalMealCount > 0 ? Math.round(totalCalories / logDays) : null
  const avgWeightKg = weights.length > 0
    ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 10) / 10
    : null
  const minWeightKg = weights.length > 0 ? Math.min(...weights) : null
  const maxWeightKg = weights.length > 0 ? Math.max(...weights) : null
  const weightChange = weights.length >= 2
    ? Math.round((weights[weights.length - 1] - weights[0]) * 10) / 10
    : null

  // ===================================================================
  // AI 週次サマリー生成
  // ===================================================================

  let aiSummary: string | null = null
  try {
    const ai = createOpenAIClient(env)

    const statsText = [
      `記録日数: ${logDays}日 / 7日`,
      avgWeightKg ? `平均体重: ${avgWeightKg}kg` : null,
      weightChange !== null ? `体重変化: ${weightChange > 0 ? '+' : ''}${weightChange}kg` : null,
      avgCalories ? `平均カロリー: ${avgCalories}kcal/日` : null,
    ].filter(Boolean).join('\n')

    const prompt = `あなたはダイエットサポートAIです。
以下の1週間のデータをもとに、ユーザーへのパーソナライズされた励ましメッセージを日本語で作成してください。

【今週のデータ】
${statsText}

要件:
- 200文字以内でコンパクトに
- 具体的な数値に言及して「あなたのデータを見ている」感を出す
- 良い点を褒め、改善点を1つだけ前向きに提案する
- 絵文字を2〜3個使って親しみやすく`

    aiSummary = await ai.createResponse(
      [{ role: 'user', content: prompt }],
      { temperature: 0.7, maxTokens: 300 }
    )
  } catch (err) {
    console.warn('[Cron] weekly-report: AI generation failed, using fallback:', err)
    aiSummary = null
  }

  // ===================================================================
  // weekly_reports テーブルに upsert
  // ===================================================================

  const report = await upsertWeeklyReport(env.DB, {
    userAccountId: userAccount.id,
    weekStart,
    weekEnd,
    avgWeightKg,
    minWeightKg,
    maxWeightKg,
    weightChange,
    mealLogCount: totalMealCount,
    logDays,
    aiSummary,
    sentAt: new Date().toISOString(),
  })

  // ===================================================================
  // LINE push でレポート送信
  // ===================================================================

  const weightText = avgWeightKg
    ? `⚖️ 平均体重: ${avgWeightKg}kg` +
      (weightChange !== null
        ? ` (${weightChange > 0 ? '+' : ''}${weightChange}kg)`
        : '')
    : null

  const lines = [
    `📊 今週の記録サマリー（${weekStart} 〜 ${weekEnd}）\n`,
    `📅 記録日数: ${logDays}日 / 7日`,
    weightText,
    avgCalories ? `🍽 平均カロリー: ${avgCalories}kcal/日` : null,
    '',
    aiSummary ?? '今週もお疲れ様でした！来週も一緒に頑張りましょう 💪',
  ].filter((l) => l !== null).join('\n')

  await pushText(lineUserId, lines, env.LINE_CHANNEL_ACCESS_TOKEN)

  console.log(`[Cron] weekly-report: sent for user=${userAccount.id} reportId=${report.id}`)
}

/** ms ミリ秒待機 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
