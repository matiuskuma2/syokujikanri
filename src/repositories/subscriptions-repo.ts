/**
 * subscriptions-repo.ts
 * サブスクリプション・ユーザー単位サービス ON/OFF
 *
 * 参照テーブル: subscriptions, user_service_statuses
 */

import type { Subscription, UserServiceStatus } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// subscriptions
// ===================================================================

/** アカウントの最新サブスクリプションを取得 */
export async function findLatestSubscriptionByAccountId(
  db: D1Database,
  accountId: string
): Promise<Subscription | null> {
  const row = await db
    .prepare(`
      SELECT * FROM subscriptions
      WHERE account_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(accountId)
    .first<Subscription>()
  return row ?? null
}

/** アクティブなサブスクリプションを取得 */
export async function findActiveSubscription(
  db: D1Database,
  accountId: string
): Promise<Subscription | null> {
  const row = await db
    .prepare(`
      SELECT * FROM subscriptions
      WHERE account_id = ?1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(accountId)
    .first<Subscription>()
  return row ?? null
}

// ===================================================================
// user_service_statuses
// ===================================================================

/** ユーザーのサービスステータスを取得 */
export async function findUserServiceStatus(
  db: D1Database,
  accountId: string,
  lineUserId: string
): Promise<UserServiceStatus | null> {
  const row = await db
    .prepare(`
      SELECT * FROM user_service_statuses
      WHERE account_id = ?1 AND line_user_id = ?2
    `)
    .bind(accountId, lineUserId)
    .first<UserServiceStatus>()
  return row ?? null
}

/**
 * サービスアクセス可否を判定
 * returns: { botEnabled, recordEnabled, consultEnabled, intakeCompleted }
 */
export async function checkServiceAccess(
  db: D1Database,
  params: { accountId: string; lineUserId: string }
): Promise<{
  botEnabled: boolean
  recordEnabled: boolean
  consultEnabled: boolean
  intakeCompleted: boolean
} | null> {
  const row = await db
    .prepare(`
      SELECT
        uss.bot_enabled,
        uss.record_enabled,
        uss.consult_enabled,
        uss.intake_completed
      FROM user_service_statuses uss
      WHERE uss.account_id = ?1
        AND uss.line_user_id = ?2
    `)
    .bind(params.accountId, params.lineUserId)
    .first<{
      bot_enabled: number
      record_enabled: number
      consult_enabled: number
      intake_completed: number
    }>()

  if (!row) return null
  return {
    botEnabled: row.bot_enabled === 1,
    recordEnabled: row.record_enabled === 1,
    consultEnabled: row.consult_enabled === 1,
    intakeCompleted: row.intake_completed === 1,
  }
}

/** ユーザーのサービスステータスをupsert */
export async function upsertUserServiceStatus(
  db: D1Database,
  params: {
    accountId: string
    lineUserId: string
    botEnabled?: number
    recordEnabled?: number
    consultEnabled?: number
    intakeCompleted?: number
  }
): Promise<void> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO user_service_statuses
        (id, account_id, line_user_id, bot_enabled, record_enabled, consult_enabled, intake_completed, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(account_id, line_user_id) DO UPDATE SET
        bot_enabled      = COALESCE(?4, bot_enabled),
        record_enabled   = COALESCE(?5, record_enabled),
        consult_enabled  = COALESCE(?6, consult_enabled),
        intake_completed = COALESCE(?7, intake_completed),
        updated_at       = ?9
    `)
    .bind(
      id,
      params.accountId,
      params.lineUserId,
      params.botEnabled ?? 1,
      params.recordEnabled ?? 1,
      params.consultEnabled ?? 1,
      params.intakeCompleted ?? 0,
      now,
      now
    )
    .run()
}

/** 全アクティブユーザーのサービスステータス一覧（Cron用） */
export async function listActiveUserServiceStatuses(
  db: D1Database,
  accountId: string
): Promise<UserServiceStatus[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM user_service_statuses
      WHERE account_id = ?1 AND bot_enabled = 1
    `)
    .bind(accountId)
    .all<UserServiceStatus>()
  return results
}
