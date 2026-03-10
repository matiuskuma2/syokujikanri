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

  // === Single-channel resolution (Phase 1) ===
  // マルチチャンネル化後は line_channels テーブルで解決する
  LINE_CHANNEL_ID: string        // D1 line_channels.id に対応するシステム内部 ID (UUID)
  LINE_LIFF_CHANNEL_ID: string   // LINE Login / LIFF の Channel ID (数字10桁) — /oauth2/v2.1/verify の client_id に使用
  CLIENT_ACCOUNT_ID: string      // D1 accounts.id に対応するクライアントアカウント ID

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
/**
 * LINE_EVENTS_QUEUE に投入するメッセージの Union 型
 *
 * - 'webhook_event'  : LINE Webhook イベントをそのまま Queue 経由で処理（将来の非同期化用）
 * - 'image_analysis' : 画像添付ファイルの解析ジョブ
 */
export type LineQueueMessage =
  | LineWebhookQueueMessage
  | ImageAnalysisQueueMessage

/** LINE Webhook イベントをそのまま非同期処理する場合 */
export type LineWebhookQueueMessage = {
  type: 'webhook_event'
  accountId: string
  channelId: string
  event: LineWebhookEvent
  receivedAt: string
}

/** 画像解析ジョブ */
export type ImageAnalysisQueueMessage = {
  type: 'image_analysis'
  attachmentId: string
  userAccountId: string
  clientAccountId: string
  threadId: string
  r2Key: string
  lineUserId: string
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
