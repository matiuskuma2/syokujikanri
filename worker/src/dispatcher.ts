/**
 * worker/src/dispatcher.ts
 * Queue メッセージのディスパッチャ
 *
 * 1. 冪等性チェック（incoming_events.processed_at）
 * 2. runtime_state ロード / 作成
 * 3. State Machine ルーティング → handler 実行
 * 4. state 更新 + incoming_events.processed_at 記録
 *
 * 全応答は push のみ（固定事項 #4）
 */

import type { WorkerEnv, QueueMessageBody, WebhookEventMessage, ImageAnalysisMessage, LineEvent, RuntimeState } from './types'
import { loadRuntimeState, createRuntimeState, updateRuntimeState } from './state/runtime-state'
import { sendPushText } from './send/push-sender'
import { handleTextMessage } from './handlers/text-handler'
import { handleImageMessage } from './handlers/image-handler'
import { handleFollowEvent } from './handlers/follow-handler'
import { handleConfirmAction } from './handlers/confirm-handler'

/**
 * Queue メッセージを処理する
 */
export async function processQueueMessage(
  body: unknown,
  env: WorkerEnv
): Promise<void> {
  const msg = body as QueueMessageBody

  if (msg.type === 'webhook_event') {
    await processWebhookEvent(msg, env)
  } else if (msg.type === 'image_analysis') {
    await processImageAnalysis(msg, env)
  } else {
    console.warn('[Dispatcher] unknown message type:', (msg as any).type)
  }
}

/**
 * Webhook イベントの処理
 */
async function processWebhookEvent(
  msg: WebhookEventMessage,
  env: WorkerEnv
): Promise<void> {
  const event = msg.event
  const lineUserId = event.source?.userId
  if (!lineUserId) {
    console.warn('[Dispatcher] no lineUserId in event')
    return
  }

  // メッセージIDを取得（冪等性キー）
  const messageId = event.message?.id ?? `evt_${event.type}_${event.timestamp}`

  // === 1. 冪等性チェック ===
  const existingEvent = await env.DB.prepare(
    `SELECT processed_at FROM incoming_events WHERE line_message_id = ?1`
  ).bind(messageId).first<{ processed_at: string | null }>()

  if (existingEvent?.processed_at) {
    console.log(`[Dispatcher] duplicate message ${messageId}, skipping`)
    return
  }

  // === 2. ユーザーアカウント解決 ===
  const userAccount = await env.DB.prepare(
    `SELECT ua.id, ua.account_id
     FROM user_accounts ua
     JOIN line_users lu ON lu.id = ua.line_user_id
     WHERE lu.line_user_id = ?1
     LIMIT 1`
  ).bind(lineUserId).first<{ id: string; account_id: string }>()

  const userAccountId = userAccount?.id
  const clientAccountId = userAccount?.account_id ?? msg.accountId

  // === 3. runtime_state ロード / 作成 ===
  let state: RuntimeState | null = null
  if (userAccountId) {
    state = await loadRuntimeState(env.DB, userAccountId)
    if (!state) {
      state = await createRuntimeState(env.DB, {
        userAccountId,
        lineUserId,
        clientAccountId,
      })
    }
  }

  // eventId を取得（incoming_events の id）
  const eventRow = await env.DB.prepare(
    `SELECT id FROM incoming_events WHERE line_message_id = ?1`
  ).bind(messageId).first<{ id: string }>()
  const eventId = eventRow?.id ?? null

  try {
    // === 4. イベントタイプ別ルーティング ===
    switch (event.type) {
      case 'follow':
        await handleFollowEvent(event, lineUserId, env, msg.accountId)
        break

      case 'unfollow':
        await handleUnfollow(lineUserId, env)
        break

      case 'message':
        if (!userAccountId || !state) {
          // ユーザー未登録の場合
          await handleUnregisteredUser(event, lineUserId, env, msg.accountId, eventId)
          break
        }

        if (event.message?.type === 'text') {
          await handleTextWithStateMachine(event, lineUserId, userAccountId, state, env, eventId)
        } else if (event.message?.type === 'image') {
          await handleImageMessage(event, lineUserId, userAccountId, state, env, eventId)
        } else {
          console.log(`[Dispatcher] unsupported message type: ${event.message?.type}`)
        }
        break

      default:
        console.log(`[Dispatcher] unhandled event type: ${event.type}`)
    }

    // === 5. incoming_events を処理済みに更新 ===
    if (eventId) {
      await env.DB.prepare(`
        UPDATE incoming_events
        SET processed_at = datetime('now'), process_result = 'success', user_account_id = ?2
        WHERE id = ?1
      `).bind(eventId, userAccountId ?? null).run()
    }

  } catch (err) {
    console.error(`[Dispatcher] processing error for ${messageId}:`, err)

    // incoming_events にエラーを記録
    if (eventId) {
      const errorDetail = err instanceof Error ? err.message : String(err)
      await env.DB.prepare(`
        UPDATE incoming_events
        SET process_result = 'failed', error_detail = ?2
        WHERE id = ?1
      `).bind(eventId, errorDetail).run()
    }

    // エラーをユーザーに通知（最善努力）
    try {
      if (userAccountId) {
        await sendPushText(
          env,
          lineUserId,
          userAccountId,
          '⚠️ 処理中にエラーが発生しました。もう一度送り直してください。',
          eventId
        )
      }
    } catch { /* push も失敗したらログのみ */ }

    throw err  // Queue retry のために re-throw
  }
}

/**
 * State Machine に基づくテキストメッセージ処理
 */
async function handleTextWithStateMachine(
  event: LineEvent,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  const text = event.message?.text?.trim() ?? ''
  if (!text) return

  // --- State Machine ルーティング ---
  // waiting_type に応じてハンドラーを選択

  if (state.waiting_type === 'image_confirm') {
    // S2: 画像確認待ち
    await handleConfirmAction(text, lineUserId, userAccountId, state, env, eventId)
    return
  }

  if (state.waiting_type === 'intake_step') {
    // S4: 問診途中 — TODO: Phase 2 で実装
    await handleTextMessage(text, lineUserId, userAccountId, state, env, eventId)
    return
  }

  if (state.waiting_type === 'clarification') {
    // S3: 追加質問中 — TODO: Phase 2 で実装
    await handleTextMessage(text, lineUserId, userAccountId, state, env, eventId)
    return
  }

  // S0/S1: アイドル状態 — テキストハンドラーに委譲
  await handleTextMessage(text, lineUserId, userAccountId, state, env, eventId)
}

/**
 * 未登録ユーザーの処理
 */
async function handleUnregisteredUser(
  event: LineEvent,
  lineUserId: string,
  env: WorkerEnv,
  clientAccountId: string,
  eventId: string | null
): Promise<void> {
  const text = event.message?.text?.trim() ?? ''

  // 招待コードチェック
  if (/^[A-Z]{3}-\d{4}$/i.test(text)) {
    // 招待コードの処理
    try {
      const code = text.toUpperCase()
      const codeRow = await env.DB.prepare(`
        SELECT ic.id, ic.account_id, ic.max_uses, ic.used_count, ic.expires_at
        FROM invite_codes ic
        WHERE ic.code = ?1 AND ic.is_active = 1
        LIMIT 1
      `).bind(code).first<{
        id: string
        account_id: string
        max_uses: number
        used_count: number
        expires_at: string | null
      }>()

      if (!codeRow) {
        await sendPushDirect(env, lineUserId, '❌ 無効な招待コードです。正しいコードを入力してください。')
        return
      }

      if (codeRow.used_count >= codeRow.max_uses) {
        await sendPushDirect(env, lineUserId, '❌ この招待コードは使用上限に達しています。')
        return
      }

      if (codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) {
        await sendPushDirect(env, lineUserId, '❌ この招待コードは期限切れです。')
        return
      }

      // ユーザー初期化 + コード使用記録は follow-handler の流れで処理
      // ここでは簡易的にPush通知
      await sendPushDirect(env, lineUserId, '✅ 招待コードを確認中です。少々お待ちください。')

    } catch (err) {
      console.error('[Dispatcher] invite code processing error:', err)
      await sendPushDirect(env, lineUserId, '⚠️ 招待コードの処理中にエラーが発生しました。もう一度お試しください。')
    }
    return
  }

  // 未登録ユーザーにはメッセージを送る
  await sendPushDirect(
    env,
    lineUserId,
    '📋 まだ登録が完了していません。\n担当者から受け取った「招待コード」を送信してください。\n\n例: ABC-1234'
  )
}

/**
 * アンフォロー処理
 */
async function handleUnfollow(lineUserId: string, env: WorkerEnv): Promise<void> {
  try {
    // line_users の follow_status を更新
    const lineChannelId = env.LINE_CHANNEL_ID
    await env.DB.prepare(`
      UPDATE line_users SET follow_status = 'blocked', updated_at = datetime('now')
      WHERE line_user_id = ?1
    `).bind(lineUserId).run()

    console.log(`[Dispatcher] unfollow processed for ${lineUserId}`)
  } catch (err) {
    console.error('[Dispatcher] unfollow error:', err)
  }
}

/**
 * 画像解析ジョブの処理
 */
async function processImageAnalysis(
  msg: ImageAnalysisMessage,
  env: WorkerEnv
): Promise<void> {
  // 既存の image-analysis ジョブロジックを移植
  // Phase 1 では最小限の実装
  console.log(`[Dispatcher] image_analysis job: ${msg.attachmentId}`)
  // TODO: Phase 2 で既存の jobs/image-analysis.ts のロジックを移植
}

/**
 * outbox を経由しない直接 push（未登録ユーザー向け等）
 */
async function sendPushDirect(
  env: WorkerEnv,
  lineUserId: string,
  text: string
): Promise<void> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: 'text', text }],
      }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[Dispatcher] direct push failed: ${res.status} ${errText}`)
    }
  } catch (err) {
    console.error('[Dispatcher] direct push error:', err)
  }
}
