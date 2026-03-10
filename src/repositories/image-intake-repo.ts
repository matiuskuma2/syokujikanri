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

/** 画像解析結果を保存 */
export async function saveImageIntakeResult(
  db: D1Database,
  params: {
    messageAttachmentId: string
    userAccountId?: string | null
    dailyLogId?: string | null
    imageCategory: ImageCategory
    confidenceScore?: number | null
    extractedJson?: Record<string, unknown> | null
    proposedActionJson?: Record<string, unknown> | null
  }
): Promise<ImageIntakeResult> {
  const id = generateId()
  const now = nowIso()
  await db
    .prepare(`
      INSERT INTO image_intake_results
        (id, message_attachment_id, user_account_id, daily_log_id,
         image_category, confidence_score, extracted_json, proposed_action_json,
         applied_flag, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)
    `)
    .bind(
      id,
      params.messageAttachmentId,
      params.userAccountId ?? null,
      params.dailyLogId ?? null,
      params.imageCategory,
      params.confidenceScore ?? null,
      params.extractedJson ? JSON.stringify(params.extractedJson) : null,
      params.proposedActionJson ? JSON.stringify(params.proposedActionJson) : null,
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
      SET applied_flag = 1, updated_at = ?1
      WHERE id = ?2
    `)
    .bind(nowIso(), id)
    .run()
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
