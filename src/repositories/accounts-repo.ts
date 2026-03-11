/**
 * accounts-repo.ts
 * 契約アカウント・メンバーシップの読み書き
 */

import type { Account, AccountMembership } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// accounts
// ===================================================================

export async function findAccountById(db: D1Database, id: string): Promise<Account | null> {
  return (await db.prepare('SELECT * FROM accounts WHERE id = ?1').bind(id).first<Account>()) ?? null
}

export async function listAccounts(db: D1Database, limit = 50, offset = 0): Promise<Account[]> {
  const { results } = await db
    .prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT ?1 OFFSET ?2')
    .bind(limit, offset).all<Account>()
  return results
}

export async function createAccount(
  db: D1Database,
  params: { name: string; type?: Account['type']; timezone?: string; locale?: string }
): Promise<Account> {
  const id = generateId()
  const now = nowIso()
  await db.prepare(`
    INSERT INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7)
  `).bind(id, params.type ?? 'clinic', params.name, params.timezone ?? 'Asia/Tokyo', params.locale ?? 'ja', now, now).run()
  return (await findAccountById(db, id))!
}

export async function updateAccountStatus(db: D1Database, id: string, status: Account['status']): Promise<void> {
  await db.prepare('UPDATE accounts SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(status, nowIso(), id).run()
}

// ===================================================================
// account_memberships
// ===================================================================

export async function findMembershipById(db: D1Database, id: string): Promise<AccountMembership | null> {
  return (await db.prepare('SELECT * FROM account_memberships WHERE id = ?1').bind(id).first<AccountMembership>()) ?? null
}

export async function findMembershipByEmail(db: D1Database, email: string): Promise<AccountMembership | null> {
  return (await db.prepare(
    "SELECT * FROM account_memberships WHERE email = ?1 AND status = 'active' LIMIT 1"
  ).bind(email).first<AccountMembership>()) ?? null
}

export async function findMembershipByUserId(db: D1Database, userId: string): Promise<AccountMembership | null> {
  return (await db.prepare(
    "SELECT * FROM account_memberships WHERE user_id = ?1 AND status = 'active' LIMIT 1"
  ).bind(userId).first<AccountMembership>()) ?? null
}

export async function findMembershipsByAccountId(db: D1Database, accountId: string): Promise<AccountMembership[]> {
  const { results } = await db.prepare(
    'SELECT * FROM account_memberships WHERE account_id = ?1 ORDER BY created_at DESC'
  ).bind(accountId).all<AccountMembership>()
  return results
}

export async function createMembership(
  db: D1Database,
  params: { id?: string; accountId: string; email: string; role: AccountMembership['role']; passwordHash?: string }
): Promise<AccountMembership> {
  const id = params.id ?? generateId()
  const now = nowIso()
  await db.prepare(`
    INSERT INTO account_memberships (id, account_id, user_id, email, role, status, password_hash, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)
  `).bind(id, params.accountId, id, params.email, params.role, params.passwordHash ?? null, now).run()
  return (await findMembershipById(db, id))!
}

export async function updateMembershipPassword(db: D1Database, id: string, passwordHash: string): Promise<void> {
  await db.prepare(
    'UPDATE account_memberships SET password_hash = ?1 WHERE id = ?2'
  ).bind(passwordHash, id).run()
}

export async function setPasswordResetToken(
  db: D1Database, id: string, token: string, expiresAt: string
): Promise<void> {
  await db.prepare(
    'UPDATE account_memberships SET password_reset_token = ?1, password_reset_expires_at = ?2 WHERE id = ?3'
  ).bind(token, expiresAt, id).run()
}

export async function findMembershipByResetToken(db: D1Database, token: string): Promise<AccountMembership | null> {
  return (await db.prepare(`
    SELECT * FROM account_memberships
    WHERE password_reset_token = ?1 AND password_reset_expires_at > datetime('now')
    LIMIT 1
  `).bind(token).first<AccountMembership>()) ?? null
}
