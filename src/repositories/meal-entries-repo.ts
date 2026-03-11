/**
 * meal-entries-repo.ts
 * 食事記録の読み書き
 *
 * 参照テーブル: meal_entries
 */

import type { MealEntry } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// meal_entries
// ===================================================================

/** daily_log_id で全食事記録を取得 */
export async function findMealEntriesByDailyLog(
  db: D1Database,
  dailyLogId: string
): Promise<MealEntry[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM meal_entries
      WHERE daily_log_id = ?1
      ORDER BY
        CASE meal_type
          WHEN 'breakfast' THEN 1
          WHEN 'lunch'     THEN 2
          WHEN 'dinner'    THEN 3
          WHEN 'snack'     THEN 4
          ELSE 5
        END,
        created_at ASC
    `)
    .bind(dailyLogId)
    .all<MealEntry>()
  return results
}

/**
 * 複数の daily_log_id に紐づく全食事記録を一括取得（N+1 解消用）
 * D1 は IN 句のパラメータバインドをサポートしないため、
 * 安全に値をエスケープした上で IN 句を構築する。
 * daily_log_id は内部生成の generateId() (nanoid) のみが入るため安全。
 */
export async function listMealEntriesByDailyLogIds(
  db: D1Database,
  dailyLogIds: string[]
): Promise<MealEntry[]> {
  if (dailyLogIds.length === 0) return []

  // D1 は配列バインドをサポートしないため、プレースホルダを個別に生成
  const placeholders = dailyLogIds.map((_, i) => `?${i + 1}`).join(',')
  const { results } = await db
    .prepare(`
      SELECT * FROM meal_entries
      WHERE daily_log_id IN (${placeholders})
      ORDER BY
        daily_log_id,
        CASE meal_type
          WHEN 'breakfast' THEN 1
          WHEN 'lunch'     THEN 2
          WHEN 'dinner'    THEN 3
          WHEN 'snack'     THEN 4
          ELSE 5
        END,
        created_at ASC
    `)
    .bind(...dailyLogIds)
    .all<MealEntry>()
  return results
}

/** daily_log_id + meal_type で1件取得 */
export async function findMealEntryByDailyLogAndType(
  db: D1Database,
  dailyLogId: string,
  mealType: MealEntry['meal_type']
): Promise<MealEntry | null> {
  const row = await db
    .prepare(`
      SELECT * FROM meal_entries
      WHERE daily_log_id = ?1 AND meal_type = ?2
      LIMIT 1
    `)
    .bind(dailyLogId, mealType)
    .first<MealEntry>()
  return row ?? null
}

/** IDで取得 */
export async function findMealEntryById(
  db: D1Database,
  id: string
): Promise<MealEntry | null> {
  const row = await db
    .prepare('SELECT * FROM meal_entries WHERE id = ?1')
    .bind(id)
    .first<MealEntry>()
  return row ?? null
}

/** 食事記録を作成 */
export async function createMealEntry(
  db: D1Database,
  params: {
    dailyLogId: string
    mealType: MealEntry['meal_type']
    mealText?: string | null
    consumedAt?: string | null
    caloriesKcal?: number | null
    proteinG?: number | null
    fatG?: number | null
    carbsG?: number | null
    confirmationStatus?: MealEntry['confirmation_status']
  }
): Promise<MealEntry> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO meal_entries
        (id, daily_log_id, meal_type, consumed_at, meal_text, photo_count,
         calories_kcal, protein_g, fat_g, carbs_g,
         confirmation_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    `)
    .bind(
      id,
      params.dailyLogId,
      params.mealType,
      params.consumedAt ?? null,
      params.mealText ?? null,
      params.caloriesKcal ?? null,
      params.proteinG ?? null,
      params.fatG ?? null,
      params.carbsG ?? null,
      params.confirmationStatus ?? 'draft',
      now
    )
    .run()
  return (await findMealEntryById(db, id))!
}

/**
 * AI 推定値でmeal_entryを更新（画像解析後に呼ぶ）
 */
export async function updateMealEntryFromEstimate(
  db: D1Database,
  id: string,
  params: {
    mealText?: string | null
    caloriesKcal?: number | null
    proteinG?: number | null
    fatG?: number | null
    carbsG?: number | null
    confirmationStatus?: MealEntry['confirmation_status']
  }
): Promise<void> {
  const now = nowIso()
  await db
    .prepare(`
      UPDATE meal_entries SET
        meal_text           = COALESCE(?1, meal_text),
        calories_kcal       = COALESCE(?2, calories_kcal),
        protein_g           = COALESCE(?3, protein_g),
        fat_g               = COALESCE(?4, fat_g),
        carbs_g             = COALESCE(?5, carbs_g),
        confirmation_status = COALESCE(?6, confirmation_status),
        updated_at          = ?7
      WHERE id = ?8
    `)
    .bind(
      params.mealText ?? null,
      params.caloriesKcal ?? null,
      params.proteinG ?? null,
      params.fatG ?? null,
      params.carbsG ?? null,
      params.confirmationStatus ?? null,
      now,
      id
    )
    .run()
}

/** 写真枚数をインクリメント */
export async function incrementMealPhotoCount(
  db: D1Database,
  mealEntryId: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE meal_entries
      SET photo_count = photo_count + 1, updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), mealEntryId)
    .run()
}

/** 確認ステータスを更新（ユーザーが「OK」を押した後） */
export async function confirmMealEntry(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE meal_entries
      SET confirmation_status = 'confirmed', updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), id)
    .run()
}
