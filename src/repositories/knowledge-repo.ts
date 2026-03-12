/**
 * knowledge-repo.ts
 * ナレッジベース・ドキュメント・BOTプロンプトの読み書き
 *
 * 参照テーブル: knowledge_bases, knowledge_documents, bot_knowledge_links, bots, bot_versions
 */

import type { Bindings } from '../types/bindings'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// 型定義
// ===================================================================

export interface KnowledgeDocument {
  id: string
  knowledge_base_id: string
  title: string
  content: string
  source_url: string | null
  is_active: number
  priority: number
  created_at: string
  updated_at: string
}

export interface BotVersion {
  id: string
  bot_id: string
  version_number: number
  system_prompt: string | null
  config: string | null
  is_published: number
  created_at: string
}

// ===================================================================
// BOT プロンプト取得
// ===================================================================

/**
 * 指定アカウントのアクティブ BOT の公開済み system_prompt を取得する。
 * bot → bot_versions の公開バージョンを参照。
 * 見つからなければ null を返す。
 */
export async function getPublishedSystemPrompt(
  db: D1Database,
  accountId: string
): Promise<string | null> {
  const row = await db
    .prepare(`
      SELECT bv.system_prompt
      FROM bots b
      JOIN bot_versions bv ON bv.bot_id = b.id
      WHERE b.account_id = ?1
        AND b.is_active = 1
        AND bv.is_published = 1
      ORDER BY bv.version_number DESC
      LIMIT 1
    `)
    .bind(accountId)
    .first<{ system_prompt: string | null }>()
  return row?.system_prompt ?? null
}

// ===================================================================
// ナレッジ検索（キーワードベース）
// ===================================================================

/**
 * BOT に紐付くナレッジドキュメントからキーワード検索する。
 * Cloudflare D1 には全文検索がないため LIKE ベースの簡易検索。
 * 将来的に embedding + vectorize に移行可能。
 *
 * 検索戦略:
 *   1. bot_knowledge_links → knowledge_bases → knowledge_documents を辿る
 *   2. ユーザーのクエリに含まれるキーワードで LIKE マッチ
 *   3. priority 順に上位 N 件を返す
 */
export async function searchKnowledgeForBot(
  db: D1Database,
  accountId: string,
  query: string,
  limit = 5
): Promise<KnowledgeDocument[]> {
  // クエリからキーワードを抽出（2文字以上）
  const keywords = extractKeywords(query)

  if (keywords.length === 0) {
    // キーワードなし → 優先度順に上位ドキュメントを返す（一般的な知識）
    const { results } = await db
      .prepare(`
        SELECT kd.*
        FROM knowledge_documents kd
        JOIN knowledge_bases kb ON kb.id = kd.knowledge_base_id
        LEFT JOIN bot_knowledge_links bkl ON bkl.knowledge_base_id = kb.id
        LEFT JOIN bots b ON b.id = bkl.bot_id
        WHERE kd.is_active = 1
          AND kb.is_active = 1
          AND (kb.account_id IS NULL OR kb.account_id = ?1)
          AND (b.account_id IS NULL OR b.account_id = ?1)
        ORDER BY kd.priority DESC, kb.priority DESC
        LIMIT ?2
      `)
      .bind(accountId, limit)
      .all<KnowledgeDocument>()
    return results
  }

  // LIKE ベースのキーワード検索
  // 最大3キーワードで OR 検索
  const topKeywords = keywords.slice(0, 3)
  const likeClauses = topKeywords.map((_, i) => `(kd.title LIKE ?${i + 3} OR kd.content LIKE ?${i + 3})`).join(' OR ')

  const sql = `
    SELECT kd.*, kb.priority AS kb_priority
    FROM knowledge_documents kd
    JOIN knowledge_bases kb ON kb.id = kd.knowledge_base_id
    LEFT JOIN bot_knowledge_links bkl ON bkl.knowledge_base_id = kb.id
    LEFT JOIN bots b ON b.id = bkl.bot_id
    WHERE kd.is_active = 1
      AND kb.is_active = 1
      AND (kb.account_id IS NULL OR kb.account_id = ?1)
      AND (b.account_id IS NULL OR b.account_id = ?1)
      AND (${likeClauses})
    ORDER BY kd.priority DESC, kb.priority DESC
    LIMIT ?2
  `

  const bindings: (string | number)[] = [accountId, limit]
  for (const kw of topKeywords) {
    bindings.push(`%${kw}%`)
  }

  const stmt = db.prepare(sql)
  const { results } = await stmt.bind(...bindings).all<KnowledgeDocument>()
  return results
}

/**
 * 日本語テキストからキーワードを抽出する簡易関数
 * 助詞・接続詞を除去し、2文字以上の単語を返す
 */
function extractKeywords(text: string): string[] {
  // 日本語の一般的な助詞・接続詞・停止語
  const stopWords = new Set([
    'は', 'が', 'の', 'を', 'に', 'へ', 'で', 'と', 'や', 'も', 'か',
    'です', 'ます', 'する', 'ある', 'いる', 'なる', 'なの', 'ない',
    'ても', 'から', 'まで', 'より', 'ので', 'のに', 'けど', 'けれど',
    'って', 'ので', 'ように', 'について', 'して', 'した', 'という',
    'どう', 'どの', 'この', 'その', 'あの', 'どんな',
    'てください', 'ください', 'したい', 'たい',
    'what', 'how', 'when', 'where', 'why', 'who',
    'the', 'a', 'an', 'is', 'are', 'was', 'were',
  ])

  // 句読点・記号で分割 → 空白で分割 → 2文字以上のみ
  const tokens = text
    .replace(/[、。！？!?.,;:\s]+/g, ' ')
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !stopWords.has(t))

  // 重複除去
  return [...new Set(tokens)].slice(0, 5)
}

// ===================================================================
// ナレッジドキュメント CRUD
// ===================================================================

/** ナレッジドキュメントを作成 */
export async function createKnowledgeDocument(
  db: D1Database,
  params: {
    knowledgeBaseId: string
    title: string
    content: string
    sourceUrl?: string | null
    priority?: number
  }
): Promise<KnowledgeDocument> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO knowledge_documents
        (id, knowledge_base_id, title, content, source_url, is_active, priority, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7)
    `)
    .bind(
      id,
      params.knowledgeBaseId,
      params.title,
      params.content,
      params.sourceUrl ?? null,
      params.priority ?? 0,
      now
    )
    .run()
  const row = await db
    .prepare('SELECT * FROM knowledge_documents WHERE id = ?1')
    .bind(id)
    .first<KnowledgeDocument>()
  return row!
}

/** ナレッジベース内のドキュメント一覧 */
export async function listKnowledgeDocuments(
  db: D1Database,
  knowledgeBaseId: string,
  limit = 50,
  offset = 0
): Promise<KnowledgeDocument[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM knowledge_documents
      WHERE knowledge_base_id = ?1 AND is_active = 1
      ORDER BY priority DESC, created_at DESC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(knowledgeBaseId, limit, offset)
    .all<KnowledgeDocument>()
  return results
}

// ===================================================================
// ユーザーコンテキスト構築
// ===================================================================

/**
 * AI 応答に注入するためのユーザー個人コンテキストを構築する。
 * user_profiles + 最近の body_metrics + daily_logs から情報を集約。
 */
export async function buildUserContext(
  db: D1Database,
  userAccountId: string
): Promise<string> {
  const parts: string[] = []

  // 1. プロファイル情報
  const profile = await db
    .prepare('SELECT * FROM user_profiles WHERE user_account_id = ?1')
    .bind(userAccountId)
    .first<{
      nickname: string | null
      gender: string | null
      age_range: string | null
      height_cm: number | null
      current_weight_kg: number | null
      target_weight_kg: number | null
      goal_summary: string | null
      concern_tags: string | null
      activity_level: string | null
    }>()

  if (profile) {
    parts.push('【ユーザープロフィール】')
    if (profile.nickname) parts.push(`名前: ${profile.nickname}`)
    if (profile.gender) {
      const genderMap: Record<string, string> = { male: '男性', female: '女性', other: 'その他' }
      parts.push(`性別: ${genderMap[profile.gender] ?? profile.gender}`)
    }
    if (profile.age_range) {
      const ageMap: Record<string, string> = { '20s': '20代', '30s': '30代', '40s': '40代', '50s': '50代', '60s+': '60代以上' }
      parts.push(`年代: ${ageMap[profile.age_range] ?? profile.age_range}`)
    }
    if (profile.height_cm) parts.push(`身長: ${profile.height_cm}cm`)
    if (profile.current_weight_kg) parts.push(`初回体重: ${profile.current_weight_kg}kg`)
    if (profile.target_weight_kg) parts.push(`目標体重: ${profile.target_weight_kg}kg`)
    if (profile.current_weight_kg && profile.target_weight_kg) {
      const diff = profile.current_weight_kg - profile.target_weight_kg
      parts.push(`目標減量幅: ${diff > 0 ? diff.toFixed(1) : 0}kg`)
    }
    if (profile.goal_summary) parts.push(`目標: ${profile.goal_summary}`)
    if (profile.concern_tags) {
      try {
        const tags = JSON.parse(profile.concern_tags)
        if (Array.isArray(tags) && tags.length > 0) {
          parts.push(`気になること: ${tags.join('、')}`)
        }
      } catch { /* ignore */ }
    }
    if (profile.activity_level) {
      const actMap: Record<string, string> = {
        sedentary: '座り仕事中心', light: '軽い運動あり',
        moderate: '週3〜5回運動', active: '毎日激しく運動',
      }
      parts.push(`活動レベル: ${actMap[profile.activity_level] ?? profile.activity_level}`)
    }
  }

  // 2. 直近の体重推移（過去7日分）
  const recentWeights = await db
    .prepare(`
      SELECT dl.log_date, bm.weight_kg
      FROM body_metrics bm
      JOIN daily_logs dl ON dl.id = bm.daily_log_id
      WHERE dl.user_account_id = ?1
        AND bm.weight_kg IS NOT NULL
      ORDER BY dl.log_date DESC
      LIMIT 7
    `)
    .bind(userAccountId)
    .all<{ log_date: string; weight_kg: number }>()

  if (recentWeights.results.length > 0) {
    parts.push('')
    parts.push('【直近の体重推移】')
    for (const w of recentWeights.results.reverse()) {
      parts.push(`  ${w.log_date}: ${w.weight_kg}kg`)
    }
    const latest = recentWeights.results[0]
    if (profile?.target_weight_kg && latest) {
      const remaining = latest.weight_kg - profile.target_weight_kg
      parts.push(`  → 目標まで残り ${remaining > 0 ? remaining.toFixed(1) : '0'}kg`)
    }
  }

  // 3. 直近の食事記録（今日分）
  const todayMeals = await db
    .prepare(`
      SELECT me.meal_type, me.meal_text, me.calories_kcal, me.protein_g, me.fat_g, me.carbs_g
      FROM meal_entries me
      JOIN daily_logs dl ON dl.id = me.daily_log_id
      WHERE dl.user_account_id = ?1
        AND dl.log_date = date('now')
      ORDER BY me.created_at ASC
    `)
    .bind(userAccountId)
    .all<{
      meal_type: string
      meal_text: string | null
      calories_kcal: number | null
      protein_g: number | null
      fat_g: number | null
      carbs_g: number | null
    }>()

  if (todayMeals.results.length > 0) {
    parts.push('')
    parts.push('【今日の食事記録】')
    const typeMap: Record<string, string> = {
      breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食', other: 'その他',
    }
    let totalCal = 0
    for (const m of todayMeals.results) {
      const label = typeMap[m.meal_type] ?? m.meal_type
      const cal = m.calories_kcal ? `${m.calories_kcal}kcal` : ''
      parts.push(`  ${label}: ${m.meal_text ?? '(記録あり)'} ${cal}`)
      if (m.calories_kcal) totalCal += m.calories_kcal
    }
    if (totalCal > 0) parts.push(`  → 今日の合計: 約${totalCal}kcal`)
  }

  return parts.join('\n')
}
