/**
 * src/services/line/intake-flow.ts
 * インテーク（初回問診）フロー
 *
 * ユーザーが初めてフォローした後、または「問診」「ヒアリング」コマンドで開始
 * 質問を順番にLINEで送り、回答を収集してuser_profiles / intake_answersに保存
 *
 * フロー:
 *   1. nickname → 2. gender → 3. age_range → 4. height_cm
 *   5. current_weight_kg → 6. target_weight_kg → 7. goal_summary
 *   8. concern_tags → 9. activity_level → 完了
 */

import type { Bindings } from '../../types/bindings'
import { generateId, nowIso, todayJst } from '../../utils/id'
import { replyText, replyWithQuickReplies, pushText } from './reply'
import { findActiveModeSession, upsertModeSession } from '../../repositories/mode-sessions-repo'
import { ensureOpenThread, updateThreadMode } from '../../repositories/conversations-repo'
import { upsertBodyMetrics } from '../../repositories/body-metrics-repo'
import { ensureDailyLog } from '../../repositories/daily-logs-repo'
import { checkServiceAccess } from '../../repositories/subscriptions-repo'

// ===================================================================
// 問診ステップ定義
// ===================================================================

export type IntakeStep =
  | 'intake_start'
  | 'intake_nickname'
  | 'intake_gender'
  | 'intake_age_range'
  | 'intake_height'
  | 'intake_current_weight'
  | 'intake_target_weight'
  | 'intake_goal'
  | 'intake_concerns'
  | 'intake_activity'
  | 'intake_done'

const INTAKE_STEPS: IntakeStep[] = [
  'intake_nickname',
  'intake_gender',
  'intake_age_range',
  'intake_height',
  'intake_current_weight',
  'intake_target_weight',
  'intake_goal',
  'intake_concerns',
  'intake_activity',
  'intake_done',
]

// ===================================================================
// ステップ番号ヘルパー
// ===================================================================

/** IntakeStep → 表示用の質問番号 (1-based) */
function stepToNumber(step: IntakeStep): number {
  const idx = INTAKE_STEPS.indexOf(step)
  return idx >= 0 ? idx + 1 : 1
}

/** IntakeStep → 表示用の質問テーマ */
function stepToLabel(step: IntakeStep): string {
  const labels: Record<string, string> = {
    intake_nickname: 'ニックネーム',
    intake_gender: '性別',
    intake_age_range: '年代',
    intake_height: '身長',
    intake_current_weight: '現在の体重',
    intake_target_weight: '目標体重',
    intake_goal: '目標・理由',
    intake_concerns: '気になること',
    intake_activity: '活動レベル',
  }
  return labels[step] ?? ''
}

// ===================================================================
// 問診フロー開始（新規 / 再開 / やり直し を統合制御）
// ===================================================================

/**
 * 問診の開始制御（フォロー時 / 「問診」コマンド / 招待コード再送 共通エントリ）
 *
 * SSOT §6.1: 常に現在の質問を返す。「続けますか？」プロンプトは挟まない。
 *
 * 判定ロジック:
 *   1. intake_completed = 1 + source='follow' → 「おかえりなさい」
 *   2. intake_completed = 1 + source='command' → やり直し確認
 *   3. intake_completed = 0 + mode_session に intake あり → その step の質問を送信
 *   4. intake_completed = 0 + 過去の回答あり → 次の step から質問を送信
 *   5. いずれでもない → Q1 から新規開始
 *
 * @param source  'follow' | 'command' | 'invite_code'
 */
export async function startIntakeFlow(
  replyToken: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings,
  source: 'follow' | 'command' | 'invite_code' = 'follow'
): Promise<void> {
  // ----- 1. intake_completed チェック -----
  const access = await checkServiceAccess(env.DB, {
    accountId: clientAccountId,
    lineUserId,
  })

  if (access?.intakeCompleted) {
    if (source === 'follow') {
      // フォロー(再フォロー)時: 問診済みなのでスキップ
      await replyText(
        replyToken,
        `おかえりなさい！🌿\n\n引き続き diet-bot をご利用ください。\n📷 食事の写真を送ると自動解析\n⚖️ 体重も記録できます\n💬「相談」でAIに相談`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      return
    }
    if (source === 'invite_code') {
      // 招待コード再送時: 問診完了済み → 利用案内
      await replyText(
        replyToken,
        'ℹ️ 既に登録済みです。\nそのままご利用いただけます！\n\n📷 食事の写真を送ると自動解析\n⚖️ 体重を入力すると記録\n💬「相談モード」と入力でAIに相談',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      return
    }
    // コマンド時: 完了済み → やり直し確認
    await replyWithQuickReplies(
      replyToken,
      `✅ 初回問診は既に完了しています。\n\nもう一度最初からやり直しますか？`,
      [
        { label: 'やり直す', text: '問診やり直し' },
        { label: 'やめる', text: '戻る' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  // ----- 2. 途中セッション確認 → P6: 常に現在の質問を返す -----
  const session = await findActiveModeSession(env.DB, clientAccountId, lineUserId)

  if (session?.current_mode === 'intake') {
    const step = session.current_step as IntakeStep
    // P6: 「続けますか？」は聞かずに、直接質問を送る
    await sendQuestionForStep(replyToken, step, env)
    return
  }

  // ----- 3. 未完了だが期限切れ (セッションなし) → 過去回答から復元 -----
  const lastAnswer = await env.DB.prepare(
    `SELECT question_key FROM intake_answers
     WHERE user_account_id = (
       SELECT id FROM user_accounts
       WHERE line_user_id = ?1 AND client_account_id = ?2 LIMIT 1
     )
     ORDER BY answered_at DESC LIMIT 1`
  ).bind(lineUserId, clientAccountId).first<{ question_key: string }>()

  if (lastAnswer) {
    // 最後に回答した質問の「次」のステップを割り出す
    const resumeStep = getNextStepAfterAnswer(lastAnswer.question_key)
    if (resumeStep && resumeStep !== 'intake_done') {
      // P6: 確認なしで直接質問を送る
      await upsertModeSession(env.DB, {
        clientAccountId,
        lineUserId,
        currentMode: 'intake',
        currentStep: resumeStep,
      })
      await sendQuestionForStep(replyToken, resumeStep, env)
      return
    }
  }

  // ----- 4. 新規開始 -----
  await beginIntakeFromStart(replyToken, lineUserId, clientAccountId, env)
}

/**
 * 問診を質問1から開始する内部関数
 * （startIntakeFlow / 「問診やり直し」コマンドから呼ばれる）
 */
export async function beginIntakeFromStart(
  replyToken: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_nickname',
  })

  await replyText(
    replyToken,
    `ようこそ！🌿 diet-bot へ！\n\nはじめに簡単なご登録（9問）をお願いします。\n※いつでも「スキップ」と送れば省略できます。\n\n━━━━━━━━━━━━━━━\n【質問 1/9】\nお名前（ニックネームでOK）を教えてください！`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

/**
 * 問診を途中のステップから再開する
 * （「問診再開」コマンドから呼ばれる）
 */
export async function resumeIntakeFlow(
  replyToken: string,
  lineUserId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const session = await findActiveModeSession(env.DB, clientAccountId, lineUserId)
  if (!session || session.current_mode !== 'intake') {
    // セッションが見つからない場合は最初から
    await beginIntakeFromStart(replyToken, lineUserId, clientAccountId, env)
    return
  }

  const step = session.current_step as IntakeStep
  await sendQuestionForStep(replyToken, step, env)
}

/** 指定ステップに対応する質問メッセージを送信（外部からも呼び出し可能） */
export async function sendQuestionForStep(
  replyToken: string,
  step: IntakeStep,
  env: Bindings
): Promise<void> {
  const num = stepToNumber(step)

  switch (step) {
    case 'intake_nickname':
      await replyText(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\nお名前（ニックネームでOK）を教えてください！`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_gender':
      await replyWithQuickReplies(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n性別を教えてください。`,
        [
          { label: '男性', text: '男性' },
          { label: '女性', text: '女性' },
          { label: '答えない', text: 'スキップ' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_age_range':
      await replyWithQuickReplies(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n年代を教えてください。`,
        [
          { label: '20代', text: '20s' },
          { label: '30代', text: '30s' },
          { label: '40代', text: '40s' },
          { label: '50代', text: '50s' },
          { label: '60代以上', text: '60s+' },
          { label: 'スキップ', text: 'スキップ' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_height':
      await replyText(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n身長を教えてください（cm）\n\n例：「165」や「165cm」`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_current_weight':
      await replyText(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n現在の体重を教えてください（kg）\n\n例：「68」や「68.5kg」`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_target_weight':
      await replyText(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n目標体重を教えてください（kg）\n\n例：「58」や「58.5kg」`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_goal':
      await replyText(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\nダイエットの目標や理由を教えてください。\n\n例：「夏までに5kg痩せたい」「健康診断で引っかかった」\n（スキップしてもOKです）`,
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_concerns':
      await replyWithQuickReplies(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n気になることを教えてください。\n（複数回タップ→最後に「次へ」）`,
        [
          { label: 'お腹まわり', text: 'お腹まわり' },
          { label: '体重が減らない', text: '体重が減らない' },
          { label: '食べすぎ', text: '食べすぎ' },
          { label: 'むくみ', text: 'むくみ' },
          { label: '運動不足', text: '運動不足' },
          { label: '次へ進む', text: '次へ' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    case 'intake_activity':
      await replyWithQuickReplies(
        replyToken,
        `━━━━━━━━━━━━━━━\n【質問 ${num}/9】\n普段の活動レベルを教えてください。`,
        [
          { label: '座り仕事中心', text: 'sedentary' },
          { label: '軽い運動あり', text: 'light' },
          { label: '週3〜5回運動', text: 'moderate' },
          { label: '毎日激しく運動', text: 'active' },
          { label: 'スキップ', text: 'スキップ' },
        ],
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
      break
    default:
      await replyText(
        replyToken,
        '問診を再開します。',
        env.LINE_CHANNEL_ACCESS_TOKEN
      )
  }
}

/** question_key から次のステップを返す */
function getNextStepAfterAnswer(questionKey: string): IntakeStep | null {
  const keyToStep: Record<string, IntakeStep> = {
    'nickname': 'intake_gender',
    'gender': 'intake_age_range',
    'age_range': 'intake_height',
    'height_cm': 'intake_current_weight',
    'current_weight_kg': 'intake_target_weight',
    'target_weight_kg': 'intake_goal',
    'goal_summary': 'intake_concerns',
    'concern_tags': 'intake_activity',
    'activity_level': 'intake_done',
  }
  return keyToStep[questionKey] ?? null
}

// ===================================================================
// インテーク回答処理（メインディスパッチャー）
// ===================================================================

/**
 * 現在のインテークステップに応じて回答を処理し、次の質問を送る
 * @returns true: インテーク継続中 / false: インテーク以外（呼び出し元で通常処理）
 */
export async function handleIntakeStep(
  replyToken: string,
  text: string,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<boolean> {
  const session = await findActiveModeSession(env.DB, clientAccountId, lineUserId)
  if (!session || session.current_mode !== 'intake') return false

  const currentStep = session.current_step as IntakeStep
  const isSkip = ['スキップ', 'skip', '省略', 'とばす', '飛ばす'].some(
    kw => text.toLowerCase().includes(kw)
  )

  switch (currentStep) {
    case 'intake_nickname':
      await processNickname(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_gender':
      await processGender(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_age_range':
      await processAgeRange(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_height':
      await processHeight(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_current_weight':
      await processCurrentWeight(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_target_weight':
      await processTargetWeight(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_goal':
      await processGoal(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_concerns':
      await processConcerns(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    case 'intake_activity':
      await processActivity(replyToken, isSkip ? null : text, lineUserId, userAccountId, clientAccountId, env)
      break

    default:
      return false
  }

  return true
}

// ===================================================================
// 各ステップのハンドラ
// ===================================================================

async function processNickname(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const nickname = text && text.length <= 20 ? text : null

  await saveProfileField(env.DB, userAccountId, { nickname })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'nickname', nickname ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_gender',
  })

  const greeting = nickname ? `${nickname} さん、よろしくお願いします！\n\n` : ''

  await replyWithQuickReplies(
    replyToken,
    `${greeting}━━━━━━━━━━━━━━━\n【質問 2/9】\n性別を教えてください。`,
    [
      { label: '男性', text: '男性' },
      { label: '女性', text: '女性' },
      { label: '答えない', text: 'スキップ' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function processGender(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  let gender: 'male' | 'female' | 'other' | null = null
  if (text?.includes('男')) gender = 'male'
  else if (text?.includes('女')) gender = 'female'
  else if (text) gender = 'other'

  await saveProfileField(env.DB, userAccountId, { gender })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'gender', gender ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_age_range',
  })

  await replyWithQuickReplies(
    replyToken,
    `━━━━━━━━━━━━━━━\n【質問 3/9】\n年代を教えてください。`,
    [
      { label: '20代', text: '20s' },
      { label: '30代', text: '30s' },
      { label: '40代', text: '40s' },
      { label: '50代', text: '50s' },
      { label: '60代以上', text: '60s+' },
      { label: 'スキップ', text: 'スキップ' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function processAgeRange(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const validRanges = ['20s', '30s', '40s', '50s', '60s+']
  const ageRange = text && validRanges.includes(text) ? text : null

  await saveProfileField(env.DB, userAccountId, { age_range: ageRange })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'age_range', ageRange ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_height',
  })

  await replyText(
    replyToken,
    `━━━━━━━━━━━━━━━\n【質問 4/9】\n身長を教えてください（cm）\n\n例：「165」や「165cm」のように入力してください。`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function processHeight(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const heightNum = text ? parseFloat(text.replace(/[^0-9.]/g, '')) : NaN
  const heightCm = !isNaN(heightNum) && heightNum > 100 && heightNum < 250 ? heightNum : null

  await saveProfileField(env.DB, userAccountId, { height_cm: heightCm })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'height_cm', heightCm?.toString() ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_current_weight',
  })

  const msg = heightCm
    ? `${heightCm}cmですね！✅\n\n━━━━━━━━━━━━━━━\n【質問 5/9】\n現在の体重を教えてください（kg）\n\n例：「68」や「68.5kg」`
    : `━━━━━━━━━━━━━━━\n【質問 5/9】\n現在の体重を教えてください（kg）\n\n例：「68」や「68.5kg」`

  await replyText(replyToken, msg, env.LINE_CHANNEL_ACCESS_TOKEN)
}

async function processCurrentWeight(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const weightNum = text ? parseFloat(text.replace(/[^0-9.]/g, '')) : NaN
  const weightKg = !isNaN(weightNum) && weightNum > 20 && weightNum < 300 ? weightNum : null

  await saveProfileField(env.DB, userAccountId, { current_weight_kg: weightKg })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'current_weight_kg', weightKg?.toString() ?? '')

  // 現在体重をbody_metricsにも保存
  if (weightKg) {
    const today = todayJst()
    const dailyLog = await ensureDailyLog(env.DB, {
      userAccountId,
      clientAccountId,
      logDate: today,
    })
    await upsertBodyMetrics(env.DB, { dailyLogId: dailyLog.id, weightKg })
  }

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_target_weight',
  })

  const msg = weightKg
    ? `${weightKg}kgを記録しました✅\n\n━━━━━━━━━━━━━━━\n【質問 6/9】\n目標体重を教えてください（kg）\n\n例：「58」や「58.5kg」`
    : `━━━━━━━━━━━━━━━\n【質問 6/9】\n目標体重を教えてください（kg）\n\n例：「58」や「58.5kg」`

  await replyText(replyToken, msg, env.LINE_CHANNEL_ACCESS_TOKEN)
}

async function processTargetWeight(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const weightNum = text ? parseFloat(text.replace(/[^0-9.]/g, '')) : NaN
  const targetKg = !isNaN(weightNum) && weightNum > 20 && weightNum < 300 ? weightNum : null

  await saveProfileField(env.DB, userAccountId, { target_weight_kg: targetKg })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'target_weight_kg', targetKg?.toString() ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_goal',
  })

  const msg = targetKg
    ? `目標体重 ${targetKg}kg ですね！🎯\n\n━━━━━━━━━━━━━━━\n【質問 7/9】\nダイエットの目標や理由を教えてください。\n\n例：「夏までに5kg痩せたい」「健康診断で引っかかった」など\n（スキップしてもOKです）`
    : `━━━━━━━━━━━━━━━\n【質問 7/9】\nダイエットの目標や理由を教えてください。\n\n例：「夏までに5kg痩せたい」「健康診断で引っかかった」など\n（スキップしてもOKです）`

  await replyText(replyToken, msg, env.LINE_CHANNEL_ACCESS_TOKEN)
}

async function processGoal(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const goalSummary = text && text.length <= 200 ? text : null

  await saveProfileField(env.DB, userAccountId, { goal_summary: goalSummary })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'goal_summary', goalSummary ?? '')

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_concerns',
  })

  await replyWithQuickReplies(
    replyToken,
    `━━━━━━━━━━━━━━━\n【質問 8/9】\n気になることを教えてください。\n（複数回タップできます。最後に「次へ」を押してください）`,
    [
      { label: 'お腹まわり', text: 'お腹まわり' },
      { label: '体重が減らない', text: '体重が減らない' },
      { label: '食べすぎ', text: '食べすぎ' },
      { label: 'むくみ', text: 'むくみ' },
      { label: '運動不足', text: '運動不足' },
      { label: '次へ進む', text: '次へ' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function processConcerns(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  // 「次へ」「スキップ」以外はconcernsとして記録して、また同じ質問を返す
  const isNext = text ? ['次へ', 'next', '完了', 'done', 'スキップ'].some(kw => text.includes(kw)) : true

  if (!isNext && text) {
    // 現在のセッションのメタデータにタグを追加（簡易的にanswer累積）
    const existing = await env.DB.prepare(
      `SELECT answer_value FROM intake_answers WHERE user_account_id = ?1 AND question_key = 'concern_tags'`
    ).bind(userAccountId).first<{ answer_value: string }>()

    let tags: string[] = []
    if (existing?.answer_value) {
      try {
        const parsed = JSON.parse(existing.answer_value)
        tags = Array.isArray(parsed) ? parsed : []
      } catch {
        tags = []
      }
    }

    if (!tags.includes(text)) tags.push(text)

    await env.DB.prepare(`
      INSERT INTO intake_answers (id, user_account_id, intake_form_id, question_key, answer_value, answered_at)
      VALUES (?1, ?2, 'default_intake', 'concern_tags', ?3, ?4)
      ON CONFLICT(user_account_id, intake_form_id, question_key) DO UPDATE SET answer_value = ?3
    `).bind(generateId(), userAccountId, JSON.stringify(tags), nowIso()).run()

    await saveProfileField(env.DB, userAccountId, { concern_tags: JSON.stringify(tags) })

    await replyWithQuickReplies(
      replyToken,
      `「${text}」を追加しました✅\n他にも気になることがあればタップ、なければ「次へ進む」を押してください。`,
      [
        { label: 'お腹まわり', text: 'お腹まわり' },
        { label: '体重が減らない', text: '体重が減らない' },
        { label: '食べすぎ', text: '食べすぎ' },
        { label: 'むくみ', text: 'むくみ' },
        { label: '運動不足', text: '運動不足' },
        { label: '次へ進む', text: '次へ' },
      ],
      env.LINE_CHANNEL_ACCESS_TOKEN
    )
    return
  }

  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'intake',
    currentStep: 'intake_activity',
  })

  await replyWithQuickReplies(
    replyToken,
    `━━━━━━━━━━━━━━━\n【質問 9/9】\n普段の活動レベルを教えてください。`,
    [
      { label: '座り仕事中心', text: 'sedentary' },
      { label: '軽い運動あり', text: 'light' },
      { label: '週3〜5回運動', text: 'moderate' },
      { label: '毎日激しく運動', text: 'active' },
      { label: 'スキップ', text: 'スキップ' },
    ],
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

async function processActivity(
  replyToken: string,
  text: string | null,
  lineUserId: string,
  userAccountId: string,
  clientAccountId: string,
  env: Bindings
): Promise<void> {
  const validLevels = ['sedentary', 'light', 'moderate', 'active']
  const activityLevel = text && validLevels.includes(text)
    ? text as 'sedentary' | 'light' | 'moderate' | 'active'
    : null

  await saveProfileField(env.DB, userAccountId, { activity_level: activityLevel })
  await saveIntakeAnswer(env.DB, userAccountId, clientAccountId, 'activity_level', activityLevel ?? '')

  // インテーク完了フラグを設定
  // 正本キー: account_id + line_user_id（DDL: UNIQUE(account_id, line_user_id)）
  await env.DB.prepare(
    `UPDATE user_service_statuses SET intake_completed = 1, updated_at = ?1
     WHERE account_id = ?2 AND line_user_id = ?3`
  ).bind(nowIso(), clientAccountId, lineUserId).run()

  // モードをrecordに戻す
  await upsertModeSession(env.DB, {
    clientAccountId,
    lineUserId,
    currentMode: 'record',
    currentStep: 'idle',
  })

  // プロファイル情報を取得して完了メッセージを組み立て
  const profile = await env.DB.prepare(
    'SELECT * FROM user_profiles WHERE user_account_id = ?1'
  ).bind(userAccountId).first<Record<string, unknown>>()

  const nickname = (profile?.nickname as string) || 'あなた'
  const currentWeight = profile?.current_weight_kg as number | null
  const targetWeight = profile?.target_weight_kg as number | null

  let goalText = ''
  if (currentWeight && targetWeight) {
    const diff = Math.abs(currentWeight - targetWeight)
    goalText = `\n\n🎯 目標: ${currentWeight}kg → ${targetWeight}kg（${diff.toFixed(1)}kg減）`
  }

  await replyText(
    replyToken,
    `✨ ${nickname} さん、ご登録ありがとうございます！${goalText}\n\n━━━━━━━━━━━━━━━\nこれから一緒に頑張りましょう！💪\n\n【使い方】\n📝 毎日の体重・食事を記録\n💬「相談」と送ると相談モードに切替\n📷 食事の写真を送ると自動解析\n⚖️ 体重計の写真でも記録できます\n\n今日も記録をスタートしましょう！`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
}

// ===================================================================
// ヘルパー関数
// ===================================================================

/** saveProfileField で許可するカラム名（SQLインジェクション防止） */
const ALLOWED_PROFILE_COLUMNS = new Set([
  'nickname',
  'gender',
  'age_range',
  'height_cm',
  'current_weight_kg',
  'target_weight_kg',
  'goal_summary',
  'concern_tags',
  'activity_level',
])

/** user_profiles テーブルに部分更新 */
async function saveProfileField(
  db: D1Database,
  userAccountId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const now = nowIso()

  // まず upsert でレコードを確保
  await db.prepare(`
    INSERT OR IGNORE INTO user_profiles (id, user_account_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(generateId(), userAccountId, now, now).run()

  // 各フィールドを個別に更新（nullも含む）— allowlist で安全なカラムのみ許可
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ALLOWED_PROFILE_COLUMNS.has(key)) {
      await db.prepare(
        `UPDATE user_profiles SET ${key} = ?1, updated_at = ?2 WHERE user_account_id = ?3`
      ).bind(value, now, userAccountId).run()
    }
  }
}

/** intake_answers テーブルに回答を保存 */
async function saveIntakeAnswer(
  db: D1Database,
  userAccountId: string,
  _clientAccountId: string,
  questionKey: string,
  answerValue: string
): Promise<void> {
  const now = nowIso()
  await db.prepare(`
    INSERT INTO intake_answers (id, user_account_id, intake_form_id, question_key, answer_value, answered_at)
    VALUES (?1, ?2, 'default_intake', ?3, ?4, ?5)
    ON CONFLICT(user_account_id, intake_form_id, question_key)
    DO UPDATE SET answer_value = ?4, answered_at = ?5
  `).bind(generateId(), userAccountId, questionKey, answerValue, now).run()
}
