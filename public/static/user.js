/**
 * diet-bot User PWA — メインスクリプト v3.0
 * 対象ルート: /dashboard (JWT 認証済みダッシュボード)
 *
 * ページ構成:
 *   #page-home     — 今日のサマリー + 体重グラフ + 食事リスト
 *   #page-records  — 過去記録一覧 + 詳細モーダル
 *   #page-photos   — 進捗写真ギャラリー
 *   #page-report   — 週次レポート
 *   #page-profile  — プロフィール / 設定
 */

'use strict';

const API = '/api';
const JWT_KEY = 'dietbot_jwt';
const LIFF_PATH = '/liff';

function getToken() { return localStorage.getItem(JWT_KEY); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem(JWT_KEY);
    location.href = LIFF_PATH;
    return null;
  }
  return res.json();
}

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function fmt1(v) { return v != null ? Number(v).toFixed(1) : '-'; }
function fmtInt(v) { return v != null ? Math.round(v) : '-'; }

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00+09:00');
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getMonth()+1}/${d.getDate()}(${days[d.getDay()]})`;
}

function fmtDateFull(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00+09:00');
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}(${days[d.getDay()]})`;
}

function todayJst() {
  return new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
}

const MEAL_LABELS = {
  breakfast: ['朝食','#f59e0b'],
  lunch:     ['昼食','#22c55e'],
  dinner:    ['夕食','#3b82f6'],
  snack:     ['間食','#8b5cf6'],
  other:     ['その他','#6b7280'],
};

const GENDER_MAP = { male: '男性', female: '女性', other: 'その他' };
const ACTIVITY_MAP = {
  sedentary: 'ほぼ運動しない',
  light: '軽い運動',
  moderate: '適度な運動',
  active: '活発に運動',
};

// ================================================================
// State
// ================================================================

const state = {
  profile: null,
  todayLog: null,
  todayMeals: [],
  todayBodyMetrics: null,
  recentLogs: [],
  photos: [],
  reports: [],
  weightChart: null,
  currentPage: 'home',
  serviceState: 'active',
};

// ================================================================
// 初期化
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  if (!getToken()) { location.href = LIFF_PATH; return; }
  initApp();
});

async function initApp() {
  try {
    const res = await apiFetch('/users/me');
    if (!res || !res.success) throw new Error('Profile fetch failed');
    state.profile = res.data;

    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    document.querySelectorAll('.js-display-name').forEach(el => {
      el.textContent = state.profile.profile?.nickname || state.profile.displayName || 'ゲスト';
    });
    document.querySelectorAll('.js-user-avatar img').forEach(el => {
      if (state.profile.pictureUrl) el.src = state.profile.pictureUrl;
    });

    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });

    const svc = state.profile.service || {};
    state.serviceState = getServiceState(svc);

    if (state.serviceState === 'suspended') { showSuspendedScreen(); return; }
    if (state.serviceState === 'intake_pending') { showStatusBanner('intake_pending'); disableDataPages(); }

    setToggleState('toggle-bot', svc.botEnabled !== false);
    setToggleState('toggle-record', svc.recordEnabled !== false);
    setToggleState('toggle-consult', svc.consultEnabled !== false);

    if (state.serviceState === 'active') await loadHomePage();
  } catch (e) {
    console.error('[initApp]', e);
    showAuthError('データの読み込みに失敗しました。再度お試しください。');
  }
}

function getServiceState(svc) {
  if (svc.botEnabled === false) return 'suspended';
  if (svc.intakeCompleted === false) return 'intake_pending';
  return 'active';
}

function showStatusBanner(status) {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  banner.style.display = 'block';
  if (status === 'intake_pending') {
    banner.className = 'status-banner intake-pending';
    banner.innerHTML = `<i class="fas fa-clipboard-list"></i><div><div class="banner-title">初回問診が未完了です</div><div class="banner-desc">LINEで「問診」と送って初回登録を完了してください。</div></div>`;
  }
}

function showSuspendedScreen() {
  const sections = document.querySelectorAll('.page-section, .bottom-nav');
  sections.forEach(el => el.style.display = 'none');
  const banner = document.getElementById('status-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.className = 'status-banner suspended';
    banner.style.margin = '40px 16px';
    banner.innerHTML = `<i class="fas fa-pause-circle" style="font-size:40px;"></i><div><div class="banner-title" style="font-size:18px;">サービス停止中</div><div class="banner-desc" style="font-size:14px;margin-top:8px;">管理者によりサービスが一時停止されています。再開をお待ちください。</div></div>`;
  }
}

function disableDataPages() {
  const homeSection = document.getElementById('page-home');
  if (homeSection) {
    homeSection.innerHTML = `<div class="card" style="margin-top:8px;"><div class="card-body" style="text-align:center;padding:32px 16px;"><i class="fas fa-clipboard-list" style="font-size:48px;color:#f59e0b;margin-bottom:16px;"></i><p style="font-size:16px;font-weight:700;color:#92400e;margin-bottom:8px;">初回問診を完了してください</p><p style="font-size:13px;color:#6b7280;line-height:1.8;">LINEで「問診」と送ると9問の簡単なアンケートが始まります。</p></div></div>`;
  }
  ['records','photos','report'].forEach(page => {
    const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (nav) { nav.style.opacity = '0.4'; nav.style.pointerEvents = 'none'; }
  });
}

function setToggleState(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = checked;
}

function switchPage(page) {
  if (state.serviceState === 'intake_pending' && ['records','photos','report'].includes(page)) {
    showToast('問診を完了してからご利用ください');
    return;
  }
  document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const section = document.getElementById('page-' + page);
  const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (section) section.classList.add('active');
  if (nav) nav.classList.add('active');
  state.currentPage = page;

  if (page === 'records' && state.recentLogs.length === 0) loadRecordsPage();
  if (page === 'photos' && state.photos.length === 0) loadPhotosPage();
  if (page === 'report' && state.reports.length === 0) loadReportPage();
  if (page === 'profile') loadProfilePage();
}

function showAuthError(msg) {
  document.getElementById('loading-screen').style.display = 'none';
  const el = document.getElementById('auth-error-screen');
  if (el) { el.style.display = 'flex'; el.querySelector('.error-msg').textContent = msg; }
}

// ================================================================
// Home Page
// ================================================================

async function loadHomePage() {
  const today = todayJst();
  const dateEl = document.getElementById('today-date-label');
  if (dateEl) {
    const d = new Date(today + 'T00:00:00+09:00');
    const days = ['日','月','火','水','木','金','土'];
    dateEl.textContent = `${d.getMonth()+1}月${d.getDate()}日（${days[d.getDay()]}）`;
  }

  // 今日のデータ + 体重履歴を並行取得
  const [todayRes, weightRes] = await Promise.allSettled([
    apiFetch(`/users/me/records/${today}`),
    apiFetch('/users/me/weight-history?limit=30'),
  ]);

  if (todayRes.status === 'fulfilled' && todayRes.value?.success) {
    const { meals, bodyMetrics } = todayRes.value.data;
    state.todayMeals = meals || [];
    state.todayBodyMetrics = bodyMetrics;
    renderTodaySummary(meals, bodyMetrics);
    renderMealList(meals);
  }

  if (weightRes.status === 'fulfilled' && weightRes.value?.success) {
    renderWeightChart(weightRes.value.data.history);
  }
}

function renderTodaySummary(meals, bodyMetrics) {
  const weight = bodyMetrics?.weight_kg;
  setTextById('today-weight', weight != null ? fmt1(weight) : '-');

  const totalCal = meals.reduce((s, m) => s + (m.calories_kcal || 0), 0);
  const totalP = meals.reduce((s, m) => s + (m.protein_g || 0), 0);
  const totalF = meals.reduce((s, m) => s + (m.fat_g || 0), 0);
  const totalC = meals.reduce((s, m) => s + (m.carbs_g || 0), 0);
  setTextById('today-calories', fmtInt(totalCal));
  setTextById('today-protein', fmtInt(totalP));
  setTextById('today-fat', fmtInt(totalF));
  setTextById('today-carbs', fmtInt(totalC));

  const bar = document.getElementById('calorie-bar-fill');
  if (bar) bar.style.width = Math.min(100, (totalCal / 1800) * 100) + '%';
}

function renderMealList(meals) {
  const c = document.getElementById('today-meals');
  if (!c) return;
  if (!meals || meals.length === 0) {
    c.innerHTML = `<div class="empty-state"><i class="fas fa-utensils"></i><p>食事の記録がありません<br>LINEで写真を送って記録しましょう</p></div>`;
    return;
  }
  c.innerHTML = meals.map(m => {
    const [label, color] = MEAL_LABELS[m.meal_type] || ['その他','#6b7280'];
    const name = m.meal_text || '記録あり';
    const kcal = m.calories_kcal != null ? `${fmtInt(m.calories_kcal)} kcal` : '';
    const pfc = [
      m.protein_g != null ? `P${fmtInt(m.protein_g)}` : '',
      m.fat_g != null ? `F${fmtInt(m.fat_g)}` : '',
      m.carbs_g != null ? `C${fmtInt(m.carbs_g)}` : '',
    ].filter(Boolean).join(' / ');
    const matchBadge = m.food_match_json ? (() => {
      try { const d = JSON.parse(m.food_match_json); return d.matched_count > 0 ? `<span style="font-size:9px;color:#22c55e;margin-left:4px;">📊DB${d.matched_count}品</span>` : ''; } catch { return ''; }
    })() : '';
    return `<div class="meal-item"><span class="meal-type-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${label}</span><div class="meal-info"><div class="meal-name">${escHtml(name)}${matchBadge}</div>${pfc ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px;">${pfc}</div>` : ''}</div><span class="meal-kcal">${kcal}</span></div>`;
  }).join('');
}

function renderWeightChart(history) {
  const canvas = document.getElementById('weight-chart');
  if (!canvas || typeof Chart === 'undefined' || !history || history.length === 0) {
    const wrap = canvas?.parentElement;
    if (wrap && (!history || history.length === 0)) {
      wrap.innerHTML = '<div style="text-align:center;padding:24px;color:#9ca3af;font-size:13px;"><i class="fas fa-chart-line" style="font-size:24px;margin-bottom:8px;display:block;"></i>体重データがありません</div>';
    }
    return;
  }
  if (state.weightChart) state.weightChart.destroy();

  const labels = history.map(h => fmtDate(h.log_date));
  const data = history.map(h => h.weight_kg);
  const weights = data.filter(v => v != null);
  const minW = Math.floor(Math.min(...weights) - 1);
  const maxW = Math.ceil(Math.max(...weights) + 1);

  state.weightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '体重 (kg)',
        data,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#22c55e',
        spanGaps: true,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.parsed.y != null ? ctx.parsed.y + ' kg' : '' } } },
      scales: {
        x: { ticks: { maxRotation: 0, maxTicksLimit: 7, font: { size: 10 } }, grid: { display: false } },
        y: { min: minW, max: maxW, ticks: { callback: v => v + 'kg', font: { size: 10 } } },
      },
    },
  });
}

// ================================================================
// Records Page + Detail Modal
// ================================================================

async function loadRecordsPage() {
  const c = document.getElementById('records-list');
  if (!c) return;
  c.innerHTML = '<div class="skeleton" style="height:48px;margin-bottom:8px;"></div>'.repeat(5);

  try {
    const res = await apiFetch('/users/me/records-with-meals?limit=30');
    if (!res || !res.success) throw new Error();
    state.recentLogs = res.data.logs;
    renderRecordsList(res.data.logs);
  } catch {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>記録の取得に失敗しました</p></div>';
  }
}

function renderRecordsList(logs) {
  const c = document.getElementById('records-list');
  if (!c) return;
  if (!logs || logs.length === 0) {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-plus"></i><p>まだ記録がありません<br>LINEで記録を始めましょう</p></div>';
    return;
  }
  c.innerHTML = logs.map(log => {
    const dateStr = fmtDate(log.log_date);
    const w = log.bodyMetrics?.weight_kg;
    const mealCount = log.meals?.length || 0;
    const totalCal = (log.meals || []).reduce((s, m) => s + (m.calories_kcal || 0), 0);
    return `<div class="log-row" onclick="openLogDetail('${log.log_date}')">
      <div style="flex:1">
        <div class="log-date-label">${dateStr}</div>
        <div class="log-meta">${mealCount > 0 ? `🍽${mealCount}食` : ''}${totalCal > 0 ? ` · ${fmtInt(totalCal)}kcal` : ''}</div>
      </div>
      <div class="log-weight">${w != null ? fmt1(w) + 'kg' : '-'}</div>
      <i class="fas fa-chevron-right" style="color:#d1d5db;font-size:12px;margin-left:8px;"></i>
    </div>`;
  }).join('');
}

async function openLogDetail(date) {
  const modal = document.getElementById('record-detail-modal');
  if (!modal) return;

  modal.style.display = 'flex';
  document.getElementById('modal-date').textContent = fmtDateFull(date);
  document.getElementById('modal-content').innerHTML = '<div style="text-align:center;padding:32px;"><div class="spinner"></div></div>';

  try {
    const res = await apiFetch(`/users/me/records/${date}`);
    if (!res || !res.success) throw new Error();
    const { meals, bodyMetrics } = res.data;

    let html = '';

    // 体重セクション
    if (bodyMetrics) {
      html += '<div class="modal-section">';
      html += '<div class="modal-section-title"><i class="fas fa-weight-scale" style="color:#3b82f6;margin-right:6px;"></i>体型データ</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">';
      if (bodyMetrics.weight_kg != null)
        html += `<div style="background:#f0f9ff;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#1e40af;">${fmt1(bodyMetrics.weight_kg)}</div><div style="font-size:11px;color:#6b7280;">体重 (kg)</div></div>`;
      if (bodyMetrics.body_fat_percent != null)
        html += `<div style="background:#fef3c7;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#92400e;">${fmt1(bodyMetrics.body_fat_percent)}</div><div style="font-size:11px;color:#6b7280;">体脂肪率 (%)</div></div>`;
      if (bodyMetrics.waist_cm != null)
        html += `<div style="background:#ecfdf5;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#065f46;">${fmt1(bodyMetrics.waist_cm)}</div><div style="font-size:11px;color:#6b7280;">ウエスト (cm)</div></div>`;
      if (bodyMetrics.temperature_c != null)
        html += `<div style="background:#fef2f2;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#991b1b;">${fmt1(bodyMetrics.temperature_c)}</div><div style="font-size:11px;color:#6b7280;">体温 (℃)</div></div>`;
      html += '</div></div>';
    }

    // 食事セクション
    if (meals && meals.length > 0) {
      const totalCal = meals.reduce((s, m) => s + (m.calories_kcal || 0), 0);
      const totalP = meals.reduce((s, m) => s + (m.protein_g || 0), 0);
      const totalF = meals.reduce((s, m) => s + (m.fat_g || 0), 0);
      const totalC = meals.reduce((s, m) => s + (m.carbs_g || 0), 0);

      html += '<div class="modal-section">';
      html += `<div class="modal-section-title"><i class="fas fa-utensils" style="color:#f59e0b;margin-right:6px;"></i>食事 <span style="font-size:11px;color:#9ca3af;font-weight:400;">合計 ${fmtInt(totalCal)} kcal</span></div>`;

      // PFC サマリー
      html += `<div style="display:flex;gap:8px;margin-bottom:12px;">
        <div style="flex:1;background:#fef3c7;border-radius:8px;padding:6px;text-align:center;"><span style="font-size:14px;font-weight:700;color:#92400e;">${fmtInt(totalP)}</span><span style="font-size:10px;color:#92400e;"> g</span><div style="font-size:9px;color:#b45309;">たんぱく質</div></div>
        <div style="flex:1;background:#fce7f3;border-radius:8px;padding:6px;text-align:center;"><span style="font-size:14px;font-weight:700;color:#9d174d;">${fmtInt(totalF)}</span><span style="font-size:10px;color:#9d174d;"> g</span><div style="font-size:9px;color:#be185d;">脂質</div></div>
        <div style="flex:1;background:#dbeafe;border-radius:8px;padding:6px;text-align:center;"><span style="font-size:14px;font-weight:700;color:#1e40af;">${fmtInt(totalC)}</span><span style="font-size:10px;color:#1e40af;"> g</span><div style="font-size:9px;color:#1d4ed8;">炭水化物</div></div>
      </div>`;

      meals.forEach(m => {
        const [label, color] = MEAL_LABELS[m.meal_type] || ['その他','#6b7280'];
        const matchInfo = m.food_match_json ? (() => {
          try {
            const d = JSON.parse(m.food_match_json);
            if (d.matched_count > 0) {
              const items = (d.items || []).filter(i => i.matchScore > 0).map(i => escHtml(i.foodName || i.name)).slice(0,3).join(', ');
              return `<div style="font-size:10px;color:#16a34a;margin-top:3px;"><i class="fas fa-database" style="margin-right:3px;"></i>DB照合: ${items}</div>`;
            }
            return '';
          } catch { return ''; }
        })() : '';
        html += `<div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f3f4f6;gap:8px;">
          <span style="font-size:11px;background:${color}15;color:${color};padding:3px 8px;border-radius:8px;font-weight:600;white-space:nowrap;">${label}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;color:#374151;word-break:break-word;">${escHtml(m.meal_text || '記録あり')}</div>
            ${matchInfo}
          </div>
          <div style="font-size:12px;color:#6b7280;white-space:nowrap;text-align:right;">
            ${m.calories_kcal != null ? fmtInt(m.calories_kcal) + 'kcal' : ''}
            ${m.protein_g != null ? `<div style="font-size:9px;color:#9ca3af;">P${fmtInt(m.protein_g)} F${fmtInt(m.fat_g)} C${fmtInt(m.carbs_g)}</div>` : ''}
          </div>
        </div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="modal-section" style="color:#9ca3af;font-size:13px;text-align:center;padding:20px;"><i class="fas fa-utensils" style="font-size:20px;display:block;margin-bottom:8px;"></i>食事の記録なし</div>';
    }

    document.getElementById('modal-content').innerHTML = html || '<div style="text-align:center;color:#9ca3af;padding:24px;">この日の記録はありません</div>';
  } catch {
    document.getElementById('modal-content').innerHTML = '<div style="text-align:center;color:#ef4444;padding:24px;">データの取得に失敗しました</div>';
  }
}

function closeModal() {
  const modal = document.getElementById('record-detail-modal');
  if (modal) modal.style.display = 'none';
}

// ================================================================
// Photos Page
// ================================================================

async function loadPhotosPage() {
  const c = document.getElementById('photos-grid');
  if (!c) return;
  c.innerHTML = '<div class="skeleton" style="height:160px;border-radius:12px;"></div>'.repeat(4);

  try {
    const res = await apiFetch('/users/me/progress-photos?limit=20');
    if (!res || !res.success) throw new Error();
    state.photos = res.data.photos;
    renderPhotosGrid(res.data.photos);
  } catch {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-images"></i><p>写真の取得に失敗しました</p></div>';
  }
}

function renderPhotosGrid(photos) {
  const c = document.getElementById('photos-grid');
  if (!c) return;
  if (!photos || photos.length === 0) {
    c.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-camera"></i><p>進捗写真がありません<br>LINEで写真を送ると保存されます</p></div>';
    return;
  }
  c.innerHTML = photos.map(p => `<div class="photo-card" onclick="openPhoto('${p.id}')"><img src="${escHtml(p.viewUrl)}" alt="進捗写真" loading="lazy" onerror="this.parentElement.style.display='none'"><div class="photo-meta"><span class="photo-date">${fmtDate(p.photo_date)}</span></div></div>`).join('');
}

function openPhoto(id) {
  const photo = state.photos.find(p => p.id === id);
  if (photo) window.open(photo.viewUrl, '_blank');
}

// ================================================================
// Report Page
// ================================================================

async function loadReportPage() {
  const c = document.getElementById('reports-list');
  if (!c) return;
  c.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:12px;border-radius:16px;"></div>'.repeat(3);

  try {
    const res = await apiFetch('/users/me/weekly-reports?limit=12');
    if (!res || !res.success) throw new Error();
    state.reports = res.data.reports;
    renderReports(res.data.reports);
  } catch {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>レポートの取得に失敗しました</p></div>';
  }
}

function renderReports(reports) {
  const c = document.getElementById('reports-list');
  if (!c) return;
  if (!reports || reports.length === 0) {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>週次レポートはまだありません<br>7日間記録を続けると自動生成されます</p></div>';
    return;
  }
  c.innerHTML = reports.map(r => {
    const start = fmtDate(r.week_start);
    const end = fmtDate(r.week_end);
    const wc = r.weight_change != null ? (r.weight_change >= 0 ? `+${fmt1(r.weight_change)}` : fmt1(r.weight_change)) + 'kg' : '-';
    const wcColor = r.weight_change != null ? (r.weight_change <= 0 ? '#22c55e' : '#ef4444') : '#6b7280';
    return `<div class="report-card"><div class="report-week">${start} 〜 ${end}</div><div class="report-stats"><div class="report-stat"><div class="val">${fmt1(r.avg_weight_kg)}<small>kg</small></div><div class="lbl">平均体重</div></div><div class="report-stat"><div class="val" style="color:${wcColor}">${wc}</div><div class="lbl">体重変化</div></div><div class="report-stat"><div class="val">${r.log_days ?? 0}<small>日</small></div><div class="lbl">記録日数</div></div></div>${r.ai_summary ? `<div class="report-summary">${escHtml(r.ai_summary)}</div>` : ''}</div>`;
  }).join('');
}

// ================================================================
// Profile Page (リッチ版)
// ================================================================

function loadProfilePage() {
  if (!state.profile) return;
  const p = state.profile;
  const prof = p.profile || {};

  // 基本情報
  document.querySelectorAll('.js-display-name').forEach(el => {
    el.textContent = prof.nickname || p.displayName || 'ゲスト';
  });
  setTextById('profile-userid', `LINE: ${p.displayName || '-'}`);
  setTextById('profile-joined', `利用開始: ${p.joinedAt ? fmtDateFull(p.joinedAt.slice(0,10)) : '-'}`);

  const imgEls = document.querySelectorAll('.profile-avatar img');
  if (p.pictureUrl) imgEls.forEach(img => { img.src = p.pictureUrl; });

  // プロフィール詳細
  const detailEl = document.getElementById('profile-details');
  if (detailEl && prof.nickname) {
    const rows = [
      ['ニックネーム', prof.nickname || '-', 'fas fa-user', '#22c55e'],
      ['性別', GENDER_MAP[prof.gender] || '-', 'fas fa-venus-mars', '#8b5cf6'],
      ['年代', prof.ageRange || '-', 'fas fa-birthday-cake', '#f59e0b'],
      ['身長', prof.heightCm ? prof.heightCm + ' cm' : '-', 'fas fa-ruler-vertical', '#3b82f6'],
      ['現在体重', prof.currentWeightKg ? prof.currentWeightKg + ' kg' : '-', 'fas fa-weight-scale', '#ef4444'],
      ['目標体重', prof.targetWeightKg ? prof.targetWeightKg + ' kg' : '-', 'fas fa-bullseye', '#22c55e'],
      ['活動レベル', ACTIVITY_MAP[prof.activityLevel] || '-', 'fas fa-running', '#f97316'],
    ];
    let concerns = '-';
    if (prof.concernTags) {
      try { concerns = JSON.parse(prof.concernTags).join('、'); } catch { concerns = prof.concernTags; }
    }

    let html = `<div class="card" style="margin-top:12px;">
      <div class="card-header"><span class="card-title"><i class="fas fa-id-card" style="color:#22c55e;margin-right:6px;"></i>プロフィール</span></div>
      <div class="card-body">`;

    rows.forEach(([k, v, icon, color]) => {
      html += `<div style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;gap:10px;">
        <i class="${icon}" style="color:${color};width:16px;text-align:center;font-size:12px;"></i>
        <span style="font-size:12px;color:#6b7280;width:72px;flex-shrink:0;">${k}</span>
        <span style="font-size:13px;color:#1f2937;font-weight:500;flex:1;text-align:right;">${escHtml(v)}</span>
      </div>`;
    });

    // 目標
    if (prof.goalSummary) {
      html += `<div style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
          <i class="fas fa-star" style="color:#f59e0b;width:16px;text-align:center;font-size:12px;"></i>
          <span style="font-size:12px;color:#6b7280;">目標・理由</span>
        </div>
        <div style="font-size:13px;color:#1f2937;padding-left:26px;line-height:1.6;">${escHtml(prof.goalSummary)}</div>
      </div>`;
    }

    // 気になること
    if (concerns !== '-') {
      html += `<div style="padding:10px 0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-heart" style="color:#ef4444;width:16px;text-align:center;font-size:12px;"></i>
          <span style="font-size:12px;color:#6b7280;">気になること</span>
        </div>
        <div style="padding-left:26px;display:flex;flex-wrap:wrap;gap:4px;">
          ${concerns.split('、').map(tag => `<span style="font-size:11px;background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:10px;">${escHtml(tag)}</span>`).join('')}
        </div>
      </div>`;
    }

    html += '</div></div>';
    detailEl.innerHTML = html;
  } else if (detailEl) {
    detailEl.innerHTML = `<div class="card" style="margin-top:12px;">
      <div class="card-body" style="text-align:center;padding:24px;">
        <i class="fas fa-clipboard-list" style="font-size:32px;color:#f59e0b;margin-bottom:8px;display:block;"></i>
        <p style="font-size:14px;color:#6b7280;">プロフィールは問診完了後に表示されます</p>
      </div>
    </div>`;
  }
}

async function toggleService(flag, value) {
  try {
    const body = {};
    body[flag] = value;
    const res = await apiFetch('/users/me/service', { method: 'PATCH', body: JSON.stringify(body) });
    if (res?.success) showToast(value ? '有効にしました' : '無効にしました');
  } catch { showToast('更新に失敗しました'); }
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// グローバルに公開
window.switchPage = switchPage;
window.openLogDetail = openLogDetail;
window.closeModal = closeModal;
window.openPhoto = openPhoto;
window.toggleService = toggleService;
