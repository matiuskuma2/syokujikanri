/**
 * worker/src/types.ts
 * Consumer Worker の環境バインディング型定義
 */

export type WorkerEnv = {
  // === Cloudflare Services ===
  DB: D1Database
  R2: R2Bucket

  // === LINE Messaging API ===
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_ID: string
  CLIENT_ACCOUNT_ID: string

  // === OpenAI ===
  OPENAI_API_KEY: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  OPENAI_TEMPERATURE_RECORD?: string
  OPENAI_TEMPERATURE_CONSULT?: string

  // === App Config ===
  APP_ENV?: string
  R2_BUCKET_URL?: string

  // === Bot Config ===
  BOT_SESSION_TTL_HOURS?: string
  CONSULT_MAX_TURNS?: string
}

/**
 * Queue から受信するメッセージ型
 */
export type QueueMessageBody =
  | WebhookEventMessage
  | ImageAnalysisMessage

export type WebhookEventMessage = {
  type: 'webhook_event'
  accountId: string
  channelId: string
  event: LineEvent
  receivedAt: string
}

export type ImageAnalysisMessage = {
  type: 'image_analysis'
  attachmentId: string
  userAccountId: string
  clientAccountId: string
  threadId: string
  r2Key: string
  lineUserId: string
}

// === LINE Event Types (簡易) ===
export type LineEvent = {
  type: 'message' | 'follow' | 'unfollow' | 'postback'
  timestamp: number
  source: {
    type: 'user' | 'group' | 'room'
    userId?: string
  }
  replyToken?: string
  mode: 'active' | 'standby'
  message?: {
    id: string
    type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'sticker'
    text?: string
    contentProvider?: {
      type: 'line' | 'external'
      originalContentUrl?: string
    }
  }
  postback?: {
    data: string
    params?: Record<string, string>
  }
}

/**
 * conversation_runtime_state テーブルの行型
 */
export type RuntimeState = {
  user_account_id: string
  line_user_id: string
  client_account_id: string
  current_mode: 'record' | 'consult' | 'intake'
  waiting_type: string | null   // null | 'image_confirm' | 'clarification' | 'intake_step'
  waiting_target_id: string | null
  waiting_expires_at: string | null
  last_processed_message_id: string | null
  last_processed_at: string | null
  version: number
  created_at: string
  updated_at: string
}
