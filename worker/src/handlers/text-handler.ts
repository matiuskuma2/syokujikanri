/**
 * worker/src/handlers/text-handler.ts
 * テキストメッセージハンドラ
 *
 * State Machine の S0 (idle/record) と S1 (consult) での処理
 * 1. キーワードショートカット（モード切替）
 * 2. AI 意図分類（classifier）
 * 3. 意図に応じた処理 + 応答生成（responder）
 * 4. outbox + push 送信
 */

import type { WorkerEnv, RuntimeState } from '../types'
import { classifyIntent, type ClassifiedIntent } from '../ai/classifier'
import { generateConsultResponse } from '../ai/responder'
import { updateRuntimeState } from '../state/runtime-state'
import { sendPushText } from '../send/push-sender'

// === Quick Reply 定義 ===
const RECORD_QUICK_REPLIES = [
  { label: '📝 続けて記録', text: '記録する' },
  { label: '💬 相談する', text: '相談する' },
]

const CONSULT_QUICK_REPLIES = [
  { label: '💬 続けて相談', text: '相談する' },
  { label: '📝 記録する', text: '記録する' },
]

const MODE_SWITCH_CONSULT_REPLY = '💬 相談モードに切り替えました。\n何でもご相談ください！'
const MODE_SWITCH_RECORD_REPLY = '📝 記録モードに切り替えました。\n食事内容や体重を送ってください。'

/**
 * テキストメッセージを処理する
 */
export async function handleTextMessage(
  text: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  // --- 1. キーワードショートカット ---
  const shortcutResult = checkKeywordShortcut(text)
  if (shortcutResult) {
    await handleModeSwitch(shortcutResult, lineUserId, userAccountId, state, env, eventId)
    return
  }

  // --- 2. AI 意図分類 ---
  const recentMsgs = await getRecentMessages(env.DB, userAccountId, 5)
  const intent = await classifyIntent(text, env, {
    currentMode: state.current_mode,
    recentMessages: recentMsgs,
  })

  console.log(`[TextHandler] classified: "${text}" → ${intent.primary} (conf=${intent.confidence})`)

  // --- 3. 意図に応じた処理 ---
  switch (intent.primary) {
    case 'switch_consult':
      await handleModeSwitch('consult', lineUserId, userAccountId, state, env, eventId)
      break

    case 'switch_record':
      await handleModeSwitch('record', lineUserId, userAccountId, state, env, eventId)
      break

    case 'consult':
      await handleConsult(text, lineUserId, userAccountId, state, env, eventId)
      break

    case 'record_meal':
      await handleRecordMeal(text, intent, lineUserId, userAccountId, state, env, eventId)
      break

    case 'record_weight':
      await handleRecordWeight(text, intent, lineUserId, userAccountId, state, env, eventId)
      break

    case 'greeting':
      await sendPushText(
        env, lineUserId, userAccountId,
        'こんにちは！🎉\n食事記録や体重記録、ダイエットの相談ができます。\n何でもお気軽にどうぞ！',
        eventId,
        [
          { label: '📝 記録する', text: '記録する' },
          { label: '💬 相談する', text: '相談する' },
        ]
      )
      break

    case 'trigger_intake':
      // TODO: Phase 2 で問診フロー実装
      await sendPushText(env, lineUserId, userAccountId,
        '📋 問診を開始します。（この機能は準備中です）',
        eventId
      )
      break

    default:
      // 現在のモードに応じてデフォルト処理
      if (state.current_mode === 'consult') {
        await handleConsult(text, lineUserId, userAccountId, state, env, eventId)
      } else {
        // record モードでの不明テキスト → 食事記録として試みる
        if (text.length > 2) {
          await handleRecordMeal(text, intent, lineUserId, userAccountId, state, env, eventId)
        } else {
          await sendPushText(
            env, lineUserId, userAccountId,
            '📝 食事記録: 食べた物をテキストで送信\n📸 写真記録: 食事の写真を送信\n⚖️ 体重記録: 体重を送信 (例: 58.5kg)\n💬 相談: 「相談する」でモード切替',
            eventId,
            [
              { label: '📝 記録する', text: '記録する' },
              { label: '💬 相談する', text: '相談する' },
            ]
          )
        }
      }
  }
}

// === 内部関数 ===

type ModeSwitchTarget = 'consult' | 'record'

function checkKeywordShortcut(text: string): ModeSwitchTarget | null {
  const t = text.trim()
  const consultKws = ['相談する', '相談モード', '💬 相談する', '相談にして', '相談続ける']
  const recordKws = ['記録する', '記録モード', '📝 記録する', '📝 続けて記録', '記録にして', '戻る']

  if (consultKws.includes(t)) return 'consult'
  if (recordKws.includes(t)) return 'record'
  return null
}

async function handleModeSwitch(
  target: ModeSwitchTarget,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  if (target === 'consult') {
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      currentMode: 'consult',
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })
    await sendPushText(env, lineUserId, userAccountId, MODE_SWITCH_CONSULT_REPLY, eventId, CONSULT_QUICK_REPLIES)
  } else {
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      currentMode: 'record',
      waitingType: null,
      waitingTargetId: null,
      waitingExpiresAt: null,
    })
    await sendPushText(env, lineUserId, userAccountId, MODE_SWITCH_RECORD_REPLY, eventId, RECORD_QUICK_REPLIES)
  }
}

async function handleConsult(
  text: string,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  // モードが record なら consult に切り替え
  if (state.current_mode !== 'consult') {
    await updateRuntimeState(env.DB, userAccountId, state.version, {
      currentMode: 'consult',
    })
    // version を再ロード
    state = { ...state, version: state.version + 1, current_mode: 'consult' }
  }

  // 会話履歴を取得
  const recentMsgs = await getRecentConversationHistory(env.DB, userAccountId, 10)

  // システムプロンプト取得
  const sysPrompt = await getSystemPrompt(env.DB, state.client_account_id)

  // ユーザーコンテキスト構築
  const userCtx = await buildUserContext(env.DB, userAccountId)

  // メモリ取得
  const memories = await getActiveMemories(env.DB, userAccountId)

  // ナレッジ検索
  const knowledgeDocs = await searchKnowledge(env.DB, state.client_account_id, text)

  // AI 応答生成
  const response = await generateConsultResponse(text, env, {
    systemPrompt: sysPrompt,
    recentMessages: recentMsgs,
    userContext: userCtx,
    memories,
    knowledgeDocs,
  })

  // 会話履歴に保存
  await saveConversationMessage(env.DB, userAccountId, lineUserId, 'user', text)
  await saveConversationMessage(env.DB, userAccountId, lineUserId, 'bot', response)

  // push 送信
  await sendPushText(env, lineUserId, userAccountId, response, eventId, CONSULT_QUICK_REPLIES)
}

async function handleRecordMeal(
  text: string,
  intent: ClassifiedIntent,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  // Phase 1: 簡易的なテキスト記録
  // Phase 2 で record-persister のフルロジックを移植する
  try {
    const foodDesc = intent.food_description || text
    const todayStr = getTodayJST()
    const targetDate = intent.target_date || todayStr
    const mealType = intent.meal_type || guessMealType()

    // AI で栄養推定
    const nutrition = await estimateNutrition(foodDesc, env)

    // DB 保存: daily_logs → meal_entries
    const dailyLogId = await ensureDailyLog(env.DB, userAccountId, targetDate)
    const mealEntryId = await createMealEntry(env.DB, {
      dailyLogId,
      userAccountId,
      mealType,
      description: foodDesc,
      calories: nutrition.calories,
      protein: nutrition.protein,
      fat: nutrition.fat,
      carbs: nutrition.carbs,
      sourceType: 'text',
    })

    // 会話履歴に保存
    await saveConversationMessage(env.DB, userAccountId, lineUserId, 'user', text)

    const mealTypeJa = { breakfast: '朝食', lunch: '昼食', snack: '間食', dinner: '夕食', night_snack: '夜食' }[mealType] || mealType
    const reply = `✅ ${mealTypeJa}を記録しました！\n\n🍽 ${foodDesc}\n🔥 ${nutrition.calories} kcal\n🥩 P ${nutrition.protein}g | 🧈 F ${nutrition.fat}g | 🍚 C ${nutrition.carbs}g`

    await saveConversationMessage(env.DB, userAccountId, lineUserId, 'bot', reply)
    await sendPushText(env, lineUserId, userAccountId, reply, eventId, RECORD_QUICK_REPLIES)

  } catch (err) {
    console.error('[TextHandler] record_meal error:', err)
    await sendPushText(
      env, lineUserId, userAccountId,
      '⚠️ 食事記録の保存中にエラーが発生しました。もう一度お試しください。',
      eventId
    )
  }
}

async function handleRecordWeight(
  text: string,
  intent: ClassifiedIntent,
  lineUserId: string,
  userAccountId: string,
  state: RuntimeState,
  env: WorkerEnv,
  eventId: string | null
): Promise<void> {
  try {
    let weight = intent.weight_value
    if (!weight) {
      // テキストから体重を抽出
      const match = text.match(/(\d+\.?\d*)\s*(kg|キロ)?/i)
      weight = match ? parseFloat(match[1]) : null
    }

    if (!weight || weight < 20 || weight > 300) {
      await sendPushText(env, lineUserId, userAccountId,
        '⚠️ 体重の値を読み取れませんでした。\n例: 「58.5kg」のように送信してください。',
        eventId
      )
      return
    }

    const todayStr = getTodayJST()
    const dailyLogId = await ensureDailyLog(env.DB, userAccountId, todayStr)

    // body_metrics に保存
    await env.DB.prepare(`
      INSERT INTO body_metrics (id, daily_log_id, user_account_id, metric_date, weight_kg, source_type, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'manual', datetime('now'), datetime('now'))
      ON CONFLICT(daily_log_id, user_account_id)
      DO UPDATE SET weight_kg = ?5, updated_at = datetime('now')
    `).bind(crypto.randomUUID(), dailyLogId, userAccountId, todayStr, weight).run()

    await saveConversationMessage(env.DB, userAccountId, lineUserId, 'user', text)

    const reply = `✅ 体重を記録しました！\n\n⚖️ ${weight} kg (${todayStr})`
    await saveConversationMessage(env.DB, userAccountId, lineUserId, 'bot', reply)
    await sendPushText(env, lineUserId, userAccountId, reply, eventId, RECORD_QUICK_REPLIES)

  } catch (err) {
    console.error('[TextHandler] record_weight error:', err)
    await sendPushText(
      env, lineUserId, userAccountId,
      '⚠️ 体重記録の保存中にエラーが発生しました。もう一度お試しください。',
      eventId
    )
  }
}

// === DB ヘルパー関数 ===

async function getRecentMessages(db: D1Database, userAccountId: string, limit: number): Promise<string[]> {
  try {
    const rows = await db.prepare(`
      SELECT cm.sender_type, cm.content
      FROM conversation_messages cm
      JOIN conversation_threads ct ON ct.id = cm.thread_id
      WHERE ct.user_account_id = ?1 AND cm.message_type = 'text'
      ORDER BY cm.created_at DESC
      LIMIT ?2
    `).bind(userAccountId, limit).all<{ sender_type: string; content: string }>()

    return (rows.results ?? []).reverse().map(r =>
      `[${r.sender_type === 'user' ? 'ユーザー' : 'BOT'}] ${r.content}`
    )
  } catch { return [] }
}

async function getRecentConversationHistory(
  db: D1Database, userAccountId: string, limit: number
): Promise<{ role: string; text: string }[]> {
  try {
    const rows = await db.prepare(`
      SELECT cm.sender_type, cm.content
      FROM conversation_messages cm
      JOIN conversation_threads ct ON ct.id = cm.thread_id
      WHERE ct.user_account_id = ?1 AND cm.message_type = 'text'
      ORDER BY cm.created_at DESC
      LIMIT ?2
    `).bind(userAccountId, limit).all<{ sender_type: string; content: string }>()

    return (rows.results ?? []).reverse().map(r => ({
      role: r.sender_type === 'user' ? 'user' : 'assistant',
      text: r.content,
    }))
  } catch { return [] }
}

async function getSystemPrompt(db: D1Database, clientAccountId: string): Promise<string | undefined> {
  try {
    const row = await db.prepare(`
      SELECT content FROM bot_system_prompts
      WHERE account_id = ?1 AND is_published = 1
      ORDER BY updated_at DESC LIMIT 1
    `).bind(clientAccountId).first<{ content: string }>()
    return row?.content ?? undefined
  } catch { return undefined }
}

async function buildUserContext(db: D1Database, userAccountId: string): Promise<string | undefined> {
  try {
    const profile = await db.prepare(`
      SELECT nickname, gender, age, height_cm, target_weight_kg, activity_level
      FROM user_profiles WHERE user_account_id = ?1 LIMIT 1
    `).bind(userAccountId).first<{
      nickname: string | null
      gender: string | null
      age: number | null
      height_cm: number | null
      target_weight_kg: number | null
      activity_level: string | null
    }>()
    if (!profile) return undefined

    const parts: string[] = []
    if (profile.nickname) parts.push(`名前: ${profile.nickname}`)
    if (profile.gender) parts.push(`性別: ${profile.gender}`)
    if (profile.age) parts.push(`年齢: ${profile.age}歳`)
    if (profile.height_cm) parts.push(`身長: ${profile.height_cm}cm`)
    if (profile.target_weight_kg) parts.push(`目標体重: ${profile.target_weight_kg}kg`)
    if (profile.activity_level) parts.push(`活動レベル: ${profile.activity_level}`)

    // 直近の体重
    const weight = await db.prepare(`
      SELECT weight_kg, metric_date FROM body_metrics
      WHERE user_account_id = ?1
      ORDER BY metric_date DESC LIMIT 1
    `).bind(userAccountId).first<{ weight_kg: number; metric_date: string }>()
    if (weight) parts.push(`直近体重: ${weight.weight_kg}kg (${weight.metric_date})`)

    return parts.length ? parts.join('\n') : undefined
  } catch { return undefined }
}

async function getActiveMemories(db: D1Database, userAccountId: string): Promise<string[]> {
  try {
    const rows = await db.prepare(`
      SELECT category, memory_value FROM user_memory_items
      WHERE user_account_id = ?1 AND confidence >= 0.6 AND is_active = 1
      ORDER BY updated_at DESC LIMIT 10
    `).bind(userAccountId).all<{ category: string; memory_value: string }>()
    return (rows.results ?? []).map(r => `[${r.category}] ${r.memory_value}`)
  } catch { return [] }
}

async function searchKnowledge(db: D1Database, clientAccountId: string, query: string): Promise<string[]> {
  try {
    // 簡易テキスト検索（Phase 2 でベクトル検索に置き換え）
    const rows = await db.prepare(`
      SELECT title, content FROM bot_knowledge_documents
      WHERE account_id = ?1 AND is_published = 1
      ORDER BY updated_at DESC LIMIT 3
    `).bind(clientAccountId).all<{ title: string; content: string }>()
    return (rows.results ?? []).map(r => `### ${r.title}\n${r.content}`)
  } catch { return [] }
}

async function saveConversationMessage(
  db: D1Database,
  userAccountId: string,
  lineUserId: string,
  senderType: 'user' | 'bot',
  content: string
): Promise<void> {
  try {
    // スレッドを取得 or 作成
    const thread = await db.prepare(`
      SELECT id FROM conversation_threads
      WHERE user_account_id = ?1 AND status = 'open'
      ORDER BY created_at DESC LIMIT 1
    `).bind(userAccountId).first<{ id: string }>()

    if (!thread) return

    await db.prepare(`
      INSERT INTO conversation_messages (id, thread_id, sender_type, message_type, content, created_at)
      VALUES (?1, ?2, ?3, 'text', ?4, datetime('now'))
    `).bind(crypto.randomUUID(), thread.id, senderType, content).run()
  } catch (err) {
    console.error('[TextHandler] saveConversationMessage error:', err)
  }
}

async function ensureDailyLog(db: D1Database, userAccountId: string, date: string): Promise<string> {
  const existing = await db.prepare(`
    SELECT id FROM daily_logs WHERE user_account_id = ?1 AND log_date = ?2
  `).bind(userAccountId, date).first<{ id: string }>()

  if (existing) return existing.id

  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO daily_logs (id, user_account_id, log_date, created_at, updated_at)
    VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
  `).bind(id, userAccountId, date).run()
  return id
}

async function createMealEntry(
  db: D1Database,
  params: {
    dailyLogId: string
    userAccountId: string
    mealType: string
    description: string
    calories: number
    protein: number
    fat: number
    carbs: number
    sourceType: string
  }
): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO meal_entries
      (id, daily_log_id, user_account_id, meal_type, description,
       total_calories, total_protein_g, total_fat_g, total_carbs_g,
       source_type, is_confirmed, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, datetime('now'), datetime('now'))
  `).bind(
    id, params.dailyLogId, params.userAccountId, params.mealType, params.description,
    params.calories, params.protein, params.fat, params.carbs, params.sourceType
  ).run()
  return id
}

async function estimateNutrition(
  foodDesc: string,
  env: WorkerEnv
): Promise<{ calories: number; protein: number; fat: number; carbs: number }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: '栄養推定エンジンです。食事のカロリーと栄養素を推定してJSONで返してください。\n{"calories":数値,"protein":数値,"fat":数値,"carbs":数値}\n数値は整数。一般的な1人前の量で推定。',
          },
          { role: 'user', content: foodDesc },
        ],
        temperature: 0.2,
        max_tokens: 100,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error('OpenAI failed')
    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content)
    return {
      calories: parsed.calories ?? 0,
      protein: parsed.protein ?? 0,
      fat: parsed.fat ?? 0,
      carbs: parsed.carbs ?? 0,
    }
  } catch {
    return { calories: 0, protein: 0, fat: 0, carbs: 0 }
  } finally {
    clearTimeout(timeoutId)
  }
}

function getTodayJST(): string {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  return jstNow.toISOString().split('T')[0]
}

function guessMealType(): string {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  const hour = jstNow.getUTCHours()

  if (hour >= 5 && hour < 10) return 'breakfast'
  if (hour >= 10 && hour < 14) return 'lunch'
  if (hour >= 14 && hour < 17) return 'snack'
  if (hour >= 17 && hour < 21) return 'dinner'
  return 'night_snack'
}
