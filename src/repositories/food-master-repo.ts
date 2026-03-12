/**
 * food-master-repo.ts
 * 食品マスターDB の検索・マッチング
 *
 * 参照テーブル: food_master, food_name_mappings
 *
 * 主な用途:
 *   1. AI 画像解析で抽出された食品名を food_master にマッチング
 *   2. ユーザーが入力した食品名の標準PFC値を取得
 *   3. マッチング結果を food_name_mappings にキャッシュ
 */

import { generateId, nowIso } from '../utils/id'

// ===================================================================
// 型定義
// ===================================================================

export interface FoodMasterItem {
  id: string
  name: string
  aliases: string | null
  category: string
  serving_size_g: number
  serving_label: string | null
  calories_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  fiber_g: number | null
  salt_g: number | null
  sugar_g: number | null
  vegetable_g: number | null
  source: string | null
  confidence: string
}

export interface FoodMatchResult {
  food: FoodMasterItem
  matchScore: number
  matchSource: 'exact' | 'alias' | 'mapping' | 'like'
}

// ===================================================================
// 食品名検索・マッチング
// ===================================================================

/**
 * 食品名で food_master を検索する。
 * 検索優先度:
 *   1. food_name_mappings のキャッシュ（完全一致）
 *   2. food_master.name の完全一致
 *   3. food_master.aliases のJSON配列内を LIKE 検索
 *   4. food_master.name の LIKE 部分一致
 *
 * @param rawName AI出力またはユーザー入力の食品名
 * @returns マッチした食品情報（最良の1件）またはnull
 */
export async function findFoodByName(
  db: D1Database,
  rawName: string
): Promise<FoodMatchResult | null> {
  const normalizedName = normalizeFoodName(rawName)

  // 1. food_name_mappings のキャッシュ
  const cached = await db
    .prepare(`
      SELECT fm.*, fnm.match_score
      FROM food_name_mappings fnm
      JOIN food_master fm ON fm.id = fnm.food_master_id
      WHERE fnm.raw_name = ?1 AND fm.is_active = 1
      ORDER BY fnm.match_score DESC
      LIMIT 1
    `)
    .bind(normalizedName)
    .first<FoodMasterItem & { match_score: number }>()

  if (cached) {
    const { match_score, ...food } = cached
    return { food, matchScore: match_score, matchSource: 'mapping' }
  }

  // 2. food_master.name の完全一致
  const exact = await db
    .prepare('SELECT * FROM food_master WHERE name = ?1 AND is_active = 1 LIMIT 1')
    .bind(normalizedName)
    .first<FoodMasterItem>()

  if (exact) {
    // キャッシュに保存
    await saveFoodNameMapping(db, normalizedName, exact.id, 1.0)
    return { food: exact, matchScore: 1.0, matchSource: 'exact' }
  }

  // 3. aliases のJSON配列内を LIKE 検索
  const aliasMatch = await db
    .prepare(`
      SELECT * FROM food_master
      WHERE is_active = 1 AND aliases LIKE ?1
      LIMIT 1
    `)
    .bind(`%"${normalizedName}"%`)
    .first<FoodMasterItem>()

  if (aliasMatch) {
    await saveFoodNameMapping(db, normalizedName, aliasMatch.id, 0.9)
    return { food: aliasMatch, matchScore: 0.9, matchSource: 'alias' }
  }

  // 4. food_master.name の LIKE 部分一致
  const likeMatch = await db
    .prepare(`
      SELECT * FROM food_master
      WHERE is_active = 1 AND (name LIKE ?1 OR name LIKE ?2)
      ORDER BY
        CASE WHEN name LIKE ?1 THEN 0 ELSE 1 END,
        LENGTH(name) ASC
      LIMIT 1
    `)
    .bind(`${normalizedName}%`, `%${normalizedName}%`)
    .first<FoodMasterItem>()

  if (likeMatch) {
    await saveFoodNameMapping(db, normalizedName, likeMatch.id, 0.7)
    return { food: likeMatch, matchScore: 0.7, matchSource: 'like' }
  }

  return null
}

/**
 * 複数の食品名を一括でマッチングする
 * AI画像解析結果の食品リストに対して使用
 */
export async function matchFoodItems(
  db: D1Database,
  foodNames: string[]
): Promise<Map<string, FoodMatchResult | null>> {
  const results = new Map<string, FoodMatchResult | null>()
  for (const name of foodNames) {
    const match = await findFoodByName(db, name)
    results.set(name, match)
  }
  return results
}

/**
 * マッチング結果からPFC合計を計算する
 */
export function calculateTotalNutrition(
  matches: Map<string, FoodMatchResult | null>
): {
  totalCalories: number
  totalProtein: number
  totalFat: number
  totalCarbs: number
  totalSalt: number
  matchedCount: number
  unmatchedNames: string[]
} {
  let totalCalories = 0
  let totalProtein = 0
  let totalFat = 0
  let totalCarbs = 0
  let totalSalt = 0
  let matchedCount = 0
  const unmatchedNames: string[] = []

  for (const [name, result] of matches) {
    if (result) {
      matchedCount++
      totalCalories += result.food.calories_kcal ?? 0
      totalProtein += result.food.protein_g ?? 0
      totalFat += result.food.fat_g ?? 0
      totalCarbs += result.food.carbs_g ?? 0
      totalSalt += result.food.salt_g ?? 0
    } else {
      unmatchedNames.push(name)
    }
  }

  return {
    totalCalories: Math.round(totalCalories),
    totalProtein: Math.round(totalProtein * 10) / 10,
    totalFat: Math.round(totalFat * 10) / 10,
    totalCarbs: Math.round(totalCarbs * 10) / 10,
    totalSalt: Math.round(totalSalt * 10) / 10,
    matchedCount,
    unmatchedNames,
  }
}

// ===================================================================
// 食品名正規化
// ===================================================================

/**
 * 食品名を正規化する
 * - 全角→半角
 * - カタカナ→ひらがな変換はしない（日本食品名はカタカナ混在が多い）
 * - 余計な空白・記号を除去
 * - 「〜の」「〜風」などの修飾語はそのまま保持
 */
function normalizeFoodName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '')                         // 空白除去
    .replace(/[（(]/g, '(')                      // 全角括弧→半角
    .replace(/[）)]/g, ')')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>       // 全角英数→半角
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    )
    .replace(/\(.*?\)/g, '')                     // 括弧内を除去（"白米(150g)"→"白米"）
    .replace(/[、。,.\s]/g, '')                   // 句読点・空白除去
}

// ===================================================================
// food_name_mappings キャッシュ
// ===================================================================

async function saveFoodNameMapping(
  db: D1Database,
  rawName: string,
  foodMasterId: string,
  matchScore: number
): Promise<void> {
  try {
    await db
      .prepare(`
        INSERT INTO food_name_mappings (id, raw_name, food_master_id, match_score, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(raw_name, food_master_id) DO UPDATE SET
          match_score = ?4,
          created_at = ?5
      `)
      .bind(generateId(), rawName, foodMasterId, matchScore, nowIso())
      .run()
  } catch (err) {
    // マッピング保存失敗は致命的ではない
    console.warn('[FoodMaster] mapping save failed:', err)
  }
}

// ===================================================================
// 食品カテゴリ検索
// ===================================================================

/** カテゴリ別に食品を一覧取得（管理画面用） */
export async function listFoodsByCategory(
  db: D1Database,
  category: string,
  limit = 50,
  offset = 0
): Promise<FoodMasterItem[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM food_master
      WHERE category = ?1 AND is_active = 1
      ORDER BY name ASC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(category, limit, offset)
    .all<FoodMasterItem>()
  return results
}

/** 食品マスターの件数を取得 */
export async function countFoodMaster(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) as cnt FROM food_master WHERE is_active = 1')
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}
