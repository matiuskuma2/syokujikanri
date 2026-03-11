/**
 * diet-bot User PWA — メインスクリプト
 * 対象ルート: /dashboard (JWT 認証済みダッシュボード)
 *
 * 認証フロー:
 *   1. localStorage の dietbot_jwt を確認
 *   2. なければ /liff へリダイレクト（LIFF → /api/auth/line → JWT 取得）
 *   3. JWT を Authorization ヘッダーに付与して /api/users/me/* を呼ぶ
 *
 * ページ構成:
 *   #page-home     — 今日のサマリー + 体重グラフ + 食事リスト
 *   #page-records  — 過去記録一覧
 *   #page-photos   — 進捗写真ギャラリー
 *   #page-report   — 週次レポート
 *   #page-profile  — プロフィール / 設定
 */

'use strict';

// ================================================================
// 定数・ユーティリティ
// ================================================================

const API = '/api';
const JWT_KEY = 'dietbot_jwt';
const LIFF_PATH = '/liff';

/** JWT を localStorage から取得 */
function getToken() {
  return localStorage.getItem(JWT_KEY);
}

/** API 呼び出し共通ラッパー */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401) {
    // JWT 期限切れ → 再認証
    localStorage.removeItem(JWT_KEY);
    location.href = LIFF_PATH;
    return null;
  }
  return res.json();
}

/** toast 表示 */
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

/** 数値フォーマット (小数点 1 位) */
function fmt1(v) { return v != null ? Number(v).toFixed(1) : '-'; }
function fmtInt(v) { return v != null ? Math.round(v) : '-'; }

/** YYYY-MM-DD → M/D(曜) */
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00+09:00');
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getMonth()+1}/${d.getDate()}(${days[d.getDay()]})`;
}

/** 今日の日付 (JST) */
function todayJst() {
  return new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
}

/** meal_type → 日本語バッジ */
const MEAL_LABELS = {
  breakfast: ['朝食','badge-breakfast'],
  lunch:     ['昼食','badge-lunch'],
  dinner:    ['夕食','badge-dinner'],
  snack:     ['間食','badge-snack'],
  other:     ['その他','badge-other'],
};

// ================================================================
// State
// ================================================================

const state = {
  profile:   null,
  todayLog:  null,
  todayMeals: [],
  todayBodyMetrics: null,
  recentLogs: [],
  photos:    [],
  photosOffset: 0,
  photosAll:  false,
  reports:   [],
  weightChart: null,
  currentPage: 'home',
};

// ================================================================
// 初期化
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (!token) {
    // JWT なし → LIFF 認証へ
    location.href = LIFF_PATH;
    return;
  }
  initApp();
});

async function initApp() {
  try {
    // プロフィール取得（JWT 検証を兼ねる）
    const res = await apiFetch('/users/me');
    if (!res || !res.success) throw new Error('Profile fetch failed');
    state.profile = res.data;

    // ローディング非表示 / アプリ表示
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    // ユーザー表示名
    document.querySelectorAll('.js-display-name').forEach(el => {
      el.textContent = state.profile.displayName || 'ゲスト';
    });
    document.querySelectorAll('.js-user-avatar img').forEach(el => {
      if (state.profile.pictureUrl) el.src = state.profile.pictureUrl;
    });

    // ナビイベント
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        switchPage(page);
      });
    });

    // ==== 状態分岐 (M1-3) ====
    const svc = state.profile.service || {};
    if (svc.botEnabled === false) {
      // BOT 停止中
      showStatusBanner('suspended');
    } else if (svc.intakeCompleted === false) {
      // 問診未完了
      showStatusBanner('intake_pending');
    }

    // サービストグルの初期値を反映
    setToggleState('toggle-bot',     svc.botEnabled !== false);
    setToggleState('toggle-record',  svc.recordEnabled !== false);
    setToggleState('toggle-consult', svc.consultEnabled !== false);

    // 初期ページ読み込み
    await loadHomePage();
  } catch (e) {
    console.error('[initApp]', e);
    showAuthError('データの読み込みに失敗しました。再度お試しください。');
  }
}

/** 状態バナー表示 (M1-3) */
function showStatusBanner(status) {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  banner.style.display = 'block';
  if (status === 'suspended') {
    banner.className = 'status-banner suspended';
    banner.innerHTML = `
      <i class="fas fa-pause-circle"></i>
      <div>
        <div class="banner-title">BOT が停止中です</div>
        <div class="banner-desc">管理者によりサービスが一時停止されています。<br>再開をお待ちください。</div>
      </div>`;
  } else if (status === 'intake_pending') {
    banner.className = 'status-banner intake-pending';
    banner.innerHTML = `
      <i class="fas fa-clipboard-list"></i>
      <div>
        <div class="banner-title">初回問診が未完了です</div>
        <div class="banner-desc">LINEで「問診」と送って初回登録を完了してください。<br>完了すると全機能をご利用いただけます。</div>
      </div>`;
  }
}

/** チェックボックス初期値設定 */
function setToggleState(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = checked;
}

/** ページ切り替え */
function switchPage(page) {
  document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const section = document.getElementById('page-' + page);
  const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (section) section.classList.add('active');
  if (nav)     nav.classList.add('active');

  state.currentPage = page;

  if (page === 'records' && state.recentLogs.length === 0) loadRecordsPage();
  if (page === 'photos'  && state.photos.length === 0)    loadPhotosPage();
  if (page === 'report'  && state.reports.length === 0)   loadReportPage();
  if (page === 'profile')                                  loadProfilePage();
}

function showAuthError(msg) {
  document.getElementById('loading-screen').style.display = 'none';
  const el = document.getElementById('auth-error-screen');
  if (el) {
    el.style.display = 'flex';
    const msgEl = el.querySelector('.error-msg');
    if (msgEl) msgEl.textContent = msg;
  }
}

// ================================================================
// Home Page (今日のサマリー)
// ================================================================

async function loadHomePage() {
  const today = todayJst();

  // 今日の日付ヘッダー
  const dateEl = document.getElementById('today-date-label');
  if (dateEl) {
    const d = new Date(today + 'T00:00:00+09:00');
    const days = ['日','月','火','水','木','金','土'];
    dateEl.textContent = `${d.getMonth()+1}月${d.getDate()}日（${days[d.getDay()]}）`;
  }

  try {
    const res = await apiFetch(`/users/me/records/${today}`);
    if (!res || !res.success) throw new Error('Today log failed');
    const { log, meals, bodyMetrics } = res.data;
    state.todayLog = log;
    state.todayMeals = meals || [];
    state.todayBodyMetrics = bodyMetrics;

    renderTodaySummary(log, meals, bodyMetrics);
    renderMealList(meals);
  } catch (e) {
    console.error('[loadHomePage]', e);
  }

  // 体重グラフ（直近14日）
  try {
    const res = await apiFetch('/users/me/records?limit=14');
    if (res && res.success) {
      state.recentLogs = res.data.logs;
      renderWeightChart(res.data.logs);
    }
  } catch (e) {
    console.error('[weightChart]', e);
  }
}

function renderTodaySummary(log, meals, bodyMetrics) {
  // 体重
  const weight = bodyMetrics?.weight_kg;
  setTextById('today-weight', weight != null ? fmt1(weight) : '-');

  // カロリー集計
  const totalCal = meals.reduce((s, m) => s + (m.calories_kcal || 0), 0);
  const totalP   = meals.reduce((s, m) => s + (m.protein_g   || 0), 0);
  const totalF   = meals.reduce((s, m) => s + (m.fat_g       || 0), 0);
  const totalC   = meals.reduce((s, m) => s + (m.carbs_g     || 0), 0);
  setTextById('today-calories', fmtInt(totalCal));
  setTextById('today-protein',  fmtInt(totalP));
  setTextById('today-fat',      fmtInt(totalF));
  setTextById('today-carbs',    fmtInt(totalC));

  // カロリーバー (目標 1800kcal 目安)
  const bar = document.getElementById('calorie-bar-fill');
  if (bar) bar.style.width = Math.min(100, (totalCal / 1800) * 100) + '%';
}

function renderMealList(meals) {
  const container = document.getElementById('today-meals');
  if (!container) return;
  if (!meals || meals.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-utensils"></i>
        <p>食事の記録がありません<br>LINEで写真を送って記録しましょう</p>
      </div>`;
    return;
  }
  container.innerHTML = meals.map(m => {
    const [label, badgeClass] = MEAL_LABELS[m.meal_type] || ['その他','badge-other'];
    const name = m.meal_text || '記録あり';
    const kcal = m.calories_kcal != null ? `${fmtInt(m.calories_kcal)} kcal` : '- kcal';
    return `
      <div class="meal-item">
        <span class="meal-type-badge ${badgeClass}">${label}</span>
        <div class="meal-info">
          <div class="meal-name">${escHtml(name)}</div>
        </div>
        <span class="meal-kcal">${kcal}</span>
      </div>`;
  }).join('');
}

function renderWeightChart(logs) {
  const canvas = document.getElementById('weight-chart');
  if (!canvas) return;
  const points = logs
    .filter(l => l.id)   // ダミー除外
    .map(l => ({ date: l.log_date, weight: null }));  // body_metrics は別取得なので null

  // Chart.js でラベルだけ表示（体重データはキャッシュなし時は別 API が必要）
  if (typeof Chart === 'undefined') return;
  if (state.weightChart) state.weightChart.destroy();

  // 直近ログの体重は records/:date でまとめて取れないので簡易表示
  const labels = logs.slice(-14).map(l => fmtDate(l.log_date).slice(0,5));
  state.weightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '体重 (kg)',
        data: Array(labels.length).fill(null),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.1)',
        tension: 0.4, fill: true, pointRadius: 4,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          ticks: { callback: v => v != null ? v + 'kg' : '' },
          beginAtZero: false,
        },
      },
    },
  });

  // 体重データを個別に取得して埋める
  loadWeightHistory(logs);
}

async function loadWeightHistory(logs) {
  // 直近14件のログについて body_metrics を取得して体重グラフを更新
  const today = todayJst();
  const weights = [];
  const logsToFetch = logs.slice(-14);

  await Promise.allSettled(logsToFetch.map(async (log) => {
    if (log.log_date === today && state.todayBodyMetrics) {
      weights.push({ date: log.log_date, w: state.todayBodyMetrics.weight_kg });
      return;
    }
    const res = await apiFetch(`/users/me/records/${log.log_date}`);
    if (res?.success) {
      weights.push({ date: log.log_date, w: res.data.bodyMetrics?.weight_kg ?? null });
    }
  }));

  weights.sort((a, b) => a.date.localeCompare(b.date));

  if (state.weightChart) {
    const dateMap = Object.fromEntries(weights.map(w => [w.date, w.w]));
    state.weightChart.data.datasets[0].data =
      state.weightChart.data.labels.map((_, i) => {
        const log = logsToFetch[i];
        return log ? (dateMap[log.log_date] ?? null) : null;
      });
    state.weightChart.update();
  }
}

// ================================================================
// Records Page (過去記録)
// ================================================================

async function loadRecordsPage() {
  const container = document.getElementById('records-list');
  if (!container) return;
  container.innerHTML = '<div class="skeleton" style="height:48px;margin-bottom:8px;"></div>'.repeat(5);

  try {
    const res = await apiFetch('/users/me/records?limit=30');
    if (!res || !res.success) throw new Error('Records fetch failed');
    state.recentLogs = res.data.logs;
    renderRecordsList(res.data.logs);
  } catch (e) {
    console.error('[loadRecordsPage]', e);
    container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>記録の取得に失敗しました</p></div>';
  }
}

function renderRecordsList(logs) {
  const container = document.getElementById('records-list');
  if (!container) return;
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-plus"></i><p>まだ記録がありません<br>LINEで記録を始めましょう</p></div>';
    return;
  }
  container.innerHTML = logs.map(log => {
    const dateStr = fmtDate(log.log_date);
    const status = log.completion_status === 'complete' ? '✅ 完了' :
                   log.completion_status === 'reviewed' ? '⭐ レビュー済み' : '📝 記録中';
    return `
      <div class="log-row" onclick="openLogDetail('${log.log_date}')">
        <div>
          <div class="log-date-label">${dateStr}</div>
          <div class="log-meta">${status}</div>
        </div>
        <div class="log-weight" id="log-weight-${log.log_date}">…</div>
      </div>`;
  }).join('');

  // 体重を非同期で埋める
  logs.slice(0,10).forEach(async log => {
    const el = document.getElementById(`log-weight-${log.log_date}`);
    if (!el) return;
    if (log.log_date === todayJst() && state.todayBodyMetrics) {
      el.textContent = state.todayBodyMetrics.weight_kg != null ? `${fmt1(state.todayBodyMetrics.weight_kg)} kg` : '-';
      return;
    }
    const res = await apiFetch(`/users/me/records/${log.log_date}`);
    if (res?.success) {
      const w = res.data.bodyMetrics?.weight_kg;
      el.textContent = w != null ? `${fmt1(w)} kg` : '-';
    }
  });
}

async function openLogDetail(date) {
  // TODO: モーダルまたはページ遷移で詳細表示
  showToast(`${fmtDate(date)} の記録を確認中…`);
}

// ================================================================
// Photos Page (進捗写真)
// ================================================================

async function loadPhotosPage() {
  const container = document.getElementById('photos-grid');
  if (!container) return;
  container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:12px;"></div>'.repeat(4);

  try {
    const res = await apiFetch('/users/me/progress-photos?limit=20');
    if (!res || !res.success) throw new Error('Photos fetch failed');
    state.photos = res.data.photos;
    renderPhotosGrid(res.data.photos);
  } catch (e) {
    console.error('[loadPhotosPage]', e);
    container.innerHTML = '<div class="empty-state"><i class="fas fa-images"></i><p>写真の取得に失敗しました</p></div>';
  }
}

function renderPhotosGrid(photos) {
  const container = document.getElementById('photos-grid');
  if (!container) return;
  if (!photos || photos.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <i class="fas fa-camera"></i>
        <p>進捗写真がありません<br>LINEで写真を送ると保存されます</p>
      </div>`;
    return;
  }
  container.innerHTML = photos.map(p => `
    <div class="photo-card" onclick="openPhoto('${p.id}')">
      <img src="${escHtml(p.viewUrl)}" alt="進捗写真" loading="lazy"
           onerror="this.parentElement.style.display='none'">
      <div class="photo-meta">
        <span class="photo-date">${fmtDate(p.photo_date)}</span>
        ${p.pose_label ? `<br>${p.pose_label}` : ''}
      </div>
    </div>`).join('');
}

function openPhoto(id) {
  const photo = state.photos.find(p => p.id === id);
  if (!photo) return;
  // 新しいタブで R2 プロキシ URL を開く
  window.open(photo.viewUrl, '_blank');
}

// ================================================================
// Report Page (週次レポート)
// ================================================================

async function loadReportPage() {
  const container = document.getElementById('reports-list');
  if (!container) return;
  container.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:12px;border-radius:16px;"></div>'.repeat(3);

  try {
    const res = await apiFetch('/users/me/weekly-reports?limit=12');
    if (!res || !res.success) throw new Error('Reports fetch failed');
    state.reports = res.data.reports;
    renderReports(res.data.reports);
  } catch (e) {
    console.error('[loadReportPage]', e);
    container.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>レポートの取得に失敗しました</p></div>';
  }
}

function renderReports(reports) {
  const container = document.getElementById('reports-list');
  if (!container) return;
  if (!reports || reports.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-chart-bar"></i>
        <p>週次レポートはまだありません<br>7日間記録を続けると自動生成されます</p>
      </div>`;
    return;
  }
  container.innerHTML = reports.map(r => {
    const start = fmtDate(r.week_start);
    const end   = fmtDate(r.week_end);
    const weightChange = r.weight_change != null
      ? (r.weight_change >= 0 ? `+${fmt1(r.weight_change)}` : fmt1(r.weight_change)) + ' kg'
      : '-';
    return `
      <div class="report-card">
        <div class="report-week">${start} 〜 ${end}</div>
        <div class="report-stats">
          <div class="report-stat">
            <div class="val">${fmt1(r.avg_weight_kg)}<small style="font-size:10px">kg</small></div>
            <div class="lbl">平均体重</div>
          </div>
          <div class="report-stat">
            <div class="val">${weightChange}</div>
            <div class="lbl">体重変化</div>
          </div>
          <div class="report-stat">
            <div class="val">${r.log_days ?? 0}<small style="font-size:10px">日</small></div>
            <div class="lbl">記録日数</div>
          </div>
        </div>
        ${r.ai_summary ? `<div class="report-summary">${escHtml(r.ai_summary)}</div>` : ''}
      </div>`;
  }).join('');
}

// ================================================================
// Profile Page
// ================================================================

function loadProfilePage() {
  if (!state.profile) return;
  const { displayName, pictureUrl, lineUserId, joinedAt } = state.profile;

  setTextById('profile-name', displayName || 'ゲスト');
  setTextById('profile-userid', `LINE ID: ${lineUserId || '-'}`);
  const joined = joinedAt ? fmtDate(joinedAt.slice(0,10)) : '-';
  setTextById('profile-joined', `利用開始: ${joined}`);

  const imgEls = document.querySelectorAll('.profile-avatar img');
  if (pictureUrl) imgEls.forEach(img => { img.src = pictureUrl; });
}

/** サービスフラグ toggle */
async function toggleService(flag, value) {
  try {
    const body = {};
    body[flag] = value;
    const res = await apiFetch('/users/me/service', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (res?.success) {
      showToast(value ? '有効にしました' : '無効にしました');
    }
  } catch(e) {
    console.error('[toggleService]', e);
    showToast('更新に失敗しました');
  }
}

// ================================================================
// ユーティリティ
// ================================================================

function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// グローバルに公開（HTML の onclick から使用）
window.switchPage    = switchPage;
window.openLogDetail = openLogDetail;
window.openPhoto     = openPhoto;
window.toggleService = toggleService;
