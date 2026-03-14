/**
 * Admin ユーザー管理 API
 * /api/admin/users
 *
 * 参照: docs/API.md §Admin API > ユーザー管理
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { listUserAccountsWithDetails, findUserAccount, findUserAccountByLineUserId } from '../../repositories/line-users-repo'
import { listRecentDailyLogs } from '../../repositories/daily-logs-repo'
import { listMealEntriesByDailyLogIds } from '../../repositories/meal-entries-repo'
import { listWeightHistory } from '../../repositories/body-metrics-repo'
import { upsertUserServiceStatus, findUserServiceStatus } from '../../repositories/subscriptions-repo'
import { findCorrectionsByUser } from '../../repositories/correction-history-repo'
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
  const isSuperadmin = payload.role === 'superadmin'

  // superadmin はアカウント横断で検索
  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const effectiveAccountId = userAccount.client_account_id
  const svc = await findUserServiceStatus(c.env.DB, effectiveAccountId, lineUserId)
  const recentLogs = await listRecentDailyLogs(c.env.DB, userAccount.id, 30)

  const lineUser = await c.env.DB.prepare(
    'SELECT display_name, picture_url, follow_status FROM line_users WHERE line_user_id = ?1 LIMIT 1'
  ).bind(lineUserId).first<{ display_name: string | null; picture_url: string | null; follow_status: string | null }>()

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

  // 体重推移取得（グラフ用）
  const weightHistory = await listWeightHistory(c.env.DB, userAccount.id, 30)

  // 修正履歴取得
  let correctionHistory: Awaited<ReturnType<typeof findCorrectionsByUser>> = []
  try {
    correctionHistory = await findCorrectionsByUser(c.env.DB, userAccount.id, 20)
  } catch { /* table may not exist */ }

  // ====== 連携ステータス・不整合チェック ======
  // 現在のモードセッション（current_mode / current_step / pending状態）
  let currentMode: string | null = null
  let currentStep: string | null = null
  let pendingStatus: { type: string; id: string | null; createdAt: string | null } | null = null
  try {
    const modeSession = await c.env.DB.prepare(
      `SELECT current_mode, current_step, session_data, updated_at, expires_at FROM bot_mode_sessions
       WHERE client_account_id = ?1 AND line_user_id = ?2 LIMIT 1`
    ).bind(effectiveAccountId, lineUserId).first<any>()
    if (modeSession) {
      currentMode = modeSession.current_mode ?? null
      currentStep = modeSession.current_step ?? null
      if (modeSession.current_step === 'pending_image_confirm') {
        let sessionData: any = {}
        try { sessionData = modeSession.session_data ? JSON.parse(modeSession.session_data) : {} } catch { }
        pendingStatus = { type: 'pending_image_confirm', id: sessionData.intakeResultId ?? null, createdAt: modeSession.updated_at }
      }
    }
  } catch { /* ignore */ }

  let pendingClarification: { id: string; currentField: string; status: string; createdAt: string } | null = null
  try {
    const clar = await c.env.DB.prepare(
      `SELECT id, current_field, status, created_at FROM pending_clarifications
       WHERE user_account_id = ?1 AND status = 'asking' LIMIT 1`
    ).bind(userAccount.id).first<any>()
    if (clar) {
      pendingClarification = { id: clar.id, currentField: clar.current_field, status: clar.status, createdAt: clar.created_at }
    }
  } catch { /* ignore */ }

  // 最新会話日時
  let lastMessageAt: string | null = null
  try {
    const msg = await c.env.DB.prepare(
      `SELECT sent_at FROM conversation_messages cm
       JOIN conversation_threads ct ON ct.id = cm.thread_id
       WHERE ct.user_account_id = ?1
       ORDER BY cm.sent_at DESC LIMIT 1`
    ).bind(userAccount.id).first<any>()
    lastMessageAt = msg?.sent_at ?? null
  } catch { /* ignore */ }

  // 最新画像解析日時
  let lastImageAnalysisAt: string | null = null
  try {
    const img = await c.env.DB.prepare(
      `SELECT created_at FROM image_intake_results
       WHERE user_account_id = ?1
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userAccount.id).first<any>()
    lastImageAnalysisAt = img?.created_at ?? null
  } catch { /* ignore */ }

  // 最新修正日時
  let lastCorrectionAt: string | null = null
  try {
    const cor = await c.env.DB.prepare(
      `SELECT created_at FROM correction_history
       WHERE user_account_id = ?1
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userAccount.id).first<any>()
    lastCorrectionAt = cor?.created_at ?? null
  } catch { /* ignore */ }

  // 最近の画像解析結果（5件: pending/confirmed/discarded を一覧表示）
  let recentImageResults: Array<{
    id: string
    imageCategory: string | null
    appliedFlag: number
    mealDescription: string | null
    estimatedCalories: number | null
    createdAt: string
    confirmedAt: string | null
  }> = []
  try {
    const { results: imgResults } = await c.env.DB.prepare(
      `SELECT id, image_category, applied_flag, extracted_json, proposed_action_json, created_at, confirmed_at
       FROM image_intake_results
       WHERE user_account_id = ?1
       ORDER BY created_at DESC
       LIMIT 5`
    ).bind(userAccount.id).all<any>()
    recentImageResults = (imgResults ?? []).map((r: any) => {
      let mealDesc: string | null = null
      let estCal: number | null = null
      try {
        const action = r.proposed_action_json ? JSON.parse(r.proposed_action_json) : {}
        mealDesc = action.meal_text ?? null
        estCal = action.calories_kcal ?? null
      } catch { /* ignore */ }
      return {
        id: r.id,
        imageCategory: r.image_category,
        appliedFlag: r.applied_flag,
        mealDescription: mealDesc,
        estimatedCalories: estCal,
        createdAt: r.created_at,
        confirmedAt: r.confirmed_at,
      }
    })
  } catch { /* ignore */ }

  // 整合性チェック
  const integrity = {
    lineUserExists: !!lineUser,
    userAccountExists: true,
    serviceStatusExists: !!svc,
    profileExists: !!profile,
    followStatus: lineUser?.follow_status ?? 'unknown',
    issues: [] as string[],
  }
  if (!lineUser) integrity.issues.push('line_users レコードなし')
  if (!svc) integrity.issues.push('user_service_statuses レコードなし')
  if (svc && svc.intake_completed === 1 && !profile) integrity.issues.push('問診完了だが profile なし')
  if (lineUser?.follow_status === 'blocked') integrity.issues.push('ユーザーがブロック/アンフォロー済み')
  if (pendingStatus) integrity.issues.push('pending_image_confirm あり')
  if (pendingClarification) integrity.issues.push('pending_clarification あり')

  return ok(c, {
    userAccountId: userAccount.id,
    lineUserId,
    clientAccountId: effectiveAccountId,
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
    weightHistory,
    // ====== 修正履歴 ======
    correctionHistory: correctionHistory.map(ch => ({
      id: ch.id,
      targetTable: ch.target_table,
      targetRecordId: ch.target_record_id,
      correctionType: ch.correction_type,
      oldValueJson: ch.old_value_json,
      newValueJson: ch.new_value_json,
      triggeredBy: ch.triggered_by,
      reason: ch.reason,
      createdAt: ch.created_at,
    })),
    // ====== 連携・不整合情報 ======
    linkage: {
      currentMode,
      currentStep,
      pendingStatus,
      pendingClarification,
      lastMessageAt,
      lastImageAnalysisAt,
      lastCorrectionAt,
      recentImageResults,
      integrity,
    },
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
  const isSuperadmin = payload.role === 'superadmin'

  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  const effectiveAccountId = userAccount.client_account_id

  const body = await c.req.json<{
    bot_enabled?: boolean
    record_enabled?: boolean
    consult_enabled?: boolean
    intake_completed?: boolean
  }>()

  await upsertUserServiceStatus(c.env.DB, {
    accountId: effectiveAccountId,
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
  const isSuperadmin = payload.role === 'superadmin'
  const limit = parseInt(c.req.query('limit') || '30', 10)

  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
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
  const isSuperadmin = payload.role === 'superadmin'
  const limit = parseInt(c.req.query('limit') || '20', 10)

  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
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
  const isSuperadmin = payload.role === 'superadmin'
  const limit = parseInt(c.req.query('limit') || '12', 10)

  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
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

// ===================================================================
// 修正履歴一覧（管理者閲覧）
// GET /api/admin/users/:lineUserId/corrections?limit=30
// ===================================================================

usersRouter.get('/:lineUserId/corrections', async (c) => {
  const payload = c.get('jwtPayload')
  const lineUserId = c.req.param('lineUserId')
  const accountId = payload.accountId
  const isSuperadmin = payload.role === 'superadmin'
  const limit = parseInt(c.req.query('limit') || '30', 10)

  const userAccount = isSuperadmin
    ? await findUserAccountByLineUserId(c.env.DB, lineUserId)
    : await findUserAccount(c.env.DB, lineUserId, accountId)
  if (!userAccount) return notFound(c, 'User not found')

  try {
    const corrections = await findCorrectionsByUser(c.env.DB, userAccount.id, limit)
    return ok(c, {
      corrections: corrections.map(ch => ({
        id: ch.id,
        targetTable: ch.target_table,
        targetRecordId: ch.target_record_id,
        correctionType: ch.correction_type,
        oldValueJson: ch.old_value_json,
        newValueJson: ch.new_value_json,
        triggeredBy: ch.triggered_by,
        reason: ch.reason,
        createdAt: ch.created_at,
      })),
    })
  } catch {
    return ok(c, { corrections: [] })
  }
})

export default usersRouter
