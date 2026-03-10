/**
 * src/routes/line/auth.ts
 * LINE LIFF トークン検証 → JWT 発行
 *
 * エンドポイント:
 *   POST /api/auth/line
 *     body: { idToken: string }
 *     → { token: string, user: { userAccountId, lineUserId, displayName } }
 *
 * フロー:
 *   1. LINE ID Token を LINE Social API で検証（verify endpoint）
 *   2. line_users テーブルから line_user_id を引く
 *   3. user_accounts テーブルから userAccountId を取得
 *   4. JWT（role: 'user'）を発行して返す
 *
 * エラーコード:
 *   - INVALID_LINE_TOKEN  : LINE IDトークンが無効
 *   - USER_NOT_REGISTERED : システムに登録されていない（未フォロー）
 *   - ACCOUNT_NOT_FOUND   : アカウントが見つからない
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { findLineUser } from '../../repositories/line-users-repo'
import { findUserAccount } from '../../repositories/line-users-repo'
import { signJwt } from '../../utils/jwt'

type HonoEnv = { Bindings: Bindings }

const lineAuthRouter = new Hono<HonoEnv>()

// ===================================================================
// POST /api/auth/line  — LINE ID Token 検証 → JWT 発行
// ===================================================================

lineAuthRouter.post('/', async (c) => {
  const body = await c.req.json<{ idToken?: string }>().catch(() => ({}))
  const { idToken } = body

  if (!idToken) {
    return c.json(
      { success: false, error: 'MISSING_ID_TOKEN', message: 'idToken is required' },
      400
    )
  }

  // ------------------------------------------------------------------
  // 1. LINE ID Token を LINE Social API で検証
  // ------------------------------------------------------------------
  const lineUserId = await verifyLineIdToken(idToken, c.env.LINE_CHANNEL_ID)
  if (!lineUserId) {
    return c.json(
      { success: false, error: 'INVALID_LINE_TOKEN', message: 'LINE ID Token is invalid or expired' },
      401
    )
  }

  // ------------------------------------------------------------------
  // 2. line_users テーブルから存在確認
  // ------------------------------------------------------------------
  const clientAccountId = c.env.CLIENT_ACCOUNT_ID
  const lineChannelId = c.env.LINE_CHANNEL_ID

  const lineUser = await findLineUser(c.env.DB, lineChannelId, lineUserId)
  if (!lineUser) {
    return c.json(
      { success: false, error: 'USER_NOT_REGISTERED', message: 'User has not followed the bot yet' },
      403
    )
  }

  // ------------------------------------------------------------------
  // 3. user_accounts から userAccountId を取得
  // ------------------------------------------------------------------
  const userAccount = await findUserAccount(c.env.DB, lineUserId, clientAccountId)
  if (!userAccount) {
    return c.json(
      { success: false, error: 'ACCOUNT_NOT_FOUND', message: 'User account not found' },
      403
    )
  }

  // ------------------------------------------------------------------
  // 4. JWT 発行
  // ------------------------------------------------------------------
  const token = await signJwt(
    {
      sub: userAccount.id,
      role: 'user',
      accountId: clientAccountId,
    },
    c.env.JWT_SECRET,
    c.env.JWT_EXPIRES_IN ?? '7d'
  )

  return c.json({
    success: true,
    data: {
      token,
      user: {
        userAccountId: userAccount.id,
        lineUserId,
        displayName: lineUser.display_name ?? null,
        pictureUrl: lineUser.picture_url ?? null,
      },
    },
  })
})

// ===================================================================
// ユーティリティ: LINE ID Token 検証
// ===================================================================

/**
 * LINE Social API の /oauth2/v2.1/verify エンドポイントで ID Token を検証する
 * 成功時は LINE User ID を返す、失敗時は null
 *
 * @see https://developers.line.biz/ja/reference/line-login/#verify-id-token
 */
async function verifyLineIdToken(
  idToken: string,
  channelId: string
): Promise<string | null> {
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: channelId,
      }),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.warn(`[LineAuth] Token verify failed: ${res.status} ${err}`)
      return null
    }

    const data = await res.json<{
      sub?: string      // LINE User ID
      exp?: number
      iat?: number
      amr?: string[]
    }>()

    if (!data.sub) return null

    return data.sub
  } catch (err) {
    console.error('[LineAuth] verifyLineIdToken error:', err)
    return null
  }
}

export default lineAuthRouter
