/**
 * Cloudflare Workers バインディング型定義
 * diet-bot - ダイエット支援BOTシステム
 */

export type Bindings = {
  // === Cloudflare Services ===
  DB: D1Database
  R2: R2Bucket
  LINE_EVENTS_QUEUE: Queue<LineQueueMessage>

  // === LINE Messaging API ===
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_WEBHOOK_PATH: string

  // === OpenAI ===
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
  OPENAI_MAX_TOKENS: string
  OPENAI_TEMPERATURE_RECORD: string
  OPENAI_TEMPERATURE_CONSULT: string

  // === JWT ===
  JWT_SECRET: string
  JWT_EXPIRES_IN: string

  // === App Config ===
  APP_ENV: string
  APP_URL: string
  CORS_ORIGINS: string

  // === Bot Config ===
  BOT_SESSION_TTL_HOURS: string
  CONSULT_MAX_TURNS: string

  // === R2 Media ===
  R2_BUCKET_URL: string
  R2_MAX_FILE_SIZE_MB: string
  R2_ALLOWED_CONTENT_TYPES: string

  // === Cron ===
  CRON_SECRET: string
}

// === LINE Queue Message ===
export type LineQueueMessage = {
  accountId: string
  channelId: string
  event: LineWebhookEvent
  receivedAt: string
}

// === LINE Webhook Event Types ===
export type LineWebhookEvent =
  | LineFollowEvent
  | LineUnfollowEvent
  | LineMessageEvent
  | LinePostbackEvent

export type LineEventBase = {
  type: string
  timestamp: number
  source: LineSource
  replyToken?: string
  mode: 'active' | 'standby'
}

export type LineFollowEvent = LineEventBase & {
  type: 'follow'
}

export type LineUnfollowEvent = LineEventBase & {
  type: 'unfollow'
}

export type LineMessageEvent = LineEventBase & {
  type: 'message'
  message: LineMessage
}

export type LinePostbackEvent = LineEventBase & {
  type: 'postback'
  postback: LinePostback
}

export type LineSource = {
  type: 'user' | 'group' | 'room'
  userId?: string
  groupId?: string
  roomId?: string
}

export type LineMessage = {
  id: string
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'sticker'
  text?: string
  contentProvider?: {
    type: 'line' | 'external'
    originalContentUrl?: string
    previewImageUrl?: string
  }
}

export type LinePostback = {
  data: string
  params?: Record<string, string>
}
