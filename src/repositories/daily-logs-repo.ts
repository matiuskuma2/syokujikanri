/**
 * daily-logs-repo.ts
 * 日次ログの読み書き（1日1件を保証する親レコード）
 *
 * 参照テーブル: daily_logs
 */

import type { DailyLog } from '../types/db'
import { generateId, nowIso, todayJst } from '../utils/id'

// ===================================================================
// daily_logs
// ===================================================================

/** ユーザーと日付でログを取得 */
export async function findDailyLogByUserAndDate(
  db: D1Database,
  userAccountId: string,
  logDate: string   // YYYY-MM-DD
): Promise<DailyLog | null> {
  const row = await db
    .prepare(`
      SELECT * FROM daily_logs
      WHERE user_account_id = ?1 AND log_date = ?2
    `)
    .bind(userAccountId, logDate)
    .first<DailyLog>()
  return row ?? null
}

/** IDで取得 */
export async function findDailyLogById(
  db: D1Database,
  id: string
): Promise<DailyLog | null> {
  const row = await db
    .prepare('SELECT * FROM daily_logs WHERE id = ?1')
    .bind(id)
    .first<DailyLog>()
  return row ?? null
}

/** 日次ログを作成 */
export async function createDailyLog(
  db: D1Database,
  params: {
    userAccountId: string
    clientAccountId: string
    logDate?: string   // 省略で today JST
    source?: DailyLog['source']
  }
): Promise<DailyLog> {
  const id = generateId()
  const now = nowIso()
  const logDate = params.logDate ?? todayJst()
  await db
    .prepare(`
      INSERT INTO daily_logs
        (id, user_account_id, client_account_id, log_date, source, completion_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'partial', ?6, ?6)
    `)
    .bind(
      id,
      params.userAccountId,
      params.clientAccountId,
      logDate,
      params.source ?? 'line',
      now
    )
    .run()
  return (await findDailyLogById(db, id))!
}

/**
 * 今日の日次ログを取得または作成（最頻出操作）
 * LINE でメッセージを受け取るたびに呼ぶ
 */
export async function ensureDailyLog(
  db: D1Database,
  params: {
    userAccountId: string
    clientAccountId: string
    logDate?: string
  }
): Promise<DailyLog> {
  const logDate = params.logDate ?? todayJst()
  const existing = await findDailyLogByUserAndDate(db, params.userAccountId, logDate)
  if (existing) return existing
  return createDailyLog(db, { ...params, logDate })
}

/** completion_status を更新 */
export async function updateDailyLogCompletionStatus(
  db: D1Database,
  dailyLogId: string,
  status: DailyLog['completion_status']
): Promise<void> {
  await db
    .prepare(`
      UPDATE daily_logs
      SET completion_status = ?1, updated_at = ?2
      WHERE id = ?3
    `)
    .bind(status, nowIso(), dailyLogId)
    .run()
}

/** AI フィードバックを保存 */
export async function updateDailyLogFeedback(
  db: D1Database,
  dailyLogId: string,
  aiFeedback: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE daily_logs
      SET ai_feedback = ?1, updated_at = ?2
      WHERE id = ?3
    `)
    .bind(aiFeedback, nowIso(), dailyLogId)
    .run()
}

/** ユーザーの直近N件のログを取得（dashboard・weekly report 用） */
export async function listRecentDailyLogs(
  db: D1Database,
  userAccountId: string,
  limit = 14
): Promise<DailyLog[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM daily_logs
      WHERE user_account_id = ?1
      ORDER BY log_date DESC
      LIMIT ?2
    `)
    .bind(userAccountId, limit)
    .all<DailyLog>()
  return results
}

/** 日付範囲でのログ一覧（週次レポート生成用） */
export async function listDailyLogsByDateRange(
  db: D1Database,
  userAccountId: string,
  startDate: string,   // YYYY-MM-DD
  endDate: string      // YYYY-MM-DD
): Promise<DailyLog[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM daily_logs
      WHERE user_account_id = ?1
        AND log_date BETWEEN ?2 AND ?3
      ORDER BY log_date ASC
    `)
    .bind(userAccountId, startDate, endDate)
    .all<DailyLog>()
  return results
}

/** 前日ログが存在するか確認（Cron リマインダー用） */
export async function hasLogForDate(
  db: D1Database,
  userAccountId: string,
  logDate: string
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT id FROM daily_logs
      WHERE user_account_id = ?1 AND log_date = ?2
    `)
    .bind(userAccountId, logDate)
    .first<{ id: string }>()
  return row !== null
}
