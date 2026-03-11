/**
 * src/routes/admin/auth.ts
 * 管理者認証 API（新規登録・ログイン・パスワード変更・招待）
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import {
  findMembershipByEmail,
  findMembershipById,
  createMembership,
  updateMembershipPassword,
  setPasswordResetToken,
  findMembershipByResetToken,
} from '../../repositories/accounts-repo'
import { signJwt, verifyJwt, extractBearerToken } from '../../utils/jwt'
import { hashPassword, verifyPassword, generateSecureToken } from '../../utils/password'
import { ok, badRequest, unauthorized, notFound, serverError } from '../../utils/response'
import { sendEmail, buildInviteEmail, buildPasswordResetEmail, buildWelcomeAdminEmail } from '../../services/email/sendgrid'
import { generateId, nowIso } from '../../utils/id'

type HonoEnv = { Bindings: Bindings }
const authRouter = new Hono<HonoEnv>()

// ───────────────────────────────────────────────
// POST /api/admin/auth/login
// ───────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>().catch(() => ({}))
  const { email, password } = body as { email?: string; password?: string }

  if (!email || !password) return badRequest(c, 'Email and password are required')

  const membership = await findMembershipByEmail(c.env.DB, email)
  if (!membership) return unauthorized(c, 'Invalid credentials')

  // password_hash が未設定（旧データ or 開発用デフォルト）
  if (!membership.password_hash) {
    // 開発環境のみ admin123 を許可
    if (c.env.APP_ENV !== 'production' && password === 'admin123') {
      // 初回ログイン時に password_hash をセット
      const hash = await hashPassword(password)
      await updateMembershipPassword(c.env.DB, membership.id, hash)
    } else {
      return unauthorized(c, 'Invalid credentials')
    }
  } else {
    const ok2 = await verifyPassword(password, membership.password_hash)
    if (!ok2) return unauthorized(c, 'Invalid credentials')
  }

  // last_login_at 更新
  await c.env.DB.prepare(
    'UPDATE account_memberships SET last_login_at = ?1 WHERE id = ?2'
  ).bind(nowIso(), membership.id).run()

  const token = await signJwt(
    { sub: membership.id, accountId: membership.account_id, role: membership.role === 'superadmin' ? 'superadmin' : 'admin' },
    c.env.JWT_SECRET,
    c.env.JWT_EXPIRES_IN || '7d'
  )

  return ok(c, {
    token,
    admin: { id: membership.id, email: membership.email, role: membership.role, accountId: membership.account_id },
  })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/register  （初回セットアップ用）
// ───────────────────────────────────────────────
authRouter.post('/register', async (c) => {
  const body = await c.req.json<{ email: string; password: string; name?: string; setupKey?: string }>().catch(() => ({}))
  const { email, password, name, setupKey } = body as any

  if (!email || !password) return badRequest(c, 'Email and password are required')
  if (password.length < 8) return badRequest(c, 'Password must be at least 8 characters')

  // 既存チェック
  const existing = await findMembershipByEmail(c.env.DB, email)
  if (existing && existing.password_hash) return badRequest(c, 'Email already registered')

  const appUrl = c.env.APP_URL ?? 'https://diet-bot.pages.dev'

  if (existing) {
    // password_hash がない既存レコードにパスワードをセット
    const hash = await hashPassword(password)
    await updateMembershipPassword(c.env.DB, existing.id, hash)

    // ウェルカムメール
    if (c.env.SENDGRID_API_KEY) {
      await sendEmail(
        buildWelcomeAdminEmail({ email, name: name ?? email, loginUrl: `${appUrl}/admin` }),
        c.env.SENDGRID_API_KEY, c.env.SENDGRID_FROM_EMAIL ?? 'noreply@diet-bot.pages.dev',
        c.env.SENDGRID_FROM_NAME ?? 'diet-bot'
      )
    }
    return ok(c, { message: 'Password set successfully' })
  }

  // 新規作成（superadminが存在しない場合のみ初回登録を許可）
  const isFirstAdmin = await isNoAdminYet(c.env.DB)
  if (!isFirstAdmin) return unauthorized(c, 'Registration requires an invitation')

  const hash = await hashPassword(password)
  const id = generateId()
  const systemAccountId = 'acc_system_00000000000000000000000000000001'

  await createMembership(c.env.DB, {
    id, accountId: systemAccountId, email,
    role: 'superadmin', passwordHash: hash,
  })

  return ok(c, { message: 'Admin account created' })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/change-password  （ログイン済み）
// ───────────────────────────────────────────────
authRouter.post('/change-password', async (c) => {
  // Authorization ヘッダーから JWT を直接検証
  const token = extractBearerToken(c.req.header('Authorization'))
  if (!token) return unauthorized(c, 'Unauthorized')
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload?.sub) return unauthorized(c, 'Unauthorized')

  const body = await c.req.json<{ currentPassword: string; newPassword: string }>().catch(() => ({}))
  const { currentPassword, newPassword } = body as any

  if (!currentPassword || !newPassword) return badRequest(c, 'currentPassword and newPassword are required')
  if (newPassword.length < 8) return badRequest(c, 'New password must be at least 8 characters')

  const membership = await findMembershipById(c.env.DB, payload.sub)
  if (!membership) return notFound(c, 'Admin not found')

  // 現在のパスワード確認
  if (membership.password_hash) {
    const valid = await verifyPassword(currentPassword, membership.password_hash)
    if (!valid) return unauthorized(c, 'Current password is incorrect')
  } else if (currentPassword !== 'admin123') {
    return unauthorized(c, 'Current password is incorrect')
  }

  const hash = await hashPassword(newPassword)
  await updateMembershipPassword(c.env.DB, membership.id, hash)

  return ok(c, { message: 'Password changed successfully' })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/forgot-password  （メール送信）
// ───────────────────────────────────────────────
authRouter.post('/forgot-password', async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => ({}))
  const { email } = body as any
  if (!email) return badRequest(c, 'Email is required')

  const membership = await findMembershipByEmail(c.env.DB, email)
  // 存在しなくても同じレスポンス（列挙攻撃対策）
  if (membership && c.env.SENDGRID_API_KEY) {
    const token = generateSecureToken()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1時間
    await setPasswordResetToken(c.env.DB, membership.id, token, expiresAt)

    const appUrl = c.env.APP_URL ?? 'https://diet-bot.pages.dev'
    const resetUrl = `${appUrl}/admin/reset-password?token=${token}`

    await sendEmail(
      buildPasswordResetEmail({ email, resetUrl, expiresMinutes: 60 }),
      c.env.SENDGRID_API_KEY, c.env.SENDGRID_FROM_EMAIL ?? 'noreply@diet-bot.pages.dev',
      c.env.SENDGRID_FROM_NAME ?? 'diet-bot'
    )
  }

  return ok(c, { message: 'If that email exists, a reset link has been sent' })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/reset-password
// ───────────────────────────────────────────────
authRouter.post('/reset-password', async (c) => {
  const body = await c.req.json<{ token: string; newPassword: string }>().catch(() => ({}))
  const { token, newPassword } = body as any

  if (!token || !newPassword) return badRequest(c, 'Token and newPassword are required')
  if (newPassword.length < 8) return badRequest(c, 'Password must be at least 8 characters')

  const membership = await findMembershipByResetToken(c.env.DB, token)
  if (!membership) return badRequest(c, 'Invalid or expired token')

  const hash = await hashPassword(newPassword)
  await updateMembershipPassword(c.env.DB, membership.id, hash)
  // トークンをクリア
  await c.env.DB.prepare(
    'UPDATE account_memberships SET password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = ?1'
  ).bind(membership.id).run()

  return ok(c, { message: 'Password reset successfully' })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/invite  （管理者が別の管理者を招待）
// ───────────────────────────────────────────────
authRouter.post('/invite', async (c) => {
  const authToken = extractBearerToken(c.req.header('Authorization'))
  if (!authToken) return unauthorized(c, 'Unauthorized')
  const payload = await verifyJwt(authToken, c.env.JWT_SECRET)
  if (!payload?.sub) return unauthorized(c, 'Unauthorized')

  const body = await c.req.json<{ email: string; role?: string }>().catch(() => ({}))
  const { email, role = 'staff' } = body as any

  if (!email) return badRequest(c, 'Email is required')
  if (!['admin', 'staff'].includes(role)) return badRequest(c, 'Role must be admin or staff')

  const inviter = await findMembershipById(c.env.DB, payload.sub)
  if (!inviter) return notFound(c, 'Inviter not found')

  // 既存確認
  const existing = await findMembershipByEmail(c.env.DB, email)
  if (existing) return badRequest(c, 'Email already registered')

  const token = generateSecureToken()
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() // 48時間

  // invite_tokens テーブルに保存
  await c.env.DB.prepare(`
    INSERT INTO invite_tokens (id, account_id, email, role, token, expires_at, invited_by, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(generateId(), inviter.account_id, email, role, token, expiresAt, payload.sub, nowIso()).run()

  const appUrl = c.env.APP_URL ?? 'https://diet-bot.pages.dev'
  const inviteUrl = `${appUrl}/admin/accept-invite?token=${token}`

  // メール送信
  if (c.env.SENDGRID_API_KEY) {
    await sendEmail(
      buildInviteEmail({
        inviteeEmail: email,
        inviterName: inviter.email,
        accountName: 'diet-bot',
        role,
        inviteUrl,
        expiresHours: 48,
      }),
      c.env.SENDGRID_API_KEY, c.env.SENDGRID_FROM_EMAIL ?? 'noreply@diet-bot.pages.dev',
      c.env.SENDGRID_FROM_NAME ?? 'diet-bot'
    )
  }

  return ok(c, { message: 'Invitation sent', inviteUrl })
})

// ───────────────────────────────────────────────
// POST /api/admin/auth/accept-invite
// ───────────────────────────────────────────────
authRouter.post('/accept-invite', async (c) => {
  const body = await c.req.json<{ token: string; password: string; name?: string }>().catch(() => ({}))
  const { token, password, name } = body as any

  if (!token || !password) return badRequest(c, 'Token and password are required')
  if (password.length < 8) return badRequest(c, 'Password must be at least 8 characters')

  // invite_tokens確認
  const invite = await c.env.DB.prepare(`
    SELECT * FROM invite_tokens WHERE token = ?1 AND used_at IS NULL AND expires_at > datetime('now')
  `).bind(token).first<any>()

  if (!invite) return badRequest(c, 'Invalid or expired invitation')

  const hash = await hashPassword(password)
  const membershipId = generateId()

  await createMembership(c.env.DB, {
    id: membershipId,
    accountId: invite.account_id,
    email: invite.email,
    role: invite.role,
    passwordHash: hash,
  })

  // トークンを使用済みにする
  await c.env.DB.prepare(
    'UPDATE invite_tokens SET used_at = ?1 WHERE id = ?2'
  ).bind(nowIso(), invite.id).run()

  const appUrl = c.env.APP_URL ?? 'https://diet-bot.pages.dev'
  if (c.env.SENDGRID_API_KEY) {
    await sendEmail(
      buildWelcomeAdminEmail({ email: invite.email, name: name ?? invite.email, loginUrl: `${appUrl}/admin` }),
      c.env.SENDGRID_API_KEY, c.env.SENDGRID_FROM_EMAIL ?? 'noreply@diet-bot.pages.dev',
      c.env.SENDGRID_FROM_NAME ?? 'diet-bot'
    )
  }

  return ok(c, { message: 'Account created successfully. You can now log in.' })
})

// ───────────────────────────────────────────────
// GET /api/admin/auth/me
// ───────────────────────────────────────────────
authRouter.get('/me', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'))
  if (!token) return unauthorized(c, 'Unauthorized')
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload?.sub) return unauthorized(c, 'Unauthorized')
  const membership = await findMembershipById(c.env.DB, payload.sub)
  if (!membership) return notFound(c, 'Admin not found')
  return ok(c, {
    id: membership.id,
    email: membership.email,
    role: membership.role,
    accountId: membership.account_id,
    lastLoginAt: membership.last_login_at ?? null,
  })
})

// ───────────────────────────────────────────────
// ヘルパー
// ───────────────────────────────────────────────
async function isNoAdminYet(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT COUNT(*) as cnt FROM account_memberships WHERE role = 'superadmin'"
  ).first<{ cnt: number }>()
  return (row?.cnt ?? 0) === 0
}

export default authRouter
