/**
 * src/routes/line/webhook.ts
 * LINE Webhook エンドポイント（V2: Webhook 最小化）
 *
 * 責務（3つだけ）:
 *   1. X-Line-Signature 署名検証
 *   2. incoming_events テーブルに raw event を保存（冪等性キー: line_message_id）
 *   3. LINE_EVENTS_QUEUE に enqueue
 *   4. 即座に 200 OK を返却
 *
 * ★ Webhook は以下を一切やらない:
 *   - AI 呼び出し
 *   - reply / push 送信
 *   - 状態変更
 *   - 複雑な分岐
 *
 * 全ての実質的な処理は Consumer Worker (diet-bot-worker) が行う。
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import type { LineWebhookEvent } from '../../types/bindings'
import { verifyLineSignature } from '../../services/line/verify-signature'

const webhookRouter = new Hono<{ Bindings: Bindings }>()

webhookRouter.post('/', async (c) => {
  const startTime = Date.now()

  // ------------------------------------------------------------------
  // 1. raw body 取得 + 署名検証
  // ------------------------------------------------------------------
  const rawBody = await c.req.text()
  const signature = c.req.header('x-line-signature') ?? ''
  const isValid = await verifyLineSignature(rawBody, signature, c.env.LINE_CHANNEL_SECRET)

  if (!isValid) {
    console.warn('[Webhook] Invalid LINE signature')
    return c.json({ error: 'Invalid signature' }, 401)
  }

  // ------------------------------------------------------------------
  // 2. JSON パース
  // ------------------------------------------------------------------
  let body: { destination?: string; events?: LineWebhookEvent[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    console.error('[Webhook] JSON parse error')
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const events = body.events ?? []

  if (events.length === 0) {
    return c.json({ ok: true })
  }

  // ------------------------------------------------------------------
  // 3. イベントごとに incoming_events 保存 + Queue 投入
  // ------------------------------------------------------------------
  const clientAccountId = c.env.CLIENT_ACCOUNT_ID ?? 'default'
  const lineChannelId = c.env.LINE_CHANNEL_ID ?? ''

  for (const event of events) {
    const messageId = event.message?.id
      ?? (event as any).webhookEventId
      ?? `evt_${event.type}_${event.timestamp}`
    const lineUserId = event.source?.userId ?? null

    // 3a. incoming_events に保存（冪等性: UNIQUE(line_message_id)）
    try {
      await c.env.DB.prepare(`
        INSERT INTO incoming_events (id, line_message_id, event_type, event_json, line_user_id, received_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).bind(
        crypto.randomUUID(),
        messageId,
        event.type,
        JSON.stringify(event),
        lineUserId,
        new Date().toISOString()
      ).run()
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE')) {
        console.log(`[Webhook] duplicate event ${messageId}, skipping enqueue`)
        continue  // 重複イベントは Queue にも入れない
      }
      // UNIQUE 以外のエラーはログだけ出して続行
      console.error(`[Webhook] incoming_events insert error:`, err)
    }

    // 3b. Queue に投入
    try {
      await c.env.LINE_EVENTS_QUEUE.send({
        type: 'webhook_event',
        accountId: clientAccountId,
        channelId: lineChannelId,
        event,
        receivedAt: new Date().toISOString(),
      })
      console.log(`[Webhook] enqueued: ${event.type} msgId=${messageId}`)
    } catch (err) {
      console.error(`[Webhook] queue send error for ${messageId}:`, err)
      // Queue 送信失敗でもイベントは incoming_events に保存されている
      // 後から再送するか、DLQ で回収可能
    }
  }

  // ------------------------------------------------------------------
  // 4. 即 200 返却（reply なし — 固定事項 #4）
  // ------------------------------------------------------------------
  const elapsed = Date.now() - startTime
  console.log(`[Webhook] processed ${events.length} event(s) in ${elapsed}ms`)
  return c.json({ ok: true })
})

export default webhookRouter
