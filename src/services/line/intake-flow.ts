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
// 問診フロー開始
// ===================================================================

/** 問診を開始してニックネームを聞く */
export async function startIntakeFlow(
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
    `ようこそ！🌿 diet-bot へ！\n\nはじめに簡単なご登録（10問ほど）をお願いします。\n※いつでも「スキップ」と送れば省略できます。\n\n━━━━━━━━━━━━━━━\n【質問 1/9】\nお名前（ニックネームでOK）を教えてください！`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  )
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
  await env.DB.prepare(
    `UPDATE user_service_statuses SET intake_completed = 1, updated_at = ?1
     WHERE user_account_id = ?2 AND account_id = ?3`
  ).bind(nowIso(), userAccountId, clientAccountId).run()

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

  // 各フィールドを個別に更新（nullも含む）
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
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
