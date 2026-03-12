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
import { startIntakeFlow, handleIntakeStep, beginIntakeFromStart, resumeIntakeFlow, sendQuestionForStep } from './intake-flow'
import { upsertLineUser, ensureUserAccount, findUserAccount } from '../../repositories/line-users-repo'
import { upsertUserServiceStatus, checkServiceAccess } from '../../repositories/subscriptions-repo'
import { ensureOpenThread, createConversationMessage, updateThreadMode } from '../../repositories/conversations-repo'
import { findActiveModeSession, upsertModeSession, deleteModeSession } from '../../repositories/mode-sessions-repo'
import { ensureDailyLog } from '../../repositories/daily-logs-repo'
import { upsertWeight } from '../../repositories/body-metrics-repo'
import { createMealEntry, findMealEntryByDailyLogAndType } from '../../repositories/meal-entries-repo'
import { createMessageAttachment } from '../../repositories/conversations-repo'
import { createImageAnalysisJob } from '../../repositories/image-intake-repo'
import { createOpenAIClient } from '../ai/openai-client'
import { generateId, nowIso, todayJst } from '../../utils/id'

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

const WEIGHT_PATTERN = /(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|ｋｇ|キロ|Kg|KG)/i

// 食事区分テキスト分類
function classifyMealType(text: string): 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other' {
  if (/朝|朝食|朝ご飯|breakfast/i.test(text)) return 'breakfast'
  if (/昼|昼食|昼ご飯|ランチ|lunch/i.test(text)) return 'lunch'
  if (/夜|夕|夕食|夕ご飯|ディナー|dinner/i.test(text)) return 'dinner'
  if (/間食|おやつ|snack/i.test(text)) return 'snack'
  return 'other'
}

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
    } else if (IMAGE_CONFIRM_KEYWORDS.some(kw => textTrim.includes(kw))) {
      const { handleImageConfirm } = await import('./image-confirm-handler')
      await handleImageConfirm(event.replyToken, intakeResultId, lineUserId, preEffectiveAccountId, env)
      return
    } else if (IMAGE_CANCEL_KEYWORDS.some(kw => textTrim.includes(kw))) {
      const { handleImageDiscard } = await import('./image-confirm-handler')
      await handleImageDiscard(event.replyToken, intakeResultId, lineUserId, preEffectiveAccountId, env)
      return
    } else {
      // P7: S3中は全ての他入力をブロック（招待コード・モード切替・体重等含む）
      await replyWithQuickReplies(
        event.replyToken,
        '🔄 いま画像の確認中です。\n「確定」または「取消」で応答してください。',
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      return
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
  if (textTrim === '問診やり直し') {
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

  // 明示的モード切替
  if (SWITCH_TO_CONSULT.some(kw => textTrim.includes(kw))) {
    try { await updateThreadMode(env.DB, thread.id, 'consult') } catch (e) { console.error('[LINE] updateThreadMode(consult) error:', e) }
    try {
      await upsertModeSession(env.DB, {
        clientAccountId: effectiveAccountId,
        lineUserId,
        currentMode: 'consult',
        currentStep: 'idle',
      })
    } catch (e) { console.error('[LINE] upsertModeSession(consult) error:', e) }
    await replyText(event.replyToken, '💬 相談モードに切り替えました。\nお気軽にご相談ください！', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  if (SWITCH_TO_RECORD.some(kw => textTrim.includes(kw))) {
    try { await updateThreadMode(env.DB, thread.id, 'record') } catch (e) { console.error('[LINE] updateThreadMode(record) error:', e) }
    try { await deleteModeSession(env.DB, effectiveAccountId, lineUserId) } catch (e) { console.error('[LINE] deleteModeSession error:', e) }
    await replyText(event.replyToken, '📝 記録モードに切り替えました。\n体重・食事・運動などを記録しましょう！', env.LINE_CHANNEL_ACCESS_TOKEN)
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
    await handleRecordText(event.replyToken, textTrim, userAccount.id, effectiveAccountId, thread.id, ctx)
  }
}

// ===================================================================
// handleRecordText — 記録モードのテキスト処理
// ===================================================================

async function handleRecordText(
  replyToken: string,
  text: string,
  userAccountId: string,
  clientAccountId: string,
  threadId: string,
  ctx: ProcessContext
): Promise<void> {
  const { env } = ctx
  const today = todayJst()
  const dailyLog = await ensureDailyLog(env.DB, { userAccountId, clientAccountId, logDate: today })

  // --- 体重検出 ---
  const weightMatch = text.match(WEIGHT_PATTERN)
  if (weightMatch) {
    const weightKg = parseFloat(weightMatch[1])
    await upsertWeight(env.DB, { dailyLogId: dailyLog.id, weightKg })

    await createConversationMessage(env.DB, {
      threadId,
      senderType: 'bot',
      messageType: 'text',
      rawText: `体重 ${weightKg}kg を記録しました ✅`,
      modeAtSend: 'record',
      sentAt: nowIso(),
    })

    await replyTextWithQuickReplies(
      replyToken,
      `体重 ${weightKg}kg を記録しました ✅\n\n他に記録することはありますか？`,
      [
        { label: '🍽 食事を記録', text: '食事記録' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // --- 食事テキスト検出 ---
  const mealType = classifyMealType(text)
  // 食事内容らしい文字列（10文字以上または食事区分が特定できた場合）
  if (mealType !== 'other' || text.length >= 8) {
    const existing = await findMealEntryByDailyLogAndType(env.DB, dailyLog.id, mealType)
    if (!existing) {
      await createMealEntry(env.DB, {
        dailyLogId: dailyLog.id,
        mealType,
        mealText: text,
        confirmationStatus: 'draft',
      })
    } else {
      // 既存エントリに追記（テキスト結合）
      const newText = [existing.meal_text, text].filter(Boolean).join(' / ')
      await env.DB.prepare(`
        UPDATE meal_entries SET meal_text = ?1, updated_at = ?2 WHERE id = ?3
      `).bind(newText, nowIso(), existing.id).run()
    }

    await createConversationMessage(env.DB, {
      threadId,
      senderType: 'bot',
      messageType: 'text',
      rawText: `食事を記録しました ✅（${mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : mealType === 'dinner' ? '夕食' : mealType === 'snack' ? '間食' : '食事'}）`,
      modeAtSend: 'record',
      sentAt: nowIso(),
    })

    await replyTextWithQuickReplies(
      replyToken,
      `食事を記録しました ✅\n\n写真も送ると栄養素を自動で計算できます 📷`,
      [
        { label: '⚖️ 体重も記録', text: '体重記録' },
        { label: '💬 相談する', text: '相談モード' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // --- 判定できなかったケース ---
  await replyTextWithQuickReplies(
    replyToken,
    `記録しました！\n\n体重・食事・運動などを入力してください。\n例: 「体重58.5kg」「朝食 トースト・コーヒー」`,
    [
      { label: '📝 記録する', text: '記録モード' },
      { label: '💬 相談する', text: '相談モード' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
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
    // 3. ユーザー個人コンテキスト（プロフィール・体重推移・食事記録）
    // ---------------------------------------------------------------
    const userContext = await buildUserContext(env.DB, userAccountId)
    let personalContext = ''
    if (userContext.trim()) {
      personalContext = '\n\n' + userContext
    }

    // ---------------------------------------------------------------
    // 4. system prompt を組み立て
    // ---------------------------------------------------------------
    const systemPrompt = basePrompt + personalContext + knowledgeContext

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

    await replyTextWithQuickReplies(
      replyToken,
      response,
      [
        { label: '📝 記録に戻る', text: '記録モード' },
        { label: '💬 続けて相談', text: '相談続ける' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
  } catch (err) {
    console.error('[LINE] consult AI error:', err)
    await replyText(
      replyToken,
      'AIの応答に失敗しました。しばらくしてから再度お試しください。',
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
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
  // ------------------------------------------------------------------
  let userAccount: Awaited<ReturnType<typeof ensureUserAccount>>
  let thread: Awaited<ReturnType<typeof ensureOpenThread>>
  try {
    userAccount = await ensureUserAccount(env.DB, lineUserId, effectiveAccountId)
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
