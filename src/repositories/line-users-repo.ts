/**
 * line-users-repo.ts
 * LINE ユーザー・UserAccount の読み書き
 *
 * 参照テーブル: line_users, user_accounts
 */

import type { LineUser, UserAccount } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// line_users
// ===================================================================

/** LINE チャンネル内の LINE ユーザーを取得 */
export async function findLineUser(
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<LineUser | null> {
  const row = await db
    .prepare(`
      SELECT * FROM line_users
      WHERE line_channel_id = ?1 AND line_user_id = ?2
    `)
    .bind(lineChannelId, lineUserId)
    .first<LineUser>()
  return row ?? null
}

/** LINE ユーザーを作成（follow イベント時） */
export async function createLineUser(
  db: D1Database,
  params: {
    lineChannelId: string
    lineUserId: string
    displayName?: string | null
    pictureUrl?: string | null
    statusMessage?: string | null
  }
): Promise<LineUser> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO line_users
        (id, line_channel_id, line_user_id, display_name, picture_url, status_message,
         follow_status, first_seen_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'following', ?7, ?7)
    `)
    .bind(
      id,
      params.lineChannelId,
      params.lineUserId,
      params.displayName ?? null,
      params.pictureUrl ?? null,
      params.statusMessage ?? null,
      now
    )
    .run()
  return (await findLineUser(db, params.lineChannelId, params.lineUserId))!
}

/** LINE ユーザーをupsert（follow時・プロフィール更新時） */
export async function upsertLineUser(
  db: D1Database,
  params: {
    lineChannelId: string
    lineUserId: string
    displayName?: string | null
    pictureUrl?: string | null
    statusMessage?: string | null
    followStatus?: LineUser['follow_status']
  }
): Promise<LineUser> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO line_users
        (id, line_channel_id, line_user_id, display_name, picture_url, status_message,
         follow_status, first_seen_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(line_channel_id, line_user_id) DO UPDATE SET
        display_name   = COALESCE(?4, display_name),
        picture_url    = COALESCE(?5, picture_url),
        status_message = COALESCE(?6, status_message),
        follow_status  = ?7,
        last_seen_at   = ?8
    `)
    .bind(
      id,
      params.lineChannelId,
      params.lineUserId,
      params.displayName ?? null,
      params.pictureUrl ?? null,
      params.statusMessage ?? null,
      params.followStatus ?? 'following',
      now
    )
    .run()
  return (await findLineUser(db, params.lineChannelId, params.lineUserId))!
}

/** 最終インタラクション時刻を更新 */
export async function updateLineUserLastInteractedAt(
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<void> {
  const now = nowIso()
  await db
    .prepare(`
      UPDATE line_users
      SET last_seen_at = ?1
      WHERE line_channel_id = ?2 AND line_user_id = ?3
    `)
    .bind(now, lineChannelId, lineUserId)
    .run()
}

/** アクティブなフォロワー全員を取得（Cron用） */
export async function listActiveLineUsers(
  db: D1Database,
  lineChannelId: string
): Promise<LineUser[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM line_users
      WHERE line_channel_id = ?1 AND follow_status = 'following'
    `)
    .bind(lineChannelId)
    .all<LineUser>()
  return results
}

// ===================================================================
// user_accounts
// ===================================================================

/** line_user_id と client_account_id で UserAccount を取得 */
export async function findUserAccount(
  db: D1Database,
  lineUserId: string,
  clientAccountId: string
): Promise<UserAccount | null> {
  const row = await db
    .prepare(`
      SELECT * FROM user_accounts
      WHERE line_user_id = ?1 AND client_account_id = ?2
    `)
    .bind(lineUserId, clientAccountId)
    .first<UserAccount>()
  return row ?? null
}

/** user_account_id（内部ID）で取得 */
export async function findUserAccountById(
  db: D1Database,
  userAccountId: string
): Promise<UserAccount | null> {
  const row = await db
    .prepare('SELECT * FROM user_accounts WHERE id = ?1')
    .bind(userAccountId)
    .first<UserAccount>()
  return row ?? null
}

/** UserAccount を作成（LINE ユーザーを契約アカウントへ紐付け） */
export async function createUserAccount(
  db: D1Database,
  params: {
    lineUserId: string
    clientAccountId: string
  }
): Promise<UserAccount> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO user_accounts
        (id, line_user_id, client_account_id, status, joined_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
    `)
    .bind(id, params.lineUserId, params.clientAccountId, now)
    .run()
  return (await findUserAccount(db, params.lineUserId, params.clientAccountId))!
}

/**
 * UserAccount をupsertし、確実に1件返す
 * follow イベント時の必須処理
 * ON CONFLICT で安全にupsert（並行フォローイベント対応）
 */
export async function ensureUserAccount(
  db: D1Database,
  lineUserId: string,
  clientAccountId: string
): Promise<UserAccount> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO user_accounts
        (id, line_user_id, client_account_id, status, joined_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
      ON CONFLICT(line_user_id, client_account_id) DO UPDATE SET
        status = 'active',
        updated_at = ?4
    `)
    .bind(id, lineUserId, clientAccountId, now)
    .run()
  return (await findUserAccount(db, lineUserId, clientAccountId))!
}

/** アカウントに紐付く全 UserAccount 一覧 */
export async function listUserAccountsByClientAccount(
  db: D1Database,
  clientAccountId: string,
  limit = 100,
  offset = 0
): Promise<UserAccount[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM user_accounts
      WHERE client_account_id = ?1 AND status = 'active'
      ORDER BY joined_at DESC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(clientAccountId, limit, offset)
    .all<UserAccount>()
  return results
}

// ===================================================================
// N+1 解消: ユーザー一覧（JOIN 版）
// user_accounts + line_users + user_service_statuses を 1 クエリで取得
// ===================================================================

export interface UserListRow {
  userAccountId: string
  lineUserId: string
  display_name: string | null
  status: string
  joinedAt: string | null
  bot_enabled: number | null
  record_enabled: number | null
  consult_enabled: number | null
  intake_completed: number | null
}

/** アカウントに紐付くユーザー一覧を 1 クエリで取得（N+1 解消） */
export async function listUserAccountsWithDetails(
  db: D1Database,
  clientAccountId: string,
  limit = 100,
  offset = 0
): Promise<UserListRow[]> {
  const { results } = await db
    .prepare(`
      SELECT
        ua.id           AS userAccountId,
        ua.line_user_id AS lineUserId,
        lu.display_name AS display_name,
        ua.status       AS status,
        ua.joined_at    AS joinedAt,
        uss.bot_enabled,
        uss.record_enabled,
        uss.consult_enabled,
        uss.intake_completed
      FROM user_accounts ua
      LEFT JOIN line_users lu
        ON lu.line_user_id = ua.line_user_id
      LEFT JOIN user_service_statuses uss
        ON uss.account_id = ua.client_account_id
        AND uss.line_user_id = ua.line_user_id
      WHERE ua.client_account_id = ?1 AND ua.status = 'active'
      ORDER BY ua.joined_at DESC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(clientAccountId, limit, offset)
    .all<UserListRow>()
  return results
}
