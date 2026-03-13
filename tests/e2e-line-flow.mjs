/**
 * E2E LINE 会話フロー テストスクリプト
 *
 * webhook エンドポイントに LINE 互換ペイロードを POST し、
 * DB 状態遷移を検証する。
 *
 * DB クエリは /api/test/query (HTTP) 経由で実行し、
 * wrangler のプロセス起動を避けて高速化。
 *
 * 実行: node tests/e2e-line-flow.mjs
 */

import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

// ===================================================================
// 定数
// ===================================================================

const BASE_URL = 'http://localhost:3000'
const WEBHOOK_PATH = '/api/webhooks/line'
const CHANNEL_SECRET = 'dummy_secret_for_local_dev'
const CLIENT_ACCOUNT_ID = 'acc_client_00000000000000000000000000000001'

// テスト結果
const results = []
let passCount = 0
let failCount = 0

// ===================================================================
// ヘルパー関数
// ===================================================================

function generateSignature(body, secret) {
  return crypto
    .createHmac('SHA256', secret)
    .update(body)
    .digest('base64')
}

let messageIdCounter = 100000

async function sendWebhookEvent(events, retries = 2) {
  const body = JSON.stringify({ destination: 'test', events })
  const signature = generateSignature(body, CHANNEL_SECRET)

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': signature,
        },
        body,
      })
      return { status: res.status, data: await res.json().catch(() => null) }
    } catch (err) {
      if (attempt < retries) {
        console.log(`    ⚠️ fetch error (retry ${attempt + 1}/${retries}): ${err.message}`)
        await sleep(2000)
      } else {
        console.error(`    ⚠️ fetch failed after ${retries} retries: ${err.message}`)
        return { status: 0, data: null }
      }
    }
  }
}

function makeFollowEvent(userId) {
  return {
    type: 'follow',
    timestamp: Date.now(),
    source: { type: 'user', userId },
    replyToken: `rt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    mode: 'active',
  }
}

function makeTextEvent(userId, text) {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId },
    replyToken: `rt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    mode: 'active',
    message: { id: `msg_${++messageIdCounter}`, type: 'text', text },
  }
}

function makeImageEvent(userId) {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId },
    replyToken: `rt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    mode: 'active',
    message: { id: `msg_img_${++messageIdCounter}`, type: 'image', contentProvider: { type: 'line' } },
  }
}

/** DB クエリ — HTTP 経由（高速） */
async function dbQuery(sql, params = []) {
  try {
    const res = await fetch(`${BASE_URL}/api/test/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    })
    const json = await res.json()
    if (json.error) {
      console.error(`  DB Query Error: ${json.error}`)
      return []
    }
    return json.results ?? []
  } catch (err) {
    console.error(`  DB Query Error: ${err.message}`)
    return []
  }
}

async function dbQueryFirst(sql, params = []) {
  const results = await dbQuery(sql, params)
  return results[0] ?? null
}

/** DB exec（INSERT/UPDATE/DELETE） */
async function dbExec(sql, params = []) {
  try {
    const res = await fetch(`${BASE_URL}/api/test/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    })
    return await res.json()
  } catch (err) {
    console.error(`  DB Exec Error: ${err.message}`)
    return { error: err.message }
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (condition) {
    passCount++
    results.push({ status: 'PASS', message })
    console.log(`    ✅ ${message}`)
  } else {
    failCount++
    results.push({ status: 'FAIL', message })
    console.log(`    ❌ ${message}`)
  }
}

// ===================================================================
// DB 初期化 (cleanup + seed)
// ===================================================================

async function seedDatabase() {
  console.log('📦 Seeding E2E test data...')

  // ---------------------------------------------------------------
  // 1. E2E テストデータの完全クリーンアップ
  //    FK 制約に対応した削除順（子テーブル→親テーブル）
  // ---------------------------------------------------------------
  const cleanupQueries = [
    // intake_answers（user_accounts FK）
    "DELETE FROM intake_answers WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%')",
    // user_profiles
    "DELETE FROM user_profiles WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%')",
    // body_metrics → daily_logs
    "DELETE FROM body_metrics WHERE daily_log_id IN (SELECT id FROM daily_logs WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%'))",
    // meal_entries → daily_logs
    "DELETE FROM meal_entries WHERE daily_log_id IN (SELECT id FROM daily_logs WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%'))",
    // daily_logs
    "DELETE FROM daily_logs WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%')",
    // conversation_messages → threads
    "DELETE FROM conversation_messages WHERE thread_id IN (SELECT id FROM conversation_threads WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%'))",
    // conversation_threads
    "DELETE FROM conversation_threads WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%')",
    // image_intake_results
    "DELETE FROM image_intake_results WHERE line_user_id LIKE 'U_e2e_%'",
    // bot_mode_sessions
    "DELETE FROM bot_mode_sessions WHERE line_user_id LIKE 'U_e2e_%'",
    // user_service_statuses
    "DELETE FROM user_service_statuses WHERE line_user_id LIKE 'U_e2e_%'",
    // progress_photos
    "DELETE FROM progress_photos WHERE user_account_id IN (SELECT id FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%')",
    // user_accounts
    "DELETE FROM user_accounts WHERE line_user_id LIKE 'U_e2e_%'",
    // invite_code_usages（line_user_id ベースとコードベースの両方）
    "DELETE FROM invite_code_usages WHERE line_user_id LIKE 'U_e2e_%'",
    "DELETE FROM invite_code_usages WHERE invite_code_id IN (SELECT id FROM invite_codes WHERE code LIKE 'TST-%')",
    // line_users
    "DELETE FROM line_users WHERE line_user_id LIKE 'U_e2e_%'",
    // invite_codes
    "DELETE FROM invite_codes WHERE code LIKE 'TST-%'",
  ]

  for (const q of cleanupQueries) {
    await dbExec(q)
  }
  console.log('  🧹 Cleanup done')

  // ---------------------------------------------------------------
  // 2. intake_forms の 'default_intake' レコードが必要（FK 制約）
  // ---------------------------------------------------------------
  await dbExec(
    `INSERT OR IGNORE INTO intake_forms (id, account_id, name, description, is_active, order_index, created_at, updated_at) VALUES ('default_intake', ?1, 'デフォルト初回問診', 'LINE BOT 初回ヒアリング（9問）', 1, 0, datetime('now'), datetime('now'))`,
    [CLIENT_ACCOUNT_ID]
  )
  console.log('  ✅ intake_forms default record ensured')

  // ---------------------------------------------------------------
  // 3. 招待コード挿入（HTTP 経由のみ — wrangler spawn を避ける）
  // ---------------------------------------------------------------
  const codes = [
    ['ic_e2e_001', 'TST-0001', 'E2E TC1'],
    ['ic_e2e_002', 'TST-0002', 'E2E TC2'],
    ['ic_e2e_003', 'TST-0003', 'E2E TC3'],
    ['ic_e2e_005', 'TST-0005', 'E2E TC5'],
    ['ic_e2e_006', 'TST-0006', 'E2E TC6'],
    ['ic_e2e_007', 'TST-0007', 'E2E TC7'],
    ['ic_e2e_008', 'TST-0008', 'E2E TC8'],
    ['ic_e2e_009', 'TST-0009', 'E2E TC9'],
  ]
  for (const [id, code, label] of codes) {
    await dbExec(
      `INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 'active', NULL, datetime('now'), datetime('now'))`,
      [id, code, CLIENT_ACCOUNT_ID, 'mem_admin_00000000000000000000000000000001', label]
    )
  }
  console.log('  ✅ Invite codes seeded')

  // 検証
  const icCount = await dbQuery("SELECT count(*) as cnt FROM invite_codes WHERE code LIKE 'TST-%'")
  console.log(`  📊 Invite codes in DB: ${icCount[0]?.cnt ?? 0}`)

  const ifCheck = await dbQueryFirst("SELECT id FROM intake_forms WHERE id = 'default_intake'")
  console.log(`  📊 intake_forms default_intake: ${ifCheck ? 'EXISTS' : 'MISSING!'}`)
  console.log()
}

// ===================================================================
// ヘルパー: 問診を完走させる（TC5-TC9 で共通利用）
// ===================================================================

async function completeIntake(userId, code, { nickname = '太郎', gender = '男性', ageRange = '30s', height = '170', currentWeight = '70', targetWeight = '60', goal = 'ダイエットしたい', activity = 'moderate' } = {}) {
  await sendWebhookEvent([makeFollowEvent(userId)])
  await sleep(500)
  await sendWebhookEvent([makeTextEvent(userId, code)])
  await sleep(800)

  const answers = [nickname, gender, ageRange, height, currentWeight, targetWeight, goal, '次へ', activity]
  for (const text of answers) {
    await sendWebhookEvent([makeTextEvent(userId, text)])
    await sleep(500)
  }
  await sleep(300)
}

// ===================================================================
// テストケース
// ===================================================================

async function tc1_newUserInviteCode() {
  console.log('\n' + '='.repeat(60))
  console.log('TC1: 新規ユーザーが未使用コードを入力→問診完走')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_001'

  // Step 1: follow event
  console.log('  Step 1: follow event')
  let res = await sendWebhookEvent([makeFollowEvent(userId)])
  assert(res.status === 200, 'follow event returns 200')
  await sleep(800)

  const lineUser = await dbQueryFirst(`SELECT * FROM line_users WHERE line_user_id = '${userId}'`)
  assert(lineUser !== null, 'line_users record created')

  // Step 2: invite code
  console.log('  Step 2: invite code TST-0001')
  res = await sendWebhookEvent([makeTextEvent(userId, 'TST-0001')])
  assert(res.status === 200, 'invite code event returns 200')
  await sleep(1000)

  const usage = await dbQueryFirst(`SELECT * FROM invite_code_usages WHERE line_user_id = '${userId}'`)
  assert(usage !== null, 'invite_code_usages record created')

  const uss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss !== null, 'user_service_statuses record created')
  assert(uss?.bot_enabled === 1, 'bot_enabled = 1')

  const session = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}'`)
  assert(session?.current_mode === 'intake', 'mode_session = intake')
  assert(session?.current_step === 'intake_nickname', 'step = intake_nickname (Q1)')

  // Step 3-12: 問診回答 Q1-Q9
  const intakeAnswers = [
    { text: 'テスト太郎', expectedStep: 'intake_gender' },
    { text: '男性', expectedStep: 'intake_age_range' },
    { text: '30s', expectedStep: 'intake_height' },
    { text: '170', expectedStep: 'intake_current_weight' },
    { text: '75', expectedStep: 'intake_target_weight' },
    { text: '65', expectedStep: 'intake_goal' },
    { text: '夏までに痩せたい', expectedStep: 'intake_concerns' },
    { text: 'お腹まわり', expectedStep: 'intake_concerns' },
    { text: '次へ', expectedStep: 'intake_activity' },
    { text: 'moderate', expectedStep: 'idle' },
  ]

  for (let i = 0; i < intakeAnswers.length; i++) {
    const { text, expectedStep } = intakeAnswers[i]
    const stepNum = i + 3
    console.log(`  Step ${stepNum}: Q answer "${text}"`)
    res = await sendWebhookEvent([makeTextEvent(userId, text)])
    assert(res.status === 200, `Q answer "${text}" returns 200`)
    await sleep(600)

    const s = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}'`)
    if (expectedStep === 'idle') {
      // 問診完了後はセッションが record になるか削除されている
      const mode = s?.current_mode
      assert(mode === 'record' || mode === undefined || s === null, `after Q9: mode = record or session cleared (actual: ${mode})`)
    } else {
      assert(s?.current_step === expectedStep, `step advanced to ${expectedStep} (actual: ${s?.current_step})`)
    }
  }

  // 最終確認
  const finalUss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(finalUss?.intake_completed === 1, 'intake_completed = 1')

  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)
  if (ua) {
    const profile = await dbQueryFirst(`SELECT * FROM user_profiles WHERE user_account_id = '${ua.id}'`)
    assert(profile?.nickname === 'テスト太郎', 'profile.nickname = テスト太郎')
    assert(profile?.gender === 'male', 'profile.gender = male')
    assert(profile?.height_cm === 170, 'profile.height_cm = 170')
    assert(profile?.current_weight_kg === 75, 'profile.current_weight_kg = 75')
    assert(profile?.target_weight_kg === 65, 'profile.target_weight_kg = 65')
    assert(profile?.activity_level === 'moderate', 'profile.activity_level = moderate')

    const answers = await dbQuery(`SELECT * FROM intake_answers WHERE user_account_id = '${ua.id}'`)
    assert(answers.length >= 9, `intake_answers count >= 9 (actual: ${answers.length})`)
  } else {
    assert(false, 'user_accounts record should exist')
  }

  const ic = await dbQueryFirst(`SELECT * FROM invite_codes WHERE code = 'TST-0001'`)
  assert(ic?.use_count === 1, 'invite_codes.use_count = 1')
}

async function tc2_intakeResumeAfterDropout() {
  console.log('\n' + '='.repeat(60))
  console.log('TC2: 問診途中離脱→コード再送→途中から再開')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_002'

  await sendWebhookEvent([makeFollowEvent(userId)])
  await sleep(500)
  await sendWebhookEvent([makeTextEvent(userId, 'TST-0002')])
  await sleep(800)

  // Q1-Q3
  await sendWebhookEvent([makeTextEvent(userId, 'テスト花子')])
  await sleep(500)
  await sendWebhookEvent([makeTextEvent(userId, '女性')])
  await sleep(500)
  await sendWebhookEvent([makeTextEvent(userId, '20s')])
  await sleep(500)

  const sessionBefore = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}'`)
  assert(sessionBefore?.current_step === 'intake_height', 'before dropout: step = intake_height (Q4)')

  // Resend code
  console.log('  Resend code TST-0002 after dropout')
  await sendWebhookEvent([makeTextEvent(userId, 'TST-0002')])
  await sleep(800)

  const sessionAfter = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}'`)
  assert(
    sessionAfter?.current_step === 'intake_height',
    `after resend: step = intake_height (actual: ${sessionAfter?.current_step})`
  )

  // Continue Q4-Q9
  console.log('  Continue from Q4 to Q9')
  for (const text of ['160', '55', '50', '健康になりたい', '次へ', 'light']) {
    await sendWebhookEvent([makeTextEvent(userId, text)])
    await sleep(500)
  }

  const finalUss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(finalUss?.intake_completed === 1, 'TC2: intake_completed = 1 after resume')
}

async function tc3_completedUserResendCode() {
  console.log('\n' + '='.repeat(60))
  console.log('TC3: 問診完了後同じコード再送→使い方ガイド')
  console.log('='.repeat(60))

  // TC1 で問診完了した U_e2e_user_001 を再利用
  const userId = 'U_e2e_user_001'

  const beforeUsages = await dbQuery(`SELECT * FROM invite_code_usages WHERE line_user_id = '${userId}'`)

  console.log('  Resend code TST-0001')
  const res = await sendWebhookEvent([makeTextEvent(userId, 'TST-0001')])
  assert(res.status === 200, 'resend returns 200')
  await sleep(500)

  const afterUsages = await dbQuery(`SELECT * FROM invite_code_usages WHERE line_user_id = '${userId}'`)
  assert(afterUsages.length === beforeUsages.length, 'invite_code_usages count unchanged')

  const uss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss?.intake_completed === 1, 'intake_completed still 1')
}

async function tc4_differentUserUsedCode() {
  console.log('\n' + '='.repeat(60))
  console.log('TC4: 別ユーザーが使用済みコードを入力→使用上限エラー')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_004'

  await sendWebhookEvent([makeFollowEvent(userId)])
  await sleep(500)

  console.log('  Send exhausted code TST-0001')
  const res = await sendWebhookEvent([makeTextEvent(userId, 'TST-0001')])
  assert(res.status === 200, 'exhausted code event returns 200')
  await sleep(500)

  const usage = await dbQueryFirst(`SELECT * FROM invite_code_usages WHERE line_user_id = '${userId}'`)
  assert(usage === null, 'no invite_code_usages for new user')

  const uss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss === null || uss?.intake_completed === 0, 'intake_completed = 0 or no record')
}

async function tc5_weightEntry() {
  console.log('\n' + '='.repeat(60))
  console.log('TC5: 体重 65.5kg 送信→body_metrics 反映')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_005'

  // setup: 問診完走
  console.log('  Setup: completing intake...')
  await completeIntake(userId, 'TST-0005')

  const uss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss?.intake_completed === 1, 'TC5 setup: intake_completed = 1')

  // 体重記録
  console.log('  Send weight: 65.5kg')
  const res = await sendWebhookEvent([makeTextEvent(userId, '65.5kg')])
  assert(res.status === 200, 'weight event returns 200')
  await sleep(800)

  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)
  if (ua) {
    const bm = await dbQuery(`SELECT bm.* FROM body_metrics bm JOIN daily_logs dl ON dl.id = bm.daily_log_id WHERE dl.user_account_id = '${ua.id}' ORDER BY bm.created_at DESC`)
    const latestWeight = bm[0]?.weight_kg
    assert(latestWeight === 65.5, `body_metrics.weight_kg = 65.5 (actual: ${latestWeight})`)

    const dl = await dbQueryFirst(`SELECT * FROM daily_logs WHERE user_account_id = '${ua.id}'`)
    assert(dl !== null, 'daily_logs record exists')
  } else {
    assert(false, 'user_accounts record should exist')
  }
}

async function tc6_imageConfirm() {
  console.log('\n' + '='.repeat(60))
  console.log('TC6: 食事写真→解析→確定→meal_entries 登録')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_006'

  // setup: 問診完走
  console.log('  Setup: completing intake...')
  await completeIntake(userId, 'TST-0006', { nickname: '花子', gender: '女性', ageRange: '20s', height: '160', currentWeight: '55', targetWeight: '48' })

  const uss = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss?.intake_completed === 1, 'TC6 setup: intake_completed = 1')

  // Simulate pending image confirm via DB
  // FK チェーン: image_intake_results → message_attachments → conversation_messages → conversation_threads
  console.log('  Simulating pending_image_confirm state via DB')
  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)

  if (ua) {
    const intakeResultId = 'iir_e2e_tc6_001'
    const msgId = 'cm_e2e_tc6_001'
    const maId = 'ma_e2e_tc6_001'
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    // 1. conversation_thread を取得（completeIntake で作成済み）
    const thread = await dbQueryFirst(`SELECT id FROM conversation_threads WHERE user_account_id = '${ua.id}' LIMIT 1`)

    // 2. conversation_messages にダミー画像メッセージを作成
    if (thread) {
      await dbExec(
        `INSERT OR IGNORE INTO conversation_messages (id, thread_id, sender_type, line_message_id, message_type, raw_text, mode_at_send, sent_at, created_at)
         VALUES (?1, ?2, 'user', 'lm_e2e_tc6', 'image', NULL, 'record', ?3, ?3)`,
        [msgId, thread.id, now]
      )

      // 3. message_attachments にダミー添付ファイルを作成
      await dbExec(
        `INSERT OR IGNORE INTO message_attachments (id, message_id, storage_provider, storage_key, content_type, created_at)
         VALUES (?1, ?2, 'r2', 'e2e/tc6/test.jpg', 'image/jpeg', ?3)`,
        [maId, msgId, now]
      )
    }

    const proposedAction = JSON.stringify({
      action: 'create_or_update_meal_entry',
      meal_type: 'lunch',
      meal_text: 'テスト昼食（サラダチキン、白米、味噌汁）',
      calories_kcal: 550,
      protein_g: 35,
      fat_g: 12,
      carbs_g: 65,
      user_account_id: ua.id,
      client_account_id: CLIENT_ACCOUNT_ID,
    })

    // 4. image_intake_results に pending レコード作成
    await dbExec(
      `INSERT OR IGNORE INTO image_intake_results (id, message_attachment_id, user_account_id, line_user_id, image_category, confidence_score, extracted_json, proposed_action_json, applied_flag, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'meal_photo', 0.95, '{}', ?5, 0, datetime('now', '+24 hours'), ?6)`,
      [intakeResultId, maId, ua.id, userId, proposedAction, now]
    )

    // 5. bot_mode_sessions を pending_image_confirm に設定
    const sessionData = JSON.stringify({ intakeResultId, category: 'meal_photo' })
    await dbExec(
      `INSERT OR REPLACE INTO bot_mode_sessions (id, client_account_id, line_user_id, current_mode, current_step, session_data, turn_count, expires_at, created_at, updated_at)
       VALUES ('bms_e2e_tc6', ?1, ?2, 'record', 'pending_image_confirm', ?3, 0, datetime('now', '+24 hours'), ?4, ?5)`,
      [CLIENT_ACCOUNT_ID, userId, sessionData, now, now]
    )

    // 検証: image_intake_results が正しく挿入されたか
    const iirBefore = await dbQueryFirst(`SELECT id, applied_flag FROM image_intake_results WHERE id = '${intakeResultId}'`)
    if (!iirBefore) {
      console.log('    ⚠️ image_intake_results INSERT failed (FK constraint?)')
    }

    console.log('  Send: 確定')
    const res = await sendWebhookEvent([makeTextEvent(userId, '確定')])
    assert(res.status === 200, 'confirm event returns 200')
    await sleep(1000)

    const iir = await dbQueryFirst(`SELECT * FROM image_intake_results WHERE id = '${intakeResultId}'`)
    assert(iir?.applied_flag === 1, `image_intake_results.applied_flag = 1 (actual: ${iir?.applied_flag})`)

    const dailyLog = await dbQueryFirst(`SELECT * FROM daily_logs WHERE user_account_id = '${ua.id}'`)
    if (dailyLog) {
      const me = await dbQueryFirst(`SELECT * FROM meal_entries WHERE daily_log_id = '${dailyLog.id}' AND confirmation_status = 'confirmed'`)
      assert(me !== null, 'meal_entries confirmed record exists')
      if (me) {
        assert(me.calories_kcal === 550, `meal_entries.calories_kcal = 550 (actual: ${me.calories_kcal})`)
      }
    } else {
      assert(false, 'daily_logs record should exist for meal confirmation')
    }

    const pendingSession = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}' AND current_step = 'pending_image_confirm'`)
    assert(pendingSession === null, 'pending_image_confirm session cleared')
  } else {
    assert(false, 'user_accounts record should exist')
  }
}

async function tc7_imageCancel() {
  console.log('\n' + '='.repeat(60))
  console.log('TC7: 食事写真→解析→取消→pending 削除')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_007'

  // setup: 問診完走
  console.log('  Setup: completing intake...')
  await completeIntake(userId, 'TST-0007', { nickname: '次郎', ageRange: '40s', height: '175', currentWeight: '80', targetWeight: '70', activity: 'sedentary' })

  // Simulate pending image confirm via DB
  // FK チェーン: image_intake_results → message_attachments → conversation_messages → conversation_threads
  console.log('  Simulating pending_image_confirm state')
  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)
  if (ua) {
    const intakeResultId = 'iir_e2e_tc7_001'
    const msgId = 'cm_e2e_tc7_001'
    const maId = 'ma_e2e_tc7_001'
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    // 1. conversation_thread を取得
    const thread = await dbQueryFirst(`SELECT id FROM conversation_threads WHERE user_account_id = '${ua.id}' LIMIT 1`)

    // 2. conversation_messages にダミー画像メッセージを作成
    if (thread) {
      await dbExec(
        `INSERT OR IGNORE INTO conversation_messages (id, thread_id, sender_type, line_message_id, message_type, raw_text, mode_at_send, sent_at, created_at)
         VALUES (?1, ?2, 'user', 'lm_e2e_tc7', 'image', NULL, 'record', ?3, ?3)`,
        [msgId, thread.id, now]
      )

      // 3. message_attachments にダミー添付ファイルを作成
      await dbExec(
        `INSERT OR IGNORE INTO message_attachments (id, message_id, storage_provider, storage_key, content_type, created_at)
         VALUES (?1, ?2, 'r2', 'e2e/tc7/test.jpg', 'image/jpeg', ?3)`,
        [maId, msgId, now]
      )
    }

    const proposedAction = JSON.stringify({
      action: 'create_or_update_meal_entry',
      meal_type: 'dinner',
      meal_text: 'テスト夕食',
      calories_kcal: 700,
      protein_g: 30,
      fat_g: 25,
      carbs_g: 80,
      user_account_id: ua.id,
      client_account_id: CLIENT_ACCOUNT_ID,
    })

    // 4. image_intake_results に pending レコード作成
    await dbExec(
      `INSERT OR IGNORE INTO image_intake_results (id, message_attachment_id, user_account_id, line_user_id, image_category, confidence_score, extracted_json, proposed_action_json, applied_flag, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'meal_photo', 0.90, '{}', ?5, 0, datetime('now', '+24 hours'), ?6)`,
      [intakeResultId, maId, ua.id, userId, proposedAction, now]
    )

    // 5. bot_mode_sessions を pending_image_confirm に設定
    const sessionData = JSON.stringify({ intakeResultId, category: 'meal_photo' })
    await dbExec(
      `INSERT OR REPLACE INTO bot_mode_sessions (id, client_account_id, line_user_id, current_mode, current_step, session_data, turn_count, expires_at, created_at, updated_at)
       VALUES ('bms_e2e_tc7', ?1, ?2, 'record', 'pending_image_confirm', ?3, 0, datetime('now', '+24 hours'), ?4, ?5)`,
      [CLIENT_ACCOUNT_ID, userId, sessionData, now, now]
    )

    console.log('  Send: 取消')
    const res = await sendWebhookEvent([makeTextEvent(userId, '取消')])
    assert(res.status === 200, 'cancel event returns 200')
    await sleep(1000)

    const iir = await dbQueryFirst(`SELECT * FROM image_intake_results WHERE id = '${intakeResultId}'`)
    assert(iir?.applied_flag === 2, `image_intake_results.applied_flag = 2 (discarded) (actual: ${iir?.applied_flag})`)

    const dailyLog = await dbQueryFirst(`SELECT * FROM daily_logs WHERE user_account_id = '${ua.id}'`)
    if (dailyLog) {
      const confirmedMeals = await dbQuery(`SELECT * FROM meal_entries WHERE daily_log_id = '${dailyLog.id}' AND confirmation_status = 'confirmed'`)
      assert(confirmedMeals.length === 0, 'no confirmed meal_entries after cancel')
    } else {
      assert(true, 'no daily_log means no meal entry (correct)')
    }

    const pendingSession = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}' AND current_step = 'pending_image_confirm'`)
    assert(pendingSession === null, 'pending session cleared after cancel')
  } else {
    assert(false, 'user_accounts record should exist')
  }
}

async function tc8_consultMode() {
  console.log('\n' + '='.repeat(60))
  console.log('TC8: 相談モード→質問→AI応答→記録モード戻り')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_008'

  // setup: 問診完走
  console.log('  Setup: completing intake...')
  await completeIntake(userId, 'TST-0008', { nickname: '三郎', height: '175', currentWeight: '80', targetWeight: '70' })

  // 相談モードに切替
  console.log('  Send: 相談モード')
  let res = await sendWebhookEvent([makeTextEvent(userId, '相談モード')])
  assert(res.status === 200, 'consult mode switch returns 200')
  await sleep(600)

  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)
  if (ua) {
    const thread = await dbQueryFirst(`SELECT * FROM conversation_threads WHERE user_account_id = '${ua.id}' ORDER BY updated_at DESC LIMIT 1`)
    assert(thread?.current_mode === 'consult', `thread.current_mode = consult (actual: ${thread?.current_mode})`)
  }

  // 相談テキスト送信（AI失敗してもDB遷移を検証）
  console.log('  Send: consult question')
  res = await sendWebhookEvent([makeTextEvent(userId, 'ダイエット中に間食していいですか？')])
  assert(res.status === 200, 'consult question returns 200')
  await sleep(2000) // AI応答を待つ

  if (ua) {
    const msgs = await dbQuery(`SELECT * FROM conversation_messages WHERE thread_id IN (SELECT id FROM conversation_threads WHERE user_account_id = '${ua.id}') AND sender_type = 'user' AND raw_text LIKE '%間食%'`)
    assert(msgs.length > 0, 'consult question saved in conversation_messages')
  }

  // 記録モードに戻す
  console.log('  Send: 記録モード')
  res = await sendWebhookEvent([makeTextEvent(userId, '記録モード')])
  assert(res.status === 200, 'record mode switch returns 200')
  await sleep(600)

  if (ua) {
    const thread = await dbQueryFirst(`SELECT * FROM conversation_threads WHERE user_account_id = '${ua.id}' ORDER BY updated_at DESC LIMIT 1`)
    assert(thread?.current_mode === 'record', `thread.current_mode = record after switch back (actual: ${thread?.current_mode})`)
  }
}

async function tc9_richMenuButtons() {
  console.log('\n' + '='.repeat(60))
  console.log('TC9: Rich Menu 6ボタン全操作フロー')
  console.log('='.repeat(60))

  const userId = 'U_e2e_user_009'

  // setup: 問診完走
  console.log('  Setup: completing intake...')
  await completeIntake(userId, 'TST-0009', { nickname: '四郎', currentWeight: '70', targetWeight: '60' })

  const uss0 = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(uss0?.intake_completed === 1, 'TC9 setup: intake_completed = 1')

  // Button 1: 記録モード
  console.log('  Button 1: 記録モード')
  let res = await sendWebhookEvent([makeTextEvent(userId, '記録モード')])
  assert(res.status === 200, 'btn1 記録モード returns 200')
  await sleep(400)

  // Button 2: 写真を送る
  console.log('  Button 2: 写真を送る')
  res = await sendWebhookEvent([makeTextEvent(userId, '写真を送る')])
  assert(res.status === 200, 'btn2 写真を送る returns 200')
  await sleep(400)

  // Button 3: 体重記録
  console.log('  Button 3: 体重記録')
  res = await sendWebhookEvent([makeTextEvent(userId, '体重記録')])
  assert(res.status === 200, 'btn3 体重記録 returns 200')
  await sleep(400)

  // Button 4: 相談モード
  console.log('  Button 4: 相談モード')
  res = await sendWebhookEvent([makeTextEvent(userId, '相談モード')])
  assert(res.status === 200, 'btn4 相談モード returns 200')
  await sleep(500)

  const ua = await dbQueryFirst(`SELECT id FROM user_accounts WHERE line_user_id = '${userId}'`)
  if (ua) {
    const thread = await dbQueryFirst(`SELECT * FROM conversation_threads WHERE user_account_id = '${ua.id}' ORDER BY updated_at DESC LIMIT 1`)
    assert(thread?.current_mode === 'consult', 'after btn4: thread mode = consult')
  }

  // Button 5: ダッシュボード (URI action - skip)
  console.log('  Button 5: ダッシュボード (URI action - skipped)')
  assert(true, 'btn5 ダッシュボード is URI action (no webhook test)')

  // record に戻す
  await sendWebhookEvent([makeTextEvent(userId, '記録モード')])
  await sleep(400)

  // Button 6: 問診やり直し
  console.log('  Button 6: 問診やり直し')
  res = await sendWebhookEvent([makeTextEvent(userId, '問診やり直し')])
  assert(res.status === 200, 'btn6 問診やり直し returns 200')
  await sleep(600)

  const ussAfter = await dbQueryFirst(`SELECT * FROM user_service_statuses WHERE line_user_id = '${userId}'`)
  assert(ussAfter?.intake_completed === 0, 'after 問診やり直し: intake_completed = 0')

  const session = await dbQueryFirst(`SELECT * FROM bot_mode_sessions WHERE line_user_id = '${userId}'`)
  assert(session?.current_mode === 'intake', 'after 問診やり直し: mode = intake')
  assert(session?.current_step === 'intake_nickname', 'after 問診やり直し: step = intake_nickname (Q1)')
}

// ===================================================================
// メイン
// ===================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     E2E LINE 会話フロー テスト                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // サーバー稼働チェック
  try {
    const healthRes = await fetch(`${BASE_URL}/api/health`)
    if (healthRes.status !== 200) throw new Error(`status ${healthRes.status}`)
  } catch (e) {
    console.error(`❌ Server not running at ${BASE_URL}: ${e.message}`)
    console.error('   Run: cd /home/user/webapp && npm run build && pm2 restart all')
    process.exit(1)
  }
  console.log(`✅ Server running at ${BASE_URL}`)

  // テスト API チェック
  try {
    const testRes = await fetch(`${BASE_URL}/api/test/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1 as test' }),
    })
    const testJson = await testRes.json()
    if (testJson.error) throw new Error(testJson.error)
    console.log('✅ Test query API available')
  } catch (e) {
    console.error(`❌ Test query API not available: ${e.message}`)
    console.error('   Ensure APP_ENV=development and rebuild')
    process.exit(1)
  }

  // DB シード
  await seedDatabase()

  const startTime = Date.now()

  // テスト実行
  await tc1_newUserInviteCode()
  await tc2_intakeResumeAfterDropout()
  await tc3_completedUserResendCode()
  await tc4_differentUserUsedCode()
  await tc5_weightEntry()
  await tc6_imageConfirm()
  await tc7_imageCancel()
  await tc8_consultMode()
  await tc9_richMenuButtons()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // サマリー
  console.log('\n' + '='.repeat(60))
  console.log('テスト結果サマリー')
  console.log('='.repeat(60))
  console.log(`  合計: ${passCount + failCount}`)
  console.log(`  ✅ PASS: ${passCount}`)
  console.log(`  ❌ FAIL: ${failCount}`)
  console.log(`  ⏱  所要時間: ${elapsed}s`)
  console.log()

  if (failCount > 0) {
    console.log('❌ 失敗したテスト:')
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    - ${r.message}`)
    })
    console.log()
  }

  console.log(failCount === 0 ? '🎉 全テスト PASS！本番デプロイ可能' : '⚠️ 一部テスト失敗。修正が必要です')
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
