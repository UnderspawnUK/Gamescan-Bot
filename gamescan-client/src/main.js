'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path   = require('path');
const log    = require('electron-log');
const Store  = require('electron-store');
const { autoUpdater } = require('electron-updater');

// ── Logging ─────────────────────────────────────────────────────────────────
log.transports.file.level = 'info';
autoUpdater.logger = log;

// ── Single-instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ── Persistent store ─────────────────────────────────────────────────────────
const store = new Store({
  defaults: {
    windowBounds: { width: 920, height: 640 },
    apiUrl:       '',
    authUser:     '',
    authPass:     '',
    rlPath:       '',
    fnPath:       '',
    scanInterval: 60,
    processedFiles: {},
  }
});

let mainWindow = null;
let tray       = null;
let scanner    = null;

// ── Create window ─────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth:  780,
    minHeight: 520,
    frame:     false,        // custom titlebar
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Save window size on close
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  });

  mainWindow.on('close', (e) => {
    // Minimise to tray instead of quitting
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Dev tools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.ico');
  tray = new Tray(iconPath);

  const menu = Menu.buildFromTemplate([
    { label: 'Open Gamescan', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit',          click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Gamescan — scanning for replays');
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupUpdater() {
  autoUpdater.autoDownload    = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('updater:status', { state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('updater:status', { state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('updater:status', { state: 'latest' });
  });

  autoUpdater.on('download-progress', (prog) => {
    sendToRenderer('updater:progress', { percent: Math.round(prog.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('updater:status', { state: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.error('Updater error:', err);
    sendToRenderer('updater:status', { state: 'error', message: err.message });
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // Window controls
  ipcMain.on('window:minimize',  () => mainWindow.minimize());
  ipcMain.on('window:maximize',  () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  ipcMain.on('window:close',     () => mainWindow.hide());

  // Store / settings
  ipcMain.handle('store:get', (_e, key)        => store.get(key));
  ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); return true; });
  ipcMain.handle('store:getAll', () => store.store);

  // Updater
  ipcMain.handle('updater:check',    () => autoUpdater.checkForUpdates());
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
  ipcMain.handle('updater:install',  () => { app.isQuitting = true; autoUpdater.quitAndInstall(); });

  // App info
  ipcMain.handle('app:version', () => app.getVersion());

  // Open external link
  ipcMain.on('shell:openExternal', (_e, url) => shell.openExternal(url));

  // Scanner control
  ipcMain.handle('scanner:start',  () => startScanner());
  ipcMain.handle('scanner:stop',   () => stopScanner());
  ipcMain.handle('scanner:status', () => scanner ? scanner.getStatus() : { running: false });
  ipcMain.handle('scanner:clearProcessed', () => {
    store.set('processedFiles', {});
    return true;
  });

  // Manually trigger a scan
  ipcMain.handle('scanner:scan', () => {
    if (scanner) return scanner.scan();
    return { scanned: 0 };
  });

  // Browse for folder (file dialog)
  ipcMain.handle('dialog:openDir', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

// ── Scanner lifecycle ─────────────────────────────────────────────────────────
function startScanner() {
  if (scanner) return { running: true };

  const Scanner = require('./scanner/scanner');
  scanner = new Scanner({
    store,
    onLog:   (entry) => sendToRenderer('scanner:log',   entry),
    onStats: (data)  => sendToRenderer('scanner:stats',  data),
    onError: (err)   => sendToRenderer('scanner:error',  { message: err.message || String(err) }),
  });

  scanner.start();
  return { running: true };
}

function stopScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
  return { running: false };
}

// ── Helper ────────────────────────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  setupUpdater();
  setupIPC();

  // Auto-start scanner if credentials are set
  const apiUrl  = store.get('apiUrl');
  const authUser = store.get('authUser');
  if (apiUrl && authUser) {
    startScanner();
  }

  // Check for updates silently on start (not in dev mode)
  if (!process.argv.includes('--dev')) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
});

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopScanner();
});
