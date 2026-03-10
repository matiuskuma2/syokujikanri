/**
 * LINE Events Queue Consumer
 * Cloudflare Queue によるイベント非同期処理
 */

import type { Bindings, LineQueueMessage } from '../types/bindings'
import { dispatchMessage, dispatchFollowEvent } from '../bot/dispatcher'

export async function lineQueueConsumer(
  batch: MessageBatch<LineQueueMessage>,
  env: Bindings
): Promise<void> {
  for (const message of batch.messages) {
    const { accountId, channelId, event } = message.body

    try {
      switch (event.type) {
        case 'follow':
          await dispatchFollowEvent(env, accountId, channelId, event)
          break
        case 'message':
          await dispatchMessage(env, accountId, channelId, event)
          break
        case 'unfollow':
          // ユーザーが友達削除 → サービス無効化
          await env.DB.prepare(`
            UPDATE user_service_statuses
            SET bot_enabled = 0, updated_at = datetime('now')
            WHERE account_id = ? AND line_user_id = ?
          `).bind(accountId, event.source.userId).run()
          break
        case 'postback':
          // postbackイベントはメッセージとして処理
          // TODO: 必要に応じて拡張
          break
      }
      message.ack()
    } catch (err) {
      console.error(`Queue consumer error for event ${event.type}:`, err)
      message.retry()
    }
  }
}
