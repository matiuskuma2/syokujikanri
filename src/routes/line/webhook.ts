/**
 * src/routes/line/webhook.ts
 * LINE Webhook エンドポイント
 *
 * 責務:
 *   1. リクエスト Body を raw text で読み取り
 *   2. X-Line-Signature を verifyLineSignature で検証
 *   3. JSON パース → events 配列を並列処理
 *   4. 各イベントは processLineEvent に委譲（1イベント単位で try/catch）
 *   5. LINE に 200 OK を即時返却
 *
 * Context 解決ロジック:
 *   - LINE_CHANNEL_ID / CLIENT_ACCOUNT_ID は env から取得
 *   - 将来マルチチャンネル化する際はここで line_channels テーブルを検索する
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import type { LineWebhookEvent } from '../../types/bindings'
import { verifyLineSignature } from '../../services/line/verify-signature'
import { processLineEvent } from '../../services/line/process-line-event'

const webhookRouter = new Hono<{ Bindings: Bindings }>()

webhookRouter.post('/', async (c) => {
  // ------------------------------------------------------------------
  // 1. raw body 取得（署名検証に生テキストが必要）
  // ------------------------------------------------------------------
  const rawBody = await c.req.text()

  // ------------------------------------------------------------------
  // 2. 署名検証
  // ------------------------------------------------------------------
  const signature = c.req.header('x-line-signature') ?? ''
  const isValid = await verifyLineSignature(rawBody, signature, c.env.LINE_CHANNEL_SECRET)

  if (!isValid) {
    console.warn('[Webhook] Invalid LINE signature')
    return c.json({ error: 'Invalid signature' }, 401)
  }

  // ------------------------------------------------------------------
  // 3. JSON パース
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
    // LINE の疎通確認（events が空の場合）
    return c.json({ ok: true })
  }

  // ------------------------------------------------------------------
  // 4. チャンネルコンテキスト解決
  //
  //    Phase 1 (シングルチャンネル):
  //      env.LINE_CHANNEL_ID と env.CLIENT_ACCOUNT_ID を直接使用
  //
  //    Phase 2+ (マルチチャンネル):
  //      body.destination の LINE チャンネル UID → line_channels テーブル検索
  // ------------------------------------------------------------------
  const lineChannelId = c.env.LINE_CHANNEL_ID ?? 'default'
  const clientAccountId = c.env.CLIENT_ACCOUNT_ID ?? 'default'

  const ctx = { env: c.env, lineChannelId, clientAccountId }

  // ------------------------------------------------------------------
  // 5. イベント処理（並列・個別 try/catch は processLineEvent 内で行う）
  // ------------------------------------------------------------------
  await Promise.allSettled(
    events.map((event) => processLineEvent(event, ctx))
  )

  // LINE は 200 を返さないとリトライするため必ず 200 を返す
  return c.json({ ok: true })
})

export default webhookRouter
