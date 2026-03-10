/**
 * progress-photos-repo.ts
 * 進捗写真の読み書き（Phase 1: 保存・一覧表示）
 *
 * 参照テーブル: progress_photos
 */

import type { ProgressPhoto } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// progress_photos
// ===================================================================

/** IDで取得 */
export async function findProgressPhotoById(
  db: D1Database,
  id: string
): Promise<ProgressPhoto | null> {
  const row = await db
    .prepare('SELECT * FROM progress_photos WHERE id = ?1')
    .bind(id)
    .first<ProgressPhoto>()
  return row ?? null
}

/** 進捗写真を保存（progress_body_photo 解析後に呼ぶ） */
export async function createProgressPhoto(
  db: D1Database,
  params: {
    userAccountId: string
    dailyLogId?: string | null
    photoDate: string   // YYYY-MM-DD
    storageKey: string
    photoType?: ProgressPhoto['photo_type']
    poseLabel?: ProgressPhoto['pose_label']
    bodyPartLabel?: ProgressPhoto['body_part_label']
    note?: string | null
  }
): Promise<ProgressPhoto> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO progress_photos
        (id, user_account_id, daily_log_id, photo_date, photo_type,
         storage_provider, storage_key, pose_label, body_part_label,
         note, is_public_use_allowed, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'r2', ?6, ?7, ?8, ?9, 0, ?10, ?10)
    `)
    .bind(
      id,
      params.userAccountId,
      params.dailyLogId ?? null,
      params.photoDate,
      params.photoType ?? 'progress',
      params.storageKey,
      params.poseLabel ?? null,
      params.bodyPartLabel ?? null,
      params.note ?? null,
      now
    )
    .run()
  return (await findProgressPhotoById(db, id))!
}

/** ユーザーの進捗写真一覧（新しい順） */
export async function listProgressPhotosByUser(
  db: D1Database,
  userAccountId: string,
  limit = 20,
  offset = 0
): Promise<ProgressPhoto[]> {
  const { results } = await db
    .prepare(`
      SELECT * FROM progress_photos
      WHERE user_account_id = ?1
      ORDER BY photo_date DESC, created_at DESC
      LIMIT ?2 OFFSET ?3
    `)
    .bind(userAccountId, limit, offset)
    .all<ProgressPhoto>()
  return results
}

/** ユーザーの最新1枚を取得（dashboard 用） */
export async function findLatestProgressPhoto(
  db: D1Database,
  userAccountId: string
): Promise<ProgressPhoto | null> {
  const row = await db
    .prepare(`
      SELECT * FROM progress_photos
      WHERE user_account_id = ?1
      ORDER BY photo_date DESC, created_at DESC
      LIMIT 1
    `)
    .bind(userAccountId)
    .first<ProgressPhoto>()
  return row ?? null
}

/** 所有者確認（files.ts プロキシ用） */
export async function isPhotoOwnedByUser(
  db: D1Database,
  photoId: string,
  userAccountId: string
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT id FROM progress_photos
      WHERE id = ?1 AND user_account_id = ?2
    `)
    .bind(photoId, userAccountId)
    .first<{ id: string }>()
  return row !== null
}
