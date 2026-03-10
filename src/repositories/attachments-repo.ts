/**
 * attachments-repo.ts
 * 添付ファイルと関連スレッドの照会（files.ts プロキシ・Queue Consumer 用）
 *
 * 参照テーブル: message_attachments, conversation_messages, conversation_threads
 */

import type { MessageAttachment, ConversationThread } from '../types/db'

// ===================================================================
// 参照クエリ（read only）
// ===================================================================

/** attachment ID で MessageAttachment を取得 */
export async function getMessageAttachmentById(
  db: D1Database,
  id: string
): Promise<MessageAttachment | null> {
  const row = await db
    .prepare(`
      SELECT * FROM message_attachments WHERE id = ?1
    `)
    .bind(id)
    .first<MessageAttachment>()
  return row ?? null
}

/**
 * attachment ID から ConversationThread を取得
 * 所有者確認（user_account_id チェック）に使用
 *
 * JOIN: message_attachments → conversation_messages → conversation_threads
 */
export async function getThreadByAttachmentId(
  db: D1Database,
  attachmentId: string
): Promise<ConversationThread | null> {
  const row = await db
    .prepare(`
      SELECT ct.*
      FROM message_attachments ma
      JOIN conversation_messages cm ON ma.message_id = cm.id
      JOIN conversation_threads ct  ON cm.thread_id  = ct.id
      WHERE ma.id = ?1
      LIMIT 1
    `)
    .bind(attachmentId)
    .first<ConversationThread>()
  return row ?? null
}

/**
 * attachment が指定ユーザーの所有物か確認
 * files.ts プロキシエンドポイントの認可チェックで使用
 */
export async function isAttachmentOwnedByUser(
  db: D1Database,
  attachmentId: string,
  userAccountId: string
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT ct.user_account_id
      FROM message_attachments ma
      JOIN conversation_messages cm ON ma.message_id = cm.id
      JOIN conversation_threads ct  ON cm.thread_id  = ct.id
      WHERE ma.id = ?1
        AND ct.user_account_id = ?2
      LIMIT 1
    `)
    .bind(attachmentId, userAccountId)
    .first<{ user_account_id: string }>()
  return row !== null
}
