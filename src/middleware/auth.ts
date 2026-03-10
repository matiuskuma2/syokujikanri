/**
 * 認証・認可ミドルウェア
 */

import type { MiddlewareHandler } from 'hono'
import type { Bindings } from '../types/bindings'
import type { JwtPayload } from '../types/db'
import { verifyJwt, extractBearerToken } from '../utils/jwt'
import { unauthorized, forbidden } from '../utils/response'

type Variables = {
  jwtPayload: JwtPayload
}

export type HonoEnv = {
  Bindings: Bindings
  Variables: Variables
}

// JWT 認証ミドルウェア
export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'))
  if (!token) return unauthorized(c)

  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) return unauthorized(c, 'Invalid or expired token')

  c.set('jwtPayload', payload)
  await next()
}

// Superadmin 専用ミドルウェア
export const superadminOnly: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const payload = c.get('jwtPayload')
  if (!payload || payload.role !== 'superadmin') {
    return forbidden(c, 'Superadmin access required')
  }
  await next()
}

// Admin以上ミドルウェア
export const adminOnly: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const payload = c.get('jwtPayload')
  if (!payload || !['superadmin', 'admin'].includes(payload.role)) {
    return forbidden(c, 'Admin access required')
  }
  await next()
}
