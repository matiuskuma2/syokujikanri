/**
 * データベースエンティティ型定義
 * diet-bot - Phase 1 MVP
 *
 * 正本: docs/DATABASE.md
 * 命名規則: テーブルのカラム名をそのまま snake_case で使用
 *   user_accounts.id → 変数名は user_account_id
 */

// ===================================================================
// アカウント系
// ===================================================================

export type Account = {
  id: string
  type: 'clinic' | 'salon' | 'personal' | 'demo'
  name: string
  status: 'active' | 'suspended' | 'cancelled'
  timezone: string
  locale: string
  settings: string | null  // JSON
  created_at: string
  updated_at: string
}

export type AccountMembership = {
  id: string
  account_id: string
  user_id: string
  email: string
  role: 'superadmin' | 'admin' | 'staff'
  status: 'active' | 'inactive'
  created_at: string
  password_hash?: string | null
  password_reset_token?: string | null
  password_reset_expires_at?: string | null
  last_login_at?: string | null
}

export type Subscription = {
  id: string
  account_id: string
  plan: 'free' | 'starter' | 'pro' | 'enterprise'
  status: 'active' | 'trialing' | 'past_due' | 'cancelled'
  max_users: number
  current_period_start: string
  current_period_end: string
  created_at: string
  updated_at: string
}

export type UserServiceStatus = {
  id: string
  account_id: string
  line_user_id: string
  bot_enabled: number       // 0|1 (SQLite INTEGER)
  record_enabled: number
  consult_enabled: number
  intake_completed: number
  created_at: string
  updated_at: string
}

// ===================================================================
// LINE 系
// ===================================================================

export type LineChannel = {
  id: string
  account_id: string
  channel_id: string
  channel_secret: string
  access_token: string
  webhook_path: string
  is_active: number   // 0|1
  created_at: string
  updated_at: string
}

export type LineUser = {
  id: string
  line_channel_id: string
  line_user_id: string
  display_name: string | null
  picture_url: string | null
  status_message: string | null
  follow_status: 'following' | 'blocked'
  first_seen_at: string
  last_seen_at: string | null
}

export type UserAccount = {
  id: string               // これが user_account_id
  line_user_id: string
  client_account_id: string
  status: 'active' | 'left' | 'blocked'
  joined_at: string
  left_at: string | null
  created_at: string
  updated_at: string
}

// ===================================================================
// 会話系
// ===================================================================

export type ConversationThread = {
  id: string
  line_channel_id: string
  line_user_id: string
  client_account_id: string
  user_account_id: string | null
  current_mode: 'record' | 'consult' | 'system'
  status: 'open' | 'closed'
  started_at: string
  last_message_at: string | null
  created_at: string
  updated_at: string
}

export type ConversationMessage = {
  id: string
  thread_id: string
  sender_type: 'user' | 'bot' | 'staff' | 'system'
  sender_account_id: string | null
  source_platform: 'line' | 'web_admin'
  line_message_id: string | null
  message_type: 'text' | 'image' | 'audio' | 'template' | 'quick_reply' | 'system_event'
  raw_text: string | null
  normalized_text: string | null
  intent_label: string | null
  mode_at_send: string | null
  sent_at: string
  created_at: string
}

export type MessageAttachment = {
  id: string
  message_id: string
  storage_provider: 'r2' | 'images' | 's3'
  storage_key: string
  content_type: string
  file_size_bytes: number | null
  original_filename: string | null
  created_at: string
}

// ===================================================================
// 画像解析系
// ===================================================================

export type ImageCategory =
  | 'meal_photo'
  | 'nutrition_label'
  | 'body_scale'
  | 'food_package'
  | 'progress_body_photo'
  | 'other'
  | 'unknown'

export type ImageAnalysisJob = {
  id: string
  message_attachment_id: string
  job_status: 'queued' | 'processing' | 'done' | 'failed'
  provider_route: 'openai_vision' | 'mixed'
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/**
 * applied_flag の値:
 *   0 = pending  (AI解析済み、ユーザー未確認)
 *   1 = confirmed (ユーザーが確定 → メインテーブルに反映済み)
 *   2 = discarded (ユーザーが取消)
 *   3 = expired   (24時間自動破棄)
 */
export type ImageIntakeResult = {
  id: string
  message_attachment_id: string
  user_account_id: string | null
  daily_log_id: string | null
  line_user_id: string | null
  image_category: ImageCategory
  confidence_score: number | null
  extracted_json: string | null     // JSON
  proposed_action_json: string | null  // JSON
  applied_flag: number  // 0=pending|1=confirmed|2=discarded|3=expired
  confirmed_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

// ===================================================================
// BOT セッション系
// ===================================================================

export type BotModeSession = {
  id: string
  client_account_id: string
  line_user_id: string
  current_mode: 'intake' | 'record' | 'consult' | 'knowledge'
  current_step: string
  session_data: string | null  // JSON
  turn_count: number
  expires_at: string
  created_at: string
  updated_at: string
}

// ===================================================================
// ユーザープロフィール系
// ===================================================================

export type UserProfile = {
  id: string
  user_account_id: string
  nickname: string | null
  gender: 'male' | 'female' | 'other' | null
  age_range: '20s' | '30s' | '40s' | '50s+' | null
  height_cm: number | null
  current_weight_kg: number | null
  target_weight_kg: number | null
  goal_summary: string | null
  concern_tags: string | null  // JSON array
  medical_notes: string | null
  activity_level: 'sedentary' | 'light' | 'moderate' | 'active' | null
  created_at: string
  updated_at: string
}

// ===================================================================
// 日次記録系
// ===================================================================

export type DailyLog = {
  id: string
  user_account_id: string
  client_account_id: string
  log_date: string   // YYYY-MM-DD
  source: 'line' | 'web' | 'import' | 'staff'
  completion_status: 'partial' | 'complete' | 'reviewed'
  notes: string | null
  ai_feedback: string | null
  created_at: string
  updated_at: string
}

export type MealEntry = {
  id: string
  daily_log_id: string
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other'
  consumed_at: string | null
  meal_text: string | null
  photo_count: number
  calories_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  fiber_g: number | null
  alcohol_kcal: number | null
  confirmation_status: 'draft' | 'confirmed' | 'corrected'
  created_at: string
  updated_at: string
}

export type BodyMetrics = {
  id: string
  daily_log_id: string
  weight_kg: number | null
  waist_cm: number | null
  body_fat_percent: number | null
  temperature_c: number | null
  edema_flag: number | null  // 0|1
  created_at: string
  updated_at: string
}

// ===================================================================
// 進捗・レポート系
// ===================================================================

export type ProgressPhoto = {
  id: string
  user_account_id: string
  daily_log_id: string | null
  photo_date: string   // YYYY-MM-DD
  photo_type: 'before' | 'progress' | 'after'
  storage_provider: 'r2'
  storage_key: string
  pose_label: 'front' | 'side' | 'mirror' | 'unknown' | null
  body_part_label: 'full_body' | 'upper_body' | 'torso' | 'unknown' | null
  note: string | null
  is_public_use_allowed: number  // 0|1
  created_at: string
  updated_at: string
}

export type WeeklyReport = {
  id: string
  user_account_id: string
  week_start: string   // YYYY-MM-DD (月曜日)
  week_end: string     // YYYY-MM-DD (日曜日)
  avg_weight_kg: number | null
  min_weight_kg: number | null
  max_weight_kg: number | null
  weight_change: number | null
  total_steps: number | null
  avg_steps: number | null
  avg_sleep_hours: number | null
  avg_water_ml: number | null
  meal_log_count: number | null
  log_days: number | null
  ai_summary: string | null
  sent_at: string | null
  created_at: string
}

// ===================================================================
// JWT ペイロード（認証系）
// ===================================================================

export type JwtRole = 'superadmin' | 'admin' | 'user'

export type JwtPayload = {
  sub: string        // userAccountId (user) または accountMembershipId (admin)
  role: JwtRole
  accountId: string  // client_account_id
  iat: number
  exp: number
}

// ===================================================================
// API レスポンス共通型
// ===================================================================

export type ApiResponse<T = undefined> = T extends undefined
  ? { success: boolean; error?: string; message?: string }
  : { success: boolean; data?: T; error?: string; message?: string }
