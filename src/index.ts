/**
 * diet-bot - メインエントリーポイント
 * Hono + Cloudflare Pages
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/cloudflare-workers'

import type { Bindings } from './types/bindings'
import type { JwtPayload } from './types/db'
import { authMiddleware } from './middleware/auth'

// Routes (import順: line → admin → user)
import webhookRouter from './routes/line/webhook'
import lineAuthRouter from './routes/line/auth'
import adminAuthRouter from './routes/admin/auth'
import adminUsersRouter from './routes/admin/users'
import adminDashboardRouter from './routes/admin/dashboard'
import inviteCodesRouter from './routes/admin/invite-codes'
import richMenuRouter from './routes/admin/rich-menu'
import userRouter from './routes/user/index'
import meRouter from './routes/user/me'
import filesRouter from './routes/user/files'

// Queue Consumer（Cloudflare Workers の queue export として使用）
import { lineQueueConsumer } from './jobs/image-analysis'

// Cron ジョブ
import { runDailyReminder } from './jobs/daily-reminder'
import { runWeeklyReport } from './jobs/weekly-report'
import { expirePendingIntakeResults } from './repositories/image-intake-repo'
import { deleteExpiredSessions } from './repositories/mode-sessions-repo'
import { expireInviteCodes } from './repositories/invite-codes-repo'

type Variables = {
  jwtPayload: JwtPayload
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ===================================================================
// グローバルミドルウェア
// ===================================================================

app.use('*', logger())

app.use('/api/*', async (c, next) => {
  const cors_origins = c.env.CORS_ORIGINS || '*'
  const corsMiddleware = cors({
    origin: cors_origins === '*' ? '*' : cors_origins.split(','),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: cors_origins !== '*'
  })
  return corsMiddleware(c, next)
})

// ===================================================================
// ヘルスチェック
// ===================================================================

app.get('/health', (c) => c.json({ status: 'ok', service: 'diet-bot', version: '1.0.0' }))
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ===================================================================
// 診断: LINE Push API テスト（本番でも利用可能 — 管理者のみ）
// ===================================================================

app.post('/api/diag/push-test', async (c) => {
  const env = c.env
  try {
    const { lineUserId, message } = await c.req.json<{ lineUserId: string; message?: string }>()
    if (!lineUserId) return c.json({ error: 'lineUserId is required' }, 400)

    const { pushText } = await import('./services/line/reply')
    const text = message ?? '🔧 Push API 診断テスト: このメッセージが見えれば push は正常に動作しています。'

    const startTime = Date.now()
    await pushText(lineUserId, text, env.LINE_CHANNEL_ACCESS_TOKEN)
    const elapsed = Date.now() - startTime

    return c.json({ success: true, elapsed_ms: elapsed })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[diag] push-test failed:', err)
    return c.json({ error: message }, 500)
  }
})

// ===================================================================
// E2E テスト用 DB クエリ API（開発環境のみ）
// ===================================================================

app.post('/api/test/query', async (c) => {
  const env = c.env
  if (env.APP_ENV !== 'development') {
    return c.json({ error: 'Not available in production' }, 403)
  }
  try {
    const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>()
    if (!sql) return c.json({ error: 'sql is required' }, 400)
    const stmt = params && params.length > 0
      ? env.DB.prepare(sql).bind(...params)
      : env.DB.prepare(sql)
    const result = await stmt.all()
    return c.json({ results: result.results ?? [], meta: result.meta })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

app.post('/api/test/exec', async (c) => {
  const env = c.env
  if (env.APP_ENV !== 'development') {
    return c.json({ error: 'Not available in production' }, 403)
  }
  try {
    const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>()
    if (!sql) return c.json({ error: 'sql is required' }, 400)
    const stmt = params && params.length > 0
      ? env.DB.prepare(sql).bind(...params)
      : env.DB.prepare(sql)
    const result = await stmt.run()
    return c.json({ success: true, meta: result.meta })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ===================================================================
// LINE Webhook（認証不要・署名検証は webhook.ts 内で実施）
// ===================================================================

app.route('/api/webhooks/line', webhookRouter)

// ===================================================================
// LINE Auth（認証不要: LIFF トークン → JWT 発行）
// ===================================================================

app.route('/api/auth/line', lineAuthRouter)

// ===================================================================
// Admin API（JWT認証必要）
// ===================================================================

app.route('/api/admin/auth', adminAuthRouter)

// 認証が必要なAdmin routes
app.use('/api/admin/*', authMiddleware)
app.route('/api/admin/users', adminUsersRouter)
app.route('/api/admin/dashboard', adminDashboardRouter)
app.route('/api/admin/invite-codes', inviteCodesRouter)
app.route('/api/admin/rich-menu', richMenuRouter)

// ===================================================================
// User API（後方互換: マジックリンク方式 /api/user/*）
// ===================================================================

app.route('/api/user', userRouter)

// ===================================================================
// User API（JWT認証: /api/users/me/* および /api/files/*）
// ===================================================================

app.route('/api/users/me', meRouter)
app.route('/api/files', filesRouter)

// ===================================================================
// 静的ファイル配信
// ===================================================================

app.use('/static/*', serveStatic({ root: './' }))

// favicon
app.get('/favicon.ico', (c) => c.redirect('/static/favicon.svg', 301))

// ===================================================================
// フロントエンド（SPA）
// ===================================================================

// Admin Dashboard
app.get('/admin', (c) => {
  return c.html(getAdminDashboardHtml())
})

app.get('/admin/*', (c) => {
  return c.html(getAdminDashboardHtml())
})

// LIFF エントリーポイント（LINE Login → JWT 取得）
app.get('/liff', (c) => {
  const liffId = c.env.LINE_LIFF_ID ?? ''
  return c.html(getLiffEntryHtml(liffId))
})

// User Dashboard (PWA) — JWT 認証済みユーザー向け
app.get('/dashboard', (c) => {
  const liffId = c.env.LINE_LIFF_ID ?? ''
  return c.html(getUserDashboardHtml(liffId))
})

// Welcome ページ（会員サイト — 認証不要）
app.get('/welcome', (c) => {
  return c.html(getWelcomeHtml())
})

// ルートリダイレクト → welcome ページへ
app.get('/', (c) => c.redirect('/welcome'))

// 404ハンドラー
app.notFound((c) => {
  return c.json({ success: false, error: 'Not Found' }, 404)
})

// エラーハンドラー
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ success: false, error: 'Internal Server Error' }, 500)
})

// ===================================================================
// Cloudflare Scheduled (Cron)
// ===================================================================

/** 毎時クリーンアップ: 期限切れ画像確認の自動破棄 + セッション清掃 */
async function runHourlyCleanup(env: Bindings): Promise<void> {
  try {
    const expired = await expirePendingIntakeResults(env.DB)
    const sessions = await deleteExpiredSessions(env.DB)
    const codes = await expireInviteCodes(env.DB)
    if (expired > 0 || sessions > 0 || codes > 0) {
      console.log(`[cron] hourly cleanup: ${expired} expired image results, ${sessions} expired sessions, ${codes} expired invite codes`)
    }
  } catch (err) {
    console.error('[cron] hourly cleanup error:', err)
  }
}

export async function scheduled(
  event: ScheduledEvent,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil((async () => {
    switch (event.cron) {
      case '0 12 * * *': // UTC 12:00 = JST 21:00 毎日リマインダー
        await runDailyReminder(env)
        break
      case '0 11 * * 0': // UTC 11:00 日曜 = JST 20:00 日曜 週次レポート
        await runWeeklyReport(env)
        break
      case '0 * * * *': // 毎時: 期限切れ画像確認の自動破棄 + セッション清掃
        await runHourlyCleanup(env)
        break
      default:
        console.log(`[cron] unknown cron expression: ${event.cron}`)
    }
  })())
}

// ===================================================================
// HTML テンプレート
// ===================================================================

function getAdminDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>diet-bot 管理ダッシュボード</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <style>
    body { font-family: 'Hiragino Sans', 'Meiryo', sans-serif; }
    .sidebar { width: 240px; min-height: 100vh; }
    .stat-card { transition: transform 0.2s; }
    .stat-card:hover { transform: translateY(-2px); }
    .modal-bg { background: rgba(0,0,0,0.5); }
    .toast { animation: fadeInOut 3.5s forwards; }
    @keyframes fadeInOut {
      0% { opacity:0; transform:translateY(20px); }
      15% { opacity:1; transform:translateY(0); }
      80% { opacity:1; }
      100% { opacity:0; }
    }
    .nav-active { background-color: #374151; color: white; }
    .role-badge-superadmin { background:#fef3c7; color:#92400e; }
    .role-badge-admin { background:#dbeafe; color:#1e40af; }
    .role-badge-staff { background:#f3f4f6; color:#374151; }
    .modal-tab {
      padding: 10px 16px; font-size: 13px; font-weight: 500;
      border-bottom: 2px solid transparent; color: #6b7280;
      cursor: pointer; background: none; border-top: none; border-left: none; border-right: none;
      transition: all 0.15s;
    }
    .modal-tab:hover { color: #374151; }
    .modal-tab.active { color: #16a34a; border-bottom-color: #16a34a; font-weight: 600; }
    .photo-thumb { border-radius: 8px; overflow: hidden; cursor: pointer; }
    .photo-thumb img { width: 100%; height: 120px; object-fit: cover; display: block; }
    .photo-thumb .photo-label { font-size: 11px; padding: 4px 8px; color: #6b7280; }
    .guide-step { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; }
    .guide-num { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
    .line-guide-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin-top: 8px; }
    .line-guide-box code { background: #dcfce7; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  </style>
</head>
<body class="bg-gray-50">

<!-- Toast -->
<div id="toast-container" class="fixed bottom-4 right-4 z-50 space-y-2"></div>

<!-- ========== 初期セットアップ画面（superadmin未登録時）========== -->
<div id="setup-screen" class="hidden min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-teal-50">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
    <div class="text-center mb-6">
      <div class="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
        <i class="fas fa-cog text-white text-2xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">初期セットアップ</h1>
      <p class="text-gray-500 text-sm mt-1">最初の管理者アカウントを作成します</p>
    </div>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
        <input id="setup-email" type="email"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent"
          placeholder="admin@example.com">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">パスワード（8文字以上）</label>
        <input id="setup-password" type="password"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent"
          placeholder="8文字以上の安全なパスワード"
          onkeydown="if(event.key==='Enter')handleSetup()">
      </div>
      <div id="setup-error" class="hidden text-red-500 text-sm bg-red-50 p-3 rounded-lg"></div>
      <button onclick="handleSetup()"
        class="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-xl font-medium transition-colors">
        <i class="fas fa-user-plus mr-2"></i>スーパー管理者アカウントを作成
      </button>
    </div>
  </div>
</div>

<!-- ========== ログイン画面 ========== -->
<div id="login-screen" class="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-teal-50">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
        <i class="fas fa-leaf text-white text-2xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">diet-bot</h1>
      <p class="text-gray-500 text-sm mt-1">管理ダッシュボード</p>
    </div>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
        <input id="login-email" type="email"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent"
          placeholder="admin@example.com">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
        <input id="login-password" type="password"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent"
          placeholder="パスワード"
          onkeydown="if(event.key==='Enter')handleLogin()">
      </div>
      <div id="login-error" class="hidden text-red-500 text-sm bg-red-50 p-3 rounded-lg"></div>
      <button onclick="handleLogin()"
        class="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-xl font-medium transition-colors">
        ログイン
      </button>
      <div class="text-center">
        <button onclick="showForgotPassword()" class="text-sm text-gray-500 hover:underline">
          パスワードを忘れた場合
        </button>
      </div>
      <!-- 初回セットアップリンク（superadmin未登録時のみ表示） -->
      <div id="setup-link" class="hidden mt-4 pt-4 border-t border-gray-100 text-center">
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p class="text-xs text-amber-700 mb-1"><i class="fas fa-info-circle mr-1"></i>管理者アカウントが未登録です</p>
          <button onclick="showSetupScreen()" class="text-sm text-green-600 hover:text-green-800 font-bold underline">
            初回セットアップはこちら（superadmin用）
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ========== パスワードリセット申請モーダル ========== -->
<div id="forgot-modal" class="hidden fixed inset-0 modal-bg z-50 flex items-center justify-center">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md mx-4">
    <h2 class="text-xl font-bold text-gray-800 mb-6">パスワード再設定</h2>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">登録メールアドレス</label>
        <input id="forgot-email" type="email"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
          placeholder="メールアドレスを入力">
      </div>
      <div id="forgot-msg" class="hidden text-sm p-3 rounded-lg"></div>
      <div class="flex gap-3">
        <button onclick="document.getElementById('forgot-modal').classList.add('hidden')"
          class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-medium transition-colors">
          キャンセル
        </button>
        <button onclick="handleForgotPassword()"
          class="flex-1 bg-green-500 hover:bg-green-600 text-white py-3 rounded-xl font-medium transition-colors">
          送信
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ========== ダッシュボード本体 ========== -->
<div id="dashboard-screen" class="hidden flex">
  <!-- サイドバー -->
  <div class="sidebar bg-gray-800 text-white flex flex-col fixed h-full z-10 overflow-y-auto">
    <div class="p-5 border-b border-gray-700">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-leaf text-white"></i>
        </div>
        <div class="min-w-0">
          <h1 class="font-bold text-white text-sm truncate" id="sidebar-account-name">diet-bot</h1>
          <p class="text-gray-500 text-xs truncate" id="sidebar-email">-</p>
        </div>
      </div>
      <!-- ロールバッジ（目立つように） -->
      <div class="mt-3">
        <span id="sidebar-role-badge" class="text-xs px-3 py-1.5 rounded-full bg-gray-600 text-gray-300 font-bold inline-flex items-center gap-1.5">
          <i class="fas fa-shield-halved text-[10px]"></i>
          <span id="sidebar-role-label">-</span>
        </span>
      </div>
    </div>
    <nav class="flex-1 p-4 space-y-1">
      <p class="text-gray-500 text-xs font-medium px-3 py-2 uppercase tracking-wider">メインメニュー</p>
      <button id="nav-overview" onclick="showPage('overview')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-chart-bar w-5 text-center"></i><span>ダッシュボード</span>
      </button>
      <button id="nav-users" onclick="showPage('users')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-users w-5 text-center"></i><span>LINEユーザー管理</span>
      </button>
      <button id="nav-invite-codes" onclick="showPage('invite-codes')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-ticket-alt w-5 text-center"></i><span>招待コード</span>
      </button>

      <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">管理</p>
      <button id="nav-members" onclick="showPage('members')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-user-shield w-5 text-center"></i><span>管理者管理</span>
      </button>

      <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">設定</p>
      <button id="nav-account" onclick="showPage('account')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-cog w-5 text-center"></i><span>アカウント設定</span>
      </button>
      <button id="nav-line-guide" onclick="showPage('line-guide')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fab fa-line w-5 text-center"></i><span>LINE案内文</span>
      </button>
      <button id="nav-checklist" onclick="showPage('checklist')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-clipboard-check w-5 text-center"></i><span>フローチェック</span>
      </button>

      <!-- Superadmin Only -->
      <div id="nav-system-section" class="hidden">
        <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">システム</p>
        <button id="nav-system" onclick="showPage('system')"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
          <i class="fas fa-server w-5 text-center"></i><span>システム管理</span>
        </button>
        <button id="nav-bot-settings" onclick="showPage('bot-settings')"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
          <i class="fas fa-robot w-5 text-center"></i><span>BOT/ナレッジ設定</span>
        </button>
        <button id="nav-rich-menu" onclick="showPage('rich-menu')"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
          <i class="fas fa-bars w-5 text-center"></i><span>Rich Menu管理</span>
        </button>
      </div>
    </nav>
    <div class="p-4 border-t border-gray-700">
      <button onclick="handleLogout()"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-400 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-sign-out-alt w-5 text-center"></i><span>ログアウト</span>
      </button>
    </div>
  </div>

  <!-- メインコンテンツ -->
  <div class="ml-60 flex-1 min-h-screen">

    <!-- ===== ダッシュボードページ ===== -->
    <div id="page-overview" class="p-8">
      <!-- ウェルカムガイド（初回表示、閉じられる） -->
      <div id="welcome-guide" class="bg-gradient-to-r from-green-50 to-teal-50 border border-green-200 rounded-2xl p-6 mb-8">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="text-lg font-bold text-gray-800 mb-1"><i class="fas fa-hand-wave text-green-500 mr-2"></i>ようこそ！最初にやることガイド</h2>
            <p class="text-sm text-gray-500 mb-4" id="guide-role-desc">管理画面の使い方を確認しましょう</p>
          </div>
          <button onclick="dismissGuide()" class="text-gray-400 hover:text-gray-600" title="閉じる">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- superadmin ガイド -->
        <div id="guide-superadmin" class="hidden">
          <div class="guide-step">
            <div class="guide-num bg-green-100 text-green-700">1</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">管理者（admin）を追加する</p>
              <p class="text-xs text-gray-500">「管理者管理」メニューから、顧客や運営担当者のアカウントを作成します</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="guide-num bg-blue-100 text-blue-700">2</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">管理者の利用状況を確認する</p>
              <p class="text-xs text-gray-500">各管理者に紐づくLINEユーザー数、利用中/停止中のステータスを管理します</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="guide-num bg-purple-100 text-purple-700">3</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">システム設定を確認する</p>
              <p class="text-xs text-gray-500">「システム管理」でDB統計・Cronジョブ・APIエンドポイントを確認できます</p>
            </div>
          </div>
          <button onclick="showPage('members')" class="mt-3 bg-green-500 hover:bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
            <i class="fas fa-user-plus mr-2"></i>管理者を追加する
          </button>
        </div>

        <!-- admin ガイド -->
        <div id="guide-admin" class="hidden">
          <div class="guide-step">
            <div class="guide-num bg-green-100 text-green-700">1</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">LINE登録を案内する</p>
              <p class="text-xs text-gray-500">「招待コード」で顧客用コードを発行し、「LINE案内文」からテンプレートをコピーして送りましょう</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="guide-num bg-blue-100 text-blue-700">2</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">ユーザーの状態を確認する</p>
              <p class="text-xs text-gray-500">「LINEユーザー管理」でLINE登録済みユーザーの問診状況・記録・体重を確認できます</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="guide-num bg-purple-100 text-purple-700">3</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">サービスのON/OFFを管理する</p>
              <p class="text-xs text-gray-500">ユーザーごとにBOT通知・記録・相談機能を個別に制御できます</p>
            </div>
          </div>
          <div class="flex gap-3 mt-3">
            <button onclick="showPage('invite-codes')" class="bg-green-500 hover:bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
              <i class="fas fa-ticket-alt mr-2"></i>招待コードを発行
            </button>
            <button onclick="showPage('line-guide')" class="bg-white border border-green-500 text-green-600 hover:bg-green-50 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
              <i class="fab fa-line mr-2"></i>LINE案内文を確認
            </button>
          </div>
        </div>

        <!-- staff ガイド（レガシーサポート） -->
        <div id="guide-staff" class="hidden">
          <div class="guide-step">
            <div class="guide-num bg-green-100 text-green-700">1</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">ダッシュボードで状況確認</p>
              <p class="text-xs text-gray-500">この画面で総ユーザー数・今日の記録・アクティブ数を確認できます</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="guide-num bg-blue-100 text-blue-700">2</div>
            <div>
              <p class="font-bold text-gray-800 text-sm">ユーザーの詳細を閲覧</p>
              <p class="text-xs text-gray-500">「LINEユーザー管理」で各ユーザーの記録を確認できます</p>
            </div>
          </div>
        </div>
      </div>

      <h1 class="text-2xl font-bold text-gray-800 mb-6">ダッシュボード</h1>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">総LINEユーザー数</p>
              <p class="text-3xl font-bold text-gray-800 mt-1" id="stat-total-users">-</p>
            </div>
            <div class="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center">
              <i class="fas fa-users text-blue-600 text-xl"></i>
            </div>
          </div>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">今日の記録数</p>
              <p class="text-3xl font-bold text-gray-800 mt-1" id="stat-today-logs">-</p>
            </div>
            <div class="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-clipboard-list text-green-600 text-xl"></i>
            </div>
          </div>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">今週のアクティブ</p>
              <p class="text-3xl font-bold text-gray-800 mt-1" id="stat-weekly-active">-</p>
            </div>
            <div class="w-14 h-14 bg-purple-100 rounded-full flex items-center justify-center">
              <i class="fas fa-fire text-purple-600 text-xl"></i>
            </div>
          </div>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">問診未完了</p>
              <p class="text-3xl font-bold text-gray-800 mt-1" id="stat-intake-incomplete">-</p>
            </div>
            <div class="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center">
              <i class="fas fa-clipboard-question text-amber-600 text-xl"></i>
            </div>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-bold text-gray-800 mb-4">最近参加したLINEユーザー</h2>
        <div id="recent-users-list" class="space-y-3">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ===== LINEユーザー管理ページ ===== -->
    <div id="page-users" class="hidden p-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">LINEユーザー管理</h1>
          <p class="text-gray-500 text-sm mt-1">LINE友達追加済みユーザーの状態確認・サービス設定</p>
        </div>
      </div>
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-sm text-blue-800">
        <i class="fas fa-info-circle mr-2"></i>
        ユーザーは <strong>LINE友達追加 → 招待コード送信</strong> で自動登録されます。ここで手動追加する必要はありません。まだユーザーがいない場合は「招待コード」を発行し「LINE案内文」を送ってください。
      </div>
      <!-- ステータスタブ -->
      <div class="flex gap-2 mb-4 flex-wrap">
        <button onclick="setUserTab('all')" id="user-tab-all"
          class="px-4 py-2 rounded-xl text-sm font-medium bg-green-500 text-white transition-colors">
          全件 <span id="user-count-all" class="ml-1 opacity-75">-</span>
        </button>
        <button onclick="setUserTab('intake')" id="user-tab-intake"
          class="px-4 py-2 rounded-xl text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
          <i class="fas fa-clipboard-question mr-1"></i>未問診 <span id="user-count-intake" class="ml-1 opacity-75">-</span>
        </button>
        <button onclick="setUserTab('active')" id="user-tab-active"
          class="px-4 py-2 rounded-xl text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
          <i class="fas fa-check-circle mr-1"></i>利用中 <span id="user-count-active" class="ml-1 opacity-75">-</span>
        </button>
        <button onclick="setUserTab('stopped')" id="user-tab-stopped"
          class="px-4 py-2 rounded-xl text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
          <i class="fas fa-ban mr-1"></i>停止中 <span id="user-count-stopped" class="ml-1 opacity-75">-</span>
        </button>
      </div>

      <div class="bg-white rounded-xl shadow">
        <div class="p-4 border-b flex gap-3">
          <input type="text" id="user-search" placeholder="名前で検索..."
            class="px-4 py-2 border border-gray-300 rounded-lg w-full max-w-xs"
            onkeyup="filterUsers()">
        </div>
        <div id="users-table" class="p-4">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ===== 招待コード管理ページ ===== -->
    <div id="page-invite-codes" class="hidden p-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-800"><i class="fas fa-ticket-alt text-green-500 mr-2"></i>招待コード</h1>
          <p class="text-gray-500 text-sm mt-1">顧客に配布する招待コードを管理します。コードでLINEユーザーが正しいアカウントに紐付けられます。</p>
        </div>
      </div>

      <!-- 仕組みの説明 -->
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
        <h3 class="font-semibold text-blue-800 text-sm mb-2"><i class="fas fa-info-circle mr-1"></i>招待コードの使い方</h3>
        <ol class="text-xs text-blue-700 space-y-1 list-decimal list-inside">
          <li>下の「招待コード発行」ボタンでコードを生成（例: <code class="bg-blue-100 px-1 rounded">ABC-1234</code>）</li>
          <li>お客様にコードを伝える（LINE案内文テンプレートが便利です）</li>
          <li>お客様がLINE友達追加後、コードをチャットで送信</li>
          <li>自動的にあなたのアカウントに紐付けられ、問診が開始されます</li>
        </ol>
      </div>

      <!-- 発行フォーム (staff以外) -->
      <div id="invite-code-form" class="bg-white rounded-xl shadow p-6 mb-6">
        <h3 class="font-semibold text-gray-700 mb-4"><i class="fas fa-plus-circle text-green-500 mr-1"></i>招待コードを発行</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class="block text-sm text-gray-600 mb-1">ラベル（メモ）</label>
            <input id="invite-label" type="text" placeholder="顧客名やメモ"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
          </div>
          <div>
            <label class="block text-sm text-gray-600 mb-1">使用回数上限</label>
            <select id="invite-max-uses" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="1">1回（1顧客用）</option>
              <option value="5">5回</option>
              <option value="10">10回</option>
              <option value="0">無制限</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-gray-600 mb-1">有効期限</label>
            <select id="invite-expires" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="0">無期限</option>
              <option value="7">7日間</option>
              <option value="30" selected>30日間</option>
              <option value="90">90日間</option>
            </select>
          </div>
        </div>
        <div id="invite-code-msg" class="hidden mt-3 p-3 rounded-lg text-sm"></div>
        <button onclick="handleCreateInviteCode()"
          class="mt-4 bg-green-500 hover:bg-green-600 text-white px-6 py-2 rounded-xl text-sm font-medium transition-colors">
          <i class="fas fa-magic mr-1"></i>招待コードを発行
        </button>
      </div>

      <!-- 発行済みコード一覧 -->
      <div class="bg-white rounded-xl shadow">
        <div class="p-4 border-b">
          <h3 class="font-semibold text-gray-700"><i class="fas fa-list mr-1"></i>発行済みコード一覧</h3>
        </div>
        <div id="invite-codes-table" class="p-4">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ===== 管理者管理ページ（旧スタッフ管理を全面リニューアル） ===== -->
    <div id="page-members" class="hidden p-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">管理者管理</h1>
          <p class="text-gray-500 text-sm mt-1" id="members-desc">管理者・スタッフアカウントの作成と権限管理</p>
        </div>
      </div>

      <!-- 権限の説明（2ロール構成） -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <span class="text-xs px-2 py-0.5 rounded-full role-badge-superadmin font-medium">superadmin</span>
          <p class="text-sm font-semibold text-gray-800 mt-2">スーパー管理者</p>
          <ul class="text-xs text-gray-600 mt-2 space-y-1">
            <li><i class="fas fa-check text-green-500 mr-1"></i>全機能・全アカウントにアクセス</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>管理者(admin)の作成・停止</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>システム設定の閲覧</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>全ユーザーの所属admin確認</li>
          </ul>
        </div>
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <span class="text-xs px-2 py-0.5 rounded-full role-badge-admin font-medium">admin</span>
          <p class="text-sm font-semibold text-gray-800 mt-2">管理者</p>
          <ul class="text-xs text-gray-600 mt-2 space-y-1">
            <li><i class="fas fa-check text-green-500 mr-1"></i>自分のLINEユーザー管理</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>招待コード発行・LINE案内文の利用</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>ユーザーサービスON/OFF</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>食事記録・レポートの閲覧</li>
          </ul>
        </div>
      </div>

      <!-- 管理者追加フォーム (superadminのみ表示) -->
      <div id="add-member-section" class="bg-white rounded-xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-2 flex items-center gap-2">
          <i class="fas fa-user-plus text-green-600"></i> 管理者（admin）を追加する
        </h2>
        <p class="text-gray-500 text-sm mb-4">メールアドレスと仮パスワードを指定して管理者アカウントを即時作成します。作成した管理者はそれぞれ独自の招待コードを発行し、LINEユーザーを管理できます。</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
            <input id="add-member-email" type="email"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
              placeholder="user@example.com">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">仮パスワード</label>
            <input id="add-member-password" type="text"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
              placeholder="8文字以上">
          </div>
          <div class="flex items-end">
            <button onclick="handleAddMember()"
              class="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-xl font-medium transition-colors text-sm">
              <i class="fas fa-plus mr-1"></i>管理者を作成
            </button>
          </div>
        </div>
        <div id="add-member-msg" class="hidden text-sm p-3 rounded-lg mt-3 max-w-3xl"></div>
      </div>

      <!-- admin権限の場合（作成不可） -->
      <div id="members-no-create" class="hidden bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-sm text-blue-800">
        <i class="fas fa-info-circle mr-2"></i>管理者アカウントの作成・停止はスーパー管理者のみ行えます。
      </div>

      <!-- 管理者一覧 -->
      <div class="bg-white rounded-xl shadow">
        <div class="p-4 border-b">
          <h2 class="font-bold text-gray-800"><i class="fas fa-list mr-2 text-gray-500"></i>管理者一覧</h2>
        </div>
        <div id="members-table" class="p-4">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ===== LINE案内文ページ ===== -->
    <div id="page-line-guide" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-6"><i class="fab fa-line text-green-500 mr-2"></i>LINE登録 案内文</h1>
      <p class="text-gray-500 text-sm mb-6">お客様にLINE登録を案内する際に使えるテンプレートです。コピーしてそのまま送れます。</p>

      <!-- QRコード -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6 flex flex-col md:flex-row items-center gap-6">
        <img src="/static/qr-line-friend.png" alt="QRコード" class="w-36 h-36 rounded-xl shadow-sm">
        <div>
          <h2 class="font-bold text-gray-800 mb-2">友達追加QRコード</h2>
          <p class="text-sm text-gray-500 mb-3">印刷して店頭に掲示したり、メールに添付してご利用ください</p>
          <div class="flex items-center gap-2 bg-gray-100 rounded-xl px-4 py-3 w-fit">
            <span class="text-gray-500 text-sm">LINE ID:</span>
            <code class="font-bold text-gray-800">@054eyzbj</code>
            <button onclick="copyText('@054eyzbj', this)" class="text-gray-400 hover:text-gray-600 ml-1" title="コピー">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- 案内文テンプレート -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-3"><i class="fas fa-envelope mr-2 text-blue-500"></i>メール・メッセージ用テンプレート</h2>
        <div class="bg-gray-50 rounded-xl p-4 relative">
          <button onclick="copyText(document.getElementById('guide-text-1').innerText, this)"
            class="absolute top-3 right-3 text-xs bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-gray-500 hover:bg-gray-50 transition-colors">
            <i class="fas fa-copy mr-1"></i>コピー
          </button>
          <div id="guide-text-1" class="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">食事管理をLINEでかんたんに始められます！

【登録方法】
1. 下記リンクからLINEで友達追加してください
   https://lin.ee/n4PoXrR
   (LINE ID: @054eyzbj)

2. 友達追加したら、担当者から受け取った招待コードを送信してください
   例: ABC-1234

3. コード認証後、初回問診(約2分)が始まります

4. 問診完了後、食事の写真を送るだけでAIが自動でカロリー計算します

※体重は「72.5kg」のようにテキストで送るだけでOKです
※「相談」と送るとAI栄養相談もできます</div>
        </div>
      </div>

      <!-- 短い案内文 -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-3"><i class="fas fa-comment-dots mr-2 text-purple-500"></i>短い案内文（SMS・チャット用）</h2>
        <div class="bg-gray-50 rounded-xl p-4 relative">
          <button onclick="copyText(document.getElementById('guide-text-2').innerText, this)"
            class="absolute top-3 right-3 text-xs bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-gray-500 hover:bg-gray-50 transition-colors">
            <i class="fas fa-copy mr-1"></i>コピー
          </button>
          <div id="guide-text-2" class="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">食事指導BOTのご案内です。下記リンクからLINEで友達追加し、招待コード「（ここにコードを入力）」を送信してください。初回問診後、写真を送るだけでカロリー記録ができます。
https://lin.ee/n4PoXrR</div>
        </div>
      </div>

      <!-- ウェルカムページURL -->
      <div class="bg-green-50 border border-green-200 rounded-2xl p-6">
        <h2 class="font-bold text-gray-800 mb-2"><i class="fas fa-globe mr-2 text-green-600"></i>ウェルカムページ</h2>
        <p class="text-sm text-gray-500 mb-3">使い方ガイド付きのページです。お客様にそのまま共有できます。</p>
        <div class="flex items-center gap-2">
          <code class="bg-white border border-green-200 rounded-lg px-4 py-2 text-sm font-mono text-gray-700">https://diet-bot.pages.dev/welcome</code>
          <button onclick="copyText('https://diet-bot.pages.dev/welcome', this)" class="text-gray-400 hover:text-gray-600" title="コピー">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- ===== アカウント設定ページ ===== -->
    <div id="page-account" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">アカウント設定</h1>
      <!-- 管理者情報 -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fas fa-user text-green-600"></i> 自分のアカウント情報
        </h2>
        <div class="space-y-3 text-sm" id="admin-info">
          <div class="flex items-center gap-3">
            <span class="text-gray-500 w-28">メールアドレス</span>
            <span id="admin-email" class="font-medium">-</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-gray-500 w-28">権限</span>
            <span id="admin-role" class="font-medium">-</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-gray-500 w-28">最終ログイン</span>
            <span id="admin-last-login" class="font-medium">-</span>
          </div>
        </div>
      </div>

      <!-- パスワード変更 -->
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fas fa-lock text-green-600"></i> パスワード変更
        </h2>
        <div class="space-y-4 max-w-md">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">現在のパスワード</label>
            <input id="current-password" type="password"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
              placeholder="現在のパスワード">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
            <input id="new-password" type="password"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
              placeholder="8文字以上">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新しいパスワード（確認）</label>
            <input id="confirm-password" type="password"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500"
              placeholder="再入力">
          </div>
          <div id="change-pw-msg" class="hidden text-sm p-3 rounded-lg"></div>
          <button onclick="handleChangePassword()"
            class="bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-xl font-medium transition-colors">
            <i class="fas fa-save mr-2"></i>パスワードを変更
          </button>
        </div>
      </div>
    </div>

    <!-- ===== フローチェックリスト ===== -->
    <div id="page-checklist" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-2"><i class="fas fa-clipboard-check text-green-500 mr-2"></i>実運用チェックリスト</h1>
      <p class="text-gray-500 text-sm mb-6">初回セットアップから実際のユーザー利用まで、順番に確認してください。各項目に具体的な操作と期待結果を記載しています。</p>

      <!-- Phase 1: Superadmin -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full role-badge-superadmin font-medium">Phase 1</span>
          superadmin のセットアップ
        </h2>
        <div class="space-y-3">
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">1. /admin にアクセス</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: ブラウザで <code class="bg-gray-100 px-1 rounded">https://diet-bot.pages.dev/admin</code> を開く</p>
                <p><strong>期待</strong>: ログイン画面が表示。superadmin未登録なら「初回セットアップはこちら」リンクが見える</p>
              </div>
              <button onclick="window.open('https://diet-bot.pages.dev/admin','_blank')" class="mt-2 text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-200 transition-colors">
                <i class="fas fa-external-link-alt mr-1"></i>/admin を開く
              </button>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">2. superadmin アカウントを作成</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: 「初回セットアップはこちら」→ メール・パスワード(8文字以上)を入力 → 「作成」ボタン</p>
                <p><strong>期待</strong>: 「スーパー管理者アカウントを作成しました」トースト → ログイン画面にメール・パスワードが入力済み</p>
                <p><strong>注意</strong>: superadminは<strong>1人だけ</strong>。2回目以降はこのリンクが表示されません</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">3. superadmin でログイン</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: メール・パスワードで「ログイン」ボタンをクリック</p>
                <p><strong>期待</strong>: ダッシュボードが表示。左上にアカウント名、<span class="inline-block bg-amber-100 text-amber-800 px-1 rounded font-medium">スーパー管理者</span> バッジが表示</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Phase 2: Admin 作成 -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full role-badge-admin font-medium">Phase 2</span>
          admin を作成してログイン
        </h2>
        <div class="space-y-3">
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">4. 「管理者管理」で admin を作成</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: サイドバー「管理者管理」→ メールと仮パスワードを入力 → 「管理者を作成」</p>
                <p><strong>期待</strong>: 「管理者を作成しました」トースト。管理者一覧に新しいadminが表示される</p>
              </div>
              <button onclick="showPage('members')" class="mt-2 text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors">
                <i class="fas fa-user-shield mr-1"></i>管理者管理を開く
              </button>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">5. ログアウト → admin でログイン</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: 左下「ログアウト」→ 作成したadminのメール・仮パスワードでログイン</p>
                <p><strong>期待</strong>: ダッシュボードが表示。左上にアカウント名、<span class="inline-block bg-blue-100 text-blue-800 px-1 rounded font-medium">管理者</span> バッジ。「管理者管理」に作成フォームがない</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">6. 招待コードを発行する</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: サイドバー「招待コード」→ ラベル(任意)を入力 → 「招待コードを発行」</p>
                <p><strong>期待</strong>: <code class="bg-green-50 text-green-700 px-1 rounded">ABC-1234</code> のようなコードが生成される。クリップボードに自動コピー</p>
              </div>
              <button onclick="showPage('invite-codes')" class="mt-2 text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg hover:bg-purple-200 transition-colors">
                <i class="fas fa-ticket-alt mr-1"></i>招待コードを開く
              </button>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">7. LINE案内文をコピーして顧客に送信</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: サイドバー「LINE案内文」→ テンプレートの「コピー」ボタン → 顧客にメール/チャットで送信</p>
                <p><strong>送る内容</strong>: テンプレート + さっき発行した招待コード</p>
                <p><strong>期待</strong>: 「コピーしました」トースト。顧客が手順通りにLINE登録できる</p>
              </div>
              <button onclick="showPage('line-guide')" class="mt-2 text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-200 transition-colors">
                <i class="fab fa-line mr-1"></i>LINE案内文を開く
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Phase 3: User (LINE) フロー -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fab fa-line text-green-500 mr-1"></i>
          <span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800 font-medium">Phase 3</span>
          user の LINE 操作（顧客がやること）
        </h2>
        <div class="space-y-3">
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">8. LINE友達追加</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: LINE で <code class="bg-gray-100 px-1 rounded">@054eyzbj</code> を検索して友達追加（または https://lin.ee/n4PoXrR を開く）</p>
                <p><strong>期待</strong>: BOTから「ようこそ！担当者から受け取った<strong>招待コード</strong>を送信してください」メッセージが届く</p>
              </div>
              <a href="https://lin.ee/n4PoXrR" target="_blank" class="mt-2 inline-block text-xs bg-green-500 text-white px-3 py-1.5 rounded-lg hover:bg-green-600 transition-colors">
                <i class="fab fa-line mr-1"></i>友達追加リンク
              </a>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">9. 招待コードを送信</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: LINE のトーク画面で招待コード（例: <code class="bg-green-50 text-green-700 px-1 rounded font-bold">ABC-1234</code>）をそのまま送信</p>
                <p><strong>期待</strong>: 「コード認証完了！初回問診を開始します」→ 最初の質問（ニックネーム）が届く</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">10. 問診9問に回答</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: BOTの質問に順番に回答（ニックネーム→性別→年代→身長→体重→目標体重→理由→気になること→活動レベル）</p>
                <p><strong>期待</strong>: 全問完了後「問診完了しました！これから食事管理を始めましょう」メッセージ</p>
                <p><strong>所要時間</strong>: 約2分</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">11. 体重を記録する</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: LINE で <code class="bg-gray-100 px-1 rounded font-bold">72.5</code> または <code class="bg-gray-100 px-1 rounded font-bold">72.5kg</code> と送信</p>
                <p><strong>期待</strong>: 「体重 72.5kg を記録しました」と返信される</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">12. 食事写真を送信する</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: LINE で食事の写真を撮影して送信</p>
                <p><strong>期待</strong>: AI分析中メッセージ → カロリー・PFC分析結果 →「確定」「取消」選択肢が表示される →「確定」で保存</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">13. AI相談モードを試す</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: LINE で <code class="bg-gray-100 px-1 rounded font-bold">相談</code> と送信 → 好きな質問を入力</p>
                <p><strong>期待</strong>: 「相談モードに切り替えました」→ AIが栄養アドバイスを返信</p>
                <p><strong>戻し方</strong>: <code class="bg-gray-100 px-1 rounded">記録モード</code> と送信</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">14. LIFFダッシュボードを確認する</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: スマホで <code class="bg-gray-100 px-1 rounded">https://liff.line.me/2009409790-DekZRh4t</code> を開く</p>
                <p><strong>期待</strong>: LINE認証 → ダッシュボードに遷移。体重推移、今日の記録、食事一覧が表示される</p>
              </div>
              <a href="https://diet-bot.pages.dev/liff" target="_blank" class="mt-2 inline-block text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors">
                <i class="fas fa-gauge-high mr-1"></i>LIFF（PC確認用）
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Phase 4: Admin で結果確認 -->
      <div class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-medium">Phase 4</span>
          admin 画面でユーザーの反映を確認
        </h2>
        <div class="space-y-3">
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">15. LINEユーザー管理でユーザーが表示されている</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: admin でログイン → サイドバー「LINEユーザー管理」</p>
                <p><strong>期待</strong>: LINE友達追加したユーザーが一覧に表示。「利用中」タブに問診完了ユーザーが入っている</p>
              </div>
              <button onclick="showPage('users')" class="mt-2 text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors">
                <i class="fas fa-users mr-1"></i>LINEユーザー管理を開く
              </button>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">16. ユーザー詳細モーダルで記録を確認</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: ユーザーの行をクリック → モーダルが開く</p>
                <p><strong>期待</strong>: プロフィール（問診結果）、サービス設定、直近の記録が表示。食事記録・写真・レポートタブも確認</p>
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
            <input type="checkbox" class="mt-1 w-4 h-4 text-green-500 rounded" onchange="updateChecklistProgress()">
            <div class="flex-1">
              <p class="text-sm font-medium text-gray-800">17. ステータスタブのフィルターを確認</p>
              <div class="mt-1 text-xs text-gray-500 space-y-1">
                <p><strong>操作</strong>: 「全件」「未問診」「利用中」「停止中」タブを切り替え</p>
                <p><strong>期待</strong>: 各タブで正しいユーザーが絞り込まれる。件数バッジも正しい</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 進捗バー -->
      <div class="bg-white rounded-2xl shadow p-6">
        <h3 class="font-bold text-gray-800 mb-3">チェックリスト進捗</h3>
        <div class="w-full bg-gray-200 rounded-full h-3">
          <div id="checklist-progress-bar" class="bg-green-500 h-3 rounded-full transition-all" style="width: 0%"></div>
        </div>
        <p class="text-xs text-gray-500 mt-2" id="checklist-progress-text">0 / 17 完了</p>
      </div>
    </div>

    <!-- ===== システム管理ページ (Superadmin Only) ===== -->
    <div id="page-system" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-6"><i class="fas fa-server mr-2 text-gray-500"></i>システム管理</h1>

      <!-- システム情報 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">API バージョン</p>
              <p class="text-xl font-bold text-gray-800 mt-1">v1.0.0</p>
            </div>
            <div class="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-code text-green-600"></i>
            </div>
          </div>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">ランタイム</p>
              <p class="text-xl font-bold text-gray-800 mt-1">Cloudflare Workers</p>
            </div>
            <div class="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
              <i class="fas fa-cloud text-orange-600"></i>
            </div>
          </div>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-500 text-sm">データベース</p>
              <p class="text-xl font-bold text-gray-800 mt-1">D1 SQLite</p>
            </div>
            <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <i class="fas fa-database text-blue-600"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- テーブルサイズ -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4"><i class="fas fa-table mr-2 text-gray-500"></i>データベース統計</h2>
        <div id="system-db-stats" class="text-gray-400 text-sm">読み込み中...</div>
      </div>

      <!-- Cron ジョブ情報 -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-4"><i class="fas fa-clock mr-2 text-gray-500"></i>定期ジョブ</h2>
        <div class="space-y-3 text-sm">
          <div class="flex items-center justify-between bg-gray-50 p-4 rounded-lg">
            <div>
              <p class="font-medium text-gray-800">毎日リマインダー</p>
              <p class="text-xs text-gray-500 mt-1">UTC 12:00 (JST 21:00)</p>
            </div>
            <span class="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">毎日</span>
          </div>
          <div class="flex items-center justify-between bg-gray-50 p-4 rounded-lg">
            <div>
              <p class="font-medium text-gray-800">週次レポート生成</p>
              <p class="text-xs text-gray-500 mt-1">UTC 11:00 日曜 (JST 20:00)</p>
            </div>
            <span class="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-full">毎週日曜</span>
          </div>
          <div class="flex items-center justify-between bg-gray-50 p-4 rounded-lg">
            <div>
              <p class="font-medium text-gray-800">画像確認期限切れ / セッション清掃</p>
              <p class="text-xs text-gray-500 mt-1">毎時 (0分)</p>
            </div>
            <span class="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-full">毎時</span>
          </div>
        </div>
      </div>

      <!-- API エンドポイント一覧 -->
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-bold text-gray-800 mb-4"><i class="fas fa-route mr-2 text-gray-500"></i>API エンドポイント</h2>
        <div class="space-y-2 text-sm font-mono">
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded font-sans font-medium">GET</span>
            <span class="text-gray-700">/health</span>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded font-sans font-medium">POST</span>
            <span class="text-gray-700">/api/webhooks/line</span>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded font-sans font-medium">POST</span>
            <span class="text-gray-700">/api/auth/line</span>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded font-sans font-medium">GET</span>
            <span class="text-gray-700">/api/admin/dashboard/stats</span>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded font-sans font-medium">GET</span>
            <span class="text-gray-700">/api/admin/users</span>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded font-sans font-medium">GET</span>
            <span class="text-gray-700">/api/users/me</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Rich Menu 管理ページ (Superadmin Only) ===== -->
    <div id="page-rich-menu" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-6"><i class="fas fa-bars mr-2 text-blue-500"></i>Rich Menu 管理</h1>

      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-sm text-blue-800">
        <i class="fas fa-info-circle mr-2"></i>
        LINE Rich Menu（トーク画面下部のメニュー）を管理します。作成 → 画像アップロード → デフォルト設定 の順で進めてください。
      </div>

      <!-- Rich Menu 一覧 -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-list mr-2 text-gray-500"></i>Rich Menu 一覧</h2>
          <button onclick="createRichMenu()" class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <i class="fas fa-plus mr-1"></i>新規作成
          </button>
        </div>
        <div id="rich-menu-list" class="text-gray-400 text-sm">読み込み中...</div>
      </div>

      <!-- Rich Menu 設計仕様 -->
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-bold text-gray-800 mb-4"><i class="fas fa-grid-2 mr-2 text-purple-500"></i>メニューレイアウト仕様</h2>
        <div class="grid grid-cols-3 gap-2 max-w-md mb-4">
          <div class="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
            <i class="fas fa-pen-to-square text-green-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">📝 記録</p>
          </div>
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
            <i class="fas fa-camera text-blue-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">📷 写真送信</p>
          </div>
          <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
            <i class="fas fa-weight-scale text-amber-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">⚖️ 体重記録</p>
          </div>
          <div class="bg-purple-50 border border-purple-200 rounded-lg p-3 text-center">
            <i class="fas fa-comments text-purple-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">💬 相談</p>
          </div>
          <div class="bg-teal-50 border border-teal-200 rounded-lg p-3 text-center">
            <i class="fas fa-chart-bar text-teal-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">📊 ダッシュボード</p>
          </div>
          <div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-center">
            <i class="fas fa-clipboard-list text-rose-600 text-lg mb-1"></i>
            <p class="text-xs font-medium text-gray-700">📋 問診やり直し</p>
          </div>
        </div>
        <p class="text-xs text-gray-500">画像サイズ: 2500 × 1686 px（2列3行） / chatBarText: 「メニューを開く」</p>
      </div>
    </div>

    <!-- ===== BOT/ナレッジ設定ページ (Superadmin Only) ===== -->
    <div id="page-bot-settings" class="hidden p-8">
      <h1 class="text-2xl font-bold text-gray-800 mb-6"><i class="fas fa-robot mr-2 text-purple-500"></i>BOT / ナレッジ設定</h1>

      <!-- BOT 一覧 -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-robot mr-2 text-blue-500"></i>BOT 一覧</h2>
        </div>
        <div id="bots-list" class="text-gray-400 text-sm">読み込み中...</div>
      </div>

      <!-- プロンプトエディタ -->
      <div id="prompt-editor-section" class="hidden bg-white rounded-xl shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-edit mr-2 text-green-500"></i>System Prompt エディタ</h2>
          <div class="flex gap-2">
            <span id="prompt-bot-name" class="text-sm text-gray-500"></span>
            <span id="prompt-version-badge" class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full"></span>
          </div>
        </div>
        <textarea id="prompt-editor" rows="15"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm leading-relaxed resize-y"
          placeholder="System Prompt を入力..."></textarea>
        <div class="flex items-center justify-between mt-4">
          <p class="text-xs text-gray-400">保存すると新しいバージョンが公開されます</p>
          <div class="flex gap-3">
            <button onclick="closePromptEditor()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-5 py-2 rounded-xl text-sm font-medium transition-colors">
              キャンセル
            </button>
            <button onclick="savePrompt()" class="bg-purple-500 hover:bg-purple-600 text-white px-5 py-2 rounded-xl text-sm font-medium transition-colors">
              <i class="fas fa-save mr-1"></i>保存して公開
            </button>
          </div>
        </div>
      </div>

      <!-- ナレッジベース一覧 -->
      <div class="bg-white rounded-xl shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-book mr-2 text-amber-500"></i>ナレッジベース</h2>
        </div>
        <div id="knowledge-bases-list" class="text-gray-400 text-sm">読み込み中...</div>
      </div>

      <!-- ナレッジドキュメント詳細 -->
      <div id="kb-documents-section" class="hidden bg-white rounded-xl shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-file-lines mr-2 text-teal-500"></i>ドキュメント一覧</h2>
          <span id="kb-documents-name" class="text-sm text-gray-500"></span>
        </div>
        <div id="kb-documents-list" class="text-gray-400 text-sm">読み込み中...</div>
      </div>

      <!-- BOT↔ナレッジ紐付け -->
      <div class="bg-white rounded-xl shadow p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-gray-800"><i class="fas fa-link mr-2 text-indigo-500"></i>BOT ↔ ナレッジ紐付け</h2>
        </div>
        <div id="bot-kb-links-list" class="text-gray-400 text-sm">読み込み中...</div>
      </div>
    </div>

  </div>
</div>

<!-- ========== ユーザー詳細モーダル ========== -->
<div id="user-modal" class="hidden fixed inset-0 modal-bg z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
    <div class="flex items-center justify-between p-6 pb-0">
      <h2 class="text-xl font-bold text-gray-800" id="modal-username">ユーザー詳細</h2>
      <button onclick="closeUserModal()" class="text-gray-400 hover:text-gray-600">
        <i class="fas fa-times text-xl"></i>
      </button>
    </div>
    <!-- タブナビ -->
    <div class="flex border-b px-6 mt-4" id="modal-tabs">
      <button class="modal-tab active" data-tab="overview" onclick="switchModalTab('overview')">
        <i class="fas fa-id-card mr-1"></i>概要
      </button>
      <button class="modal-tab" data-tab="records" onclick="switchModalTab('records')">
        <i class="fas fa-utensils mr-1"></i>食事記録
      </button>
      <button class="modal-tab" data-tab="photos" onclick="switchModalTab('photos')">
        <i class="fas fa-images mr-1"></i>写真
      </button>
      <button class="modal-tab" data-tab="reports" onclick="switchModalTab('reports')">
        <i class="fas fa-chart-bar mr-1"></i>レポート
      </button>
      <button class="modal-tab" data-tab="corrections" onclick="switchModalTab('corrections')">
        <i class="fas fa-history mr-1"></i>修正履歴
      </button>
      <button class="modal-tab" data-tab="debug" onclick="switchModalTab('debug')">
        <i class="fas fa-bug mr-1"></i>状態
      </button>
    </div>
    <div id="modal-content" class="overflow-y-auto p-6 flex-1">読み込み中...</div>
  </div>
</div>

<script src="/static/admin.js"></script>
</body>
</html>`
}


/**
 * LIFF エントリー HTML
 * /liff でアクセス → LIFF SDK 初期化 → ID Token 取得 → /api/auth/line で JWT 発行
 *   → localStorage に JWT 保存 → /dashboard へリダイレクト
 */
function getLiffEntryHtml(liffId: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>diet-bot — 認証中</title>
  <link rel="stylesheet" href="/static/user.css">
  <style>
    .liff-msg { font-size: 14px; color: #6b7280; margin-top: 8px; }
    .retry-btn {
      margin-top: 20px;
      background: #22c55e; color: white;
      border: none; border-radius: 10px;
      padding: 12px 28px; font-size: 15px;
      cursor: pointer;
    }
  </style>
</head>
<body>

<div id="loading-screen">
  <div class="spinner"></div>
  <p class="liff-msg" id="liff-status">LINEと連携中...</p>
</div>

<div id="auth-error-screen" style="display:none; flex-direction:column; align-items:center;">
  <i class="fas fa-exclamation-circle" style="font-size:48px;color:#ef4444;margin-bottom:12px;"></i>
  <p class="error-msg" style="font-size:15px;font-weight:600;">認証に失敗しました</p>
  <p class="liff-msg" id="error-detail"></p>
  <button class="retry-btn" onclick="location.reload()">再試行</button>
</div>

<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
(async function() {
  const LIFF_ID = '${liffId}';
  const JWT_KEY = 'dietbot_jwt';
  const setStatus = (msg) => {
    const el = document.getElementById('liff-status');
    if (el) el.textContent = msg;
  };
  const showError = (msg, detail) => {
    document.getElementById('loading-screen').style.display = 'none';
    const errScreen = document.getElementById('auth-error-screen');
    errScreen.style.display = 'flex';
    const detailEl = document.getElementById('error-detail');
    if (detailEl) detailEl.textContent = detail || '';
    const msgEl = errScreen.querySelector('.error-msg');
    if (msgEl) msgEl.textContent = msg;
  };

  try {
    if (!LIFF_ID) {
      showError('設定エラー', 'LIFF ID が設定されていません。管理者にお問い合わせください。');
      return;
    }

    setStatus('LIFF を初期化中...');
    await liff.init({ liffId: LIFF_ID });

    if (!liff.isLoggedIn()) {
      setStatus('LINE にログイン中...');
      liff.login({ redirectUri: location.href });
      return;
    }

    setStatus('認証トークンを取得中...');
    const idToken = liff.getIDToken();
    if (!idToken) {
      showError('トークン取得失敗', 'LINE IDトークンを取得できませんでした。');
      return;
    }

    setStatus('サーバーに認証中...');
    const res = await fetch('/api/auth/line', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      const code = data.error || 'UNKNOWN_ERROR';
      // USER_NOT_REGISTERED の場合は特別な画面を表示
      if (code === 'USER_NOT_REGISTERED') {
        document.getElementById('loading-screen').style.display = 'none';
        const errScreen = document.getElementById('auth-error-screen');
        errScreen.style.display = 'flex';
        errScreen.innerHTML = \`
          <i class="fas fa-user-plus" style="font-size:48px;color:#22c55e;margin-bottom:12px;"></i>
          <p style="font-size:17px;font-weight:700;color:#1f2937;">LINE連携がまだ完了していません</p>
          <p class="liff-msg" style="margin:8px 0 4px;">LINEで以下の手順を行ってください:</p>
          <div style="text-align:left;background:#f0fdf4;border-radius:12px;padding:16px 20px;margin:12px 0;max-width:320px;">
            <ol style="font-size:13px;color:#374151;line-height:2.2;margin:0;padding-left:20px;">
              <li><strong>diet-bot</strong> を友達追加する</li>
              <li>招待コードを送信する</li>
              <li>完了後にこのページを再読み込み</li>
            </ol>
          </div>
          <button class="retry-btn" onclick="location.reload()" style="margin-top:8px;">
            <i class="fas fa-redo-alt" style="margin-right:6px;"></i>再読み込み
          </button>
          <p style="font-size:11px;color:#9ca3af;margin-top:12px;">問題が続く場合は管理者にお問い合わせください</p>
        \`;
        return;
      }
      // ACCOUNT_NOT_FOUND の場合もカスタム表示
      if (code === 'ACCOUNT_NOT_FOUND') {
        document.getElementById('loading-screen').style.display = 'none';
        const errScreen = document.getElementById('auth-error-screen');
        errScreen.style.display = 'flex';
        errScreen.innerHTML = \`
          <i class="fas fa-link-slash" style="font-size:48px;color:#f59e0b;margin-bottom:12px;"></i>
          <p style="font-size:17px;font-weight:700;color:#1f2937;">アカウントが見つかりません</p>
          <div style="text-align:left;background:#fffbeb;border-radius:12px;padding:16px 20px;margin:12px 0;max-width:320px;">
            <p style="font-size:13px;color:#92400e;line-height:1.6;margin:0;">
              LINEの友達追加は確認できましたが、サービスアカウントへの紐付けが完了していません。
            </p>
            <p style="font-size:13px;color:#92400e;line-height:1.6;margin:8px 0 0;">
              しばらく待ってから再試行するか、管理者にお問い合わせください。
            </p>
          </div>
          <button class="retry-btn" onclick="location.reload()" style="margin-top:8px;">
            <i class="fas fa-redo-alt" style="margin-right:6px;"></i>再読み込み
          </button>
        \`;
        return;
      }
      // INVALID_LINE_TOKEN: トークン無効・期限切れ → LIFF再ログイン
      if (code === 'INVALID_LINE_TOKEN') {
        document.getElementById('loading-screen').style.display = 'none';
        const errScreen = document.getElementById('auth-error-screen');
        errScreen.style.display = 'flex';
        errScreen.innerHTML = \`
          <i class="fas fa-key" style="font-size:48px;color:#f59e0b;margin-bottom:12px;"></i>
          <p style="font-size:17px;font-weight:700;color:#1f2937;">認証の有効期限が切れました</p>
          <p class="liff-msg">LINEに再ログインしてください</p>
          <button class="retry-btn" onclick="if(typeof liff!=='undefined'&&liff.isLoggedIn()){liff.logout();}location.reload();" style="margin-top:16px;width:100%;max-width:320px;">
            <i class="fab fa-line" style="margin-right:6px;"></i>LINEで再ログイン
          </button>
        \`;
        return;
      }
      showError('ログインできませんでした', data.message || code);
      return;
    }

    // JWT を保存してダッシュボードへ
    localStorage.setItem(JWT_KEY, data.data.token);
    // ユーザー情報（intakeCompleted等）も保存
    if (data.data.user) {
      localStorage.setItem('dietbot_user', JSON.stringify(data.data.user));
    }
    setStatus('ダッシュボードを開いています...');
    location.href = '/dashboard';

  } catch (e) {
    console.error('[liff-entry]', e);
    showError('予期しないエラーが発生しました', e.message);
  }
})();
</script>
</body>
</html>`
}

/**
 * User Dashboard HTML
 * /dashboard でアクセス — JWT ベースの PWA
 * 実際のデータ取得は public/static/user.js が担当
 */
function getUserDashboardHtml(liffId: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#22c55e">
  <title>diet-bot — ダッシュボード</title>
  <link rel="stylesheet" href="/static/user.css">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body>

<!-- ローディング -->
<div id="loading-screen">
  <div class="spinner"></div>
  <p style="font-size:13px;color:#6b7280;margin-top:8px;">読み込み中...</p>
</div>

<!-- 認証エラー -->
<div id="auth-error-screen">
  <i class="fas fa-exclamation-circle" style="font-size:48px;color:#ef4444;margin-bottom:12px;"></i>
  <p class="error-msg" style="font-size:15px;font-weight:600;">エラーが発生しました</p>
  <p style="font-size:13px;color:#6b7280;margin-top:8px;"></p>
  <a href="/liff" style="margin-top:20px;background:#22c55e;color:white;border-radius:10px;padding:12px 28px;font-size:15px;text-decoration:none;">
    再ログイン
  </a>
</div>

<!-- アプリ本体 -->
<div id="app">
  <!-- ステータスバナー (M1-3: 問診未完了 / 停止中) -->
  <div id="status-banner" class="status-banner" style="display:none;"></div>

  <!-- ヘッダー -->
  <header class="app-header">
    <div class="logo">
      <div class="logo-icon"><i class="fas fa-leaf"></i></div>
      <span class="logo-text">diet-bot</span>
    </div>
    <div class="user-avatar js-user-avatar" onclick="switchPage('profile')">
      <img src="/static/default-avatar.svg" alt="プロフィール" onerror="this.style.display='none'">
    </div>
  </header>

  <!-- ページ: ホーム -->
  <section id="page-home" class="page-section active">
    <!-- 日付 -->
    <p style="font-size:13px;color:#6b7280;padding:8px 0 4px;" id="today-date-label">今日</p>

    <!-- 今日のサマリー -->
    <div class="card">
      <div class="card-header"><span class="card-title">今日の記録</span></div>
      <div class="card-body">
        <div class="summary-grid">
          <div class="summary-item green">
            <div class="val" id="today-calories">-</div>
            <div class="label">カロリー (kcal)</div>
          </div>
          <div class="summary-item blue">
            <div class="val" id="today-weight">-</div>
            <div class="label">体重 (kg)</div>
          </div>
        </div>
        <!-- カロリーバー -->
        <div class="calorie-bar"><div class="calorie-bar-fill" id="calorie-bar-fill" style="width:0%"></div></div>
        <p style="font-size:10px;color:#9ca3af;margin-top:4px;text-align:right;">目安: 1800 kcal</p>
        <!-- PFC -->
        <div class="pfc-row" style="margin-top:12px;">
          <div class="pfc-item p"><div class="val" id="today-protein">-</div><div class="label">P (g)</div></div>
          <div class="pfc-item f"><div class="val" id="today-fat">-</div><div class="label">F (g)</div></div>
          <div class="pfc-item c"><div class="val" id="today-carbs">-</div><div class="label">C (g)</div></div>
        </div>
      </div>
    </div>

    <!-- 体重グラフ -->
    <div class="card">
      <div class="card-header"><span class="card-title">体重推移（14日）</span></div>
      <div class="card-body">
        <div class="chart-wrap"><canvas id="weight-chart"></canvas></div>
      </div>
    </div>

    <!-- 今日の食事 -->
    <div class="card">
      <div class="card-header"><span class="card-title">今日の食事</span></div>
      <div class="card-body" id="today-meals">
        <div class="empty-state">
          <i class="fas fa-utensils"></i>
          <p>食事の記録がありません<br>LINEで写真を送って記録しましょう</p>
        </div>
      </div>
    </div>

    <!-- LINE ボタン -->
    <div style="padding: 8px 0 16px;">
      <a href="https://line.me/R/ti/p/${liffId ? '@' + liffId.split('-')[0] : ''}"
         class="line-cta" target="_blank">
        <i class="fab fa-line"></i>LINEで記録する
      </a>
    </div>
  </section>

  <!-- ページ: 過去記録 -->
  <section id="page-records" class="page-section">
    <p style="font-size:18px;font-weight:700;padding:12px 0 8px;">過去の記録</p>
    <div id="records-list">
      <div class="skeleton" style="height:56px;border-radius:12px;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:56px;border-radius:12px;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:56px;border-radius:12px;"></div>
    </div>
  </section>

  <!-- ページ: 進捗写真 -->
  <section id="page-photos" class="page-section">
    <p style="font-size:18px;font-weight:700;padding:12px 0 8px;">進捗写真</p>
    <div class="photo-grid" id="photos-grid">
      <div class="skeleton" style="height:200px;border-radius:12px;"></div>
      <div class="skeleton" style="height:200px;border-radius:12px;"></div>
    </div>
  </section>

  <!-- ページ: レポート -->
  <section id="page-report" class="page-section">
    <p style="font-size:18px;font-weight:700;padding:12px 0 8px;">週次レポート</p>
    <div id="reports-list"></div>
  </section>

  <!-- ページ: プロフィール -->
  <section id="page-profile" class="page-section">
    <div class="profile-header">
      <div class="profile-avatar js-user-avatar">
        <img src="/static/default-avatar.svg" alt="アバター" onerror="this.style.display='none'">
      </div>
      <p class="profile-name js-display-name">-</p>
      <p class="profile-sub" id="profile-userid">-</p>
      <p class="profile-sub" id="profile-joined">-</p>
    </div>

    <!-- プロフィール詳細 (JS で描画) -->
    <div id="profile-details"></div>

    <div class="settings-list">
      <div class="settings-row">
        <span class="settings-label"><i class="fas fa-robot" style="color:#22c55e;margin-right:8px;"></i>BOT 通知</span>
        <label class="toggle">
          <input type="checkbox" id="toggle-bot" checked onchange="toggleService('botEnabled', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="settings-row">
        <span class="settings-label"><i class="fas fa-pen-to-square" style="color:#3b82f6;margin-right:8px;"></i>記録モード</span>
        <label class="toggle">
          <input type="checkbox" id="toggle-record" checked onchange="toggleService('recordEnabled', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="settings-row">
        <span class="settings-label"><i class="fas fa-comments" style="color:#8b5cf6;margin-right:8px;"></i>相談モード</span>
        <label class="toggle">
          <input type="checkbox" id="toggle-consult" checked onchange="toggleService('consultEnabled', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>

    <div style="padding:16px 0;">
      <button onclick="logoutUser()"
        style="width:100%;border:1px solid #e5e7eb;background:white;color:#6b7280;
               border-radius:10px;padding:12px;font-size:14px;cursor:pointer;">
        <i class="fas fa-sign-out-alt" style="margin-right:6px;"></i>ログアウト
      </button>
    </div>
  </section>

  <!-- ボトムナビ -->
  <nav class="bottom-nav">
    <button class="nav-item active" data-page="home">
      <i class="fas fa-home"></i><span>ホーム</span>
    </button>
    <button class="nav-item" data-page="records">
      <i class="fas fa-calendar-days"></i><span>記録</span>
    </button>
    <button class="nav-item" data-page="photos">
      <i class="fas fa-images"></i><span>写真</span>
    </button>
    <button class="nav-item" data-page="report">
      <i class="fas fa-chart-bar"></i><span>レポート</span>
    </button>
    <button class="nav-item" data-page="profile">
      <i class="fas fa-user"></i><span>プロフィール</span>
    </button>
  </nav>
</div>

<!-- 記録詳細モーダル -->
<div id="record-detail-modal" style="display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.5);align-items:flex-end;justify-content:center;">
  <div style="background:white;width:100%;max-width:480px;max-height:85vh;border-radius:20px 20px 0 0;overflow:hidden;display:flex;flex-direction:column;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #f3f4f6;">
      <h3 style="font-size:16px;font-weight:700;color:#1f2937;" id="modal-date">-</h3>
      <button onclick="closeModal()" style="background:none;border:none;color:#9ca3af;font-size:20px;cursor:pointer;">
        <i class="fas fa-times"></i>
      </button>
    </div>
    <div id="modal-content" style="overflow-y:auto;padding:16px 20px;flex:1;"></div>
  </div>
</div>

<!-- Toast -->
<div id="toast"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="/static/user.js"></script>
<script>
function logoutUser() {
  localStorage.removeItem('dietbot_jwt');
  location.href = '/liff';
}
</script>
</body>
</html>`
}

// ===================================================================
// Welcome ページ HTML
// ===================================================================

function getWelcomeHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>食事指導BOT — はじめての方へ</title>
  <meta name="description" content="LINEで食事記録・AI栄養相談ができる食事指導BOT。友達追加して今日から健康管理を始めましょう。">
  <meta property="og:title" content="食事指導BOT — AIで毎日の食事をサポート">
  <meta property="og:description" content="LINEで写真を送るだけでカロリー自動計算。AIが栄養アドバイスをくれる食事管理ツール。">
  <meta property="og:type" content="website">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800&display=swap');
    body { font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif; }
    .hero-gradient {
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 50%, #15803d 100%);
    }
    .glass-card {
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.3);
    }
    .step-num {
      width: 40px; height: 40px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 18px;
      flex-shrink: 0;
    }
    .feature-icon {
      width: 56px; height: 56px;
      border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px;
      flex-shrink: 0;
    }
    .line-btn {
      background: #06C755;
      color: white;
      font-weight: 700;
      font-size: 17px;
      padding: 16px 32px;
      border-radius: 14px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 14px rgba(6,199,85,0.4);
    }
    .line-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(6,199,85,0.5); }
    .line-btn:active { transform: translateY(0); }
    .qr-glow {
      box-shadow: 0 0 0 8px rgba(34,197,94,0.1), 0 4px 20px rgba(0,0,0,0.08);
    }
    .fade-in { animation: fadeIn 0.6s ease-out forwards; opacity: 0; }
    @keyframes fadeIn {
      to { opacity: 1; transform: translateY(0); }
    }
    .fade-in { transform: translateY(16px); }
    .float-cta {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(10px);
      border-top: 1px solid #e5e7eb;
      padding: 12px 16px;
      z-index: 50;
      display: flex; justify-content: center;
    }
    @media (min-width: 768px) { .float-cta { display: none; } }
  </style>
</head>
<body class="bg-gray-50">

<!-- ===== Hero ===== -->
<section class="hero-gradient text-white">
  <div class="max-w-4xl mx-auto px-5 pt-12 pb-16 md:pt-20 md:pb-24 text-center">
    <div class="fade-in" style="animation-delay:0.1s;">
      <div class="inline-flex items-center gap-2 bg-white/20 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
        <i class="fas fa-sparkles"></i>
        <span>AI×LINE で食事管理</span>
      </div>
      <h1 class="text-3xl md:text-5xl font-extrabold leading-tight mb-4">
        食事指導BOT
      </h1>
      <p class="text-lg md:text-xl text-green-100 max-w-xl mx-auto leading-relaxed mb-8">
        LINEで写真を送るだけ。<br class="md:hidden">
        AIがカロリー計算・栄養アドバイスを<br class="md:hidden">
        毎日サポートします。
      </p>
    </div>

    <!-- CTA -->
    <div class="fade-in" style="animation-delay:0.25s;">
      <a href="https://lin.ee/n4PoXrR" target="_blank" rel="noopener" class="line-btn text-lg">
        <i class="fab fa-line text-2xl"></i>
        友達追加して始める
      </a>
      <p class="text-green-200 text-sm mt-3">無料 &middot; 30秒で登録完了</p>
    </div>
  </div>
</section>

<!-- ===== QR + ID ===== -->
<section class="max-w-4xl mx-auto px-5 -mt-10 relative z-10">
  <div class="glass-card rounded-2xl shadow-xl p-6 md:p-8 fade-in" style="animation-delay:0.35s;">
    <div class="flex flex-col md:flex-row items-center gap-6 md:gap-10">
      <div class="flex-shrink-0">
        <img src="/static/qr-line-friend.png" alt="LINE友達追加QRコード" class="w-40 h-40 md:w-48 md:h-48 rounded-2xl qr-glow">
      </div>
      <div class="text-center md:text-left">
        <h2 class="text-xl font-bold text-gray-800 mb-2">QRコードで友達追加</h2>
        <p class="text-gray-500 text-sm mb-4">スマホのカメラまたはLINEの<br>「友だち追加」からスキャンしてください</p>
        <div class="flex flex-col sm:flex-row items-center gap-3">
          <a href="https://lin.ee/n4PoXrR" target="_blank" rel="noopener"
            class="inline-flex items-center gap-2 bg-green-500 hover:bg-green-600 text-white px-5 py-3 rounded-xl font-bold transition-colors text-sm">
            <i class="fab fa-line text-lg"></i>友達追加リンク
          </a>
          <div class="flex items-center gap-2 bg-gray-100 rounded-xl px-4 py-3">
            <span class="text-gray-500 text-sm">LINE ID:</span>
            <code class="font-bold text-gray-800">@054eyzbj</code>
            <button onclick="navigator.clipboard.writeText('@054eyzbj');this.innerHTML='<i class=\'fas fa-check text-green-500\'></i>';setTimeout(()=>this.innerHTML='<i class=\'fas fa-copy\'></i>',1500)" class="text-gray-400 hover:text-gray-600 ml-1" title="コピー">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ===== 使い方 3ステップ ===== -->
<section class="max-w-4xl mx-auto px-5 py-16 md:py-20">
  <div class="text-center mb-12">
    <p class="text-green-600 font-bold text-sm mb-2">HOW TO USE</p>
    <h2 class="text-2xl md:text-3xl font-extrabold text-gray-800">かんたん3ステップ</h2>
  </div>

  <div class="grid md:grid-cols-3 gap-6">
    <!-- Step 1 -->
    <div class="bg-white rounded-2xl shadow-sm p-6 fade-in" style="animation-delay:0.1s;">
      <div class="step-num bg-green-100 text-green-700 mb-4">1</div>
      <h3 class="font-bold text-gray-800 text-lg mb-2">友達追加</h3>
      <p class="text-gray-500 text-sm leading-relaxed">
        上のQRコード、またはLINE IDで<br>
        <strong>食事指導BOT</strong> を友達追加します。
      </p>
    </div>

    <!-- Step 2 -->
    <div class="bg-white rounded-2xl shadow-sm p-6 fade-in" style="animation-delay:0.2s;">
      <div class="step-num bg-blue-100 text-blue-700 mb-4">2</div>
      <h3 class="font-bold text-gray-800 text-lg mb-2">招待コードを送信</h3>
      <p class="text-gray-500 text-sm leading-relaxed">
        担当者から受け取った<br>
        <strong>招待コード</strong>（例: ABC-1234）を<br>
        LINEで送信してください。
      </p>
    </div>

    <!-- Step 3 -->
    <div class="bg-white rounded-2xl shadow-sm p-6 fade-in" style="animation-delay:0.3s;">
      <div class="step-num bg-purple-100 text-purple-700 mb-4">3</div>
      <h3 class="font-bold text-gray-800 text-lg mb-2">問診に回答して開始</h3>
      <p class="text-gray-500 text-sm leading-relaxed">
        <strong>9つの質問</strong>にLINEで答えるだけ。<br>
        約2分で完了。あとは写真を送るだけで<br>
        AIがカロリー計算します。
      </p>
    </div>
  </div>
</section>

<!-- ===== 機能紹介 ===== -->
<section class="bg-white py-16 md:py-20">
  <div class="max-w-4xl mx-auto px-5">
    <div class="text-center mb-12">
      <p class="text-green-600 font-bold text-sm mb-2">FEATURES</p>
      <h2 class="text-2xl md:text-3xl font-extrabold text-gray-800">できること</h2>
    </div>

    <div class="grid sm:grid-cols-2 gap-6">
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-green-50">
        <div class="feature-icon bg-green-100 text-green-600"><i class="fas fa-camera"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">写真で食事記録</h3>
          <p class="text-gray-500 text-sm">食事の写真を送るだけでAIがカロリー・PFC（たんぱく質・脂質・炭水化物）を自動分析</p>
        </div>
      </div>
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-blue-50">
        <div class="feature-icon bg-blue-100 text-blue-600"><i class="fas fa-weight-scale"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">体重記録</h3>
          <p class="text-gray-500 text-sm">「72.5kg」とLINEに送るだけで記録完了。体重計の写真からも自動読み取り</p>
        </div>
      </div>
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-purple-50">
        <div class="feature-icon bg-purple-100 text-purple-600"><i class="fas fa-comments"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">AI栄養相談</h3>
          <p class="text-gray-500 text-sm">「相談」と送ると相談モードに切替。AIがあなたに合わせた食事アドバイスを提案</p>
        </div>
      </div>
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-amber-50">
        <div class="feature-icon bg-amber-100 text-amber-600"><i class="fas fa-chart-line"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">ダッシュボード</h3>
          <p class="text-gray-500 text-sm">体重推移グラフ、カロリー履歴、週次レポートでモチベーションをキープ</p>
        </div>
      </div>
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-rose-50">
        <div class="feature-icon bg-rose-100 text-rose-600"><i class="fas fa-bell"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">リマインダー</h3>
          <p class="text-gray-500 text-sm">記録を忘れた日は毎晩21時にLINEでやさしくリマインド</p>
        </div>
      </div>
      <div class="flex items-start gap-4 p-5 rounded-2xl bg-teal-50">
        <div class="feature-icon bg-teal-100 text-teal-600"><i class="fas fa-file-alt"></i></div>
        <div>
          <h3 class="font-bold text-gray-800 mb-1">週次レポート</h3>
          <p class="text-gray-500 text-sm">毎週日曜日にAIが1週間の食事と体重を振り返り、パーソナルアドバイスを送信</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ===== 使い方コマンド一覧 ===== -->
<section class="max-w-4xl mx-auto px-5 py-16 md:py-20">
  <div class="text-center mb-12">
    <p class="text-green-600 font-bold text-sm mb-2">COMMANDS</p>
    <h2 class="text-2xl md:text-3xl font-extrabold text-gray-800">LINE操作ガイド</h2>
  </div>

  <div class="bg-white rounded-2xl shadow-sm overflow-hidden">
    <div class="divide-y divide-gray-100">
      <div class="flex items-center gap-4 p-5">
        <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-pen text-green-600"></i>
        </div>
        <div class="flex-1">
          <p class="font-bold text-gray-800">体重を記録する</p>
          <p class="text-sm text-gray-500 mt-0.5">例：<code class="bg-gray-100 px-2 py-0.5 rounded text-gray-700">72.5</code> または <code class="bg-gray-100 px-2 py-0.5 rounded text-gray-700">72.5kg</code></p>
        </div>
      </div>
      <div class="flex items-center gap-4 p-5">
        <div class="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-camera text-blue-600"></i>
        </div>
        <div class="flex-1">
          <p class="font-bold text-gray-800">食事を記録する</p>
          <p class="text-sm text-gray-500 mt-0.5">食事の写真を送信 → AIが自動でカロリー分析 → 「確定」で記録保存</p>
        </div>
      </div>
      <div class="flex items-center gap-4 p-5">
        <div class="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-comments text-purple-600"></i>
        </div>
        <div class="flex-1">
          <p class="font-bold text-gray-800">AIに相談する</p>
          <p class="text-sm text-gray-500 mt-0.5"><code class="bg-gray-100 px-2 py-0.5 rounded text-gray-700">相談</code> と送信 → 相談モードに切替 → 何でも聞いてみよう</p>
        </div>
      </div>
      <div class="flex items-center gap-4 p-5">
        <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-rotate text-amber-600"></i>
        </div>
        <div class="flex-1">
          <p class="font-bold text-gray-800">モードを切替</p>
          <p class="text-sm text-gray-500 mt-0.5"><code class="bg-gray-100 px-2 py-0.5 rounded text-gray-700">記録モード</code> で食事記録モードに戻る</p>
        </div>
      </div>
      <div class="flex items-center gap-4 p-5">
        <div class="w-10 h-10 bg-teal-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-gauge-high text-teal-600"></i>
        </div>
        <div class="flex-1">
          <p class="font-bold text-gray-800">ダッシュボードを見る</p>
          <p class="text-sm text-gray-500 mt-0.5">LINEメニューからダッシュボードを開くと、体重推移・カロリー・レポートを確認できます</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ===== 最後の CTA ===== -->
<section class="hero-gradient text-white py-16 md:py-20">
  <div class="max-w-2xl mx-auto px-5 text-center">
    <h2 class="text-2xl md:text-3xl font-extrabold mb-4">今日から始めてみませんか？</h2>
    <p class="text-green-100 text-lg mb-8">友達追加するだけで、すぐに使い始められます。</p>
    <a href="https://lin.ee/n4PoXrR" target="_blank" rel="noopener" class="line-btn text-lg">
      <i class="fab fa-line text-2xl"></i>
      友達追加して始める
    </a>
    <p class="text-green-200 text-sm mt-3">LINE ID: <strong>@054eyzbj</strong></p>
  </div>
</section>

<!-- ===== フッター ===== -->
<footer class="bg-gray-800 text-gray-400 py-8" style="padding-bottom:80px;">
  <div class="max-w-4xl mx-auto px-5 text-center">
    <div class="flex items-center justify-center gap-2 mb-3">
      <div class="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
        <i class="fas fa-leaf text-white text-sm"></i>
      </div>
      <span class="font-bold text-white">食事指導BOT</span>
    </div>
    <div class="space-x-4 text-sm mb-3">
      <a href="/admin" class="hover:text-white transition-colors">管理者ログイン</a>
    </div>
    <p class="text-xs text-gray-500">&copy; 2026 diet-bot. All rights reserved.</p>
  </div>
</footer>

<!-- ===== モバイル固定CTA ===== -->
<div class="float-cta">
  <a href="https://lin.ee/n4PoXrR" target="_blank" rel="noopener"
    class="flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 text-white font-bold py-3.5 px-6 rounded-xl text-sm w-full max-w-sm transition-colors">
    <i class="fab fa-line text-xl"></i>
    友達追加して始める（無料）
  </a>
</div>

<!-- Intersection Observer for fade-in -->
<script>
document.addEventListener('DOMContentLoaded', () => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.style.animationPlayState = 'running';
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.fade-in').forEach(el => {
    el.style.animationPlayState = 'paused';
    observer.observe(el);
  });
});
</script>

</body>
</html>`
}

// ===================================================================
// エクスポート
// ===================================================================

export default app
export { lineQueueConsumer as queue }
