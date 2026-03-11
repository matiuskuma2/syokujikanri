/**
 * src/routes/line/auth.ts
 * LINE LIFF ID Token 検証 → システム JWT 発行
 *
 * 認証方式: LIFF ID Token（推奨・初期版）
 *   フロント: liff.getIDToken()  で取得した ID Token を送る
 *   バック:   LINE /oauth2/v2.1/verify で検証 → sub (LINE User ID) を取得
 *
 * ⚠️  Access Token との違い:
 *   - ID Token  : ユーザー認証用。/oauth2/v2.1/verify で検証。sub = LINE User ID
 *   - Access Token: API呼び出し用。別エンドポイントで検証。今回は使わない
 *
 * エンドポイント:
 *   POST /api/auth/line
 *     body: { idToken: string }   ← liff.getIDToken() の戻り値
 *     → { token: string, user: { userAccountId, lineUserId, displayName } }
 *
 * エラーコード:
 *   - MISSING_ID_TOKEN   : body に idToken がない
 *   - INVALID_LINE_TOKEN : LINE IDトークンが無効・期限切れ
 *   - USER_NOT_REGISTERED: システムに未登録（BOTを未フォロー）
 *   - ACCOUNT_NOT_FOUND  : user_accounts に紐付けなし
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { findLineUser, findUserAccount } from '../../repositories/line-users-repo'
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
  //    client_id = LINE_LIFF_CHANNEL_ID（LINE Login の Channel ID: 数字10桁）
  //    ※ LINE_CHANNEL_ID（内部DB UUID）とは別物
  // ------------------------------------------------------------------
  const lineUserId = await verifyLineIdToken(idToken, c.env.LINE_LIFF_CHANNEL_ID)
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
 *
 * LINE 側で iss / aud / exp / 署名の検証は実行済みだが、
 * defense-in-depth としてレスポンスのフィールドをクライアント側でも再検証する。
 *
 * @param idToken  liff.getIDToken() で取得した ID Token
 * @param liffChannelId  LINE Login の Channel ID（数字10桁）= LINE_LIFF_CHANNEL_ID
 * @returns LINE User ID (sub) または null（検証失敗時）
 *
 * @see https://developers.line.biz/en/reference/line-login/#verify-id-token
 */
async function verifyLineIdToken(
  idToken: string,
  liffChannelId: string
): Promise<string | null> {
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: liffChannelId,  // LINE Login の Channel ID（数字10桁）
      }),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.warn(`[LineAuth] Token verify failed: ${res.status} ${err}`)
      return null
    }

    const data = await res.json<{
      iss?: string       // 発行者 — "https://access.line.me" であること
      sub?: string       // LINE User ID
      aud?: string       // 対象者 — client_id (LINE_LIFF_CHANNEL_ID) と一致すること
      exp?: number       // 有効期限 (Unix timestamp)
      iat?: number       // 発行日時
      amr?: string[]     // 認証方法
    }>()

    // ---- defense-in-depth: レスポンスフィールド検証 ----

    // sub（LINE User ID）の存在確認
    if (!data.sub) {
      console.warn('[LineAuth] Missing sub in verified token')
      return null
    }

    // iss（発行者）の検証 — LINE公式ドキュメントで "https://access.line.me" と明記
    if (data.iss && data.iss !== 'https://access.line.me') {
      console.warn(`[LineAuth] Invalid iss: ${data.iss}`)
      return null
    }

    // aud（対象者）の検証 — リクエストで送った client_id と一致すること
    if (data.aud && data.aud !== liffChannelId) {
      console.warn(`[LineAuth] aud mismatch: expected=${liffChannelId} got=${data.aud}`)
      return null
    }

    // exp（有効期限）の検証 — 現在時刻より未来であること（5分のバッファ許容）
    if (data.exp) {
      const nowSec = Math.floor(Date.now() / 1000)
      if (data.exp < nowSec - 300) {
        console.warn(`[LineAuth] Token expired: exp=${data.exp} now=${nowSec}`)
        return null
      }
    }

    return data.sub
  } catch (err) {
    console.error('[LineAuth] verifyLineIdToken error:', err)
    return null
  }
}

export default lineAuthRouter
