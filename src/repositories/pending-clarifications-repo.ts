/**
 * pending-clarifications-repo.ts
 * Phase B 明確化フローの状態管理リポジトリ
 *
 * 正本: docs/12_記録確認フローSSOT.md §3
 */

import { generateId, nowIso } from '../../utils/id'
import type { PendingClarification } from '../../types/intent'

// ===================================================================
// Create
// ===================================================================

/**
 * 明確化待ちレコードを作成する
 * 既存の asking 状態があれば cancelled にする（1ユーザー1件制約）
 */
export async function createPendingClarification(
  db: D1Database,
  params: {
    userAccountId: string
    clientAccountId: string
    intentJson: string
    originalMessage: string
    messageId: string | null
    missingFields: string[]
    currentField: string
  }
): Promise<PendingClarification> {
  // 既存の asking を cancelled に
  await cancelActiveClarifications(db, params.userAccountId)

  const id = generateId()
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  await db.prepare(`
    INSERT INTO pending_clarifications
      (id, user_account_id, client_account_id, intent_json, original_message,
       message_id, missing_fields, current_field, answers_json, status,
       ask_count, expires_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', 'asking', 1, ?9, ?10, ?10)
  `).bind(
    id,
    params.userAccountId,
    params.clientAccountId,
    params.intentJson,
    params.originalMessage,
    params.messageId,
    JSON.stringify(params.missingFields),
    params.currentField,
    expiresAt,
    now
  ).run()

  return {
    id,
    user_account_id: params.userAccountId,
    client_account_id: params.clientAccountId,
    intent_json: params.intentJson,
    original_message: params.originalMessage,
    message_id: params.messageId,
    missing_fields: JSON.stringify(params.missingFields),
    current_field: params.currentField,
    answers_json: '{}',
    status: 'asking',
    ask_count: 1,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  }
}

// ===================================================================
// Read
// ===================================================================

/**
 * ユーザーの有効な明確化待ちレコードを取得する（最大1件）
 */
export async function findActiveClarification(
  db: D1Database,
  userAccountId: string
): Promise<PendingClarification | null> {
  return db.prepare(`
    SELECT * FROM pending_clarifications
    WHERE user_account_id = ?1 AND status = 'asking'
    ORDER BY created_at DESC LIMIT 1
  `).bind(userAccountId).first<PendingClarification>()
}

/**
 * IDで取得
 */
export async function findClarificationById(
  db: D1Database,
  id: string
): Promise<PendingClarification | null> {
  return db.prepare(`
    SELECT * FROM pending_clarifications WHERE id = ?1
  `).bind(id).first<PendingClarification>()
}

// ===================================================================
// Update
// ===================================================================

/**
 * 回答を追加し、次の質問フィールドを更新
 */
export async function updateClarificationAnswer(
  db: D1Database,
  id: string,
  params: {
    answersJson: string
    currentField: string | null
    intentJson: string
  }
): Promise<void> {
  const now = nowIso()

  if (params.currentField) {
    // まだ不足フィールドあり → 次の質問へ
    await db.prepare(`
      UPDATE pending_clarifications
      SET answers_json = ?1, current_field = ?2, intent_json = ?3,
          ask_count = ask_count + 1, updated_at = ?4
      WHERE id = ?5
    `).bind(params.answersJson, params.currentField, params.intentJson, now, id).run()
  } else {
    // 全フィールド回答済み → answered に
    await db.prepare(`
      UPDATE pending_clarifications
      SET answers_json = ?1, intent_json = ?2, status = 'answered', updated_at = ?3
      WHERE id = ?4
    `).bind(params.answersJson, params.intentJson, now, id).run()
  }
}

/**
 * ユーザーの全 asking を cancelled に
 */
export async function cancelActiveClarifications(
  db: D1Database,
  userAccountId: string
): Promise<void> {
  await db.prepare(`
    UPDATE pending_clarifications
    SET status = 'cancelled', updated_at = ?1
    WHERE user_account_id = ?2 AND status = 'asking'
  `).bind(nowIso(), userAccountId).run()
}

/**
 * 期限切れの asking を expired に（Cron ジョブ用）
 */
export async function expirePendingClarifications(
  db: D1Database
): Promise<number> {
  const now = nowIso()
  const result = await db.prepare(`
    UPDATE pending_clarifications
    SET status = 'expired', updated_at = ?1
    WHERE status = 'asking' AND expires_at < ?1
  `).bind(now).run()
  return result.meta.changes ?? 0
}

// ===================================================================
// Delete
// ===================================================================

/**
 * answered 状態のレコードを物理削除（Phase C 完了後）
 */
export async function deleteClarification(
  db: D1Database,
  id: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM pending_clarifications WHERE id = ?1
  `).bind(id).run()
}
