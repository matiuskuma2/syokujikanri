/**
 * BOTディスパッチャー
 * LINEメッセージを受け取り、適切なBOTモードに振り分ける
 */

import type { Bindings, LineMessageEvent, LineFollowEvent } from '../types/bindings'
import {
  SessionRepo, MessageRepo, LineUserRepo, UserServiceRepo,
  ProfileRepo, DailyLogRepo, MealRepo, KnowledgeRepo,
  ProgressPhotoRepo, todayJst, generateId, nowIso
} from '../repository'
import { DietAIService } from '../ai/client'
import {
  replyText, replyTextWithQuickReplies, pushText,
  getMessageContent, getUserProfile
} from '../utils/line'
import {
  INTAKE_WELCOME_MESSAGE, INTAKE_QUESTIONS, INTAKE_COMPLETE_MESSAGE
} from '../ai/prompts'

// ===================================================================
// メインディスパッチャー
// ===================================================================

export async function dispatchMessage(
  env: Bindings,
  accountId: string,
  channelId: string,
  event: LineMessageEvent
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId) return

  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN

  // ユーザー情報取得 or 作成
  const lineUser = await LineUserRepo.findByLineUserId(env.DB, accountId, lineUserId)
  if (!lineUser) {
    // 新規ユーザーはフォローイベントで処理されるはずだが念のため
    return
  }

  // サービス状態確認
  const serviceStatus = await UserServiceRepo.ensureDefault(env.DB, accountId, lineUserId)
  if (!serviceStatus.bot_enabled) {
    return // BOT無効ユーザーはスキップ
  }

  // 会話スレッド取得・作成
  const threadId = await MessageRepo.getOrCreateThread(env.DB, accountId, lineUserId)

  // メッセージ保存
  const messageContent = event.message.type === 'text' ? event.message.text || null : null
  const inboundMsgId = await MessageRepo.saveMessage(env.DB, {
    threadId,
    direction: 'inbound',
    messageType: event.message.type,
    content: messageContent,
    metadata: {
      line_message_id: event.message.id,
      reply_token: event.replyToken
    }
  })

  const replyToken = event.replyToken || ''

  // 画像メッセージの処理
  if (event.message.type === 'image') {
    await handleImageMessage(env, accountId, lineUserId, event, threadId, inboundMsgId, replyToken)
    return
  }

  // テキストメッセージの処理
  if (event.message.type === 'text' && event.message.text) {
    const text = event.message.text.trim()

    // セッション確認
    const session = await SessionRepo.findActive(env.DB, accountId, lineUserId)

    // コマンドチェック（セッションに関わらず実行）
    if (isCommand(text, ['ヘルプ', 'help', 'メニュー'])) {
      await sendMainMenu(replyToken, accessToken)
      return
    }
    if (isCommand(text, ['キャンセル', 'cancel', 'やめる', '中断'])) {
      await SessionRepo.clear(env.DB, accountId, lineUserId)
      await replyText(replyToken, 'キャンセルしました。\n「ヘルプ」でメニューを表示できます。', accessToken)
      return
    }

    // セッションが存在する場合は続行
    if (session) {
      await continueSession(env, accountId, lineUserId, threadId, session.mode, session.step_code,
        session.session_data ? JSON.parse(session.session_data) : {}, text, replyToken)
      return
    }

    // 新規モード開始コマンド
    if (isCommand(text, ['記録', 'きろく', '食事記録'])) {
      await startRecordMode(env, accountId, lineUserId, threadId, replyToken)
      return
    }
    if (isCommand(text, ['相談', 'そうだん', 'チャット'])) {
      if (!serviceStatus.consult_enabled) {
        await replyText(replyToken, '相談機能は現在ご利用いただけません。', accessToken)
        return
      }
      await startConsultMode(env, accountId, lineUserId, threadId, replyToken)
      return
    }
    if (isCommand(text, ['ヒアリング', 'プロフィール設定', '初期設定'])) {
      if (!serviceStatus.intake_enabled) {
        await replyText(replyToken, 'ヒアリング機能は現在ご利用いただけません。', accessToken)
        return
      }
      await startIntakeMode(env, accountId, lineUserId, threadId, replyToken)
      return
    }
    if (isCommand(text, ['体重', 'たいじゅう', '今日の体重'])) {
      await handleWeightInput(env, accountId, lineUserId, threadId, text, replyToken)
      return
    }

    // ナレッジ検索（デフォルト）
    if (serviceStatus.consult_enabled) {
      await handleKnowledgeQuery(env, accountId, lineUserId, threadId, text, replyToken)
    } else {
      await sendMainMenu(replyToken, accessToken)
    }
  }
}

// ===================================================================
// フォローイベント処理
// ===================================================================

export async function dispatchFollowEvent(
  env: Bindings,
  accountId: string,
  channelId: string,
  event: LineFollowEvent
): Promise<void> {
  const lineUserId = event.source.userId
  if (!lineUserId) return

  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN

  // LINEプロフィール取得
  const lineProfile = await getUserProfile(lineUserId, accessToken)

  // ユーザー登録
  const lineChannel = await env.DB.prepare(
    'SELECT id FROM line_channels WHERE channel_id = ? OR account_id = ?'
  ).bind(channelId, accountId).first<{ id: string }>()

  if (lineChannel) {
    await LineUserRepo.upsert(env.DB, {
      accountId,
      lineChannelId: lineChannel.id,
      lineUserId,
      displayName: lineProfile?.displayName,
      pictureUrl: lineProfile?.pictureUrl
    })
  }

  // サービスステータス初期化
  await UserServiceRepo.ensureDefault(env.DB, accountId, lineUserId)

  // ウェルカムメッセージ + ヒアリング開始
  const replyToken = event.replyToken || ''
  if (replyToken) {
    await replyText(replyToken, INTAKE_WELCOME_MESSAGE, accessToken)
  }
}

// ===================================================================
// ヒアリングモード
// ===================================================================

async function startIntakeMode(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  replyToken: string
): Promise<void> {
  await SessionRepo.upsert(env.DB, {
    accountId, lineUserId, mode: 'intake', stepCode: 'intake_welcome'
  })
  await replyText(replyToken, INTAKE_WELCOME_MESSAGE, env.LINE_CHANNEL_ACCESS_TOKEN)
}

// ===================================================================
// 記録モード
// ===================================================================

async function startRecordMode(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  replyToken: string
): Promise<void> {
  await SessionRepo.upsert(env.DB, {
    accountId, lineUserId, mode: 'record', stepCode: 'record_start'
  })
  await replyTextWithQuickReplies(
    replyToken,
    '📝 何を記録しますか？',
    [
      { label: '朝食', text: '朝食を記録' },
      { label: '昼食', text: '昼食を記録' },
      { label: '夕食', text: '夕食を記録' },
      { label: '間食', text: '間食を記録' },
      { label: '体重', text: '体重を記録' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function handleWeightInput(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  text: string,
  replyToken: string
): Promise<void> {
  const weight = parseFloat(text.replace(/[^0-9.]/g, ''))
  if (isNaN(weight) || weight < 20 || weight > 300) {
    await replyText(replyToken, '体重を数字で入力してください（例: 65.5）', env.LINE_CHANNEL_ACCESS_TOKEN)
    return
  }

  const today = todayJst()
  const log = await DailyLogRepo.upsert(env.DB, {
    account_id: accountId,
    line_user_id: lineUserId,
    log_date: today,
    weight_kg: weight
  })

  // プロフィールの現在体重も更新
  await ProfileRepo.upsert(env.DB, {
    account_id: accountId,
    line_user_id: lineUserId,
    current_weight_kg: weight
  })

  await replyText(
    replyToken,
    `⚖️ ${today}の体重を記録しました\n\n体重: ${weight}kg\n\n継続は力なり！毎日の記録が目標達成への近道です💪`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// 相談モード
// ===================================================================

async function startConsultMode(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  replyToken: string
): Promise<void> {
  await SessionRepo.upsert(env.DB, {
    accountId, lineUserId, mode: 'consult', stepCode: 'consult_waiting_user_question'
  })
  await replyText(
    replyToken,
    '💬 相談モードです。ダイエットや健康について何でも聞いてください！\n（「キャンセル」で終了）',
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// セッション継続処理
// ===================================================================

async function continueSession(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  mode: string,
  stepCode: string,
  sessionData: Record<string, unknown>,
  text: string,
  replyToken: string
): Promise<void> {
  switch (mode) {
    case 'intake':
      await handleIntakeStep(env, accountId, lineUserId, threadId, stepCode, sessionData, text, replyToken)
      break
    case 'record':
      await handleRecordStep(env, accountId, lineUserId, threadId, stepCode, sessionData, text, replyToken)
      break
    case 'consult':
      await handleConsultStep(env, accountId, lineUserId, threadId, sessionData, text, replyToken)
      break
    default:
      await SessionRepo.clear(env.DB, accountId, lineUserId)
      await sendMainMenu(replyToken, env.LINE_CHANNEL_ACCESS_TOKEN)
  }
}

// ヒアリングステップ処理
async function handleIntakeStep(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  stepCode: string,
  sessionData: Record<string, unknown>,
  text: string,
  replyToken: string
): Promise<void> {
  const steps = ['nickname', 'gender', 'age_range', 'height_cm', 'current_weight_kg', 'target_weight_kg', 'goal_summary']
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN

  // はじめる → nickname質問
  if (stepCode === 'intake_welcome' || isCommand(text, ['はじめる', '開始', 'start'])) {
    await SessionRepo.upsert(env.DB, {
      accountId, lineUserId, mode: 'intake', stepCode: 'intake_nickname', sessionData
    })
    await replyText(replyToken, INTAKE_QUESTIONS.nickname.message, accessToken)
    return
  }

  // 各ステップの回答処理
  const stepMap: Record<string, { key: string; next: string; validate?: (t: string) => boolean }> = {
    intake_nickname: { key: 'nickname', next: 'intake_gender' },
    intake_gender: {
      key: 'gender', next: 'intake_age_range',
      validate: (t) => ['1', '2', '3', '男性', '女性', 'male', 'female'].includes(t)
    },
    intake_age_range: { key: 'age_range', next: 'intake_height' },
    intake_height: {
      key: 'height_cm', next: 'intake_weight',
      validate: (t) => !isNaN(parseFloat(t.replace(/[^0-9.]/g, '')))
    },
    intake_weight: {
      key: 'current_weight_kg', next: 'intake_target_weight',
      validate: (t) => !isNaN(parseFloat(t.replace(/[^0-9.]/g, '')))
    },
    intake_target_weight: {
      key: 'target_weight_kg', next: 'intake_goal',
      validate: (t) => !isNaN(parseFloat(t.replace(/[^0-9.]/g, '')))
    },
    intake_goal: { key: 'goal_summary', next: 'intake_complete' }
  }

  const currentStep = stepMap[stepCode]
  if (!currentStep) {
    await SessionRepo.clear(env.DB, accountId, lineUserId)
    return
  }

  // バリデーション
  if (currentStep.validate && !currentStep.validate(text)) {
    await replyText(replyToken, '入力形式が正しくありません。もう一度入力してください。', accessToken)
    return
  }

  // 値の変換・保存
  let value: unknown = text
  if (currentStep.key === 'height_cm' || currentStep.key === 'current_weight_kg' || currentStep.key === 'target_weight_kg') {
    value = parseFloat(text.replace(/[^0-9.]/g, ''))
  }
  if (currentStep.key === 'gender') {
    value = text === '1' || text === '男性' || text === 'male' ? 'male'
      : text === '2' || text === '女性' || text === 'female' ? 'female' : 'other'
  }
  if (currentStep.key === 'goal_summary' && (text === 'スキップ' || text === 'skip')) {
    value = null
  }

  sessionData[currentStep.key] = value

  // 完了チェック
  if (currentStep.next === 'intake_complete') {
    // プロフィール保存
    await ProfileRepo.upsert(env.DB, {
      account_id: accountId,
      line_user_id: lineUserId,
      nickname: sessionData.nickname as string || null,
      gender: sessionData.gender as 'male' | 'female' | 'other' || null,
      age_range: sessionData.age_range as string || null,
      height_cm: sessionData.height_cm as number || null,
      current_weight_kg: sessionData.current_weight_kg as number || null,
      target_weight_kg: sessionData.target_weight_kg as number || null,
      goal_summary: sessionData.goal_summary as string || null
    })

    await SessionRepo.clear(env.DB, accountId, lineUserId)

    const nickname = sessionData.nickname as string || 'あなた'
    const current = sessionData.current_weight_kg as number || 0
    const target = sessionData.target_weight_kg as number || 0
    await replyText(replyToken, INTAKE_COMPLETE_MESSAGE(nickname, target, current), accessToken)
    return
  }

  // 次のステップへ
  await SessionRepo.upsert(env.DB, {
    accountId, lineUserId, mode: 'intake',
    stepCode: currentStep.next, sessionData
  })

  // 次の質問を送信
  const nextQuestionMap: Record<string, string> = {
    intake_gender: INTAKE_QUESTIONS.gender.message,
    intake_age_range: INTAKE_QUESTIONS.age_range.message,
    intake_height: INTAKE_QUESTIONS.height_cm.message,
    intake_weight: INTAKE_QUESTIONS.current_weight_kg.message,
    intake_target_weight: INTAKE_QUESTIONS.target_weight_kg.message,
    intake_goal: INTAKE_QUESTIONS.goal_summary.message
  }

  const nextMessage = nextQuestionMap[currentStep.next]
  if (nextMessage) {
    await replyText(replyToken, nextMessage, accessToken)
  }
}

// 記録ステップ処理
async function handleRecordStep(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  stepCode: string,
  sessionData: Record<string, unknown>,
  text: string,
  replyToken: string
): Promise<void> {
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN
  const mealTypeMap: Record<string, string> = {
    '朝食を記録': 'breakfast', '昼食を記録': 'lunch',
    '夕食を記録': 'dinner', '間食を記録': 'snack', '体重を記録': 'weight'
  }

  if (stepCode === 'record_start') {
    const mealType = mealTypeMap[text]
    if (!mealType) {
      await replyText(replyToken, '記録する種類を選んでください。', accessToken)
      return
    }
    if (mealType === 'weight') {
      await SessionRepo.clear(env.DB, accountId, lineUserId)
      await handleWeightInput(env, accountId, lineUserId, threadId, '', replyToken)
      return
    }
    await SessionRepo.upsert(env.DB, {
      accountId, lineUserId, mode: 'record',
      stepCode: 'record_waiting_meal_input',
      sessionData: { meal_type: mealType }
    })
    await replyText(
      replyToken,
      `🍽️ ${text.replace('を記録', '')}の内容を教えてください\n\n写真を送るか、テキストで入力してください\n（例: ご飯1杯、みそ汁、焼き魚）\n\n「スキップ」で記録なしとして保存できます`,
      accessToken
    )
    return
  }

  if (stepCode === 'record_waiting_meal_input') {
    const mealType = sessionData.meal_type as string || 'snack'
    const today = todayJst()

    if (text === 'スキップ' || text === 'skip') {
      await SessionRepo.clear(env.DB, accountId, lineUserId)
      await replyText(replyToken, '記録をスキップしました。', accessToken)
      return
    }

    // テキストからAI解析
    const ai = new DietAIService(env)
    const analysis = await ai.parseMealText(text, mealType)

    // 日次ログ確認・作成
    const dailyLog = await DailyLogRepo.upsert(env.DB, {
      account_id: accountId, line_user_id: lineUserId, log_date: today
    })

    // 食事記録保存
    await MealRepo.create(env.DB, {
      line_user_id: lineUserId,
      account_id: accountId,
      daily_log_id: dailyLog.id,
      log_date: today,
      meal_type: mealType as MealEntry['meal_type'],
      description: text,
      estimated_calories: analysis.total_calories || null,
      estimated_protein_g: analysis.total_protein_g || null,
      estimated_fat_g: analysis.total_fat_g || null,
      estimated_carbs_g: analysis.total_carbs_g || null,
      nutrition_score: analysis.nutrition_score || null,
      ai_parsed: true,
      ai_comment: analysis.ai_comment || null,
      image_key: null,
      recorded_at: nowIso()
    })

    await SessionRepo.clear(env.DB, accountId, lineUserId)

    const calText = analysis.total_calories ? `約${analysis.total_calories}kcal` : '（解析中）'
    const comment = analysis.ai_comment || '記録しました！'
    await replyText(
      replyToken,
      `✅ 食事記録を保存しました\n\n${text}\n${calText}\n\n${comment}`,
      accessToken
    )
  }
}

// 相談ステップ処理
async function handleConsultStep(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  sessionData: Record<string, unknown>,
  text: string,
  replyToken: string
): Promise<void> {
  const profile = await ProfileRepo.findByUser(env.DB, accountId, lineUserId)
  const history = await MessageRepo.getRecentHistory(env.DB, threadId, 10)

  const ai = new DietAIService(env)
  const response = await ai.consult(text, profile, history)

  // 返答保存
  await MessageRepo.saveMessage(env.DB, {
    threadId, direction: 'outbound', messageType: 'text',
    content: response, botMode: 'consult', stepCode: 'consult_answer'
  })

  await replyText(replyToken, response, env.LINE_CHANNEL_ACCESS_TOKEN)
}

// ===================================================================
// 画像メッセージ処理
// ===================================================================

async function handleImageMessage(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  event: LineMessageEvent,
  threadId: string,
  messageId: string,
  replyToken: string
): Promise<void> {
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN

  // 画像コンテンツ取得
  const content = await getMessageContent(event.message.id, accessToken)
  if (!content) {
    await replyText(replyToken, '画像の取得に失敗しました。再度送信してください。', accessToken)
    return
  }

  // R2に保存
  const today = todayJst()
  const r2Key = `images/${accountId}/${lineUserId}/${today}/${event.message.id}.jpg`
  await env.R2.put(r2Key, content, {
    httpMetadata: { contentType: 'image/jpeg' }
  })

  // R2公開URL（仮）
  const imageUrl = `${env.R2_BUCKET_URL}/${r2Key}`

  // AI分類
  const ai = new DietAIService(env)
  const classification = await ai.classifyImage(imageUrl)

  // セッション確認
  const session = await SessionRepo.findActive(env.DB, accountId, lineUserId)

  let replyMessage = '画像を受け取りました。'

  switch (classification.type) {
    case 'meal_photo': {
      const mealType = session?.mode === 'record'
        ? (session?.session_data ? JSON.parse(session.session_data).meal_type || 'snack' : 'snack')
        : 'snack'
      const analysis = await ai.analyzeMealImage(imageUrl, mealType)

      const dailyLog = await DailyLogRepo.upsert(env.DB, {
        account_id: accountId, line_user_id: lineUserId, log_date: today
      })
      await MealRepo.create(env.DB, {
        line_user_id: lineUserId, account_id: accountId,
        daily_log_id: dailyLog.id, log_date: today,
        meal_type: mealType as MealEntry['meal_type'],
        description: analysis.dishes.map(d => d.name).join('、') || '食事',
        estimated_calories: analysis.total_calories || null,
        estimated_protein_g: analysis.total_protein_g || null,
        estimated_fat_g: analysis.total_fat_g || null,
        estimated_carbs_g: analysis.total_carbs_g || null,
        nutrition_score: analysis.nutrition_score || null,
        ai_parsed: true,
        ai_comment: analysis.ai_comment || null,
        image_key: r2Key,
        recorded_at: nowIso()
      })

      if (session?.mode === 'record') {
        await SessionRepo.clear(env.DB, accountId, lineUserId)
      }

      const dishes = analysis.dishes.map(d => `・${d.name}（${d.estimated_calories}kcal）`).join('\n')
      replyMessage = `🍽️ 食事を記録しました！\n\n${dishes || '食事内容'}\n\n合計: 約${analysis.total_calories}kcal\n\n${analysis.ai_comment}`
      break
    }
    case 'body_scale': {
      const scaleResult = await ai.analyzeScale(imageUrl)
      if (scaleResult.weight_kg) {
        await DailyLogRepo.upsert(env.DB, {
          account_id: accountId, line_user_id: lineUserId, log_date: today,
          weight_kg: scaleResult.weight_kg,
          body_fat_pct: scaleResult.body_fat_pct || null
        })
        await ProfileRepo.upsert(env.DB, {
          account_id: accountId, line_user_id: lineUserId,
          current_weight_kg: scaleResult.weight_kg
        })
        replyMessage = `⚖️ 体重を記録しました！\n\n体重: ${scaleResult.weight_kg}kg${scaleResult.body_fat_pct ? `\n体脂肪率: ${scaleResult.body_fat_pct}%` : ''}\n\n毎日の記録、お疲れさまです！`
      } else {
        replyMessage = '体重計の数値を読み取れませんでした。数値が見えるように撮り直してください📷'
      }
      break
    }
    case 'nutrition_label': {
      const label = await ai.analyzeNutritionLabel(imageUrl)
      if (label.calories_per_serving) {
        replyMessage = `📊 栄養成分を読み取りました！\n\n${label.product_name || '商品名不明'}\n1食分(${label.serving_size || '?'})\nカロリー: ${label.calories_per_serving}kcal\nタンパク質: ${label.protein_g || '?'}g\n脂質: ${label.fat_g || '?'}g\n炭水化物: ${label.carbs_g || '?'}g\n\nこの食品を記録しますか？\n「はい」で記録、「いいえ」でキャンセル`
      } else {
        replyMessage = 'ラベルの読み取りに失敗しました。もっと近づけて撮影してください📷'
      }
      break
    }
    case 'progress_body_photo': {
      // 進捗写真として保存
      await ProgressPhotoRepo.create(env.DB, {
        line_user_id: lineUserId, account_id: accountId,
        log_date: today, r2_key: r2Key,
        weight_at_photo: null, waist_at_photo: null, notes: null
      })
      replyMessage = '📸 進捗写真を保存しました！\n\nダッシュボードから確認できます。\n継続は力なり！引き続き頑張りましょう💪'
      break
    }
    default:
      replyMessage = '画像を受け取りました。食事の写真や体重計の写真を送ると自動で記録できます📱'
  }

  await replyText(replyToken, replyMessage, accessToken)
}

// ===================================================================
// ナレッジ検索
// ===================================================================

async function handleKnowledgeQuery(
  env: Bindings,
  accountId: string,
  lineUserId: string,
  threadId: string,
  text: string,
  replyToken: string
): Promise<void> {
  const docs = await KnowledgeRepo.searchByText(env.DB, accountId, text, 3)
  const context = docs.map(d => `【${d.title}】\n${d.content}`).join('\n\n')

  const profile = await ProfileRepo.findByUser(env.DB, accountId, lineUserId)
  const ai = new DietAIService(env)
  const response = await ai.answerWithKnowledge(text, context, profile)

  await replyText(replyToken, response, env.LINE_CHANNEL_ACCESS_TOKEN)
}

// ===================================================================
// メインメニュー
// ===================================================================

async function sendMainMenu(replyToken: string, accessToken: string): Promise<void> {
  await replyTextWithQuickReplies(
    replyToken,
    '📱 何をしますか？',
    [
      { label: '食事記録', text: '記録' },
      { label: '相談', text: '相談' },
      { label: 'プロフィール', text: 'ヒアリング' },
    ],
    accessToken
  )
}

// ===================================================================
// ヘルパー
// ===================================================================

function isCommand(text: string, commands: string[]): boolean {
  const normalized = text.trim().toLowerCase()
  return commands.some(cmd => normalized === cmd.toLowerCase())
}

// TypeScript用のMealEntryインポート
import type { MealEntry } from '../types/models'
