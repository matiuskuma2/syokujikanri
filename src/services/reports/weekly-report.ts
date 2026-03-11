/**
 * src/services/reports/weekly-report.ts
 * 週次レポート生成・LINE送信
 */

import type { Bindings } from '../../types/bindings'
import { replyText } from '../line/reply'
import { createOpenAIClient } from '../ai/openai-client'
import { listActiveUserServiceStatuses } from '../../repositories/subscriptions-repo'
import { findUserAccountById } from '../../repositories/line-users-repo'
import { nowIso } from '../../utils/id'
import { generateId } from '../../utils/id'

interface WeeklyStats {
  lineUserId: string
  userAccountId: string
  displayName: string | null
  weekStart: string
  weekEnd: string
  avgWeightKg: number | null
  minWeightKg: number | null
  maxWeightKg: number | null
  deltaWeightKg: number | null
  avgCalories: number | null
  logDays: number
  mealCount: number
}

/** 全アクティブユーザーに週次レポートを送信（Cron から呼ばれる） */
export async function sendWeeklyReportsToAll(env: Bindings): Promise<void> {
  const accountId = env.CLIENT_ACCOUNT_ID
  const statuses = await listActiveUserServiceStatuses(env.DB, accountId)

  const now = new Date()
  const weekEnd = toJstDateString(now)
  const weekStartDate = new Date(now)
  weekStartDate.setDate(now.getDate() - 6)
  const weekStart = toJstDateString(weekStartDate)

  console.log(`[WeeklyReport] Sending to ${statuses.length} users for ${weekStart} – ${weekEnd}`)

  await Promise.allSettled(
    statuses.map(s => sendWeeklyReportToUser(env, s.line_user_id, accountId, weekStart, weekEnd))
  )
}

async function sendWeeklyReportToUser(
  env: Bindings,
  lineUserId: string,
  accountId: string,
  weekStart: string,
  weekEnd: string
): Promise<void> {
  try {
    // user_accounts から userAccountId を取得
    const row = await env.DB.prepare(`
      SELECT ua.id, lu.display_name
      FROM user_accounts ua
      JOIN line_users lu ON lu.line_user_id = ua.line_user_id AND lu.line_channel_id = ?2
      WHERE ua.line_user_id = ?1 AND ua.account_id = ?3
      LIMIT 1
    `).bind(lineUserId, env.LINE_CHANNEL_ID, accountId).first<{ id: string; display_name: string | null }>()

    if (!row) return

    // 週次統計を集計
    const stats = await getWeeklyStats(env.DB, row.id, weekStart, weekEnd)

    // レポートが既に送信済みか確認
    const existing = await env.DB.prepare(`
      SELECT id FROM weekly_reports
      WHERE user_account_id = ?1 AND week_start = ?2
    `).bind(row.id, weekStart).first<{ id: string }>()
    if (existing) return

    // AI でサマリー生成
    const summary = await generateWeeklySummary(env, stats, row.display_name)

    // weekly_reports に保存
    await env.DB.prepare(`
      INSERT INTO weekly_reports (id, user_account_id, account_id, week_start, week_end,
        avg_weight_kg, avg_calories, log_days, summary, sent_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
    `).bind(
      generateId(), row.id, accountId, weekStart, weekEnd,
      stats.avgWeightKg, stats.avgCalories, stats.logDays,
      summary, nowIso()
    ).run()

    // LINE に送信（push message）
    const message = buildWeeklyReportMessage(stats, summary, row.display_name)
    await pushMessage(lineUserId, message, env.LINE_CHANNEL_ACCESS_TOKEN)

    console.log(`[WeeklyReport] Sent to ${lineUserId} (${row.display_name})`)
  } catch (e) {
    console.error(`[WeeklyReport] Error for ${lineUserId}:`, e)
  }
}

async function getWeeklyStats(
  db: D1Database,
  userAccountId: string,
  weekStart: string,
  weekEnd: string
): Promise<WeeklyStats> {
  const logsRow = await db.prepare(`
    SELECT
      COUNT(*) as log_days,
      AVG(bm.weight_kg) as avg_weight,
      MIN(bm.weight_kg) as min_weight,
      MAX(bm.weight_kg) as max_weight
    FROM daily_logs dl
    LEFT JOIN body_metrics bm ON bm.daily_log_id = dl.id
    WHERE dl.user_account_id = ?1 AND dl.log_date BETWEEN ?2 AND ?3
  `).bind(userAccountId, weekStart, weekEnd).first<any>()

  const mealRow = await db.prepare(`
    SELECT COUNT(*) as meal_count, AVG(me.estimated_calories) as avg_cal
    FROM meal_entries me
    JOIN daily_logs dl ON dl.id = me.daily_log_id
    WHERE dl.user_account_id = ?1 AND dl.log_date BETWEEN ?2 AND ?3
  `).bind(userAccountId, weekStart, weekEnd).first<any>()

  const avgWeight = logsRow?.avg_weight ? Math.round(logsRow.avg_weight * 10) / 10 : null
  const minWeight = logsRow?.min_weight ?? null
  const maxWeight = logsRow?.max_weight ?? null
  const delta = (minWeight && maxWeight) ? Math.round((maxWeight - minWeight) * 10) / 10 : null

  return {
    lineUserId: '',
    userAccountId,
    displayName: null,
    weekStart,
    weekEnd,
    avgWeightKg: avgWeight,
    minWeightKg: minWeight,
    maxWeightKg: maxWeight,
    deltaWeightKg: delta,
    avgCalories: mealRow?.avg_cal ? Math.round(mealRow.avg_cal) : null,
    logDays: logsRow?.log_days ?? 0,
    mealCount: mealRow?.meal_count ?? 0,
  }
}

async function generateWeeklySummary(
  env: Bindings,
  stats: WeeklyStats,
  name: string | null
): Promise<string> {
  if (!env.OPENAI_API_KEY) return '今週もお疲れ様でした！記録を続けることが大切です。'

  const prompt = `ダイエットサポートAIとして、以下のデータをもとに${name ?? 'ユーザー'}さんへの週次レポートコメントを100文字以内で書いてください。励ましを含め、改善点があれば1つだけ具体的に提案してください。

記録日数: ${stats.logDays}/7日
平均体重: ${stats.avgWeightKg ?? '未記録'}kg
最小体重: ${stats.minWeightKg ?? '-'}kg / 最大体重: ${stats.maxWeightKg ?? '-'}kg
平均摂取カロリー: ${stats.avgCalories ?? '未記録'}kcal/日
食事記録数: ${stats.mealCount}回`

  try {
    const client = createOpenAIClient(env.OPENAI_API_KEY)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL ?? 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
      }),
    })
    const data = await res.json<any>()
    return data.choices?.[0]?.message?.content?.trim() ?? '今週もお疲れ様でした！'
  } catch {
    return '今週もお疲れ様でした！記録を続けることが大切です。'
  }
}

function buildWeeklyReportMessage(stats: WeeklyStats, summary: string, name: string | null): string {
  const lines = [
    `📊 週次レポート（${stats.weekStart} 〜 ${stats.weekEnd}）`,
    '',
    `📅 記録日数: ${stats.logDays}/7日`,
  ]
  if (stats.avgWeightKg) lines.push(`⚖️ 平均体重: ${stats.avgWeightKg}kg`)
  if (stats.minWeightKg && stats.maxWeightKg) {
    lines.push(`📉 最小: ${stats.minWeightKg}kg  📈 最大: ${stats.maxWeightKg}kg`)
  }
  if (stats.avgCalories) lines.push(`🍽️ 平均カロリー: ${stats.avgCalories}kcal/日`)
  lines.push('', `💬 ${summary}`)
  return lines.join('\n')
}

async function pushMessage(lineUserId: string, text: string, accessToken: string): Promise<void> {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
  })
}

function toJstDateString(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().split('T')[0]
}
