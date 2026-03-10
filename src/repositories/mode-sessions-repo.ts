/**
 * mode-sessions-repo.ts
 * BOT モードセッション（record / consult / intake）の管理
 *
 * 参照テーブル: bot_mode_sessions
 */

import type { BotModeSession } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// BOT セッション TTL ヘルパー
// ===================================================================

/** TTL（時間単位）からexpires_at文字列を計算 */
function calcExpiresAt(ttlHours: number): string {
  const d = new Date(Date.now() + ttlHours * 60 * 60 * 1000)
  return d.toISOString().replace('T', ' ').substring(0, 19)
}

// ===================================================================
// bot_mode_sessions
// ===================================================================

/** アクティブなセッションを取得 */
export async function findActiveModeSession(
  db: D1Database,
  clientAccountId: string,
  lineUserId: string
): Promise<BotModeSession | null> {
  const now = nowIso()
  const row = await db
    .prepare(`
      SELECT * FROM bot_mode_sessions
      WHERE client_account_id = ?1
        AND line_user_id = ?2
        AND expires_at > ?3
      LIMIT 1
    `)
    .bind(clientAccountId, lineUserId, now)
    .first<BotModeSession>()
  return row ?? null
}

/** IDでセッションを取得 */
export async function findModeSessionById(
  db: D1Database,
  sessionId: string
): Promise<BotModeSession | null> {
  const row = await db
    .prepare('SELECT * FROM bot_mode_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<BotModeSession>()
  return row ?? null
}

/** セッションを作成 */
export async function createModeSession(
  db: D1Database,
  params: {
    clientAccountId: string
    lineUserId: string
    currentMode: BotModeSession['current_mode']
    currentStep: string
    sessionData?: Record<string, unknown> | null
    ttlHours?: number
  }
): Promise<BotModeSession> {
  const id = generateId()
  const now = nowIso()
  const expiresAt = calcExpiresAt(params.ttlHours ?? 24)
  const sessionDataJson = params.sessionData
    ? JSON.stringify(params.sessionData)
    : null

  await db
    .prepare(`
      INSERT INTO bot_mode_sessions
        (id, client_account_id, line_user_id, current_mode, current_step,
         session_data, turn_count, expires_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)
    `)
    .bind(
      id,
      params.clientAccountId,
      params.lineUserId,
      params.currentMode,
      params.currentStep,
      sessionDataJson,
      expiresAt,
      now
    )
    .run()

  return (await findModeSessionById(db, id))!
}

/** セッションをupsert（最も一般的な操作） */
export async function upsertModeSession(
  db: D1Database,
  params: {
    clientAccountId: string
    lineUserId: string
    currentMode: BotModeSession['current_mode']
    currentStep: string
    sessionData?: Record<string, unknown> | null
    ttlHours?: number
  }
): Promise<BotModeSession> {
  const now = nowIso()
  const expiresAt = calcExpiresAt(params.ttlHours ?? 24)
  const sessionDataJson = params.sessionData
    ? JSON.stringify(params.sessionData)
    : null

  // 既存セッションを確認
  const existing = await db
    .prepare(`
      SELECT id FROM bot_mode_sessions
      WHERE client_account_id = ?1 AND line_user_id = ?2
    `)
    .bind(params.clientAccountId, params.lineUserId)
    .first<{ id: string }>()

  if (existing) {
    await db
      .prepare(`
        UPDATE bot_mode_sessions SET
          current_mode = ?1,
          current_step = ?2,
          session_data = ?3,
          turn_count   = turn_count + 1,
          expires_at   = ?4,
          updated_at   = ?5
        WHERE client_account_id = ?6 AND line_user_id = ?7
      `)
      .bind(
        params.currentMode,
        params.currentStep,
        sessionDataJson,
        expiresAt,
        now,
        params.clientAccountId,
        params.lineUserId
      )
      .run()
    return (await findModeSessionById(db, existing.id))!
  } else {
    return createModeSession(db, params)
  }
}

/** セッションのステップとデータを更新 */
export async function updateSessionStep(
  db: D1Database,
  sessionId: string,
  params: {
    currentStep: string
    sessionData?: Record<string, unknown> | null
    ttlHours?: number
  }
): Promise<void> {
  const now = nowIso()
  const expiresAt = calcExpiresAt(params.ttlHours ?? 24)
  const sessionDataJson = params.sessionData
    ? JSON.stringify(params.sessionData)
    : null
  await db
    .prepare(`
      UPDATE bot_mode_sessions SET
        current_step = ?1,
        session_data = ?2,
        turn_count   = turn_count + 1,
        expires_at   = ?3,
        updated_at   = ?4
      WHERE id = ?5
    `)
    .bind(params.currentStep, sessionDataJson, expiresAt, now, sessionId)
    .run()
}

/** セッションを削除（モード終了時） */
export async function deleteModeSession(
  db: D1Database,
  clientAccountId: string,
  lineUserId: string
): Promise<void> {
  await db
    .prepare(`
      DELETE FROM bot_mode_sessions
      WHERE client_account_id = ?1 AND line_user_id = ?2
    `)
    .bind(clientAccountId, lineUserId)
    .run()
}

/** 期限切れセッションを一括削除（Cron用） */
export async function deleteExpiredSessions(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`
      DELETE FROM bot_mode_sessions
      WHERE expires_at <= ?1
    `)
    .bind(nowIso())
    .run()
  return result.meta.changes ?? 0
}
