/**
 * User API（後方互換: マジックリンク方式）
 * /api/user/*
 *
 * 参照: docs/API.md §ユーザー API
 * NOTE: JWT方式（/api/users/me/*）が正式版。
 *       このファイルは後方互換のため維持する。
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { findUserAccount } from '../../repositories/line-users-repo'
import { ensureDailyLog, listRecentDailyLogs, findDailyLogByUserAndDate } from '../../repositories/daily-logs-repo'
import { findMealEntriesByDailyLog } from '../../repositories/meal-entries-repo'
import { listProgressPhotosByUser } from '../../repositories/progress-photos-repo'
import { listWeeklyReportsByUser } from '../../repositories/weekly-reports-repo'
import { findBodyMetricsByDailyLog } from '../../repositories/body-metrics-repo'
import { ok, badRequest, notFound } from '../../utils/response'
import { todayJst } from '../../utils/id'

type HonoEnv = { Bindings: Bindings }

const userRouter = new Hono<HonoEnv>()

// ===================================================================
// ダッシュボードデータ
// GET /api/user/dashboard?line_user_id=xxx&account_id=xxx
// ===================================================================

userRouter.get('/dashboard', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const today = todayJst()
  const dailyLog = await ensureDailyLog(c.env.DB, {
    userAccountId: userAccount.id,
    clientAccountId: accountId,
    logDate: today,
  })

  const [meals, recentLogs, bodyMetrics, photos] = await Promise.all([
    findMealEntriesByDailyLog(c.env.DB, dailyLog.id),
    listRecentDailyLogs(c.env.DB, userAccount.id, 14),
    findBodyMetricsByDailyLog(c.env.DB, dailyLog.id),
    listProgressPhotosByUser(c.env.DB, userAccount.id, 3),
  ])

  return ok(c, {
    dailyLog,
    meals,
    weightKg: bodyMetrics?.weight_kg ?? null,
    recentLogs,
    photos,
  })
})

// ===================================================================
// 日次ログ一覧
// GET /api/user/records?line_user_id=xxx&account_id=xxx&limit=30
// ===================================================================

userRouter.get('/records', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')
  const limit = parseInt(c.req.query('limit') || '30', 10)

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const logs = await listRecentDailyLogs(c.env.DB, userAccount.id, limit)
  return ok(c, { logs })
})

// ===================================================================
// 特定日の記録詳細
// GET /api/user/records/:date?line_user_id=xxx&account_id=xxx
// ===================================================================

userRouter.get('/records/:date', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')
  const date = c.req.param('date')

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const log = await findDailyLogByUserAndDate(c.env.DB, userAccount.id, date)
  if (!log) return notFound(c, 'Log not found')

  const [meals, bodyMetrics] = await Promise.all([
    findMealEntriesByDailyLog(c.env.DB, log.id),
    findBodyMetricsByDailyLog(c.env.DB, log.id),
  ])

  return ok(c, { log, meals, bodyMetrics })
})

// ===================================================================
// 進捗写真一覧
// GET /api/user/progress-photos?line_user_id=xxx&account_id=xxx
// ===================================================================

userRouter.get('/progress-photos', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')
  const limit = parseInt(c.req.query('limit') || '20', 10)

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const photos = await listProgressPhotosByUser(c.env.DB, userAccount.id, limit)
  return ok(c, { photos })
})

// ===================================================================
// 週次レポート一覧
// GET /api/user/weekly-reports?line_user_id=xxx&account_id=xxx
// ===================================================================

userRouter.get('/weekly-reports', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const reports = await listWeeklyReportsByUser(c.env.DB, userAccount.id)
  return ok(c, { reports })
})

export default userRouter
