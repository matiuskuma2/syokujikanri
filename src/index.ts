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

// ルートリダイレクト
app.get('/', (c) => c.redirect('/admin'))

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
    if (expired > 0 || sessions > 0) {
      console.log(`[cron] hourly cleanup: ${expired} expired image results, ${sessions} expired sessions`)
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
  </style>
</head>
<body class="bg-gray-50">

<!-- Toast通知 -->
<div id="toast-container" class="fixed bottom-4 right-4 z-50 space-y-2"></div>

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
          <h1 class="font-bold text-white text-sm">diet-bot</h1>
          <p class="text-gray-400 text-xs truncate" id="sidebar-email">-</p>
          <span id="sidebar-role-badge" class="text-xs px-2 py-0.5 rounded-full bg-gray-600 text-gray-300"></span>
        </div>
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

      <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">管理者管理</p>
      <button id="nav-staff" onclick="showPage('staff')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-user-shield w-5 text-center"></i><span>スタッフ管理</span>
      </button>

      <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">設定</p>
      <button id="nav-account" onclick="showPage('account')"
        class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
        <i class="fas fa-cog w-5 text-center"></i><span>アカウント設定</span>
      </button>

      <!-- Superadmin Only -->
      <div id="nav-system-section" class="hidden">
        <p class="text-gray-500 text-xs font-medium px-3 py-2 mt-3 uppercase tracking-wider">システム</p>
        <button id="nav-system" onclick="showPage('system')"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-gray-300 hover:bg-gray-700 transition-colors text-left">
          <i class="fas fa-server w-5 text-center"></i><span>システム管理</span>
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
          <p class="text-gray-500 text-sm mt-1">diet-bot を利用しているLINEユーザーの一覧・設定管理</p>
        </div>
      </div>
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-sm text-blue-800">
        <i class="fas fa-info-circle mr-2"></i>
        LINEユーザーはLINE公式アカウントを友達追加した際に自動的に登録されます。ここでは各ユーザーのサービス設定（BOT・記録・相談機能の有効化）を管理できます。
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

    <!-- ===== スタッフ管理ページ ===== -->
    <div id="page-staff" class="hidden p-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">スタッフ管理</h1>
          <p class="text-gray-500 text-sm mt-1">管理者・スタッフアカウントの招待と権限管理</p>
        </div>
      </div>

      <!-- 役割の説明 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs px-2 py-0.5 rounded-full role-badge-superadmin font-medium">superadmin</span>
          </div>
          <p class="text-sm font-semibold text-gray-800">スーパー管理者</p>
          <ul class="text-xs text-gray-600 mt-2 space-y-1">
            <li><i class="fas fa-check text-green-500 mr-1"></i>全機能アクセス</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>管理者の追加・削除</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>システム設定の変更</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>全ユーザーデータ閲覧</li>
          </ul>
        </div>
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs px-2 py-0.5 rounded-full role-badge-admin font-medium">admin</span>
          </div>
          <p class="text-sm font-semibold text-gray-800">管理者</p>
          <ul class="text-xs text-gray-600 mt-2 space-y-1">
            <li><i class="fas fa-check text-green-500 mr-1"></i>LINEユーザー管理</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>スタッフの招待</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>ユーザーサービス設定</li>
            <li><i class="fas fa-times text-red-400 mr-1"></i>管理者の追加・削除</li>
          </ul>
        </div>
        <div class="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs px-2 py-0.5 rounded-full role-badge-staff font-medium">staff</span>
          </div>
          <p class="text-sm font-semibold text-gray-800">スタッフ</p>
          <ul class="text-xs text-gray-600 mt-2 space-y-1">
            <li><i class="fas fa-check text-green-500 mr-1"></i>LINEユーザー閲覧</li>
            <li><i class="fas fa-check text-green-500 mr-1"></i>ダッシュボード閲覧</li>
            <li><i class="fas fa-times text-red-400 mr-1"></i>設定変更</li>
            <li><i class="fas fa-times text-red-400 mr-1"></i>招待・管理操作</li>
          </ul>
        </div>
      </div>

      <!-- 招待フォーム（admin/superadminのみ表示） -->
      <div id="invite-form-section" class="bg-white rounded-xl shadow p-6 mb-6">
        <h2 class="font-bold text-gray-800 mb-2 flex items-center gap-2">
          <i class="fas fa-envelope text-blue-600"></i> スタッフを招待する
        </h2>
        <p class="text-gray-500 text-sm mb-4">
          招待リンクをメールで送信します。受信者はそのリンクからアカウントを作成できます（48時間有効）。
        </p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl">
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">招待先メールアドレス</label>
            <input id="invite-email" type="email"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500"
              placeholder="staff@example.com">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">権限</label>
            <select id="invite-role"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500">
              <option value="staff">スタッフ</option>
              <option id="invite-role-admin-option" value="admin">管理者</option>
            </select>
          </div>
        </div>
        <div class="mt-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-600 max-w-2xl" id="role-desc">
          <i class="fas fa-info-circle mr-1"></i>
          <span id="role-desc-text">スタッフ：ユーザー閲覧のみ可能。設定変更・招待は不可。</span>
        </div>
        <div id="invite-msg" class="hidden text-sm p-3 rounded-lg mt-3 max-w-2xl"></div>
        <div class="mt-4">
          <button onclick="handleInvite()"
            class="bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-xl font-medium transition-colors">
            <i class="fas fa-paper-plane mr-2"></i>招待メールを送信
          </button>
        </div>
      </div>

      <!-- staff権限の場合は非表示メッセージ -->
      <div id="staff-no-invite" class="hidden bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6 text-sm text-yellow-800">
        <i class="fas fa-lock mr-2"></i>スタッフ権限では招待機能は使用できません。
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
    </div>
    <div id="modal-content" class="overflow-y-auto p-6 flex-1">読み込み中...</div>
  </div>
</div>

<script>
let authToken = null;
let currentAdmin = null;
let allUsers = [];
const API_BASE = '/api';

// XSS対策: HTML特殊文字エスケープ
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== 認証 =====
async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!email || !password) {
    errEl.textContent = 'メールアドレスとパスワードを入力してください。';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await axios.post(API_BASE + '/admin/auth/login', { email, password });
    authToken = res.data.data.token;
    currentAdmin = res.data.data.admin;
    localStorage.setItem('diet_bot_token', authToken);
    localStorage.setItem('diet_bot_admin', JSON.stringify(currentAdmin));
    showDashboard();
  } catch (err) {
    const msg = err.response?.data?.error || 'ログインに失敗しました。メールアドレスとパスワードを確認してください。';
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }
}

function handleLogout() {
  authToken = null; currentAdmin = null;
  localStorage.removeItem('diet_bot_token');
  localStorage.removeItem('diet_bot_admin');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard-screen').classList.add('hidden');
}

function showForgotPassword() {
  document.getElementById('forgot-modal').classList.remove('hidden');
}

async function handleForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  const msgEl = document.getElementById('forgot-msg');
  if (!email) { showMsg(msgEl, 'メールアドレスを入力してください', 'error'); return; }
  try {
    await axios.post(API_BASE + '/admin/auth/forgot-password', { email });
    showMsg(msgEl, 'リセットリンクを送信しました（登録済みメールの場合）', 'success');
  } catch {
    showMsg(msgEl, '送信に失敗しました', 'error');
  }
}

// ===== ダッシュボード表示 =====
async function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');
  if (currentAdmin) {
    document.getElementById('sidebar-email').textContent = currentAdmin.email || '-';
    const roleBadge = document.getElementById('sidebar-role-badge');
    const roleLabel = { superadmin: 'スーパー管理者', admin: '管理者', staff: 'スタッフ' }[currentAdmin.role] || currentAdmin.role;
    roleBadge.textContent = roleLabel;
    roleBadge.className = 'text-xs px-2 py-0.5 rounded-full role-badge-' + (currentAdmin.role || 'staff');
  }
  // staff権限の場合はスタッフ管理ページのメニューを制限
  if (currentAdmin?.role === 'staff') {
    const staffNavBtn = document.getElementById('nav-staff');
    if (staffNavBtn) staffNavBtn.style.opacity = '0.5';
  }
  // superadminの場合はシステム管理メニューを表示
  if (currentAdmin?.role === 'superadmin') {
    const sysSection = document.getElementById('nav-system-section');
    if (sysSection) sysSection.classList.remove('hidden');
  }
  await showPage('overview');
}

// ===== 概要 =====
async function loadOverview() {
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/stats', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const { stats, recentUsers } = res.data.data;
    document.getElementById('stat-total-users').textContent = stats.totalActiveUsers ?? 0;
    document.getElementById('stat-today-logs').textContent = stats.todayLogCount ?? 0;
    document.getElementById('stat-weekly-active').textContent = stats.weeklyActiveUsers ?? 0;
    document.getElementById('stat-intake-incomplete').textContent = stats.intakeIncompleteCount ?? 0;

    const listEl = document.getElementById('recent-users-list');
    if (!recentUsers || recentUsers.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-sm">まだLINEユーザーがいません</p>';
    } else {
      listEl.innerHTML = recentUsers.map(u => \`
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-user text-green-600"></i>
            </div>
            <div>
              <p class="font-medium text-gray-800">\${esc(u.displayName || 'Unknown')}</p>
              <p class="text-xs text-gray-500">\${esc(u.lastLogDate || '-')}</p>
            </div>
          </div>
          \${u.latestWeight ? '<span class="text-sm font-medium text-gray-600">' + esc(u.latestWeight) + 'kg</span>' : ''}
        </div>
      \`).join('');
    }
  } catch (err) {
    console.error('loadOverview error:', err);
  }
}

// ===== LINEユーザー管理 =====
async function loadUsers() {
  try {
    const res = await axios.get(API_BASE + '/admin/users', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    allUsers = res.data.data.users || [];
    renderUsersTable(allUsers);
  } catch (err) {
    console.error('loadUsers error:', err);
    document.getElementById('users-table').innerHTML = '<p class="text-red-400 text-sm">読み込みに失敗しました</p>';
  }
}

function filterUsers() {
  const q = document.getElementById('user-search').value.toLowerCase();
  const filtered = q ? allUsers.filter(u =>
    (u.display_name || '').toLowerCase().includes(q) ||
    (u.lineUserId || '').toLowerCase().includes(q)
  ) : allUsers;
  renderUsersTable(filtered);
}

function renderUsersTable(users) {
  const tableEl = document.getElementById('users-table');
  if (users.length === 0) {
    tableEl.innerHTML = '<p class="text-gray-400 text-sm py-4 text-center">ユーザーがいません</p>';
    return;
  }
  const isReadOnly = currentAdmin?.role === 'staff';
  tableEl.innerHTML = \`
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
        <th class="pb-3 pt-2 px-3">ユーザー</th>
        <th class="pb-3 pt-2 px-3">参加日</th>
        <th class="pb-3 pt-2 px-3 text-center">状態</th>
        <th class="pb-3 pt-2 px-3 text-center">BOT</th>
        <th class="pb-3 pt-2 px-3 text-center">記録</th>
        <th class="pb-3 pt-2 px-3 text-center">相談</th>
        <th class="pb-3 pt-2 px-3">操作</th>
      </tr></thead>
      <tbody>
        \${users.map(u => \`
        <tr class="border-b hover:bg-gray-50 cursor-pointer" onclick="openUserModal('\${esc(u.lineUserId)}')">
          <td class="py-3 px-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <i class="fas fa-user text-green-600 text-xs"></i>
              </div>
              <div>
                <p class="font-medium text-gray-800">\${esc(u.display_name || 'Unknown')}</p>
                <p class="text-xs text-gray-400">\${esc((u.lineUserId||'').substring(0,12))}...</p>
              </div>
            </div>
          </td>
          <td class="py-3 px-3 text-gray-500 text-xs">\${esc((u.joinedAt||'').substring(0,10))}</td>
          <td class="py-3 px-3 text-center">\${userStatusLabel(u)}</td>
          <td class="py-3 px-3 text-center">\${badge(u.botEnabled)}</td>
          <td class="py-3 px-3 text-center">\${badge(u.recordEnabled)}</td>
          <td class="py-3 px-3 text-center">\${badge(u.consultEnabled)}</td>
          <td class="py-3 px-3">
            <button onclick="event.stopPropagation();openUserModal('\${esc(u.lineUserId)}')"
              class="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1 rounded-lg transition-colors">
              詳細
            </button>
          </td>
        </tr>
        \`).join('')}
      </tbody>
    </table>
    </div>
    <p class="text-gray-400 text-xs mt-3 px-3">全 \${users.length} 件</p>
  \`;
}

function badge(val) {
  return val
    ? '<span class="inline-flex items-center justify-center w-5 h-5 bg-green-400 rounded-full" title="有効"><i class="fas fa-check text-white" style="font-size:9px"></i></span>'
    : '<span class="inline-flex items-center justify-center w-5 h-5 bg-gray-200 rounded-full" title="無効"><i class="fas fa-minus text-gray-400" style="font-size:9px"></i></span>';
}

function userStatusLabel(u) {
  // M1-5: 複合ステータスラベル — 優先度順に判定
  if (u.status === 'blocked') {
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium" title="ブロック済み">🚫 ブロック</span>';
  }
  if (!u.botEnabled) {
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium" title="管理者によりBOTが停止中">⏸ 停止中</span>';
  }
  if (!u.intakeCompleted) {
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium" title="初回問診が未完了">📋 問診未完了</span>';
  }
  // 全サービス無効チェック
  if (!u.recordEnabled && !u.consultEnabled) {
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium" title="BOT有効・記録/相談は無効">🔵 制限中</span>';
  }
  return '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium" title="全サービス利用中">✅ 利用中</span>';
}

// ===== Current modal user context =====
let modalUser = null;
let modalLineUserId = null;

async function openUserModal(lineUserId) {
  document.getElementById('user-modal').classList.remove('hidden');
  document.getElementById('modal-content').innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  modalLineUserId = lineUserId;

  // reset tabs to overview
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.modal-tab[data-tab="overview"]')?.classList.add('active');

  try {
    const res = await axios.get(API_BASE + '/admin/users/' + lineUserId, {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    modalUser = res.data.data;
    document.getElementById('modal-username').textContent = modalUser.display_name || modalUser.profile?.nickname || 'ユーザー詳細';
    renderModalOverview();
  } catch {
    document.getElementById('modal-content').innerHTML = '<p class="text-red-400">読み込みに失敗しました</p>';
  }
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(\`.modal-tab[data-tab="\${tab}"]\`)?.classList.add('active');

  if (tab === 'overview') renderModalOverview();
  else if (tab === 'records') loadModalRecords();
  else if (tab === 'photos') loadModalPhotos();
  else if (tab === 'reports') loadModalReports();
}

function renderModalOverview() {
  const u = modalUser;
  if (!u) return;
  const lineUserId = modalLineUserId;
  const logs = (u.recentLogs || []).slice(0, 7);
  const profile = u.profile;
  const answers = u.intakeAnswers || [];
  const isReadOnly = currentAdmin?.role === 'staff';

  document.getElementById('modal-content').innerHTML = \`
    <div class="grid grid-cols-2 gap-4 mb-6 text-sm">
      <div class="bg-gray-50 p-3 rounded-lg">
        <p class="text-gray-500 text-xs mb-1">LINE User ID</p>
        <p class="font-mono text-xs truncate">\${esc(lineUserId)}</p>
      </div>
      <div class="bg-gray-50 p-3 rounded-lg">
        <p class="text-gray-500 text-xs mb-1">参加日</p>
        <p class="font-medium">\${esc((u.joinedAt||'').substring(0,10))}</p>
      </div>
    </div>

    \${profile ? \`
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-id-card text-green-500 mr-1"></i>プロフィール</h3>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">ニックネーム</p>
          <p class="font-medium">\${esc(profile.nickname || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">性別</p>
          <p class="font-medium">\${{male:'男性',female:'女性',other:'その他'}[profile.gender] || '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">年代</p>
          <p class="font-medium">\${esc(profile.ageRange || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">身長</p>
          <p class="font-medium">\${profile.heightCm ? esc(profile.heightCm) + 'cm' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">現在の体重</p>
          <p class="font-medium">\${profile.currentWeightKg ? esc(profile.currentWeightKg) + 'kg' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">目標体重</p>
          <p class="font-medium">\${profile.targetWeightKg ? esc(profile.targetWeightKg) + 'kg' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg col-span-2">
          <p class="text-gray-500 text-xs mb-1">目標・理由</p>
          <p class="font-medium">\${esc(profile.goalSummary || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">気になること</p>
          <p class="font-medium">\${formatConcernTags(profile.concernTags)}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">活動レベル</p>
          <p class="font-medium">\${{sedentary:'座り仕事中心',light:'軽い運動あり',moderate:'週3〜5回運動',active:'毎日激しく運動'}[profile.activityLevel] || '-'}</p>
        </div>
      </div>
    </div>
    \` : '<div class="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800"><i class="fas fa-info-circle mr-2"></i>プロフィール未登録（問診未完了）</div>'}

    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3">サービス設定\${isReadOnly ? ' <span class="text-xs text-gray-400 font-normal">(閲覧のみ)</span>' : ''}</h3>
      <div class="grid grid-cols-2 gap-3">
        \${serviceToggle(lineUserId, 'bot_enabled', u.service?.bot_enabled, 'BOT有効', isReadOnly)}
        \${serviceToggle(lineUserId, 'record_enabled', u.service?.record_enabled, '記録機能', isReadOnly)}
        \${serviceToggle(lineUserId, 'consult_enabled', u.service?.consult_enabled, '相談機能', isReadOnly)}
        \${serviceToggle(lineUserId, 'intake_completed', u.service?.intake_completed, '問診完了', isReadOnly)}
      </div>
    </div>

    \${answers.length > 0 ? \`
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-clipboard-list text-blue-500 mr-1"></i>問診回答 (\${answers.length}件)</h3>
      <div class="space-y-2">
        \${answers.map(a => \`
          <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
            <span class="text-gray-500 text-xs w-28 flex-shrink-0">\${formatQuestionLabel(a.question_key)}</span>
            <span class="text-gray-800 font-medium text-right flex-1 ml-3">\${esc(a.answer_value || '-')}</span>
          </div>
        \`).join('')}
      </div>
    </div>
    \` : ''}

    <div>
      <h3 class="font-semibold text-gray-700 mb-3">直近の記録（7日分）</h3>
      \${logs.length === 0
        ? '<p class="text-gray-400 text-sm">記録なし</p>'
        : \`<div class="space-y-2">\${logs.map(log => \`
          <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
            <span class="text-gray-600">\${esc(log.log_date)}</span>
            <div class="flex gap-4 text-gray-500 text-xs">
              \${log.total_calories_kcal ? '<span>🔥 '+esc(log.total_calories_kcal)+'kcal</span>' : ''}
              \${log.weight_snapshot_kg ? '<span>⚖️ '+esc(log.weight_snapshot_kg)+'kg</span>' : ''}
            </div>
          </div>
        \`).join('')}</div>\`
      }
    </div>
  \`;
}

// ===== Records Tab (食事記録) =====
async function loadModalRecords() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/logs?limit=30', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const logs = res.data.data.logs || [];
    if (logs.length === 0) {
      el.innerHTML = '<div class="text-center py-8 text-gray-400"><i class="fas fa-utensils text-3xl mb-3"></i><p>食事記録がありません</p></div>';
      return;
    }
    el.innerHTML = logs.map(log => {
      const meals = log.meals || [];
      const mealHtml = meals.length > 0
        ? meals.map(m => {
            const typeLabel = {breakfast:'朝食',lunch:'昼食',dinner:'夕食',snack:'間食',other:'その他'}[m.meal_type] || m.meal_type;
            const typeColor = {breakfast:'bg-amber-100 text-amber-800',lunch:'bg-green-100 text-green-800',dinner:'bg-purple-100 text-purple-800',snack:'bg-red-100 text-red-800',other:'bg-gray-100 text-gray-700'}[m.meal_type] || 'bg-gray-100 text-gray-700';
            return \`<div class="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
              <span class="text-xs px-2 py-0.5 rounded-full \${typeColor} font-medium">\${typeLabel}</span>
              <span class="text-sm text-gray-700 flex-1">\${esc(m.meal_text || '記録あり')}</span>
              <span class="text-xs text-gray-500">\${m.calories_kcal ? esc(m.calories_kcal)+'kcal' : '-'}</span>
            </div>\`;
          }).join('')
        : '<p class="text-gray-400 text-xs py-2">食事記録なし</p>';

      return \`<div class="bg-white border rounded-xl mb-4 overflow-hidden">
        <div class="bg-gray-50 px-4 py-3 flex items-center justify-between">
          <span class="font-semibold text-sm text-gray-800">\${esc(log.log_date)}</span>
          <div class="flex gap-3 text-xs text-gray-500">
            \${log.total_calories_kcal ? '<span>🔥 '+esc(log.total_calories_kcal)+'kcal</span>' : ''}
            \${log.weight_snapshot_kg ? '<span>⚖️ '+esc(log.weight_snapshot_kg)+'kg</span>' : ''}
          </div>
        </div>
        <div class="px-4 py-2">\${mealHtml}</div>
      </div>\`;
    }).join('');
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">食事記録の取得に失敗しました</p>';
  }
}

// ===== Photos Tab (写真) =====
async function loadModalPhotos() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/photos?limit=20', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const photos = res.data.data.photos || [];

    if (photos.length === 0) {
      el.innerHTML = '<div class="text-center py-8 text-gray-400"><i class="fas fa-images text-3xl mb-3"></i><p>進捗写真がありません</p></div>';
      return;
    }

    const poseLabels = { front: '正面', side: '側面', mirror: 'ミラー', unknown: '-' };
    const typeLabels = { before: 'ビフォー', progress: '途中経過', after: 'アフター' };

    el.innerHTML = \`
      <div class="grid grid-cols-3 gap-3">
        \${photos.map(p => \`
          <div class="photo-thumb bg-gray-50 rounded-lg overflow-hidden">
            <div style="height:120px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;">
              <i class="fas fa-image text-gray-300 text-2xl"></i>
            </div>
            <div class="photo-label p-2">
              <p class="text-xs font-medium text-gray-700">\${esc(p.photo_date)}</p>
              <p class="text-xs text-gray-400">\${typeLabels[p.photo_type] || ''} \${poseLabels[p.pose_label] || ''}</p>
              \${p.note ? '<p class="text-xs text-gray-500 mt-1 truncate">' + esc(p.note) + '</p>' : ''}
            </div>
          </div>
        \`).join('')}
      </div>\`;
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">写真データの取得に失敗しました</p>';
  }
}

// ===== Reports Tab (レポート) =====
async function loadModalReports() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/reports?limit=12', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const reports = res.data.data.reports || [];

    if (reports.length === 0) {
      el.innerHTML = '<div class="text-center py-8 text-gray-400"><i class="fas fa-chart-bar text-3xl mb-3"></i><p>週次レポートがありません<br><span class="text-xs">7日間記録を続けると自動生成されます</span></p></div>';
      return;
    }

    el.innerHTML = reports.map(r => {
      const weightChange = r.weight_change != null
        ? (r.weight_change >= 0 ? '+' : '') + Number(r.weight_change).toFixed(1) + 'kg'
        : '-';
      const changeColor = r.weight_change < 0 ? 'text-green-600' : r.weight_change > 0 ? 'text-red-600' : 'text-gray-600';

      return \`<div class="bg-white border rounded-xl mb-4 overflow-hidden">
        <div class="bg-gray-50 px-4 py-3 flex items-center justify-between">
          <span class="font-semibold text-sm text-gray-800">\${esc(r.week_start)} 〜 \${esc(r.week_end)}</span>
          \${r.sent_at ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">送信済</span>' : '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">未送信</span>'}
        </div>
        <div class="px-4 py-3">
          <div class="grid grid-cols-4 gap-3 text-center mb-3">
            <div>
              <p class="text-lg font-bold text-gray-800">\${r.avg_weight_kg ? Number(r.avg_weight_kg).toFixed(1) : '-'}</p>
              <p class="text-xs text-gray-500">平均体重(kg)</p>
            </div>
            <div>
              <p class="text-lg font-bold \${changeColor}">\${weightChange}</p>
              <p class="text-xs text-gray-500">体重変化</p>
            </div>
            <div>
              <p class="text-lg font-bold text-gray-800">\${r.meal_log_count ?? 0}</p>
              <p class="text-xs text-gray-500">食事記録数</p>
            </div>
            <div>
              <p class="text-lg font-bold text-gray-800">\${r.log_days ?? 0}</p>
              <p class="text-xs text-gray-500">記録日数</p>
            </div>
          </div>
          \${r.ai_summary ? '<div class="bg-purple-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap">' + esc(r.ai_summary) + '</div>' : ''}
        </div>
      </div>\`;
    }).join('');
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">レポートデータの取得に失敗しました</p>';
  }
}

function formatConcernTags(tags) {
  if (!tags) return '-';
  try {
    const arr = JSON.parse(tags);
    return Array.isArray(arr) ? arr.map(t => esc(t)).join(', ') : esc(tags);
  } catch { return esc(tags); }
}

function formatQuestionLabel(key) {
  const labels = {
    nickname: 'ニックネーム',
    gender: '性別',
    age_range: '年代',
    height_cm: '身長',
    current_weight_kg: '現在体重',
    target_weight_kg: '目標体重',
    goal_summary: '目標・理由',
    concern_tags: '気になること',
    activity_level: '活動レベル',
  };
  return labels[key] || key;
}

function serviceToggle(lineUserId, key, val, label, isReadOnly) {
  const isOn = val === 1 || val === true;
  if (isReadOnly) {
    return \`
      <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
        <span class="text-sm text-gray-700">\${esc(label)}</span>
        <span class="w-10 h-6 rounded-full \${isOn ? 'bg-green-400' : 'bg-gray-300'} relative inline-block">
          <span class="absolute top-0.5 \${isOn ? 'right-0.5' : 'left-0.5'} w-5 h-5 bg-white rounded-full shadow"></span>
        </span>
      </div>
    \`;
  }
  return \`
    <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
      <span class="text-sm text-gray-700">\${esc(label)}</span>
      <button onclick="toggleService('\${esc(lineUserId)}','\${esc(key)}',\${isOn})"
        class="w-10 h-6 rounded-full transition-colors \${isOn ? 'bg-green-500' : 'bg-gray-300'} relative">
        <span class="absolute top-0.5 \${isOn ? 'right-0.5' : 'left-0.5'} w-5 h-5 bg-white rounded-full shadow transition-all"></span>
      </button>
    </div>
  \`;
}

async function toggleService(lineUserId, key, currentVal) {
  try {
    await axios.patch(API_BASE + '/admin/users/' + lineUserId + '/service',
      { [key]: !currentVal },
      { headers: { Authorization: 'Bearer ' + authToken } }
    );
    showToast('設定を更新しました', 'success');
    openUserModal(lineUserId);
  } catch {
    showToast('更新に失敗しました', 'error');
  }
}

function closeUserModal() {
  document.getElementById('user-modal').classList.add('hidden');
}

// ===== スタッフ管理 =====
function loadStaff() {
  const role = currentAdmin?.role;
  const inviteSection = document.getElementById('invite-form-section');
  const noInviteMsg = document.getElementById('staff-no-invite');

  if (role === 'staff') {
    inviteSection.classList.add('hidden');
    noInviteMsg.classList.remove('hidden');
  } else {
    inviteSection.classList.remove('hidden');
    noInviteMsg.classList.add('hidden');
    // superadminのみ「管理者」オプションを表示
    const adminOption = document.getElementById('invite-role-admin-option');
    if (adminOption) {
      adminOption.style.display = role === 'superadmin' ? '' : 'none';
    }
  }
  updateRoleDesc();
}

function updateRoleDesc() {
  const role = document.getElementById('invite-role')?.value;
  const descEl = document.getElementById('role-desc-text');
  if (!descEl) return;
  const descs = {
    staff: 'スタッフ：ユーザー閲覧のみ可能。設定変更・招待は不可。',
    admin: '管理者：ユーザー管理・スタッフ招待が可能。管理者の追加は不可。'
  };
  descEl.textContent = descs[role] || '';
}

async function handleInvite() {
  const email = document.getElementById('invite-email').value.trim();
  const role = document.getElementById('invite-role').value;
  const msgEl = document.getElementById('invite-msg');

  if (!email) { showMsg(msgEl, 'メールアドレスを入力してください', 'error'); return; }

  try {
    const res = await axios.post(API_BASE + '/admin/auth/invite', { email, role },
      { headers: { Authorization: 'Bearer ' + authToken } }
    );
    const inviteUrl = res.data.data.inviteUrl;
    showMsg(msgEl, \`招待メールを送信しました！（\${email}）\`, 'success');
    document.getElementById('invite-email').value = '';
    showToast('招待メールを送信しました', 'success');
    console.log('招待URL:', inviteUrl);
  } catch (err) {
    const msg = err.response?.data?.error || '招待に失敗しました';
    showMsg(msgEl, msg, 'error');
  }
}

// ===== アカウント設定 =====
async function loadAccount() {
  try {
    const res = await axios.get(API_BASE + '/admin/auth/me', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const admin = res.data.data;
    document.getElementById('admin-email').textContent = admin.email || '-';
    const roleLabels = { superadmin: 'スーパー管理者 (superadmin)', admin: '管理者 (admin)', staff: 'スタッフ (staff)' };
    document.getElementById('admin-role').textContent = roleLabels[admin.role] || admin.role || '-';
    document.getElementById('admin-last-login').textContent = admin.lastLoginAt
      ? admin.lastLoginAt.substring(0, 19).replace('T', ' ')
      : '初回ログイン';
  } catch { /* ignore */ }
}

// ===== システム管理 (Superadmin Only) =====
async function loadSystem() {
  if (currentAdmin?.role !== 'superadmin') {
    showToast('アクセス権限がありません', 'error');
    showPage('overview');
    return;
  }
  const el = document.getElementById('system-db-stats');
  if (!el) return;
  el.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...';
  try {
    const tables = ['line_users','user_accounts','user_service_statuses','user_profiles','intake_answers',
                    'daily_logs','meal_entries','body_metrics','conversation_threads','conversation_messages',
                    'message_attachments','image_analysis_jobs','image_intake_results','bot_mode_sessions',
                    'progress_photos','weekly_reports','account_memberships'];
    // Use the health endpoint to verify connectivity
    await axios.get('/health');
    
    // For DB stats, we query a system endpoint
    try {
      const res = await axios.get(API_BASE + '/admin/dashboard/db-stats', {
        headers: { Authorization: 'Bearer ' + authToken }
      });
      const stats = res.data.data?.tables || [];
      if (stats.length > 0) {
        el.innerHTML = \`
          <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
              <th class="pb-2 pt-1 px-3">テーブル名</th>
              <th class="pb-2 pt-1 px-3 text-right">行数</th>
            </tr></thead>
            <tbody>
              \${stats.map(t => \`
                <tr class="border-b hover:bg-gray-50">
                  <td class="py-2 px-3 font-mono text-xs text-gray-700">\${esc(t.name)}</td>
                  <td class="py-2 px-3 text-right text-gray-600">\${t.count?.toLocaleString()}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
          </div>
        \`;
      } else {
        el.innerHTML = '<p class="text-gray-400">テーブル情報を取得できませんでした</p>';
      }
    } catch {
      el.innerHTML = '<p class="text-gray-400">DB統計APIが未実装です。今後のアップデートで追加予定です。</p>';
    }
  } catch {
    el.innerHTML = '<p class="text-red-400">システム情報の取得に失敗しました</p>';
  }
}

async function handleChangePassword() {
  const currentPw = document.getElementById('current-password').value;
  const newPw = document.getElementById('new-password').value;
  const confirmPw = document.getElementById('confirm-password').value;
  const msgEl = document.getElementById('change-pw-msg');

  if (!currentPw || !newPw || !confirmPw) { showMsg(msgEl, '全ての項目を入力してください', 'error'); return; }
  if (newPw !== confirmPw) { showMsg(msgEl, '新しいパスワードが一致しません', 'error'); return; }
  if (newPw.length < 8) { showMsg(msgEl, 'パスワードは8文字以上にしてください', 'error'); return; }

  try {
    await axios.post(API_BASE + '/admin/auth/change-password',
      { currentPassword: currentPw, newPassword: newPw },
      { headers: { Authorization: 'Bearer ' + authToken } }
    );
    showMsg(msgEl, 'パスワードを変更しました！', 'success');
    document.getElementById('current-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    showToast('パスワードを変更しました', 'success');
  } catch (err) {
    const msg = err.response?.data?.error || 'パスワード変更に失敗しました';
    showMsg(msgEl, msg, 'error');
  }
}

// ===== ページ切替 =====
function showPage(page) {
  const pages = ['overview', 'users', 'staff', 'account', 'system'];
  pages.forEach(p => {
    const el = document.getElementById('page-' + p);
    if (el) el.classList.add('hidden');
    const nav = document.getElementById('nav-' + p);
    if (nav) {
      nav.classList.remove('bg-gray-700', 'text-white', 'nav-active');
      nav.classList.add('text-gray-300');
    }
  });
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.remove('hidden');
  const navEl = document.getElementById('nav-' + page);
  if (navEl) {
    navEl.classList.add('bg-gray-700', 'text-white');
    navEl.classList.remove('text-gray-300');
  }

  if (!authToken) {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
    return;
  }

  if (page === 'overview') loadOverview();
  else if (page === 'users') loadUsers();
  else if (page === 'staff') loadStaff();
  else if (page === 'account') loadAccount();
  else if (page === 'system') loadSystem();
}

// ===== ユーティリティ =====
function showMsg(el, msg, type) {
  el.textContent = msg;
  el.classList.remove('hidden', 'bg-green-50', 'text-green-700', 'bg-red-50', 'text-red-600');
  if (type === 'success') el.classList.add('bg-green-50', 'text-green-700');
  else el.classList.add('bg-red-50', 'text-red-600');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = \`toast px-4 py-3 rounded-xl shadow-lg text-sm font-medium \${
    type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
  }\`;
  toast.innerHTML = \`<i class="fas fa-\${type === 'success' ? 'check' : 'exclamation'} mr-2"></i>\${esc(msg)}\`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// 権限変更時の説明文更新
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'invite-role') updateRoleDesc();
});

// 初期化
window.addEventListener('load', () => {
  const savedToken = localStorage.getItem('diet_bot_token');
  const savedAdmin = localStorage.getItem('diet_bot_admin');
  if (savedToken) {
    authToken = savedToken;
    if (savedAdmin) {
      try { currentAdmin = JSON.parse(savedAdmin); } catch {}
    }
    showDashboard();
  }
});
</script>
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
          <p style="font-size:17px;font-weight:700;color:#1f2937;">まだ登録が完了していません</p>
          <p class="liff-msg" style="margin:8px 0 4px;">LINEで以下の手順を行ってください:</p>
          <div style="text-align:left;background:#f0fdf4;border-radius:12px;padding:16px 20px;margin:12px 0;max-width:320px;">
            <ol style="font-size:13px;color:#374151;line-height:2.2;margin:0;padding-left:20px;">
              <li><strong>diet-bot</strong> を友達追加する</li>
              <li>初回問診（9問）に回答する</li>
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
// エクスポート
// ===================================================================

export default app
export { lineQueueConsumer as queue }
