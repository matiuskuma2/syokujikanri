/**
 * conversations-repo.ts
 * 会話スレッド・メッセージの読み書き
 *
 * 参照テーブル: conversation_threads, conversation_messages, message_attachments
 */

import type { ConversationThread, ConversationMessage, MessageAttachment } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// conversation_threads
// ===================================================================

/** LINE ユーザーのオープンスレッドを取得 */
export async function findOpenThreadByLineUser(
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<ConversationThread | null> {
  const row = await db
    .prepare(`
      SELECT * FROM conversation_threads
      WHERE line_channel_id = ?1
        AND line_user_id = ?2
        AND status = 'open'
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .bind(lineChannelId, lineUserId)
    .first<ConversationThread>()
  return row ?? null
}

/** スレッドIDで取得 */
export async function findThreadById(
  db: D1Database,
  threadId: string
): Promise<ConversationThread | null> {
  const row = await db
    .prepare('SELECT * FROM conversation_threads WHERE id = ?1')
    .bind(threadId)
    .first<ConversationThread>()
  return row ?? null
}

/** 新しい会話スレッドを作成 */
export async function createConversationThread(
  db: D1Database,
  params: {
    lineChannelId: string
    lineUserId: string
    clientAccountId: string
    userAccountId?: string | null
    currentMode?: ConversationThread['current_mode']
  }
): Promise<ConversationThread> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO conversation_threads
        (id, line_channel_id, line_user_id, client_account_id, user_account_id,
         current_mode, status, started_at, last_message_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?7, ?7, ?7)
    `)
    .bind(
      id,
      params.lineChannelId,
      params.lineUserId,
      params.clientAccountId,
      params.userAccountId ?? null,
      params.currentMode ?? 'record',
      now
    )
    .run()
  return (await findThreadById(db, id))!
}

/**
 * オープンスレッドを取得または新規作成
 * LINE webhook の入り口で必ず呼ぶ
 */
export async function ensureOpenThread(
  db: D1Database,
  params: {
    lineChannelId: string
    lineUserId: string
    clientAccountId: string
    userAccountId?: string | null
  }
): Promise<ConversationThread> {
  const existing = await findOpenThreadByLineUser(
    db,
    params.lineChannelId,
    params.lineUserId
  )
  if (existing) return existing
  return createConversationThread(db, params)
}

/** スレッドのモードを更新（record ↔ consult 切替） */
export async function updateThreadMode(
  db: D1Database,
  threadId: string,
  mode: ConversationThread['current_mode']
): Promise<void> {
  await db
    .prepare(`
      UPDATE conversation_threads
      SET current_mode = ?1, updated_at = ?2
      WHERE id = ?3
    `)
    .bind(mode, nowIso(), threadId)
    .run()
}

/** スレッドの最終メッセージ時刻を更新 */
export async function touchThread(
  db: D1Database,
  threadId: string
): Promise<void> {
  const now = nowIso()
  await db
    .prepare(`
      UPDATE conversation_threads
      SET last_message_at = ?1, updated_at = ?1
      WHERE id = ?2
    `)
    .bind(now, threadId)
    .run()
}

/** スレッドをクローズ */
export async function closeThread(
  db: D1Database,
  threadId: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE conversation_threads
      SET status = 'closed', updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), threadId)
    .run()
}

// ===================================================================
// conversation_messages
// ===================================================================

/** メッセージを保存 */
export async function createConversationMessage(
  db: D1Database,
  params: {
    threadId: string
    senderType: ConversationMessage['sender_type']
    senderAccountId?: string | null
    sourcePlatform?: ConversationMessage['source_platform']
    lineMessageId?: string | null
    messageType: ConversationMessage['message_type']
    rawText?: string | null
    normalizedText?: string | null
    intentLabel?: string | null
    modeAtSend?: string | null
    sentAt?: string
  }
): Promise<ConversationMessage> {
  const id = generateId()
  const now = nowIso()
  const sentAt = params.sentAt ?? now
  await db
    .prepare(`
      INSERT INTO conversation_messages
        (id, thread_id, sender_type, sender_account_id, source_platform, line_message_id,
         message_type, raw_text, normalized_text, intent_label, mode_at_send, sent_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `)
    .bind(
      id,
      params.threadId,
      params.senderType,
      params.senderAccountId ?? null,
      params.sourcePlatform ?? 'line',
      params.lineMessageId ?? null,
      params.messageType,
      params.rawText ?? null,
      params.normalizedText ?? null,
      params.intentLabel ?? null,
      params.modeAtSend ?? null,
      sentAt,
      now
    )
    .run()

  // スレッドの最終メッセージ時刻を更新
  await touchThread(db, params.threadId)

  const row = await db
    .prepare('SELECT * FROM conversation_messages WHERE id = ?1')
    .bind(id)
    .first<ConversationMessage>()
  return row!
}

/** スレッドの最近のメッセージを取得（AI コンテキスト用） */
export async function listRecentMessages(
  db: D1Database,
  threadId: string,
  limit = 20
): Promise<ConversationMessage[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM conversation_messages
      WHERE thread_id = ?1
      ORDER BY sent_at DESC
      LIMIT ?2
    `)
    .bind(threadId, limit)
    .all<ConversationMessage>()
  // 古い順に返す（AIコンテキストとして使いやすいため）
  return results.reverse()
}

// ===================================================================
// message_attachments
// ===================================================================

/** 添付ファイルを保存 */
export async function createMessageAttachment(
  db: D1Database,
  params: {
    messageId: string
    storageKey: string
    contentType: string
    fileSizeBytes?: number | null
  }
): Promise<MessageAttachment> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO message_attachments
        (id, message_id, storage_provider, storage_key, content_type, file_size_bytes, created_at)
      VALUES (?1, ?2, 'r2', ?3, ?4, ?5, ?6)
    `)
    .bind(
      id,
      params.messageId,
      params.storageKey,
      params.contentType,
      params.fileSizeBytes ?? null,
      now
    )
    .run()
  const row = await db
    .prepare('SELECT * FROM message_attachments WHERE id = ?1')
    .bind(id)
    .first<MessageAttachment>()
  return row!
}
