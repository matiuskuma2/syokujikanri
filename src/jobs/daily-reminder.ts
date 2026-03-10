/**
 * src/jobs/daily-reminder.ts
 * 毎日リマインダー Cron ジョブ
 *
 * cron: "0 21 * * *"  (UTC 21:00 = JST 翌6:00 → 実運用は JST 21:00 = UTC 12:00)
 * wrangler.jsonc の crons 設定:  "0 12 * * *"  (UTC 12:00 = JST 21:00)
 *
 * 処理フロー:
 *   1. record_enabled = 1 の全ユーザーを取得
 *   2. 当日の daily_log がないユーザーを絞り込み
 *   3. 記録催促メッセージを LINE push
 *
 * 注意:
 *   - 大量ユーザー時は LINE Rate Limit に注意（1秒に複数送信しない）
 *   - Phase 2: バッチサイズ・遅延送信・送信時間帯のユーザー設定に対応予定
 */

import type { Bindings } from '../types/bindings'
import { listActiveUserServiceStatuses } from '../repositories/subscriptions-repo'
import { hasLogForDate } from '../repositories/daily-logs-repo'
import { findUserAccountById } from '../repositories/line-users-repo'
import { pushText } from '../services/line/reply'
import { todayJst } from '../utils/id'

/** リマインダーメッセージテンプレート */
const REMINDER_MESSAGES = [
  '📝 今日の記録はお済みですか？\n\n体重・食事・運動を記録して、目標達成を目指しましょう！',
  '💪 今日も記録を忘れずに！\n\n毎日の積み重ねが結果につながります。',
  '🌙 1日の振り返りをしましょう！\n\n食事・体重・運動の記録をお待ちしています。',
]

/**
 * 毎日リマインダー Cron エントリーポイント
 * src/index.ts の scheduled handler から呼ぶ
 */
export async function runDailyReminder(env: Bindings): Promise<void> {
  console.log('[Cron] daily-reminder: start')
  const today = todayJst()

  try {
    // 1. 全クライアントアカウントのアクティブユーザーを取得
    //    現フェーズはシングルチャンネルなので CLIENT_ACCOUNT_ID ベースで取得
    const clientAccountId = env.CLIENT_ACCOUNT_ID
    const activeStatuses = await listActiveUserServiceStatuses(env.DB, clientAccountId)

    console.log(`[Cron] daily-reminder: ${activeStatuses.length} active users`)

    let sentCount = 0
    let skipCount = 0

    for (const status of activeStatuses) {
      try {
        // record_enabled でないユーザーはスキップ
        if (!status.record_enabled) {
          skipCount++
          continue
        }

        // 当日の記録があればスキップ
        const userAccount = await findUserAccountById(env.DB, status.line_user_id)
        if (!userAccount) {
          skipCount++
          continue
        }

        const alreadyLogged = await hasLogForDate(env.DB, userAccount.id, today)
        if (alreadyLogged) {
          skipCount++
          continue
        }

        // LINE push 送信（ランダムメッセージ）
        const msg = REMINDER_MESSAGES[sentCount % REMINDER_MESSAGES.length]
        await pushText(status.line_user_id, msg, env.LINE_CHANNEL_ACCESS_TOKEN)
        sentCount++

        // LINE API レート制限回避: 50ms 間隔
        await sleep(50)
      } catch (err) {
        console.warn(`[Cron] daily-reminder: failed for ${status.line_user_id}:`, err)
      }
    }

    console.log(
      `[Cron] daily-reminder: done. sent=${sentCount} skipped=${skipCount}`
    )
  } catch (err) {
    console.error('[Cron] daily-reminder: fatal error:', err)
    throw err
  }
}

/** ms ミリ秒待機 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
