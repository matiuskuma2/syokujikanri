/**
 * src/routes/user/files.ts
 * R2 画像プロキシ — 所有者確認付き
 *
 * エンドポイント:
 *   GET /api/files/progress/:id  — 進捗写真
 *   GET /api/files/meals/:id     — 食事画像（message_attachments）
 *
 * 認証:
 *   - Bearer JWT が必要（role: 'user' または 'admin' / 'superadmin'）
 *   - user ロールは自身が所有するファイルのみアクセス可
 *   - admin / superadmin はすべてのファイルにアクセス可
 *
 * フロー（progress写真）:
 *   1. JWT 検証
 *   2. progress_photos テーブルから storage_key を取得
 *   3. user ロールの場合: user_account_id == jwt.sub を確認
 *   4. R2 から取得してレスポンス
 *
 * フロー（食事画像）:
 *   1. JWT 検証
 *   2. message_attachments テーブルから storage_key を取得
 *   3. user ロールの場合: isAttachmentOwnedByUser で確認
 *   4. R2 から取得してレスポンス
 *
 * Phase 2 拡張予定:
 *   GET /api/files/progress/:id/signed-url  — R2 署名付き URL を返す
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { authMiddleware } from '../../middleware/auth'
import { findProgressPhotoById } from '../../repositories/progress-photos-repo'
import { getMessageAttachmentById, isAttachmentOwnedByUser } from '../../repositories/attachments-repo'

const filesRouter = new Hono<HonoEnv>()

// 全ルートに JWT 認証を適用
filesRouter.use('*', authMiddleware)

// ===================================================================
// GET /api/files/progress/:id  — 進捗写真
// ===================================================================

filesRouter.get('/progress/:id', async (c) => {
  const payload = c.get('jwtPayload')
  const photoId = c.req.param('id')

  // 1. DB から写真情報を取得
  const photo = await findProgressPhotoById(c.env.DB, photoId)
  if (!photo) {
    return c.json({ success: false, error: 'NOT_FOUND', message: 'Photo not found' }, 404)
  }

  // 2. 所有者チェック（user ロールのみ）
  if (payload.role === 'user' && photo.user_account_id !== payload.sub) {
    return c.json({ success: false, error: 'FORBIDDEN', message: 'Access denied' }, 403)
  }

  // 3. R2 から取得
  const r2Object = await c.env.R2.get(photo.storage_key)
  if (!r2Object) {
    return c.json({ success: false, error: 'NOT_FOUND', message: 'File not found in storage' }, 404)
  }

  // 4. レスポンス返却（CDN キャッシュ 1時間）
  const contentType = r2Object.httpMetadata?.contentType ?? 'image/jpeg'
  return new Response(r2Object.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${photoId}.jpg"`,
    },
  })
})

// ===================================================================
// GET /api/files/meals/:id  — 食事画像（message_attachments）
// ===================================================================

filesRouter.get('/meals/:id', async (c) => {
  const payload = c.get('jwtPayload')
  const attachmentId = c.req.param('id')

  // 1. DB から添付ファイル情報を取得
  const attachment = await getMessageAttachmentById(c.env.DB, attachmentId)
  if (!attachment) {
    return c.json({ success: false, error: 'NOT_FOUND', message: 'Attachment not found' }, 404)
  }

  // 2. 所有者チェック（user ロールのみ）
  if (payload.role === 'user') {
    const isOwned = await isAttachmentOwnedByUser(c.env.DB, attachmentId, payload.sub)
    if (!isOwned) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Access denied' }, 403)
    }
  }

  // 3. R2 から取得
  const r2Object = await c.env.R2.get(attachment.storage_key)
  if (!r2Object) {
    return c.json({ success: false, error: 'NOT_FOUND', message: 'File not found in storage' }, 404)
  }

  // 4. レスポンス返却
  const contentType = attachment.content_type ?? r2Object.httpMetadata?.contentType ?? 'image/jpeg'
  return new Response(r2Object.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${attachmentId}.jpg"`,
    },
  })
})

export default filesRouter
