/**
 * admin.js — diet-bot 管理ダッシュボード JavaScript
 * ロール別ナビゲーション・管理者一覧・ユーザー管理・初回セットアップ
 */

// ===== グローバル状態 =====
let authToken = null;
let currentAdmin = null;
let allUsers = [];
let allMembers = [];
let modalUser = null;
let modalLineUserId = null;
let currentUserTab = 'all';
const API_BASE = '/api';

// ===== ユーティリティ =====
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showMsg(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden', 'bg-green-50', 'text-green-700', 'bg-red-50', 'text-red-600');
  if (type === 'success') el.classList.add('bg-green-50', 'text-green-700');
  else el.classList.add('bg-red-50', 'text-red-600');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
    type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
  }`;
  toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check' : 'exclamation'} mr-2"></i>${esc(msg)}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-check text-green-500"></i>';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
    showToast('コピーしました');
  });
}

function apiHeaders() {
  return { Authorization: 'Bearer ' + authToken };
}

function fmtDate(iso) {
  if (!iso) return '-';
  return iso.substring(0, 10);
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  return iso.substring(0, 19).replace('T', ' ');
}

// ================================================================
// 初回セットアップ（superadmin が存在しない場合）
// ================================================================
async function checkSetupNeeded() {
  try {
    const res = await axios.get(API_BASE + '/admin/auth/setup-status');
    return res.data?.data?.needsSetup === true;
  } catch {
    return false;
  }
}

async function handleSetup() {
  const email = document.getElementById('setup-email').value.trim();
  const password = document.getElementById('setup-password').value;
  const errEl = document.getElementById('setup-error');
  errEl.classList.add('hidden');

  if (!email || !password) {
    errEl.textContent = 'メールアドレスとパスワードを入力してください。';
    errEl.classList.remove('hidden');
    return;
  }
  if (password.length < 8) {
    errEl.textContent = 'パスワードは8文字以上で入力してください。';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await axios.post(API_BASE + '/admin/auth/register', { email, password });
    showToast('スーパー管理者アカウントを作成しました！');
    // セットアップ画面を非表示にしてログイン画面へ
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    // 自動的にログインフィールドに値を入れる
    document.getElementById('login-email').value = email;
    document.getElementById('login-password').value = password;
  } catch (err) {
    const msg = err.response?.data?.error || '作成に失敗しました';
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }
}

function showSetupScreen() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.add('hidden');
}

// ================================================================
// 認証
// ================================================================
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
    const msg = err.response?.data?.error || 'ログインに失敗しました';
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    // superadmin未登録の場合はセットアップへ案内
    if (msg.includes('Invalid credentials')) {
      checkSetupNeeded().then(needs => {
        if (needs) {
          errEl.innerHTML = msg + '<br><span class="text-xs">管理者が未登録です。<button onclick="showSetupScreen()" class="text-green-600 underline font-bold">初回セットアップ</button>から作成してください</span>';
        }
      });
    }
  }
}

function handleLogout() {
  authToken = null;
  currentAdmin = null;
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

// ================================================================
// ダッシュボード表示
// ================================================================
async function showDashboard() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');

  if (currentAdmin) {
    // アカウント名を左上に目立つように表示
    const accountNameEl = document.getElementById('sidebar-account-name');
    if (accountNameEl) {
      accountNameEl.textContent = currentAdmin.accountName || currentAdmin.email?.split('@')[0] || 'diet-bot';
    }
    document.getElementById('sidebar-email').textContent = currentAdmin.email || '-';
    const roleBadge = document.getElementById('sidebar-role-badge');
    const roleLabel = document.getElementById('sidebar-role-label');
    const roleLabelMap = { superadmin: 'スーパー管理者', admin: '管理者', staff: 'スタッフ' };
    if (roleLabel) roleLabel.textContent = roleLabelMap[currentAdmin.role] || currentAdmin.role;
    if (roleBadge) {
      const badgeClasses = {
        superadmin: 'text-xs px-3 py-1.5 rounded-full font-bold inline-flex items-center gap-1.5 bg-amber-100 text-amber-800',
        admin: 'text-xs px-3 py-1.5 rounded-full font-bold inline-flex items-center gap-1.5 bg-blue-100 text-blue-800',
        staff: 'text-xs px-3 py-1.5 rounded-full font-bold inline-flex items-center gap-1.5 bg-gray-200 text-gray-600',
      };
      const badgeIcons = {
        superadmin: '<i class="fas fa-crown text-[10px]"></i>',
        admin: '<i class="fas fa-shield-halved text-[10px]"></i>',
        staff: '<i class="fas fa-user text-[10px]"></i>',
      };
      roleBadge.className = badgeClasses[currentAdmin.role] || badgeClasses.staff;
      roleBadge.innerHTML = (badgeIcons[currentAdmin.role] || '') + ' <span id="sidebar-role-label">' + (roleLabelMap[currentAdmin.role] || currentAdmin.role) + '</span>';
    }
  }

  // ロール別メニュー表示制御
  const role = currentAdmin?.role;

  // superadmin: システム管理メニュー表示
  const sysSection = document.getElementById('nav-system-section');
  if (sysSection) sysSection.classList.toggle('hidden', role !== 'superadmin');

  // staff: 管理者管理メニュー非表示
  const membersNav = document.getElementById('nav-members');
  if (membersNav && role === 'staff') membersNav.style.display = 'none';

  // staff: 招待コードメニュー非表示（閲覧のみ可だが、発行不可なため非表示にする場合はここ）
  const inviteNav = document.getElementById('nav-invite-codes');
  if (inviteNav && role === 'staff') inviteNav.style.display = 'none';

  // ウェルカムガイドの表示（まだ閉じていない場合）
  const guideKey = 'diet_bot_guide_dismissed_' + (currentAdmin?.id || '');
  const guideDismissed = localStorage.getItem(guideKey);
  const guideEl = document.getElementById('welcome-guide');
  if (guideEl) {
    guideEl.classList.toggle('hidden', !!guideDismissed);
  }

  // ロール別ガイドの表示
  ['superadmin', 'admin', 'staff'].forEach(r => {
    const el = document.getElementById('guide-' + r);
    if (el) el.classList.toggle('hidden', r !== role);
  });

  // ガイドの説明文
  const descEl = document.getElementById('guide-role-desc');
  if (descEl) {
    const descs = {
      superadmin: 'スーパー管理者として、管理者の追加やシステム管理ができます',
      admin: '管理者として、LINEユーザーの管理やLINE登録案内ができます',
      staff: 'スタッフとして、ダッシュボードとユーザー情報の閲覧ができます',
    };
    descEl.textContent = descs[role] || '管理画面の使い方を確認しましょう';
  }

  await showPage('overview');
}

function dismissGuide() {
  const guideKey = 'diet_bot_guide_dismissed_' + (currentAdmin?.id || '');
  localStorage.setItem(guideKey, '1');
  const guideEl = document.getElementById('welcome-guide');
  if (guideEl) guideEl.classList.add('hidden');
}

// ================================================================
// ページ切替
// ================================================================
function showPage(page) {
  const pages = ['overview', 'users', 'invite-codes', 'members', 'line-guide', 'checklist', 'account', 'system'];
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
  else if (page === 'invite-codes') loadInviteCodes();
  else if (page === 'members') loadMembers();
  else if (page === 'account') loadAccount();
  else if (page === 'system') loadSystem();
  else if (page === 'checklist') updateChecklistProgress();
  // line-guide は静的なので読み込み不要
}

// ================================================================
// ダッシュボード概要
// ================================================================
async function loadOverview() {
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/stats', { headers: apiHeaders() });
    const { stats, recentUsers } = res.data.data;
    document.getElementById('stat-total-users').textContent = stats.totalActiveUsers ?? 0;
    document.getElementById('stat-today-logs').textContent = stats.todayLogCount ?? 0;
    document.getElementById('stat-weekly-active').textContent = stats.weeklyActiveUsers ?? 0;
    document.getElementById('stat-intake-incomplete').textContent = stats.intakeIncompleteCount ?? 0;

    const listEl = document.getElementById('recent-users-list');
    if (!recentUsers || recentUsers.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-sm">まだLINEユーザーがいません</p>';
    } else {
      listEl.innerHTML = recentUsers.map(u => `
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
          onclick="showPage('users')">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-user text-green-600"></i>
            </div>
            <div>
              <p class="font-medium text-gray-800">${esc(u.displayName || 'Unknown')}</p>
              <p class="text-xs text-gray-500">${esc(u.lastLogDate || '-')}</p>
            </div>
          </div>
          ${u.latestWeight ? '<span class="text-sm font-medium text-gray-600">' + esc(u.latestWeight) + 'kg</span>' : ''}
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('loadOverview error:', err);
  }
}

// ================================================================
// LINEユーザー管理
// ================================================================
async function loadUsers() {
  try {
    const res = await axios.get(API_BASE + '/admin/users', { headers: apiHeaders() });
    allUsers = res.data.data.users || [];
    updateUserCounts();
    filterUsers();
  } catch (err) {
    console.error('loadUsers error:', err);
    document.getElementById('users-table').innerHTML = '<p class="text-red-400 text-sm">読み込みに失敗しました</p>';
  }
}

function filterUsers() {
  const q = document.getElementById('user-search').value.toLowerCase();
  let filtered = allUsers;

  // タブでフィルタ
  if (currentUserTab === 'intake') {
    filtered = filtered.filter(u => !u.intakeCompleted && u.botEnabled);
  } else if (currentUserTab === 'active') {
    filtered = filtered.filter(u => u.botEnabled && u.intakeCompleted);
  } else if (currentUserTab === 'stopped') {
    filtered = filtered.filter(u => !u.botEnabled || u.status === 'blocked');
  }

  // テキスト検索
  if (q) {
    filtered = filtered.filter(u =>
      (u.display_name || '').toLowerCase().includes(q) ||
      (u.lineUserId || '').toLowerCase().includes(q) ||
      (u.adminEmail || '').toLowerCase().includes(q));
  }
  renderUsersTable(filtered);
}

function setUserTab(tab) {
  currentUserTab = tab;
  const tabs = ['all', 'intake', 'active', 'stopped'];
  tabs.forEach(t => {
    const btn = document.getElementById('user-tab-' + t);
    if (btn) {
      if (t === tab) {
        btn.className = 'px-4 py-2 rounded-xl text-sm font-medium bg-green-500 text-white transition-colors';
      } else {
        btn.className = 'px-4 py-2 rounded-xl text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors';
      }
    }
  });
  filterUsers();
}

function updateUserCounts() {
  const all = allUsers.length;
  const intake = allUsers.filter(u => !u.intakeCompleted && u.botEnabled).length;
  const active = allUsers.filter(u => u.botEnabled && u.intakeCompleted).length;
  const stopped = allUsers.filter(u => !u.botEnabled || u.status === 'blocked').length;
  const setCount = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setCount('user-count-all', all);
  setCount('user-count-intake', intake);
  setCount('user-count-active', active);
  setCount('user-count-stopped', stopped);
}

function renderUsersTable(users) {
  const tableEl = document.getElementById('users-table');
  if (users.length === 0) {
    tableEl.innerHTML = `
      <div class="text-center py-12 text-gray-400">
        <i class="fas fa-users text-4xl mb-3"></i>
        <p>LINEユーザーがまだいません</p>
        <p class="text-xs mt-2">LINE公式アカウントを友達追加したユーザーが自動的にここに表示されます</p>
        <button onclick="showPage('line-guide')" class="mt-4 bg-green-500 hover:bg-green-600 text-white px-5 py-2 rounded-xl text-sm font-medium transition-colors">
          <i class="fab fa-line mr-1"></i>LINE案内文を確認
        </button>
      </div>`;
    return;
  }
  const isSuperadmin = currentAdmin?.role === 'superadmin';
  const isReadOnly = currentAdmin?.role === 'staff';
  tableEl.innerHTML = `
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
        <th class="pb-3 pt-2 px-3">ユーザー</th>
        ${isSuperadmin ? '<th class="pb-3 pt-2 px-3">所属admin</th>' : ''}
        <th class="pb-3 pt-2 px-3">参加日</th>
        <th class="pb-3 pt-2 px-3 text-center">状態</th>
        <th class="pb-3 pt-2 px-3 text-center">BOT</th>
        <th class="pb-3 pt-2 px-3 text-center">記録</th>
        <th class="pb-3 pt-2 px-3 text-center">相談</th>
        <th class="pb-3 pt-2 px-3">操作</th>
      </tr></thead>
      <tbody>
        ${users.map(u => `
        <tr class="border-b hover:bg-gray-50 cursor-pointer" onclick="openUserModal('${esc(u.lineUserId)}')">
          <td class="py-3 px-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <i class="fas fa-user text-green-600 text-xs"></i>
              </div>
              <div>
                <p class="font-medium text-gray-800">${esc(u.display_name || 'Unknown')}</p>
                <p class="text-xs text-gray-400">${esc((u.lineUserId || '').substring(0, 12))}...</p>
              </div>
            </div>
          </td>
          ${isSuperadmin ? `<td class="py-3 px-3">
            <div class="flex items-center gap-1">
              <i class="fas fa-user-shield text-blue-400 text-xs"></i>
              <span class="text-xs text-blue-600 font-medium">${esc(u.adminEmail || '-')}</span>
            </div>
            ${u.accountName ? '<p class="text-xs text-gray-400">' + esc(u.accountName) + '</p>' : ''}
          </td>` : ''}
          <td class="py-3 px-3 text-gray-500 text-xs">${fmtDate(u.joinedAt)}</td>
          <td class="py-3 px-3 text-center">${userStatusLabel(u)}</td>
          <td class="py-3 px-3 text-center">${badge(u.botEnabled)}</td>
          <td class="py-3 px-3 text-center">${badge(u.recordEnabled)}</td>
          <td class="py-3 px-3 text-center">${badge(u.consultEnabled)}</td>
          <td class="py-3 px-3">
            <button onclick="event.stopPropagation();openUserModal('${esc(u.lineUserId)}')"
              class="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1 rounded-lg transition-colors">
              詳細
            </button>
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
    <p class="text-gray-400 text-xs mt-3 px-3">全 ${users.length} 件</p>
  `;
}

function badge(val) {
  return val
    ? '<span class="inline-flex items-center justify-center w-5 h-5 bg-green-400 rounded-full" title="有効"><i class="fas fa-check text-white" style="font-size:9px"></i></span>'
    : '<span class="inline-flex items-center justify-center w-5 h-5 bg-gray-200 rounded-full" title="無効"><i class="fas fa-minus text-gray-400" style="font-size:9px"></i></span>';
}

function userStatusLabel(u) {
  if (u.status === 'blocked')
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium">ブロック</span>';
  if (!u.botEnabled)
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">停止中</span>';
  if (!u.intakeCompleted)
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">問診未完了</span>';
  if (!u.recordEnabled && !u.consultEnabled)
    return '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">制限中</span>';
  return '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">利用中</span>';
}

// ================================================================
// ユーザー詳細モーダル
// ================================================================
async function openUserModal(lineUserId) {
  document.getElementById('user-modal').classList.remove('hidden');
  document.getElementById('modal-content').innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  modalLineUserId = lineUserId;
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.modal-tab[data-tab="overview"]')?.classList.add('active');

  try {
    const res = await axios.get(API_BASE + '/admin/users/' + lineUserId, { headers: apiHeaders() });
    modalUser = res.data.data;
    document.getElementById('modal-username').textContent = modalUser.display_name || modalUser.profile?.nickname || 'ユーザー詳細';
    renderModalOverview();
  } catch {
    document.getElementById('modal-content').innerHTML = '<p class="text-red-400">読み込みに失敗しました</p>';
  }
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.modal-tab[data-tab="${tab}"]`)?.classList.add('active');
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

  document.getElementById('modal-content').innerHTML = `
    <div class="grid grid-cols-2 gap-4 mb-6 text-sm">
      <div class="bg-gray-50 p-3 rounded-lg">
        <p class="text-gray-500 text-xs mb-1">LINE User ID</p>
        <p class="font-mono text-xs truncate">${esc(lineUserId)}</p>
      </div>
      <div class="bg-gray-50 p-3 rounded-lg">
        <p class="text-gray-500 text-xs mb-1">参加日</p>
        <p class="font-medium">${fmtDate(u.joinedAt)}</p>
      </div>
    </div>

    ${profile ? `
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-id-card text-green-500 mr-1"></i>プロフィール</h3>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">ニックネーム</p>
          <p class="font-medium">${esc(profile.nickname || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">性別</p>
          <p class="font-medium">${{male:'男性',female:'女性',other:'その他'}[profile.gender] || '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">年代</p>
          <p class="font-medium">${esc(profile.ageRange || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">身長</p>
          <p class="font-medium">${profile.heightCm ? esc(profile.heightCm) + 'cm' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">現在の体重</p>
          <p class="font-medium">${profile.currentWeightKg ? esc(profile.currentWeightKg) + 'kg' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">目標体重</p>
          <p class="font-medium">${profile.targetWeightKg ? esc(profile.targetWeightKg) + 'kg' : '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg col-span-2">
          <p class="text-gray-500 text-xs mb-1">目標・理由</p>
          <p class="font-medium">${esc(profile.goalSummary || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">気になること</p>
          <p class="font-medium">${formatConcernTags(profile.concernTags)}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">活動レベル</p>
          <p class="font-medium">${{sedentary:'座り仕事中心',light:'軽い運動あり',moderate:'週3〜5回運動',active:'毎日激しく運動'}[profile.activityLevel] || '-'}</p>
        </div>
      </div>
    </div>
    ` : '<div class="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800"><i class="fas fa-info-circle mr-2"></i>プロフィール未登録（問診未完了）</div>'}

    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3">サービス設定${isReadOnly ? ' <span class="text-xs text-gray-400 font-normal">(閲覧のみ)</span>' : ''}</h3>
      <div class="grid grid-cols-2 gap-3">
        ${serviceToggle(lineUserId, 'bot_enabled', u.service?.bot_enabled, 'BOT有効', isReadOnly)}
        ${serviceToggle(lineUserId, 'record_enabled', u.service?.record_enabled, '記録機能', isReadOnly)}
        ${serviceToggle(lineUserId, 'consult_enabled', u.service?.consult_enabled, '相談機能', isReadOnly)}
        ${serviceToggle(lineUserId, 'intake_completed', u.service?.intake_completed, '問診完了', isReadOnly)}
      </div>
    </div>

    ${answers.length > 0 ? `
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-clipboard-list text-blue-500 mr-1"></i>問診回答 (${answers.length}件)</h3>
      <div class="space-y-2">
        ${answers.map(a => `
          <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
            <span class="text-gray-500 text-xs w-28 flex-shrink-0">${formatQuestionLabel(a.question_key)}</span>
            <span class="text-gray-800 font-medium text-right flex-1 ml-3">${esc(a.answer_value || '-')}</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <div>
      <h3 class="font-semibold text-gray-700 mb-3">直近の記録（7日分）</h3>
      ${logs.length === 0
        ? '<p class="text-gray-400 text-sm">記録なし</p>'
        : `<div class="space-y-2">${logs.map(log => `
          <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
            <span class="text-gray-600">${esc(log.log_date)}</span>
            <div class="flex gap-4 text-gray-500 text-xs">
              ${log.total_calories_kcal ? '<span>' + esc(log.total_calories_kcal) + 'kcal</span>' : ''}
              ${log.weight_snapshot_kg ? '<span>' + esc(log.weight_snapshot_kg) + 'kg</span>' : ''}
            </div>
          </div>
        `).join('')}</div>`
      }
    </div>
  `;
}

// Records Tab
async function loadModalRecords() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/logs?limit=30', { headers: apiHeaders() });
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
            return `<div class="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
              <span class="text-xs px-2 py-0.5 rounded-full ${typeColor} font-medium">${typeLabel}</span>
              <span class="text-sm text-gray-700 flex-1">${esc(m.meal_text || '記録あり')}</span>
              <span class="text-xs text-gray-500">${m.calories_kcal ? esc(m.calories_kcal) + 'kcal' : '-'}</span>
            </div>`;
          }).join('')
        : '<p class="text-gray-400 text-xs py-2">食事記録なし</p>';
      return `<div class="bg-white border rounded-xl mb-4 overflow-hidden">
        <div class="bg-gray-50 px-4 py-3 flex items-center justify-between">
          <span class="font-semibold text-sm text-gray-800">${esc(log.log_date)}</span>
          <div class="flex gap-3 text-xs text-gray-500">
            ${log.total_calories_kcal ? '<span>' + esc(log.total_calories_kcal) + 'kcal</span>' : ''}
            ${log.weight_snapshot_kg ? '<span>' + esc(log.weight_snapshot_kg) + 'kg</span>' : ''}
          </div>
        </div>
        <div class="px-4 py-2">${mealHtml}</div>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">食事記録の取得に失敗しました</p>';
  }
}

// Photos Tab
async function loadModalPhotos() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/photos?limit=20', { headers: apiHeaders() });
    const photos = res.data.data.photos || [];
    if (photos.length === 0) {
      el.innerHTML = '<div class="text-center py-8 text-gray-400"><i class="fas fa-images text-3xl mb-3"></i><p>進捗写真がありません</p></div>';
      return;
    }
    const poseLabels = { front: '正面', side: '側面', mirror: 'ミラー', unknown: '-' };
    const typeLabels = { before: 'ビフォー', progress: '途中経過', after: 'アフター' };
    el.innerHTML = `
      <div class="grid grid-cols-3 gap-3">
        ${photos.map(p => `
          <div class="photo-thumb bg-gray-50 rounded-lg overflow-hidden">
            <div style="height:120px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;">
              <i class="fas fa-image text-gray-300 text-2xl"></i>
            </div>
            <div class="photo-label p-2">
              <p class="text-xs font-medium text-gray-700">${esc(p.photo_date)}</p>
              <p class="text-xs text-gray-400">${typeLabels[p.photo_type] || ''} ${poseLabels[p.pose_label] || ''}</p>
              ${p.note ? '<p class="text-xs text-gray-500 mt-1 truncate">' + esc(p.note) + '</p>' : ''}
            </div>
          </div>
        `).join('')}
      </div>`;
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">写真データの取得に失敗しました</p>';
  }
}

// Reports Tab
async function loadModalReports() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/reports?limit=12', { headers: apiHeaders() });
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
      return `<div class="bg-white border rounded-xl mb-4 overflow-hidden">
        <div class="bg-gray-50 px-4 py-3 flex items-center justify-between">
          <span class="font-semibold text-sm text-gray-800">${esc(r.week_start)} - ${esc(r.week_end)}</span>
          ${r.sent_at ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">送信済</span>' : '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">未送信</span>'}
        </div>
        <div class="px-4 py-3">
          <div class="grid grid-cols-4 gap-3 text-center mb-3">
            <div>
              <p class="text-lg font-bold text-gray-800">${r.avg_weight_kg ? Number(r.avg_weight_kg).toFixed(1) : '-'}</p>
              <p class="text-xs text-gray-500">平均体重(kg)</p>
            </div>
            <div>
              <p class="text-lg font-bold ${changeColor}">${weightChange}</p>
              <p class="text-xs text-gray-500">体重変化</p>
            </div>
            <div>
              <p class="text-lg font-bold text-gray-800">${r.meal_log_count ?? 0}</p>
              <p class="text-xs text-gray-500">食事記録数</p>
            </div>
            <div>
              <p class="text-lg font-bold text-gray-800">${r.log_days ?? 0}</p>
              <p class="text-xs text-gray-500">記録日数</p>
            </div>
          </div>
          ${r.ai_summary ? '<div class="bg-purple-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap">' + esc(r.ai_summary) + '</div>' : ''}
        </div>
      </div>`;
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
    nickname: 'ニックネーム', gender: '性別', age_range: '年代',
    height_cm: '身長', current_weight_kg: '現在体重', target_weight_kg: '目標体重',
    goal_summary: '目標・理由', concern_tags: '気になること', activity_level: '活動レベル',
  };
  return labels[key] || key;
}

function serviceToggle(lineUserId, key, val, label, isReadOnly) {
  const isOn = val === 1 || val === true;
  if (isReadOnly) {
    return `
      <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
        <span class="text-sm text-gray-700">${esc(label)}</span>
        <span class="w-10 h-6 rounded-full ${isOn ? 'bg-green-400' : 'bg-gray-300'} relative inline-block">
          <span class="absolute top-0.5 ${isOn ? 'right-0.5' : 'left-0.5'} w-5 h-5 bg-white rounded-full shadow"></span>
        </span>
      </div>`;
  }
  return `
    <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
      <span class="text-sm text-gray-700">${esc(label)}</span>
      <button onclick="toggleService('${esc(lineUserId)}','${esc(key)}',${isOn})"
        class="w-10 h-6 rounded-full transition-colors ${isOn ? 'bg-green-500' : 'bg-gray-300'} relative">
        <span class="absolute top-0.5 ${isOn ? 'right-0.5' : 'left-0.5'} w-5 h-5 bg-white rounded-full shadow transition-all"></span>
      </button>
    </div>`;
}

async function toggleService(lineUserId, key, currentVal) {
  try {
    await axios.patch(API_BASE + '/admin/users/' + lineUserId + '/service',
      { [key]: !currentVal },
      { headers: apiHeaders() }
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

// ================================================================
// 管理者管理
// ================================================================
async function loadMembers() {
  const role = currentAdmin?.role;

  // superadminのみ作成フォームを表示
  const addSection = document.getElementById('add-member-section');
  const noCreateMsg = document.getElementById('members-no-create');

  if (role === 'superadmin') {
    if (addSection) addSection.classList.remove('hidden');
    if (noCreateMsg) noCreateMsg.classList.add('hidden');
  } else {
    if (addSection) addSection.classList.add('hidden');
    if (noCreateMsg) noCreateMsg.classList.remove('hidden');
  }

  // 管理者一覧を読み込み
  const tableEl = document.getElementById('members-table');
  tableEl.innerHTML = '<div class="text-center py-4"><i class="fas fa-spinner fa-spin text-gray-400 mr-2"></i>読み込み中...</div>';

  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/members', { headers: apiHeaders() });
    allMembers = res.data.data.members || [];
    renderMembersTable(allMembers);
  } catch (err) {
    console.error('loadMembers error:', err);
    tableEl.innerHTML = '<p class="text-red-400 text-sm p-4">読み込みに失敗しました</p>';
  }
}

function renderMembersTable(members) {
  const tableEl = document.getElementById('members-table');
  if (members.length === 0) {
    tableEl.innerHTML = '<p class="text-gray-400 text-sm p-6 text-center">管理者がいません</p>';
    return;
  }

  const isSuperadmin = currentAdmin?.role === 'superadmin';

  tableEl.innerHTML = `
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
        <th class="pb-3 pt-2 px-4">管理者</th>
        <th class="pb-3 pt-2 px-4">権限</th>
        <th class="pb-3 pt-2 px-4 text-center">状態</th>
        <th class="pb-3 pt-2 px-4 text-center">LINEユーザー数</th>
        <th class="pb-3 pt-2 px-4">最終ログイン</th>
        ${isSuperadmin ? '<th class="pb-3 pt-2 px-4">操作</th>' : ''}
      </tr></thead>
      <tbody>
        ${members.map(m => {
          const roleBadge = {
            superadmin: '<span class="text-xs px-2 py-0.5 rounded-full role-badge-superadmin font-medium">superadmin</span>',
            admin: '<span class="text-xs px-2 py-0.5 rounded-full role-badge-admin font-medium">admin</span>',
            staff: '<span class="text-xs px-2 py-0.5 rounded-full role-badge-staff font-medium">staff</span>',
          }[m.role] || `<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">${esc(m.role)}</span>`;

          const statusBadge = m.status === 'active'
            ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">有効</span>'
            : '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">停止中</span>';

          const canModify = isSuperadmin && m.role !== 'superadmin' && m.id !== currentAdmin.id;

          return `
          <tr class="border-b hover:bg-gray-50">
            <td class="py-3 px-4">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-user-shield text-blue-600 text-xs"></i>
                </div>
                <div>
                  <p class="font-medium text-gray-800">${esc(m.email)}</p>
                  ${m.account_name ? '<p class="text-xs text-gray-400">' + esc(m.account_name) + '</p>' : ''}
                </div>
              </div>
            </td>
            <td class="py-3 px-4">${roleBadge}</td>
            <td class="py-3 px-4 text-center">${statusBadge}</td>
            <td class="py-3 px-4 text-center">
              <span class="font-bold text-gray-800">${m.user_count ?? 0}</span>
              <span class="text-xs text-gray-400">人</span>
            </td>
            <td class="py-3 px-4 text-xs text-gray-500">${fmtDateTime(m.last_login_at)}</td>
            ${isSuperadmin ? `<td class="py-3 px-4">
              ${canModify ? `
                <button onclick="toggleMemberStatus('${esc(m.id)}', '${m.status === 'active' ? 'suspended' : 'active'}')"
                  class="text-xs ${m.status === 'active' ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-green-100 text-green-700 hover:bg-green-200'} px-3 py-1 rounded-lg transition-colors">
                  ${m.status === 'active' ? '停止' : '有効化'}
                </button>
              ` : '<span class="text-xs text-gray-300">-</span>'}
            </td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
    <p class="text-gray-400 text-xs mt-3 px-4">全 ${members.length} 件</p>
  `;
}

async function handleAddMember() {
  const email = document.getElementById('add-member-email').value.trim();
  const password = document.getElementById('add-member-password').value;
  const role = 'admin'; // always admin — superadmin creates admins only
  const msgEl = document.getElementById('add-member-msg');

  if (!email || !password) { showMsg(msgEl, 'メールアドレスとパスワードを入力してください', 'error'); return; }
  if (password.length < 8) { showMsg(msgEl, 'パスワードは8文字以上で入力してください', 'error'); return; }

  try {
    await axios.post(API_BASE + '/admin/dashboard/members', { email, password, role }, { headers: apiHeaders() });
    showMsg(msgEl, `${email} を管理者(admin)として作成しました！`, 'success');
    document.getElementById('add-member-email').value = '';
    document.getElementById('add-member-password').value = '';
    showToast('管理者を作成しました', 'success');
    loadMembers();
  } catch (err) {
    const msg = err.response?.data?.error || '作成に失敗しました';
    showMsg(msgEl, msg, 'error');
  }
}

async function toggleMemberStatus(memberId, newStatus) {
  const label = newStatus === 'suspended' ? '停止' : '有効化';
  if (!confirm(`この管理者を${label}しますか？`)) return;

  try {
    await axios.patch(API_BASE + '/admin/dashboard/members/' + memberId,
      { status: newStatus },
      { headers: apiHeaders() }
    );
    showToast(`管理者を${label}しました`, 'success');
    loadMembers();
  } catch (err) {
    const msg = err.response?.data?.error || '更新に失敗しました';
    showToast(msg, 'error');
  }
}

// ================================================================
// アカウント設定
// ================================================================
async function loadAccount() {
  try {
    const res = await axios.get(API_BASE + '/admin/auth/me', { headers: apiHeaders() });
    const admin = res.data.data;
    document.getElementById('admin-email').textContent = admin.email || '-';
    const roleLabels = { superadmin: 'スーパー管理者 (superadmin)', admin: '管理者 (admin)', staff: 'スタッフ (staff)' };
    document.getElementById('admin-role').textContent = roleLabels[admin.role] || admin.role || '-';
    document.getElementById('admin-last-login').textContent = admin.lastLoginAt
      ? fmtDateTime(admin.lastLoginAt)
      : '初回ログイン';
  } catch { /* ignore */ }
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
      { headers: apiHeaders() }
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

// ================================================================
// 招待コード管理
// ================================================================
let allInviteCodes = [];

async function loadInviteCodes() {
  const role = currentAdmin?.role;

  // staff はフォーム非表示
  const formEl = document.getElementById('invite-code-form');
  if (formEl) formEl.classList.toggle('hidden', role === 'staff');

  const tableEl = document.getElementById('invite-codes-table');
  tableEl.innerHTML = '<div class="text-center py-4"><i class="fas fa-spinner fa-spin text-gray-400 mr-2"></i>読み込み中...</div>';

  try {
    const res = await axios.get(API_BASE + '/admin/invite-codes', { headers: apiHeaders() });
    allInviteCodes = res.data.data.codes || [];
    renderInviteCodesTable(allInviteCodes);
  } catch (err) {
    console.error('loadInviteCodes error:', err);
    tableEl.innerHTML = '<p class="text-red-400 text-sm p-4">読み込みに失敗しました</p>';
  }
}

function renderInviteCodesTable(codes) {
  const tableEl = document.getElementById('invite-codes-table');
  if (codes.length === 0) {
    tableEl.innerHTML = `
      <div class="text-center py-12 text-gray-400">
        <i class="fas fa-ticket-alt text-4xl mb-3"></i>
        <p>招待コードがまだありません</p>
        <p class="text-xs mt-2">上のフォームからコードを発行してください</p>
      </div>`;
    return;
  }

  const canRevoke = currentAdmin?.role !== 'staff';

  tableEl.innerHTML = `
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
        <th class="pb-3 pt-2 px-4">コード</th>
        <th class="pb-3 pt-2 px-4">ラベル</th>
        <th class="pb-3 pt-2 px-4 text-center">使用状況</th>
        <th class="pb-3 pt-2 px-4 text-center">状態</th>
        <th class="pb-3 pt-2 px-4">有効期限</th>
        <th class="pb-3 pt-2 px-4">作成者</th>
        <th class="pb-3 pt-2 px-4">作成日</th>
        ${canRevoke ? '<th class="pb-3 pt-2 px-4">操作</th>' : ''}
      </tr></thead>
      <tbody>
        ${codes.map(c => {
          const statusBadge = {
            active: '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">有効</span>',
            expired: '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium">期限切れ</span>',
            revoked: '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">無効化済</span>',
          }[c.status] || '';

          const maxLabel = c.max_uses === 0 || c.max_uses === null ? '無制限' : c.max_uses;
          const useInfo = c.use_count + ' / ' + maxLabel;

          return `
          <tr class="border-b hover:bg-gray-50">
            <td class="py-3 px-4">
              <div class="flex items-center gap-2">
                <code class="text-sm font-bold text-green-700 bg-green-50 px-2 py-1 rounded">${esc(c.code)}</code>
                <button onclick="copyText('${esc(c.code)}', this)" class="text-gray-400 hover:text-gray-600 text-xs" title="コピー">
                  <i class="fas fa-copy"></i>
                </button>
              </div>
            </td>
            <td class="py-3 px-4 text-gray-600 text-xs">${esc(c.label || '-')}</td>
            <td class="py-3 px-4 text-center text-xs">
              <span class="font-bold ${c.use_count > 0 ? 'text-green-600' : 'text-gray-500'}">${useInfo}</span>
            </td>
            <td class="py-3 px-4 text-center">${statusBadge}</td>
            <td class="py-3 px-4 text-xs text-gray-500">${c.expires_at ? fmtDate(c.expires_at) : '無期限'}</td>
            <td class="py-3 px-4 text-xs text-gray-500">${esc(c.creator_email || '-')}</td>
            <td class="py-3 px-4 text-xs text-gray-500">${fmtDate(c.created_at)}</td>
            ${canRevoke ? `<td class="py-3 px-4">
              ${c.status === 'active' ? `
                <button onclick="revokeInviteCode('${esc(c.id)}')"
                  class="text-xs bg-red-100 text-red-700 hover:bg-red-200 px-3 py-1 rounded-lg transition-colors">
                  無効化
                </button>
              ` : '<span class="text-xs text-gray-300">-</span>'}
            </td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
    <p class="text-gray-400 text-xs mt-3 px-4">全 ${codes.length} 件</p>
  `;
}

async function handleCreateInviteCode() {
  const label = document.getElementById('invite-label').value.trim();
  const maxUsesVal = document.getElementById('invite-max-uses').value;
  const expiresVal = document.getElementById('invite-expires').value;
  const msgEl = document.getElementById('invite-code-msg');

  const maxUses = parseInt(maxUsesVal, 10);
  const expiresInDays = parseInt(expiresVal, 10);

  try {
    const res = await axios.post(API_BASE + '/admin/invite-codes', {
      label: label || undefined,
      maxUses: maxUses === 0 ? null : maxUses,
      expiresInDays: expiresInDays || undefined,
    }, { headers: apiHeaders() });

    const code = res.data.data.code;
    showMsg(msgEl, `招待コード「${code.code}」を発行しました！`, 'success');
    document.getElementById('invite-label').value = '';
    showToast(`コード ${code.code} を発行しました`, 'success');

    // コードをクリップボードにコピー
    try { await navigator.clipboard.writeText(code.code); } catch {}

    loadInviteCodes();
  } catch (err) {
    const msg = err.response?.data?.error || '発行に失敗しました';
    showMsg(msgEl, msg, 'error');
  }
}

async function revokeInviteCode(codeId) {
  if (!confirm('この招待コードを無効化しますか？')) return;
  try {
    await axios.patch(API_BASE + '/admin/invite-codes/' + codeId + '/revoke', {}, { headers: apiHeaders() });
    showToast('招待コードを無効化しました', 'success');
    loadInviteCodes();
  } catch (err) {
    showToast(err.response?.data?.error || '無効化に失敗しました', 'error');
  }
}

// ================================================================
// フローチェックリスト
// ================================================================
function updateChecklistProgress() {
  const checkboxes = document.querySelectorAll('#page-checklist input[type="checkbox"]');
  const total = checkboxes.length;
  const checked = [...checkboxes].filter(c => c.checked).length;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const bar = document.getElementById('checklist-progress-bar');
  if (bar) bar.style.width = pct + '%';
  const text = document.getElementById('checklist-progress-text');
  if (text) text.textContent = `${checked} / ${total} 完了 (${pct}%)`;
}

// ================================================================
// システム管理 (Superadmin Only)
// ================================================================
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
    const res = await axios.get(API_BASE + '/admin/dashboard/db-stats', { headers: apiHeaders() });
    const stats = res.data.data?.tables || [];
    if (stats.length > 0) {
      el.innerHTML = `
        <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="border-b text-left text-gray-500 bg-gray-50">
            <th class="pb-2 pt-1 px-3">テーブル名</th>
            <th class="pb-2 pt-1 px-3 text-right">行数</th>
          </tr></thead>
          <tbody>
            ${stats.map(t => `
              <tr class="border-b hover:bg-gray-50">
                <td class="py-2 px-3 font-mono text-xs text-gray-700">${esc(t.name)}</td>
                <td class="py-2 px-3 text-right text-gray-600">${t.count?.toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>`;
    } else {
      el.innerHTML = '<p class="text-gray-400">テーブル情報を取得できませんでした</p>';
    }
  } catch {
    el.innerHTML = '<p class="text-gray-400">DB統計の取得に失敗しました</p>';
  }
}

// ================================================================
// 初期化
// ================================================================
window.addEventListener('load', async () => {
  const savedToken = localStorage.getItem('diet_bot_token');
  const savedAdmin = localStorage.getItem('diet_bot_admin');
  if (savedToken) {
    authToken = savedToken;
    if (savedAdmin) {
      try { currentAdmin = JSON.parse(savedAdmin); } catch {}
    }
    showDashboard();
  } else {
    // ログイン画面表示時にセットアップ状態を確認
    const needsSetup = await checkSetupNeeded();
    const setupLink = document.getElementById('setup-link');
    if (setupLink) {
      setupLink.classList.toggle('hidden', !needsSetup);
    }
  }
});
