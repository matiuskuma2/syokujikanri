/**
 * src/repositories/user-memory-repo.ts
 * user_memory_items テーブルの読み書き
 *
 * Layer 3: パーソナルメモリ（長期的な個人情報）
 */

import type { UserMemoryItem } from '../types/intent'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// CRUD
// ===================================================================

/** メモリを UPSERT（同一カテゴリ・キーは上書き） */
export async function upsertMemoryItem(
  db: D1Database,
  userAccountId: string,
  item: {
    category: string
    memory_key: string
    memory_value: string
    structured_json?: string | null
    source_type?: UserMemoryItem['source_type']
    source_message_id?: string | null
    confidence_score?: number
  }
): Promise<void> {
  const now = nowIso()
  const id = generateId()
  const confidence = item.confidence_score ?? 0.8

  // 既存レコードの確信度をチェック
  const existing = await db
    .prepare(`
      SELECT confidence_score FROM user_memory_items
      WHERE user_account_id = ?1 AND category = ?2 AND memory_key = ?3
    `)
    .bind(userAccountId, item.category, item.memory_key)
    .first<{ confidence_score: number }>()

  // 新しい confidence_score が既存より低い場合はスキップ
  if (existing && existing.confidence_score > confidence) {
    return
  }

  await db.prepare(`
    INSERT INTO user_memory_items
      (id, user_account_id, category, memory_key, memory_value,
       structured_json, source_type, source_message_id,
       confidence_score, is_active, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
    ON CONFLICT(user_account_id, category, memory_key)
    DO UPDATE SET
      memory_value = ?5,
      structured_json = ?6,
      source_type = ?7,
      source_message_id = ?8,
      confidence_score = ?9,
      is_active = 1,
      updated_at = ?10
  `).bind(
    id,
    userAccountId,
    item.category,
    item.memory_key,
    item.memory_value,
    item.structured_json ?? null,
    item.source_type ?? 'conversation',
    item.source_message_id ?? null,
    confidence,
    now
  ).run()
}

/** ユーザーの有効なメモリを全取得 */
export async function findActiveMemories(
  db: D1Database,
  userAccountId: string
): Promise<UserMemoryItem[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM user_memory_items
      WHERE user_account_id = ?1 AND is_active = 1
      ORDER BY updated_at DESC
    `)
    .bind(userAccountId)
    .all<UserMemoryItem>()
  return results
}

/** カテゴリ指定でメモリを取得 */
export async function findMemoriesByCategory(
  db: D1Database,
  userAccountId: string,
  category: string
): Promise<UserMemoryItem[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM user_memory_items
      WHERE user_account_id = ?1 AND category = ?2 AND is_active = 1
      ORDER BY updated_at DESC
    `)
    .bind(userAccountId, category)
    .all<UserMemoryItem>()
  return results
}

/** メモリを無効化（論理削除） */
export async function deactivateMemoryItem(
  db: D1Database,
  memoryId: string
): Promise<void> {
  await db.prepare(`
    UPDATE user_memory_items
    SET is_active = 0, updated_at = datetime('now')
    WHERE id = ?1
  `).bind(memoryId).run()
}

/** ユーザーの全メモリを物理削除（アカウント削除時） */
export async function deleteAllMemories(
  db: D1Database,
  userAccountId: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM user_memory_items
    WHERE user_account_id = ?1
  `).bind(userAccountId).run()
}
