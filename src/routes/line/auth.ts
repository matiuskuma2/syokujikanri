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
import { fetchWithTimeout, TIMEOUT } from '../../utils/fetch-with-timeout'

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
  //    LINE_CHANNEL_ID は LINE API の Channel ID (数字10桁) の場合と
  //    内部 UUID (ch_xxx) の場合があるため、line_channels テーブルで
  //    内部IDを解決してから line_users を検索する
  // ------------------------------------------------------------------
  const clientAccountId = c.env.CLIENT_ACCOUNT_ID
  const envChannelId = c.env.LINE_CHANNEL_ID ?? ''

  // line_channels テーブルから内部IDを解決（webhook.ts と同じロジック）
  let lineChannelId = envChannelId
  try {
    // まず channel_id (LINE API の数字10桁) で検索
    const channelRow = await c.env.DB.prepare(
      `SELECT id FROM line_channels WHERE channel_id = ?1 AND is_active = 1 LIMIT 1`
    ).bind(envChannelId).first<{ id: string }>()
    if (channelRow) {
      lineChannelId = channelRow.id
    } else {
      // 内部 ID として直接使えるか確認
      const directRow = await c.env.DB.prepare(
        `SELECT id FROM line_channels WHERE id = ?1 AND is_active = 1 LIMIT 1`
      ).bind(envChannelId).first<{ id: string }>()
      if (directRow) {
        lineChannelId = directRow.id
      } else {
        // フォールバック: 最初のアクティブチャンネル
        const fallbackRow = await c.env.DB.prepare(
          `SELECT id FROM line_channels WHERE is_active = 1 LIMIT 1`
        ).first<{ id: string }>()
        lineChannelId = fallbackRow?.id ?? envChannelId
      }
    }
  } catch (err) {
    console.error('[LineAuth] Failed to resolve lineChannelId:', err)
    // エラー時は env 値をそのまま使う
  }

  // まず解決した内部IDで検索
  let lineUser = await findLineUser(c.env.DB, lineChannelId, lineUserId)

  // 見つからない場合: lineUserId のみで検索（channel_id 不一致でも救済）
  if (!lineUser) {
    const fallbackRow = await c.env.DB.prepare(
      `SELECT * FROM line_users WHERE line_user_id = ?1 AND follow_status = 'following' LIMIT 1`
    ).bind(lineUserId).first<any>()
    if (fallbackRow) {
      lineUser = fallbackRow
      console.log(`[LineAuth] lineUser found by lineUserId fallback: ${lineUserId} (channel_id mismatch recovered)`)
    }
  }

  if (!lineUser) {
    return c.json(
      { success: false, error: 'USER_NOT_REGISTERED', message: 'User has not followed the bot yet' },
      403
    )
  }

  // ------------------------------------------------------------------
  // 3. user_accounts から userAccountId を取得
  //    user_account が見つからない場合でも、line_users があれば
  //    自動的にアカウントを作成して LIFF アクセスを許可する
  // ------------------------------------------------------------------
  let userAccount = await findUserAccount(c.env.DB, lineUserId, clientAccountId)
  if (!userAccount) {
    // line_users は存在するが user_accounts がない場合、自動作成を試みる
    try {
      const { ensureUserAccount } = await import('../../repositories/line-users-repo')
      userAccount = await ensureUserAccount(c.env.DB, lineUserId, clientAccountId)
    } catch (err) {
      console.error('[LineAuth] ensureUserAccount fallback failed:', err)
    }
    if (!userAccount) {
      return c.json(
        { success: false, error: 'ACCOUNT_NOT_FOUND', message: 'User account not found' },
        403
      )
    }
  }

  // ------------------------------------------------------------------
  // 3.5 サービスステータス取得（問診完了状態の判定用）
  // ------------------------------------------------------------------
  const { findUserServiceStatus } = await import('../../repositories/subscriptions-repo')
  const serviceStatus = await findUserServiceStatus(c.env.DB, clientAccountId, lineUserId)

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
        intakeCompleted: serviceStatus?.intake_completed === 1,
        botEnabled: serviceStatus?.bot_enabled === 1,
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
    const res = await fetchWithTimeout(
      'https://api.line.me/oauth2/v2.1/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          id_token: idToken,
          client_id: liffChannelId,  // LINE Login の Channel ID（数字10桁）
        }),
      },
      TIMEOUT.LINE_VERIFY
    )

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
