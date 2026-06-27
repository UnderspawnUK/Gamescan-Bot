'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const log    = require('electron-log');
const chokidar = require('chokidar');
const RLP    = require('./rl-parser');
const FNP    = require('./fn-parser');
const API    = require('../api');

const DEFAULT_RL = path.join(process.env.USERPROFILE || '', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Demos');
const DEFAULT_FN = path.join(process.env.LOCALAPPDATA || '', 'FortniteGame', 'Saved', 'Demos');

class Scanner {
  constructor({ store, onLog, onStats, onError }) {
    this.store   = store;
    this.onLog   = onLog   || (() => {});
    this.onStats = onStats || (() => {});
    this.onError = onError || (() => {});
    this.watchers  = [];
    this.timer     = null;
    this.running   = false;
    this.counts    = { rl: 0, fn: 0 };
  }

  rlPath() { return this.store.get('rlPath') || DEFAULT_RL; }
  fnPath() { return this.store.get('fnPath') || DEFAULT_FN; }

  start() {
    if (this.running) return;
    this.running = true;
    this._log('info', 'Scanner started');
    this._watch();
    this.scan();
    const ms = (this.store.get('scanInterval') || 60) * 1000;
    this.timer = setInterval(() => this.scan(), ms);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.watchers.forEach(w => w.close());
    this.watchers = [];
    this._log('info', 'Scanner stopped');
  }

  getStatus() {
    return { running: this.running, counts: this.counts, rlPath: this.rlPath(), fnPath: this.fnPath() };
  }

  scan() {
    this._scanDir(this.rlPath(), 'rl');
    this._scanDir(this.fnPath(), 'fn');
  }

  _watch() {
    const opts = { persistent: true, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 2000 } };
    for (const [p, game] of [[this.rlPath(), 'rl'], [this.fnPath(), 'fn']]) {
      if (!fs.existsSync(p)) { this._log('warn', game.toUpperCase() + ' folder not found: ' + p); continue; }
      const w = chokidar.watch(path.join(p, '*.replay'), opts);
      w.on('add', fp => this._handle(fp, game));
      this.watchers.push(w);
      this._log('info', 'Watching ' + game.toUpperCase() + ': ' + p);
    }
  }

  _scanDir(dir, game) {
    if (!fs.existsSync(dir)) return;
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.replay')).map(f => path.join(dir, f)); }
    catch { return; }
    for (const fp of files) {
      if (!this._seen(fp)) this._handle(fp, game);
    }
  }

  async _handle(fp, game) {
    if (this._seen(fp)) return;
    const name = path.basename(fp);
    this._log('info', 'New ' + game.toUpperCase() + ' replay: ' + name);
    let parsed;
    try {
      parsed = game === 'rl' ? RLP.parse(fp) : FNP.parse(fp);
      this.counts[game]++;
    } catch (e) {
      this._log('error', 'Parse failed (' + name + '): ' + e.message);
      this._mark(fp);
      return;
    }
    try {
      const api = new API(this.store);
      const res = await api.postMatch({ game, ...parsed });
      this._mark(fp);
      this.onStats({ game, file: name, match: parsed });
      this._log('success', 'Sent ' + name);
    } catch (e) {
      this._log('error', 'API error (' + name + '): ' + e.message);
    }
  }

  _key(fp) {
    try {
      const s = fs.statSync(fp);
      return crypto.createHash('md5').update(path.basename(fp) + s.size).digest('hex');
    } catch { return crypto.createHash('md5').update(fp).digest('hex'); }
  }
  _seen(fp) { return !!(this.store.get('processedFiles') || {})[this._key(fp)]; }
  _mark(fp) {
    const m = this.store.get('processedFiles') || {};
    m[this._key(fp)] = Date.now();
    this.store.set('processedFiles', m);
  }
  _log(level, msg) {
    log[level === 'success' ? 'info' : level]('[Scanner] ' + msg);
    this.onLog({ level, message: msg, ts: Date.now() });
  }
}

module.exports = Scanner;
