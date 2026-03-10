/**
 * Admin ダッシュボード API
 * /api/admin/dashboard
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { ok } from '../../utils/response'
import { todayJst } from '../../repository'

const dashboardRouter = new Hono<HonoEnv>()

// ダッシュボードサマリー
dashboardRouter.get('/summary', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = c.req.query('account_id') || payload.account_id
  const today = todayJst()

  const [totalUsers, todayLogs, weeklyActive, recentUsers] = await Promise.all([
    // 総ユーザー数
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM line_users WHERE account_id = ?')
      .bind(accountId).first<{ cnt: number }>(),

    // 今日の記録数
    c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM daily_logs WHERE account_id = ? AND log_date = ?"
    ).bind(accountId, today).first<{ cnt: number }>(),

    // 週間アクティブユーザー（7日以内に記録）
    c.env.DB.prepare(`
      SELECT COUNT(DISTINCT line_user_id) as cnt FROM daily_logs
      WHERE account_id = ? AND log_date >= date(?, '-7 days')
    `).bind(accountId, today).first<{ cnt: number }>(),

    // 最近のユーザー（アクティブ5件）
    c.env.DB.prepare(`
      SELECT lu.line_user_id, lu.display_name, lu.last_active_at,
        up.nickname, up.current_weight_kg, up.target_weight_kg,
        dl.weight_kg as today_weight
      FROM line_users lu
      LEFT JOIN user_profiles up ON up.account_id = lu.account_id AND up.line_user_id = lu.line_user_id
      LEFT JOIN daily_logs dl ON dl.account_id = lu.account_id AND dl.line_user_id = lu.line_user_id
        AND dl.log_date = ?
      WHERE lu.account_id = ?
      ORDER BY lu.last_active_at DESC
      LIMIT 5
    `).bind(today, accountId).all()
  ])

  return ok(c, {
    summary: {
      total_users: totalUsers?.cnt || 0,
      today_logs: todayLogs?.cnt || 0,
      weekly_active: weeklyActive?.cnt || 0
    },
    recent_users: recentUsers.results
  })
})

// 体重推移グラフデータ（全ユーザー平均）
dashboardRouter.get('/weight-trend', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = c.req.query('account_id') || payload.account_id
  const days = parseInt(c.req.query('days') || '30', 10)
  const today = todayJst()

  const trend = await c.env.DB.prepare(`
    SELECT log_date, AVG(weight_kg) as avg_weight, COUNT(DISTINCT line_user_id) as user_count
    FROM daily_logs
    WHERE account_id = ? AND log_date >= date(?, ?) AND weight_kg IS NOT NULL
    GROUP BY log_date
    ORDER BY log_date ASC
  `).bind(accountId, today, `-${days} days`).all<{
    log_date: string; avg_weight: number; user_count: number
  }>()

  return ok(c, { trend: trend.results })
})

export default dashboardRouter
