/**
 * worker/src/send/push-sender.ts
 * Outbox パターンによる LINE push 送信
 *
 * 1. outbox_messages にレコードを INSERT (status='pending')
 * 2. LINE Push API で送信
 * 3. 成功 → status='sent'、失敗 → status='failed'
 *
 * Consumer Worker からの全応答はこのモジュールを経由する。
 * reply は一切使わない（固定事項 #4）。
 */

import type { WorkerEnv } from '../types'

const LINE_API = 'https://api.line.me/v2/bot'

type QuickReplyItem = {
  label: string
  text: string
}

/**
 * outbox にレコードを書き込み、即座に push 送信を試みる
 */
export async function sendPushText(
  env: WorkerEnv,
  lineUserId: string,
  userAccountId: string,
  text: string,
  sourceEventId: string | null,
  quickReplies?: QuickReplyItem[]
): Promise<{ outboxId: string; sent: boolean }> {
  const outboxId = crypto.randomUUID()
  const messageJson = JSON.stringify({ text })
  const quickReplyJson = quickReplies
    ? JSON.stringify({
        items: quickReplies.slice(0, 13).map(item => ({
          type: 'action',
          action: {
            type: 'message',
            label: item.label.substring(0, 20),
            text: item.text,
          },
        })),
      })
    : null

  // Step 1: outbox_messages に INSERT
  await env.DB.prepare(`
    INSERT INTO outbox_messages
      (id, user_account_id, line_user_id, message_type, message_json, quick_reply_json, status, attempts, source_event_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, datetime('now'))
  `).bind(
    outboxId,
    userAccountId,
    lineUserId,
    quickReplies ? 'quick_reply' : 'text',
    messageJson,
    quickReplyJson,
    sourceEventId
  ).run()

  // Step 2: LINE Push API で送信
  try {
    const messages: any[] = [{
      type: 'text',
      text,
      ...(quickReplies ? {
        quickReply: {
          items: quickReplies.slice(0, 13).map(item => ({
            type: 'action',
            action: {
              type: 'message',
              label: item.label.substring(0, 20),
              text: item.text,
            },
          })),
        },
      } : {}),
    }]

    const res = await fetch(`${LINE_API}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: lineUserId, messages }),
    })

    if (res.ok) {
      // Step 3a: 成功
      await env.DB.prepare(`
        UPDATE outbox_messages
        SET status = 'sent', attempts = attempts + 1, last_attempt_at = datetime('now')
        WHERE id = ?1
      `).bind(outboxId).run()

      console.log(`[PushSender] sent outbox=${outboxId} to ${lineUserId.substring(0, 8)}...`)
      return { outboxId, sent: true }
    } else {
      const errText = await res.text().catch(() => '')
      throw new Error(`LINE push failed: ${res.status} ${errText}`)
    }
  } catch (err) {
    // Step 3b: 失敗
    const errorDetail = err instanceof Error ? err.message : String(err)
    await env.DB.prepare(`
      UPDATE outbox_messages
      SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_detail = ?2
      WHERE id = ?1
    `).bind(outboxId, errorDetail).run()

    console.error(`[PushSender] failed outbox=${outboxId}:`, errorDetail)
    return { outboxId, sent: false }
  }
}

/**
 * 失敗した outbox メッセージを再送する
 */
export async function retryFailedOutbox(
  env: WorkerEnv,
  outboxId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT * FROM outbox_messages WHERE id = ?1 AND status = 'failed'`
  ).bind(outboxId).first<{
    line_user_id: string
    message_json: string
    quick_reply_json: string | null
  }>()

  if (!row) return false

  const parsed = JSON.parse(row.message_json)
  const messages: any[] = [{
    type: 'text',
    text: parsed.text,
    ...(row.quick_reply_json ? { quickReply: JSON.parse(row.quick_reply_json) } : {}),
  }]

  try {
    const res = await fetch(`${LINE_API}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: row.line_user_id, messages }),
    })

    if (res.ok) {
      await env.DB.prepare(`
        UPDATE outbox_messages
        SET status = 'sent', attempts = attempts + 1, last_attempt_at = datetime('now')
        WHERE id = ?1
      `).bind(outboxId).run()
      return true
    } else {
      const errText = await res.text().catch(() => '')
      await env.DB.prepare(`
        UPDATE outbox_messages
        SET attempts = attempts + 1, last_attempt_at = datetime('now'), error_detail = ?2
        WHERE id = ?1
      `).bind(outboxId, `LINE push retry failed: ${res.status} ${errText}`).run()
      return false
    }
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err)
    await env.DB.prepare(`
      UPDATE outbox_messages
      SET attempts = attempts + 1, last_attempt_at = datetime('now'), error_detail = ?2
      WHERE id = ?1
    `).bind(outboxId, errorDetail).run()
    return false
  }
}
