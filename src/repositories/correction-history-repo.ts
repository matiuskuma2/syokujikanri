/**
 * correction-history-repo.ts
 * 記録修正履歴のリポジトリ
 *
 * 正本: docs/12_記録確認フローSSOT.md §4
 */

import { generateId, nowIso } from '../utils/id'
import type { CorrectionHistory, CorrectionType } from '../types/intent'

// ===================================================================
// Create
// ===================================================================

/**
 * 修正履歴を記録する
 */
export async function createCorrectionHistory(
  db: D1Database,
  params: {
    userAccountId: string
    targetTable: 'meal_entries' | 'body_metrics' | 'daily_logs'
    targetRecordId: string
    correctionType: CorrectionType
    oldValueJson: string
    newValueJson: string | null
    triggeredBy?: 'user' | 'system' | 'admin'
    messageId?: string | null
    reason?: string | null
  }
): Promise<CorrectionHistory> {
  const id = generateId()
  const now = nowIso()

  await db.prepare(`
    INSERT INTO correction_history
      (id, user_account_id, target_table, target_record_id,
       correction_type, old_value_json, new_value_json,
       triggered_by, message_id, reason, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `).bind(
    id,
    params.userAccountId,
    params.targetTable,
    params.targetRecordId,
    params.correctionType,
    params.oldValueJson,
    params.newValueJson,
    params.triggeredBy ?? 'user',
    params.messageId ?? null,
    params.reason ?? null,
    now
  ).run()

  return {
    id,
    user_account_id: params.userAccountId,
    target_table: params.targetTable,
    target_record_id: params.targetRecordId,
    correction_type: params.correctionType,
    old_value_json: params.oldValueJson,
    new_value_json: params.newValueJson ?? null,
    triggered_by: params.triggeredBy ?? 'user',
    message_id: params.messageId ?? null,
    reason: params.reason ?? null,
    created_at: now,
  }
}

// ===================================================================
// Read
// ===================================================================

/**
 * ユーザーの修正履歴を取得（新しい順）
 */
export async function findCorrectionsByUser(
  db: D1Database,
  userAccountId: string,
  limit: number = 20
): Promise<CorrectionHistory[]> {
  const results = await db.prepare(`
    SELECT * FROM correction_history
    WHERE user_account_id = ?1
    ORDER BY created_at DESC
    LIMIT ?2
  `).bind(userAccountId, limit).all<CorrectionHistory>()
  return results.results ?? []
}

/**
 * 特定レコードの修正履歴を取得
 */
export async function findCorrectionsByTarget(
  db: D1Database,
  targetTable: string,
  targetRecordId: string
): Promise<CorrectionHistory[]> {
  const results = await db.prepare(`
    SELECT * FROM correction_history
    WHERE target_table = ?1 AND target_record_id = ?2
    ORDER BY created_at DESC
  `).bind(targetTable, targetRecordId).all<CorrectionHistory>()
  return results.results ?? []
}

/**
 * 修正履歴をIDで取得
 */
export async function findCorrectionById(
  db: D1Database,
  id: string
): Promise<CorrectionHistory | null> {
  return db.prepare(`
    SELECT * FROM correction_history WHERE id = ?1
  `).bind(id).first<CorrectionHistory>()
}
