/**
 * Admin 認証 API
 * /api/admin/auth
 *
 * 参照: docs/API.md §Admin API > 認証
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { findMembershipByEmail } from '../../repositories/accounts-repo'
import { signJwt } from '../../utils/jwt'
import { ok, badRequest, unauthorized } from '../../utils/response'

type HonoEnv = { Bindings: Bindings }

const authRouter = new Hono<HonoEnv>()

// ===================================================================
// 管理者ログイン
// POST /api/admin/auth/login
// ===================================================================

authRouter.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>()

  if (!body.email || !body.password) {
    return badRequest(c, 'Email and password are required')
  }

  // Phase 1: 開発環境用の簡易認証（環境変数ベース）
  // TODO: Phase 2 で account_memberships テーブルによるDB管理に移行
  if (c.env.APP_ENV === 'development' || c.env.APP_ENV === 'local') {
    const devEmail = 'admin@diet-bot.local'
    const devPassword = 'admin123'

    if (body.email !== devEmail || body.password !== devPassword) {
      return unauthorized(c, 'Invalid credentials')
    }

    const token = await signJwt(
      {
        sub: 'superadmin-001',
        accountId: 'system',
        role: 'superadmin',
      },
      c.env.JWT_SECRET,
      c.env.JWT_EXPIRES_IN || '7d'
    )

    return ok(c, {
      token,
      admin: {
        id: 'superadmin-001',
        email: devEmail,
        role: 'superadmin',
        accountId: 'system',
      },
    })
  }

  // 本番: account_memberships からメールアドレスで検索
  // NOTE: パスワード認証は別途 password_hash カラム追加後に実装
  const membership = await findMembershipByEmail(c.env.DB, body.email)
  if (!membership) {
    return unauthorized(c, 'Invalid credentials')
  }

  const token = await signJwt(
    {
      sub: membership.id,
      accountId: membership.account_id,
      role: membership.role === 'superadmin' ? 'superadmin' : 'admin',
    },
    c.env.JWT_SECRET,
    c.env.JWT_EXPIRES_IN || '7d'
  )

  return ok(c, {
    token,
    admin: {
      id: membership.id,
      email: membership.email,
      role: membership.role,
      accountId: membership.account_id,
    },
  })
})

// ===================================================================
// 自分の情報取得
// GET /api/me（authMiddleware 後に呼ばれる）
// ===================================================================

authRouter.get('/me', async (c) => {
  return ok(c, { message: 'Token is valid' })
})

export default authRouter
