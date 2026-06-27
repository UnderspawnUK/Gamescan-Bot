'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const log     = require('electron-log');
const chokidar = require('chokidar');

const RLParser = require('./rl-parser');
const FNParser = require('./fn-parser');
const API      = require('../api');

// Default replay paths on Windows
const DEFAULT_RL_PATH = path.join(
  process.env.USERPROFILE || '',
  'Documents', 'My Games', 'Rocket League', 'TAGame', 'Demos'
);

const DEFAULT_FN_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'FortniteGame', 'Saved', 'Demos'
);

class Scanner {
  constructor({ store, onLog, onStats, onError }) {
    this.store   = store;
    this.onLog   = onLog   || (() => {});
    this.onStats = onStats || (() => {});
    this.onError = onError || (() => {});

    this.watchers  = [];
    this.timer     = null;
    this.running   = false;
    this.scanCount = { rl: 0, fn: 0 };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    this._log('info', 'Scanner started');
    this._watchPaths();
    // Also do an immediate scan on start
    this.scan().catch((err) => this.onError(err));
    // Then schedule every N seconds
    const interval = (this.store.get('scanInterval') || 60) * 1000;
    this.timer = setInterval(() => {
      this.scan().catch((err) => this.onError(err));
    }, interval);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    this._log('info', 'Scanner stopped');
  }

  getStatus() {
    return {
      running:   this.running,
      scanCount: this.scanCount,
      rlPath:    this._rlPath(),
      fnPath:    this._fnPath(),
    };
  }

  async scan() {
    const results = { rl: [], fn: [] };

    results.rl = await this._scanDir(this._rlPath(), 'rl');
    results.fn = await this._scanDir(this._fnPath(), 'fn');

    return results;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _rlPath() { return this.store.get('rlPath') || DEFAULT_RL_PATH; }
  _fnPath() { return this.store.get('fnPath') || DEFAULT_FN_PATH; }

  _watchPaths() {
    const opts = {
      persistent:        true,
      ignoreInitial:     true,
      awaitWriteFinish:  { stabilityThreshold: 2000, pollInterval: 200 },
      depth: 0,
    };

    const rlPath = this._rlPath();
    const fnPath = this._fnPath();

    if (fs.existsSync(rlPath)) {
      const w = chokidar.watch(path.join(rlPath, '*.replay'), opts);
      w.on('add', (fp) => this._handleNewFile(fp, 'rl'));
      this.watchers.push(w);
      this._log('info', `Watching RL: ${rlPath}`);
    } else {
      this._log('warn', `RL path not found: ${rlPath}`);
    }

    if (fs.existsSync(fnPath)) {
      const w = chokidar.watch(path.join(fnPath, '*.replay'), opts);
      w.on('add', (fp) => this._handleNewFile(fp, 'fn'));
      this.watchers.push(w);
      this._log('info', `Watching FN: ${fnPath}`);
    } else {
      this._log('warn', `FN path not found: ${fnPath}`);
    }
  }

  async _scanDir(dirPath, game) {
    if (!fs.existsSync(dirPath)) return [];
    const processed = [];

    let files;
    try {
      files = fs.readdirSync(dirPath)
        .filter((f) => f.toLowerCase().endsWith('.replay'))
        .map((f) => path.join(dirPath, f));
    } catch { return []; }

    for (const fp of files) {
      if (this._isProcessed(fp)) continue;
      try {
        await this._handleNewFile(fp, game);
        processed.push(fp);
      } catch (err) {
        this._log('error', `Failed to process ${path.basename(fp)}: ${err.message}`);
      }
    }

    return processed;
  }

  async _handleNewFile(filePath, game) {
    if (this._isProcessed(filePath)) return;

    const name = path.basename(filePath);
    this._log('info', `Found new ${game.toUpperCase()} replay: ${name}`);

    let parsed;
    try {
      if (game === 'rl') {
        parsed = RLParser.parse(filePath);
        this.scanCount.rl++;
      } else {
        parsed = FNParser.parse(filePath);
        this.scanCount.fn++;
      }
    } catch (err) {
      this._log('error', `Parse error (${name}): ${err.message}`);
      // Mark as processed anyway so we don't retry bad files forever
      this._markProcessed(filePath);
      return;
    }

    if (!parsed) {
      this._markProcessed(filePath);
      return;
    }

    this._log('info', `Parsed ${name} — sending to dashboard`);

    try {
      const api = new API(this.store);
      const res = await api.postMatch({ game, ...parsed });
      this._markProcessed(filePath);
      this.onStats({ game, file: name, match: parsed, response: res });
      this._log('success', `Sent ${name} — ${this._statsLine(game, parsed)}`);
    } catch (err) {
      this._log('error', `API error for ${name}: ${err.message}`);
      // Don't mark processed — will retry next scan
    }
  }

  _isProcessed(filePath) {
    const hash = this._fileHash(filePath);
    const processed = this.store.get('processedFiles') || {};
    return !!processed[hash];
  }

  _markProcessed(filePath) {
    const hash = this._fileHash(filePath);
    const processed = this.store.get('processedFiles') || {};
    processed[hash] = { path: filePath, ts: Date.now() };
    this.store.set('processedFiles', processed);
  }

  // Use filename + size as a cheap, stable hash (no need to read whole file)
  _fileHash(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return crypto.createHash('md5')
        .update(path.basename(filePath) + String(stat.size))
        .digest('hex');
    } catch {
      return crypto.createHash('md5').update(filePath).digest('hex');
    }
  }

  _statsLine(game, parsed) {
    if (game === 'rl') {
      return `Score ${parsed.score || 0} | Goals ${parsed.goals || 0} | Saves ${parsed.saves || 0} | Assists ${parsed.assists || 0}`;
    }
    return `Kills ${parsed.kills || 0} | Damage ${parsed.damageDealt || 0} | Placement ${parsed.placement || '?'}`;
  }

  _log(level, message) {
    log[level === 'success' ? 'info' : level](`[Scanner] ${message}`);
    this.onLog({ level, message, ts: Date.now() });
  }
}

module.exports = Scanner;
