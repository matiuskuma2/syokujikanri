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
    .main-content { flex: 1; min-height: 100vh; }
    .stat-card { transition: transform 0.2s; }
    .stat-card:hover { transform: translateY(-2px); }
  </style>
</head>
<body class="bg-gray-50">

<!-- ログイン画面 -->
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
        <input id="email" type="email" value="admin@diet-bot.local"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
          placeholder="admin@diet-bot.local">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
        <input id="password" type="password" value="admin123"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
          placeholder="パスワード">
      </div>
      <div id="login-error" class="text-red-500 text-sm hidden"></div>
      <button onclick="handleLogin()"
        class="w-full bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600 transition-colors">
        ログイン
      </button>
    </div>
  </div>
</div>

<!-- ダッシュボード -->
<div id="dashboard-screen" class="hidden flex">
  <!-- サイドバー -->
  <div class="sidebar bg-gray-800 text-white p-4 flex flex-col">
    <div class="mb-8">
      <div class="flex items-center space-x-2">
        <div class="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
          <i class="fas fa-leaf text-white text-sm"></i>
        </div>
        <span class="font-bold text-lg">diet-bot</span>
      </div>
    </div>
    <nav class="space-y-1 flex-1">
      <a href="#" onclick="showPage('overview')" id="nav-overview"
        class="nav-item flex items-center space-x-3 px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition-colors active">
        <i class="fas fa-chart-line w-5"></i><span>概要</span>
      </a>
      <a href="#" onclick="showPage('users')" id="nav-users"
        class="nav-item flex items-center space-x-3 px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
        <i class="fas fa-users w-5"></i><span>ユーザー管理</span>
      </a>
      <a href="#" onclick="showPage('knowledge')" id="nav-knowledge"
        class="nav-item flex items-center space-x-3 px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
        <i class="fas fa-book w-5"></i><span>ナレッジ管理</span>
      </a>
    </nav>
    <button onclick="handleLogout()"
      class="flex items-center space-x-3 px-3 py-2 rounded-lg text-gray-400 hover:bg-gray-700 hover:text-white transition-colors">
      <i class="fas fa-sign-out-alt w-5"></i><span>ログアウト</span>
    </button>
  </div>

  <!-- メインコンテンツ -->
  <div class="main-content p-8 overflow-auto">
    <!-- 概要ページ -->
    <div id="page-overview">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">ダッシュボード概要</h1>
      <div class="grid grid-cols-3 gap-6 mb-8">
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between mb-4">
            <div class="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <i class="fas fa-users text-blue-600 text-xl"></i>
            </div>
            <span class="text-2xl font-bold text-gray-800" id="stat-total-users">-</span>
          </div>
          <p class="text-gray-600 text-sm">総ユーザー数</p>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between mb-4">
            <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
              <i class="fas fa-clipboard-check text-green-600 text-xl"></i>
            </div>
            <span class="text-2xl font-bold text-gray-800" id="stat-today-logs">-</span>
          </div>
          <p class="text-gray-600 text-sm">今日の記録数</p>
        </div>
        <div class="stat-card bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between mb-4">
            <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <i class="fas fa-fire text-purple-600 text-xl"></i>
            </div>
            <span class="text-2xl font-bold text-gray-800" id="stat-weekly-active">-</span>
          </div>
          <p class="text-gray-600 text-sm">週間アクティブユーザー</p>
        </div>
      </div>

      <!-- 最近のユーザー -->
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4">最近のアクティブユーザー</h2>
        <div id="recent-users-list" class="space-y-3">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ユーザー管理ページ -->
    <div id="page-users" class="hidden">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">ユーザー管理</h1>
      <div class="bg-white rounded-xl shadow">
        <div class="p-4 border-b">
          <input type="text" placeholder="ユーザーを検索..."
            class="px-4 py-2 border border-gray-300 rounded-lg w-full max-w-xs">
        </div>
        <div id="users-table" class="p-4">
          <div class="text-gray-400 text-sm">読み込み中...</div>
        </div>
      </div>
    </div>

    <!-- ナレッジ管理ページ -->
    <div id="page-knowledge" class="hidden">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">ナレッジ管理</h1>
      <div class="bg-white rounded-xl shadow p-6">
        <p class="text-gray-500">ナレッジ管理機能は開発中です。</p>
      </div>
    </div>
  </div>
</div>

<script>
let authToken = null;
const API_BASE = '/api';
const ACCOUNT_ID = 'system';

async function handleLogin() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  try {
    const res = await axios.post(API_BASE + '/admin/auth/login', { email, password });
    authToken = res.data.data.token;
    localStorage.setItem('diet_bot_token', authToken);
    showDashboard();
  } catch (err) {
    document.getElementById('login-error').textContent = 'ログインに失敗しました。';
    document.getElementById('login-error').classList.remove('hidden');
  }
}

function handleLogout() {
  authToken = null;
  localStorage.removeItem('diet_bot_token');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard-screen').classList.add('hidden');
}

async function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');
  await loadOverview();
}

async function loadOverview() {
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/summary?account_id=' + ACCOUNT_ID, {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const { summary, recent_users } = res.data.data;
    document.getElementById('stat-total-users').textContent = summary.total_users;
    document.getElementById('stat-today-logs').textContent = summary.today_logs;
    document.getElementById('stat-weekly-active').textContent = summary.weekly_active;
    
    const listEl = document.getElementById('recent-users-list');
    if (recent_users.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-sm">まだユーザーがいません</p>';
    } else {
      listEl.innerHTML = recent_users.map(u => \`
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-user text-green-600"></i>
            </div>
            <div>
              <p class="font-medium text-gray-800">\${u.nickname || u.display_name || 'Unknown'}</p>
              <p class="text-xs text-gray-500">\${u.last_active_at}</p>
            </div>
          </div>
          \${u.current_weight_kg ? '<span class="text-sm text-gray-600">' + u.current_weight_kg + 'kg</span>' : ''}
        </div>
      \`).join('');
    }
  } catch (err) {
    console.error('Load overview error:', err);
  }
}

async function loadUsers() {
  try {
    const res = await axios.get(API_BASE + '/admin/users?account_id=' + ACCOUNT_ID, {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    const { users, total } = res.data.data;
    const tableEl = document.getElementById('users-table');
    if (users.length === 0) {
      tableEl.innerHTML = '<p class="text-gray-400 text-sm">ユーザーがいません</p>';
      return;
    }
    tableEl.innerHTML = \`
      <table class="w-full text-sm">
        <thead><tr class="border-b text-left text-gray-500">
          <th class="pb-2">名前</th><th class="pb-2">最終アクティブ</th>
          <th class="pb-2">体重</th><th class="pb-2">目標</th><th class="pb-2">操作</th>
        </tr></thead>
        <tbody>
          \${users.map(u => \`<tr class="border-b hover:bg-gray-50">
            <td class="py-3 font-medium">\${u.nickname || u.display_name || 'Unknown'}</td>
            <td class="py-3 text-gray-500">\${u.last_active_at}</td>
            <td class="py-3">\${u.current_weight_kg ? u.current_weight_kg + 'kg' : '-'}</td>
            <td class="py-3">\${u.target_weight_kg ? u.target_weight_kg + 'kg' : '-'}</td>
            <td class="py-3"><button class="text-green-600 hover:underline">詳細</button></td>
          </tr>\`).join('')}
        </tbody>
      </table>
      <p class="text-gray-400 text-xs mt-2">全 \${total} 件</p>
    \`;
  } catch (err) {
    console.error('Load users error:', err);
  }
}

function showPage(page) {
  ['overview', 'users', 'knowledge'].forEach(p => {
    document.getElementById('page-' + p).classList.add('hidden');
    document.getElementById('nav-' + p).classList.remove('bg-gray-700', 'text-white');
  });
  document.getElementById('page-' + page).classList.remove('hidden');
  document.getElementById('nav-' + page).classList.add('bg-gray-700', 'text-white');
  
  if (page === 'users') loadUsers();
}

// 初期化
window.addEventListener('load', () => {
  const savedToken = localStorage.getItem('diet_bot_token');
  if (savedToken) {
    authToken = savedToken;
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
      const msgs = {
        INVALID_LINE_TOKEN: 'LINEトークンの検証に失敗しました。再ログインをお試しください。',
        USER_NOT_REGISTERED: 'このLINEアカウントはまだ登録されていません。まずBOTを友達追加してください。',
        ACCOUNT_NOT_FOUND: 'アカウント情報が見つかりません。管理者にお問い合わせください。',
      };
      showError('ログインできませんでした', msgs[code] || data.message || code);
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
