/**
 * Admin ユーザー管理 API
 * /api/admin/users
 *
 * 参照: docs/API.md §Admin API > ユーザー管理
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { listUserAccountsWithDetails, findUserAccount } from '../../repositories/line-users-repo'
import { listRecentDailyLogs } from '../../repositories/daily-logs-repo'
import { listMealEntriesByDailyLogIds } from '../../repositories/meal-entries-repo'
import { upsertUserServiceStatus, findUserServiceStatus } from '../../repositories/subscriptions-repo'
import type { UserProfile } from '../../types/db'
import { ok, badRequest, notFound } from '../../utils/response'

const usersRouter = new Hono<HonoEnv>()

// ===================================================================
// ユーザー一覧
// GET /api/admin/users?limit=20&offset=0
// ===================================================================

usersRouter.get('/', async (c) => {
  const payload = c.get('jwtPayload')
  const accountId = payload.accountId
  const isSuperadmin = payload.role === 'superadmin'
  const limit = parseInt(c.req.query('limit') || '100', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  if (isSuperadmin) {
    // Superadmin: 全ユーザーを取得し、所属admin情報も含める
    const { results: rows } = await c.env.DB.prepare(`
      SELECT
        ua.id           AS userAccountId,
        ua.line_user_id AS lineUserId,
        lu.display_name AS display_name,
        ua.status       AS status,
        ua.joined_at    AS joinedAt,
        ua.client_account_id AS clientAccountId,
        uss.bot_enabled,
        uss.record_enabled,
        uss.consult_enabled,
        uss.intake_completed,
        a.name          AS accountName,
        am.email        AS adminEmail
      FROM user_accounts ua
      LEFT JOIN line_users lu
        ON lu.line_user_id = ua.line_user_id
      LEFT JOIN user_service_statuses uss
        ON uss.account_id = ua.client_account_id
        AND uss.line_user_id = ua.line_user_id
      LEFT JOIN accounts a
        ON a.id = ua.client_account_id
      LEFT JOIN account_memberships am
        ON am.account_id = ua.client_account_id
        AND am.role = 'admin'
        AND am.status = 'active'
      WHERE ua.status = 'active'
      ORDER BY ua.joined_at DESC
      LIMIT ?1 OFFSET ?2
    `).bind(limit, offset).all<any>()

    const users = rows.map((r: any) => ({
      userAccountId: r.userAccountId,
      lineUserId: r.lineUserId,
      display_name: r.display_name,
      status: r.status,
      joinedAt: r.joinedAt,
      clientAccountId: r.clientAccountId,
      accountName: r.accountName,
      adminEmail: r.adminEmail,
      botEnabled: r.bot_enabled === 1,
      recordEnabled: r.record_enabled === 1,
      consultEnabled: r.consult_enabled === 1,
      intakeCompleted: r.intake_completed === 1,
    }))

    return ok(c, { users, limit, offset })
  }

  // Admin: 自分のアカウントのユーザーのみ
  const rows = await listUserAccountsWithDetails(c.env.DB, accountId, limit, offset)

  const users = rows.map((r) => ({
    userAccountId: r.userAccountId,
    lineUserId: r.lineUserId,
    display_name: r.display_name,
    status: r.status,
    joinedAt: r.joinedAt,
    botEnabled: r.bot_enabled === 1,
    recordEnabled: r.record_enabled === 1,
    consultEnabled: r.consult_enabled === 1,
    intakeCompleted: r.intake_completed === 1,
  }))

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

  const lineUser = await c.env.DB.prepare(
    'SELECT display_name, picture_url FROM line_users WHERE line_user_id = ?1 LIMIT 1'
  ).bind(lineUserId).first<{ display_name: string | null; picture_url: string | null }>()

  // プロフィール取得
  const profile = await c.env.DB.prepare(
    'SELECT * FROM user_profiles WHERE user_account_id = ?1 LIMIT 1'
  ).bind(userAccount.id).first<UserProfile>()

  // 問診回答取得
  const { results: intakeAnswers } = await c.env.DB.prepare(
    `SELECT question_key, answer_value, answered_at
     FROM intake_answers
     WHERE user_account_id = ?1
     ORDER BY answered_at ASC`
  ).bind(userAccount.id).all<{
    question_key: string
    answer_value: string | null
    answered_at: string
  }>()

  return ok(c, {
    userAccountId: userAccount.id,
    lineUserId,
    display_name: lineUser?.display_name ?? null,
    picture_url: lineUser?.picture_url ?? null,
    status: userAccount.status,
    joinedAt: userAccount.joined_at,
    service: svc ?? null,
    profile: profile ? {
      nickname: profile.nickname,
      gender: profile.gender,
      ageRange: profile.age_range,
      heightCm: profile.height_cm,
      currentWeightKg: profile.current_weight_kg,
      targetWeightKg: profile.target_weight_kg,
      goalSummary: profile.goal_summary,
      concernTags: profile.concern_tags,
      activityLevel: profile.activity_level,
      updatedAt: profile.updated_at,
    } : null,
    intakeAnswers: intakeAnswers ?? [],
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

  // N+1 解消: 全ログIDの食事記録を 1 クエリで一括取得して振り分け
  if (logs.length === 0) return ok(c, { logs: [] })

  const logIds = logs.map(l => l.id)
  const allMeals = await listMealEntriesByDailyLogIds(c.env.DB, logIds)

  // daily_log_id → meals[] の Map を構築
  const mealsMap = new Map<string, typeof allMeals>()
  for (const meal of allMeals) {
    const arr = mealsMap.get(meal.daily_log_id) ?? []
    arr.push(meal)
    mealsMap.set(meal.daily_log_id, arr)
  }

  const logsWithMeals = logs.map(log => ({
    ...log,
    meals: mealsMap.get(log.id) ?? [],
  }))

  return ok(c, { logs: logsWithMeals })
})

// ===================================================================
// L-2: ユーザーの写真一覧（管理者閲覧）
// GET /api/admin/users/:lineUserId/photos?limit=20
// ===================================================================

usersRouter.get('/:lineUserId/photos', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId
  const limit = parseInt(c.req.query('limit') || '20', 10)

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const { results: photos } = await c.env.DB.prepare(`
    SELECT id, photo_date, photo_type, storage_key, pose_label, body_part_label, note, created_at
    FROM progress_photos
    WHERE user_account_id = ?1
    ORDER BY photo_date DESC, created_at DESC
    LIMIT ?2
  `).bind(userAccount.id, limit).all<{
    id: string
    photo_date: string
    photo_type: string
    storage_key: string
    pose_label: string | null
    body_part_label: string | null
    note: string | null
    created_at: string
  }>()

  return ok(c, { photos })
})

// ===================================================================
// L-2: ユーザーの週次レポート一覧（管理者閲覧）
// GET /api/admin/users/:lineUserId/reports?limit=12
// ===================================================================

usersRouter.get('/:lineUserId/reports', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId
  const limit = parseInt(c.req.query('limit') || '12', 10)

  const userAccount = await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const { results: reports } = await c.env.DB.prepare(`
    SELECT id, week_start, week_end, avg_weight_kg, min_weight_kg, max_weight_kg,
           weight_change, meal_log_count, log_days, ai_summary, sent_at, created_at
    FROM weekly_reports
    WHERE user_account_id = ?1
    ORDER BY week_start DESC
    LIMIT ?2
  `).bind(userAccount.id, limit).all()

  return ok(c, { reports })
})

export default usersRouter
