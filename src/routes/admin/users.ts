/**
 * Admin ユーザー管理 API
 * /api/admin/users
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { LineUserRepo, ProfileRepo, DailyLogRepo, MealRepo, SessionRepo } from '../../repository'
import { ok, badRequest, notFound } from '../../utils/response'

const usersRouter = new Hono<HonoEnv>()

// ユーザー一覧
usersRouter.get('/', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = c.req.query('account_id') || payload.account_id
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const { users, total } = await LineUserRepo.listByAccountId(c.env.DB, accountId, limit, offset)

  return ok(c, { users, total, limit, offset })
})

// ユーザー詳細
usersRouter.get('/:lineUserId', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = c.req.query('account_id') || payload.account_id

  const lineUser = await LineUserRepo.findByLineUserId(c.env.DB, accountId, lineUserId)
  if (!lineUser) return notFound(c, 'User not found')

  const profile = await ProfileRepo.findByUser(c.env.DB, accountId, lineUserId)
  const recentLogs = await DailyLogRepo.getRecent(c.env.DB, accountId, lineUserId, 30)
  const streak = await DailyLogRepo.getStreak(c.env.DB, accountId, lineUserId)

  return ok(c, {
    user: lineUser,
    profile,
    recentLogs,
    streak
  })
})

// ユーザーのサービス設定変更
usersRouter.patch('/:lineUserId/service', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = c.req.query('account_id') || payload.account_id
  const body = await c.req.json<{
    bot_enabled?: boolean
    record_enabled?: boolean
    consult_enabled?: boolean
    intake_enabled?: boolean
  }>()

  const lineUser = await LineUserRepo.findByLineUserId(c.env.DB, accountId, lineUserId)
  if (!lineUser) return notFound(c, 'User not found')

  const updates: string[] = []
  const values: unknown[] = []
  if (body.bot_enabled !== undefined) { updates.push('bot_enabled = ?'); values.push(body.bot_enabled ? 1 : 0) }
  if (body.record_enabled !== undefined) { updates.push('record_enabled = ?'); values.push(body.record_enabled ? 1 : 0) }
  if (body.consult_enabled !== undefined) { updates.push('consult_enabled = ?'); values.push(body.consult_enabled ? 1 : 0) }
  if (body.intake_enabled !== undefined) { updates.push('intake_enabled = ?'); values.push(body.intake_enabled ? 1 : 0) }

  if (updates.length > 0) {
    await c.env.DB.prepare(`
      UPDATE user_service_statuses SET ${updates.join(', ')}, updated_at = datetime('now')
      WHERE account_id = ? AND line_user_id = ?
    `).bind(...values, accountId, lineUserId).run()
  }

  return ok(c, { success: true })
})

// ユーザーの記録一覧（管理者閲覧）
usersRouter.get('/:lineUserId/logs', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = c.req.query('account_id') || payload.account_id
  const days = parseInt(c.req.query('days') || '30', 10)

  const logs = await DailyLogRepo.getRecent(c.env.DB, accountId, lineUserId, days)
  const logsWithMeals = await Promise.all(
    logs.map(async (log) => {
      const meals = await MealRepo.getByDate(c.env.DB, accountId, lineUserId, log.log_date)
      return { ...log, meals }
    })
  )

  return ok(c, { logs: logsWithMeals })
})

export default usersRouter
