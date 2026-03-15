/**
 * worker/src/handlers/follow-handler.ts
 * フォロー/アンフォローイベントハンドラ
 *
 * フォロー時:
 *   1. LINE プロフィール取得
 *   2. line_users upsert
 *   3. user_accounts 作成
 *   4. user_service_statuses 初期化
 *   5. conversation_runtime_state 作成
 *   6. push で歓迎メッセージ
 */

import type { WorkerEnv, LineEvent } from '../types'
import { createRuntimeState } from '../state/runtime-state'

const LINE_API = 'https://api.line.me/v2/bot'

/**
 * フォローイベントを処理
 */
export async function handleFollowEvent(
  event: LineEvent,
  lineUserId: string,
  env: WorkerEnv,
  clientAccountId: string
): Promise<void> {
  // 1. LINE プロフィール取得
  let displayName: string | null = null
  let pictureUrl: string | null = null
  let statusMessage: string | null = null

  try {
    const profileRes = await fetch(`${LINE_API}/profile/${lineUserId}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    })
    if (profileRes.ok) {
      const profile = await profileRes.json() as any
      displayName = profile.displayName ?? null
      pictureUrl = profile.pictureUrl ?? null
      statusMessage = profile.statusMessage ?? null
    }
  } catch (err) {
    console.warn(`[FollowHandler] profile fetch failed for ${lineUserId}:`, err)
  }

  // 2. line_channels の内部ID を取得
  const envChannelId = env.LINE_CHANNEL_ID ?? ''
  let lineChannelId = 'default'
  try {
    const channelRow = await env.DB.prepare(
      `SELECT id FROM line_channels WHERE channel_id = ?1 AND is_active = 1 LIMIT 1`
    ).bind(envChannelId).first<{ id: string }>()
    if (channelRow) {
      lineChannelId = channelRow.id
    } else {
      const fallbackRow = await env.DB.prepare(
        `SELECT id FROM line_channels WHERE is_active = 1 LIMIT 1`
      ).first<{ id: string }>()
      lineChannelId = fallbackRow?.id ?? 'default'
    }
  } catch (err) {
    console.error('[FollowHandler] channel resolution error:', err)
  }

  // 3. line_users upsert
  try {
    await env.DB.prepare(`
      INSERT INTO line_users (id, line_channel_id, line_user_id, display_name, picture_url, status_message, follow_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'following', datetime('now'), datetime('now'))
      ON CONFLICT(line_channel_id, line_user_id) DO UPDATE SET
        display_name = COALESCE(?4, display_name),
        picture_url = COALESCE(?5, picture_url),
        status_message = COALESCE(?6, status_message),
        follow_status = 'following',
        updated_at = datetime('now')
    `).bind(
      crypto.randomUUID(),
      lineChannelId,
      lineUserId,
      displayName,
      pictureUrl,
      statusMessage
    ).run()
  } catch (err) {
    console.error('[FollowHandler] line_users upsert error:', err)
  }

  // 4. user_accounts 作成
  let userAccountId: string | null = null
  try {
    // 既存チェック
    const existing = await env.DB.prepare(`
      SELECT ua.id FROM user_accounts ua
      JOIN line_users lu ON lu.id = ua.line_user_id
      WHERE lu.line_user_id = ?1 LIMIT 1
    `).bind(lineUserId).first<{ id: string }>()

    if (existing) {
      userAccountId = existing.id
    } else {
      // line_users.id を取得
      const lineUserRow = await env.DB.prepare(
        `SELECT id FROM line_users WHERE line_user_id = ?1 LIMIT 1`
      ).bind(lineUserId).first<{ id: string }>()

      if (lineUserRow) {
        userAccountId = crypto.randomUUID()
        await env.DB.prepare(`
          INSERT INTO user_accounts (id, account_id, line_user_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
          ON CONFLICT DO NOTHING
        `).bind(userAccountId, clientAccountId, lineUserRow.id).run()
      }
    }
  } catch (err) {
    console.error('[FollowHandler] user_accounts error:', err)
  }

  // 5. user_service_statuses 初期化
  if (userAccountId) {
    try {
      await env.DB.prepare(`
        INSERT INTO user_service_statuses (id, account_id, user_account_id, line_user_id, bot_enabled, record_enabled, consult_enabled, intake_completed, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 1, 1, 1, 0, datetime('now'), datetime('now'))
        ON CONFLICT(account_id, line_user_id) DO UPDATE SET
          bot_enabled = 1,
          updated_at = datetime('now')
      `).bind(crypto.randomUUID(), clientAccountId, userAccountId, lineUserId).run()
    } catch (err) {
      console.error('[FollowHandler] service_statuses error:', err)
    }

    // 6. conversation_runtime_state 作成
    try {
      await createRuntimeState(env.DB, {
        userAccountId,
        lineUserId,
        clientAccountId,
      })
    } catch (err) {
      console.error('[FollowHandler] runtime_state error:', err)
    }

    // 7. 会話スレッド作成
    try {
      await env.DB.prepare(`
        INSERT INTO conversation_threads (id, line_channel_id, line_user_id, account_id, user_account_id, current_mode, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'record', 'open', datetime('now'), datetime('now'))
        ON CONFLICT DO NOTHING
      `).bind(crypto.randomUUID(), lineChannelId, lineUserId, clientAccountId, userAccountId).run()
    } catch (err) {
      console.error('[FollowHandler] thread creation error:', err)
    }
  }

  // 8. push で歓迎メッセージ
  try {
    // 招待コード使用済みチェック
    const existingUsage = await env.DB.prepare(`
      SELECT ic.code FROM invite_code_usages icu
      JOIN invite_codes ic ON ic.id = icu.invite_code_id
      WHERE icu.line_user_id = ?1 LIMIT 1
    `).bind(lineUserId).first<{ code: string }>()

    const welcomeText = existingUsage
      ? `🎉 おかえりなさい！\n\n食事指導BOTに再登録されました。\n食事記録や体重記録、ダイエットの相談ができます。`
      : `🎉 友だち追加ありがとうございます！\n\n食事指導BOTへようこそ。\n\n📋 担当者から受け取った「招待コード」を送信してください。\n\n例: ABC-1234\n\n招待コードを入力すると、あなた専用のダイエットサポートが開始されます！`

    await fetch(`${LINE_API}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: 'text', text: welcomeText }],
      }),
    })
  } catch (err) {
    console.error('[FollowHandler] welcome push error:', err)
  }

  console.log(`[FollowHandler] follow processed: ${lineUserId} (${displayName})`)
}
