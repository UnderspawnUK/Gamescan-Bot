'use strict';

const fetch = require('node-fetch');
const log   = require('electron-log');

class API {
  constructor(store) {
    this.store = store;
  }

  _base() { return (this.store.get('apiUrl') || '').replace(/\/$/, ''); }
  _user() { return this.store.get('authUser') || ''; }
  _pass() { return this.store.get('authPass') || ''; }
  _auth() { return 'Basic ' + Buffer.from(this._user() + ':' + this._pass()).toString('base64'); }

  async request(method, endpoint, body) {
    const url = this._base() + '/wp-json/gamescan/v1/' + endpoint;
    if (!this._base()) throw new Error('No API URL set');

    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._auth(),
        'X-Source': 'gamescan-desktop'
      }
    };
    if (body) opts.body = JSON.stringify(body);

    log.info('[API]', method, url);
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
    return data;
  }

  postMatch(data)  { return this.request('POST', 'match', data); }
  ping()           { return this.request('GET',  'ping'); }
}

module.exports = API;
