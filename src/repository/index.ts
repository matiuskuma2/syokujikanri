/**
 * Repository 層 - データベース操作ヘルパー
 * diet-bot - D1 SQLite
 */

import type {
  Account, AccountMembership, Subscription,
  LineChannel, LineUser, UserServiceStatus,
  ConversationThread, ConversationMessage, MessageAttachment,
  BotModeSession, Bot, BotVersion,
  KnowledgeBase, KnowledgeDocument,
  UserProfile, IntakeAnswer,
  DailyLog, MealEntry,
  ImageIntakeResult, ProgressPhoto,
  WeeklyReport, QuestionDefinition
} from '../types/models'

// ===================================================================
// ユーティリティ
// ===================================================================

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

export function todayJst(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().substring(0, 10)
}

// ===================================================================
// アカウント
// ===================================================================

export const AccountRepo = {
  async findById(db: D1Database, id: string): Promise<Account | null> {
    const result = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>()
    return result || null
  },

  async findAll(db: D1Database): Promise<Account[]> {
    const result = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all<Account>()
    return result.results
  },

  async create(db: D1Database, data: Omit<Account, 'id' | 'created_at' | 'updated_at'>): Promise<Account> {
    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.type, data.name, data.status, data.timezone, data.locale, now, now).run()
    return { id, ...data, created_at: now, updated_at: now }
  }
}

// ===================================================================
// LINE チャンネル
// ===================================================================

export const LineChannelRepo = {
  async findByAccountId(db: D1Database, accountId: string): Promise<LineChannel | null> {
    return db.prepare('SELECT * FROM line_channels WHERE account_id = ? AND is_active = 1')
      .bind(accountId).first<LineChannel>()
  },

  async findByChannelId(db: D1Database, channelId: string): Promise<LineChannel | null> {
    return db.prepare('SELECT * FROM line_channels WHERE channel_id = ? AND is_active = 1')
      .bind(channelId).first<LineChannel>()
  }
}

// ===================================================================
// LINE ユーザー
// ===================================================================

export const LineUserRepo = {
  async findByLineUserId(db: D1Database, accountId: string, lineUserId: string): Promise<LineUser | null> {
    return db.prepare('SELECT * FROM line_users WHERE account_id = ? AND line_user_id = ?')
      .bind(accountId, lineUserId).first<LineUser>()
  },

  async upsert(db: D1Database, data: {
    accountId: string
    lineChannelId: string
    lineUserId: string
    displayName?: string
    pictureUrl?: string
  }): Promise<LineUser> {
    const now = nowIso()
    const existing = await LineUserRepo.findByLineUserId(db, data.accountId, data.lineUserId)

    if (existing) {
      await db.prepare(`
        UPDATE line_users SET display_name = ?, picture_url = ?, last_active_at = ?, updated_at = ?
        WHERE account_id = ? AND line_user_id = ?
      `).bind(data.displayName || existing.display_name, data.pictureUrl || existing.picture_url,
        now, now, data.accountId, data.lineUserId).run()
      return { ...existing, display_name: data.displayName || existing.display_name, last_active_at: now }
    }

    const id = generateId()
    await db.prepare(`
      INSERT INTO line_users (id, account_id, line_channel_id, line_user_id, display_name, picture_url, first_seen_at, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.accountId, data.lineChannelId, data.lineUserId,
      data.displayName || null, data.pictureUrl || null, now, now, now, now).run()

    return {
      id, account_id: data.accountId, line_channel_id: data.lineChannelId,
      line_user_id: data.lineUserId, display_name: data.displayName || null,
      picture_url: data.pictureUrl || null, status_message: null,
      first_seen_at: now, last_active_at: now, created_at: now, updated_at: now
    }
  },

  async listByAccountId(db: D1Database, accountId: string, limit = 50, offset = 0): Promise<{
    users: (LineUser & { profile: UserProfile | null; lastLog: DailyLog | null })[]
    total: number
  }> {
    const total = await db.prepare(
      'SELECT COUNT(*) as cnt FROM line_users WHERE account_id = ?'
    ).bind(accountId).first<{ cnt: number }>()

    const users = await db.prepare(`
      SELECT lu.*,
        up.nickname, up.current_weight_kg, up.target_weight_kg,
        dl.log_date as last_log_date, dl.weight_kg as last_weight
      FROM line_users lu
      LEFT JOIN user_profiles up ON up.account_id = lu.account_id AND up.line_user_id = lu.line_user_id
      LEFT JOIN daily_logs dl ON dl.account_id = lu.account_id AND dl.line_user_id = lu.line_user_id
        AND dl.log_date = (
          SELECT MAX(log_date) FROM daily_logs
          WHERE account_id = lu.account_id AND line_user_id = lu.line_user_id
        )
      WHERE lu.account_id = ?
      ORDER BY lu.last_active_at DESC
      LIMIT ? OFFSET ?
    `).bind(accountId, limit, offset).all()

    return {
      users: users.results as (LineUser & { profile: UserProfile | null; lastLog: DailyLog | null })[],
      total: total?.cnt || 0
    }
  }
}

// ===================================================================
// ユーザーサービスステータス
// ===================================================================

export const UserServiceRepo = {
  async findByUser(db: D1Database, accountId: string, lineUserId: string): Promise<UserServiceStatus | null> {
    return db.prepare(
      'SELECT * FROM user_service_statuses WHERE account_id = ? AND line_user_id = ?'
    ).bind(accountId, lineUserId).first<UserServiceStatus>()
  },

  async ensureDefault(db: D1Database, accountId: string, lineUserId: string): Promise<UserServiceStatus> {
    const existing = await UserServiceRepo.findByUser(db, accountId, lineUserId)
    if (existing) return existing

    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT OR IGNORE INTO user_service_statuses
      (id, line_user_id, account_id, bot_enabled, record_enabled, consult_enabled, intake_enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1, 1, ?, ?)
    `).bind(id, lineUserId, accountId, now, now).run()

    return {
      id, line_user_id: lineUserId, account_id: accountId,
      bot_enabled: true, record_enabled: true, consult_enabled: true, intake_enabled: true,
      created_at: now, updated_at: now
    }
  }
}

// ===================================================================
// BOT セッション
// ===================================================================

export const SessionRepo = {
  async findActive(db: D1Database, accountId: string, lineUserId: string): Promise<BotModeSession | null> {
    return db.prepare(`
      SELECT * FROM bot_mode_sessions
      WHERE account_id = ? AND line_user_id = ? AND expires_at > datetime('now')
      LIMIT 1
    `).bind(accountId, lineUserId).first<BotModeSession>()
  },

  async upsert(db: D1Database, data: {
    accountId: string
    lineUserId: string
    mode: string
    stepCode: string
    sessionData?: Record<string, unknown>
    ttlHours?: number
  }): Promise<BotModeSession> {
    const now = nowIso()
    const ttl = data.ttlHours || 24
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString()
      .replace('T', ' ').substring(0, 19)

    const existing = await SessionRepo.findActive(db, data.accountId, data.lineUserId)

    if (existing) {
      await db.prepare(`
        UPDATE bot_mode_sessions
        SET mode = ?, step_code = ?, session_data = ?, turn_count = turn_count + 1,
            expires_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(data.mode, data.stepCode,
        data.sessionData ? JSON.stringify(data.sessionData) : null,
        expiresAt, now, existing.id).run()
      return { ...existing, mode: data.mode as BotModeSession['mode'], step_code: data.stepCode }
    }

    const id = generateId()
    await db.prepare(`
      INSERT INTO bot_mode_sessions
      (id, line_user_id, account_id, mode, step_code, session_data, turn_count, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).bind(id, data.lineUserId, data.accountId, data.mode, data.stepCode,
      data.sessionData ? JSON.stringify(data.sessionData) : null,
      expiresAt, now, now).run()

    return {
      id, line_user_id: data.lineUserId, account_id: data.accountId,
      mode: data.mode as BotModeSession['mode'], step_code: data.stepCode,
      session_data: data.sessionData ? JSON.stringify(data.sessionData) : null,
      turn_count: 0, expires_at: expiresAt, created_at: now, updated_at: now
    }
  },

  async clear(db: D1Database, accountId: string, lineUserId: string): Promise<void> {
    await db.prepare(
      'DELETE FROM bot_mode_sessions WHERE account_id = ? AND line_user_id = ?'
    ).bind(accountId, lineUserId).run()
  }
}

// ===================================================================
// 会話メッセージ
// ===================================================================

export const MessageRepo = {
  async saveMessage(db: D1Database, data: {
    threadId: string
    direction: 'inbound' | 'outbound'
    messageType: string
    content: string | null
    botMode?: string | null
    stepCode?: string | null
    metadata?: Record<string, unknown>
  }): Promise<string> {
    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT INTO conversation_messages
      (id, thread_id, direction, message_type, content, bot_mode, step_code, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.threadId, data.direction, data.messageType, data.content,
      data.botMode || null, data.stepCode || null,
      data.metadata ? JSON.stringify(data.metadata) : null, now).run()
    return id
  },

  async getOrCreateThread(db: D1Database, accountId: string, lineUserId: string): Promise<string> {
    const existing = await db.prepare(`
      SELECT id FROM conversation_threads
      WHERE account_id = ? AND line_user_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).bind(accountId, lineUserId).first<{ id: string }>()

    if (existing) return existing.id

    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT INTO conversation_threads (id, account_id, line_user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).bind(id, accountId, lineUserId, now, now).run()
    return id
  },

  async getRecentHistory(db: D1Database, threadId: string, limit = 10): Promise<
    Array<{ role: 'user' | 'assistant'; content: string }>
  > {
    const messages = await db.prepare(`
      SELECT direction, content FROM conversation_messages
      WHERE thread_id = ? AND message_type = 'text' AND content IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).bind(threadId, limit).all<{ direction: string; content: string }>()

    return messages.results
      .reverse()
      .map(m => ({
        role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.content
      }))
  }
}

// ===================================================================
// ユーザープロファイル
// ===================================================================

export const ProfileRepo = {
  async findByUser(db: D1Database, accountId: string, lineUserId: string): Promise<UserProfile | null> {
    return db.prepare(
      'SELECT * FROM user_profiles WHERE account_id = ? AND line_user_id = ?'
    ).bind(accountId, lineUserId).first<UserProfile>()
  },

  async upsert(db: D1Database, data: Partial<UserProfile> & {
    account_id: string; line_user_id: string
  }): Promise<void> {
    const now = nowIso()
    const existing = await ProfileRepo.findByUser(db, data.account_id, data.line_user_id)

    if (existing) {
      const fields = Object.keys(data).filter(k =>
        !['id', 'account_id', 'line_user_id', 'created_at', 'updated_at'].includes(k)
      )
      if (fields.length === 0) return
      const setClause = fields.map(f => `${f} = ?`).join(', ')
      const values = fields.map(f => (data as Record<string, unknown>)[f])
      await db.prepare(`
        UPDATE user_profiles SET ${setClause}, updated_at = ?
        WHERE account_id = ? AND line_user_id = ?
      `).bind(...values, now, data.account_id, data.line_user_id).run()
    } else {
      const id = generateId()
      await db.prepare(`
        INSERT OR IGNORE INTO user_profiles
        (id, line_user_id, account_id, nickname, gender, age_range, height_cm,
         current_weight_kg, target_weight_kg, goal_summary, concern_tags,
         diet_history, medical_notes, activity_level, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, data.line_user_id, data.account_id,
        data.nickname || null, data.gender || null, data.age_range || null,
        data.height_cm || null, data.current_weight_kg || null, data.target_weight_kg || null,
        data.goal_summary || null, data.concern_tags || null,
        data.diet_history || null, data.medical_notes || null, data.activity_level || null,
        now, now).run()
    }
  }
}

// ===================================================================
// 日次ログ
// ===================================================================

export const DailyLogRepo = {
  async findByDate(db: D1Database, accountId: string, lineUserId: string, date: string): Promise<DailyLog | null> {
    return db.prepare(
      'SELECT * FROM daily_logs WHERE account_id = ? AND line_user_id = ? AND log_date = ?'
    ).bind(accountId, lineUserId, date).first<DailyLog>()
  },

  async upsert(db: D1Database, data: Partial<DailyLog> & {
    account_id: string; line_user_id: string; log_date: string
  }): Promise<DailyLog> {
    const now = nowIso()
    const existing = await DailyLogRepo.findByDate(db, data.account_id, data.line_user_id, data.log_date)

    if (existing) {
      const updates: string[] = []
      const values: unknown[] = []
      const fields: Array<keyof DailyLog> = [
        'weight_kg', 'waist_cm', 'body_fat_pct', 'steps', 'water_ml',
        'sleep_hours', 'mood_score', 'notes', 'ai_feedback'
      ]
      for (const f of fields) {
        if (data[f] !== undefined) {
          updates.push(`${f} = ?`)
          values.push(data[f])
        }
      }
      if (updates.length > 0) {
        await db.prepare(`
          UPDATE daily_logs SET ${updates.join(', ')}, updated_at = ?
          WHERE account_id = ? AND line_user_id = ? AND log_date = ?
        `).bind(...values, now, data.account_id, data.line_user_id, data.log_date).run()
      }
      return { ...existing, ...data, updated_at: now }
    }

    const id = generateId()
    await db.prepare(`
      INSERT INTO daily_logs
      (id, line_user_id, account_id, log_date, weight_kg, waist_cm, body_fat_pct,
       steps, water_ml, sleep_hours, mood_score, notes, ai_feedback, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.line_user_id, data.account_id, data.log_date,
      data.weight_kg || null, data.waist_cm || null, data.body_fat_pct || null,
      data.steps || null, data.water_ml || null, data.sleep_hours || null,
      data.mood_score || null, data.notes || null, data.ai_feedback || null,
      now, now).run()

    return {
      id, line_user_id: data.line_user_id, account_id: data.account_id,
      log_date: data.log_date, weight_kg: data.weight_kg || null,
      waist_cm: data.waist_cm || null, body_fat_pct: data.body_fat_pct || null,
      steps: data.steps || null, water_ml: data.water_ml || null,
      sleep_hours: data.sleep_hours || null, mood_score: data.mood_score || null,
      notes: data.notes || null, ai_feedback: data.ai_feedback || null,
      created_at: now, updated_at: now
    }
  },

  async getRecent(db: D1Database, accountId: string, lineUserId: string, days = 14): Promise<DailyLog[]> {
    const result = await db.prepare(`
      SELECT * FROM daily_logs
      WHERE account_id = ? AND line_user_id = ?
      ORDER BY log_date DESC LIMIT ?
    `).bind(accountId, lineUserId, days).all<DailyLog>()
    return result.results
  },

  async getStreak(db: D1Database, accountId: string, lineUserId: string): Promise<number> {
    const result = await db.prepare(`
      SELECT DISTINCT log_date FROM daily_logs
      WHERE account_id = ? AND line_user_id = ?
      ORDER BY log_date DESC LIMIT 60
    `).bind(accountId, lineUserId).all<{ log_date: string }>()

    const dates = result.results.map(r => r.log_date)
    let streak = 0
    const today = todayJst()
    let checkDate = today

    for (const date of dates) {
      if (date === checkDate) {
        streak++
        const d = new Date(checkDate)
        d.setDate(d.getDate() - 1)
        checkDate = d.toISOString().substring(0, 10)
      } else {
        break
      }
    }
    return streak
  }
}

// ===================================================================
// 食事記録
// ===================================================================

export const MealRepo = {
  async create(db: D1Database, data: Omit<MealEntry, 'id' | 'created_at' | 'updated_at'>): Promise<MealEntry> {
    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT INTO meal_entries
      (id, line_user_id, account_id, daily_log_id, log_date, meal_type, description,
       estimated_calories, estimated_protein_g, estimated_fat_g, estimated_carbs_g,
       nutrition_score, ai_parsed, ai_comment, image_key, recorded_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.line_user_id, data.account_id, data.daily_log_id || null, data.log_date,
      data.meal_type, data.description || null,
      data.estimated_calories || null, data.estimated_protein_g || null,
      data.estimated_fat_g || null, data.estimated_carbs_g || null,
      data.nutrition_score || null, data.ai_parsed ? 1 : 0,
      data.ai_comment || null, data.image_key || null,
      data.recorded_at, now, now).run()

    return { id, ...data, created_at: now, updated_at: now }
  },

  async getByDate(db: D1Database, accountId: string, lineUserId: string, date: string): Promise<MealEntry[]> {
    const result = await db.prepare(`
      SELECT * FROM meal_entries
      WHERE account_id = ? AND line_user_id = ? AND log_date = ?
      ORDER BY recorded_at ASC
    `).bind(accountId, lineUserId, date).all<MealEntry>()
    return result.results
  }
}

// ===================================================================
// ナレッジ
// ===================================================================

export const KnowledgeRepo = {
  async searchByText(db: D1Database, accountId: string, query: string, limit = 5): Promise<KnowledgeDocument[]> {
    // シンプルなLIKE検索（Phase 1: Vectorize未実装時のフォールバック）
    const result = await db.prepare(`
      SELECT kd.* FROM knowledge_documents kd
      INNER JOIN knowledge_bases kb ON kb.id = kd.knowledge_base_id
      WHERE (kb.account_id = ? OR kb.account_id IS NULL)
        AND kb.is_active = 1 AND kd.is_active = 1
        AND (kd.title LIKE ? OR kd.content LIKE ?)
      ORDER BY kb.priority DESC, kd.priority DESC
      LIMIT ?
    `).bind(accountId, `%${query}%`, `%${query}%`, limit).all<KnowledgeDocument>()
    return result.results
  },

  async listBases(db: D1Database, accountId: string): Promise<KnowledgeBase[]> {
    const result = await db.prepare(`
      SELECT * FROM knowledge_bases
      WHERE account_id = ? OR account_id IS NULL
      ORDER BY priority DESC
    `).bind(accountId).all<KnowledgeBase>()
    return result.results
  }
}

// ===================================================================
// 週次レポート
// ===================================================================

export const WeeklyReportRepo = {
  async create(db: D1Database, data: Omit<WeeklyReport, 'id' | 'created_at'>): Promise<WeeklyReport> {
    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT OR REPLACE INTO weekly_reports
      (id, line_user_id, account_id, week_start, week_end, avg_weight_kg, avg_calories,
       log_days, summary, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.line_user_id, data.account_id, data.week_start, data.week_end,
      data.avg_weight_kg || null, data.avg_calories || null, data.log_days,
      data.summary || null, data.sent_at || null, now).run()
    return { id, ...data, created_at: now }
  }
}

// ===================================================================
// 進捗写真
// ===================================================================

export const ProgressPhotoRepo = {
  async create(db: D1Database, data: Omit<ProgressPhoto, 'id' | 'created_at'>): Promise<ProgressPhoto> {
    const id = generateId()
    const now = nowIso()
    await db.prepare(`
      INSERT INTO progress_photos
      (id, line_user_id, account_id, log_date, r2_key, weight_at_photo, waist_at_photo, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, data.line_user_id, data.account_id, data.log_date, data.r2_key,
      data.weight_at_photo || null, data.waist_at_photo || null, data.notes || null, now).run()
    return { id, ...data, created_at: now }
  },

  async getByUser(db: D1Database, accountId: string, lineUserId: string, limit = 10): Promise<ProgressPhoto[]> {
    const result = await db.prepare(`
      SELECT * FROM progress_photos
      WHERE account_id = ? AND line_user_id = ?
      ORDER BY log_date DESC LIMIT ?
    `).bind(accountId, lineUserId, limit).all<ProgressPhoto>()
    return result.results
  }
}
