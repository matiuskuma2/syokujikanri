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

import { getUserProfile, replyText, replyTextWithQuickReplies, replyWithQuickReplies, replyMessages, getMessageContent, pushText, pushWithQuickReplies } from './reply'
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

// テキスト分類用キーワード（AI判定のフォールバック用に保持）
// AI-first フローでは interpretMessage() が意図を判定するが、
// pending_image_confirm ブロック用にリッチメニューコマンドは残す

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
    console.error(`[LINE] processLineEvent CRITICAL error (type=${event.type}):`, err)
    // ★ 無応答防止: トップレベルエラーでも必ずユーザーに通知
    try {
      const msgEvent = event as LineMessageEvent
      const lineUserId = msgEvent?.source?.userId
      if (lineUserId && ctx.env.LINE_CHANNEL_ACCESS_TOKEN) {
        await pushText(
          lineUserId,
          '⚠️ 処理中にエラーが発生しました。もう一度送り直してください。',
          ctx.env.LINE_CHANNEL_ACCESS_TOKEN
        ).catch(e => console.error('[LINE] processLineEvent emergency push failed:', e))
      }
    } catch { /* 最終手段も失敗 — ログのみ */ }
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

  console.log(`[LINE] handleText START: user=${lineUserId?.substring(0,8)}, text="${textTrim.substring(0,30)}", msgId=${event.message.id}`)

  // ==================================================================
  // SSOT 優先順位 v2.0 — AI-first architecture
  //   ① 画像確認待ち(S3) — 確定/取消/修正/メタデータ更新 以外は全ブロック
  //   ② 招待コード(認証前OK)
  //   ③ サービスアクセス確認
  //   ④ 問診途中(S1)
  //   ⑤ AI意図判定ファースト — 全テキストを interpretMessage() で解釈
  //      → switch_record / switch_consult / trigger_* / record_* / consult / etc.
  //      → pending_clarification の回答 vs 新規意図の自動判別
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
        '相談する', '相談モード', '相談にして', '相談続ける',
        '写真を送る', '体重記録', '体重を記録',
        '問診', 'ヒアリング', '登録', '初期設定', '問診やり直し', '問診リセット', '問診再開',
      ]
      if (PENDING_BLOCK_COMMANDS.includes(textTrim)) {
        // reply + push フォールバック
        try {
          await replyWithQuickReplies(
            event.replyToken,
            '🔄 いま前の食事の確認待ちです。\n先に「✅ 確定」「修正テキスト」「❌ 取消」のいずれかで完了してください。',
            [
              { label: '✅ 確定', text: '確定' },
              { label: '❌ 取消', text: '取消' },
            ],
            env.LINE_CHANNEL_ACCESS_TOKEN
          )
        } catch {
          console.warn('[LINE] pending block reply failed, using push')
          await pushWithQuickReplies(
            lineUserId,
            '🔄 いま前の食事の確認待ちです。\n先に「✅ 確定」「修正テキスト」「❌ 取消」のいずれかで完了してください。',
            [
              { label: '✅ 確定', text: '確定' },
              { label: '❌ 取消', text: '取消' },
            ],
            env.LINE_CHANNEL_ACCESS_TOKEN
          ).catch(e => console.error('[LINE] pending block push fallback failed:', e))
        }
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
        // AI 意図判定: 食品修正 / メタデータ更新（日付・区分） / 両方 / 無関係 を判別
        // ★ 修正テキスト・メタデータ更新は OpenAI を2回呼ぶため replyToken が期限切れになる
        //    → replyToken は最初に「処理中」通知で消費し、以降は pushText を使う
        try {
          const { classifyPendingText } = await import('./image-confirm-handler')
          const pendingIntent = await classifyPendingText(textTrim, env)
          console.log(`[LINE] pending_image_confirm text intent: "${textTrim}" → ${pendingIntent}`)

          switch (pendingIntent) {
            case 'food_correction':
            case 'both':
              // replyToken で即座に中間応答を送る（期限切れ前に消費）
              try {
                await replyText(event.replyToken, '✏️ 修正内容を反映中です…少々お待ちください。', env.LINE_CHANNEL_ACCESS_TOKEN)
              } catch (replyErr) {
                console.warn('[LINE] correction interim reply failed:', replyErr)
                // replyToken失敗でもpush処理は続行
              }
              // 実際の修正処理は pushText ベースで実行
              await handleImageCorrectionWithPush(textTrim, intakeResultId, lineUserId, preEffectiveAccountId, env)
              return

            case 'metadata_update':
              try {
                await replyText(event.replyToken, '📅 日付・区分を変更中です…少々お待ちください。', env.LINE_CHANNEL_ACCESS_TOKEN)
              } catch (replyErr) {
                console.warn('[LINE] metadata interim reply failed:', replyErr)
              }
              await handleImageMetadataUpdateWithPush(textTrim, intakeResultId, lineUserId, preEffectiveAccountId, env)
              return

            case 'unrelated':
            default:
              // 無関係テキスト → 確認待ちを案内
              try {
                await replyWithQuickReplies(
                  event.replyToken,
                  '🔄 いま前の食事の確認待ちです。\n\n内容を修正する場合は修正内容をテキストで送ってください。\n例: 「鮭ではなくスクランブルエッグ」\n例: 「昨日の夕食」\n\nまたは「✅ 確定」「❌ 取消」で完了してください。',
                  [
                    { label: '✅ 確定', text: '確定' },
                    { label: '❌ 取消', text: '取消' },
                  ],
                  env.LINE_CHANNEL_ACCESS_TOKEN
                )
              } catch {
                await pushWithQuickReplies(
                  lineUserId,
                  '🔄 いま前の食事の確認待ちです。\n\n内容を修正する場合は修正内容をテキストで送ってください。\n例: 「鮭ではなくスクランブルエッグ」\n例: 「昨日の夕食」\n\nまたは「✅ 確定」「❌ 取消」で完了してください。',
                  [
                    { label: '✅ 確定', text: '確定' },
                    { label: '❌ 取消', text: '取消' },
                  ],
                  env.LINE_CHANNEL_ACCESS_TOKEN
                ).catch(e => console.error('[LINE] pending unrelated push fallback failed:', e))
              }
              return
          }
        } catch (pendingErr) {
          console.error('[LINE] pending_image_confirm handler error:', pendingErr)
          // エラー時は push で応答（replyToken は既に消費されている可能性がある）
          await pushWithQuickReplies(
            lineUserId,
            '⚠️ 処理中にエラーが発生しました。\n「✅ 確定」か「❌ 取消」で操作を完了してください。',
            [
              { label: '✅ 確定', text: '確定' },
              { label: '❌ 取消', text: '取消' },
            ],
            env.LINE_CHANNEL_ACCESS_TOKEN
          ).catch(e => console.error('[LINE] pending error push fallback failed:', e))
          return
        }
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
  // ④ 問診途中（S1: mode=intake）— AI判定より前に評価
  //    問診中は AI 解析不要（問診ステップ処理のみ）
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
    // handleIntakeStep が false を返した場合（セッション不整合）→ AI判定フローへ
  }

  // ==================================================================
  // ⑤ AI意図判定ファースト — 全テキストをまず interpretMessage() に通す
  //    キーワードマッチは AI 判定結果に基づいてルーティングする
  // ==================================================================
  await handleTextWithAIFirst(
    event.replyToken,
    textTrim,
    userAccount.id,
    effectiveAccountId,
    lineUserId,
    thread.id,
    currentMode,
    ctx,
    event.message.id,
    event.timestamp
  )
}

// ===================================================================
// handleTextWithAIFirst — AI意図判定ファーストのテキスト処理
// 全テキストを最初にAI解析し、結果に基づいてルーティングする
// ===================================================================

async function handleTextWithAIFirst(
  replyToken: string,
  text: string,
  userAccountId: string,
  clientAccountId: string,
  lineUserId: string,
  threadId: string,
  currentMode: string,
  ctx: ProcessContext,
  lineMessageId: string,
  eventTimestamp: number
): Promise<void> {
  const { env } = ctx

  try {
  // ★ handleTextWithAIFirst 全体を try-catch で囲む（無応答防止）
  console.log(`[AIFirst] START: text="${text.substring(0,30)}", mode=${currentMode}, user=${lineUserId?.substring(0,8)}`)

  // ------------------------------------------------------------------
  // Phase B 復帰: pending_clarification 中の場合
  // ------------------------------------------------------------------
  const { findActiveClarification, cancelActiveClarifications } =
    await import('../../repositories/pending-clarifications-repo')
  const pendingClar = await findActiveClarification(env.DB, userAccountId)

  // ------------------------------------------------------------------
  // Phase A: AI 解釈 → Unified Intent JSON（全テキスト共通）
  // ------------------------------------------------------------------
  const { interpretMessage, buildUserContextForInterpretation, createFallbackIntent } =
    await import('../ai/interpretation')
  const { canSaveImmediately, canSaveWithConfirmation } =
    await import('../../types/intent')

  const resolvedMode = (currentMode === 'record' || currentMode === 'consult')
    ? currentMode as 'record' | 'consult'
    : 'record'
  const userCtx = await buildUserContextForInterpretation(
    env.DB, threadId, userAccountId, resolvedMode, eventTimestamp
  )

  let intent: Awaited<ReturnType<typeof interpretMessage>>
  let fallbackUsed: 'gpt' | 'regex' | 'unclear' = 'gpt'
  try {
    intent = await interpretMessage(text, userCtx, env)
    if (intent.reasoning?.includes('フォールバック')) {
      fallbackUsed = intent.intent_primary === 'unclear' ? 'unclear' : 'regex'
    }
  } catch (interpretErr) {
    console.error('[AIFirst] Phase A interpret error:', interpretErr)
    fallbackUsed = 'regex'
    intent = createFallbackIntent(text, userCtx)
    if (intent.intent_primary === 'unclear') fallbackUsed = 'unclear'
  }

  // R13: Phase A 監査ログ
  console.log(JSON.stringify({
    event: 'phase_a_result',
    line_message_id: lineMessageId,
    user_account_id: userAccountId,
    intent_primary: intent.intent_primary,
    intent_secondary: intent.intent_secondary,
    confidence: intent.confidence,
    needs_clarification: intent.needs_clarification,
    target_date_source: intent.target_date.source,
    meal_type_source: intent.meal_type?.source ?? null,
    fallback_used: fallbackUsed,
    current_mode: currentMode,
    has_pending_clarification: !!pendingClar,
  }))

  console.log(`[AIFirst] primary=${intent.intent_primary}, conf=${intent.confidence}, clarify=[${intent.needs_clarification.join(',')}], mode=${currentMode}, pendingClar=${!!pendingClar}`)

  // ------------------------------------------------------------------
  // pending_clarification が存在する場合の処理
  // 新しい明確な意図 → pending キャンセル + 新規処理
  // 回答っぽい → 既存の clarification を継続
  // ------------------------------------------------------------------
  if (pendingClar) {
    const isNewActionIntent = [
      'record_meal', 'record_weight', 'correct_record', 'delete_record',
      'consult', 'switch_record', 'switch_consult',
      'trigger_intake', 'trigger_photo', 'trigger_weight_input',
    ].includes(intent.intent_primary)

    const isHighConfidenceNewIntent = isNewActionIntent && intent.confidence >= 0.7

    if (isHighConfidenceNewIntent) {
      // 新しい明確な意図 → pending をキャンセルして新規処理へ
      console.log(`[AIFirst] cancelling pending clarification for new intent: ${intent.intent_primary}`)
      try { await cancelActiveClarifications(env.DB, userAccountId) } catch { /* ignore */ }
      // フォールスルー: 新しい intent で処理
    } else {
      // 既存の clarification の回答として処理
      try {
        const { handleClarificationAnswer, sendNextClarificationQuestion } =
          await import('./clarification-handler')

        const clarResult = await handleClarificationAnswer(
          text, userAccountId, clientAccountId, lineUserId, env
        )

        if (clarResult.complete && clarResult.updatedIntent) {
          const { persistRecord } = await import('./record-persister')
          const result = await persistRecord(clarResult.updatedIntent, userAccountId, clientAccountId, env)

          if (clarResult.pendingId) {
            const { deleteClarification } = await import('../../repositories/pending-clarifications-repo')
            await deleteClarification(env.DB, clarResult.pendingId)
          }

          await saveBotMessage(env.DB, threadId, result.replyMessage)
          await safeReplyWithQuickReplies(
            replyToken, lineUserId, result.replyMessage,
            [{ label: '📝 続けて記録', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
            env.LINE_CHANNEL_ACCESS_TOKEN
          )
          fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)
          return
        } else if (clarResult.pendingId && clarResult.updatedIntent) {
          await sendNextClarificationQuestion(replyToken, clarResult.updatedIntent, clarResult.pendingId, env)
          return
        } else if (clarResult.pendingId && !clarResult.updatedIntent) {
          const rePending = await findActiveClarification(env.DB, userAccountId)
          if (rePending) {
            const currentField = rePending.current_field
            let reText = '🤔 もう少し教えてください。'
            if (currentField === 'target_date') reText = '🤔 日付がわかりませんでした。「今日」「昨日」「3/10」のように教えてください。'
            if (currentField === 'meal_type') reText = '🤔 食事区分がわかりませんでした。「朝食」「昼食」「夕食」「間食」のどれですか？'
            if (currentField === 'weight_value') reText = '🤔 体重がわかりませんでした。「58.5」のように数字で教えてください。'
            await safeReplyText(replyToken, lineUserId, reText, env.LINE_CHANNEL_ACCESS_TOKEN)
            return
          }
        }
      } catch (err) {
        console.error('[AIFirst] clarification handling error:', err)
        // エラー → キャンセルして新規処理へ
        try { await cancelActiveClarifications(env.DB, userAccountId) } catch { /* ignore */ }
      }
    }
  }

  // ==================================================================
  // Intent-based routing
  // ==================================================================

  // --- モード切替系 ---
  if (intent.intent_primary === 'switch_record') {
    try { await cancelActiveClarifications(env.DB, userAccountId) } catch { /* ignore */ }
    try { await updateThreadMode(env.DB, threadId, 'record') } catch { /* ignore */ }
    try { await deleteModeSession(env.DB, clientAccountId, lineUserId) } catch { /* ignore */ }
    await safeReplyText(replyToken, lineUserId, '📝 記録モードです。\n記録したい内容を送ってください。食事写真・食事テキスト・体重の数字・体重計の写真、どれでもOKです。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  if (intent.intent_primary === 'switch_consult') {
    try { await cancelActiveClarifications(env.DB, userAccountId) } catch { /* ignore */ }
    try { await updateThreadMode(env.DB, threadId, 'consult') } catch { /* ignore */ }
    try {
      await upsertModeSession(env.DB, {
        clientAccountId,
        lineUserId,
        currentMode: 'consult',
        currentStep: 'idle',
      })
    } catch { /* ignore */ }
    // ★ switch_consult は即座に reply（OpenAI呼び出し前なのでreplyToken有効）
    await safeReplyText(replyToken, lineUserId, '💬 相談モードです。食事・体重・外食・間食・続け方など、何でも送ってください 😊', env.LINE_CHANNEL_ACCESS_TOKEN)
    console.log(`[AIFirst] switch_consult: reply sent for ${lineUserId}`)
    return
  }

  if (intent.intent_primary === 'trigger_intake') {
    // 問診開始/やり直し/再開 を判別
    const isReset = /やり直し|リセット/.test(text)
    const isResume = /再開/.test(text)
    if (isReset) {
      await upsertUserServiceStatus(env.DB, { accountId: clientAccountId, lineUserId, intakeCompleted: 0 })
      await beginIntakeFromStart(replyToken, lineUserId, clientAccountId, env)
    } else if (isResume) {
      await resumeIntakeFlow(replyToken, lineUserId, clientAccountId, env)
    } else {
      await startIntakeFlow(replyToken, lineUserId, clientAccountId, env, 'command')
    }
    return
  }

  if (intent.intent_primary === 'trigger_photo') {
    try { await updateThreadMode(env.DB, threadId, 'record') } catch { /* ignore */ }
    try { await deleteModeSession(env.DB, clientAccountId, lineUserId) } catch { /* ignore */ }
    await safeReplyText(
      replyToken,
      lineUserId,
      '📝 記録したい内容を送ってください。食事写真・食事テキスト・体重の数字・体重計の写真、どれでもOKです。\n\n💡 写真のヒント:\n・真上から撮ると認識精度UP\n・お皿全体が入るように\n・1品ずつでも、まとめてでもOK',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  if (intent.intent_primary === 'trigger_weight_input') {
    try { await updateThreadMode(env.DB, threadId, 'record') } catch { /* ignore */ }
    try { await deleteModeSession(env.DB, clientAccountId, lineUserId) } catch { /* ignore */ }
    await safeReplyWithQuickReplies(
      replyToken,
      lineUserId,
      '⚖️ 体重を入力してください！\n\n例: 65.5kg\n例: 58キロ\n\n※ 数字＋kg（またはキロ）で記録されます',
      [{ label: '📝 記録する', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // --- 相談意図 ---
  if (intent.intent_primary === 'consult') {
    if (currentMode !== 'consult') {
      try { await updateThreadMode(env.DB, threadId, 'consult') } catch { /* ignore */ }
      try {
        await upsertModeSession(env.DB, {
          clientAccountId, lineUserId, currentMode: 'consult', currentStep: 'idle',
        })
      } catch { /* ignore */ }
    }
    await handleConsultText(replyToken, text, threadId, userAccountId, ctx, lineUserId, intent)
    return
  }

  // --- 挨拶 ---
  if (intent.intent_primary === 'greeting') {
    await safeReplyWithQuickReplies(
      replyToken,
      lineUserId,
      '👋 こんにちは！\n\n食事の内容や体重を送ってくださいね 😊\n\n例: 「朝食 トースト・コーヒー」\n例: 「58.5kg」',
      [{ label: '📝 記録する', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // --- 記録系 intent (record_meal / record_weight / correct_record / delete_record) ---
  // record モードに自動切替（consult 中に記録意図が検出された場合）
  if (currentMode === 'consult' &&
      (intent.intent_primary === 'record_meal' || intent.intent_primary === 'record_weight' ||
       intent.intent_primary === 'correct_record' || intent.intent_primary === 'delete_record')) {
    try { await updateThreadMode(env.DB, threadId, 'record') } catch { /* ignore */ }
  }

  // 即時保存チェック
  if (canSaveImmediately(intent)) {
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)

    console.log(JSON.stringify({
      event: 'phase_c_result',
      line_message_id: lineMessageId,
      user_account_id: userAccountId,
      persist_action: result.persist_action ?? (result.success ? 'created' : 'rejected'),
      target_table: intent.intent_primary === 'record_weight' ? 'body_metrics' : 'meal_entries',
      error: result.error ?? null,
    }))

    await saveBotMessage(env.DB, threadId, result.replyMessage)
    await safeReplyWithQuickReplies(
      replyToken, lineUserId, result.replyMessage,
      [{ label: '📝 続けて記録', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)
    return
  }

  if (canSaveWithConfirmation(intent)) {
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)

    const confirmNote = intent.target_date.source === 'timestamp' && intent.meal_type?.source === 'timestamp'
      ? '\n\n⏰ 日付と食事区分は送信時刻から推定しました。違う場合はお知らせください。'
      : intent.target_date.source === 'timestamp'
        ? '\n\n⏰ 日付は送信時刻から推定しました。違う場合は「昨日」などと教えてください。'
        : intent.meal_type?.source === 'timestamp'
          ? '\n\n⏰ 食事区分は送信時刻から推定しました。違う場合は「朝食」などと教えてください。'
          : ''

    await saveBotMessage(env.DB, threadId, result.replyMessage + confirmNote)
    await safeReplyWithQuickReplies(
      replyToken, lineUserId, result.replyMessage + confirmNote,
      [{ label: '📝 続けて記録', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)
    return
  }

  // 修正・削除
  if (intent.intent_primary === 'correct_record' || intent.intent_primary === 'delete_record') {
    const { persistRecord } = await import('./record-persister')
    const result = await persistRecord(intent, userAccountId, clientAccountId, env)
    await saveBotMessage(env.DB, threadId, result.replyMessage)
    await safeReplyWithQuickReplies(
      replyToken, lineUserId, result.replyMessage,
      [{ label: '📝 続けて記録', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // Phase B: 明確化フロー
  if (intent.needs_clarification.length > 0) {
    const { startClarificationFlow } = await import('./clarification-handler')
    await startClarificationFlow(replyToken, intent, text, userAccountId, clientAccountId, null, lineUserId, env)
    return
  }

  // unclear → ガイド
  if (intent.intent_primary === 'unclear') {
    await safeReplyWithQuickReplies(
      replyToken,
      lineUserId,
      '🤔 記録内容が判定できませんでした。\n\n体重・食事・運動などを入力してください。\n例: 「体重58.5kg」\n例: 「朝食 トースト・コーヒー」',
      [{ label: '📝 記録する', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // フォールバック
  await safeReplyWithQuickReplies(
    replyToken,
    lineUserId,
    '🤔 記録内容が判定できませんでした。\n\n体重・食事・運動などを入力してください。\n例: 「体重58.5kg」\n例: 「朝食 トースト・コーヒー」',
    [{ label: '📝 記録する', text: '記録モード' }, { label: '💬 相談する', text: '相談モード' }],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )

  } catch (topLevelErr) {
    // ★ handleTextWithAIFirst トップレベルのエラーキャッチ
    // ここに到達 = 内部のどこかで未キャッチの例外が発生
    // 絶対に無応答にしない
    console.error(`[AIFirst] CRITICAL top-level error for "${text}":`, topLevelErr)
    try {
      await pushText(
        lineUserId,
        '⚠️ 一時的な処理エラーが発生しました。もう一度送り直してください。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
    } catch (pushErr) {
      console.error('[AIFirst] even push fallback failed:', pushErr)
      // 最後の手段: replyToken を試す
      await replyText(replyToken, '⚠️ 一時的なエラーです。もう一度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
    }
  }
}

// ===================================================================
// ヘルパー: reply + push フォールバック付き安全な応答
// ===================================================================

/**
 * replyToken で応答を試み、失敗した場合は pushText にフォールバックする。
 * OpenAI 呼び出し後で replyToken が期限切れの場合に対応。
 */
async function safeReplyWithQuickReplies(
  replyToken: string,
  lineUserId: string,
  text: string,
  items: Array<{ label: string; text: string }>,
  accessToken: string
): Promise<void> {
  try {
    await replyTextWithQuickReplies(replyToken, text, items, accessToken)
    console.log(`[safeReply] QR reply success to ${lineUserId?.substring(0,8)}`)
  } catch (replyErr) {
    // replyToken 失敗 → push フォールバック
    console.warn(`[safeReply] QR reply failed to ${lineUserId?.substring(0,8)}, falling back to push:`, replyErr)
    try {
      await pushWithQuickReplies(lineUserId, text, items, accessToken)
      console.log(`[safeReply] QR push fallback success to ${lineUserId?.substring(0,8)}`)
    } catch (pushErr) {
      console.error(`[safeReply] QR push fallback ALSO failed to ${lineUserId?.substring(0,8)}:`, pushErr)
    }
  }
}

/**
 * replyToken でテキスト応答を試み、失敗した場合は pushText にフォールバック。
 */
async function safeReplyText(
  replyToken: string,
  lineUserId: string,
  text: string,
  accessToken: string
): Promise<void> {
  try {
    await replyText(replyToken, text, accessToken)
    console.log(`[safeReply] text reply success to ${lineUserId?.substring(0,8)}`)
  } catch (replyErr) {
    console.warn(`[safeReply] text reply failed to ${lineUserId?.substring(0,8)}, falling back to push:`, replyErr)
    try {
      await pushText(lineUserId, text, accessToken)
      console.log(`[safeReply] text push fallback success to ${lineUserId?.substring(0,8)}`)
    } catch (pushErr) {
      console.error(`[safeReply] text push fallback ALSO failed to ${lineUserId?.substring(0,8)}:`, pushErr)
    }
  }
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
  ctx: ProcessContext,
  lineUserId?: string,
  precomputedIntent?: import('../../types/intent').UnifiedIntent
): Promise<void> {
  const { env } = ctx

  try {
    const ai = createOpenAIClient(env)

    // ------------------------------------------------------------------
    // Phase A: 副次意図チェック（相談中に記録情報が含まれていないか）
    // AI判定は handleTextWithAIFirst で既に実施済みの場合は再利用
    // ------------------------------------------------------------------
    let secondaryRecordSaved = false
    try {
      const { canSaveImmediately, CONSULT_SECONDARY_SAVE_THRESHOLD } =
        await import('../../types/intent')

      // precomputedIntent がある場合は再利用、なければ新規解釈
      let intent = precomputedIntent
      if (!intent) {
        const { interpretMessage, buildUserContextForInterpretation } =
          await import('../ai/interpretation')
        const userCtx = await buildUserContextForInterpretation(
          env.DB, threadId, userAccountId, 'consult', Date.now()
        )
        intent = await interpretMessage(text, userCtx, env)
      }

      // pending_clarification が存在しないことを確認
      let hasPending = false
      try {
        const { findActiveClarification } = await import('../../repositories/pending-clarifications-repo')
        hasPending = !!(await findActiveClarification(env.DB, userAccountId))
      } catch { /* ignore */ }

      // R1-3~R1-6: 副次意図の記録検出（confidence ≥ 0.80 + canSaveImmediately + no pending）
      const secondaryEligible = !secondaryRecordSaved && !hasPending &&
          intent.intent_secondary &&
          (intent.intent_secondary === 'record_meal' || intent.intent_secondary === 'record_weight') &&
          intent.confidence >= CONSULT_SECONDARY_SAVE_THRESHOLD

      if (secondaryEligible) {
        const recordIntent = { ...intent, intent_primary: intent.intent_secondary! }
        if (canSaveImmediately(recordIntent)) {
          const { persistRecord } = await import('./record-persister')
          const result = await persistRecord(recordIntent, userAccountId, ctx.clientAccountId, env)
          if (result.success) secondaryRecordSaved = true

          console.log(JSON.stringify({
            event: 'consult_secondary_record',
            user_account_id: userAccountId,
            intent_secondary: intent.intent_secondary,
            confidence: intent.confidence,
            saved: result.success,
            reason: result.success ? 'threshold_met_no_pending' : 'error',
          }))
        } else {
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
        console.log(JSON.stringify({
          event: 'consult_secondary_record',
          user_account_id: userAccountId,
          intent_secondary: intent.intent_secondary,
          confidence: intent.confidence,
          saved: false,
          reason: hasPending ? 'has_pending' : 'below_threshold',
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

    // ★ OpenAI 呼び出し後は replyToken が期限切れの可能性が高い
    //    → push を先に試み、失敗時のみ reply を試す
    if (lineUserId) {
      try {
        await pushWithQuickReplies(
          lineUserId,
          replyMsg,
          [
            { label: '📝 記録に戻る', text: '記録モード' },
            { label: '💬 続けて相談', text: '相談続ける' },
          ],
          env.LINE_CHANNEL_ACCESS_TOKEN
        )
      } catch (pushErr) {
        console.warn('[Consult] push failed, trying reply:', pushErr)
        try {
          await replyTextWithQuickReplies(
            replyToken,
            replyMsg,
            [
              { label: '📝 記録に戻る', text: '記録モード' },
              { label: '💬 続けて相談', text: '相談続ける' },
            ],
            env.LINE_CHANNEL_ACCESS_TOKEN
          )
        } catch (replyErr) {
          console.error('[Consult] both push and reply failed:', replyErr)
        }
      }
    } else {
      // lineUserId なし（通常は起きないが念のため）
      try {
        await replyTextWithQuickReplies(
          replyToken,
          replyMsg,
          [
            { label: '📝 記録に戻る', text: '記録モード' },
            { label: '💬 続けて相談', text: '相談続ける' },
          ],
          env.LINE_CHANNEL_ACCESS_TOKEN
        )
      } catch { /* ignore */ }
    }

    // バックグラウンド: メモリ抽出
    fireMemoryExtraction(text, userAccountId, null, env, ctx.waitUntil)

  } catch (err) {
    console.error('[LINE] consult AI error:', err)
    const errorMsg = '⚠️ AIの応答に失敗しました。しばらくしてから再度お試しください。'
    // ★ push を先に試す（replyToken は既に期限切れの可能性が高い）
    if (lineUserId) {
      try {
        await pushText(lineUserId, errorMsg, env.LINE_CHANNEL_ACCESS_TOKEN)
      } catch {
        // push も失敗した場合のみ reply を試す
        await replyText(replyToken, errorMsg, env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
      }
    } else {
      await replyText(replyToken, errorMsg, env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
    }
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

// ===================================================================
// Push-based 画像修正/メタデータ更新ハンドラー
// ===================================================================
// replyToken は classifyPendingText の OpenAI 呼び出し後に期限切れになるため、
// 修正・メタデータ更新は pushText ベースで応答する。

/**
 * handleImageCorrectionWithPush
 * replyToken を使わず pushText で応答するバージョン
 */
async function handleImageCorrectionWithPush(
  correctionText: string,
  intakeResultId: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const {
    findIntakeResultById,
    updateIntakeResultProposedAction,
  } = await import('../../repositories/image-intake-repo')
  const { deleteModeSession } = await import('../../repositories/mode-sessions-repo')
  const { matchFoodItems, calculateTotalNutrition } = await import('../../repositories/food-master-repo')

  const result = await findIntakeResultById(env.DB, intakeResultId)

  if (!result || result.applied_flag !== 0) {
    await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  try {
    // 1. 元の解析結果を復元
    let originalExtracted: Record<string, unknown> = {}
    try {
      originalExtracted = result.extracted_json
        ? (typeof result.extracted_json === 'string'
          ? JSON.parse(result.extracted_json)
          : result.extracted_json)
        : {}
    } catch { /* ignore */ }

    let originalAction: Record<string, unknown> = {}
    try {
      originalAction = result.proposed_action_json
        ? (typeof result.proposed_action_json === 'string'
          ? JSON.parse(result.proposed_action_json)
          : result.proposed_action_json)
        : {}
    } catch { /* ignore */ }

    // 2. AI に修正を反映させる
    const ai = createOpenAIClient(env)
    const originalSummary = [
      originalExtracted.meal_description || originalAction.meal_text || '不明',
      originalExtracted.food_items ? `食品: ${(originalExtracted.food_items as string[]).join(', ')}` : '',
      originalAction.calories_kcal ? `推定カロリー: ${originalAction.calories_kcal}kcal` : '',
    ].filter(Boolean).join('\n')

    const correctionPrompt = `あなたは栄養士AIです。
ユーザーが食事写真のAI解析結果を修正しました。

【元のAI解析結果】
${originalSummary}

【ユーザーの修正内容】
${correctionText}

ユーザーの修正を反映した正しい食事情報を出力してください。
ユーザーが言及していない項目は元の解析結果を維持してください。

必ず以下のJSON形式のみで返答してください:
{
  "meal_description": "修正後の料理名・食材の説明（日本語、100文字以内）",
  "food_items": ["個別食品名1", "個別食品名2"],
  "estimated_calories_kcal": <整数またはnull>,
  "estimated_protein_g": <数値またはnull>,
  "estimated_fat_g": <数値またはnull>,
  "estimated_carbs_g": <数値またはnull>,
  "meal_type_guess": "breakfast|lunch|dinner|snack|other",
  "correction_note": "修正した点の要約"
}`

    const raw = await ai.createResponse(
      [
        { role: 'system', content: correctionPrompt },
        { role: 'user', content: correctionText },
      ],
      { temperature: 0.3, maxTokens: 512 }
    )

    let parsed: Record<string, unknown> = {}
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      parsed = {}
    }

    // 3. 修正後の値を決定
    const desc = (parsed.meal_description as string) || (originalAction.meal_text as string) || '食事'
    const foodItems = (parsed.food_items as string[]) || (originalExtracted.food_items as string[]) || []
    let finalCalories = (parsed.estimated_calories_kcal as number) ?? (originalAction.calories_kcal as number) ?? null
    let finalProtein = (parsed.estimated_protein_g as number) ?? (originalAction.protein_g as number) ?? null
    let finalFat = (parsed.estimated_fat_g as number) ?? (originalAction.fat_g as number) ?? null
    let finalCarbs = (parsed.estimated_carbs_g as number) ?? (originalAction.carbs_g as number) ?? null
    const mealType = (parsed.meal_type_guess as string) || (originalAction.meal_type as string) || 'other'

    // 4. food_master マッチング
    let foodMatchData: Record<string, unknown> | null = null
    let matchSummaryText = ''

    if (foodItems.length > 0) {
      try {
        const matches = await matchFoodItems(env.DB, foodItems)
        const nutrition = calculateTotalNutrition(matches)

        const matchDetails: Array<Record<string, unknown>> = []
        for (const [name, matchResult] of matches) {
          if (matchResult) {
            matchDetails.push({
              ai_name: name,
              master_name: matchResult.food.name,
              master_id: matchResult.food.id,
              match_score: matchResult.matchScore,
              calories_kcal: matchResult.food.calories_kcal,
              serving_label: matchResult.food.serving_label,
            })
          } else {
            matchDetails.push({ ai_name: name, master_name: null, match_score: 0 })
          }
        }

        foodMatchData = {
          matched_count: nutrition.matchedCount,
          total_count: foodItems.length,
          unmatched_names: nutrition.unmatchedNames,
          items: matchDetails,
        }

        if (nutrition.matchedCount > 0) {
          const matchRate = nutrition.matchedCount / foodItems.length
          if (matchRate >= 0.5) {
            const unmatchedRatio = nutrition.unmatchedNames.length / foodItems.length
            const aiCal = finalCalories ?? 0
            finalCalories = nutrition.totalCalories + Math.round(aiCal * unmatchedRatio)
            finalProtein = Math.round((nutrition.totalProtein + (finalProtein ?? 0) * unmatchedRatio) * 10) / 10
            finalFat = Math.round((nutrition.totalFat + (finalFat ?? 0) * unmatchedRatio) * 10) / 10
            finalCarbs = Math.round((nutrition.totalCarbs + (finalCarbs ?? 0) * unmatchedRatio) * 10) / 10
          }

          const matchedNames = matchDetails
            .filter(d => d.master_name)
            .map(d => `${d.ai_name}→${d.master_name}`)
            .slice(0, 3)
          matchSummaryText = `\n📊 食品DB照合: ${nutrition.matchedCount}/${foodItems.length}品マッチ`
          if (matchedNames.length > 0) {
            matchSummaryText += `\n   ${matchedNames.join(', ')}`
          }
        }
      } catch (err) {
        console.warn('[ImageCorrectionPush] food_master matching failed:', err)
      }
    }

    // 5. proposed_action_json を更新
    const newProposedAction = {
      ...originalAction,
      action: 'create_or_update_meal_entry',
      meal_type: mealType,
      meal_text: desc,
      calories_kcal: finalCalories,
      protein_g: finalProtein,
      fat_g: finalFat,
      carbs_g: finalCarbs,
      food_match_data: foodMatchData,
    }

    const newExtracted = {
      ...originalExtracted,
      ...parsed,
      food_match_data: foodMatchData,
      correction_applied: true,
      correction_text: correctionText,
    }

    await updateIntakeResultProposedAction(env.DB, result.id, newProposedAction, newExtracted)

    // 6. push で修正結果を送信
    const mealTypeJa =
      mealType === 'breakfast' ? '朝食' :
      mealType === 'lunch' ? '昼食' :
      mealType === 'dinner' ? '夕食' :
      mealType === 'snack' ? '間食' : '食事'

    const correctionNote = (parsed.correction_note as string) || ''

    const replyMessage =
      `✏️ 修正を反映しました！\n\n` +
      `🍽 ${mealTypeJa}\n` +
      `📝 ${desc}\n` +
      (finalCalories ? `🔥 推定カロリー: ${finalCalories} kcal\n` : '') +
      (finalProtein ? `💪 P: ${finalProtein}g` : '') +
      (finalFat ? ` / F: ${finalFat}g` : '') +
      (finalCarbs ? ` / C: ${finalCarbs}g` : '') +
      matchSummaryText +
      (correctionNote ? `\n\n📌 ${correctionNote}` : '') +
      '\n\n↓ この内容で記録しますか？'

    await pushWithQuickReplies(
      lineUserId,
      replyMessage,
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[ImageCorrectionPush] push failed:', e))

    console.log(`[ImageCorrectionPush] correction applied for ${intakeResultId}: "${correctionText}"`)
  } catch (err) {
    console.error('[ImageCorrectionPush] error:', err)
    await pushWithQuickReplies(
      lineUserId,
      '修正の処理中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[ImageCorrectionPush] error push also failed:', e))
  }
}

/**
 * handleImageMetadataUpdateWithPush
 * replyToken を使わず pushText で応答するバージョン
 */
async function handleImageMetadataUpdateWithPush(
  metadataText: string,
  intakeResultId: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const {
    findIntakeResultById,
    updateIntakeResultProposedAction,
  } = await import('../../repositories/image-intake-repo')
  const { deleteModeSession } = await import('../../repositories/mode-sessions-repo')

  const result = await findIntakeResultById(env.DB, intakeResultId)

  if (!result || result.applied_flag !== 0) {
    await pushText(lineUserId, '確認対象のデータが見つかりませんでした。', env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {})
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    return
  }

  try {
    let originalAction: Record<string, unknown> = {}
    try {
      originalAction = result.proposed_action_json
        ? (typeof result.proposed_action_json === 'string'
          ? JSON.parse(result.proposed_action_json)
          : result.proposed_action_json)
        : {}
    } catch { /* ignore */ }

    let originalExtracted: Record<string, unknown> = {}
    try {
      originalExtracted = result.extracted_json
        ? (typeof result.extracted_json === 'string'
          ? JSON.parse(result.extracted_json)
          : result.extracted_json)
        : {}
    } catch { /* ignore */ }

    // AI でテキストから日付・食事区分を抽出
    const ai = createOpenAIClient(env)
    const today = todayJst()

    /** 今日から offset 日分ずらした日付を YYYY-MM-DD で返す */
    const getDateOffset = (offset: number): string => {
      const d = new Date()
      d.setHours(d.getHours() + 9) // JST
      d.setDate(d.getDate() + offset)
      return d.toISOString().slice(0, 10)
    }

    const raw = await ai.createResponse(
      [
        {
          role: 'system',
          content: `今日は${today}です。ユーザーの発言から日付と食事区分を抽出してください。

必ず以下のJSON形式のみで返答してください:
{
  "target_date": "YYYY-MM-DD形式の日付。不明なら null",
  "meal_type": "breakfast|lunch|dinner|snack|other のいずれか。不明なら null",
  "reasoning": "判定理由"
}

例:
- "昨日の晩御飯" → {"target_date": "${getDateOffset(-1)}", "meal_type": "dinner", "reasoning": "昨日=前日、晩御飯=dinner"}
- "これは朝食です" → {"target_date": null, "meal_type": "breakfast", "reasoning": "朝食=breakfast"}
- "3月10日の夕食" → {"target_date": "2026-03-10", "meal_type": "dinner", "reasoning": "3月10日, 夕食=dinner"}`
        },
        { role: 'user', content: metadataText }
      ],
      { temperature: 0, maxTokens: 200 }
    )

    let parsed: { target_date?: string | null; meal_type?: string | null; reasoning?: string } = {}
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      parsed = {}
    }

    // 変更があった項目だけ更新
    let changed = false
    const newAction = { ...originalAction }
    const newExtracted = { ...originalExtracted }

    if (parsed.target_date) {
      newAction.target_date = parsed.target_date
      newExtracted.target_date = parsed.target_date
      changed = true
    }

    if (parsed.meal_type && ['breakfast', 'lunch', 'dinner', 'snack', 'other'].includes(parsed.meal_type)) {
      newAction.meal_type = parsed.meal_type
      newExtracted.meal_type_guess = parsed.meal_type
      changed = true
    }

    if (changed) {
      newExtracted.metadata_update_applied = true
      newExtracted.metadata_update_text = metadataText
      await updateIntakeResultProposedAction(env.DB, result.id, newAction, newExtracted)
    }

    // push で更新結果を送信
    const mealType = (newAction.meal_type as string) ?? 'other'
    const mealTypeJa =
      mealType === 'breakfast' ? '朝食' :
      mealType === 'lunch' ? '昼食' :
      mealType === 'dinner' ? '夕食' :
      mealType === 'snack' ? '間食' : '食事'

    const targetDate = (newAction.target_date as string) ?? today
    const dateDisplay = targetDate === today
      ? '今日'
      : targetDate === getDateOffset(-1) ? '昨日' : targetDate

    const desc = (newAction.meal_text as string) ?? '食事'
    const cal = newAction.calories_kcal as number | null

    const replyMessage =
      `📅 ${dateDisplay}の${mealTypeJa}に変更しました！\n\n` +
      `📝 ${desc}\n` +
      (cal ? `🔥 推定カロリー: ${cal} kcal\n` : '') +
      (newAction.protein_g ? `💪 P: ${newAction.protein_g}g` : '') +
      (newAction.fat_g ? ` / F: ${newAction.fat_g}g` : '') +
      (newAction.carbs_g ? ` / C: ${newAction.carbs_g}g` : '') +
      '\n\n↓ この内容で記録しますか？'

    await pushWithQuickReplies(
      lineUserId,
      replyMessage,
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[ImageMetadataUpdatePush] push failed:', e))

    console.log(`[ImageMetadataUpdatePush] metadata updated for ${intakeResultId}: date=${parsed.target_date}, type=${parsed.meal_type}`)
  } catch (err) {
    console.error('[ImageMetadataUpdatePush] error:', err)
    await pushWithQuickReplies(
      lineUserId,
      '情報の更新中にエラーが発生しました。\n「確定」でそのまま記録、「取消」でやり直しできます。',
      [
        { label: '✅ 確定', text: '確定' },
        { label: '❌ 取消', text: '取消' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    ).catch(e => console.error('[ImageMetadataUpdatePush] error push also failed:', e))
  }
}
