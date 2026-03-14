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
  const pages = ['overview', 'users', 'invite-codes', 'members', 'line-guide', 'checklist', 'account', 'system', 'bot-settings', 'rich-menu'];
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
  else if (page === 'bot-settings') loadBotSettings();
  else if (page === 'rich-menu') loadRichMenuList();
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
        <i class="fab fa-line text-4xl mb-3 text-green-400"></i>
        <p class="text-gray-600 font-medium">まだLINEユーザーがいません</p>
        <p class="text-xs mt-2 text-gray-400">ユーザーは手動追加ではなく、<strong>LINE友達追加 → 招待コード送信</strong>で自動登録されます</p>
        <div class="flex gap-3 justify-center mt-4">
          <button onclick="showPage('invite-codes')" class="bg-green-500 hover:bg-green-600 text-white px-5 py-2 rounded-xl text-sm font-medium transition-colors">
            <i class="fas fa-ticket-alt mr-1"></i>招待コードを発行
          </button>
          <button onclick="showPage('line-guide')" class="bg-white border border-green-400 text-green-600 hover:bg-green-50 px-5 py-2 rounded-xl text-sm font-medium transition-colors">
            <i class="fab fa-line mr-1"></i>LINE案内文をコピー
          </button>
        </div>
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
  else if (tab === 'corrections') loadModalCorrections();
}

function renderModalOverview() {
  const u = modalUser;
  if (!u) return;
  const lineUserId = modalLineUserId;
  const logs = (u.recentLogs || []).slice(0, 7);
  const profile = u.profile;
  const answers = u.intakeAnswers || [];
  const weightHistory = u.weightHistory || [];
  const isReadOnly = currentAdmin?.role === 'staff';

  // 連携・整合性ステータス (API v2: linkage nested object)
  const linkage = u.linkage || {};
  const integrity = linkage.integrity || u.integrity || {};
  const pending = linkage.pendingStatus || u.pendingStatus;
  const pendingClar = linkage.pendingClarification || u.pendingClarification;
  const hasIssues = integrity.issues && integrity.issues.length > 0;
  const currentMode = linkage.currentMode;
  const currentStep = linkage.currentStep;
  const lastMsgAt = linkage.lastMessageAt || u.lastMessageAt;
  const lastImgAt = linkage.lastImageAnalysisAt || u.lastImageAnalysisAt;
  const lastCorAt = linkage.lastCorrectionAt;

  document.getElementById('modal-content').innerHTML = `
    <!-- 連携ステータス -->
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-link text-blue-500 mr-1"></i>連携ステータス</h3>
      <div class="grid grid-cols-3 gap-3 text-sm">
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">LINE 表示名</p>
          <p class="font-medium">${esc(u.display_name || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">LINE User ID</p>
          <p class="font-mono text-xs truncate" title="${esc(lineUserId)}">${esc(lineUserId)}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">User Account ID</p>
          <p class="font-mono text-xs truncate" title="${esc(u.userAccountId)}">${esc(u.userAccountId)}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">Client Account ID</p>
          <p class="font-mono text-xs truncate" title="${esc(u.clientAccountId || '-')}">${esc(u.clientAccountId || '-')}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">参加日</p>
          <p class="font-medium">${fmtDate(u.joinedAt)}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">フォロー状態</p>
          <p class="font-medium">${
            integrity.followStatus === 'following' ? '<span class="text-green-600"><i class="fas fa-check-circle mr-1"></i>フォロー中</span>'
            : integrity.followStatus === 'blocked' ? '<span class="text-red-600"><i class="fas fa-ban mr-1"></i>ブロック/解除</span>'
            : '<span class="text-gray-400">' + esc(integrity.followStatus || '不明') + '</span>'
          }</p>
        </div>
      </div>

      <!-- BOT状態フラグ -->
      <div class="grid grid-cols-5 gap-2 mt-3 text-xs text-center">
        <div class="p-2 rounded-lg ${u.service?.intake_completed === 1 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}">
          <i class="fas ${u.service?.intake_completed === 1 ? 'fa-check-circle' : 'fa-clock'} mb-1"></i>
          <p class="font-medium">問診${u.service?.intake_completed === 1 ? '完了' : '未完了'}</p>
        </div>
        <div class="p-2 rounded-lg ${u.service?.bot_enabled === 1 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}">
          <i class="fas ${u.service?.bot_enabled === 1 ? 'fa-robot' : 'fa-robot'} mb-1"></i>
          <p class="font-medium">BOT ${u.service?.bot_enabled === 1 ? 'ON' : 'OFF'}</p>
        </div>
        <div class="p-2 rounded-lg ${u.service?.record_enabled === 1 ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}">
          <i class="fas fa-utensils mb-1"></i>
          <p class="font-medium">記録 ${u.service?.record_enabled === 1 ? 'ON' : 'OFF'}</p>
        </div>
        <div class="p-2 rounded-lg ${u.service?.consult_enabled === 1 ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}">
          <i class="fas fa-comments mb-1"></i>
          <p class="font-medium">相談 ${u.service?.consult_enabled === 1 ? 'ON' : 'OFF'}</p>
        </div>
        <div class="p-2 rounded-lg ${currentMode ? 'bg-purple-50 text-purple-700' : 'bg-gray-100 text-gray-400'}">
          <i class="fas fa-cog mb-1"></i>
          <p class="font-medium">${currentMode ? esc(currentMode) : 'idle'}</p>
          ${currentStep ? '<p class="text-[10px] truncate" title="' + esc(currentStep) + '">' + esc(currentStep) + '</p>' : ''}
        </div>
      </div>

      <!-- Pending ステータス -->
      ${pending ? `
      <div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
        <div class="flex items-center gap-2 mb-1">
          <i class="fas fa-hourglass-half text-amber-600"></i>
          <span class="font-medium text-amber-800">Pending: ${esc(pending.type)}</span>
        </div>
        <div class="text-xs text-amber-700">
          ${pending.id ? '<span>ID: ' + esc(pending.id) + '</span> · ' : ''}
          <span>更新: ${fmtDateTime(pending.createdAt)}</span>
        </div>
      </div>` : ''}

      ${pendingClar ? `
      <div class="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
        <div class="flex items-center gap-2 mb-1">
          <i class="fas fa-question-circle text-blue-600"></i>
          <span class="font-medium text-blue-800">確認待ち: ${esc(pendingClar.currentField)}</span>
        </div>
        <div class="text-xs text-blue-700">
          <span>ID: ${esc(pendingClar.id)}</span> · <span>ステータス: ${esc(pendingClar.status)}</span> · <span>作成: ${fmtDateTime(pendingClar.createdAt)}</span>
        </div>
      </div>` : ''}

      <!-- アクティビティ -->
      <div class="grid grid-cols-3 gap-3 mt-3 text-sm">
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">最終メッセージ</p>
          <p class="font-medium text-xs">${fmtDateTime(lastMsgAt) || '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">最終画像解析</p>
          <p class="font-medium text-xs">${fmtDateTime(lastImgAt) || '-'}</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-500 text-xs mb-1">最終修正</p>
          <p class="font-medium text-xs">${fmtDateTime(lastCorAt) || '-'}</p>
        </div>
      </div>

      <!-- 整合性チェック -->
      ${hasIssues ? `
      <div class="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
        <div class="flex items-center gap-2 mb-2">
          <i class="fas fa-exclamation-triangle text-red-600"></i>
          <span class="font-semibold text-red-800 text-sm">不整合検出 (${integrity.issues.length}件)</span>
        </div>
        <ul class="list-disc list-inside text-xs text-red-700 space-y-1">
          ${integrity.issues.map(issue => '<li>' + esc(issue) + '</li>').join('')}
        </ul>
      </div>` : `
      <div class="mt-3 bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
        <i class="fas fa-check-circle text-green-600"></i>
        <span class="text-green-800 text-sm font-medium">データ整合性: 問題なし</span>
        <div class="flex gap-2 ml-auto text-xs text-green-600">
          ${integrity.lineUserExists ? '<span title="line_users"><i class="fas fa-check"></i> LINE</span>' : ''}
          ${integrity.userAccountExists ? '<span title="user_accounts"><i class="fas fa-check"></i> Account</span>' : ''}
          ${integrity.serviceStatusExists ? '<span title="user_service_statuses"><i class="fas fa-check"></i> Service</span>' : ''}
          ${integrity.profileExists ? '<span title="user_profiles"><i class="fas fa-check"></i> Profile</span>' : ''}
        </div>
      </div>`}
    </div>

    <!-- 最近の画像解析結果 -->
    ${(() => {
      const imgResults = linkage.recentImageResults || [];
      if (imgResults.length === 0) return '';
      const flagLabels = { 0: ['⏳ 確認待ち', 'bg-amber-100 text-amber-700'], 1: ['✅ 確定', 'bg-green-100 text-green-700'], 2: ['🗑 取消', 'bg-gray-100 text-gray-500'] };
      const catLabels = { meal_photo: '🍽 食事写真', nutrition_label: '📋 栄養表示', body_scale: '⚖️ 体重計', progress_body_photo: '📸 体型写真', food_package: '📦 食品パッケージ' };
      return '<div class="mb-6"><h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-camera text-indigo-500 mr-1"></i>最近の画像解析 (' + imgResults.length + '件)</h3><div class="space-y-2">' +
        imgResults.map(r => {
          const [flagLabel, flagClass] = flagLabels[r.appliedFlag] || ['❓ 不明', 'bg-gray-100 text-gray-500'];
          const catLabel = catLabels[r.imageCategory] || r.imageCategory || '不明';
          return '<div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">' +
            '<div class="flex items-center gap-2 flex-1 min-w-0">' +
              '<span class="text-xs px-2 py-0.5 rounded-full ' + flagClass + ' font-medium whitespace-nowrap">' + flagLabel + '</span>' +
              '<span class="text-xs text-gray-500 whitespace-nowrap">' + esc(catLabel) + '</span>' +
              (r.mealDescription ? '<span class="text-xs text-gray-700 truncate" title="' + esc(r.mealDescription) + '">' + esc(r.mealDescription.substring(0, 30)) + '</span>' : '') +
              (r.estimatedCalories ? '<span class="text-xs text-orange-600 whitespace-nowrap">' + r.estimatedCalories + 'kcal</span>' : '') +
            '</div>' +
            '<span class="text-xs text-gray-400 whitespace-nowrap ml-2">' + fmtDateTime(r.createdAt) + '</span>' +
          '</div>';
        }).join('') + '</div></div>';
    })()}

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

    ${weightHistory.length > 0 ? `
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-chart-line text-blue-500 mr-1"></i>体重推移（30日）</h3>
      <div style="position:relative;height:160px;background:#f9fafb;border-radius:8px;padding:8px;">
        <canvas id="admin-weight-chart"></canvas>
      </div>
    </div>
    ` : ''}

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
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-history text-orange-500 mr-1"></i>最近の修正 (${(u.correctionHistory || []).length}件)</h3>
      ${(u.correctionHistory || []).length === 0
        ? '<p class="text-gray-400 text-sm">修正履歴なし</p>'
        : `<div class="space-y-2">${(u.correctionHistory || []).slice(0, 5).map(ch => {
            const tableLabels = { meal_entries: '食事', body_metrics: '体重', daily_logs: '日次ログ' };
            const typeLabels = { text_correction: 'テキスト修正', overwrite: '上書き', delete: '削除', auto_merge: '自動マージ', manual_fix: '手動修正' };
            return `<div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
              <div class="flex items-center gap-2">
                <span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">${esc(typeLabels[ch.correctionType] || ch.correctionType)}</span>
                <span class="text-xs text-gray-500">${esc(tableLabels[ch.targetTable] || ch.targetTable)}</span>
                ${ch.reason ? '<span class="text-xs text-gray-400 truncate max-w-[150px]" title="' + esc(ch.reason) + '">' + esc(ch.reason) + '</span>' : ''}
              </div>
              <span class="text-xs text-gray-400">${fmtDateTime(ch.createdAt)}</span>
            </div>`;
          }).join('')}</div>${(u.correctionHistory || []).length > 5 ? '<p class="text-xs text-blue-500 mt-2 cursor-pointer" onclick="switchModalTab(\'corrections\')"><i class="fas fa-arrow-right mr-1"></i>すべて表示</p>' : ''}`
      }
    </div>

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

  // 体重チャートを描画
  if (weightHistory.length > 0) {
    renderAdminWeightChart(weightHistory);
  }
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

// Corrections Tab
async function loadModalCorrections() {
  const el = document.getElementById('modal-content');
  el.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-gray-400 text-2xl"></i></div>';
  try {
    const res = await axios.get(API_BASE + '/admin/users/' + modalLineUserId + '/corrections?limit=30', { headers: apiHeaders() });
    const corrections = res.data.data.corrections || [];
    if (corrections.length === 0) {
      el.innerHTML = '<div class="text-center py-8 text-gray-400"><i class="fas fa-history text-3xl mb-3"></i><p>修正履歴がありません</p></div>';
      return;
    }

    const tableLabels = { meal_entries: '食事', body_metrics: '体重', daily_logs: '日次ログ' };
    const typeLabels = { text_correction: 'テキスト修正', overwrite: '上書き', delete: '削除', auto_merge: '自動マージ', manual_fix: '手動修正' };
    const triggerLabels = { user: 'ユーザー', system: 'システム', admin: '管理者' };
    const triggerColors = { user: 'bg-blue-100 text-blue-700', system: 'bg-gray-100 text-gray-700', admin: 'bg-purple-100 text-purple-700' };

    el.innerHTML = `
      <div class="text-xs text-gray-500 mb-3">全 ${corrections.length} 件の修正履歴</div>
      ${corrections.map(ch => {
        const table = tableLabels[ch.targetTable] || ch.targetTable;
        const type = typeLabels[ch.correctionType] || ch.correctionType;
        const trigger = triggerLabels[ch.triggeredBy] || ch.triggeredBy;
        const triggerCls = triggerColors[ch.triggeredBy] || 'bg-gray-100 text-gray-600';

        let diffHtml = '';
        try {
          const oldVal = ch.oldValueJson ? JSON.parse(ch.oldValueJson) : null;
          const newVal = ch.newValueJson ? JSON.parse(ch.newValueJson) : null;
          if (oldVal || newVal) {
            const oldLines = [];
            const newLines = [];
            if (oldVal) {
              for (const [k, v] of Object.entries(oldVal)) {
                if (v != null) oldLines.push(esc(k) + ': ' + esc(String(v)));
              }
            }
            if (newVal) {
              for (const [k, v] of Object.entries(newVal)) {
                if (v != null) newLines.push(esc(k) + ': ' + esc(String(v)));
              }
            }
            diffHtml = '<div class="grid grid-cols-2 gap-2 mt-2">';
            if (oldLines.length > 0) {
              diffHtml += '<div class="bg-red-50 border border-red-200 rounded p-2"><p class="text-[10px] text-red-600 font-bold mb-1">変更前</p><p class="text-xs text-red-800 whitespace-pre-wrap">' + oldLines.join('\n') + '</p></div>';
            }
            if (newLines.length > 0) {
              diffHtml += '<div class="bg-green-50 border border-green-200 rounded p-2"><p class="text-[10px] text-green-600 font-bold mb-1">変更後</p><p class="text-xs text-green-800 whitespace-pre-wrap">' + newLines.join('\n') + '</p></div>';
            }
            diffHtml += '</div>';
          }
        } catch { /* ignore parse errors */ }

        return `<div class="bg-white border rounded-xl mb-3 overflow-hidden">
          <div class="bg-gray-50 px-4 py-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs px-2 py-0.5 rounded-full ${triggerCls} font-medium">${esc(trigger)}</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">${esc(type)}</span>
              <span class="text-xs text-gray-500">${esc(table)}</span>
            </div>
            <span class="text-xs text-gray-400">${fmtDateTime(ch.createdAt)}</span>
          </div>
          <div class="px-4 py-3">
            <div class="text-xs text-gray-500">対象ID: <code class="bg-gray-100 px-1 rounded">${esc((ch.targetRecordId || '').substring(0, 16))}...</code></div>
            ${ch.reason ? '<div class="text-xs text-gray-600 mt-1"><i class="fas fa-comment text-gray-400 mr-1"></i>' + esc(ch.reason) + '</div>' : ''}
            ${diffHtml}
          </div>
        </div>`;
      }).join('')}
    `;
  } catch {
    el.innerHTML = '<p class="text-red-400 text-sm">修正履歴の取得に失敗しました</p>';
  }
}

let adminWeightChart = null;

function renderAdminWeightChart(history) {
  const canvas = document.getElementById('admin-weight-chart');
  if (!canvas || typeof Chart === 'undefined' || !history || history.length === 0) return;
  if (adminWeightChart) adminWeightChart.destroy();

  const labels = history.map(h => {
    const d = h.log_date || '';
    const parts = d.split('-');
    return parts.length === 3 ? parts[1] + '/' + parts[2] : d;
  });
  const data = history.map(h => h.weight_kg);
  const weights = data.filter(v => v != null);
  const minW = Math.floor(Math.min(...weights) - 1);
  const maxW = Math.ceil(Math.max(...weights) + 1);

  adminWeightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '体重 (kg)',
        data,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.08)',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#3b82f6',
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
        <th class="pb-3 pt-2 px-4">使用者</th>
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

          // 使用者表示
          const usages = c.usages || [];
          let usageHtml = '<span class="text-gray-300">-</span>';
          if (usages.length > 0) {
            usageHtml = usages.map(u => {
              const name = esc(u.display_name || u.line_user_id || '不明');
              const date = u.used_at ? fmtDate(u.used_at) : '';
              return `<div class="flex items-center gap-1.5 mb-1">
                <i class="fas fa-user-check text-green-500 text-xs"></i>
                <span class="font-medium text-gray-800">${name}</span>
                ${date ? '<span class="text-gray-400 text-[10px]">(' + date + ')</span>' : ''}
              </div>`;
            }).join('');
          }

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
            <td class="py-3 px-4 text-xs">${usageHtml}</td>
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
// BOT / ナレッジ設定 (Superadmin Only)
// ================================================================
let currentEditBotId = null;

async function loadBotSettings() {
  if (currentAdmin?.role !== 'superadmin') {
    showToast('アクセス権限がありません', 'error');
    showPage('overview');
    return;
  }
  await Promise.all([loadBots(), loadKnowledgeBases(), loadBotKbLinks()]);
}

async function loadBots() {
  const el = document.getElementById('bots-list');
  if (!el) return;
  el.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...';
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/bots', { headers: apiHeaders() });
    const bots = res.data.data.bots || [];
    if (bots.length === 0) {
      el.innerHTML = '<div class="text-center py-6 text-gray-400"><i class="fas fa-robot text-3xl mb-3"></i><p>BOTが登録されていません</p><p class="text-xs mt-1">seed.sql でBOTを初期登録してください</p></div>';
      return;
    }
    el.innerHTML = `<div class="space-y-3">${bots.map(b => {
      const statusBadge = b.is_active
        ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">有効</span>'
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium">無効</span>';
      const versionInfo = b.version_number ? `v${b.version_number}` : '未設定';
      const publishedBadge = b.is_published
        ? '<span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">公開中</span>'
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">未公開</span>';
      return `<div class="flex items-center justify-between bg-gray-50 p-4 rounded-xl">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
            <i class="fas fa-robot text-purple-600"></i>
          </div>
          <div>
            <p class="font-medium text-gray-800">${esc(b.name)}</p>
            <p class="text-xs text-gray-500">key: ${esc(b.bot_key)} · ${esc(b.account_name || '-')} · ${versionInfo}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${statusBadge} ${publishedBadge}
          <button onclick="openPromptEditor('${esc(b.id)}', '${esc(b.name)}', ${b.version_number || 0})" 
            class="text-xs bg-purple-100 text-purple-700 hover:bg-purple-200 px-3 py-1.5 rounded-lg transition-colors">
            <i class="fas fa-edit mr-1"></i>プロンプト編集
          </button>
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch {
    el.innerHTML = '<p class="text-red-400">BOT一覧の取得に失敗しました</p>';
  }
}

async function openPromptEditor(botId, botName, currentVersion) {
  currentEditBotId = botId;
  const section = document.getElementById('prompt-editor-section');
  section.classList.remove('hidden');
  document.getElementById('prompt-bot-name').textContent = botName;
  document.getElementById('prompt-version-badge').textContent = `現在: v${currentVersion || 0}`;
  document.getElementById('prompt-editor').value = '';

  // 現在のプロンプトを取得
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/bots/' + botId + '/versions', { headers: apiHeaders() });
    const versions = res.data.data.versions || [];
    const published = versions.find(v => v.is_published) || versions[0];
    if (published) {
      // プロンプトの全文を取得（preview は 200 文字まで）
      // system_prompt の全文は bot detail API がないので、versions の preview を使う
      // 実際は full prompt が必要 — versions API で全文返すよう改良が理想だが、
      // ここでは published version のプロンプトを取得する別ルートを使う
      document.getElementById('prompt-editor').value = published.prompt_preview || '';
      document.getElementById('prompt-editor').placeholder = 'System Prompt を入力...\n(現在のプロンプトが表示されています。全文は200文字まで表示。)';
    }
  } catch {
    showToast('プロンプトの取得に失敗しました', 'error');
  }
  section.scrollIntoView({ behavior: 'smooth' });
}

function closePromptEditor() {
  document.getElementById('prompt-editor-section').classList.add('hidden');
  currentEditBotId = null;
}

async function savePrompt() {
  if (!currentEditBotId) return;
  const prompt = document.getElementById('prompt-editor').value.trim();
  if (!prompt) { showToast('プロンプトを入力してください', 'error'); return; }

  try {
    const res = await axios.post(
      API_BASE + '/admin/dashboard/bots/' + currentEditBotId + '/versions',
      { systemPrompt: prompt, publish: true },
      { headers: apiHeaders() }
    );
    const ver = res.data.data;
    showToast(`v${ver.versionNumber} を公開しました`, 'success');
    closePromptEditor();
    loadBots();
  } catch (err) {
    showToast(err.response?.data?.error || '保存に失敗しました', 'error');
  }
}

async function loadKnowledgeBases() {
  const el = document.getElementById('knowledge-bases-list');
  if (!el) return;
  el.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...';
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/knowledge-bases', { headers: apiHeaders() });
    const bases = res.data.data.bases || [];
    if (bases.length === 0) {
      el.innerHTML = '<div class="text-center py-6 text-gray-400"><i class="fas fa-book text-3xl mb-3"></i><p>ナレッジベースがありません</p><p class="text-xs mt-1">seed.sql でナレッジベースを初期登録してください</p></div>';
      return;
    }
    el.innerHTML = `<div class="space-y-3">${bases.map(kb => {
      const statusBadge = kb.is_active
        ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">有効</span>'
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium">無効</span>';
      return `<div class="flex items-center justify-between bg-gray-50 p-4 rounded-xl">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
            <i class="fas fa-book text-amber-600"></i>
          </div>
          <div>
            <p class="font-medium text-gray-800">${esc(kb.name)}</p>
            <p class="text-xs text-gray-500">${esc(kb.description || '-')} · ${esc(kb.account_name || 'システム共通')} · ${kb.doc_count}件のドキュメント</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${statusBadge}
          <span class="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">優先度: ${kb.priority}</span>
          <button onclick="loadKbDocuments('${esc(kb.id)}', '${esc(kb.name)}')"
            class="text-xs bg-amber-100 text-amber-700 hover:bg-amber-200 px-3 py-1.5 rounded-lg transition-colors">
            <i class="fas fa-file-lines mr-1"></i>ドキュメント
          </button>
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch {
    el.innerHTML = '<p class="text-red-400">ナレッジベース一覧の取得に失敗しました</p>';
  }
}

async function loadKbDocuments(kbId, kbName) {
  const section = document.getElementById('kb-documents-section');
  section.classList.remove('hidden');
  document.getElementById('kb-documents-name').textContent = kbName;
  const el = document.getElementById('kb-documents-list');
  el.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...';

  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/knowledge-bases/' + kbId + '/documents', { headers: apiHeaders() });
    const docs = res.data.data.documents || [];
    if (docs.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-center py-4">ドキュメントがありません</p>';
      return;
    }
    el.innerHTML = `<div class="space-y-3">${docs.map(d => {
      const contentPreview = (d.content || '').substring(0, 150);
      return `<div class="bg-gray-50 p-4 rounded-xl">
        <div class="flex items-center justify-between mb-2">
          <p class="font-medium text-gray-800 text-sm">${esc(d.title)}</p>
          <div class="flex gap-2">
            <span class="text-xs px-2 py-0.5 rounded-full ${d.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}">
              ${d.is_active ? '有効' : '無効'}
            </span>
            <span class="text-xs text-gray-400">優先度: ${d.priority}</span>
          </div>
        </div>
        <p class="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">${esc(contentPreview)}${d.content && d.content.length > 150 ? '...' : ''}</p>
        ${d.source_url ? '<p class="text-xs text-blue-500 mt-2"><i class="fas fa-link mr-1"></i>' + esc(d.source_url) + '</p>' : ''}
        <p class="text-xs text-gray-400 mt-2">${fmtDateTime(d.created_at)}</p>
      </div>`;
    }).join('')}</div>`;
  } catch {
    el.innerHTML = '<p class="text-red-400">ドキュメントの取得に失敗しました</p>';
  }
  section.scrollIntoView({ behavior: 'smooth' });
}

async function loadBotKbLinks() {
  const el = document.getElementById('bot-kb-links-list');
  if (!el) return;
  el.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...';
  try {
    const res = await axios.get(API_BASE + '/admin/dashboard/bot-knowledge-links', { headers: apiHeaders() });
    const links = res.data.data.links || [];
    if (links.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-center py-4">紐付けがありません</p>';
      return;
    }
    el.innerHTML = `<div class="space-y-2">${links.map(l => `
      <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg text-sm">
        <div class="flex items-center gap-3">
          <i class="fas fa-robot text-purple-500"></i>
          <span class="font-medium">${esc(l.bot_name || '-')}</span>
          <i class="fas fa-arrow-right text-gray-300 text-xs"></i>
          <i class="fas fa-book text-amber-500"></i>
          <span class="font-medium">${esc(l.kb_name || '-')}</span>
        </div>
        <span class="text-xs text-gray-400">優先度: ${l.priority}</span>
      </div>
    `).join('')}</div>`;
  } catch {
    el.innerHTML = '<p class="text-red-400">紐付け情報の取得に失敗しました</p>';
  }
}

// ================================================================
// Rich Menu 管理 (Admin / Superadmin)
// ================================================================

async function loadRichMenuList() {
  const container = document.getElementById('rich-menu-list');
  if (!container) return;

  container.innerHTML = '<div class="text-center py-4"><div class="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto"></div></div>';

  try {
    const res = await fetch(`${API_BASE}/admin/rich-menu/list`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const menus = data.data.richmenus || [];
    const defaultId = data.data.defaultRichMenuId;

    // Always show preset info card
    const presetHtml = `
      <div class="bg-gradient-to-r from-green-50 to-teal-50 rounded-xl border border-green-200 p-4 mb-4">
        <h4 class="font-bold text-green-800 mb-2"><i class="fas fa-magic mr-2"></i>プリセット Rich Menu 構成</h4>
        <div class="grid grid-cols-2 gap-2 text-sm mb-3">
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-pencil-alt text-green-500 mr-1"></i>記録する<br><span class="text-xs text-gray-400">→ 記録モード</span></div>
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-camera text-blue-500 mr-1"></i>写真を送る<br><span class="text-xs text-gray-400">→ 写真案内</span></div>
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-weight text-purple-500 mr-1"></i>体重記録<br><span class="text-xs text-gray-400">→ 体重入力案内</span></div>
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-comment text-orange-500 mr-1"></i>相談する<br><span class="text-xs text-gray-400">→ 相談モード</span></div>
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-chart-bar text-teal-500 mr-1"></i>ダッシュボード<br><span class="text-xs text-gray-400">→ LIFF起動</span></div>
          <div class="bg-white rounded p-2 text-center border"><i class="fas fa-clipboard-list text-red-500 mr-1"></i>問診やり直し<br><span class="text-xs text-gray-400">→ 問診リセット</span></div>
        </div>
        <p class="text-xs text-gray-500">画像サイズ: 2500×1686px (2列×3行) ・ プリセット画像: <code>/static/richmenu.png</code></p>
      </div>`;

    if (menus.length === 0) {
      container.innerHTML = presetHtml + `
        <div class="text-center py-8 text-gray-500">
          <i class="fas fa-bars text-3xl mb-3"></i>
          <p>Rich Menu がまだ作成されていません</p>
          <div class="flex justify-center gap-3 mt-4">
            <button onclick="createRichMenu()" class="bg-green-500 text-white px-4 py-2 rounded-lg hover:bg-green-600 transition">
              <i class="fas fa-plus mr-2"></i>Rich Menu を作成（画像付き）
            </button>
            <button onclick="createRichMenuWithoutImage()" class="bg-gray-500 text-white px-4 py-2 rounded-lg hover:bg-gray-600 transition">
              <i class="fas fa-plus mr-2"></i>メニューのみ作成
            </button>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = presetHtml + menus.map(m => `
      <div class="bg-white rounded-xl shadow-sm border p-4 mb-3">
        <div class="flex items-center justify-between">
          <div>
            <h4 class="font-semibold text-gray-800">${esc(m.name)}</h4>
            <p class="text-xs text-gray-500 mt-1">ID: ${esc(m.richMenuId)}</p>
            <p class="text-xs text-gray-500">chatBarText: ${esc(m.chatBarText)}</p>
            <p class="text-xs text-gray-500">areas: ${m.areas?.length || 0}個</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap justify-end">
            ${m.richMenuId === defaultId
              ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full"><i class="fas fa-check mr-1"></i>デフォルト</span>'
              : `<button onclick="setDefaultRichMenu('${m.richMenuId}')" class="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600">デフォルトに設定</button>`
            }
            <button onclick="uploadRichMenuImage('${m.richMenuId}')" class="text-xs bg-purple-500 text-white px-3 py-1 rounded hover:bg-purple-600"><i class="fas fa-image mr-1"></i>画像</button>
            ${currentAdmin?.role === 'superadmin' ? `<button onclick="deleteRichMenu('${m.richMenuId}')" class="text-xs bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"><i class="fas fa-trash"></i></button>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<div class="text-red-500 text-center py-4"><i class="fas fa-exclamation-circle mr-2"></i>${esc(e.message)}</div>`;
  }
}

async function createRichMenu() {
  if (!confirm('プリセット Rich Menu を作成しますか？\n\n6ボタン構成 + プリセット画像で作成し、デフォルトに設定します。')) return;

  try {
    showToast('Rich Menu を作成中...', 'success');

    // 1. まずプリセット画像を取得
    const imgRes = await fetch('/static/richmenu.png');
    let imageBlob = null;
    if (imgRes.ok) {
      imageBlob = await imgRes.blob();
    }

    // 2. Rich Menu 作成（画像付き multipart）
    let res;
    if (imageBlob) {
      const formData = new FormData();
      formData.append('image', imageBlob, 'richmenu.png');
      res = await fetch(`${API_BASE}/admin/rich-menu/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
    } else {
      res = await fetch(`${API_BASE}/admin/rich-menu/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const msg = data.data.setAsDefault
      ? `Rich Menu 作成完了（デフォルト設定済み）: ${data.data.richMenuId}`
      : `Rich Menu 作成完了: ${data.data.richMenuId}`;
    showToast(msg, 'success');
    await loadRichMenuList();
  } catch (e) {
    showToast('作成失敗: ' + e.message, 'error');
  }
}

async function createRichMenuWithoutImage() {
  if (!confirm('Rich Menu（画像なし）を作成しますか？\n\n後から画像をアップロードできます。')) return;

  try {
    showToast('Rich Menu を作成中...', 'success');
    const res = await fetch(`${API_BASE}/admin/rich-menu/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`Rich Menu 作成完了: ${data.data.richMenuId}`, 'success');
    await loadRichMenuList();
  } catch (e) {
    showToast('作成失敗: ' + e.message, 'error');
  }
}

async function setDefaultRichMenu(richMenuId) {
  if (!confirm('このRich Menuをデフォルトに設定しますか？')) return;
  try {
    const res = await fetch(`${API_BASE}/admin/rich-menu/set-default/${richMenuId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast('デフォルトに設定しました', 'success');
    await loadRichMenuList();
  } catch (e) {
    showToast('設定失敗: ' + e.message, 'error');
  }
}

async function deleteRichMenu(richMenuId) {
  if (!confirm('このRich Menuを削除しますか？\n※ ユーザー全員のメニューが消えます')) return;
  try {
    const res = await fetch(`${API_BASE}/admin/rich-menu/${richMenuId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast('削除しました', 'success');
    await loadRichMenuList();
  } catch (e) {
    showToast('削除失敗: ' + e.message, 'error');
  }
}

async function uploadRichMenuImage(richMenuId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      showToast('画像アップロード中...', 'success');
      const res = await fetch(`${API_BASE}/admin/rich-menu/upload-image/${richMenuId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast('画像アップロード完了', 'success');
    } catch (e) {
      showToast('アップロード失敗: ' + e.message, 'error');
    }
  };
  input.click();
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
