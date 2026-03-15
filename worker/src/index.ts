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
