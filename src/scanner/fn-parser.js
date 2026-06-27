'use strict';

const fs   = require('fs');
const path = require('path');

const FN_MAGIC = 0x1CA2E27F;

function ri32(b, o) { return b.readInt32LE(o); }
function ru32(b, o) { return b.readUInt32LE(o); }

function rstr(b, o) {
  if (o + 4 > b.length) return { v: '', n: o + 4 };
  const len = ri32(b, o); o += 4;
  if (len === 0) return { v: '', n: o };
  if (len < 0) {
    const bl = (-len) * 2;
    return { v: b.slice(o, o + bl - 2).toString('utf16le'), n: o + bl };
  }
  return { v: b.slice(o, o + len - 1).toString('utf8'), n: o + len };
}

function parse(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const sz = Math.min(4 * 1024 * 1024, fs.fstatSync(fd).size);
  const b  = Buffer.alloc(sz);
  fs.readSync(fd, b, 0, sz, 0);
  fs.closeSync(fd);

  if (ru32(b, 0) !== FN_MAGIC) throw new Error('Not a Fortnite replay');

  const fileVersion = ru32(b, 4);
  const durationMs  = ru32(b, 8);
  const { v: friendlyName, n: o1 } = rstr(b, 12);

  // Timestamp (Windows FILETIME, 8 bytes)
  let date = null;
  if (o1 + 8 <= b.length) {
    const lo = b.readUInt32LE(o1);
    const hi = b.readUInt32LE(o1 + 4);
    const ft = hi * 0x100000000 + lo;
    date = new Date(ft / 10000 - 11644473600000).toISOString();
  }

  // Text scan for stats in event chunks
  const raw  = b.slice(o1 + 8).toString('latin1');
  const num  = (pat) => { const m = raw.match(new RegExp(pat + '[^\\d]*(\\d+)', 'i')); return m ? parseInt(m[1], 10) : 0; };

  return {
    game:         'fortnite',
    replayFile:   path.basename(filePath),
    date,
    durationMs,
    friendlyName,
    kills:        num('(?:TotalKills|KillCount|Eliminations)'),
    assists:      num('(?:AssistCount|Assists)'),
    placement:    num('(?:FinishingPlacement|Placement|Place)') || null,
    damageDealt:  num('(?:DamageDealt|DamageDone)'),
    damageTaken:  num('(?:DamageTaken|DamageReceived)'),
    headshotKills:num('(?:HeadshotKills|Headshots)'),
    gameMode:     /squad/i.test(raw) ? 'Squad' : /duo/i.test(raw) ? 'Duos' : 'Solo'
  };
}

module.exports = { parse };
