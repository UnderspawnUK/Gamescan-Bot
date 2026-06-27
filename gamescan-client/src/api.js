'use strict';

const fetch = require('node-fetch');
const log   = require('electron-log');

class API {
  constructor(store) {
    this.store = store;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _base()   { return (this.store.get('apiUrl') || '').replace(/\/$/, ''); }
  _user()   { return this.store.get('authUser') || ''; }
  _pass()   { return this.store.get('authPass') || ''; }

  _authHeader() {
    const creds = Buffer.from(`${this._user()}:${this._pass()}`).toString('base64');
    return `Basic ${creds}`;
  }

  async _request(method, endpoint, body) {
    const base = this._base();
    if (!base) throw new Error('No API URL configured');

    const url = `${base}/wp-json/gamescan/v1/${endpoint}`;
    const opts = {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': this._authHeader(),
        'X-Source':      'gamescan-desktop',
      },
    };

    if (body) opts.body = JSON.stringify(body);

    log.info(`[API] ${method} ${url}`);

    const res = await fetch(url, opts);
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      const msg = data?.message || data?.code || `HTTP ${res.status}`;
      throw new Error(`API error: ${msg}`);
    }

    return data;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * POST a parsed match to /wp-json/gamescan/v1/match
   * The WP endpoint should handle deduplication by replayFile name.
   */
  async postMatch(matchData) {
    return this._request('POST', 'match', matchData);
  }

  /**
   * GET /wp-json/gamescan/v1/ping — verify credentials & connection
   */
  async ping() {
    return this._request('GET', 'ping');
  }

  /**
   * GET current user info from WP
   */
  async getUser() {
    const base = this._base();
    if (!base) throw new Error('No API URL configured');

    const url = `${base}/wp-json/wp/v2/users/me`;
    const res = await fetch(url, {
      headers: { 'Authorization': this._authHeader() },
    });
    if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
    return res.json();
  }
}

module.exports = API;
