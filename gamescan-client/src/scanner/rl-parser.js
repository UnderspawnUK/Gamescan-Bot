'use strict';

/**
 * Rocket League Replay Parser
 * ----------------------------
 * RL replay files (.replay) are binary files using Unreal Engine serialization.
 * The file header contains a "Properties" section with match metadata and stats
 * encoded as a key-value list. Each entry: name (string), type (string), value.
 *
 * This parser reads the binary header to extract:
 *  - Match date, duration, map, team sizes
 *  - Per-player stats: score, goals, assists, saves, shots
 *  - Team scores
 *
 * Format reference: https://github.com/nickbabcock/boxcars
 */

const fs = require('fs');

// ── Binary read helpers ───────────────────────────────────────────────────────

function readUInt32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function readInt32LE(buf, offset) {
  return buf.readInt32LE(offset);
}

function readFloat32LE(buf, offset) {
  return buf.readFloatLE(offset);
}

// Read a UE4 "FString": int32 length, then that many bytes (negative = UTF-16)
function readString(buf, offset) {
  if (offset + 4 > buf.length) return { value: '', nextOffset: offset + 4 };
  const len = readInt32LE(buf, offset);
  offset += 4;

  if (len === 0) return { value: '', nextOffset: offset };

  if (len < 0) {
    // UTF-16 (little endian)
    const byteLen = (-len) * 2;
    if (offset + byteLen > buf.length) return { value: '', nextOffset: offset + byteLen };
    const value = buf.slice(offset, offset + byteLen - 2).toString('utf16le');
    return { value, nextOffset: offset + byteLen };
  }

  // ASCII / UTF-8
  if (offset + len > buf.length) return { value: '', nextOffset: offset + len };
  const raw = buf.slice(offset, offset + len - 1).toString('utf8');
  return { value: raw, nextOffset: offset + len };
}

// ── Property value readers ────────────────────────────────────────────────────

function readPropertyValue(buf, offset, typeName) {
  switch (typeName) {
    case 'IntProperty': {
      const value = readInt32LE(buf, offset + 8); // skip 8-byte "size" header
      return { value, nextOffset: offset + 12 };
    }
    case 'FloatProperty': {
      const value = readFloat32LE(buf, offset + 8);
      return { value, nextOffset: offset + 12 };
    }
    case 'BoolProperty': {
      // Bool is 1 byte after the 8-byte header
      const value = buf[offset + 8] === 1;
      return { value, nextOffset: offset + 9 };
    }
    case 'ByteProperty': {
      // Enum-style byte: enum name string + value string
      const { value: enumName, nextOffset: o1 } = readString(buf, offset + 8);
      if (enumName === 'None') {
        return { value: buf[o1], nextOffset: o1 + 1 };
      }
      const { value: enumVal, nextOffset: o2 } = readString(buf, o1);
      return { value: enumVal, nextOffset: o2 };
    }
    case 'StrProperty':
    case 'NameProperty': {
      const { value, nextOffset: o } = readString(buf, offset + 8);
      return { value, nextOffset: o };
    }
    case 'QWordProperty': {
      // 8-byte int after 8-byte header
      const lo = readUInt32LE(buf, offset + 8);
      const hi = readUInt32LE(buf, offset + 12);
      return { value: hi * 0x100000000 + lo, nextOffset: offset + 16 };
    }
    default: {
      // Unknown: skip using the 8-byte "size" field
      const size = readUInt32LE(buf, offset);
      return { value: null, nextOffset: offset + 8 + size };
    }
  }
}

// ── Main properties parser ────────────────────────────────────────────────────

function parseProperties(buf, startOffset) {
  const props = {};
  let offset = startOffset;
  const MAX_PROPS = 200;
  let count = 0;

  while (offset < buf.length - 8 && count < MAX_PROPS) {
    const { value: name, nextOffset: o1 } = readString(buf, offset);
    if (!name || name === 'None') break;
    offset = o1;

    const { value: typeName, nextOffset: o2 } = readString(buf, offset);
    offset = o2;

    try {
      const { value, nextOffset: o3 } = readPropertyValue(buf, offset, typeName);
      props[name] = { type: typeName, value };
      offset = o3;
    } catch {
      break;
    }

    count++;
  }

  return props;
}

// ── High-level parse ──────────────────────────────────────────────────────────

function parse(filePath) {
  let buf;
  try {
    // Only read the first 128 KB — properties are always in the header
    const fd   = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(131072, stat.size);
    buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
  } catch (err) {
    throw new Error(`Cannot read file: ${err.message}`);
  }

  // Magic number check: RL replays start with 0x46 0x01 0x00 0x00 (or similar)
  // They actually start with the CRC + version bytes, then properties.
  // Offset 16 is typically where the top-level properties start.
  const headerSize = readUInt32LE(buf, 0);
  const crc        = readUInt32LE(buf, 4);
  void crc;

  // Properties begin after an 8-byte header block
  const propsStart = 16;
  const props = parseProperties(buf, propsStart);

  // Extract key fields
  const p = (name) => props[name]?.value ?? null;

  const teamSize   = p('TeamSize') ?? 3;
  const team0Score = p('Team0Score') ?? 0;
  const team1Score = p('Team1Score') ?? 0;
  const date       = p('Date') || p('ReplayDate') || null;
  const mapName    = p('MapName') || p('Map') || 'Unknown';
  const playerName = p('PlayerName') || p('PrimaryPlayerTeam') || null;

  // Stats stored in the replay for the recorded player
  const score     = p('Score')   ?? p('PlayerStats.Score')    ?? 0;
  const goals     = p('Goals')   ?? p('PlayerStats.Goals')    ?? 0;
  const assists   = p('Assists') ?? p('PlayerStats.Assists')  ?? 0;
  const saves     = p('Saves')   ?? p('PlayerStats.Saves')    ?? 0;
  const shots     = p('Shots')   ?? p('PlayerStats.Shots')    ?? 0;
  const demos     = p('Demolitions') ?? 0;

  return {
    game:        'rocket_league',
    replayFile:  require('path').basename(filePath),
    date,
    mapName,
    playerName,
    teamSize,
    team0Score,
    team1Score,
    score,
    goals,
    assists,
    saves,
    shots,
    demolitions: demos,
    win: team0Score > team1Score ? true : team0Score < team1Score ? false : null,
    rawProps: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, v.value])
    ),
  };
}

module.exports = { parse };
