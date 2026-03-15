/**
 * worker/src/state/runtime-state.ts
 * conversation_runtime_state の CRUD
 *
 * 正本テーブル: Consumer Worker が参照する唯一の状態源
 * 楽観的ロック: version カラムで競合検出
 */

import type { RuntimeState, WorkerEnv } from '../types'

/**
 * runtime_state をロードする。未存在なら null を返す。
 */
export async function loadRuntimeState(
  db: D1Database,
  userAccountId: string
): Promise<RuntimeState | null> {
  const row = await db.prepare(
    `SELECT * FROM conversation_runtime_state WHERE user_account_id = ?1`
  ).bind(userAccountId).first<RuntimeState>()

  if (!row) return null

  // 期限切れチェック: waiting_expires_at が過去なら waiting をクリア
  if (row.waiting_expires_at) {
    const expiresAt = new Date(row.waiting_expires_at).getTime()
    if (expiresAt < Date.now()) {
      console.log(`[RuntimeState] waiting expired for ${userAccountId}, resetting`)
      await db.prepare(`
        UPDATE conversation_runtime_state
        SET waiting_type = NULL,
            waiting_target_id = NULL,
            waiting_expires_at = NULL,
            updated_at = datetime('now')
        WHERE user_account_id = ?1
      `).bind(userAccountId).run()
      row.waiting_type = null
      row.waiting_target_id = null
      row.waiting_expires_at = null
    }
  }

  return row
}

/**
 * runtime_state を新規作成する。
 */
export async function createRuntimeState(
  db: D1Database,
  params: {
    userAccountId: string
    lineUserId: string
    clientAccountId: string
    currentMode?: 'record' | 'consult' | 'intake'
  }
): Promise<RuntimeState> {
  const mode = params.currentMode ?? 'record'
  await db.prepare(`
    INSERT INTO conversation_runtime_state
      (user_account_id, line_user_id, client_account_id, current_mode, version, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 1, datetime('now'), datetime('now'))
    ON CONFLICT(user_account_id) DO NOTHING
  `).bind(
    params.userAccountId,
    params.lineUserId,
    params.clientAccountId,
    mode
  ).run()

  return (await loadRuntimeState(db, params.userAccountId))!
}

/**
 * runtime_state を更新する（楽観的ロック付き）。
 * version が一致しない場合は例外を投げる。
 */
export async function updateRuntimeState(
  db: D1Database,
  userAccountId: string,
  currentVersion: number,
  updates: {
    currentMode?: 'record' | 'consult' | 'intake'
    waitingType?: string | null
    waitingTargetId?: string | null
    waitingExpiresAt?: string | null
    lastProcessedMessageId?: string | null
    lastProcessedAt?: string | null
  }
): Promise<RuntimeState> {
  const setClauses: string[] = []
  const values: (string | number | null)[] = []
  let paramIdx = 1

  if (updates.currentMode !== undefined) {
    setClauses.push(`current_mode = ?${paramIdx}`)
    values.push(updates.currentMode)
    paramIdx++
  }
  if (updates.waitingType !== undefined) {
    setClauses.push(`waiting_type = ?${paramIdx}`)
    values.push(updates.waitingType)
    paramIdx++
  }
  if (updates.waitingTargetId !== undefined) {
    setClauses.push(`waiting_target_id = ?${paramIdx}`)
    values.push(updates.waitingTargetId)
    paramIdx++
  }
  if (updates.waitingExpiresAt !== undefined) {
    setClauses.push(`waiting_expires_at = ?${paramIdx}`)
    values.push(updates.waitingExpiresAt)
    paramIdx++
  }
  if (updates.lastProcessedMessageId !== undefined) {
    setClauses.push(`last_processed_message_id = ?${paramIdx}`)
    values.push(updates.lastProcessedMessageId)
    paramIdx++
  }
  if (updates.lastProcessedAt !== undefined) {
    setClauses.push(`last_processed_at = ?${paramIdx}`)
    values.push(updates.lastProcessedAt)
    paramIdx++
  }

  // version increment + updated_at
  setClauses.push(`version = version + 1`)
  setClauses.push(`updated_at = datetime('now')`)

  // WHERE clause with optimistic lock
  const sql = `
    UPDATE conversation_runtime_state
    SET ${setClauses.join(', ')}
    WHERE user_account_id = ?${paramIdx} AND version = ?${paramIdx + 1}
  `
  values.push(userAccountId, currentVersion)

  const result = await db.prepare(sql).bind(...values).run()

  if (!result.meta.changed_db || (result.meta.changes ?? 0) === 0) {
    throw new Error(`[RuntimeState] Optimistic lock failed: userAccountId=${userAccountId}, expectedVersion=${currentVersion}`)
  }

  return (await loadRuntimeState(db, userAccountId))!
}

/**
 * 指定された line_user_id で runtime_state を検索する。
 */
export async function findRuntimeStateByLineUser(
  db: D1Database,
  lineUserId: string
): Promise<RuntimeState | null> {
  return db.prepare(
    `SELECT * FROM conversation_runtime_state WHERE line_user_id = ?1`
  ).bind(lineUserId).first<RuntimeState>()
}
