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

import { getUserProfile, replyText, replyWithQuickReplies, getMessageContent } from './reply'
import { startIntakeFlow, handleIntakeStep, beginIntakeFromStart, resumeIntakeFlow } from './intake-flow'
import { upsertLineUser, ensureUserAccount } from '../../repositories/line-users-repo'
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
}

// テキスト分類用キーワード
const CONSULT_KEYWORDS = ['相談', '質問', 'アドバイス', '教えて', 'どうすれば', '悩み', 'ヘルプ']
const RECORD_KEYWORDS = ['記録', 'ログ', 'メモ']
const SWITCH_TO_CONSULT = ['相談モード', '相談にして', '相談する']
const SWITCH_TO_RECORD = ['記録モード', '記録にして', '記録する', '戻る']

// 体重検出パターン: 例 "58.5kg", "58.5 kg", "58キロ"
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

  // 3. user_accounts 作成（初回フォロー時）
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

  // 5. 会話スレッド作成
  const userAccount = await ensureUserAccount(env.DB, lineUserId, clientAccountId)
  await ensureOpenThread(env.DB, {
    lineChannelId,
    lineUserId,
    clientAccountId,
    userAccountId: userAccount.id,
  })

  // 6. インテークフロー開始（初回問診 / 再フォロー時はスキップ判定）
  if (event.replyToken) {
    await startIntakeFlow(
      event.replyToken,
      lineUserId,
      clientAccountId,
      env,
      'follow'
    )
  }

  console.log(`[LINE] follow: ${lineUserId} (${profile?.displayName})`)
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

  // ------------------------------------------------------------------
  // 1. サービスアクセス確認
  // ------------------------------------------------------------------
  const access = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
  if (!access || !access.botEnabled) {
    await replyText(event.replyToken, 'このサービスは現在ご利用いただけません。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // 2. ユーザー・スレッドの確保
  // ------------------------------------------------------------------
  const userAccount = await ensureUserAccount(env.DB, lineUserId, clientAccountId)
  const thread = await ensureOpenThread(env.DB, {
    lineChannelId,
    lineUserId,
    clientAccountId,
    userAccountId: userAccount.id,
  })

  // ------------------------------------------------------------------
  // 3. メッセージ保存（user 発言）
  // ------------------------------------------------------------------
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
  // 4. モード切替コマンド判定
  // ------------------------------------------------------------------
  // インテーク開始 / 再開コマンド
  if (['問診', 'ヒアリング', '登録', '初期設定'].includes(textTrim)) {
    await startIntakeFlow(event.replyToken, lineUserId, clientAccountId, env, 'command')
    return
  }

  // 「問診やり直し」→ 最初から新規開始
  if (textTrim === '問診やり直し') {
    // intake_completed を 0 にリセット
    await upsertUserServiceStatus(env.DB, {
      accountId: clientAccountId,
      lineUserId,
      intakeCompleted: 0,
    })
    await beginIntakeFromStart(event.replyToken, lineUserId, clientAccountId, env)
    return
  }

  // 「問診再開」→ 途中のステップから続行
  if (textTrim === '問診再開') {
    await resumeIntakeFlow(event.replyToken, lineUserId, clientAccountId, env)
    return
  }

  if (SWITCH_TO_CONSULT.some(kw => textTrim.includes(kw))) {
    await updateThreadMode(env.DB, thread.id, 'consult')
    await upsertModeSession(env.DB, {
      clientAccountId,
      lineUserId,
      currentMode: 'consult',
      currentStep: 'idle',
    })
    await replyText(event.replyToken, '💬 相談モードに切り替えました。\nお気軽にご相談ください！', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  if (SWITCH_TO_RECORD.some(kw => textTrim.includes(kw))) {
    await updateThreadMode(env.DB, thread.id, 'record')
    await deleteModeSession(env.DB, clientAccountId, lineUserId)
    await replyText(event.replyToken, '📝 記録モードに切り替えました。\n体重・食事・運動などを記録しましょう！', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // 5. 現在のモードに応じて処理
  // ------------------------------------------------------------------
  const session = await findActiveModeSession(env.DB, clientAccountId, lineUserId)
  const currentMode = session?.current_mode ?? thread.current_mode

  // 画像確認 pending 中の応答を優先処理
  if (session?.current_step === 'pending_image_confirm') {
    let sessionData: { intakeResultId?: string } = {}
    try {
      sessionData = session.session_data ? JSON.parse(session.session_data) : {}
    } catch { /* ignore */ }

    const intakeResultId = sessionData.intakeResultId
    if (!intakeResultId) {
      // データ不整合 — セッションをクリアして通常処理へ
      await deleteModeSession(env.DB, clientAccountId, lineUserId)
    } else if (['確定', 'はい', 'yes', 'ok', 'OK', '記録', '保存'].some(kw => textTrim.includes(kw))) {
      const { handleImageConfirm } = await import('./image-confirm-handler')
      await handleImageConfirm(event.replyToken, intakeResultId, lineUserId, clientAccountId, env)
      return
    } else if (['取消', 'キャンセル', 'cancel', 'いいえ', 'no', 'やめる', '削除'].some(kw => textTrim.includes(kw))) {
      const { handleImageDiscard } = await import('./image-confirm-handler')
      await handleImageDiscard(event.replyToken, intakeResultId, lineUserId, clientAccountId, env)
      return
    } else {
      // 判定できないテキスト → 再度確認を促す
      await replyWithQuickReplies(
        event.replyToken,
        '画像の解析結果を記録しますか？\n「確定」または「取消」で応答してください。',
        [
          { label: '✅ 確定', text: '確定' },
          { label: '❌ 取消', text: '取消' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      return
    }
  }

  // インテーク（問診）モード中は優先処理
  if (currentMode === 'intake') {
    const handled = await handleIntakeStep(
      event.replyToken,
      textTrim,
      lineUserId,
      userAccount.id,
      clientAccountId,
      env
    )
    if (handled) return
  }

  if (currentMode === 'consult') {
    await handleConsultText(event.replyToken, textTrim, thread.id, userAccount.id, ctx)
  } else {
    await handleRecordText(event.replyToken, textTrim, userAccount.id, clientAccountId, thread.id, ctx)
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

    const systemPrompt = `あなたはダイエット専門のAIアシスタントです。
ユーザーの食事・運動・体重管理をサポートし、科学的根拠に基づいたアドバイスを提供します。
- 常に励ましながら、具体的で実践的なアドバイスをしてください
- 医療診断は行わず、気になる症状は専門医への相談を促してください
- 日本語で、丁寧かつ親しみやすい口調で応答してください
- 回答は200文字以内で簡潔にまとめてください`

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
  if (!lineUserId || !event.replyToken) return

  const { env, lineChannelId, clientAccountId } = ctx

  // ------------------------------------------------------------------
  // 1. サービスアクセス確認
  // ------------------------------------------------------------------
  const access = await checkServiceAccess(env.DB, { accountId: clientAccountId, lineUserId })
  if (!access || !access.botEnabled) {
    await replyText(event.replyToken, 'このサービスは現在ご利用いただけません。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // 2. ユーザー・スレッドの確保
  // ------------------------------------------------------------------
  const userAccount = await ensureUserAccount(env.DB, lineUserId, clientAccountId)
  const thread = await ensureOpenThread(env.DB, {
    lineChannelId,
    lineUserId,
    clientAccountId,
    userAccountId: userAccount.id,
  })

  // ------------------------------------------------------------------
  // 3. LINE Content API から画像バイナリを取得
  // ------------------------------------------------------------------
  const content = await getMessageContent(event.message.id, env.LINE_CHANNEL_ACCESS_TOKEN)
  if (!content) {
    await replyText(event.replyToken, '画像の取得に失敗しました。もう一度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // 4. R2 に保存（intake/{userAccountId}/{messageId}.jpg）
  // ------------------------------------------------------------------
  const today = todayJst()
  const r2Key = `intake/${userAccount.id}/${today}-${event.message.id}.jpg`

  try {
    await env.R2.put(r2Key, content.data, {
      httpMetadata: { contentType: content.contentType },
    })
  } catch (err) {
    console.error('[LINE] R2 put error:', err)
    await replyText(event.replyToken, '画像の保存に失敗しました。しばらくしてから再度お試しください。', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  // ------------------------------------------------------------------
  // 5. conversation_messages に image メッセージを保存
  // ------------------------------------------------------------------
  const msg = await createConversationMessage(env.DB, {
    threadId: thread.id,
    senderType: 'user',
    lineMessageId: event.message.id,
    messageType: 'image',
    modeAtSend: thread.current_mode,
    sentAt: new Date(event.timestamp).toISOString().replace('T', ' ').substring(0, 19),
  })

  // ------------------------------------------------------------------
  // 6. message_attachments にレコードを確定
  //    ※ Queue 投入前に必ず DB レコードを確定させる
  // ------------------------------------------------------------------
  const attachment = await createMessageAttachment(env.DB, {
    messageId: msg.id,
    storageKey: r2Key,
    contentType: content.contentType,
    fileSizeBytes: content.data.byteLength,
  })

  // ------------------------------------------------------------------
  // 7. image_analysis_jobs を作成
  // ------------------------------------------------------------------
  await createImageAnalysisJob(env.DB, {
    messageAttachmentId: attachment.id,
    providerRoute: 'openai_vision',
  })

  // ------------------------------------------------------------------
  // 8. Queue に投入（非同期処理へ）
  // ------------------------------------------------------------------
  try {
    await env.LINE_EVENTS_QUEUE.send({
      type: 'image_analysis',
      attachmentId: attachment.id,
      userAccountId: userAccount.id,
      clientAccountId,
      threadId: thread.id,
      r2Key,
      lineUserId,
    })
  } catch (err) {
    console.error('[LINE] Queue send error:', err)
    // Queue 失敗は致命的ではない（ジョブは DB に残っている）
  }

  // ------------------------------------------------------------------
  // 9. ユーザーへの即時返信（解析中メッセージ）
  // ------------------------------------------------------------------
  await replyText(
    event.replyToken,
    '📷 画像を受け取りました！\n解析中です。少しお待ちください...',
    env.LINE_CHANNEL_ACCESS_TOKEN
  )

  console.log(`[LINE] image queued: attachment=${attachment.id} r2Key=${r2Key}`)
}
