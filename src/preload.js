'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gs', {
  minimize:  ()      => ipcRenderer.send('win:minimize'),
  maximize:  ()      => ipcRenderer.send('win:maximize'),
  close:     ()      => ipcRenderer.send('win:close'),
  get:    (k)        => ipcRenderer.invoke('store:get', k),
  set:    (k,v)      => ipcRenderer.invoke('store:set', k, v),
  getAll: ()         => ipcRenderer.invoke('store:getAll'),
  version:()         => ipcRenderer.invoke('app:version'),
  startScanner:  ()  => ipcRenderer.invoke('scanner:start'),
  stopScanner:   ()  => ipcRenderer.invoke('scanner:stop'),
  scanNow:       ()  => ipcRenderer.invoke('scanner:scan'),
  scannerStatus: ()  => ipcRenderer.invoke('scanner:status'),
  clearProcessed:()  => ipcRenderer.invoke('scanner:clearProcessed'),
  openDir:       ()  => ipcRenderer.invoke('dialog:openDir'),
  openExternal:(url) => ipcRenderer.send('shell:open', url),
  checkUpdate:   ()  => ipcRenderer.invoke('updater:check'),
  downloadUpdate:()  => ipcRenderer.invoke('updater:download'),
  installUpdate: ()  => ipcRenderer.invoke('updater:install'),
  on:(channel,fn)=>{
    const safe=['scanner:log','scanner:stats','scanner:error','updater:status','updater:progress'];
    if(!safe.includes(channel))return;
    const cb=(_,...a)=>fn(...a);
    ipcRenderer.on(channel,cb);
    return ()=>ipcRenderer.removeListener(channel,cb);
  }
});
