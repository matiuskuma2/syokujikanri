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

// ===================================================================
// DB テーブル行数統計 (Superadmin 用)
// GET /api/admin/dashboard/db-stats
// ===================================================================

dashboardRouter.get('/db-stats', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const tables = [
    'accounts', 'account_memberships', 'subscriptions',
    'line_users', 'user_accounts', 'user_service_statuses', 'user_profiles',
    'intake_answers', 'daily_logs', 'meal_entries', 'body_metrics',
    'conversation_threads', 'conversation_messages', 'message_attachments',
    'image_analysis_jobs', 'image_intake_results', 'bot_mode_sessions',
    'progress_photos', 'weekly_reports',
    'invite_codes', 'invite_code_usages',
  ]

  const results: { name: string; count: number }[] = []
  for (const table of tables) {
    try {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM ${table}`
      ).first<{ cnt: number }>()
      results.push({ name: table, count: row?.cnt ?? 0 })
    } catch {
      results.push({ name: table, count: -1 })
    }
  }

  return ok(c, { tables: results })
})

// ===================================================================
// 管理者一覧
// GET /api/admin/dashboard/members
// ===================================================================

dashboardRouter.get('/members', async (c) => {
  const payload = c.get('jwtPayload')
  // superadmin: 全メンバー表示, admin: 同一アカウントのメンバーのみ
  const isSuperadmin = payload.role === 'superadmin'

  let sql: string
  let params: any[]

  if (isSuperadmin) {
    sql = `
      SELECT am.id, am.account_id, am.email, am.role, am.status, am.last_login_at, am.created_at,
             a.name AS account_name,
             (SELECT COUNT(*) FROM user_accounts ua WHERE ua.client_account_id = am.account_id AND ua.status = 'active') AS user_count
      FROM account_memberships am
      LEFT JOIN accounts a ON a.id = am.account_id
      ORDER BY am.created_at DESC
    `
    params = []
  } else {
    sql = `
      SELECT am.id, am.account_id, am.email, am.role, am.status, am.last_login_at, am.created_at,
             a.name AS account_name,
             (SELECT COUNT(*) FROM user_accounts ua WHERE ua.client_account_id = am.account_id AND ua.status = 'active') AS user_count
      FROM account_memberships am
      LEFT JOIN accounts a ON a.id = am.account_id
      WHERE am.account_id = ?1
      ORDER BY am.created_at DESC
    `
    params = [payload.accountId]
  }

  const stmt = params.length > 0
    ? c.env.DB.prepare(sql).bind(...params)
    : c.env.DB.prepare(sql)

  const { results } = await stmt.all<{
    id: string
    account_id: string
    email: string
    role: string
    status: string
    last_login_at: string | null
    created_at: string
    account_name: string | null
    user_count: number
  }>()

  return ok(c, { members: results })
})

// ===================================================================
// 管理者を直接作成（仮パスワード方式）
// POST /api/admin/dashboard/members
// superadmin: admin を作成可能, admin: staff のみ作成可能
// ===================================================================

dashboardRouter.post('/members', async (c) => {
  const payload = c.get('jwtPayload')
  const body = await c.req.json<{
    email: string
    password: string
    role?: string
    accountId?: string
  }>().catch(() => ({} as any))

  if (!body.email || !body.password) {
    return c.json({ success: false, error: 'Email and password are required' }, 400)
  }
  if (body.password.length < 8) {
    return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400)
  }

  const role = body.role ?? 'staff'
  if (!['admin', 'staff'].includes(role)) {
    return c.json({ success: false, error: 'Role must be admin or staff' }, 400)
  }

  // 権限チェック: superadminのみadminを作成可能
  if (role === 'admin' && payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Only superadmin can create admin accounts' }, 403)
  }
  // staffは誰も作成できない
  if (payload.role === 'staff') {
    return c.json({ success: false, error: 'Staff cannot create accounts' }, 403)
  }

  // メール重複チェック
  const existing = await c.env.DB.prepare(
    "SELECT id FROM account_memberships WHERE email = ?1 AND status = 'active'"
  ).bind(body.email).first()
  if (existing) {
    return c.json({ success: false, error: 'Email already registered' }, 400)
  }

  // superadminがadminを作る場合: accountIdが必要。指定がなければクライアントアカウントを自動作成
  let targetAccountId = body.accountId ?? payload.accountId
  if (role === 'admin' && payload.role === 'superadmin' && !body.accountId) {
    // 新しいクライアントアカウントを作成
    const { createAccount } = await import('../../repositories/accounts-repo')
    const newAccount = await createAccount(c.env.DB, {
      name: `${body.email.split('@')[0]} のアカウント`,
      type: 'clinic',
    })
    targetAccountId = newAccount.id
  }

  // パスワードハッシュ化
  const { hashPassword } = await import('../../utils/password')
  const { generateId, nowIso } = await import('../../utils/id')
  const hash = await hashPassword(body.password)
  const id = generateId()

  await c.env.DB.prepare(`
    INSERT INTO account_memberships (id, account_id, user_id, email, role, status, password_hash, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)
  `).bind(id, targetAccountId, id, body.email, role, hash, nowIso()).run()

  return ok(c, {
    message: 'Member created successfully',
    member: { id, email: body.email, role, accountId: targetAccountId },
  })
})

// ===================================================================
// 管理者を停止/有効化
// PATCH /api/admin/dashboard/members/:id
// ===================================================================

dashboardRouter.patch('/members/:id', async (c) => {
  const payload = c.get('jwtPayload')
  const memberId = c.req.param('id')
  const body = await c.req.json<{ status?: string }>().catch(() => ({} as any))

  if (!body.status || !['active', 'suspended'].includes(body.status)) {
    return c.json({ success: false, error: 'Status must be active or suspended' }, 400)
  }

  // 自分自身は停止できない
  if (memberId === payload.sub) {
    return c.json({ success: false, error: 'Cannot change your own status' }, 400)
  }

  const target = await c.env.DB.prepare(
    'SELECT * FROM account_memberships WHERE id = ?1'
  ).bind(memberId).first<{ id: string; role: string; account_id: string }>()

  if (!target) return c.json({ success: false, error: 'Member not found' }, 404)

  // superadminのみsuperadmin以外を操作可能, adminはstaffのみ
  if (target.role === 'superadmin') {
    return c.json({ success: false, error: 'Cannot modify superadmin status' }, 403)
  }
  if (target.role === 'admin' && payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Only superadmin can modify admin status' }, 403)
  }

  const { nowIso } = await import('../../utils/id')
  await c.env.DB.prepare(
    'UPDATE account_memberships SET status = ?1, updated_at = ?2 WHERE id = ?3'
  ).bind(body.status, nowIso(), memberId).run()

  // ===================================================================
  // カスケード停止/復帰: admin停止時、従属ユーザーのBOTも停止する
  // admin復帰時は従属ユーザーのBOTも復帰する
  // ===================================================================
  if (target.role === 'admin') {
    const newBotEnabled = body.status === 'active' ? 1 : 0
    await c.env.DB.prepare(`
      UPDATE user_service_statuses
      SET bot_enabled = ?1, updated_at = ?2
      WHERE account_id = ?3
    `).bind(newBotEnabled, nowIso(), target.account_id).run()

    // account自体も停止/復帰させる
    const accountStatus = body.status === 'active' ? 'active' : 'suspended'
    await c.env.DB.prepare(`
      UPDATE accounts
      SET status = ?1, updated_at = ?2
      WHERE id = ?3
    `).bind(accountStatus, nowIso(), target.account_id).run()

    console.log(`[cascade] admin ${memberId} → ${body.status}: account ${target.account_id} and all users bot_enabled=${newBotEnabled}`)
  }

  return ok(c, { message: 'Status updated', id: memberId, status: body.status })
})

// ===================================================================
// BOT 一覧 (Superadmin)
// GET /api/admin/dashboard/bots
// ===================================================================

dashboardRouter.get('/bots', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const { results: bots } = await c.env.DB.prepare(`
    SELECT b.id, b.account_id, b.name, b.bot_key, b.type, b.is_active, b.current_version_id, b.created_at,
           a.name AS account_name,
           bv.version_number, bv.is_published, bv.system_prompt
    FROM bots b
    LEFT JOIN accounts a ON a.id = b.account_id
    LEFT JOIN bot_versions bv ON bv.id = b.current_version_id
    ORDER BY b.created_at DESC
  `).all<any>()

  return ok(c, { bots })
})

// ===================================================================
// BOT のバージョン一覧
// GET /api/admin/dashboard/bots/:botId/versions
// ===================================================================

dashboardRouter.get('/bots/:botId/versions', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const botId = c.req.param('botId')
  const { results: versions } = await c.env.DB.prepare(`
    SELECT id, bot_id, version_number, is_published, created_at,
           substr(system_prompt, 1, 200) AS prompt_preview
    FROM bot_versions
    WHERE bot_id = ?1
    ORDER BY version_number DESC
  `).bind(botId).all<any>()

  return ok(c, { versions })
})

// ===================================================================
// BOT バージョンの system_prompt 更新（新バージョン作成）
// POST /api/admin/dashboard/bots/:botId/versions
// ===================================================================

dashboardRouter.post('/bots/:botId/versions', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const botId = c.req.param('botId')
  const body = await c.req.json<{ systemPrompt: string; publish?: boolean }>().catch(() => ({} as any))
  if (!body.systemPrompt) {
    return c.json({ success: false, error: 'systemPrompt is required' }, 400)
  }

  const { generateId, nowIso } = await import('../../utils/id')

  // 最新バージョン番号を取得
  const latest = await c.env.DB.prepare(
    'SELECT MAX(version_number) as max_ver FROM bot_versions WHERE bot_id = ?1'
  ).bind(botId).first<{ max_ver: number | null }>()
  const newVersion = (latest?.max_ver ?? 0) + 1

  const versionId = generateId()
  const shouldPublish = body.publish !== false

  // 新バージョンを作成
  await c.env.DB.prepare(`
    INSERT INTO bot_versions (id, bot_id, version_number, system_prompt, is_published, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(versionId, botId, newVersion, body.systemPrompt, shouldPublish ? 1 : 0, nowIso()).run()

  if (shouldPublish) {
    // 旧バージョンの公開フラグを落とす
    await c.env.DB.prepare(
      'UPDATE bot_versions SET is_published = 0 WHERE bot_id = ?1 AND id != ?2'
    ).bind(botId, versionId).run()
    // BOT の current_version_id を更新
    await c.env.DB.prepare(
      'UPDATE bots SET current_version_id = ?1, updated_at = ?2 WHERE id = ?3'
    ).bind(versionId, nowIso(), botId).run()
  }

  return ok(c, { versionId, versionNumber: newVersion, published: shouldPublish })
})

// ===================================================================
// ナレッジベース一覧 (Superadmin)
// GET /api/admin/dashboard/knowledge-bases
// ===================================================================

dashboardRouter.get('/knowledge-bases', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const { results: bases } = await c.env.DB.prepare(`
    SELECT kb.id, kb.account_id, kb.name, kb.description, kb.is_active, kb.priority, kb.created_at,
           a.name AS account_name,
           (SELECT COUNT(*) FROM knowledge_documents kd WHERE kd.knowledge_base_id = kb.id AND kd.is_active = 1) AS doc_count
    FROM knowledge_bases kb
    LEFT JOIN accounts a ON a.id = kb.account_id
    ORDER BY kb.priority DESC, kb.created_at DESC
  `).all<any>()

  return ok(c, { bases })
})

// ===================================================================
// ナレッジドキュメント一覧
// GET /api/admin/dashboard/knowledge-bases/:kbId/documents
// ===================================================================

dashboardRouter.get('/knowledge-bases/:kbId/documents', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const kbId = c.req.param('kbId')
  const { results: documents } = await c.env.DB.prepare(`
    SELECT id, knowledge_base_id, title, content, source_url, is_active, priority, created_at, updated_at
    FROM knowledge_documents
    WHERE knowledge_base_id = ?1
    ORDER BY priority DESC, created_at DESC
  `).bind(kbId).all<any>()

  return ok(c, { documents })
})

// ===================================================================
// ナレッジドキュメント作成/更新
// POST /api/admin/dashboard/knowledge-bases/:kbId/documents
// ===================================================================

dashboardRouter.post('/knowledge-bases/:kbId/documents', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const kbId = c.req.param('kbId')
  const body = await c.req.json<{ title: string; content: string; sourceUrl?: string; priority?: number }>().catch(() => ({} as any))
  if (!body.title || !body.content) {
    return c.json({ success: false, error: 'title and content are required' }, 400)
  }

  const { createKnowledgeDocument } = await import('../../repositories/knowledge-repo')
  const doc = await createKnowledgeDocument(c.env.DB, {
    knowledgeBaseId: kbId,
    title: body.title,
    content: body.content,
    sourceUrl: body.sourceUrl,
    priority: body.priority,
  })

  return ok(c, { document: doc })
})

// ===================================================================
// BOT↔ナレッジ紐付け一覧
// GET /api/admin/dashboard/bot-knowledge-links
// ===================================================================

dashboardRouter.get('/bot-knowledge-links', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const { results: links } = await c.env.DB.prepare(`
    SELECT bkl.id, bkl.bot_id, bkl.knowledge_base_id, bkl.priority, bkl.created_at,
           b.name AS bot_name, kb.name AS kb_name
    FROM bot_knowledge_links bkl
    LEFT JOIN bots b ON b.id = bkl.bot_id
    LEFT JOIN knowledge_bases kb ON kb.id = bkl.knowledge_base_id
    ORDER BY bkl.priority DESC
  `).all<any>()

  return ok(c, { links })
})

export default dashboardRouter
