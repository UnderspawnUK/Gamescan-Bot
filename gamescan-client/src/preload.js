'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, typed API to the renderer
contextBridge.exposeInMainWorld('gs', {
  // ── Window controls ────────────────────────────────────────────────────────
  minimize:  () => ipcRenderer.send('window:minimize'),
  maximize:  () => ipcRenderer.send('window:maximize'),
  close:     () => ipcRenderer.send('window:close'),

  // ── Persistent store ───────────────────────────────────────────────────────
  get:    (key)         => ipcRenderer.invoke('store:get',    key),
  set:    (key, value)  => ipcRenderer.invoke('store:set',    key, value),
  getAll: ()            => ipcRenderer.invoke('store:getAll'),

  // ── App info ───────────────────────────────────────────────────────────────
  version: () => ipcRenderer.invoke('app:version'),

  // ── Updater ────────────────────────────────────────────────────────────────
  checkUpdate:    () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate:  () => ipcRenderer.invoke('updater:install'),

  // ── Scanner ────────────────────────────────────────────────────────────────
  startScanner:         () => ipcRenderer.invoke('scanner:start'),
  stopScanner:          () => ipcRenderer.invoke('scanner:stop'),
  scannerStatus:        () => ipcRenderer.invoke('scanner:status'),
  clearProcessed:       () => ipcRenderer.invoke('scanner:clearProcessed'),
  triggerScan:          () => ipcRenderer.invoke('scanner:scan'),

  // ── File dialog ────────────────────────────────────────────────────────────
  openDir: () => ipcRenderer.invoke('dialog:openDir'),

  // ── External links ─────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // ── Event listeners (renderer subscribes) ─────────────────────────────────
  on: (channel, fn) => {
    const allowed = [
      'updater:status', 'updater:progress',
      'scanner:log', 'scanner:stats', 'scanner:error',
    ];
    if (allowed.includes(channel)) {
      const wrapped = (_event, ...args) => fn(...args);
      ipcRenderer.on(channel, wrapped);
      // Return unsubscribe function
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
});
