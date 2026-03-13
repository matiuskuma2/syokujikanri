/**
 * image-intake-repo.ts
 * 画像解析ジョブ・結果の読み書き
 *
 * 参照テーブル: image_analysis_jobs, image_intake_results
 */

import type { ImageAnalysisJob, ImageIntakeResult, ImageCategory } from '../types/db'
import { generateId, nowIso } from '../utils/id'

// ===================================================================
// image_analysis_jobs
// ===================================================================

/** 画像解析ジョブを作成（Queue enqueue 時に呼ぶ） */
export async function createImageAnalysisJob(
  db: D1Database,
  params: {
    messageAttachmentId: string
    providerRoute?: ImageAnalysisJob['provider_route']
  }
): Promise<ImageAnalysisJob> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO image_analysis_jobs
        (id, message_attachment_id, job_status, provider_route, created_at)
      VALUES (?1, ?2, 'queued', ?3, ?4)
    `)
    .bind(id, params.messageAttachmentId, params.providerRoute ?? 'openai_vision', now)
    .run()
  const row = await db
    .prepare('SELECT * FROM image_analysis_jobs WHERE id = ?1')
    .bind(id)
    .first<ImageAnalysisJob>()
  return row!
}

/** ジョブステータスを更新 */
export async function updateJobStatus(
  db: D1Database,
  jobId: string,
  status: ImageAnalysisJob['job_status'],
  errorMessage?: string | null
): Promise<void> {
  const now = nowIso()
  if (status === 'processing') {
    await db
      .prepare('UPDATE image_analysis_jobs SET job_status = ?1, started_at = ?2 WHERE id = ?3')
      .bind(status, now, jobId)
      .run()
  } else if (status === 'done' || status === 'failed') {
    await db
      .prepare(`
        UPDATE image_analysis_jobs
        SET job_status = ?1, finished_at = ?2, error_message = ?3
        WHERE id = ?4
      `)
      .bind(status, now, errorMessage ?? null, jobId)
      .run()
  }
}

/** attachment_id でジョブを検索 */
export async function findJobByAttachmentId(
  db: D1Database,
  messageAttachmentId: string
): Promise<ImageAnalysisJob | null> {
  const row = await db
    .prepare(`
      SELECT * FROM image_analysis_jobs
      WHERE message_attachment_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(messageAttachmentId)
    .first<ImageAnalysisJob>()
  return row ?? null
}

// ===================================================================
// image_intake_results
// ===================================================================

/** 画像解析結果を保存（pending 状態で作成、24h 後の期限付き） */
export async function saveImageIntakeResult(
  db: D1Database,
  params: {
    messageAttachmentId: string
    userAccountId?: string | null
    lineUserId?: string | null
    dailyLogId?: string | null
    imageCategory: ImageCategory
    confidenceScore?: number | null
    extractedJson?: Record<string, unknown> | null
    proposedActionJson?: Record<string, unknown> | null
  }
): Promise<ImageIntakeResult> {
  const id = generateId()
  const now = nowIso()
  // 24時間後の期限
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19)

  await db
    .prepare(`
      INSERT INTO image_intake_results
        (id, message_attachment_id, user_account_id, line_user_id, daily_log_id,
         image_category, confidence_score, extracted_json, proposed_action_json,
         applied_flag, expires_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?11)
    `)
    .bind(
      id,
      params.messageAttachmentId,
      params.userAccountId ?? null,
      params.lineUserId ?? null,
      params.dailyLogId ?? null,
      params.imageCategory,
      params.confidenceScore ?? null,
      params.extractedJson ? JSON.stringify(params.extractedJson) : null,
      params.proposedActionJson ? JSON.stringify(params.proposedActionJson) : null,
      expiresAt,
      now
    )
    .run()
  const row = await db
    .prepare('SELECT * FROM image_intake_results WHERE id = ?1')
    .bind(id)
    .first<ImageIntakeResult>()
  return row!
}

/** applied_flag を更新（DB反映済みにする） */
export async function markIntakeResultApplied(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE image_intake_results
      SET applied_flag = 1, confirmed_at = ?1, updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), id)
    .run()
}

/** proposed_action_json と extracted_json を更新（テキスト修正用） */
export async function updateIntakeResultProposedAction(
  db: D1Database,
  id: string,
  proposedActionJson: Record<string, unknown>,
  extractedJson?: Record<string, unknown> | null
): Promise<void> {
  const now = nowIso()
  if (extractedJson) {
    await db
      .prepare(`
        UPDATE image_intake_results
        SET proposed_action_json = ?1, extracted_json = ?2, updated_at = ?3
        WHERE id = ?4
      `)
      .bind(JSON.stringify(proposedActionJson), JSON.stringify(extractedJson), now, id)
      .run()
  } else {
    await db
      .prepare(`
        UPDATE image_intake_results
        SET proposed_action_json = ?1, updated_at = ?2
        WHERE id = ?3
      `)
      .bind(JSON.stringify(proposedActionJson), now, id)
      .run()
  }
}

/** ユーザーが取消した場合 */
export async function markIntakeResultDiscarded(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE image_intake_results
      SET applied_flag = 2, confirmed_at = ?1, updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), id)
    .run()
}

/** 24時間タイムアウトで自動破棄（Cron 用） */
export async function expirePendingIntakeResults(
  db: D1Database
): Promise<number> {
  const now = nowIso()
  const result = await db
    .prepare(`
      UPDATE image_intake_results
      SET applied_flag = 3, updated_at = ?1
      WHERE applied_flag = 0 AND expires_at <= ?1
    `)
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

/** ユーザーの未確認(pending)結果を取得 */
export async function findPendingIntakeResult(
  db: D1Database,
  userAccountId: string
): Promise<ImageIntakeResult | null> {
  const row = await db
    .prepare(`
      SELECT * FROM image_intake_results
      WHERE user_account_id = ?1 AND applied_flag = 0
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(userAccountId)
    .first<ImageIntakeResult>()
  return row ?? null
}

/** IDで解析結果を取得 */
export async function findIntakeResultById(
  db: D1Database,
  id: string
): Promise<ImageIntakeResult | null> {
  const row = await db
    .prepare('SELECT * FROM image_intake_results WHERE id = ?1')
    .bind(id)
    .first<ImageIntakeResult>()
  return row ?? null
}

/** attachment_id で解析結果を取得 */
export async function findIntakeResultByAttachmentId(
  db: D1Database,
  messageAttachmentId: string
): Promise<ImageIntakeResult | null> {
  const row = await db
    .prepare(`
      SELECT * FROM image_intake_results
      WHERE message_attachment_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(messageAttachmentId)
    .first<ImageIntakeResult>()
  return row ?? null
}
