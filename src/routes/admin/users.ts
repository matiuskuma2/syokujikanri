/**
 * Admin ユーザー管理 API
 * /api/admin/users
 *
 * 参照: docs/API.md §Admin API > ユーザー管理
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { listUserAccountsByClientAccount, findUserAccount } from '../../repositories/line-users-repo'
import { listRecentDailyLogs } from '../../repositories/daily-logs-repo'
import { findMealEntriesByDailyLog } from '../../repositories/meal-entries-repo'
import { upsertUserServiceStatus, findUserServiceStatus } from '../../repositories/subscriptions-repo'
import { ok, badRequest, notFound } from '../../utils/response'

const usersRouter = new Hono<HonoEnv>()

// ===================================================================
// ユーザー一覧
// GET /api/admin/users?limit=20&offset=0
// ===================================================================

usersRouter.get('/', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = payload.accountId
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const userAccounts = await listUserAccountsByClientAccount(c.env.DB, accountId, limit, offset)

  // 各ユーザーのサービスステータスを付与
  const users = await Promise.all(
    userAccounts.map(async (ua) => {
      const svc = await findUserServiceStatus(c.env.DB, accountId, ua.line_user_id)
      return {
        userAccountId: ua.id,
        lineUserId: ua.line_user_id,
        status: ua.status,
        joinedAt: ua.joined_at,
        botEnabled: svc?.bot_enabled === 1,
        recordEnabled: svc?.record_enabled === 1,
        consultEnabled: svc?.consult_enabled === 1,
        intakeCompleted: svc?.intake_completed === 1,
      }
    })
  )

  return ok(c, { users, limit, offset })
})

// ===================================================================
// ユーザー詳細
// GET /api/admin/users/:lineUserId
// ===================================================================

usersRouter.get('/:lineUserId', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const svc = await findUserServiceStatus(c.env.DB, accountId, lineUserId)
  const recentLogs = await listRecentDailyLogs(c.env.DB, userAccount.id, 30)

  return ok(c, {
    userAccountId: userAccount.id,
    lineUserId,
    status: userAccount.status,
    joinedAt: userAccount.joined_at,
    service: svc ?? null,
    recentLogs,
  })
})

// ===================================================================
// ユーザーのサービス設定変更
// PATCH /api/admin/users/:lineUserId/service
// ===================================================================

usersRouter.patch('/:lineUserId/service', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const body = await c.req.json<{
    bot_enabled?: boolean
    record_enabled?: boolean
    consult_enabled?: boolean
    intake_completed?: boolean
  }>()

  await upsertUserServiceStatus(c.env.DB, {
    accountId,
    lineUserId,
    botEnabled:      body.bot_enabled !== undefined ? (body.bot_enabled ? 1 : 0) : undefined,
    recordEnabled:   body.record_enabled !== undefined ? (body.record_enabled ? 1 : 0) : undefined,
    consultEnabled:  body.consult_enabled !== undefined ? (body.consult_enabled ? 1 : 0) : undefined,
    intakeCompleted: body.intake_completed !== undefined ? (body.intake_completed ? 1 : 0) : undefined,
  })

  return ok(c, { success: true })
})

// ===================================================================
// ユーザーの記録一覧（管理者閲覧）
// GET /api/admin/users/:lineUserId/logs?limit=30
// ===================================================================

usersRouter.get('/:lineUserId/logs', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId
  const limit = parseInt(c.req.query('limit') || '30', 10)

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const logs = await listRecentDailyLogs(c.env.DB, userAccount.id, limit)
  const logsWithMeals = await Promise.all(
    logs.map(async (log) => {
      const meals = await findMealEntriesByDailyLog(c.env.DB, log.id)
      return { ...log, meals }
    })
  )

  return ok(c, { logs: logsWithMeals })
})

export default usersRouter
