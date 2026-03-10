/**
 * User API
 * /api/user
 */

import { Hono } from 'hono'
import type { Bindings } from '../../types/bindings'
import { ProfileRepo, DailyLogRepo, MealRepo, ProgressPhotoRepo } from '../../repository'
import { ok, badRequest } from '../../utils/response'
import { todayJst } from '../../repository'

type HonoEnv = { Bindings: Bindings }

const userRouter = new Hono<HonoEnv>()

// ダッシュボードデータ
userRouter.get('/dashboard', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const today = todayJst()

  const [profile, todayLog, todayMeals, recentLogs, streak, photos] = await Promise.all([
    ProfileRepo.findByUser(c.env.DB, accountId, lineUserId),
    DailyLogRepo.findByDate(c.env.DB, accountId, lineUserId, today),
    MealRepo.getByDate(c.env.DB, accountId, lineUserId, today),
    DailyLogRepo.getRecent(c.env.DB, accountId, lineUserId, 14),
    DailyLogRepo.getStreak(c.env.DB, accountId, lineUserId),
    ProgressPhotoRepo.getByUser(c.env.DB, accountId, lineUserId, 6)
  ])

  // 今日のカロリー計算
  const todayCalories = todayMeals.reduce((sum, m) => sum + (m.estimated_calories || 0), 0)
  const todayProtein = todayMeals.reduce((sum, m) => sum + (m.estimated_protein_g || 0), 0)
  const todayFat = todayMeals.reduce((sum, m) => sum + (m.estimated_fat_g || 0), 0)
  const todayCarbs = todayMeals.reduce((sum, m) => sum + (m.estimated_carbs_g || 0), 0)

  // 体重推移（14日）
  const weightTrend = recentLogs
    .filter(l => l.weight_kg !== null)
    .map(l => ({ date: l.log_date, weight: l.weight_kg }))

  return ok(c, {
    profile,
    today: {
      date: today,
      log: todayLog,
      calories: todayCalories,
      protein_g: todayProtein,
      fat_g: todayFat,
      carbs_g: todayCarbs,
      meals: todayMeals
    },
    weightTrend,
    streak,
    photos: photos.map(p => ({
      date: p.log_date,
      url: `${c.env.R2_BUCKET_URL}/${p.r2_key}`,
      weight: p.weight_at_photo
    }))
  })
})

// 記録一覧
userRouter.get('/records', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')
  const limit = parseInt(c.req.query('limit') || '30', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const logs = await DailyLogRepo.getRecent(c.env.DB, accountId, lineUserId, limit)
  const logsWithMeals = await Promise.all(
    logs.map(async (log) => {
      const meals = await MealRepo.getByDate(c.env.DB, accountId, lineUserId, log.log_date)
      const totalCalories = meals.reduce((sum, m) => sum + (m.estimated_calories || 0), 0)
      return { ...log, meals_count: meals.length, total_calories: totalCalories }
    })
  )

  return ok(c, { logs: logsWithMeals, limit, offset })
})

// 特定日の記録
userRouter.get('/records/:date', async (c) => {
  const lineUserId = c.req.query('line_user_id')
  const accountId = c.req.query('account_id')
  const date = c.req.param('date')

  if (!lineUserId || !accountId) {
    return badRequest(c, 'line_user_id and account_id are required')
  }

  const log = await DailyLogRepo.findByDate(c.env.DB, accountId, lineUserId, date)
  const meals = await MealRepo.getByDate(c.env.DB, accountId, lineUserId, date)

  return ok(c, { date, log, meals })
})

export default userRouter
