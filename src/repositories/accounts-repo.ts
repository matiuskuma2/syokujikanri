/**
 * accounts-repo.ts
 * 契約アカウント・メンバーシップの読み書き
 *
 * 参照テーブル: accounts, account_memberships
 */

import type { Account, AccountMembership } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// accounts
// ===================================================================

/** ID でアカウントを取得 */
export async function findAccountById(
  db: D1Database,
  id: string
): Promise<Account | null> {
  const row = await db
    .prepare('SELECT * FROM accounts WHERE id = ?1')
    .bind(id)
    .first<Account>()
  return row ?? null
}

/** 全アカウントを取得（superadmin 用） */
export async function listAccounts(
  db: D1Database,
  limit = 50,
  offset = 0
): Promise<Account[]> {
  const { results } = await db
    .prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT ?1 OFFSET ?2')
    .bind(limit, offset)
    .all<Account>()
  return results
}

/** 新しいアカウントを作成 */
export async function createAccount(
  db: D1Database,
  params: {
    name: string
    type?: Account['type']
    timezone?: string
    locale?: string
  }
): Promise<Account> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7)
    `)
    .bind(
      id,
      params.type ?? 'clinic',
      params.name,
      params.timezone ?? 'Asia/Tokyo',
      params.locale ?? 'ja',
      now,
      now
    )
    .run()
  return (await findAccountById(db, id))!
}

/** アカウントのステータスを更新 */
export async function updateAccountStatus(
  db: D1Database,
  id: string,
  status: Account['status']
): Promise<void> {
  await db
    .prepare('UPDATE accounts SET status = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(status, nowIso(), id)
    .run()
}

// ===================================================================
// account_memberships
// ===================================================================

/** メンバーID（staff の認証 user_id）でメンバーシップを取得 */
export async function findMembershipByUserId(
  db: D1Database,
  userId: string
): Promise<AccountMembership | null> {
  const row = await db
    .prepare(`
      SELECT * FROM account_memberships
      WHERE user_id = ?1 AND status = 'active'
      LIMIT 1
    `)
    .bind(userId)
    .first<AccountMembership>()
  return row ?? null
}

/** email でメンバーシップを取得（ログイン用） */
export async function findMembershipByEmail(
  db: D1Database,
  email: string
): Promise<AccountMembership | null> {
  const row = await db
    .prepare(`
      SELECT * FROM account_memberships
      WHERE email = ?1 AND status = 'active'
      LIMIT 1
    `)
    .bind(email)
    .first<AccountMembership>()
  return row ?? null
}

/** アカウントに属するメンバー一覧 */
export async function findMembershipsByAccountId(
  db: D1Database,
  accountId: string
): Promise<AccountMembership[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM account_memberships
      WHERE account_id = ?1
      ORDER BY created_at DESC
    `)
    .bind(accountId)
    .all<AccountMembership>()
  return results
}

/** メンバーシップを作成 */
export async function createMembership(
  db: D1Database,
  params: {
    accountId: string
    userId: string
    email: string
    role: AccountMembership['role']
  }
): Promise<AccountMembership> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO account_memberships (id, account_id, user_id, email, role, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)
    `)
    .bind(id, params.accountId, params.userId, params.email, params.role, now)
    .run()
  const row = await db
    .prepare('SELECT * FROM account_memberships WHERE id = ?1')
    .bind(id)
    .first<AccountMembership>()
  return row!
}
