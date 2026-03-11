/**
 * Admin ダッシュボード API
 * /api/admin/dashboard
 *
 * 参照: docs/API.md §Admin API > ダッシュボード
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { ok } from '../../utils/response'
import { todayJst } from '../../utils/id'
import type { Context } from 'hono'

const dashboardRouter = new Hono<HonoEnv>()

// ===================================================================
// 共通: ダッシュボード統計データ取得
// ===================================================================

async function fetchDashboardData(c: Context<HonoEnv>) {
  const payload = c.get('jwtPayload')
  const accountId = payload.accountId
  const today = todayJst()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().substring(0, 10)

  const [totalUsersRow, todayLogsRow, weeklyActiveRow, intakeIncompleteRow] = await Promise.all([
    // 総ユーザー数（アクティブな user_accounts）
    c.env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM user_accounts
      WHERE client_account_id = ?1 AND status = 'active'
    `).bind(accountId).first<{ cnt: number }>(),

    // 今日の記録件数
    c.env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM daily_logs
      WHERE client_account_id = ?1 AND log_date = ?2
    `).bind(accountId, today).first<{ cnt: number }>(),

    // 週間アクティブユーザー（7日以内に記録）
    c.env.DB.prepare(`
      SELECT COUNT(DISTINCT user_account_id) as cnt FROM daily_logs
      WHERE client_account_id = ?1 AND log_date >= ?2
    `).bind(accountId, sevenDaysAgo).first<{ cnt: number }>(),

    // M2-3: 問診未完了ユーザー数
    c.env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM user_service_statuses
      WHERE account_id = ?1 AND intake_completed = 0 AND bot_enabled = 1
    `).bind(accountId).first<{ cnt: number }>(),
  ])

  // 最近アクティブなユーザー5件
  const recentUsers = await c.env.DB.prepare(`
    SELECT
      ua.id           AS userAccountId,
      ua.line_user_id AS lineUserId,
      lu.display_name AS displayName,
      bm.weight_kg    AS latestWeight,
      dl.log_date     AS lastLogDate
    FROM user_accounts ua
    LEFT JOIN line_users lu ON lu.line_user_id = ua.line_user_id
    LEFT JOIN daily_logs dl ON dl.user_account_id = ua.id
      AND dl.log_date = (
        SELECT MAX(log_date) FROM daily_logs
        WHERE user_account_id = ua.id
      )
    LEFT JOIN body_metrics bm ON bm.daily_log_id = dl.id
    WHERE ua.client_account_id = ?1 AND ua.status = 'active'
    ORDER BY dl.log_date DESC
    LIMIT 5
  `).bind(accountId).all<{
    userAccountId: string
    lineUserId: string
    displayName: string | null
    latestWeight: number | null
    lastLogDate: string | null
  }>()

  return {
    totalUsers: totalUsersRow?.cnt ?? 0,
    todayLogs: todayLogsRow?.cnt ?? 0,
    weeklyActive: weeklyActiveRow?.cnt ?? 0,
    incompleteIntake: intakeIncompleteRow?.cnt ?? 0,
    recentUsers: recentUsers.results,
  }
}

// ===================================================================
// ダッシュボードサマリー
// GET /api/admin/dashboard/stats
// ===================================================================

dashboardRouter.get('/stats', async (c) => {
  const data = await fetchDashboardData(c)
  return ok(c, {
    stats: {
      totalActiveUsers: data.totalUsers,
      todayLogCount: data.todayLogs,
      weeklyActiveUsers: data.weeklyActive,
      intakeIncompleteCount: data.incompleteIntake,
    },
    recentUsers: data.recentUsers,
    // 後方互換 — フロント側が summary / recent_users を参照する場合にも対応
    summary: {
      total_users: data.totalUsers,
      today_logs: data.todayLogs,
      weekly_active: data.weeklyActive,
      incomplete_intake: data.incompleteIntake,
    },
    recent_users: data.recentUsers.map((u) => ({
      ...u,
      nickname: u.displayName,
      display_name: u.displayName,
      current_weight_kg: u.latestWeight,
      last_active_at: u.lastLogDate,
    })),
  })
})

// ===================================================================
// /summary → /stats 互換エイリアス
// フロントエンドが /admin/dashboard/summary を呼ぶ場合に対応
// ===================================================================

dashboardRouter.get('/summary', async (c) => {
  const data = await fetchDashboardData(c)
  return ok(c, {
    summary: {
      total_users: data.totalUsers,
      today_logs: data.todayLogs,
      weekly_active: data.weeklyActive,
      incomplete_intake: data.incompleteIntake,
    },
    recent_users: data.recentUsers.map((u) => ({
      ...u,
      nickname: u.displayName,
      display_name: u.displayName,
      current_weight_kg: u.latestWeight,
      last_active_at: u.lastLogDate,
    })),
  })
})

// ===================================================================
// 最近の会話
// GET /api/admin/dashboard/conversations
// ===================================================================

dashboardRouter.get('/conversations', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = payload.accountId
  const limit = parseInt(c.req.query('limit') || '10', 10)

  const conversations = await c.env.DB.prepare(`
    SELECT
      ct.id           AS threadId,
      ct.line_user_id AS lineUserId,
      lu.display_name AS displayName,
      ct.current_mode AS mode,
      ct.last_message_at AS lastMessageAt,
      cm.raw_text     AS lastMessage
    FROM conversation_threads ct
    LEFT JOIN line_users lu ON lu.line_user_id = ct.line_user_id
    LEFT JOIN conversation_messages cm ON cm.id = (
      SELECT id FROM conversation_messages
      WHERE thread_id = ct.id
      ORDER BY sent_at DESC LIMIT 1
    )
    WHERE ct.client_account_id = ?1 AND ct.status = 'open'
    ORDER BY ct.last_message_at DESC
    LIMIT ?2
  `).bind(accountId, limit).all<{
    threadId: string
    lineUserId: string
    displayName: string | null
    mode: string
    lastMessageAt: string | null
    lastMessage: string | null
  }>()

  return ok(c, { conversations: conversations.results })
})

export default dashboardRouter
