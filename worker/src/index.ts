/**
 * worker/src/index.ts
 * Consumer Worker エントリポイント
 *
 * diet-bot-line-events Queue のメッセージを1件ずつ直列処理する。
 * Pages Function (webhook) は保存 + enqueue + 200 のみ。
 * 全ての実質的な処理はこの Worker が行い、全応答は push で送信する。
 */

import type { MessageBatch, ExecutionContext } from '@cloudflare/workers-types'
import { processQueueMessage } from './dispatcher'
import type { WorkerEnv } from './types'

export default {
  /**
   * HTTP fetch ハンドラ（ヘルスチェック + 状態確認用）
   */
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health' || url.pathname === '/') {
      // 簡易ヘルスチェック
      const pendingEvents = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM incoming_events WHERE processed_at IS NULL`
      ).first<{ cnt: number }>()

      const pendingOutbox = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM outbox_messages WHERE status = 'pending'`
      ).first<{ cnt: number }>()

      const failedOutbox = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM outbox_messages WHERE status = 'failed'`
      ).first<{ cnt: number }>()

      return new Response(JSON.stringify({
        status: 'ok',
        worker: 'diet-bot-worker',
        version: 'v2.0.0',
        queue: {
          pending_events: pendingEvents?.cnt ?? 0,
          pending_outbox: pendingOutbox?.cnt ?? 0,
          failed_outbox: failedOutbox?.cnt ?? 0,
        },
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/debug/state' && url.searchParams.get('line_user_id')) {
      const lineUserId = url.searchParams.get('line_user_id')!
      const state = await env.DB.prepare(
        `SELECT * FROM conversation_runtime_state WHERE line_user_id = ?1`
      ).bind(lineUserId).first()

      const recentEvents = await env.DB.prepare(
        `SELECT id, line_message_id, event_type, processed_at, process_result
         FROM incoming_events WHERE line_user_id = ?1
         ORDER BY received_at DESC LIMIT 10`
      ).bind(lineUserId).all()

      return new Response(JSON.stringify({
        runtime_state: state,
        recent_events: recentEvents.results,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },

  /**
   * Queue Consumer ハンドラ
   * max_batch_size: 1 なので batch.messages は常に1件
   */
  async queue(
    batch: MessageBatch<unknown>,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      const startTime = Date.now()
      try {
        await processQueueMessage(message.body, env)
        message.ack()
        console.log(`[Worker] message processed in ${Date.now() - startTime}ms`)
      } catch (err) {
        const elapsed = Date.now() - startTime
        console.error(`[Worker] message processing failed after ${elapsed}ms (attempt ${message.attempts}):`, err)
        // retry: Queue が自動で retry_delay 後に再送する
        // max_retries 超過で DLQ 行き
        message.retry()
      }
    }
  },
}
