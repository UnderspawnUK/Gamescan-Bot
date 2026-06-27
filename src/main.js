'use strict';

// ═══════════════════════════════════════════════════════════════════
//  GAMESCAN DESKTOP CLIENT  —  single-file main process
//  Includes: Electron app + Scanner + RL parser + FN parser + API
// ═══════════════════════════════════════════════════════════════════

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const log    = require('electron-log');
const Store  = require('electron-store');
const fetch  = require('node-fetch');
const chokidar = require('chokidar');
const { autoUpdater } = require('electron-updater');

log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = false;

// ── Store ──────────────────────────────────────────────────────────
const store = new Store({
  defaults: {
    apiUrl: '', authUser: '', authPass: '',
    rlPath: '', fnPath: '', scanInterval: 60,
    processedFiles: {}
  }
});

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, tray = null, scanner = null;

// ══════════════════════════════════════════════════════════════════
//  API CLIENT
// ══════════════════════════════════════════════════════════════════
function apiAuth() {
  return 'Basic ' + Buffer.from(store.get('authUser') + ':' + store.get('authPass')).toString('base64');
}
async function apiPost(endpoint, body) {
  const base = (store.get('apiUrl') || '').replace(/\/$/, '');
  if (!base) throw new Error('No API URL set');
  const res = await fetch(base + '/wp-json/gamescan/v1/' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiAuth(), 'X-Source': 'gamescan-desktop' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
  return data;
}

// ══════════════════════════════════════════════════════════════════
//  ROCKET LEAGUE PARSER
// ══════════════════════════════════════════════════════════════════
function parseRL(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const sz = Math.min(131072, fs.fstatSync(fd).size);
  const b  = Buffer.alloc(sz);
  fs.readSync(fd, b, 0, sz, 0);
  fs.closeSync(fd);

  function ri(o) { return b.readInt32LE(o); }
  function rstr(o) {
    if (o + 4 > b.length) return { v: '', n: o + 4 };
    const len = ri(o); o += 4;
    if (len === 0) return { v: '', n: o };
    if (len < 0) { const bl = (-len)*2; return { v: b.slice(o, o+bl-2).toString('utf16le'), n: o+bl }; }
    return { v: b.slice(o, o+len-1).toString('utf8'), n: o+len };
  }
  function readVal(o, type) {
    if (type === 'IntProperty')   return { v: ri(o+8),              n: o+12 };
    if (type === 'FloatProperty') return { v: b.readFloatLE(o+8),   n: o+12 };
    if (type === 'BoolProperty')  return { v: b[o+8]===1,           n: o+9  };
    if (type === 'StrProperty' || type === 'NameProperty') { const r=rstr(o+8); return { v:r.v, n:r.n }; }
    if (type === 'ByteProperty')  { const {v:en,n:o1}=rstr(o+8); if(en==='None') return {v:b[o1],n:o1+1}; const {v:ev,n:o2}=rstr(o1); return {v:ev,n:o2}; }
    return { v: null, n: o + 8 + b.readUInt32LE(o) };
  }

  const props = {};
  let o = 16;
  for (let i = 0; i < 200 && o < b.length-8; i++) {
    const {v:name,n:o1} = rstr(o); if (!name || name==='None') break;
    const {v:type,n:o2} = rstr(o1);
    try { const {v,n:o3} = readVal(o2, type); props[name]=v; o=o3; } catch { break; }
  }
  const p = k => props[k] != null ? props[k] : null;
  return {
    game: 'rocket_league', replayFile: path.basename(filePath),
    date: p('Date')||p('ReplayDate'), mapName: p('MapName')||p('Map')||'Unknown',
    playerName: p('PlayerName'), teamSize: p('TeamSize')||3,
    team0Score: p('Team0Score')||0, team1Score: p('Team1Score')||0,
    score: p('Score')||0, goals: p('Goals')||0, assists: p('Assists')||0,
    saves: p('Saves')||0, shots: p('Shots')||0, demolitions: p('Demolitions')||0
  };
}

// ══════════════════════════════════════════════════════════════════
//  FORTNITE PARSER
// ══════════════════════════════════════════════════════════════════
function parseFN(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const sz = Math.min(4*1024*1024, fs.fstatSync(fd).size);
  const b  = Buffer.alloc(sz);
  fs.readSync(fd, b, 0, sz, 0);
  fs.closeSync(fd);

  if (b.readUInt32LE(0) !== 0x1CA2E27F) throw new Error('Not a Fortnite replay');
  const durationMs = b.readUInt32LE(8);
  function rstr(o) {
    const len = b.readInt32LE(o); o += 4;
    if (len===0) return {v:'',n:o};
    if (len<0) { const bl=(-len)*2; return {v:b.slice(o,o+bl-2).toString('utf16le'),n:o+bl}; }
    return {v:b.slice(o,o+len-1).toString('utf8'),n:o+len};
  }
  const {v:friendlyName,n:o1} = rstr(12);
  let date = null;
  if (o1+8 <= b.length) {
    const lo=b.readUInt32LE(o1), hi=b.readUInt32LE(o1+4);
    date = new Date((hi*0x100000000+lo)/10000 - 11644473600000).toISOString();
  }
  const raw = b.slice(o1+8).toString('latin1');
  const num = pat => { const m=raw.match(new RegExp(pat+'[^\\d]*(\\d+)','i')); return m?parseInt(m[1],10):0; };
  return {
    game: 'fortnite', replayFile: path.basename(filePath), date, durationMs, friendlyName,
    kills:        num('(?:TotalKills|KillCount|Eliminations)'),
    assists:      num('(?:AssistCount|Assists)'),
    placement:    num('(?:FinishingPlacement|Placement|Place)')||null,
    damageDealt:  num('(?:DamageDealt|DamageDone)'),
    damageTaken:  num('(?:DamageTaken|DamageReceived)'),
    headshotKills:num('(?:HeadshotKills|Headshots)'),
    gameMode: /squad/i.test(raw)?'Squad':/duo/i.test(raw)?'Duos':'Solo'
  };
}

// ══════════════════════════════════════════════════════════════════
//  SCANNER
// ══════════════════════════════════════════════════════════════════
const DEFAULT_RL = path.join(process.env.USERPROFILE||'', 'Documents','My Games','Rocket League','TAGame','Demos');
const DEFAULT_FN = path.join(process.env.LOCALAPPDATA||'', 'FortniteGame','Saved','Demos');

class Scanner {
  constructor() {
    this.watchers=[]; this.timer=null; this.running=false; this.counts={rl:0,fn:0};
  }
  rlPath() { return store.get('rlPath')||DEFAULT_RL; }
  fnPath() { return store.get('fnPath')||DEFAULT_FN; }

  start() {
    if (this.running) return;
    this.running = true;
    log.info('[Scanner] started');
    send('scanner:log', { level:'info', message:'Scanner started', ts:Date.now() });
    this._watch();
    this._scanAll();
    const ms = (store.get('scanInterval')||60)*1000;
    this.timer = setInterval(() => this._scanAll(), ms);
  }
  stop() {
    this.running=false; clearInterval(this.timer); this.timer=null;
    this.watchers.forEach(w=>w.close()); this.watchers=[];
    send('scanner:log', { level:'info', message:'Scanner stopped', ts:Date.now() });
  }
  getStatus() { return { running:this.running, counts:this.counts, rlPath:this.rlPath(), fnPath:this.fnPath() }; }

  _watch() {
    const opts = { persistent:true, ignoreInitial:true, awaitWriteFinish:{stabilityThreshold:2000} };
    for (const [p,game] of [[this.rlPath(),'rl'],[this.fnPath(),'fn']]) {
      if (!fs.existsSync(p)) { this._log('warn', game.toUpperCase()+' folder not found: '+p); continue; }
      const w = chokidar.watch(path.join(p,'*.replay'), opts);
      w.on('add', fp => this._handle(fp, game));
      this.watchers.push(w);
      this._log('info', 'Watching '+game.toUpperCase()+': '+p);
    }
  }
  _scanAll() {
    for (const [p,game] of [[this.rlPath(),'rl'],[this.fnPath(),'fn']]) {
      if (!fs.existsSync(p)) continue;
      try {
        fs.readdirSync(p).filter(f=>f.endsWith('.replay'))
          .forEach(f => { const fp=path.join(p,f); if(!this._seen(fp)) this._handle(fp,game); });
      } catch {}
    }
  }
  async _handle(fp, game) {
    if (this._seen(fp)) return;
    const name = path.basename(fp);
    this._log('info', 'New '+game.toUpperCase()+' replay: '+name);
    let parsed;
    try { parsed = game==='rl' ? parseRL(fp) : parseFN(fp); this.counts[game]++; }
    catch (e) { this._log('error','Parse failed ('+name+'): '+e.message); this._mark(fp); return; }
    try {
      await apiPost('match', parsed);
      this._mark(fp);
      send('scanner:stats', { game, file:name, match:parsed });
      this._log('success', 'Sent '+name);
    } catch (e) { this._log('error','API error ('+name+'): '+e.message); }
  }
  _key(fp) {
    try { const s=fs.statSync(fp); return crypto.createHash('md5').update(path.basename(fp)+s.size).digest('hex'); }
    catch { return crypto.createHash('md5').update(fp).digest('hex'); }
  }
  _seen(fp) { return !!(store.get('processedFiles')||{})[this._key(fp)]; }
  _mark(fp) { const m=store.get('processedFiles')||{}; m[this._key(fp)]=Date.now(); store.set('processedFiles',m); }
  _log(level, message) {
    log[level==='success'?'info':level]('[Scanner] '+message);
    send('scanner:log', { level, message, ts:Date.now() });
  }
}

// ══════════════════════════════════════════════════════════════════
//  ELECTRON APP
// ══════════════════════════════════════════════════════════════════
function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width:960, height:660, minWidth:800, minHeight:540,
    frame:false, backgroundColor:'#0a0a0f', show:false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation:true, nodeIntegration:false
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico')
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'tray.ico'));
    tray.setToolTip('Gamescan');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label:'Open Gamescan', click:()=>{ win.show(); win.focus(); } },
      { type:'separator' },
      { label:'Quit', click:()=>{ app.isQuitting=true; app.quit(); } }
    ]));
    tray.on('double-click', ()=>{ win.show(); win.focus(); });
  } catch(e) { log.warn('Tray failed:', e.message); }
}

// IPC
ipcMain.on('win:minimize', ()=> win.minimize());
ipcMain.on('win:maximize', ()=> win.isMaximized()?win.unmaximize():win.maximize());
ipcMain.on('win:close',    ()=> win.hide());

ipcMain.handle('store:get',    (_,k)   => store.get(k));
ipcMain.handle('store:set',    (_,k,v) => store.set(k,v));
ipcMain.handle('store:getAll', ()      => store.store);
ipcMain.handle('app:version',  ()      => app.getVersion());

ipcMain.handle('scanner:start',          ()=> { if(!scanner){scanner=new Scanner();scanner.start();} return true; });
ipcMain.handle('scanner:stop',           ()=> { if(scanner){scanner.stop();scanner=null;} return true; });
ipcMain.handle('scanner:scan',           ()=> scanner?scanner._scanAll():null);
ipcMain.handle('scanner:status',         ()=> scanner?scanner.getStatus():{running:false});
ipcMain.handle('scanner:clearProcessed', ()=> { store.set('processedFiles',{}); return true; });

ipcMain.handle('dialog:openDir', async ()=> {
  const r = await dialog.showOpenDialog(win,{properties:['openDirectory']});
  return r.canceled?null:r.filePaths[0];
});
ipcMain.on('shell:open', (_,url)=> shell.openExternal(url));

ipcMain.handle('updater:check',    ()=> autoUpdater.checkForUpdates().catch(e=>({error:e.message})));
ipcMain.handle('updater:download', ()=> autoUpdater.downloadUpdate());
ipcMain.handle('updater:install',  ()=> { app.isQuitting=true; autoUpdater.quitAndInstall(); });

autoUpdater.on('update-available',     i=> send('updater:status',{state:'available',version:i.version}));
autoUpdater.on('update-not-available', ()=> send('updater:status',{state:'latest'}));
autoUpdater.on('update-downloaded',    i=> send('updater:status',{state:'ready',version:i.version}));
autoUpdater.on('download-progress',    p=> send('updater:progress',{percent:Math.round(p.percent)}));
autoUpdater.on('error',                e=> send('updater:status',{state:'error',message:e.message}));

app.whenReady().then(()=>{
  createWindow();
  createTray();
  if (store.get('apiUrl') && store.get('authUser')) { scanner=new Scanner(); scanner.start(); }
  if (!process.argv.includes('--dev')) setTimeout(()=>autoUpdater.checkForUpdates().catch(()=>{}), 6000);
});
app.on('second-instance', ()=>{ if(win){win.show();win.focus();} });
app.on('window-all-closed', ()=>{});
app.on('before-quit', ()=>{ app.isQuitting=true; if(scanner){scanner.stop();scanner=null;} });
