/**
 * LINE Webhook ルーター
 * /api/webhooks/line
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import type { LineWebhookEvent } from '../../types/bindings'
import { verifyLineSignature } from '../../utils/line'
import { LineChannelRepo } from '../../repository'

type HonoEnv = { Bindings: Bindings }

const webhook = new Hono<HonoEnv>()

webhook.post('/', async (c) => {
  const signature = c.req.header('x-line-signature') || ''
  const rawBody = await c.req.text()

  // シグネチャ検証
  const isValid = await verifyLineSignature(rawBody, signature, c.env.LINE_CHANNEL_SECRET)
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let body: { events: LineWebhookEvent[]; destination?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  // チャンネル確認
  const destination = body.destination || ''
  const channel = await LineChannelRepo.findByChannelId(c.env.DB, destination)
  if (!channel) {
    // チャンネルが見つからない場合は200を返す（LINEの仕様）
    return c.json({ status: 'channel_not_found' })
  }

  const accountId = channel.account_id
  const channelId = channel.channel_id

  // イベントをキューに送信（非同期処理）
  for (const event of body.events) {
    try {
      await c.env.LINE_EVENTS_QUEUE.send({
        accountId,
        channelId,
        event,
        receivedAt: new Date().toISOString()
      })
    } catch (err) {
      console.error('Queue send error:', err)
    }
  }

  return c.json({ status: 'ok' })
})

export default webhook
