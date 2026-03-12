/**
 * invite-codes-repo.ts
 * 招待コードの CRUD 操作
 *
 * テーブル: invite_codes, invite_code_usages
 */

import { generateId, nowIso } from '../utils/id'

// ===================================================================
// 型定義
// ===================================================================

export interface InviteCode {
  id: string
  code: string
  account_id: string
  created_by: string
  label: string | null
  max_uses: number | null
  use_count: number
  status: 'active' | 'expired' | 'revoked'
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface InviteCodeUsage {
  id: string
  invite_code_id: string
  line_user_id: string
  used_at: string
}

export interface InviteCodeWithCreator extends InviteCode {
  creator_email?: string
}

// ===================================================================
// コード生成
// ===================================================================

/** 6文字のランダム招待コードを生成 (例: ABC-1234) */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // I,O を除外 (0,1と混同防止)
  const nums = '0123456789'
  let code = ''
  for (let i = 0; i < 3; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  code += '-'
  for (let i = 0; i < 4; i++) {
    code += nums.charAt(Math.floor(Math.random() * nums.length))
  }
  return code
}

// ===================================================================
// CRUD
// ===================================================================

/** 招待コードを作成 */
export async function createInviteCode(
  db: D1Database,
  params: {
    accountId: string
    createdBy: string
    label?: string | null
    maxUses?: number | null
    expiresAt?: string | null
  }
): Promise<InviteCode> {
  const id = generateId()
  const now = nowIso()

  // コード重複チェック付きリトライ（最大5回）
  let code: string
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateInviteCode()
    const existing = await db
      .prepare('SELECT id FROM invite_codes WHERE code = ?1')
      .bind(code)
      .first()
    if (!existing) break
    if (attempt === 4) throw new Error('Failed to generate unique invite code')
  }

  await db
    .prepare(`
      INSERT INTO invite_codes
        (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'active', ?7, ?8, ?8)
    `)
    .bind(
      id,
      code!,
      params.accountId,
      params.createdBy,
      params.label ?? null,
      params.maxUses ?? 1,
      params.expiresAt ?? null,
      now
    )
    .run()

  return (await findInviteCodeById(db, id))!
}

/** IDで取得 */
export async function findInviteCodeById(
  db: D1Database,
  id: string
): Promise<InviteCode | null> {
  const row = await db
    .prepare('SELECT * FROM invite_codes WHERE id = ?1')
    .bind(id)
    .first<InviteCode>()
  return row ?? null
}

/** コード文字列で取得 */
export async function findInviteCodeByCode(
  db: D1Database,
  code: string
): Promise<InviteCode | null> {
  const row = await db
    .prepare("SELECT * FROM invite_codes WHERE code = ?1 AND status = 'active'")
    .bind(code.toUpperCase().trim())
    .first<InviteCode>()
  return row ?? null
}

/** アカウントの招待コード一覧 */
export async function listInviteCodesByAccount(
  db: D1Database,
  accountId: string,
  limit = 50,
  offset = 0
): Promise<InviteCodeWithCreator[]> {
  const { results } = await db
    .prepare(`
      SELECT ic.*, am.email AS creator_email
      FROM invite_codes ic
      LEFT JOIN account_memberships am ON am.id = ic.created_by
      WHERE ic.account_id = ?1
      ORDER BY ic.created_at DESC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(accountId, limit, offset)
    .all<InviteCodeWithCreator>()
  return results
}

/** superadmin用: 全招待コード一覧 */
export async function listAllInviteCodes(
  db: D1Database,
  limit = 100,
  offset = 0
): Promise<InviteCodeWithCreator[]> {
  const { results } = await db
    .prepare(`
      SELECT ic.*, am.email AS creator_email
      FROM invite_codes ic
      LEFT JOIN account_memberships am ON am.id = ic.created_by
      ORDER BY ic.created_at DESC
      LIMIT ?1 OFFSET ?2
    `)
    .bind(limit, offset)
    .all<InviteCodeWithCreator>()
  return results
}

// ===================================================================
// コード使用（LINE ユーザーの紐付け）
// ===================================================================

/**
 * 招待コードを使用してユーザーをアカウントに紐付ける
 *
 * @returns { success: true, accountId } or { success: false, error }
 */
export async function useInviteCode(
  db: D1Database,
  code: string,
  lineUserId: string
): Promise<{ success: true; accountId: string } | { success: false; error: string }> {
  const inviteCode = await findInviteCodeByCode(db, code)

  if (!inviteCode) {
    return { success: false, error: 'INVALID_CODE' }
  }

  // 有効期限チェック
  if (inviteCode.expires_at) {
    const now = new Date()
    const expires = new Date(inviteCode.expires_at)
    if (now > expires) {
      // ステータス更新
      await db
        .prepare("UPDATE invite_codes SET status = 'expired', updated_at = ?1 WHERE id = ?2")
        .bind(nowIso(), inviteCode.id)
        .run()
      return { success: false, error: 'CODE_EXPIRED' }
    }
  }

  // 使用回数チェック
  if (inviteCode.max_uses !== null && inviteCode.use_count >= inviteCode.max_uses) {
    return { success: false, error: 'CODE_EXHAUSTED' }
  }

  // 同一ユーザーが同じコードを二重使用しないかチェック
  const alreadyUsed = await db
    .prepare('SELECT id FROM invite_code_usages WHERE invite_code_id = ?1 AND line_user_id = ?2')
    .bind(inviteCode.id, lineUserId)
    .first()
  if (alreadyUsed) {
    return { success: false, error: 'ALREADY_USED' }
  }

  // 同一ユーザーが別のコードで既に紐付け済みかチェック（再招待シナリオ対応）
  const anyPreviousUsage = await db
    .prepare('SELECT ic.account_id FROM invite_code_usages icu JOIN invite_codes ic ON ic.id = icu.invite_code_id WHERE icu.line_user_id = ?1 ORDER BY icu.used_at DESC LIMIT 1')
    .bind(lineUserId)
    .first<{ account_id: string }>()
  // 既に同じアカウントに紐付いている場合は ALREADY_USED を返す
  if (anyPreviousUsage && anyPreviousUsage.account_id === inviteCode.account_id) {
    return { success: false, error: 'ALREADY_USED' }
  }

  // 使用履歴を記録
  const usageId = generateId()
  await db
    .prepare(`
      INSERT INTO invite_code_usages (id, invite_code_id, line_user_id, used_at)
      VALUES (?1, ?2, ?3, ?4)
    `)
    .bind(usageId, inviteCode.id, lineUserId, nowIso())
    .run()

  // 使用回数をインクリメント
  await db
    .prepare('UPDATE invite_codes SET use_count = use_count + 1, updated_at = ?1 WHERE id = ?2')
    .bind(nowIso(), inviteCode.id)
    .run()

  return { success: true, accountId: inviteCode.account_id }
}

// ===================================================================
// 管理操作
// ===================================================================

/** 招待コードを無効化 */
export async function revokeInviteCode(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare("UPDATE invite_codes SET status = 'revoked', updated_at = ?1 WHERE id = ?2")
    .bind(nowIso(), id)
    .run()
}

/** 期限切れコードを一括更新 (hourly cron) */
export async function expireInviteCodes(
  db: D1Database
): Promise<number> {
  const now = nowIso()
  const result = await db
    .prepare(`
      UPDATE invite_codes
      SET status = 'expired', updated_at = ?1
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?1
    `)
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

/** LINE ユーザーの招待コード使用履歴を検索（再フォロー時の判定用） */
export async function findInviteCodeUsageByLineUser(
  db: D1Database,
  lineUserId: string
): Promise<InviteCodeUsage | null> {
  const row = await db
    .prepare('SELECT * FROM invite_code_usages WHERE line_user_id = ?1 ORDER BY used_at DESC LIMIT 1')
    .bind(lineUserId)
    .first<InviteCodeUsage>()
  return row ?? null
}
