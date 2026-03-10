/**
 * reply.ts
 * LINE Messaging API の送信処理
 *
 * reply と push を明確に分離する。
 * reply: replyToken を使う（1イベントにつき1回のみ使用可）
 * push:  userId 宛に任意のタイミングで送信（課金対象）
 */

const LINE_API = 'https://api.line.me/v2/bot'

// ===================================================================
// 型定義
// ===================================================================

export type LineTextMessage = {
  type: 'text'
  text: string
  quickReply?: LineQuickReply
}

export type LineQuickReply = {
  items: LineQuickReplyItem[]
}

export type LineQuickReplyItem = {
  type: 'action'
  action:
    | { type: 'message'; label: string; text: string }
    | { type: 'postback'; label: string; data: string; displayText?: string }
    | { type: 'uri'; label: string; uri: string }
}

export type LineSendableMessage = LineTextMessage

// ===================================================================
// 内部ユーティリティ
// ===================================================================

async function callLineApi(
  endpoint: string,
  accessToken: string,
  body: unknown
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${LINE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`[LINE API] ${endpoint} failed: ${res.status} ${text}`)
  }
  return { ok: res.ok, status: res.status }
}

// ===================================================================
// Reply（replyToken使用 — イベントに対する返信）
// ===================================================================

/** テキストで返信 */
export async function replyText(
  replyToken: string,
  text: string,
  accessToken: string
): Promise<void> {
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: [{ type: 'text', text }],
  })
}

/** テキスト + クイックリプライで返信 */
export async function replyTextWithQuickReplies(
  replyToken: string,
  text: string,
  items: Array<{ label: string; text: string }>,
  accessToken: string
): Promise<void> {
  const quickReply: LineQuickReply = {
    items: items.map((item) => ({
      type: 'action' as const,
      action: { type: 'message' as const, label: item.label, text: item.text },
    })),
  }
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: [{ type: 'text', text, quickReply }],
  })
}

/** 複数メッセージで返信（最大5件） */
export async function replyMessages(
  replyToken: string,
  messages: LineSendableMessage[],
  accessToken: string
): Promise<void> {
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: messages.slice(0, 5),
  })
}

// ===================================================================
// Push（userId宛 — 任意のタイミングで送信）
// ===================================================================

/** テキストをプッシュ */
export async function pushText(
  lineUserId: string,
  text: string,
  accessToken: string
): Promise<void> {
  await callLineApi('/message/push', accessToken, {
    to: lineUserId,
    messages: [{ type: 'text', text }],
  })
}

/** 複数メッセージをプッシュ（最大5件） */
export async function pushMessages(
  lineUserId: string,
  messages: LineSendableMessage[],
  accessToken: string
): Promise<void> {
  await callLineApi('/message/push', accessToken, {
    to: lineUserId,
    messages: messages.slice(0, 5),
  })
}

// ===================================================================
// LINE Content API（画像バイナリ取得）
// ===================================================================

/** LINE サーバーからメッセージの添付コンテンツを取得 */
export async function getMessageContent(
  messageId: string,
  accessToken: string
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return null
  const data = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  return { data, contentType }
}

// ===================================================================
// LINE Profile API
// ===================================================================

export type LineProfile = {
  userId: string
  displayName: string
  pictureUrl?: string
  statusMessage?: string
}

/** LINE ユーザープロフィールを取得 */
export async function getUserProfile(
  lineUserId: string,
  accessToken: string
): Promise<LineProfile | null> {
  const res = await fetch(`${LINE_API}/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return res.json() as Promise<LineProfile>
}
