/**
 * process-line-event.ts
 * LINE イベントのディスパッチ・処理
 *
 * 責務を3つのハンドラーに分割:
 *   handleFollowEvent        - フォロー / アンフォロー
 *   handleTextMessageEvent   - テキストメッセージ（record/consult分岐）
 *   handleImageMessageEvent  - 画像（R2保存→Queue投入）
 *
 * 各ハンドラーは独立して例外をキャッチし、
 * 1つのイベントエラーで webhook 全体を落とさない。
 */

import type { Bindings } from '../../types/bindings'
import type {
  LineWebhookEvent,
  LineFollowEvent,
  LineUnfollowEvent,
  LineMessageEvent,
} from '../../types/bindings'

import { getUserProfile, replyText, replyTextWithQuickReplies, replyWithQuickReplies, replyMessages, getMessageContent, pushText } from './reply'
import { startIntakeFlow, handleIntakeStep, beginIntakeFromStart, resumeIntakeFlow } from './intake-flow'
import { upsertLineUser, ensureUserAccount, findUserAccount } from '../../repositories/line-users-repo'
import { upsertUserServiceStatus, checkServiceAccess } from '../../repositories/subscriptions-repo'
import { ensureOpenThread, createConversationMessage, updateThreadMode } from '../../repositories/conversations-repo'
import { findActiveModeSession, upsertModeSession, deleteModeSession } from '../../repositories/mode-sessions-repo'
// Note: ensureDailyLog, upsertWeight, createMealEntry, findMealEntryByDailyLogAndType
// are now called via record-persister.ts (Phase C) instead of directly here
import { createMessageAttachment } from '../../repositories/conversations-repo'
import { createImageAnalysisJob } from '../../repositories/image-intake-repo'
import { createOpenAIClient } from '../ai/openai-client'
import { nowIso, todayJst } from '../../utils/id'

// ===================================================================
// 型・定数
// ===================================================================

type ProcessContext = {
  env: Bindings
  /** LINE チャンネル ID（wrangler.jsonc の line_channel_id または env から解決） */
  lineChannelId: string
  /** LINE チャンネルの client_account_id */
  clientAccountId: string
  /** waitUntil for background processing (from ExecutionContext) */
  waitUntil?: (promise: Promise<unknown>) => void
}

// テキスト分類用キーワード
const CONSULT_KEYWORDS = ['相談', '質問', 'アドバイス', '教えて', 'どうすれば', '悩み', 'ヘルプ', '相談したい']
const RECORD_KEYWORDS = ['記録', 'ログ', 'メモ']
const SWITCH_TO_CONSULT = ['相談モード', '相談にして', '相談する']
const SWITCH_TO_RECORD = ['記録モード', '記録にして', '記録する', '戻る']

// 画像確認 — 確定/取消キーワード（SSOT §8.1）
const IMAGE_CONFIRM_KEYWORDS = ['確定', 'はい', 'yes', 'ok', 'OK', '記録', '保存']
const IMAGE_CANCEL_KEYWORDS = ['取消', 'キャンセル', 'cancel', 'いいえ', 'no', 'やめる', '削除']

// 体重検出パターン: 例 "58.5kg", "58.5 kg", "58キロ"
// 招待コード検出パターン: 例 "ABC-1234"
const INVITE_CODE_PATTERN = /^([A-Z]{3}-\d{4})$/i

// Note: WEIGHT_PATTERN and classifyMealType are now handled by Phase A (interpretation.ts)

// ===================================================================
// メインエントリ: イベントディスパッチ
// ===================================================================

/**
 * 1件の LINE イベントを処理する。
 * エラーは event 単位でキャッチし、上位に伝播させない。
 */
export async function processLineEvent(
  event: LineWebhookEvent,
  ctx: ProcessContext
): Promise<void> {
  try {
    switch (event.type) {
      case 'follow':
        await handleFollowEvent(event as LineFollowEvent, ctx)
        break
      case 'unfollow':
        await handleUnfollowEvent(event as LineUnfollowEvent, ctx)
        break
      case 'message': {
        const msgEvent = event as LineMessageEvent
        if (msgEvent.message.type === 'text') {
          await handleTextMessageEvent(msgEvent, ctx)
        } else if (msgEvent.message.type === 'image') {
          await handleImageMessageEvent(msgEvent, ctx)
        } else {
          // その他メッセージ種別は現時点では無視
          console.log(`[LINE] Unsupported message type: ${msgEvent.message.type}`)
        }
        break
      }
      default:
        console.log(`[LINE] Unhandled event type: ${event.type}`)
    }
  } catch (err) {
    console.error(`[LINE] processLineEvent error (type=${event.type}):`, err)
    // webhook 全体は落とさない — エラーログのみ
  }
}

// ===================================================================
// ensureUserInitialized — フォローイベント未到達時のフォールバック
// ===================================================================

/**
 * フォローイベントが処理されていない（Webhook遅延・エラー等）場合に備え、
 * メッセージ受信時に line_users / user_accounts / user_service_statuses を
 * 自動作成する。既に存在する場合は何もしない。
 */
async function ensureUserInitialized(
  env: Bindings,
  lineChannelId: string,
  lineUserId: string,
  clientAccountId: string
): Promise<void> {
  try {
    // user_service_statuses の存在チェック（最軽量なクエリ）
    const existing = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
    if (existing) return // 既に初期化済み

    console.log(`[LINE] ensureUserInitialized: creating records for ${lineUserId} (follow event may have been missed)`)

    // line_users の upsert（プロフィールは取得できなくてもOK）
    let profile: { displayName?: string; pictureUrl?: string; statusMessage?: string } | null = null
    try {
      profile = await getUserProfile(lineUserId, env.LINE_CHANNEL_ACCESS_TOKEN)
    } catch (err) {
      console.warn(`[LINE] ensureUserInitialized: profile fetch failed for ${lineUserId}:`, err)
    }

    await upsertLineUser(env.DB, {
      lineChannelId,
      lineUserId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
      followStatus: 'following',
    })

    // user_accounts 作成
    await ensureUserAccount(env.DB, lineUserId, clientAccountId)

    // user_service_statuses 初期化（bot_enabled=1）
    await upsertUserServiceStatus(env.DB, {
      accountId: clientAccountId,
      lineUserId,
      botEnabled: 1,
      recordEnabled: 1,
      consultEnabled: 1,
      intakeCompleted: 0,
    })

    console.log(`[LINE] ensureUserInitialized: records created for ${lineUserId}`)
  } catch (err) {
    console.error(`[LINE] ensureUserInitialized error for ${lineUserId}:`, err)
    // エラーでも処理は続行（checkServiceAccess で再度チェックされる）
  }
}

// ===================================================================
// handleFollowEvent — フォロー
// ===================================================================

async function handleFollowEvent(
  event: LineFollowEvent,
  ctx: ProcessContext
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId) return

  const { env, lineChannelId, clientAccountId } = ctx

  // 1. LINE プロフィール取得
  const profile = await getUserProfile(lineUserId, env.LINE_CHANNEL_ACCESS_TOKEN)

  // 2. line_users upsert
  await upsertLineUser(env.DB, {
    lineChannelId,
    lineUserId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
    followStatus: 'following',
  })

  // 3. user_accounts 作成（デフォルトアカウントに仮紐付け）
  await ensureUserAccount(env.DB, lineUserId, clientAccountId)

  // 4. user_service_statuses 初期化
  await upsertUserServiceStatus(env.DB, {
    accountId: clientAccountId,
    lineUserId,
    botEnabled: 1,
    recordEnabled: 1,
    consultEnabled: 1,
    intakeCompleted: 0,
  })

  // 5. 会話スレッド作成（ensureUserAccount は上のステップ3で既に呼ばれているため再利用）
  const existingUA = await findUserAccount(env.DB, lineUserId, clientAccountId)
  if (existingUA) {
    await ensureOpenThread(env.DB, {
      lineChannelId,
      lineUserId,
      clientAccountId,
      userAccountId: existingUA.id,
    })
  }

  // 6. 招待コード入力を促すメッセージを送信
  //    コードが入力されたら handleInviteCode で正しいアカウントに紐付けられる
  //    コードなしでも問診コマンドで開始可能（デフォルトアカウントのまま）
  if (event.replyToken) {
    // 既に別アカウントに紐付いているか確認（再フォロー時）
    const { findInviteCodeUsageByLineUser } = await import('../../repositories/invite-codes-repo')
    const existingUsage = await findInviteCodeUsageByLineUser(env.DB, lineUserId)

    if (existingUsage) {
      // 再フォロー: 既にコード使用済みなので問診を再開
      await startIntakeFlow(
        event.replyToken,
        lineUserId,
        clientAccountId,
        env,
        'follow'
      )
    } else {
      // 初回フォロー: 招待コード入力を促す
      await replyText(
        event.replyToken,
        `🎉 友だち追加ありがとうございます！\n\n食事指導BOTへようこそ。\n\n📋 担当者から受け取った「招待コード」を送信してください。\n\n例: ABC-1234\n\n招待コードを入力すると、あなた専用のダイエットサポートが開始されます！`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    }
  }

  console.log(`[LINE] follow: ${lineUserId} (${profile?.displayName}) — service status created with accountId=${clientAccountId}`)
}

// ===================================================================
// handleUnfollowEvent — アンフォロー
// ===================================================================

async function handleUnfollowEvent(
  event: LineUnfollowEvent,
  ctx: ProcessContext
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId) return

  const { env, lineChannelId } = ctx

  // follow_status を 'blocked' に更新
  await upsertLineUser(env.DB, {
    lineChannelId,
    lineUserId,
    followStatus: 'blocked',
  })

  console.log(`[LINE] unfollow: ${lineUserId}`)
}

// ===================================================================
// handleTextMessageEvent — テキストメッセージ
// ===================================================================

async function handleTextMessageEvent(
  event: LineMessageEvent,
  ctx: ProcessContext
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId || !event.replyToken) return

  const { env, lineChannelId, clientAccountId } = ctx
  const text = event.message.type === 'text' ? event.message.text ?? '' : ''
  const textTrim = text.trim()

  // ==================================================================
  // SSOT 優先順位（docs/07_diet-bot_LINE_運用フロー_画面要件_SSOT.md §2）
  //   ① 画像確認待ち(S3) — 確定/取消以外は全ブロック
  //   ② 招待コード(認証前OK)
  //   ③ サービスアクセス確認
  //   ④ 問診途中(S1)
  //   ⑤ モード切替コマンド
  //   ⑥ 相談キーワード自動切替(CONSULT_KEYWORDS)
  //   ⑦ 体重記録
  //   ⑧ 相談テキスト / 通常テキスト
  // ==================================================================

  // ------------------------------------------------------------------
  // ① 画像確認待ち（S3）— 最優先。確定/取消以外は全てブロック（P7）
  //    サービスアクセスチェックより前に処理する。
  //    session は effectiveAccountId が必要なので、まず access を取得する。
  // ------------------------------------------------------------------
  const preAccess = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
  const preEffectiveAccountId = preAccess?.accountId ?? clientAccountId

  const session = await findActiveModeSession(env.DB, preEffectiveAccountId, lineUserId)
  if (session?.current_step === 'pending_image_confirm') {
    let sessionData: { intakeResultId?: string } = {}
    try {
      sessionData = session.session_data ? JSON.parse(session.session_data) : {}
    } catch { /* ignore */ }

    const intakeResultId = sessionData.intakeResultId
    if (!intakeResultId) {
      // データ不整合 — セッションをクリアして通常処理へ
      await deleteModeSession(env.DB, preEffectiveAccountId, lineUserId)
      // fall through to normal processing
    } else {
      // --- pending_image_confirm 中は確認フロー優先 ---
      // リッチメニュー系コマンド → 確認完了を促す（新しい操作を開始させない）
      const PENDING_BLOCK_COMMANDS = [
        '記録する', '記録モード', '記録にして', '戻る',
        '相談する', '相談モード', '相談にして',
        '写真を送る', '体重記録', '体重を記録',
        '問診', 'ヒアリング', '登録', '初期設定', '問診やり直し', '問診リセット', '問診再開',
      ]
      if (PENDING_BLOCK_COMMANDS.includes(textTrim)) {
        await replyWithQuickReplies(
          event.replyToken,
          '🔄 いま前の食事の確認待ちです。\n先にこの内容を「✅ 確定」「修正テキスト」「❌ 取消」のいずれかで完了してください。',
          [
            { label: '✅ 確定', text: '確定' },
            { label: '❌ 取消', text: '取消' },
          ],
          env.LINE_CHANNEL_ACCESS_TOKEN
        )
        return
      }

      // 確定キーワード（完全一致優先、部分一致は「確定」「はい」など短いキーワードのみ）
      const isConfirm = IMAGE_CONFIRM_KEYWORDS.some(kw => textTrim === kw) ||
        (textTrim.length <= 4 && IMAGE_CONFIRM_KEYWORDS.some(kw => textTrim.includes(kw)))
      const isCancel = IMAGE_CANCEL_KEYWORDS.some(kw => textTrim === kw) ||
        (textTrim.length <= 6 && IMAGE_CANCEL_KEYWORDS.some(kw => textTrim.includes(kw)))

      if (isConfirm) {
        const { handleImageConfirm } = await import('./image-confirm-handler')
        await handleImageConfirm(event.replyToken, intakeResultId, lineUserId, preEffectiveAccountId, env)
        return
      } else if (isCancel) {
        const { handleImageDiscard } = await import('./image-confirm-handler')
        await handleImageDiscard(event.replyToken, intakeResultId, lineUserId, preEffectiveAccountId, env)
        return
      } else {
        // テキスト修正として処理: ユーザーの修正を AI で再解析し、提案を更新する
        const { handleImageCorrection } = await import('./image-confirm-handler')
        await handleImageCorrection(event.replyToken, textTrim, intakeResultId, lineUserId, preEffectiveAccountId, env)
        return
      }
    }
  }

  // ------------------------------------------------------------------
  // ② 招待コード検出（認証前OK — S0 でも受付）
  // ------------------------------------------------------------------
  const inviteMatch = textTrim.match(INVITE_CODE_PATTERN)
  if (inviteMatch) {
    console.log(`[LINE] invite code detected (pre-auth): ${inviteMatch[1]} from ${lineUserId}`)
    await handleInviteCode(
      event.replyToken,
      inviteMatch[1],
      lineUserId,
      ctx
    )
    return
  }

  // ------------------------------------------------------------------
  // ③ サービスアクセス確認（S0 → ブロック）
  // ------------------------------------------------------------------
  const access = preAccess // 既に取得済みを再利用
  if (!access || !access.botEnabled) {
    console.warn(`[LINE] service access denied: lineUserId=${lineUserId}, accountId=${clientAccountId}, access=${JSON.stringify(access)}`)
    await replyText(event.replyToken, '📋 招待コードを入力してください。\n\n担当者から受け取ったコード（例: ABC-1234）を送信すると、サービスが利用できるようになります。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  const effectiveAccountId = access.accountId

  // ------------------------------------------------------------------
  // ユーザー・スレッド確保 + メッセージ保存
  // ------------------------------------------------------------------
  const userAccount = await ensureUserAccount(env.DB, lineUserId, effectiveAccountId)
  const thread = await ensureOpenThread(env.DB, {
    lineChannelId,
    lineUserId,
    clientAccountId: effectiveAccountId,
    userAccountId: userAccount.id,
  })

  // R5: Webhook Idempotency — 同一 line_message_id の重複処理を防止
  try {
    await createConversationMessage(env.DB, {
      threadId: thread.id,
      senderType: 'user',
      lineMessageId: event.message.id,
      messageType: 'text',
      rawText: textTrim,
      normalizedText: textTrim,
      modeAtSend: thread.current_mode,
      sentAt: new Date(event.timestamp).toISOString().replace('T', ' ').substring(0, 19),
    })
  } catch (msgErr: unknown) {
    // UNIQUE 制約違反 = 既に処理済みのメッセージ → スキップ
    if (msgErr instanceof Error && msgErr.message?.includes('UNIQUE')) {
      console.log(`[LINE] R5 idempotency: duplicate message ${event.message.id}, skipping`)
      return
    }
    // その他のエラーは処理続行（メッセージ保存失敗でもBOT応答は行う）
    console.warn('[LINE] createConversationMessage error (continuing):', msgErr)
  }

  // ------------------------------------------------------------------
  // ④ 問診途中（S1: mode=intake）— モード切替コマンドより前に評価
  // ------------------------------------------------------------------
  const currentMode = session?.current_mode ?? thread.current_mode

  if (currentMode === 'intake') {
    const handled = await handleIntakeStep(
      event.replyToken,
      textTrim,
      lineUserId,
      userAccount.id,
      effectiveAccountId,
      env
    )
    if (handled) return
    // handleIntakeStep が false を返した場合（セッション不整合）→ 通常処理へ
  }

  // ------------------------------------------------------------------
  // ⑤ モード切替コマンド判定
  // ------------------------------------------------------------------

  // 問診開始 / 再開コマンド
  if (['問診', 'ヒアリング', '登録', '初期設定'].includes(textTrim) || /ヒアリング.*(お願い|開始|して|したい)/i.test(textTrim)) {
    await startIntakeFlow(event.replyToken, lineUserId, effectiveAccountId, env, 'command')
    return
  }

  // 「問診やり直し」→ 最初から新規開始
  if (textTrim === '問診やり直し' || textTrim === '問診リセット') {
    await upsertUserServiceStatus(env.DB, {
      accountId: effectiveAccountId,
      lineUserId,
      intakeCompleted: 0,
    })
    await beginIntakeFromStart(event.replyToken, lineUserId, effectiveAccountId, env)
    return
  }

  // 「問診再開」→ 途中のステップから続行
  if (textTrim === '問診再開') {
    await resumeIntakeFlow(event.replyToken, lineUserId, effectiveAccountId, env)
    return
  }

  // ------------------------------------------------------------------
  // ⑤a Rich Menu ボタンからの特殊トリガー
  // ------------------------------------------------------------------

  // 「写真を送る」ボタン → 画像送信を促す案内
  if (textTrim === '写真を送る') {
    // record モードへ切替
    try { await updateThreadMode(env.DB, thread.id, 'record') } catch (e) { console.error('[LINE] updateThreadMode(record) error:', e) }
    try { await deleteModeSession(env.DB, effectiveAccountId, lineUserId) } catch (e) { /* ignore */ }
    await replyText(
      event.replyToken,
      '📝 記録したい内容を送ってください。食事写真・食事テキスト・体重の数字・体重計の写真、どれでもOKです。\n\n💡 写真のヒント:\n・真上から撮ると認識精度UP\n・お皿全体が入るように\n・1品ずつでも、まとめてでもOK',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // 「体重記録」ボタン → 体重入力を促す案内
  if (textTrim === '体重記録' || textTrim === '体重を記録') {
    // record モードへ切替
    try { await updateThreadMode(env.DB, thread.id, 'record') } catch (e) { console.error('[LINE] updateThreadMode(record) error:', e) }
    try { await deleteModeSession(env.DB, effectiveAccountId, lineUserId) } catch (e) { /* ignore */ }
    await replyTextWithQuickReplies(
      event.replyToken,
      '⚖️ 体重を入力してください！\n\n例: 65.5kg\n例: 58キロ\n\n※ 数字＋kg（またはキロ）で記録されます',
      [
        { label: '📝 記録する', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // R6-2: モード切替コマンドで pending_clarification を cancelled に
  // 明示的モード切替
  if (SWITCH_TO_CONSULT.some(kw => textTrim.includes(kw))) {
    try {
      const { cancelActiveClarifications } = await import('../../repositories/pending-clarifications-repo')
      await cancelActiveClarifications(env.DB, userAccount.id)
    } catch (e) { console.warn('[LINE] cancelActiveClarifications on consult switch:', e) }
    try { await updateThreadMode(env.DB, thread.id, 'consult') } catch (e) { console.error('[LINE] updateThreadMode(consult) error:', e) }
    try {
      await upsertModeSession(env.DB, {
        clientAccountId: effectiveAccountId,
        lineUserId,
        currentMode: 'consult',
        currentStep: 'idle',
      })
    } catch (e) { console.error('[LINE] upsertModeSession(consult) error:', e) }
    await replyText(event.replyToken, '💬 相談モードです。食事・体重・外食・間食・続け方など、何でも送ってください 😊', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  if (SWITCH_TO_RECORD.some(kw => textTrim.includes(kw))) {
    // R6-2: モード切替コマンドで pending_clarification を cancelled に
    try {
      const { cancelActiveClarifications } = await import('../../repositories/pending-clarifications-repo')
      await cancelActiveClarifications(env.DB, userAccount.id)
    } catch (e) { console.warn('[LINE] cancelActiveClarifications on record switch:', e) }
    try { await updateThreadMode(env.DB, thread.id, 'record') } catch (e) { console.error('[LINE] updateThreadMode(record) error:', e) }
    try { await deleteModeSession(env.DB, effectiveAccountId, lineUserId) } catch (e) { console.error('[LINE] deleteModeSession error:', e) }
    await replyText(event.replyToken, '📝 記録モードです。\n記録したい内容を送ってください。食事写真・食事テキスト・体重の数字・体重計の写真、どれでもOKです。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // ⑥ CONSULT_KEYWORDS 暗黙的切替（record モード中のみ）
  //    「相談」「教えて」等のキーワードで自動的に consult へ切替
  // ------------------------------------------------------------------
  if (currentMode !== 'consult' && CONSULT_KEYWORDS.some(kw => textTrim.includes(kw))) {
    try { await updateThreadMode(env.DB, thread.id, 'consult') } catch (e) { console.error('[LINE] auto-switch consult error:', e) }
    try {
      await upsertModeSession(env.DB, {
        clientAccountId: effectiveAccountId,
        lineUserId,
        currentMode: 'consult',
        currentStep: 'idle',
      })
    } catch (e) { console.error('[LINE] auto-switch consult session error:', e) }
    // 自動切替の場合、切替メッセージは送らず直接相談処理へ
    await handleConsultText(event.replyToken, textTrim, thread.id, userAccount.id, ctx)
    return
  }

  // ------------------------------------------------------------------
  // ⑦⑧ 現在のモードに応じて処理
  // ------------------------------------------------------------------
  if (currentMode === 'consult') {
    await handleConsultText(event.replyToken, textTrim, thread.id, userAccount.id, ctx)
  } else {
    await handleRecordText(event.replyToken, textTrim, userAccount.id, effectiveAccountId, lineUserId, thread.id, ctx, event.message.id)
  }
}

// ===================================================================
// handleRecordText — 記録モードのテキスト処理
// SSOT v2.0: Phase A → Phase B → Phase C パイプライン
// ===================================================================

async function handleRecordText(
  replyToken: string,
  text: string,
  userAccountId: string,
  clientAccountId: string,
  lineUserId: string,
  threadId: string,
  ctx: ProcessContext,
  lineMessageId?: string
): Promise<void> {
  const { env } = ctx

  // ------------------------------------------------------------------
  // Phase B 復帰: pending_clarification に対する回答チェック
  // ------------------------------------------------------------------
  try {
    const { handleClarificationAnswer, sendNextClarificationQuestion } =
      await import('./clarification-handler')
    const { findActiveClarification } = await import('../../repositories/pending-clarifications-repo')

    const pendingClar = await findActiveClarification(env.DB, userAccountId)
    if (pendingClar) {
      const clarResult = await handleClarificationAnswer(
        text, userAccountId, clientAccountId, lineUserId, env
      )

      if (clarResult.complete && clarResult.updatedIntent) {
        // Phase B 完了 → Phase C 保存
        const { persistRecord } = await import('./record-persister')
        const result = await persistRecord(clarResult.updatedIntent, userAccountId, clientAccountId, env)

        // 明確化レコードを物理削除
        if (clarResult.pendingId) {
          const { deleteClarification } = await import('../../repositories/pending-clarifications-repo')
          await deleteClarification(env.DB, clarResult.pendingId)
        }

        await saveBotMessage(env.DB, threadId, result.replyMessage)
        await replyTextWithQuickReplies(
          replyToken,
          result.replyMessage,
          [
            { label: '📝 続けて記録', text: '記録モード' },
            { label: '💬 相談する', text: '相談モード' },
          ],
          env.LINE_CHANNEL_ACCESS_TOKEN
        )

        // バックグラウンド: メモリ抽出
        fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)
        return
      } else if (clarResult.pendingId && clarResult.updatedIntent) {
        // まだ不足フィールドあり → 次の質問を送信
        await sendNextClarificationQuestion(
          replyToken, clarResult.updatedIntent, clarResult.pendingId, env
        )
        return
      } else if (clarResult.pendingId && !clarResult.updatedIntent) {
        // パース失敗 → 再質問（同じフィールド）
        const rePending = await findActiveClarification(env.DB, userAccountId)
        if (rePending) {
          const currentField = rePending.current_field
          let reText = '🤔 もう少し教えてください。'
          if (currentField === 'target_date') reText = '🤔 日付がわかりませんでした。「今日」「昨日」「3/10」のように教えてください。'
          if (currentField === 'meal_type') reText = '🤔 食事区分がわかりませんでした。「朝食」「昼食」「夕食」「間食」のどれですか？'
          if (currentField === 'weight_value') reText = '🤔 体重がわかりませんでした。「58.5」のように数字で教えてください。'

          await replyText(replyToken, reText, env.LINE_CHANNEL_ACCESS_TOKEN)
          return
        }
      }
      // それ以外 → pending が見つからない等 → 通常のPhase Aへフォールスルー
    }
  } catch (err) {
    console.error('[RecordText] clarification check error:', err)
    // エラー時は通常の Phase A 処理へフォールスルー
  }

  // ------------------------------------------------------------------
  // Phase A: AI 解釈 → Unified Intent JSON
  // ------------------------------------------------------------------
  const { interpretMessage, buildUserContextForInterpretation } =
    await import('../ai/interpretation')
  const { canSaveImmediately, canSaveWithConfirmation } =
    await import('../../types/intent')

  const userCtx = await buildUserContextForInterpretation(
    env.DB, threadId, userAccountId, 'record', Date.now()
  )

  let intent: Awaited<ReturnType<typeof interpretMessage>>
  let fallbackUsed: 'gpt' | 'regex' | 'unclear' = 'gpt'
  try {
    intent = await interpretMessage(text, userCtx, env)
    // R14: フォールバック検出
    if (intent.reasoning?.includes('フォールバック')) {
      fallbackUsed = intent.intent_primary === 'unclear' ? 'unclear' : 'regex'
    }
  } catch (interpretErr) {
    console.error('[RecordText] Phase A interpret error:', interpretErr)
    fallbackUsed = 'regex'
    const { createFallbackIntent } = await import('../ai/interpretation')
    intent = createFallbackIntent(text, userCtx)
    if (intent.intent_primary === 'unclear') fallbackUsed = 'unclear'
  }

  // R13: Phase A 監査ログ
  console.log(JSON.stringify({
    event: 'phase_a_result',
    line_message_id: lineMessageId ?? null,
    user_account_id: userAccountId,
    intent_primary: intent.intent_primary,
    intent_secondary: intent.intent_secondary,
    confidence: intent.confidence,
    needs_clarification: intent.needs_clarification,
    target_date_source: intent.target_date.source,
    meal_type_source: intent.meal_type?.source ?? null,
    fallback_used: fallbackUsed,
  }))

  console.log(`[RecordText] Phase A: primary=${intent.intent_primary}, conf=${intent.confidence}, clarify=[${intent.needs_clarification.join(',')}], fallback=${fallbackUsed}`)

  // ------------------------------------------------------------------
  // 意図別ルーティング
  // ------------------------------------------------------------------

  // 相談意図を検出 → 自動切替
  if (intent.intent_primary === 'consult') {
    try { await updateThreadMode(env.DB, threadId, 'consult') } catch { /* ignore */ }
    await handleConsultText(replyToken, text, threadId, userAccountId, ctx)
    return
  }

  // 挨拶 → フレンドリーに返す
  if (intent.intent_primary === 'greeting') {
    await replyTextWithQuickReplies(
      replyToken,
      '👋 こんにちは！\n\n食事の内容や体重を送ってくださいね 😊\n\n例: 「朝食 トースト・コーヒー」\n例: 「58.5kg」',
      [
        { label: '📝 記録する', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // 意図不明 → ガイド
  if (intent.intent_primary === 'unclear') {
    await replyTextWithQuickReplies(
      replyToken,
      '🤔 記録内容が判定できませんでした。\n\n体重・食事・運動などを入力してください。\n例: 「体重58.5kg」\n例: 「朝食 トースト・コーヒー」',
      [
        { label: '📝 記録する', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // ------------------------------------------------------------------
  // 即時保存チェック (Phase C 直行)
  // ------------------------------------------------------------------
  if (canSaveImmediately(intent)) {
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)

    // R13: Phase C 監査ログ
    console.log(JSON.stringify({
      event: 'phase_c_result',
      line_message_id: lineMessageId ?? null,
      user_account_id: userAccountId,
      persist_action: result.persist_action ?? (result.success ? 'created' : 'rejected'),
      target_table: intent.intent_primary === 'record_weight' ? 'body_metrics' : 'meal_entries',
      target_record_id: null,
      error: result.error ?? null,
    }))

    await saveBotMessage(env.DB, threadId, result.replyMessage)
    await replyTextWithQuickReplies(
      replyToken,
      result.replyMessage,
      [
        { label: '📝 続けて記録', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )

    // バックグラウンド: メモリ抽出
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)

    // 副次意図: 相談レスポンスも生成 (Phase 2 で実装予定)
      // intent.reply_policy.generate_consult_reply が true の場合、
      // push で相談返答を送信する機能を追加予定
    return
  }

  if (canSaveWithConfirmation(intent)) {
    // timestamp 由来でも保存はする。ただし確認メッセージを添える
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)

    // R13: Phase C 監査ログ（確認付き保存）
    console.log(JSON.stringify({
      event: 'phase_c_result',
      line_message_id: lineMessageId ?? null,
      user_account_id: userAccountId,
      persist_action: result.persist_action ?? (result.success ? 'created' : 'rejected'),
      target_table: 'meal_entries',
      target_record_id: null,
      error: result.error ?? null,
    }))

    const confirmNote = intent.target_date.source === 'timestamp' && intent.meal_type?.source === 'timestamp'
      ? '\n\n⏰ 日付と食事区分は送信時刻から推定しました。違う場合はお知らせください。'
      : intent.target_date.source === 'timestamp'
        ? '\n\n⏰ 日付は送信時刻から推定しました。違う場合は「昨日」などと教えてください。'
        : (intent.meal_type?.source === 'timestamp'
          ? '\n\n⏰ 食事区分は送信時刻から推定しました。違う場合は「朝食」などと教えてください。'
          : '')

    await saveBotMessage(env.DB, threadId, result.replyMessage + confirmNote)
    await replyTextWithQuickReplies(
      replyToken,
      result.replyMessage + confirmNote,
      [
        { label: '📝 続けて記録', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )

    // バックグラウンド: メモリ抽出
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)
    return
  }

  // ------------------------------------------------------------------
  // 修正・削除の場合 → Phase C 直行（対象探索は persistRecord 内で行う）
  // ------------------------------------------------------------------
  if (intent.intent_primary === 'correct_record' || intent.intent_primary === 'delete_record') {
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)

    await saveBotMessage(env.DB, threadId, result.replyMessage)
    await replyTextWithQuickReplies(
      replyToken,
      result.replyMessage,
      [
        { label: '📝 続けて記録', text: '記録モード' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // ------------------------------------------------------------------
  // Phase B: 不足フィールドあり → 明確化フロー開始
  // ------------------------------------------------------------------
  if (intent.needs_clarification.length > 0) {
    const { startClarificationFlow } = await import('./clarification-handler')
    await startClarificationFlow(
      replyToken, intent, text,
      userAccountId, clientAccountId, null,
      lineUserId, env
    )
    return
  }

  // ------------------------------------------------------------------
  // フォールバック: ここに来るケースは少ないはず
  // ------------------------------------------------------------------
  await replyTextWithQuickReplies(
    replyToken,
    '🤔 記録内容が判定できませんでした。\n\n体重・食事・運動などを入力してください。\n例: 「体重58.5kg」\n例: 「朝食 トースト・コーヒー」',
    [
      { label: '📝 記録する', text: '記録モード' },
      { label: '💬 相談する', text: '相談モード' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// ヘルパー: BOT メッセージ保存
// ===================================================================

async function saveBotMessage(db: D1Database, threadId: string, text: string): Promise<void> {
  try {
    await createConversationMessage(db, {
      threadId,
      senderType: 'bot',
      messageType: 'text',
      rawText: text,
      modeAtSend: 'record',
      sentAt: nowIso(),
    })
  } catch (err) {
    console.error('[saveBotMessage] error:', err)
  }
}

// ===================================================================
// ヘルパー: バックグラウンドメモリ抽出
// ===================================================================

function fireMemoryExtraction(
  text: string,
  userAccountId: string,
  messageId: string | null,
  env: Bindings,
  waitUntil?: (promise: Promise<unknown>) => void
): void {
  const work = (async () => {
    try {
      const { extractMemoryFromMessage } = await import('../ai/memory-extraction')
      await extractMemoryFromMessage(text, userAccountId, messageId, env)
    } catch (err) {
      console.error('[MemoryExtraction] background error:', err)
    }
  })()

  if (waitUntil) {
    waitUntil(work)
  }
  // waitUntil がなければ fire-and-forget（Cloudflare の制限内で最善努力）
}

// ===================================================================
// handleConsultText — 相談モードのテキスト処理
// ===================================================================

async function handleConsultText(
  replyToken: string,
  text: string,
  threadId: string,
  userAccountId: string,
  ctx: ProcessContext
): Promise<void> {
  const { env } = ctx

  try {
    const ai = createOpenAIClient(env)

    // ------------------------------------------------------------------
    // Phase A: 副次意図チェック（相談中に記録情報が含まれていないか）
    // ------------------------------------------------------------------
    let secondaryRecordSaved = false
    try {
      const { interpretMessage, buildUserContextForInterpretation } =
        await import('../ai/interpretation')
      const { canSaveImmediately } = await import('../../types/intent')

      const userCtx = await buildUserContextForInterpretation(
        env.DB, threadId, userAccountId, 'consult', Date.now()
      )
      const intent = await interpretMessage(text, userCtx, env)

      // R1-6: 相談モードで intent_primary が record_* の場合、記録モードに自動切替
      if (intent.intent_primary === 'record_meal' || intent.intent_primary === 'record_weight') {
        console.log(`[Consult] auto-switch to record: primary=${intent.intent_primary}, conf=${intent.confidence}`)
        try { await updateThreadMode(env.DB, threadId, 'record') } catch { /* ignore */ }
        if (canSaveImmediately(intent)) {
          const { persistRecord } = await import('./record-persister')
          const result = await persistRecord(intent, userAccountId, ctx.clientAccountId, env)
          if (result.success) {
            secondaryRecordSaved = true
            // R1-6 は「記録も保存しました」ではなく通常の記録保存返信
            // ただし相談応答も並行して生成するため secondaryRecordSaved で追記
            console.log(`[Consult] R1-6 primary record saved: ${intent.intent_primary}`)
          }
        }
        // canSaveImmediately == false の場合は相談応答にフォールスルー
      }

      // R1-3, R1-4, R1-5: 副次意図の記録検出
      // 相談モードでも体重・食事記録を副次意図として検出 → 保存
      const { CONSULT_SECONDARY_SAVE_THRESHOLD } = await import('../../types/intent')
      const secondaryEligible = !secondaryRecordSaved && intent.intent_secondary &&
          (intent.intent_secondary === 'record_meal' || intent.intent_secondary === 'record_weight') &&
          intent.confidence >= CONSULT_SECONDARY_SAVE_THRESHOLD

      if (secondaryEligible) {
        // 副次意図を主意図に昇格させて保存
        const recordIntent = { ...intent, intent_primary: intent.intent_secondary! }
        if (canSaveImmediately(recordIntent)) {
          const { persistRecord } = await import('./record-persister')
          const result = await persistRecord(recordIntent, userAccountId, ctx.clientAccountId, env)
          if (result.success) {
            secondaryRecordSaved = true
          }

          // R13: 相談中副次記録 監査ログ
          console.log(JSON.stringify({
            event: 'consult_secondary_record',
            user_account_id: userAccountId,
            intent_secondary: intent.intent_secondary,
            confidence: intent.confidence,
            saved: result.success,
            reason: result.success ? 'threshold_met' : 'error',
          }))
        } else {
          // R13: canSaveImmediately 不成立
          console.log(JSON.stringify({
            event: 'consult_secondary_record',
            user_account_id: userAccountId,
            intent_secondary: intent.intent_secondary,
            confidence: intent.confidence,
            saved: false,
            reason: 'cannot_save_immediately',
          }))
        }
      } else if (intent.intent_secondary &&
          (intent.intent_secondary === 'record_meal' || intent.intent_secondary === 'record_weight')) {
        // R13: 閾値未満
        console.log(JSON.stringify({
          event: 'consult_secondary_record',
          user_account_id: userAccountId,
          intent_secondary: intent.intent_secondary,
          confidence: intent.confidence,
          saved: false,
          reason: 'below_threshold',
        }))
      }
    } catch (err) {
      console.warn('[Consult] secondary intent detection error:', err)
    }

    // 直近の会話履歴を取得（最大10ターン）
    const { listRecentMessages } = await import('../../repositories/conversations-repo')
    const history = await listRecentMessages(env.DB, threadId, 20)
    const aiMessages = history
      .filter(m => m.sender_type === 'user' || m.sender_type === 'bot')
      .slice(-10)
      .map(m => ({
        role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.raw_text ?? '',
      }))

    // ---------------------------------------------------------------
    // 1. DB から system_prompt を取得（なければハードコードフォールバック）
    // ---------------------------------------------------------------
    const { getPublishedSystemPrompt, searchKnowledgeForBot, buildUserContext } =
      await import('../../repositories/knowledge-repo')

    let basePrompt = await getPublishedSystemPrompt(env.DB, ctx.clientAccountId)
    if (!basePrompt) {
      basePrompt = `あなたはダイエット専門のAIアシスタントです。
ユーザーの食事・運動・体重管理をサポートし、科学的根拠に基づいたアドバイスを提供します。
- 常に励ましながら、具体的で実践的なアドバイスをしてください
- 医療診断は行わず、気になる症状は専門医への相談を促してください
- 日本語で、丁寧かつ親しみやすい口調で応答してください
- 回答は200文字以内で簡潔にまとめてください`
    }

    // ---------------------------------------------------------------
    // 2. ナレッジ検索（ユーザーの質問に関連する知識を取得）
    // ---------------------------------------------------------------
    const knowledgeDocs = await searchKnowledgeForBot(env.DB, ctx.clientAccountId, text, 3)
    let knowledgeContext = ''
    if (knowledgeDocs.length > 0) {
      knowledgeContext = '\n\n【参考ナレッジ】\n' +
        knowledgeDocs.map(d => `[${d.title}] ${d.content}`).join('\n---\n')
    }

    // ---------------------------------------------------------------
    // 3. ユーザー個人コンテキスト + パーソナルメモリ
    // ---------------------------------------------------------------
    const userContext = await buildUserContext(env.DB, userAccountId)
    let personalContext = ''
    if (userContext.trim()) {
      personalContext = '\n\n' + userContext
    }

    // パーソナルメモリ(Layer 3)もコンテキストに注入
    let memoryContext = ''
    try {
      const { findActiveMemories } = await import('../../repositories/user-memory-repo')
      const memories = await findActiveMemories(env.DB, userAccountId)
      const relevant = memories.filter(m => m.confidence_score >= 0.6) // MEMORY_CONFIDENCE_MIN
      if (relevant.length > 0) {
        memoryContext = '\n\n【ユーザーの既知情報】\n' +
          relevant.map(m => `- [${m.category}] ${m.memory_value}`).join('\n')
      }
    } catch { /* テーブル未作成時は無視 */ }

    // ---------------------------------------------------------------
    // 4. system prompt を組み立て
    // ---------------------------------------------------------------
    const systemPrompt = basePrompt + personalContext + memoryContext + knowledgeContext

    const response = await ai.createResponse(
      [
        { role: 'system', content: systemPrompt },
        ...aiMessages,
        { role: 'user', content: text },
      ],
      { temperature: 0.7, maxTokens: 512 }
    )

    // bot の発言を保存
    await createConversationMessage(env.DB, {
      threadId,
      senderType: 'bot',
      messageType: 'text',
      rawText: response,
      modeAtSend: 'consult',
      sentAt: nowIso(),
    })

    // 副次記録がある場合は追記
    const replyMsg = secondaryRecordSaved
      ? `${response}\n\n📝 ※会話中の記録情報も保存しました`
      : response

    await replyTextWithQuickReplies(
      replyToken,
      replyMsg,
      [
        { label: '📝 記録に戻る', text: '記録モード' },
        { label: '💬 続けて相談', text: '相談続ける' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )

    // バックグラウンド: メモリ抽出
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)

  } catch (err) {
    console.error('[LINE] consult AI error:', err)
    await replyText(
      replyToken,
      'AIの応答に失敗しました。しばらくしてから再度お試しください。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch((replyErr) => {
      console.warn('[Consult] error reply also failed:', replyErr)
    })
  }
}

// ===================================================================
// handleImageMessageEvent — 画像メッセージ
// ===================================================================

async function handleImageMessageEvent(
  event: LineMessageEvent,
  ctx: ProcessContext
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId) return

  const { env, lineChannelId, clientAccountId } = ctx
  const replyToken = event.replyToken

  console.log(`[LINE] handleImage START: lineUserId=${lineUserId}, messageId=${event.message.id}`)

  // ------------------------------------------------------------------
  // 1. サービスアクセス確認
  // ------------------------------------------------------------------
  let access: Awaited<ReturnType<typeof checkServiceAccess>> = null
  try {
    access = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
  } catch (e) {
    console.error('[LINE] handleImage checkServiceAccess error:', e)
  }

  if (!access || !access.botEnabled) {
    console.warn(`[LINE] image access denied: lineUserId=${lineUserId}`)
    if (replyToken) {
      await replyText(replyToken, '📋 まずは招待コードを入力してください。\n\n担当者から受け取ったコード（例: ABC-1234）を送信すると、画像解析機能が利用できるようになります。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(e => console.error('[LINE] reply error:', e))
    }
    return
  }

  const effectiveAccountId = access.accountId
  console.log(`[LINE] handleImage: access OK, effectiveAccountId=${effectiveAccountId}`)

  // ------------------------------------------------------------------
  // 1.5 画像確認待ち(S3)中は新しい画像をブロック（SSOT §8.2）
  // ------------------------------------------------------------------
  const imgSession = await findActiveModeSession(env.DB, effectiveAccountId, lineUserId)
  if (imgSession?.current_step === 'pending_image_confirm') {
    if (replyToken) {
      await replyWithQuickReplies(
        replyToken,
        '🔄 いま画像の確認中です。\n先に確認が完了してから新しい画像を送ってください。',
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(e => console.error('[LINE] reply error:', e))
    }
    return
  }

  // ------------------------------------------------------------------
  // 2. ユーザー・スレッドの確保（エラーでも続行を試みる）
  //    R6-3: 画像受信時に pending_clarification を cancelled に
  // ------------------------------------------------------------------
  let userAccount: Awaited<ReturnType<typeof ensureUserAccount>>
  let thread: Awaited<ReturnType<typeof ensureOpenThread>>
  try {
    userAccount = await ensureUserAccount(env.DB, lineUserId, effectiveAccountId)

    // R6-3: 画像は新しい記録行為 → 明確化待ちをキャンセル
    try {
      const { cancelActiveClarifications } = await import('../../repositories/pending-clarifications-repo')
      await cancelActiveClarifications(env.DB, userAccount.id)
    } catch (e) { console.warn('[LINE] cancelActiveClarifications on image:', e) }

    thread = await ensureOpenThread(env.DB, {
      lineChannelId,
      lineUserId,
      clientAccountId: effectiveAccountId,
      userAccountId: userAccount.id,
    })
  } catch (e) {
    console.error('[LINE] handleImage user/thread setup error:', e)
    if (replyToken) {
      await replyText(replyToken, '⚠️ 一時的なエラーが発生しました。もう一度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
    }
    return
  }

  console.log(`[LINE] handleImage: userAccount=${userAccount.id}, thread=${thread.id}`)

  // ------------------------------------------------------------------
  // 3. 即時返信（解析中メッセージ）— 最優先で送信
  //    replyToken は受信後30秒で失効するため、他の処理より先に返信する
  // ------------------------------------------------------------------
  if (replyToken) {
    await replyText(
      replyToken,
      '📷 画像を受け取りました！\n解析中です。少しお待ちください...',
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[LINE] handleImage reply error:', e))
  }

  // ------------------------------------------------------------------
  // 4. 以降のバックグラウンド処理を waitUntil で実行
  //    （webhook は即座に 200 を返し、画像処理はバックグラウンドで継続）
  // ------------------------------------------------------------------
  const bgWork = (async () => {
    try {
      // 4a. LINE Content API から画像バイナリを取得
      let content: Awaited<ReturnType<typeof getMessageContent>> = null
      try {
        content = await getMessageContent(event.message.id, env.LINE_CHANNEL_ACCESS_TOKEN)
      } catch (e) {
        console.error('[LINE] handleImage getMessageContent error:', e)
      }

      if (!content) {
        console.error(`[LINE] handleImage: content is null for messageId=${event.message.id}`)
        await pushText(lineUserId, '画像の取得に失敗しました。もう一度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
        return
      }

      console.log(`[LINE] handleImage: content fetched, size=${content.data.byteLength}, type=${content.contentType}`)

      // 4b. R2 に保存
      const today = todayJst()
      const r2Key = `intake/${userAccount.id}/${today}-${event.message.id}.jpg`

      try {
        await env.R2.put(r2Key, content.data, {
          httpMetadata: { contentType: content.contentType },
        })
        console.log(`[LINE] handleImage: R2 saved: ${r2Key}`)
      } catch (err) {
        console.error('[LINE] handleImage R2 put error:', err)
        await pushText(lineUserId, '画像の保存に失敗しました。しばらくしてから再度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
        return
      }

      // 4c. DB レコード作成（message → attachment → job）
      let attachment: Awaited<ReturnType<typeof createMessageAttachment>>
      try {
        const msg = await createConversationMessage(env.DB, {
          threadId: thread.id,
          senderType: 'user',
          lineMessageId: event.message.id,
          messageType: 'image',
          modeAtSend: thread.current_mode,
          sentAt: new Date(event.timestamp).toISOString().replace('T', ' ').substring(0, 19),
        })

        attachment = await createMessageAttachment(env.DB, {
          messageId: msg.id,
          storageKey: r2Key,
          contentType: content.contentType,
          fileSizeBytes: content.data.byteLength,
        })

        await createImageAnalysisJob(env.DB, {
          messageAttachmentId: attachment.id,
          providerRoute: 'openai_vision',
        })

        console.log(`[LINE] handleImage: DB records created, attachment=${attachment.id}`)
      } catch (e) {
        console.error('[LINE] handleImage DB record creation error:', e)
        await pushText(lineUserId, '⚠️ データ保存に失敗しました。もう一度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
        return
      }

      // 4d. 画像解析を直接実行
      const queuePayload = {
        type: 'image_analysis' as const,
        attachmentId: attachment.id,
        userAccountId: userAccount.id,
        clientAccountId: effectiveAccountId,
        threadId: thread.id,
        r2Key,
        lineUserId,
      }

      console.log(`[LINE] handleImage: starting direct image analysis`)
      try {
        const { processImageDirectly } = await import('../../jobs/image-analysis')
        await processImageDirectly(queuePayload, env)
        console.log(`[LINE] handleImage: direct processing completed`)
      } catch (err) {
        console.error('[LINE] handleImage direct processing failed:', err)
        await pushText(
          lineUserId,
          '画像の解析に失敗しました。お手数ですが、もう一度お試しください。',
          env.LINE_CHANNEL_ACCESS_TOKEN
        ).catch(() => {})
      }
    } catch (outerErr) {
      console.error('[LINE] handleImage background work fatal error:', outerErr)
      await pushText(
        lineUserId,
        '⚠️ 画像処理中にエラーが発生しました。もう一度お試しください。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(() => {})
    }
  })()

  // waitUntil が利用可能ならバックグラウンドで実行、なければ await
  if (ctx.waitUntil) {
    ctx.waitUntil(bgWork)
    console.log('[LINE] handleImage: background work dispatched via waitUntil')
  } else {
    console.log('[LINE] handleImage: waitUntil not available, awaiting directly')
    await bgWork
  }
}

// ===================================================================
// handleInviteCode — 招待コード検出時の紐付け処理
// ===================================================================

async function handleInviteCode(
  replyToken: string,
  code: string,
  lineUserId: string,
  ctx: ProcessContext
): Promise<void> {
  const { env, lineChannelId, clientAccountId } = ctx
  const { useInviteCode, findInviteCodeByCode, findInviteCodeUsageByLineUser } = await import('../../repositories/invite-codes-repo')
  const { findUserAccount, ensureUserAccount: ensureUA } = await import('../../repositories/line-users-repo')

  // ---------------------------------------------------------------
  // 0. LINE ユーザーの line_users レコードを先に作っておく
  // ---------------------------------------------------------------
  let profile: { displayName?: string; pictureUrl?: string; statusMessage?: string } | null = null
  try {
    profile = await getUserProfile(lineUserId, env.LINE_CHANNEL_ACCESS_TOKEN)
  } catch (err) {
    console.warn(`[LINE] handleInviteCode: profile fetch failed for ${lineUserId}:`, err)
  }
  await upsertLineUser(env.DB, {
    lineChannelId,
    lineUserId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
    followStatus: 'following',
  })

  // ---------------------------------------------------------------
  // 1. 既に招待コード使用済みか先にチェック（SSOT Pattern B/C）
  // ---------------------------------------------------------------
  const existingUsage = await findInviteCodeUsageByLineUser(env.DB, lineUserId)
  if (existingUsage) {
    const access = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
    const effectiveAccountId = access?.accountId ?? clientAccountId

    if (access?.intakeCompleted) {
      // Pattern B: 問診完了済み → 通常利用を案内
      await replyText(
        replyToken,
        'ℹ️ 既に登録済みです。\nそのままご利用いただけます！\n\n📷 食事の写真を送ると自動解析\n⚖️ 体重を入力すると記録\n💬「相談モード」と入力でAIに相談',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } else {
      // Pattern C: 問診未完了 → 現在の質問を直接返す（P6: 「続けますか？」不要）
      try {
        await ensureUA(env.DB, lineUserId, effectiveAccountId)
      } catch (err) {
        console.error(`[LINE] handleInviteCode DB setup for intake failed:`, err)
      }
      // startIntakeFlow('invite_code') が途中の質問を直接返す
      await startIntakeFlow(replyToken, lineUserId, effectiveAccountId, env, 'invite_code')
    }
    console.log(`[LINE] invite code skipped (already registered): sent=${code} by ${lineUserId}`)
    return
  }

  // ---------------------------------------------------------------
  // 2. 招待コードを使用（新規ユーザー）
  // ---------------------------------------------------------------
  const result = await useInviteCode(env.DB, code, lineUserId)

  if (!result.success) {
    // ALREADY_USED/ALREADY_BOUND: レースコンディション対応
    if (result.error === 'ALREADY_USED' || result.error === 'ALREADY_BOUND') {
      const access = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
      const effectiveAccountId = access?.accountId ?? clientAccountId
      if (access && !access.intakeCompleted) {
        try {
          await ensureUA(env.DB, lineUserId, effectiveAccountId)
        } catch (err) {
          console.error(`[LINE] handleInviteCode ALREADY_USED intake setup failed:`, err)
        }
        await startIntakeFlow(replyToken, lineUserId, effectiveAccountId, env, 'invite_code')
        return
      }
      await replyText(
        replyToken,
        'ℹ️ 既に登録済みです。\nそのままご利用いただけます！\n\n📷 食事の写真を送ると自動解析\n⚖️ 体重を入力すると記録\n💬「相談モード」と入力でAIに相談',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      return
    }

    const errorMessages: Record<string, string> = {
      INVALID_CODE: '❌ この招待コードは無効です。\nコードをもう一度確認してください。',
      CODE_EXPIRED: '⏰ この招待コードは有効期限切れです。\n担当者にお問い合わせください。',
      CODE_EXHAUSTED: '⚠️ この招待コードは使用上限に達しています。\n担当者にお問い合わせください。',
    }
    await replyText(
      replyToken,
      errorMessages[result.error] ?? '招待コードの処理に失敗しました。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // ---------------------------------------------------------------
  // 3. Pattern A: 新規成功 — アカウント紐付け + 問診開始
  // ---------------------------------------------------------------
  const targetAccountId = result.accountId

  const existingDefault = await findUserAccount(env.DB, lineUserId, clientAccountId)
  if (existingDefault && clientAccountId !== targetAccountId) {
    await env.DB.prepare(`
      UPDATE user_accounts 
      SET client_account_id = ?1, updated_at = ?2
      WHERE line_user_id = ?3 AND client_account_id = ?4
    `).bind(targetAccountId, nowIso(), lineUserId, clientAccountId).run()
  }

  await ensureUA(env.DB, lineUserId, targetAccountId)

  await upsertUserServiceStatus(env.DB, {
    accountId: targetAccountId,
    lineUserId,
    botEnabled: 1,
    recordEnabled: 1,
    consultEnabled: 1,
  })

  // replyで「登録完了」+「問診開始 Q1」を同時送信
  try {
    await upsertModeSession(env.DB, {
      clientAccountId: targetAccountId,
      lineUserId,
      currentMode: 'intake',
      currentStep: 'intake_nickname',
    })
  } catch (err) {
    console.error(`[LINE] handleInviteCode: upsertModeSession failed:`, err)
  }

  await replyMessages(
    replyToken,
    [
      { type: 'text', text: `✅ 招待コード「${code.toUpperCase()}」で登録が完了しました！\n\nこれからダイエットサポートを開始します 😊` },
      { type: 'text', text: '📋 初回ヒアリングを開始します！\n\n━━━━━━━━━━━━━━━\n【質問 1/9】\nお名前（ニックネームでOK）を教えてください！' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )

  console.log(`[LINE] invite code used: ${code} → account ${targetAccountId} by ${lineUserId}`)
}
