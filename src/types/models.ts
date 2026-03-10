/**
 * データベースエンティティ型定義
 * diet-bot - Phase 1 MVP
 */

// === アカウント ===
export type Account = {
  id: string
  type: 'clinic' | 'salon' | 'personal' | 'demo'
  name: string
  status: 'active' | 'suspended' | 'cancelled'
  timezone: string
  locale: string
  created_at: string
  updated_at: string
}

export type AccountMembership = {
  id: string
  account_id: string
  user_id: string
  role: 'superadmin' | 'admin' | 'member'
  status: 'active' | 'inactive'
  created_at: string
  updated_at: string
}

export type Subscription = {
  id: string
  account_id: string
  plan: 'free' | 'starter' | 'professional' | 'enterprise'
  status: 'trial' | 'active' | 'past_due' | 'cancelled'
  trial_ends_at: string | null
  current_period_start: string
  current_period_end: string
  max_users: number
  created_at: string
  updated_at: string
}

// === ユーザーサービス制御 ===
export type UserServiceStatus = {
  id: string
  line_user_id: string
  account_id: string
  bot_enabled: boolean
  record_enabled: boolean
  consult_enabled: boolean
  intake_enabled: boolean
  created_at: string
  updated_at: string
}

// === LINE連携 ===
export type LineChannel = {
  id: string
  account_id: string
  channel_id: string
  channel_secret: string
  channel_access_token: string
  webhook_path: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export type LineUser = {
  id: string
  account_id: string
  line_channel_id: string
  line_user_id: string
  display_name: string | null
  picture_url: string | null
  status_message: string | null
  first_seen_at: string
  last_active_at: string
  created_at: string
  updated_at: string
}

// === 会話 ===
export type ConversationThread = {
  id: string
  account_id: string
  line_user_id: string
  status: 'active' | 'closed'
  bot_mode: BotMode | null
  created_at: string
  updated_at: string
}

export type ConversationMessage = {
  id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  message_type: 'text' | 'image' | 'template' | 'flex' | 'system'
  content: string | null
  bot_mode: BotMode | null
  step_code: string | null
  metadata: string | null // JSON string
  created_at: string
}

export type MessageAttachment = {
  id: string
  message_id: string
  file_type: 'image' | 'video' | 'audio' | 'file'
  r2_key: string
  content_type: string
  file_size: number | null
  intake_type: ImageIntakeType | null
  created_at: string
}

// === BOT セッション ===
export type BotMode = 'intake' | 'record' | 'consult' | 'knowledge'

export type BotModeSession = {
  id: string
  line_user_id: string
  account_id: string
  mode: BotMode
  step_code: string
  session_data: string | null // JSON string
  turn_count: number
  expires_at: string
  created_at: string
  updated_at: string
}

// === BOT 管理 ===
export type Bot = {
  id: string
  account_id: string
  name: string
  bot_key: string
  type: 'line' | 'web'
  is_active: boolean
  current_version_id: string | null
  created_at: string
  updated_at: string
}

export type BotVersion = {
  id: string
  bot_id: string
  version_number: number
  system_prompt: string | null
  config: string | null // JSON string
  is_published: boolean
  created_at: string
}

// === ナレッジ ===
export type KnowledgeBase = {
  id: string
  account_id: string | null // null = システム共通
  name: string
  description: string | null
  is_active: boolean
  priority: number
  created_at: string
  updated_at: string
}

export type KnowledgeDocument = {
  id: string
  knowledge_base_id: string
  title: string
  content: string
  source_url: string | null
  is_active: boolean
  priority: number
  created_at: string
  updated_at: string
}

// === ユーザープロファイル ===
export type UserProfile = {
  id: string
  line_user_id: string
  account_id: string
  nickname: string | null
  gender: 'male' | 'female' | 'other' | null
  age_range: string | null
  height_cm: number | null
  current_weight_kg: number | null
  target_weight_kg: number | null
  goal_summary: string | null
  concern_tags: string | null // JSON array string
  diet_history: string | null
  medical_notes: string | null
  activity_level: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active' | null
  created_at: string
  updated_at: string
}

// === ヒアリング ===
export type IntakeForm = {
  id: string
  account_id: string
  name: string
  description: string | null
  is_active: boolean
  order_index: number
  created_at: string
  updated_at: string
}

export type IntakeAnswer = {
  id: string
  line_user_id: string
  account_id: string
  intake_form_id: string
  question_key: string
  answer_value: string | null
  answered_at: string
}

// === 日次記録 ===
export type DailyLog = {
  id: string
  line_user_id: string
  account_id: string
  log_date: string // YYYY-MM-DD
  weight_kg: number | null
  waist_cm: number | null
  body_fat_pct: number | null
  steps: number | null
  water_ml: number | null
  sleep_hours: number | null
  mood_score: number | null // 1-5
  notes: string | null
  ai_feedback: string | null
  created_at: string
  updated_at: string
}

export type MealEntry = {
  id: string
  line_user_id: string
  account_id: string
  daily_log_id: string | null
  log_date: string // YYYY-MM-DD
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'drink'
  description: string | null
  estimated_calories: number | null
  estimated_protein_g: number | null
  estimated_fat_g: number | null
  estimated_carbs_g: number | null
  nutrition_score: number | null // 0-100
  ai_parsed: boolean
  ai_comment: string | null
  image_key: string | null // R2 key
  recorded_at: string
  created_at: string
  updated_at: string
}

// === 画像取り込み結果 ===
export type ImageIntakeType = 'meal_photo' | 'nutrition_label' | 'body_scale' | 'progress_body_photo'

export type ImageIntakeResult = {
  id: string
  message_attachment_id: string
  line_user_id: string
  account_id: string
  intake_type: ImageIntakeType
  raw_response: string | null // OpenAI レスポンスJSON
  parsed_data: string | null // JSON string
  confidence_score: number | null
  is_confirmed: boolean
  created_at: string
  updated_at: string
}

export type ProgressPhoto = {
  id: string
  line_user_id: string
  account_id: string
  log_date: string // YYYY-MM-DD
  r2_key: string
  weight_at_photo: number | null
  waist_at_photo: number | null
  notes: string | null
  created_at: string
}

// === 週次レポート ===
export type WeeklyReport = {
  id: string
  line_user_id: string
  account_id: string
  week_start: string // YYYY-MM-DD Monday
  week_end: string   // YYYY-MM-DD Sunday
  avg_weight_kg: number | null
  avg_calories: number | null
  log_days: number
  summary: string | null // AI生成テキスト
  sent_at: string | null
  created_at: string
}

// === 質問定義 ===
export type QuestionDefinition = {
  id: string
  question_key: string
  category: 'intake' | 'daily_check'
  label_ja: string
  input_type: 'text' | 'number' | 'select' | 'multiselect' | 'image'
  options_json: string | null // JSON array
  is_required: boolean
  order_index: number
  created_at: string
}

// === 監査ログ ===
export type AuditLog = {
  id: string
  account_id: string | null
  user_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  details: string | null // JSON string
  ip_address: string | null
  created_at: string
}

// === JWT ===
export type JwtPayload = {
  sub: string          // user_id or line_user_id
  account_id: string
  role: 'superadmin' | 'admin' | 'member' | 'user'
  type: 'admin' | 'user'
  iat: number
  exp: number
}

// === API レスポンス ===
export type ApiResponse<T = unknown> = {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// === 画像解析結果 ===
export type MealAnalysisResult = {
  dishes: Array<{
    name: string
    quantity: string
    estimated_calories: number
    protein_g: number
    fat_g: number
    carbs_g: number
    confidence: number
  }>
  total_calories: number
  total_protein_g: number
  total_fat_g: number
  total_carbs_g: number
  nutrition_score: number
  ai_comment: string
}

export type ScaleReadResult = {
  weight_kg: number | null
  body_fat_pct: number | null
  confidence: number
  raw_text: string
}

export type NutritionLabelResult = {
  product_name: string | null
  serving_size: string | null
  calories_per_serving: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  sodium_mg: number | null
  confidence: number
}
