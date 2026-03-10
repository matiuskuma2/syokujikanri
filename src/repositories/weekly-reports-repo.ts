/**
 * weekly-reports-repo.ts
 * 週次レポートの読み書き
 *
 * 参照テーブル: weekly_reports
 */

import type { WeeklyReport } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// weekly_reports
// ===================================================================

/** IDで取得 */
export async function findWeeklyReportById(
  db: D1Database,
  id: string
): Promise<WeeklyReport | null> {
  const row = await db
    .prepare('SELECT * FROM weekly_reports WHERE id = ?1')
    .bind(id)
    .first<WeeklyReport>()
  return row ?? null
}

/** ユーザーと週開始日で取得 */
export async function findWeeklyReportByUserAndWeek(
  db: D1Database,
  userAccountId: string,
  weekStart: string   // YYYY-MM-DD（月曜日）
): Promise<WeeklyReport | null> {
  const row = await db
    .prepare(`
      SELECT * FROM weekly_reports
      WHERE user_account_id = ?1 AND week_start = ?2
    `)
    .bind(userAccountId, weekStart)
    .first<WeeklyReport>()
  return row ?? null
}

/** ユーザーの週次レポート一覧（新しい順） */
export async function listWeeklyReportsByUser(
  db: D1Database,
  userAccountId: string,
  limit = 12
): Promise<WeeklyReport[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM weekly_reports
      WHERE user_account_id = ?1
      ORDER BY week_start DESC
      LIMIT ?2
    `)
    .bind(userAccountId, limit)
    .all<WeeklyReport>()
  return results
}

/** 週次レポートを upsert（Cron で毎週作成） */
export async function upsertWeeklyReport(
  db: D1Database,
  params: {
    userAccountId: string
    weekStart: string
    weekEnd: string
    avgWeightKg?: number | null
    minWeightKg?: number | null
    maxWeightKg?: number | null
    weightChange?: number | null
    totalSteps?: number | null
    avgSteps?: number | null
    avgSleepHours?: number | null
    avgWaterMl?: number | null
    mealLogCount?: number | null
    logDays?: number | null
    aiSummary?: string | null
    sentAt?: string | null
  }
): Promise<WeeklyReport> {
  const now = nowIso()
  const existing = await findWeeklyReportByUserAndWeek(
    db,
    params.userAccountId,
    params.weekStart
  )

  if (existing) {
    await db
      .prepare(`
        UPDATE weekly_reports SET
          avg_weight_kg  = COALESCE(?1, avg_weight_kg),
          min_weight_kg  = COALESCE(?2, min_weight_kg),
          max_weight_kg  = COALESCE(?3, max_weight_kg),
          weight_change  = COALESCE(?4, weight_change),
          total_steps    = COALESCE(?5, total_steps),
          avg_steps      = COALESCE(?6, avg_steps),
          avg_sleep_hours = COALESCE(?7, avg_sleep_hours),
          avg_water_ml   = COALESCE(?8, avg_water_ml),
          meal_log_count = COALESCE(?9, meal_log_count),
          log_days       = COALESCE(?10, log_days),
          ai_summary     = COALESCE(?11, ai_summary),
          sent_at        = COALESCE(?12, sent_at)
        WHERE id = ?13
      `)
      .bind(
        params.avgWeightKg ?? null,
        params.minWeightKg ?? null,
        params.maxWeightKg ?? null,
        params.weightChange ?? null,
        params.totalSteps ?? null,
        params.avgSteps ?? null,
        params.avgSleepHours ?? null,
        params.avgWaterMl ?? null,
        params.mealLogCount ?? null,
        params.logDays ?? null,
        params.aiSummary ?? null,
        params.sentAt ?? null,
        existing.id
      )
      .run()
    return (await findWeeklyReportById(db, existing.id))!
  } else {
    const id = generateId()
    await db
      .prepare(`
        INSERT INTO weekly_reports
          (id, user_account_id, week_start, week_end,
           avg_weight_kg, min_weight_kg, max_weight_kg, weight_change,
           total_steps, avg_steps, avg_sleep_hours, avg_water_ml,
           meal_log_count, log_days, ai_summary, sent_at, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      `)
      .bind(
        id,
        params.userAccountId,
        params.weekStart,
        params.weekEnd,
        params.avgWeightKg ?? null,
        params.minWeightKg ?? null,
        params.maxWeightKg ?? null,
        params.weightChange ?? null,
        params.totalSteps ?? null,
        params.avgSteps ?? null,
        params.avgSleepHours ?? null,
        params.avgWaterMl ?? null,
        params.mealLogCount ?? null,
        params.logDays ?? null,
        params.aiSummary ?? null,
        params.sentAt ?? null,
        now
      )
      .run()
    return (await findWeeklyReportById(db, id))!
  }
}
