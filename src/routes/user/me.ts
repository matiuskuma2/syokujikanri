/**
 * src/routes/user/me.ts
 * JWT 認証付き ユーザー自身のデータ API
 *
 * ベースパス: /api/users/me
 * 認証: Bearer JWT (role: 'user', sub = userAccountId)
 *
 * エンドポイント:
 *   GET  /api/users/me                   — プロフィール
 *   GET  /api/users/me/records           — 日次ログ一覧（直近 limit 件）
 *   GET  /api/users/me/records/:date     — 特定日の記録詳細
 *   GET  /api/users/me/progress-photos   — 進捗写真一覧
 *   GET  /api/users/me/weekly-reports    — 週次レポート一覧
 *   PATCH /api/users/me/service          — サービスフラグ更新（自己申告）
 *
 * 認可ポリシー:
 *   - jwt.sub = userAccountId で絞り込み
 *   - 他ユーザーのデータへのアクセスは拒否
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { authMiddleware } from '../../middleware/auth'
import { findUserAccountById } from '../../repositories/line-users-repo'
import { findLineUser } from '../../repositories/line-users-repo'
import {
  ensureDailyLog,
  listRecentDailyLogs,
  findDailyLogByUserAndDate,
} from '../../repositories/daily-logs-repo'
import { findMealEntriesByDailyLog } from '../../repositories/meal-entries-repo'
import { findBodyMetricsByDailyLog } from '../../repositories/body-metrics-repo'
import { listProgressPhotosByUser } from '../../repositories/progress-photos-repo'
import { listWeeklyReportsByUser } from '../../repositories/weekly-reports-repo'
import { upsertUserServiceStatus } from '../../repositories/subscriptions-repo'
import { ok, badRequest, notFound } from '../../utils/response'
import { todayJst } from '../../utils/id'

const meRouter = new Hono<HonoEnv>()

// JWT 認証を全ルートに適用
meRouter.use('*', authMiddleware)

// ===================================================================
// GET /api/users/me  — プロフィール情報
// ===================================================================

meRouter.get('/', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub

  const userAccount = await findUserAccountById(c.env.DB, userAccountId)
  if (!userAccount) return notFound(c, 'User account not found')

  // LINE ユーザー情報を追加取得
  const lineUser = await findLineUser(c.env.DB, c.env.LINE_CHANNEL_ID, userAccount.line_user_id)

  return ok(c, {
    userAccountId: userAccount.id,
    lineUserId: userAccount.line_user_id,
    displayName: lineUser?.display_name ?? null,
    pictureUrl: lineUser?.picture_url ?? null,
    status: userAccount.status,
    joinedAt: userAccount.joined_at,
  })
})

// ===================================================================
// GET /api/users/me/records  — 日次ログ一覧
// ===================================================================

meRouter.get('/records', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub
  const limit = Math.min(parseInt(c.req.query('limit') || '30', 10), 90)

  const logs = await listRecentDailyLogs(c.env.DB, userAccountId, limit)
  return ok(c, { logs, count: logs.length })
})

// ===================================================================
// GET /api/users/me/records/:date  — 特定日の記録詳細
// ===================================================================

meRouter.get('/records/:date', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub
  const date = c.req.param('date')

  // 日付フォーマット簡易チェック
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return badRequest(c, 'date must be YYYY-MM-DD format')
  }

  // 当日なら自動作成、過去日は取得のみ
  const today = todayJst()
  const isToday = date === today

  const log = isToday
    ? await ensureDailyLog(c.env.DB, {
        userAccountId,
        clientAccountId: payload.accountId,
        logDate: date,
      })
    : await findDailyLogByUserAndDate(c.env.DB, userAccountId, date)

  if (!log) return notFound(c, `No record found for ${date}`)

  const [meals, bodyMetrics] = await Promise.all([
    findMealEntriesByDailyLog(c.env.DB, log.id),
    findBodyMetricsByDailyLog(c.env.DB, log.id),
  ])

  return ok(c, {
    date,
    log,
    meals,
    bodyMetrics,
    isToday,
  })
})

// ===================================================================
// GET /api/users/me/progress-photos  — 進捗写真一覧
// ===================================================================

meRouter.get('/progress-photos', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const photos = await listProgressPhotosByUser(c.env.DB, userAccountId, limit, offset)

  // storage_key から /api/files/progress/:id の URL を付与
  const appUrl = c.env.APP_URL ?? ''
  const photosWithUrl = photos.map((p) => ({
    ...p,
    viewUrl: `${appUrl}/api/files/progress/${p.id}`,
  }))

  return ok(c, { photos: photosWithUrl, count: photos.length })
})

// ===================================================================
// GET /api/users/me/weekly-reports  — 週次レポート一覧
// ===================================================================

meRouter.get('/weekly-reports', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub
  const limit = Math.min(parseInt(c.req.query('limit') || '12', 10), 52)

  const reports = await listWeeklyReportsByUser(c.env.DB, userAccountId, limit)
  return ok(c, { reports, count: reports.length })
})

// ===================================================================
// PATCH /api/users/me/service  — サービスフラグ更新（自己申告）
// ===================================================================

meRouter.patch('/service', async (c) => {
  const payload = c.get('jwtPayload')
  const userAccountId = payload.sub

  // userAccountId から line_user_id を引く
  const userAccount = await findUserAccountById(c.env.DB, userAccountId)
  if (!userAccount) return notFound(c, 'User account not found')

  const body = await c.req.json<{
    botEnabled?: boolean
    recordEnabled?: boolean
    consultEnabled?: boolean
  }>().catch(() => ({}))

  // 少なくとも1フィールドが必要
  if (
    body.botEnabled === undefined &&
    body.recordEnabled === undefined &&
    body.consultEnabled === undefined
  ) {
    return badRequest(c, 'At least one field (botEnabled, recordEnabled, consultEnabled) is required')
  }

  // 部分更新用のオブジェクトを構築（undefined は渡さない）
  const updateParams: {
    accountId: string
    lineUserId: string
    botEnabled?: number
    recordEnabled?: number
    consultEnabled?: number
  } = {
    accountId: payload.accountId,
    lineUserId: userAccount.line_user_id,
  }
  if (body.botEnabled !== undefined)     updateParams.botEnabled     = body.botEnabled ? 1 : 0
  if (body.recordEnabled !== undefined)  updateParams.recordEnabled  = body.recordEnabled ? 1 : 0
  if (body.consultEnabled !== undefined) updateParams.consultEnabled = body.consultEnabled ? 1 : 0

  await upsertUserServiceStatus(c.env.DB, updateParams)

  return ok(c, { updated: true })
})

export default meRouter
