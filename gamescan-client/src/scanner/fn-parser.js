'use strict';

/**
 * Fortnite Replay Parser
 * -----------------------
 * Fortnite replay files (.replay) use Unreal Engine 4's DemoNetDriver format.
 *
 * File layout:
 *   - Magic: 0x1CA2E27F (4 bytes)
 *   - File version (4 bytes)
 *   - Length in ms (4 bytes)
 *   - FriendlyName string
 *   - Timestamp (8 bytes, Windows FILETIME)
 *   - Is Live (4 bytes bool)
 *   - Is Compressed (4 bytes bool)
 *   - Encryption key (variable)
 *   - Checkpoints / events chunks containing match data
 *
 * Key stats available in the header/events:
 *   - Placement (finishing position)
 *   - Total kills
 *   - Damage dealt / taken
 *   - Match duration
 *   - Game mode (solo/duo/squad)
 *
 * Reference: https://github.com/Apexiiiiii/fnbr-replay-parser
 */

const fs   = require('fs');
const path = require('path');

const FN_MAGIC = 0x1CA2E27F;

// ── Binary helpers ────────────────────────────────────────────────────────────

function readUInt32LE(buf, offset) { return buf.readUInt32LE(offset); }
function readInt32LE(buf, offset)  { return buf.readInt32LE(offset); }
function readUInt64LE(buf, offset) {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return hi * 0x100000000 + lo;
}

function readFString(buf, offset) {
  if (offset + 4 > buf.length) return { value: '', nextOffset: offset + 4 };
  const len = readInt32LE(buf, offset);
  offset += 4;
  if (len === 0) return { value: '', nextOffset: offset };
  if (len < 0) {
    const byteLen = (-len) * 2;
    if (offset + byteLen > buf.length) return { value: '', nextOffset: offset + byteLen };
    const value = buf.slice(offset, offset + byteLen - 2).toString('utf16le');
    return { value, nextOffset: offset + byteLen };
  }
  if (offset + len > buf.length) return { value: '', nextOffset: offset + len };
  const value = buf.slice(offset, offset + len - 1).toString('utf8');
  return { value, nextOffset: offset + len };
}

// ── Header parser ─────────────────────────────────────────────────────────────

function parseHeader(buf) {
  if (buf.length < 12) throw new Error('File too small');

  const magic = readUInt32LE(buf, 0);
  if (magic !== FN_MAGIC) throw new Error(`Not a Fortnite replay (magic 0x${magic.toString(16)})`);

  const fileVersion  = readUInt32LE(buf, 4);
  const lengthMs     = readUInt32LE(buf, 8);

  const { value: friendlyName, nextOffset: o1 } = readFString(buf, 12);

  // Timestamp: 8-byte Windows FILETIME at o1
  let timestamp = null;
  if (o1 + 8 <= buf.length) {
    const ft = readUInt64LE(buf, o1);
    // Convert Windows FILETIME (100-ns intervals since 1601-01-01) to Date
    const MS_EPOCH_DIFF = 11644473600000; // ms between 1601 and 1970
    timestamp = new Date(ft / 10000 - MS_EPOCH_DIFF).toISOString();
  }

  return {
    fileVersion,
    durationMs:   lengthMs,
    friendlyName,
    timestamp,
    eventsOffset: o1 + 8, // rough starting point for events
  };
}

// ── Event chunk scanner ───────────────────────────────────────────────────────

/**
 * Scans the events section for known stat keys.
 * Fortnite replays encode player stats in event chunks tagged with
 * "playerElimination", "AthenaMatchStats", or similar.
 * We do a best-effort text scan for JSON-like patterns.
 */
function scanForStats(buf, startOffset) {
  const stats = {
    kills:        0,
    assists:      0,
    placement:    null,
    damageDealt:  0,
    damageTaken:  0,
    headshotKills: 0,
    shotsFired:   0,
    accuracy:     null,
    gameMode:     'Unknown',
    teamSize:     1,
  };

  // Convert buffer to string for text scanning (only events area, max 2MB)
  const end = Math.min(buf.length, startOffset + 2 * 1024 * 1024);
  const raw = buf.slice(startOffset, end).toString('latin1');

  // Helper: find numeric value after a key
  const num = (pattern) => {
    const re = new RegExp(pattern + '[^\\d]*(\\d+)', 'i');
    const m = raw.match(re);
    return m ? parseInt(m[1], 10) : null;
  };

  // Try common stat patterns from Fortnite replay events
  stats.kills        = num('(?:TotalKills|KillCount|Eliminations)') ?? 0;
  stats.assists      = num('(?:AssistCount|Assists)')               ?? 0;
  stats.placement    = num('(?:FinishingPlacement|Placement|Place)');
  stats.damageDealt  = num('(?:DamageDealt|DamageDone)')            ?? 0;
  stats.damageTaken  = num('(?:DamageTaken|DamageReceived)')        ?? 0;
  stats.headshotKills = num('(?:HeadshotKills|Headshots)')          ?? 0;
  stats.shotsFired   = num('(?:ShotsFired|BulletsShot)')            ?? 0;
  stats.teamSize     = num('(?:TeamSize|PlayersPerTeam)')           ?? 1;

  // Game mode from string patterns
  if (/squad/i.test(raw))   stats.gameMode = 'Squad';
  else if (/duo/i.test(raw)) stats.gameMode = 'Duos';
  else                       stats.gameMode = 'Solo';

  if (stats.shotsFired > 0) {
    stats.accuracy = Math.round((stats.kills / stats.shotsFired) * 100 * 10) / 10;
  }

  return stats;
}

// ── Main export ───────────────────────────────────────────────────────────────

function parse(filePath) {
  let buf;
  try {
    const fd      = fs.openSync(filePath, 'r');
    const stat    = fs.fstatSync(fd);
    const readSize = Math.min(4 * 1024 * 1024, stat.size); // read up to 4 MB
    buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
  } catch (err) {
    throw new Error(`Cannot read file: ${err.message}`);
  }

  const header = parseHeader(buf);
  const stats  = scanForStats(buf, header.eventsOffset);

  return {
    game:         'fortnite',
    replayFile:   path.basename(filePath),
    date:         header.timestamp,
    durationMs:   header.durationMs,
    friendlyName: header.friendlyName,
    ...stats,
  };
}

module.exports = { parse };
