/**
 * src/types/intent.ts
 * Unified Intent Schema — 会話解釈SSOT の型定義
 *
 * Phase A の出力: 1メッセージにつき1つの UnifiedIntent JSON
 * AIが生成し、バリデーション後に Phase B / Phase C で使用
 *
 * 正本: docs/11_会話解釈SSOT.md §2
 */

// ===================================================================
// スキーマバージョン (F1-5: Prompt Contract Drift 追跡用)
// ===================================================================

/** UnifiedIntent スキーマバージョン — AI出力の互換性追跡用 */
export const INTENT_SCHEMA_VERSION = '1.0.0'

// ===================================================================
// メインスキーマ
// ===================================================================

/** Phase A の出力: 1メッセージにつき1つの Intent JSON */
export type UnifiedIntent = {
  /** メッセージの主要な意図 */
  intent_primary: IntentPrimary

  /** 副次的な意図（相談中に記録情報が含まれる場合等） */
  intent_secondary: IntentPrimary | null

  /** 記録対象の日付 */
  target_date: TargetDate

  /** 食事区分（食事記録の場合） */
  meal_type: MealTypeResolution | null

  /** 記録種別 */
  record_type: RecordType | null

  /** 内容の要約（BOT返信用） */
  content_summary: string | null

  /** 食事の詳細記述（AI解析テキスト） */
  meal_description: string | null

  /** 体重値（kg） */
  weight_kg: number | null

  /** 明確化が必要なフィールド一覧 */
  needs_clarification: ClarificationField[]

  /** 修正対象（既存レコードの修正の場合） */
  correction_target: CorrectionTarget | null

  /** AIの確信度（0.0-1.0） */
  confidence: number

  /** AIの判断根拠メモ（デバッグ用） */
  reasoning: string

  /** 返信ポリシー（Phase C で使用） */
  reply_policy: ReplyPolicy
}

// ===================================================================
// サブ型
// ===================================================================

/** 主要な意図の分類 */
export type IntentPrimary =
  | 'record_meal'           // 食事記録
  | 'record_weight'         // 体重記録
  | 'record_progress_photo' // 体型写真記録
  | 'correct_record'        // 既存記録の修正
  | 'delete_record'         // 既存記録の削除
  | 'consult'               // 相談・質問
  | 'greeting'              // 挨拶・雑談
  | 'unclear'               // 意図不明

/** 日付の解決状態 */
export type TargetDate = {
  /** 解決済みの日付 (YYYY-MM-DD) */
  resolved: string | null
  /** ユーザーの原文表現 */
  original_expression: string | null
  /** 日付の推定方法 */
  source: DateSource
  /** 日付確認が必要か */
  needs_confirmation: boolean
}

export type DateSource =
  | 'explicit'    // ユーザーが明示（「昨日」「3/10」等）
  | 'inferred'    // 文脈から推定（「さっき」→今日）
  | 'timestamp'   // メッセージ送信時刻から推定
  | 'unknown'     // 不明（確認が必要）

/** 食事区分の解決状態 */
export type MealTypeResolution = {
  /** 解決済みの食事区分 */
  value: MealTypeValue | null
  /** ユーザーの原文表現 */
  raw_text: string | null
  /** 解決方法 */
  source: MealTypeSource
  /** 確認が必要か */
  needs_confirmation: boolean
}

export type MealTypeValue =
  | 'breakfast'    // 朝食
  | 'lunch'        // 昼食
  | 'dinner'       // 夕食
  | 'snack'        // 間食
  | 'other'        // その他（夜食等）

export type MealTypeSource =
  | 'explicit_keyword'    // 明示的キーワード（「朝食」「昼ご飯」等）
  | 'time_expression'     // 時間表現（「3時に」「夜9時」等）
  | 'content_inference'   // 内容から推定（「ポテチ」→ snack）
  | 'timestamp'           // メッセージ送信時刻から推定
  | 'unknown'             // 不明（確認が必要）

/** 記録種別 */
export type RecordType =
  | 'meal'            // 食事
  | 'weight'          // 体重
  | 'progress_photo'  // 体型写真

/** 明確化が必要なフィールド */
export type ClarificationField =
  | 'target_date'   // いつの記録か不明
  | 'meal_type'     // 食事区分が不明
  | 'content'       // 内容が不明（何を食べたか等）
  | 'weight_value'  // 体重値が不明

/** 修正対象の指定 */
export type CorrectionTarget = {
  /** 修正対象の日付 (YYYY-MM-DD) */
  target_date: string | null
  /** 修正対象の食事区分 */
  target_meal_type: MealTypeValue | null
  /** 修正内容の種別 */
  correction_type: CorrectionType
  /** 変更後の値 */
  new_value: {
    meal_type?: MealTypeValue
    content?: string
    target_date?: string
    weight_kg?: number
  } | null
}

export type CorrectionType =
  | 'meal_type_change'    // 食事区分の変更（朝食→夕食等）
  | 'content_change'      // 内容の変更（鮭→卵焼き等）
  | 'date_change'         // 日付の変更
  | 'nutrition_change'    // 栄養値の変更
  | 'delete'              // 削除
  | 'weight_change'       // 体重値の変更
  | 'append'              // R9: 同日同区分への追記

/** 返信ポリシー */
export type ReplyPolicy = {
  /** 保存完了を返信に含めるか */
  notify_save: boolean
  /** 相談応答を生成するか */
  generate_consult_reply: boolean
  /** 明確化質問を送るか（needs_clarification と連動） */
  ask_clarification: boolean
}

// ===================================================================
// Phase A コンテキスト型
// ===================================================================

/** Phase A interpretMessage() に渡すユーザーコンテキスト */
export type UserContext = {
  /** 現在のモード */
  current_mode: 'record' | 'consult'
  /** メッセージ送信時刻 (JST ISO8601) */
  message_timestamp_jst: string
  /** 今日の日付 (JST) YYYY-MM-DD */
  today_jst: string
  /** 直近の会話メッセージ（ユーザー+BOT） */
  recent_messages: Array<{
    role: 'user' | 'bot'
    text: string
    sent_at: string
  }>
  /** 明確化待ちの pending 状態（Phase B からの復帰時） */
  pending_clarification: PendingClarificationContext | null
  /** ユーザーメモリ（嗜好・アレルギー等） */
  user_memories: Array<{
    category: string
    memory_value: string
  }>
}

/** pending_clarifications テーブルから復元したコンテキスト */
export type PendingClarificationContext = {
  id: string
  intent_json: UnifiedIntent
  missing_fields: ClarificationField[]
  current_field: ClarificationField
  answers: Record<string, unknown>
}

// ===================================================================
// DB エンティティ型（pending_clarifications / correction_history / user_memory_items）
// ===================================================================

/** pending_clarifications テーブルの行型 */
export type PendingClarification = {
  id: string
  user_account_id: string
  client_account_id: string
  intent_json: string         // JSON string of UnifiedIntent
  original_message: string
  message_id: string | null
  missing_fields: string      // JSON array string
  current_field: string
  answers_json: string        // JSON object string
  status: 'asking' | 'answered' | 'expired' | 'cancelled'
  ask_count: number
  expires_at: string
  created_at: string
  updated_at: string
}

/** correction_history テーブルの行型 */
export type CorrectionHistory = {
  id: string
  user_account_id: string
  target_table: 'meal_entries' | 'body_metrics' | 'daily_logs'
  target_record_id: string
  correction_type: CorrectionType
  old_value_json: string      // JSON string
  new_value_json: string | null  // JSON string, null for delete
  triggered_by: 'user' | 'system' | 'admin'
  message_id: string | null
  reason: string | null
  created_at: string
}

/** user_memory_items テーブルの行型 */
export type UserMemoryItem = {
  id: string
  user_account_id: string
  category: string
  memory_key: string
  memory_value: string
  structured_json: string | null
  source_type: 'conversation' | 'intake' | 'admin' | 'system'
  source_message_id: string | null
  confidence_score: number
  is_active: number           // 0 | 1
  created_at: string
  updated_at: string
}

// ===================================================================
// 定数（docs/15_実装前確定ルールSSOT.md 準拠）
// ===================================================================

/** R1: 相談モードでの副次記録保存に必要な最低 confidence */
export const CONSULT_SECONDARY_SAVE_THRESHOLD = 0.8

/** R2: 体重の有効範囲 */
export const WEIGHT_MIN = 20
export const WEIGHT_MAX = 300

/** R14-6: 明確化の有効期限（時間） */
export const CLARIFICATION_EXPIRY_HOURS = 24

/** R13-1: 1ユーザーあたりの asking 上限 */
export const MAX_PENDING_PER_USER = 1

/** R5-12: 日付のルックバック上限（日） */
export const DATE_LOOKBACK_DAYS = 30

/** F2-1: メモリの最低 confidence（コンテキスト注入の閾値） */
export const MEMORY_CONFIDENCE_MIN = 0.6

/** メモリ抽出スキップの最低文字数 */
export const MEMORY_EXTRACTION_MIN_LENGTH = 5

/** R9: 修正対象特定の直前コンテキスト有効期限（分） */
export const CORRECTION_CONTEXT_EXPIRY_MINUTES = 30

/** R17: cancelled/expired pending の保持期間（日） */
export const PENDING_RETENTION_DAYS = 30

/** R4: meal_text の最大文字数 */
export const MEAL_TEXT_MAX_LENGTH = 2000

/** R6: 深夜帯の境界時刻（JST）。0:00〜(MIDNIGHT_BOUNDARY_HOUR-1):59 は前日扱い */
export const MIDNIGHT_BOUNDARY_HOUR = 5

/** R7: 食事区分の時間帯境界（分単位） */
export const MEAL_TIME_BREAKFAST_START = 300   // 05:00
export const MEAL_TIME_LUNCH_START = 630       // 10:30
export const MEAL_TIME_SNACK_START = 900       // 15:00
export const MEAL_TIME_DINNER_START = 1050     // 17:30
export const MEAL_TIME_NIGHT_START = 1380      // 23:00

// ===================================================================
// バリデーションヘルパー
// ===================================================================

const VALID_INTENT_PRIMARIES = new Set<IntentPrimary>([
  'record_meal', 'record_weight', 'record_progress_photo',
  'correct_record', 'delete_record', 'consult', 'greeting', 'unclear',
])

const VALID_MEAL_TYPES = new Set<MealTypeValue>([
  'breakfast', 'lunch', 'dinner', 'snack', 'other',
])

const VALID_DATE_SOURCES = new Set<DateSource>([
  'explicit', 'inferred', 'timestamp', 'unknown',
])

const VALID_MEAL_TYPE_SOURCES = new Set<MealTypeSource>([
  'explicit_keyword', 'time_expression', 'content_inference', 'timestamp', 'unknown',
])

/** AIの生JSON出力をバリデーション・正規化する */
export function validateAndNormalizeIntent(raw: Record<string, unknown>): UnifiedIntent {
  const intent_primary = VALID_INTENT_PRIMARIES.has(raw.intent_primary as IntentPrimary)
    ? (raw.intent_primary as IntentPrimary)
    : 'unclear'

  const intent_secondary = raw.intent_secondary && VALID_INTENT_PRIMARIES.has(raw.intent_secondary as IntentPrimary)
    ? (raw.intent_secondary as IntentPrimary)
    : null

  // target_date の正規化
  const rawDate = (raw.target_date ?? {}) as Record<string, unknown>
  const target_date: TargetDate = {
    resolved: typeof rawDate.resolved === 'string' ? rawDate.resolved : null,
    original_expression: typeof rawDate.original_expression === 'string' ? rawDate.original_expression : null,
    source: VALID_DATE_SOURCES.has(rawDate.source as DateSource) ? (rawDate.source as DateSource) : 'unknown',
    needs_confirmation: rawDate.needs_confirmation === true,
  }

  // meal_type の正規化
  let meal_type: MealTypeResolution | null = null
  if (raw.meal_type && typeof raw.meal_type === 'object') {
    const rawMT = raw.meal_type as Record<string, unknown>
    meal_type = {
      value: VALID_MEAL_TYPES.has(rawMT.value as MealTypeValue) ? (rawMT.value as MealTypeValue) : null,
      raw_text: typeof rawMT.raw_text === 'string' ? rawMT.raw_text : null,
      source: VALID_MEAL_TYPE_SOURCES.has(rawMT.source as MealTypeSource) ? (rawMT.source as MealTypeSource) : 'unknown',
      needs_confirmation: rawMT.needs_confirmation === true,
    }
  }

  // needs_clarification の正規化
  const validClarificationFields = new Set<ClarificationField>(['target_date', 'meal_type', 'content', 'weight_value'])
  const needs_clarification = Array.isArray(raw.needs_clarification)
    ? (raw.needs_clarification as string[]).filter(f => validClarificationFields.has(f as ClarificationField)) as ClarificationField[]
    : []

  // correction_target の正規化
  let correction_target: CorrectionTarget | null = null
  if (raw.correction_target && typeof raw.correction_target === 'object') {
    const rawCT = raw.correction_target as Record<string, unknown>
    correction_target = {
      target_date: typeof rawCT.target_date === 'string' ? rawCT.target_date : null,
      target_meal_type: VALID_MEAL_TYPES.has(rawCT.target_meal_type as MealTypeValue) ? (rawCT.target_meal_type as MealTypeValue) : null,
      correction_type: (rawCT.correction_type as CorrectionType) ?? 'content_change',
      new_value: rawCT.new_value as CorrectionTarget['new_value'] ?? null,
    }
  }

  // reply_policy の正規化
  const rawRP = (raw.reply_policy ?? {}) as Record<string, unknown>
  const reply_policy: ReplyPolicy = {
    notify_save: rawRP.notify_save === true || needs_clarification.length === 0,
    generate_consult_reply: rawRP.generate_consult_reply === true,
    ask_clarification: rawRP.ask_clarification === true || needs_clarification.length > 0,
  }

  return {
    intent_primary,
    intent_secondary,
    target_date,
    meal_type,
    record_type: typeof raw.record_type === 'string' ? (raw.record_type as RecordType) : null,
    content_summary: typeof raw.content_summary === 'string' ? raw.content_summary : null,
    meal_description: typeof raw.meal_description === 'string' ? raw.meal_description : null,
    weight_kg: typeof raw.weight_kg === 'number' ? raw.weight_kg : null,
    needs_clarification,
    correction_target,
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    reply_policy,
  }
}

/** Intent が即時保存可能かチェックする (SSOT §3.1) */
export function canSaveImmediately(intent: UnifiedIntent): boolean {
  if (intent.needs_clarification.length > 0) return false

  // 体重: 値があればOK (R2)
  if (intent.intent_primary === 'record_weight' && intent.weight_kg !== null) {
    return intent.weight_kg >= WEIGHT_MIN && intent.weight_kg <= WEIGHT_MAX
  }

  // 食事: 日付 + 区分 + 内容 の3要素すべて確定
  if (intent.intent_primary === 'record_meal') {
    const dateOk = intent.target_date.resolved !== null &&
      (intent.target_date.source === 'explicit' || intent.target_date.source === 'inferred')
    const mealTypeOk = intent.meal_type !== null && intent.meal_type.value !== null &&
      (intent.meal_type.source === 'explicit_keyword' || intent.meal_type.source === 'time_expression' || intent.meal_type.source === 'content_inference')
    const contentOk = intent.content_summary !== null && intent.content_summary.trim().length > 0
    return dateOk && mealTypeOk && contentOk
  }

  return false
}

/** Intent が「確認付き保存」の条件を満たすかチェック (SSOT §0.5) */
export function canSaveWithConfirmation(intent: UnifiedIntent): boolean {
  if (intent.intent_primary !== 'record_meal') return false
  if (intent.needs_clarification.length > 0) return false

  const contentOk = intent.content_summary !== null && intent.content_summary.trim().length > 0
  const hasTimestamp = intent.target_date.source === 'timestamp' ||
    (intent.meal_type !== null && intent.meal_type.source === 'timestamp')

  return contentOk && hasTimestamp
}

// ===================================================================
// R6: 深夜帯ヘルパー
// ===================================================================

/**
 * R6: メッセージ送信時刻(JST)から timestamp 推定の基準日を返す。
 * 00:00〜04:59 → 前日、05:00〜23:59 → 当日
 */
export function resolveBaseDateFromTimestamp(timestampJst: string, todayJst: string): string {
  try {
    const hour = parseInt(timestampJst.substring(11, 13), 10)
    if (hour < MIDNIGHT_BOUNDARY_HOUR) {
      // 前日を返す
      const d = new Date(todayJst + 'T00:00:00+09:00')
      d.setDate(d.getDate() - 1)
      return d.toISOString().substring(0, 10)
    }
    return todayJst
  } catch {
    return todayJst
  }
}

/** 食事区分の日本語ラベル */
export function mealTypeToJa(mealType: MealTypeValue | null): string {
  switch (mealType) {
    case 'breakfast': return '朝食'
    case 'lunch': return '昼食'
    case 'dinner': return '夕食'
    case 'snack': return '間食'
    case 'other': return '食事'
    default: return '食事'
  }
}
