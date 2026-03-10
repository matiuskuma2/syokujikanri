/**
 * LINE Messaging API ユーティリティ
 */

type LineTextMessage = {
  type: 'text'
  text: string
}

type LineQuickReply = {
  items: Array<{
    type: 'action'
    action: {
      type: 'message' | 'postback' | 'uri'
      label: string
      text?: string
      data?: string
      uri?: string
    }
  }>
}

type LineFlexContainer = {
  type: string
  [key: string]: unknown
}

const LINE_API = 'https://api.line.me/v2/bot'

async function callLineApi(
  endpoint: string,
  accessToken: string,
  body: unknown
): Promise<Response> {
  return fetch(`${LINE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  })
}

// リプライメッセージ（1回のみ使用可能）
export async function replyText(
  replyToken: string,
  text: string,
  accessToken: string
): Promise<void> {
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: [{ type: 'text', text }]
  })
}

// リプライ（クイックリプライ付き）
export async function replyTextWithQuickReplies(
  replyToken: string,
  text: string,
  quickReplyItems: Array<{ label: string; text: string }>,
  accessToken: string
): Promise<void> {
  const quickReply: LineQuickReply = {
    items: quickReplyItems.map(item => ({
      type: 'action' as const,
      action: {
        type: 'message' as const,
        label: item.label,
        text: item.text
      }
    }))
  }
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: [{ type: 'text', text, quickReply }]
  })
}

// プッシュメッセージ（任意のタイミングで送信）
export async function pushText(
  lineUserId: string,
  text: string,
  accessToken: string
): Promise<void> {
  await callLineApi('/message/push', accessToken, {
    to: lineUserId,
    messages: [{ type: 'text', text }]
  })
}

// 複数メッセージのプッシュ
export async function pushMessages(
  lineUserId: string,
  messages: LineTextMessage[],
  accessToken: string
): Promise<void> {
  await callLineApi('/message/push', accessToken, {
    to: lineUserId,
    messages
  })
}

// LINEのコンテンツ（画像等）を取得
export async function getMessageContent(
  messageId: string,
  accessToken: string
): Promise<ArrayBuffer | null> {
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) return null
  return response.arrayBuffer()
}

// ユーザープロフィールを取得
export async function getUserProfile(
  lineUserId: string,
  accessToken: string
): Promise<{ displayName: string; pictureUrl?: string; statusMessage?: string } | null> {
  const response = await fetch(`${LINE_API}/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) return null
  const data = await response.json() as {
    displayName: string
    pictureUrl?: string
    statusMessage?: string
  }
  return data
}

// HMACシグネチャ検証
export async function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    return expected === signature
  } catch {
    return false
  }
}
