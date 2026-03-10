/**
 * body-metrics-repo.ts
 * 体重・体型測定値の読み書き
 *
 * 参照テーブル: body_metrics
 */

import type { BodyMetrics } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// body_metrics
// ===================================================================

/** daily_log_id で体型測定値を取得 */
export async function findBodyMetricsByDailyLog(
  db: D1Database,
  dailyLogId: string
): Promise<BodyMetrics | null> {
  const row = await db
    .prepare(`
      SELECT * FROM body_metrics
      WHERE daily_log_id = ?1
      LIMIT 1
    `)
    .bind(dailyLogId)
    .first<BodyMetrics>()
  return row ?? null
}

/** IDで取得 */
export async function findBodyMetricsById(
  db: D1Database,
  id: string
): Promise<BodyMetrics | null> {
  const row = await db
    .prepare('SELECT * FROM body_metrics WHERE id = ?1')
    .bind(id)
    .first<BodyMetrics>()
  return row ?? null
}

/**
 * 体重のみ upsert（テキスト入力・体重計画像 共通）
 * daily_log に1レコードだけ存在することを保証する
 */
export async function upsertWeight(
  db: D1Database,
  params: {
    dailyLogId: string
    weightKg: number
  }
): Promise<BodyMetrics> {
  const now = nowIso()

  // 既存レコード確認
  const existing = await findBodyMetricsByDailyLog(db, params.dailyLogId)

  if (existing) {
    await db
      .prepare(`
        UPDATE body_metrics
        SET weight_kg = ?1, updated_at = ?2
        WHERE id = ?3
      `)
      .bind(params.weightKg, now, existing.id)
      .run()
    return (await findBodyMetricsById(db, existing.id))!
  } else {
    const id = generateId()
    await db
      .prepare(`
        INSERT INTO body_metrics
          (id, daily_log_id, weight_kg, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?4)
      `)
      .bind(id, params.dailyLogId, params.weightKg, now)
      .run()
    return (await findBodyMetricsById(db, id))!
  }
}

/**
 * 体型測定値をフル upsert（体重以外も含む場合）
 */
export async function upsertBodyMetrics(
  db: D1Database,
  params: {
    dailyLogId: string
    weightKg?: number | null
    waistCm?: number | null
    bodyFatPercent?: number | null
    temperatureC?: number | null
    edemaFlag?: number | null
  }
): Promise<BodyMetrics> {
  const now = nowIso()
  const existing = await findBodyMetricsByDailyLog(db, params.dailyLogId)

  if (existing) {
    await db
      .prepare(`
        UPDATE body_metrics SET
          weight_kg        = COALESCE(?1, weight_kg),
          waist_cm         = COALESCE(?2, waist_cm),
          body_fat_percent = COALESCE(?3, body_fat_percent),
          temperature_c    = COALESCE(?4, temperature_c),
          edema_flag       = COALESCE(?5, edema_flag),
          updated_at       = ?6
        WHERE id = ?7
      `)
      .bind(
        params.weightKg ?? null,
        params.waistCm ?? null,
        params.bodyFatPercent ?? null,
        params.temperatureC ?? null,
        params.edemaFlag ?? null,
        now,
        existing.id
      )
      .run()
    return (await findBodyMetricsById(db, existing.id))!
  } else {
    const id = generateId()
    await db
      .prepare(`
        INSERT INTO body_metrics
          (id, daily_log_id, weight_kg, waist_cm, body_fat_percent, temperature_c, edema_flag, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      `)
      .bind(
        id,
        params.dailyLogId,
        params.weightKg ?? null,
        params.waistCm ?? null,
        params.bodyFatPercent ?? null,
        params.temperatureC ?? null,
        params.edemaFlag ?? null,
        now
      )
      .run()
    return (await findBodyMetricsById(db, id))!
  }
}

/** ユーザーの体重推移を取得（グラフ用） */
export async function listWeightHistory(
  db: D1Database,
  userAccountId: string,
  limit = 30
): Promise<Array<{ log_date: string; weight_kg: number | null }>> {
  const { results } = await db
    .prepare(`
      SELECT dl.log_date, bm.weight_kg
      FROM body_metrics bm
      JOIN daily_logs dl ON bm.daily_log_id = dl.id
      WHERE dl.user_account_id = ?1
        AND bm.weight_kg IS NOT NULL
      ORDER BY dl.log_date DESC
      LIMIT ?2
    `)
    .bind(userAccountId, limit)
    .all<{ log_date: string; weight_kg: number | null }>()
  return results.reverse()   // 古い順で返す（グラフ向け）
}
