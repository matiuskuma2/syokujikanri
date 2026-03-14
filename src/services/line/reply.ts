/**
 * reply.ts
 * LINE Messaging API の送信処理
 *
 * reply と push を明確に分離する。
 * reply: replyToken を使う（1イベントにつき1回のみ使用可）
 * push:  userId 宛に任意のタイミングで送信（課金対象）
 */

import { fetchWithTimeout, TIMEOUT } from '../../utils/fetch-with-timeout'

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
  console.log(`[LINE API] calling ${endpoint}, body keys: ${Object.keys(body as Record<string, unknown>).join(',')})`)
  const startTime = Date.now()
  try {
    const res = await fetchWithTimeout(
      `${LINE_API}${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      },
      TIMEOUT.LINE_API
    )
    const elapsed = Date.now() - startTime
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[LINE API] ${endpoint} failed: ${res.status} ${text} (${elapsed}ms)`)
      // reply / push どちらも失敗時は throw する（無応答防止）
      throw new Error(`LINE ${endpoint} failed: ${res.status} ${text}`)
    }
    console.log(`[LINE API] ${endpoint} success (${elapsed}ms)`)
    return { ok: res.ok, status: res.status }
  } catch (err) {
    const elapsed = Date.now() - startTime
    if (err instanceof Error && err.message.startsWith('LINE ')) {
      throw err // 既に上で throw したエラーを再 throw
    }
    // AbortError (timeout) やネットワークエラー
    console.error(`[LINE API] ${endpoint} exception after ${elapsed}ms:`, err)
    throw new Error(`LINE ${endpoint} exception: ${err instanceof Error ? err.message : String(err)}`)
  }
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
  console.log(`[LINE push] pushText to=${lineUserId?.substring(0,8)}..., text=${text.substring(0,50)}...`)
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
  const res = await fetchWithTimeout(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    TIMEOUT.LINE_CONTENT
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
  const res = await fetchWithTimeout(
    `${LINE_API}/profile/${lineUserId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    TIMEOUT.LINE_API
  )
  if (!res.ok) return null
  return res.json() as Promise<LineProfile>
}

// ===================================================================
// クイックリプライ
// ===================================================================

export type QuickReplyItem = {
  label: string  // 最大20文字
  text: string   // 送信テキスト
}

/** クイックリプライ付きテキストメッセージを送信（replyToken使用） */
export async function replyWithQuickReplies(
  replyToken: string,
  text: string,
  items: QuickReplyItem[],
  accessToken: string
): Promise<void> {
  const quickReply = {
    items: items.slice(0, 13).map(item => ({
      type: 'action',
      action: {
        type: 'message',
        label: item.label.substring(0, 20),
        text: item.text,
      },
    })),
  }

  // callLineApi を使用（reply失敗時は throw → push フォールバック可能）
  await callLineApi('/message/reply', accessToken, {
    replyToken,
    messages: [{ type: 'text', text, quickReply }],
  })
}

/** クイックリプライ付きテキストメッセージをプッシュ送信 */
export async function pushWithQuickReplies(
  lineUserId: string,
  text: string,
  items: QuickReplyItem[],
  accessToken: string
): Promise<void> {
  console.log(`[LINE push] pushWithQuickReplies to=${lineUserId?.substring(0,8)}..., text=${text.substring(0,50)}..., items=${items.length}`)
  const quickReply = {
    items: items.slice(0, 13).map(item => ({
      type: 'action',
      action: {
        type: 'message',
        label: item.label.substring(0, 20),
        text: item.text,
      },
    })),
  }

  // callLineApi を使って push（エラー時は throw されるので呼び出し元で catch）
  await callLineApi('/message/push', accessToken, {
    to: lineUserId,
    messages: [{ type: 'text', text, quickReply }],
  })
}
