/**
 * Admin 招待コード API
 * /api/admin/invite-codes
 *
 * admin が招待コードを発行し、顧客に配布する
 * 顧客が LINE で招待コードを送信すると、admin の account に紐付けられる
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { ok } from '../../utils/response'
import {
  createInviteCode,
  listInviteCodesByAccount,
  listAllInviteCodes,
  revokeInviteCode,
  findInviteCodeById,
} from '../../repositories/invite-codes-repo'

const inviteCodesRouter = new Hono<HonoEnv>()

// ===================================================================
// 招待コード一覧
// GET /api/admin/invite-codes
// superadmin: 全コード, admin: 自分のアカウントのコード
// ===================================================================

inviteCodesRouter.get('/', async (c) => {
  const payload = c.get('jwtPayload')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  let codes
  if (payload.role === 'superadmin') {
    codes = await listAllInviteCodes(c.env.DB, limit, offset)
  } else {
    codes = await listInviteCodesByAccount(c.env.DB, payload.accountId, limit, offset)
  }

  return ok(c, { codes })
})

// ===================================================================
// 招待コード発行
// POST /api/admin/invite-codes
// body: { label?, maxUses?, expiresInDays? }
// ===================================================================

inviteCodesRouter.post('/', async (c) => {
  const payload = c.get('jwtPayload')

  // staff は作成不可
  if (payload.role === 'staff') {
    return c.json({ success: false, error: 'Staff cannot create invite codes' }, 403)
  }

  const body = await c.req.json<{
    label?: string
    maxUses?: number
    expiresInDays?: number
  }>().catch(() => ({} as any))

  // 有効期限の計算
  let expiresAt: string | null = null
  if (body.expiresInDays && body.expiresInDays > 0) {
    const d = new Date()
    d.setDate(d.getDate() + body.expiresInDays)
    expiresAt = d.toISOString()
  }

  const code = await createInviteCode(c.env.DB, {
    accountId: payload.accountId,
    createdBy: payload.sub,
    label: body.label ?? null,
    maxUses: body.maxUses ?? 1,
    expiresAt,
  })

  return ok(c, {
    message: '招待コードを発行しました',
    code: {
      id: code.id,
      code: code.code,
      label: code.label,
      maxUses: code.max_uses,
      useCount: code.use_count,
      status: code.status,
      expiresAt: code.expires_at,
      createdAt: code.created_at,
    },
  })
})

// ===================================================================
// 招待コード無効化
// PATCH /api/admin/invite-codes/:id/revoke
// ===================================================================

inviteCodesRouter.patch('/:id/revoke', async (c) => {
  const payload = c.get('jwtPayload')
  const codeId = c.req.param('id')

  // staff は操作不可
  if (payload.role === 'staff') {
    return c.json({ success: false, error: 'Staff cannot revoke invite codes' }, 403)
  }

  const existing = await findInviteCodeById(c.env.DB, codeId)
  if (!existing) {
    return c.json({ success: false, error: 'Invite code not found' }, 404)
  }

  // admin は自分のアカウントのコードのみ操作可能
  if (payload.role !== 'superadmin' && existing.account_id !== payload.accountId) {
    return c.json({ success: false, error: 'Cannot revoke codes from other accounts' }, 403)
  }

  await revokeInviteCode(c.env.DB, codeId)

  return ok(c, { message: '招待コードを無効化しました', id: codeId })
})

export default inviteCodesRouter
