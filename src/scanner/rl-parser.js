'use strict';

const fs   = require('fs');
const path = require('path');

function ri32(b, o) { return b.readInt32LE(o); }
function ru32(b, o) { return b.readUInt32LE(o); }
function rf32(b, o) { return b.readFloatLE(o); }

function rstr(b, o) {
  if (o + 4 > b.length) return { v: '', n: o + 4 };
  const len = ri32(b, o); o += 4;
  if (len === 0) return { v: '', n: o };
  if (len < 0) {
    const bl = (-len) * 2;
    if (o + bl > b.length) return { v: '', n: o + bl };
    return { v: b.slice(o, o + bl - 2).toString('utf16le'), n: o + bl };
  }
  if (o + len > b.length) return { v: '', n: o + len };
  return { v: b.slice(o, o + len - 1).toString('utf8'), n: o + len };
}

function readVal(b, o, type) {
  switch (type) {
    case 'IntProperty':   return { v: ri32(b, o + 8), n: o + 12 };
    case 'FloatProperty': return { v: rf32(b, o + 8), n: o + 12 };
    case 'BoolProperty':  return { v: b[o + 8] === 1, n: o + 9 };
    case 'StrProperty':
    case 'NameProperty': { const r = rstr(b, o + 8); return { v: r.v, n: r.n }; }
    case 'ByteProperty': {
      const { v: en, n: o1 } = rstr(b, o + 8);
      if (en === 'None') return { v: b[o1], n: o1 + 1 };
      const { v: ev, n: o2 } = rstr(b, o1);
      return { v: ev, n: o2 };
    }
    default: {
      const size = ru32(b, o);
      return { v: null, n: o + 8 + size };
    }
  }
}

function parseProps(b, start) {
  const props = {};
  let o = start;
  for (let i = 0; i < 200 && o < b.length - 8; i++) {
    const { v: name, n: o1 } = rstr(b, o);
    if (!name || name === 'None') break;
    const { v: type, n: o2 } = rstr(b, o1);
    try {
      const { v: val, n: o3 } = readVal(b, o2, type);
      props[name] = val;
      o = o3;
    } catch { break; }
  }
  return props;
}

function parse(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const sz = Math.min(131072, fs.fstatSync(fd).size);
  const b  = Buffer.alloc(sz);
  fs.readSync(fd, b, 0, sz, 0);
  fs.closeSync(fd);

  const props = parseProps(b, 16);
  const p = k => props[k] != null ? props[k] : null;

  return {
    game:        'rocket_league',
    replayFile:  path.basename(filePath),
    date:        p('Date') || p('ReplayDate'),
    mapName:     p('MapName') || p('Map') || 'Unknown',
    playerName:  p('PlayerName'),
    teamSize:    p('TeamSize') || 3,
    team0Score:  p('Team0Score') || 0,
    team1Score:  p('Team1Score') || 0,
    score:       p('Score') || 0,
    goals:       p('Goals') || 0,
    assists:     p('Assists') || 0,
    saves:       p('Saves') || 0,
    shots:       p('Shots') || 0,
    demolitions: p('Demolitions') || 0
  };
}

module.exports = { parse };
