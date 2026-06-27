'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  scannerRunning: false,
  rlCount:        0,
  fnCount:        0,
  totalSynced:    0,
  lastScan:       null,
  rlLast:         null,
  fnLast:         null,
  logEntries:     [],
  updateState:    'idle', // idle | checking | available | downloading | ready | error
  updateVersion:  null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  appVersion:    $('app-version'),
  scannerDot:    $('scanner-dot'),
  btnToggle:     $('btn-toggle-scanner'),
  btnScanNow:    $('btn-scan-now'),
  statTotal:     $('stat-total'),
  statLastScan:  $('stat-last-scan'),
  statStatus:    $('stat-status'),
  statStatusSub: $('stat-status-sub'),
  rlCount:       $('rl-count'),
  rlLast:        $('rl-last'),
  rlDetected:    $('rl-detected'),
  rlPathDisplay: $('rl-path-display'),
  fnCount:       $('fn-count'),
  fnLast:        $('fn-last'),
  fnDetected:    $('fn-detected'),
  fnPathDisplay: $('fn-path-display'),
  logBody:       $('log-body'),
  logEmpty:      $('log-empty'),
  // Update
  updateBanner:       $('update-banner'),
  updateTitle:        $('update-title'),
  updateSub:          $('update-sub'),
  updateProgressWrap: $('update-progress-wrap'),
  updateProgressBar:  $('update-progress-bar'),
  btnUpdateAction:    $('btn-update-action'),
  btnUpdateDismiss:   $('btn-update-dismiss'),
  // Settings
  inputApiUrl:       $('input-api-url'),
  inputAuthUser:     $('input-auth-user'),
  inputAuthPass:     $('input-auth-pass'),
  inputRlPath:       $('input-rl-path'),
  inputFnPath:       $('input-fn-path'),
  inputScanInterval: $('input-scan-interval'),
  connBadge:         $('conn-badge'),
  btnTestConn:       $('btn-test-conn'),
  btnSaveSettings:   $('btn-save-settings'),
  btnBrowseRL:       $('btn-browse-rl'),
  btnBrowseFN:       $('btn-browse-fn'),
  btnResetProcessed: $('btn-reset-processed'),
  btnCheckUpdate:    $('btn-check-update'),
  updateSettingsSub: $('update-settings-sub'),
};

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-page]').forEach((b) => b.classList.remove('active'));
  const page = document.getElementById(`page-${name}`);
  const btn  = document.querySelector(`.nav-btn[data-page="${name}"]`);
  if (page) page.classList.add('active');
  if (btn)  btn.classList.add('active');
  if (name === 'settings') loadSettingsForm();
}

document.querySelectorAll('.nav-btn[data-page]').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// ── Window controls ───────────────────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => window.gs.minimize());
$('btn-maximize').addEventListener('click', () => window.gs.maximize());
$('btn-close').addEventListener('click',    () => window.gs.close());

// ── App version ───────────────────────────────────────────────────────────────
window.gs.version().then((v) => {
  els.appVersion.textContent = `v${v}`;
});

// ── Scanner toggle ────────────────────────────────────────────────────────────
els.btnToggle.addEventListener('click', async () => {
  if (state.scannerRunning) {
    await window.gs.stopScanner();
    state.scannerRunning = false;
  } else {
    await window.gs.startScanner();
    state.scannerRunning = true;
    state.lastScan = new Date();
  }
  renderScannerState();
});

// Scan now
els.btnScanNow.addEventListener('click', async () => {
  els.btnScanNow.disabled = true;
  addLog('info', 'Manual scan triggered…');
  try {
    await window.gs.triggerScan();
    state.lastScan = new Date();
    renderScannerState();
  } catch (e) {
    addLog('error', `Scan failed: ${e.message}`);
  }
  setTimeout(() => { els.btnScanNow.disabled = false; }, 1500);
});

// ── Scanner IPC events ────────────────────────────────────────────────────────
window.gs.on('scanner:log', (entry) => {
  addLog(entry.level, entry.message);
  if (entry.level === 'info' && entry.message.includes('Watching')) {
    renderPaths();
  }
});

window.gs.on('scanner:stats', (data) => {
  state.totalSynced++;
  state.lastScan = new Date();
  if (data.game === 'rl') { state.rlCount++; state.rlLast = new Date(); }
  else                    { state.fnCount++; state.fnLast = new Date(); }
  renderScannerState();
});

window.gs.on('scanner:error', (data) => {
  addLog('error', data.message);
});

// ── Render helpers ────────────────────────────────────────────────────────────
function renderScannerState() {
  // Status dot
  els.scannerDot.className = 'status-dot' + (state.scannerRunning ? ' running' : '');

  // Toggle button
  if (state.scannerRunning) {
    els.btnToggle.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      Stop`;
    els.btnToggle.style.background = 'var(--neg)';
    els.btnToggle.style.boxShadow   = '0 4px 18px color-mix(in oklab, var(--neg) 40%, transparent)';
  } else {
    els.btnToggle.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Start`;
    els.btnToggle.style.background = '';
    els.btnToggle.style.boxShadow   = '';
  }

  // Stats
  els.statTotal.textContent    = state.totalSynced;
  els.statLastScan.textContent = state.lastScan ? relTime(state.lastScan) : '—';
  els.statStatus.textContent   = state.scannerRunning ? 'Running' : 'Stopped';
  els.statStatus.style.color   = state.scannerRunning ? 'var(--pos)' : 'var(--text-faint)';
  els.statStatusSub.textContent = state.scannerRunning
    ? `Scanning every ${60}s · ${state.totalSynced} synced`
    : 'Start the scanner to begin';

  // Game cards
  els.rlCount.textContent = state.rlCount;
  els.fnCount.textContent = state.fnCount;
  els.rlLast.textContent  = state.rlLast ? relTime(state.rlLast) : '—';
  els.fnLast.textContent  = state.fnLast ? relTime(state.fnLast) : '—';
}

async function renderPaths() {
  const rlPath = await window.gs.get('rlPath');
  const fnPath = await window.gs.get('fnPath');
  const rlDefault = '%USERPROFILE%\\Documents\\My Games\\Rocket League\\TAGame\\Demos';
  const fnDefault = '%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos';

  const rlDisplay = rlPath || rlDefault;
  const fnDisplay = fnPath || fnDefault;

  els.rlPathDisplay.textContent = shorten(rlDisplay, 42);
  els.fnPathDisplay.textContent = shorten(fnDisplay, 42);
  els.rlDetected.textContent    = '✓';
  els.fnDetected.textContent    = '✓';
}

// ── Activity log ──────────────────────────────────────────────────────────────
function addLog(level, message) {
  const entry = { level, message, ts: Date.now() };
  state.logEntries.unshift(entry);
  if (state.logEntries.length > 200) state.logEntries.length = 200;
  renderLog();
}

function renderLog() {
  if (state.logEntries.length === 0) {
    els.logEmpty.style.display = '';
    return;
  }
  els.logEmpty.style.display = 'none';

  // Only re-render top 60 entries for perf
  const entries = state.logEntries.slice(0, 60);
  const frag = document.createDocumentFragment();

  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `
      <span class="log-time">${timeStr(e.ts)}</span>
      <span class="log-dot ${e.level}"></span>
      <span class="log-msg ${e.level === 'success' ? 'success' : e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : ''}">${escapeHtml(e.message)}</span>`;
    frag.appendChild(row);
  }

  // Replace content but keep container
  while (els.logBody.firstChild && els.logBody.firstChild !== els.logEmpty) {
    els.logBody.removeChild(els.logBody.firstChild);
  }
  els.logBody.insertBefore(frag, els.logEmpty);
}

$('btn-clear-log').addEventListener('click', () => {
  state.logEntries = [];
  while (els.logBody.firstChild && els.logBody.firstChild !== els.logEmpty) {
    els.logBody.removeChild(els.logBody.firstChild);
  }
  els.logEmpty.style.display = '';
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettingsForm() {
  const all = await window.gs.getAll();
  els.inputApiUrl.value       = all.apiUrl       || '';
  els.inputAuthUser.value     = all.authUser     || '';
  els.inputAuthPass.value     = all.authPass     || '';
  els.inputRlPath.value       = all.rlPath       || '';
  els.inputFnPath.value       = all.fnPath       || '';
  els.inputScanInterval.value = String(all.scanInterval || 60);
  setConnBadge('idle');
}

els.btnSaveSettings.addEventListener('click', async () => {
  await window.gs.set('apiUrl',       els.inputApiUrl.value.trim());
  await window.gs.set('authUser',     els.inputAuthUser.value.trim());
  await window.gs.set('authPass',     els.inputAuthPass.value.trim());
  await window.gs.set('rlPath',       els.inputRlPath.value.trim());
  await window.gs.set('fnPath',       els.inputFnPath.value.trim());
  await window.gs.set('scanInterval', parseInt(els.inputScanInterval.value, 10) || 60);

  addLog('success', 'Settings saved');
  renderPaths();
  showPage('overview');
});

els.btnTestConn.addEventListener('click', async () => {
  els.btnTestConn.disabled = true;
  setConnBadge('idle', 'Testing…');

  // Save current values temporarily so API can read them
  await window.gs.set('apiUrl',   els.inputApiUrl.value.trim());
  await window.gs.set('authUser', els.inputAuthUser.value.trim());
  await window.gs.set('authPass', els.inputAuthPass.value.trim());

  try {
    // Try wp/v2/users/me — if it returns 200, creds are valid
    const res = await fetch(`${els.inputApiUrl.value.trim().replace(/\/$/,'')}/wp-json/wp/v2/users/me`, {
      headers: {
        Authorization: 'Basic ' + btoa(`${els.inputAuthUser.value.trim()}:${els.inputAuthPass.value.trim()}`),
      },
    });
    if (res.ok) {
      const user = await res.json();
      setConnBadge('ok', `✓ ${user.name || 'Connected'}`);
      addLog('success', `Connected as ${user.name || els.inputAuthUser.value}`);
    } else {
      setConnBadge('fail', `✗ HTTP ${res.status}`);
      addLog('error', `Connection failed: HTTP ${res.status}`);
    }
  } catch (e) {
    setConnBadge('fail', '✗ Error');
    addLog('error', `Connection error: ${e.message}`);
  }

  els.btnTestConn.disabled = false;
});

function setConnBadge(state, label) {
  const labels = { ok: 'Connected', fail: 'Failed', idle: 'Untested' };
  els.connBadge.className = `conn-badge ${state}`;
  els.connBadge.textContent = label || labels[state] || 'Untested';
}

// Browse buttons
els.btnBrowseRL.addEventListener('click', async () => {
  const dir = await window.gs.openDir();
  if (dir) els.inputRlPath.value = dir;
});

els.btnBrowseFN.addEventListener('click', async () => {
  const dir = await window.gs.openDir();
  if (dir) els.inputFnPath.value = dir;
});

// Reset processed
els.btnResetProcessed.addEventListener('click', async () => {
  await window.gs.clearProcessed();
  addLog('warn', 'Processed file history cleared — all replays will be re-sent on next scan');
});

// ── Updates ───────────────────────────────────────────────────────────────────
window.gs.on('updater:status', (data) => {
  state.updateState   = data.state;
  state.updateVersion = data.version || null;
  renderUpdateBanner(data);
  renderUpdateSettings(data);
});

window.gs.on('updater:progress', (data) => {
  els.updateProgressWrap.style.display = '';
  els.updateProgressBar.style.width = `${data.percent}%`;
  els.updateSub.textContent = `Downloading… ${data.percent}%`;
});

function renderUpdateBanner(data) {
  if (data.state === 'available') {
    els.updateBanner.classList.add('visible');
    els.updateTitle.textContent   = `Update v${data.version} available`;
    els.updateSub.textContent     = 'Download and install the latest version';
    els.btnUpdateAction.textContent = 'Download';
    els.btnUpdateAction.onclick = () => window.gs.downloadUpdate();
  } else if (data.state === 'ready') {
    els.updateBanner.classList.add('visible');
    els.updateTitle.textContent   = `v${data.version} ready to install`;
    els.updateSub.textContent     = 'Restart the app to apply the update';
    els.btnUpdateAction.textContent = 'Restart & install';
    els.btnUpdateAction.onclick = () => window.gs.installUpdate();
  } else {
    // checking, latest, error — hide banner unless error
    if (data.state === 'error') {
      addLog('error', `Updater: ${data.message}`);
    }
  }
}

function renderUpdateSettings(data) {
  const msgs = {
    checking: 'Checking for updates…',
    available: `v${data.version} is available`,
    latest: 'You are on the latest version',
    error: `Update check failed: ${data.message}`,
    ready: `v${data.version} downloaded — restart to install`,
    idle: 'Auto-checks on launch via GitHub Releases',
  };
  if (els.updateSettingsSub) {
    els.updateSettingsSub.textContent = msgs[data.state] || msgs.idle;
  }
}

els.btnUpdateDismiss.addEventListener('click', () => {
  els.updateBanner.classList.remove('visible');
});

els.btnCheckUpdate.addEventListener('click', async () => {
  els.btnCheckUpdate.disabled = true;
  addLog('info', 'Checking for updates…');
  await window.gs.checkUpdate();
  setTimeout(() => { els.btnCheckUpdate.disabled = false; }, 3000);
});

// ── Dashboard link ────────────────────────────────────────────────────────────
$('btn-open-dashboard').addEventListener('click', async () => {
  const url = await window.gs.get('apiUrl');
  if (url) window.gs.openExternal(url + '/dashboard/');
  else     window.gs.openExternal('https://yourdomain.com/dashboard/');
});

// ── Utility ───────────────────────────────────────────────────────────────────
function relTime(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function timeStr(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

function shorten(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return '…' + str.slice(-(maxLen - 1));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Tick (update relative times) ─────────────────────────────────────────────
setInterval(() => {
  if (state.lastScan) {
    els.statLastScan.textContent = relTime(state.lastScan);
  }
}, 10000);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const status = await window.gs.scannerStatus();
  state.scannerRunning = status.running;
  if (status.scanCount) {
    state.rlCount = status.scanCount.rl || 0;
    state.fnCount = status.scanCount.fn || 0;
  }
  renderScannerState();
  renderPaths();
}

init();
