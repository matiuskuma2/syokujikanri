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
import adminAuthRouter from './routes/admin/auth'
import adminUsersRouter from './routes/admin/users'
import adminDashboardRouter from './routes/admin/dashboard'
import userRouter from './routes/user/index'
// import { lineQueueConsumer } from './jobs/image-analysis'  // Step 5: image analysis job
import { lineQueueConsumer } from './jobs/image-analysis'

// Cron jobs（Step 5で src/jobs/ に移動予定）
// import { runDailyReminder, runWeeklyReport } from './jobs/daily-reminder'

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
// Admin API（JWT認証必要）
// ===================================================================

app.route('/api/admin/auth', adminAuthRouter)

// 認証が必要なAdmin routes
app.use('/api/admin/*', authMiddleware)
app.route('/api/admin/users', adminUsersRouter)
app.route('/api/admin/dashboard', adminDashboardRouter)

// ===================================================================
// User API
// ===================================================================

app.route('/api/user', userRouter)

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

// User Dashboard (PWA)
app.get('/dashboard', (c) => {
  const lineUserId = c.req.query('user')
  const accountId = c.req.query('account')
  return c.html(getUserDashboardHtml(lineUserId, accountId))
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
    // Step 5 で jobs/ 実装後に有効化
    switch (event.cron) {
      case '0 21 * * *': // 毎日21時 JST → リマインダー
        console.log('[cron] daily-reminder: not yet implemented')
        break
      case '0 20 * * 0': // 毎週日曜20時 JST → 週次レポート
        console.log('[cron] weekly-report: not yet implemented')
        break
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

function getUserDashboardHtml(lineUserId?: string, accountId?: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>diet-bot マイダッシュボード</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <style>
    body { font-family: 'Hiragino Sans', 'Meiryo', sans-serif; background: #f0fdf4; }
    .card { background: white; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  </style>
</head>
<body>
  <div class="max-w-sm mx-auto p-4 pb-24">
    <!-- ヘッダー -->
    <div class="flex items-center justify-between mb-6 pt-4">
      <div>
        <h1 class="text-xl font-bold text-gray-800">マイダッシュボード</h1>
        <p class="text-sm text-gray-500" id="today-date"></p>
      </div>
      <div class="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center">
        <i class="fas fa-leaf text-white"></i>
      </div>
    </div>

    <!-- 今日のサマリー -->
    <div class="card p-4 mb-4">
      <h2 class="text-sm font-semibold text-gray-600 mb-3">今日の記録</h2>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-green-50 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-green-600" id="today-calories">-</p>
          <p class="text-xs text-gray-500">カロリー (kcal)</p>
        </div>
        <div class="bg-blue-50 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-blue-600" id="today-weight">-</p>
          <p class="text-xs text-gray-500">体重 (kg)</p>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 mt-3 text-center">
        <div><p class="text-sm font-semibold text-orange-500" id="today-protein">-</p><p class="text-xs text-gray-400">P (g)</p></div>
        <div><p class="text-sm font-semibold text-yellow-500" id="today-fat">-</p><p class="text-xs text-gray-400">F (g)</p></div>
        <div><p class="text-sm font-semibold text-purple-500" id="today-carbs">-</p><p class="text-xs text-gray-400">C (g)</p></div>
      </div>
    </div>

    <!-- 連続記録 -->
    <div class="card p-4 mb-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <i class="fas fa-fire text-orange-400 text-lg"></i>
          <span class="font-semibold text-gray-800">連続記録</span>
        </div>
        <span class="text-2xl font-bold text-orange-500"><span id="streak-days">-</span>日</span>
      </div>
    </div>

    <!-- 体重グラフ -->
    <div class="card p-4 mb-4">
      <h2 class="text-sm font-semibold text-gray-600 mb-3">体重推移（14日）</h2>
      <canvas id="weight-chart" height="150"></canvas>
    </div>

    <!-- 今日の食事 -->
    <div class="card p-4 mb-4">
      <h2 class="text-sm font-semibold text-gray-600 mb-3">今日の食事</h2>
      <div id="today-meals" class="space-y-2">
        <p class="text-gray-400 text-sm">記録なし</p>
      </div>
    </div>

    <!-- LINEで記録ボタン -->
    <div class="fixed bottom-0 left-0 right-0 bg-white border-t p-4">
      <div class="max-w-sm mx-auto">
        <a href="https://line.me/ti/p/" 
          class="block w-full bg-green-500 text-white py-3 rounded-xl text-center font-medium hover:bg-green-600">
          <i class="fab fa-line mr-2"></i>LINEで記録する
        </a>
      </div>
    </div>
  </div>

<script>
const LINE_USER_ID = '${lineUserId || ''}';
const ACCOUNT_ID = '${accountId || ''}';
const API_BASE = '/api';

let weightChart = null;

async function loadDashboard() {
  if (!LINE_USER_ID || !ACCOUNT_ID) {
    document.querySelector('.max-w-sm').innerHTML = '<div class="text-center mt-20"><p class="text-gray-500">ユーザー情報が見つかりません。</p><p class="text-sm text-gray-400">LINEから開いてください。</p></div>';
    return;
  }
  
  try {
    const res = await axios.get(API_BASE + '/user/dashboard?line_user_id=' + LINE_USER_ID + '&account_id=' + ACCOUNT_ID);
    const data = res.data.data;
    
    // 今日の日付
    document.getElementById('today-date').textContent = data.today.date;
    
    // 今日のデータ
    document.getElementById('today-calories').textContent = data.today.calories || 0;
    document.getElementById('today-weight').textContent = data.today.log?.weight_kg || '-';
    document.getElementById('today-protein').textContent = Math.round(data.today.protein_g) || 0;
    document.getElementById('today-fat').textContent = Math.round(data.today.fat_g) || 0;
    document.getElementById('today-carbs').textContent = Math.round(data.today.carbs_g) || 0;
    
    // 連続記録
    document.getElementById('streak-days').textContent = data.streak;
    
    // 体重グラフ
    if (data.weightTrend.length > 0) {
      const ctx = document.getElementById('weight-chart').getContext('2d');
      if (weightChart) weightChart.destroy();
      weightChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.weightTrend.map(d => d.date.slice(5)),
          datasets: [{
            label: '体重',
            data: data.weightTrend.map(d => d.weight),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.1)',
            tension: 0.4, fill: true, pointRadius: 3
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { ticks: { callback: v => v + 'kg' } } }
        }
      });
    } else {
      document.getElementById('weight-chart').parentElement.innerHTML += '<p class="text-gray-400 text-sm text-center mt-2">体重データなし</p>';
    }
    
    // 今日の食事
    const mealsEl = document.getElementById('today-meals');
    if (data.today.meals.length > 0) {
      mealsEl.innerHTML = data.today.meals.map(m => \`
        <div class="flex items-center justify-between py-2 border-b last:border-0">
          <div>
            <span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full mr-2">\${m.meal_type}</span>
            <span class="text-sm text-gray-700">\${m.description || '記録あり'}</span>
          </div>
          <span class="text-sm text-gray-500">\${m.estimated_calories || '?'}kcal</span>
        </div>
      \`).join('');
    }
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

// 今日の日付表示
document.getElementById('today-date').textContent = new Date().toLocaleDateString('ja-JP');
loadDashboard();
</script>
</body>
</html>`
}

// ===================================================================
// エクスポート
// ===================================================================

export default app
export { lineQueueConsumer as queue }
