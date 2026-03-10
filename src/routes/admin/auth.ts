/**
 * Admin 認証 API
 * /api/admin/auth
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { signJwt } from '../../utils/jwt'
import { ok, badRequest, unauthorized } from '../../utils/response'

type HonoEnv = { Bindings: Bindings }

const authRouter = new Hono<HonoEnv>()

// 管理者ログイン
authRouter.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string; account_id?: string }>()

  if (!body.email || !body.password) {
    return badRequest(c, 'Email and password are required')
  }

  // superadmin 確認（環境変数ベースの簡易認証）
  // TODO: Phase 2でDB管理者テーブルに移行
  const adminEmail = c.env.APP_ENV === 'development' ? 'admin@diet-bot.local' : null
  const adminPassword = c.env.APP_ENV === 'development' ? 'admin123' : null

  if (!adminEmail || body.email !== adminEmail || body.password !== adminPassword) {
    return unauthorized(c, 'Invalid credentials')
  }

  const token = await signJwt({
    sub: 'superadmin-001',
    account_id: body.account_id || 'system',
    role: 'superadmin',
    type: 'admin'
  }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d')

  return ok(c, {
    token,
    user: {
      id: 'superadmin-001',
      email: adminEmail,
      role: 'superadmin'
    }
  })
})

// トークン確認
authRouter.get('/me', async (c) => {
  // このルートはauthMiddlewareの後に呼ばれる想定
  return ok(c, { message: 'Token is valid' })
})

export default authRouter
