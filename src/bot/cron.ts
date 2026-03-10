/**
 * Cron ジョブ
 * - 毎日21時 JST: デイリーリマインダー
 * - 毎週日曜20時 JST: 週次レポート
 */

import type { Bindings } from '../types/bindings'
import { DailyLogRepo, ProfileRepo, WeeklyReportRepo, MealRepo, todayJst } from '../repository'
import { DietAIService } from '../ai/client'
import { buildReminderMessage } from '../ai/prompts'
import { pushText } from '../utils/line'

// ===================================================================
// デイリーリマインダー
// ===================================================================

export async function runDailyReminder(env: Bindings): Promise<void> {
  const today = todayJst()

  // アクティブユーザー一覧を取得
  const users = await env.DB.prepare(`
    SELECT lu.line_user_id, lu.account_id, up.nickname
    FROM line_users lu
    LEFT JOIN user_profiles up ON up.account_id = lu.account_id AND up.line_user_id = lu.line_user_id
    INNER JOIN user_service_statuses uss ON uss.account_id = lu.account_id AND uss.line_user_id = lu.line_user_id
    WHERE uss.bot_enabled = 1 AND uss.record_enabled = 1
    ORDER BY lu.last_active_at DESC
  `).all<{ line_user_id: string; account_id: string; nickname: string | null }>()

  for (const user of users.results) {
    try {
      const todayLog = await DailyLogRepo.findByDate(
        env.DB, user.account_id, user.line_user_id, today
      )
      const hasLoggedToday = todayLog !== null

      const message = buildReminderMessage(user.nickname || 'あなた', hasLoggedToday)
      await pushText(user.line_user_id, message, env.LINE_CHANNEL_ACCESS_TOKEN)
    } catch (err) {
      console.error(`Reminder error for user ${user.line_user_id}:`, err)
    }
  }
}

// ===================================================================
// 週次レポート
// ===================================================================

export async function runWeeklyReport(env: Bindings): Promise<void> {
  const today = todayJst()

  // 今週の月曜日〜日曜日を計算
  const todayDate = new Date(today)
  const dayOfWeek = todayDate.getDay() // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(todayDate)
  monday.setDate(todayDate.getDate() + mondayOffset)
  const weekStart = monday.toISOString().substring(0, 10)
  const weekEnd = today

  // アクティブユーザーに週次レポート生成・送信
  const users = await env.DB.prepare(`
    SELECT lu.line_user_id, lu.account_id
    FROM line_users lu
    INNER JOIN user_service_statuses uss ON uss.account_id = lu.account_id AND uss.line_user_id = lu.line_user_id
    WHERE uss.bot_enabled = 1
    ORDER BY lu.last_active_at DESC
  `).all<{ line_user_id: string; account_id: string }>()

  const ai = new DietAIService(env)

  for (const user of users.results) {
    try {
      const profile = await ProfileRepo.findByUser(env.DB, user.account_id, user.line_user_id)
      const logs = await DailyLogRepo.getRecent(env.DB, user.account_id, user.line_user_id, 7)

      if (logs.length === 0) continue

      // 今週の全食事データ取得
      const allMeals = []
      for (const log of logs) {
        const meals = await MealRepo.getByDate(env.DB, user.account_id, user.line_user_id, log.log_date)
        allMeals.push(...meals)
      }

      // AI週次レポート生成
      const summary = await ai.generateWeeklyReport(profile, weekStart, weekEnd, logs, allMeals)

      // 平均体重・カロリー計算
      const weights = logs.filter(l => l.weight_kg !== null).map(l => l.weight_kg as number)
      const avgWeight = weights.length > 0 ? weights.reduce((a, b) => a + b) / weights.length : null
      const avgCalories = allMeals.length > 0
        ? allMeals.reduce((sum, m) => sum + (m.estimated_calories || 0), 0) / 7
        : null

      // 週次レポート保存
      await WeeklyReportRepo.create(env.DB, {
        line_user_id: user.line_user_id,
        account_id: user.account_id,
        week_start: weekStart,
        week_end: weekEnd,
        avg_weight_kg: avgWeight,
        avg_calories: avgCalories,
        log_days: logs.length,
        summary,
        sent_at: new Date().toISOString()
      })

      // LINEに送信
      const message = `📊 今週の週次レポートです\n\n${summary}\n\n記録日数: ${logs.length}/7日`
      await pushText(user.line_user_id, message, env.LINE_CHANNEL_ACCESS_TOKEN)
    } catch (err) {
      console.error(`Weekly report error for user ${user.line_user_id}:`, err)
    }
  }
}
