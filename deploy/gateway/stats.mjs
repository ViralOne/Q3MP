// Player statistics from the game server's own match log (games.log, g_log).
//
// qagame writes one line per event — "Kill: <killer> <victim> <mod>: A killed B
// by MOD_X", "ClientUserinfoChanged: <slot> n\Name\...", "InitGame:", "Exit:",
// "score: N ping: P client: <slot> Name" — so the whole history can be rebuilt
// from the file at any time: no database, and stats survive restarts because
// the log lives on the server's state volume. New lines are read from the last
// offset as soon as the file changes (fs.watch, with a slow poll as fallback);
// a shrunk/rotated file is parsed again from scratch.
//
// Admin clean-up (the admin panel) never touches games.log: removed players,
// merged names, removed matches and a reset point are kept in STATS_ADMIN_FILE
// and applied while the log is parsed, so every change can be undone.
//
// Env:
//   STATS_LOG          path to games.log (default /state/baseq3/games.log; empty = off)
//   STATS_ADMIN_FILE   clean-up choices (default stats-admin.json next to PRESETS_FILE)

import { openSync, readSync, fstatSync, closeSync, watch, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const logPath = process.env.STATS_LOG ?? "/state/baseq3/games.log";
const adminFile = process.env.STATS_ADMIN_FILE
  ?? join(dirname(process.env.PRESETS_FILE ?? "/state/gateway/presets.json"), "stats-admin.json");
// fallback only: changes are normally picked up right away through fs.watch,
// which the chat mode vote (chatvote.mjs) relies on to answer quickly
const POLL_MS = 3000;
const RECENT_MATCHES = 15;

const WEAPONS = {
  MOD_GAUNTLET: "Gauntlet",
  MOD_MACHINEGUN: "Machinegun",
  MOD_SHOTGUN: "Shotgun",
  MOD_GRENADE: "Grenade launcher",
  MOD_GRENADE_SPLASH: "Grenade launcher",
  MOD_ROCKET: "Rocket launcher",
  MOD_ROCKET_SPLASH: "Rocket launcher",
  MOD_PLASMA: "Plasma gun",
  MOD_PLASMA_SPLASH: "Plasma gun",
  MOD_RAILGUN: "Railgun",
  MOD_LIGHTNING: "Lightning gun",
  MOD_BFG: "BFG10K",
  MOD_BFG_SPLASH: "BFG10K",
  MOD_TELEFRAG: "Telefrag",
};

// ^1A^2n^3a -> Ana (Quake color codes), trimmed for use as a player key
const plain = (name) => String(name).replace(/\^[^^]/g, "").trim();
const keyOf = (name) => plain(name).toLowerCase();

// --- admin clean-up choices ------------------------------------------------------

// removed: player keys erased from the stats (with every kill they were in)
// merges: { fromKey: intoKey } — two names counted as one player
// removedMatches: InitGame byte offsets of matches dropped from the stats
// resetAt: { offset, ino, at } — only what the log gained after this point counts
let admin = { removed: [], merges: {}, removedMatches: [], resetAt: null };
try {
  admin = { ...admin, ...JSON.parse(readFileSync(adminFile, "utf8")) };
} catch {
  // first start, or no clean-up yet
}

function saveAdmin() {
  mkdirSync(dirname(adminFile), { recursive: true });
  const temp = `${adminFile}.tmp`;
  writeFileSync(temp, JSON.stringify(admin, null, 2));
  renameSync(temp, adminFile);
}

// a merged name's final player key (merges can chain: a -> b -> c)
function resolveKey(key) {
  const seen = new Set();
  while (admin.merges[key] && !seen.has(key)) {
    seen.add(key);
    key = admin.merges[key];
  }
  return key;
}

const isRemoved = (key) => admin.removed.includes(key);

// --- parsing --------------------------------------------------------------------

function emptyState() {
  return {
    players: new Map(),   // key (lowercased plain name) -> aggregate
    weapons: new Map(),   // weapon -> frags
    maps: new Map(),      // map -> matches started
    matches: [],          // finished matches, newest last
    match: null,          // the one in progress
    totalKills: 0,
  };
}

let state = emptyState();
let offset = 0;
let carry = "";
// false while catching up with what the log already held (not replayed to
// listeners); true once the reader has reached the end of the file
let primed = false;
const listeners = [];

// Other modules (the chat mode vote) get every new log line as it arrives;
// history read at start-up is not replayed to them.
export function onLogLine(fn) {
  listeners.push(fn);
}

// The aggregate for a name, or null for a removed (or empty) name.
function player(name) {
  const key = resolveKey(keyOf(name));
  if (!key || isRemoved(key)) return null;
  let p = state.players.get(key);
  if (!p) {
    p = { key, name: plain(name), display: name, kills: 0, deaths: 0, suicides: 0,
      matches: 0, wins: 0, bot: false, weapons: {}, victims: {}, lastSeen: null, names: new Set() };
    state.players.set(key, p);
  }
  p.names.add(plain(name));
  // a merge target keeps its own name; otherwise the latest spelling wins
  if (key === keyOf(name)) { p.name = plain(name); p.display = name; }
  return p;
}

function onLine(line, live, pos) {
  const m = /^\s*\d+:\d+\s+([A-Za-z]+):\s?(.*)$/.exec(line);
  if (!m) return;
  const [, event, rest] = m;
  const match = state.match;
  // a removed match counts for nothing
  if (match && match.skip && event !== "InitGame" && event !== "ShutdownGame") return;
  switch (event) {
    case "InitGame": {
      const info = {};
      const parts = rest.split("\\");
      for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
      const map = String(info.mapname || "?").toLowerCase();
      state.match = { id: pos, map, gametype: Number(info.g_gametype ?? 0), clients: {},
        seen: new Set(), kills: 0, startedAt: live ? Date.now() : null,
        skip: admin.removedMatches.includes(pos) };
      if (!state.match.skip) state.maps.set(map, (state.maps.get(map) || 0) + 1);
      break;
    }
    case "ClientUserinfoChanged": {
      if (!match) break;
      const slot = /^(\d+)\s+(.*)$/.exec(rest);
      if (!slot) break;
      const info = {};
      const parts = ("\\" + slot[2]).split("\\");
      for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
      if (!info.n) break;
      const p = player(info.n);
      match.clients[slot[1]] = p;              // null for a removed player
      if (!p) break;
      if (info.skill !== undefined) p.bot = true;
      if (!match.seen.has(p)) { match.seen.add(p); p.matches += 1; }
      if (live) p.lastSeen = Date.now();
      break;
    }
    case "Kill": {
      const k = /^(\d+)\s+(\d+)\s+\d+:.*\sby\s+(MOD_\w+)/.exec(rest);
      if (!k || !match) break;
      const [, killerSlot, victimSlot, mod] = k;
      const victim = match.clients[victimSlot];
      if (!victim) break;
      const killer = match.clients[killerSlot];
      // a kill by a removed player is erased along with them, and one between
      // two names merged into one player counts for nothing
      if (killerSlot !== "1022" && killerSlot !== victimSlot && (killer === null || killer === victim)) break;
      victim.deaths += 1;
      if (killerSlot === "1022" || !killer || killer === victim) {
        victim.suicides += 1;                      // world, falling, own rocket
        break;
      }
      killer.kills += 1;
      const weapon = WEAPONS[mod] || mod.replace(/^MOD_/, "").toLowerCase();
      killer.weapons[weapon] = (killer.weapons[weapon] || 0) + 1;
      killer.victims[victim.key] = (killer.victims[victim.key] || 0) + 1;
      state.weapons.set(weapon, (state.weapons.get(weapon) || 0) + 1);
      state.totalKills += 1;
      match.kills += 1;
      if (live) killer.lastSeen = Date.now();
      break;
    }
    case "Exit":
      if (match) match.exit = rest.trim();
      break;
    case "score": {
      // end-of-match scoreboard, written right after Exit
      const s = /^(-?\d+)\s+ping:\s+\d+\s+client:\s+(\d+)\s+(.*)$/.exec(rest);
      if (!s || !match) break;
      const p = match.clients[s[2]] === undefined ? player(s[3]) : match.clients[s[2]];
      if (!p) break;                               // removed player
      (match.scores ||= []).push({ key: p.key, name: p.name, score: Number(s[1]) });
      break;
    }
    case "ShutdownGame": {
      if (!match) break;
      if (!match.skip && match.exit && match.scores?.length) {
        match.scores.sort((a, b) => b.score - a.score);
        // a win is the top score in free-for-all and duel, with no tie
        const [top, second] = match.scores;
        if (match.gametype <= 1 && top.score > 0 && (!second || top.score > second.score)) {
          const p = state.players.get(top.key);
          if (p) p.wins += 1;
        }
        state.matches.push({
          id: match.id,
          map: match.map,
          gametype: match.gametype,
          exit: match.exit,
          kills: match.kills,
          scores: match.scores.slice(0, 5).map(({ name, score }) => ({ name, score })),
          endedAt: live ? Date.now() : null,
        });
        if (state.matches.length > RECENT_MATCHES) state.matches.shift();
      }
      state.match = null;
      break;
    }
    default:
      break;
  }
}

// Where parsing starts: 0, or the admin's reset point while it still belongs
// to this file (same inode, not truncated below it).
function startOffset(stat) {
  const r = admin.resetAt;
  return r && r.ino === stat.ino && stat.size >= r.offset ? r.offset : 0;
}

function statOf(path) {
  const fd = openSync(path, "r");
  try { return fstatSync(fd); } finally { closeSync(fd); }
}

function poll() {
  if (!logPath) return;
  let fd;
  try {
    fd = openSync(logPath, "r");
  } catch {
    primed = true;                                 // no log yet: all of it will be new
    return;
  }
  let size = 0;
  try {
    const stat = fstatSync(fd);
    size = stat.size;
    if (size < offset) {                           // rotated or truncated
      state = emptyState();
      offset = 0;
      carry = "";
    }
    if (offset === 0 && !carry) offset = startOffset(stat);
    if (size === offset) return;
    const live = primed;
    const chunk = Buffer.alloc(Math.min(size - offset, 8 << 20));
    readSync(fd, chunk, 0, chunk.length, offset);
    let pos = offset - carry.length;               // byte offset of the next line
    offset += chunk.length;
    const lines = (carry + chunk.toString("latin1")).split("\n");
    carry = lines.pop();
    for (const line of lines) {
      onLine(line, live, pos);
      pos += line.length + 1;                      // latin1: one byte per char
      if (live) for (const fn of listeners) {
        try { fn(line); } catch { /* a listener never breaks the stats */ }
      }
    }
  } finally {
    closeSync(fd);
    // history is read in 8 MB slices; lines are live only past its end
    if (!primed && offset >= size) primed = true;
  }
}

// Parse the whole log again (start-up, or after an admin change) without
// replaying it to listeners.
function rebuild() {
  state = emptyState();
  offset = 0;
  carry = "";
  primed = false;
  for (let guard = 0; !primed && guard < 10_000; guard++) {
    const before = offset;
    poll();
    if (offset === before) break;
  }
  primed = true;
}

export function startStats(log = console.log) {
  if (!logPath) {
    log("stats: disabled (STATS_LOG empty)");
    return;
  }
  rebuild();
  setInterval(poll, POLL_MS).unref?.();
  // watch the directory, not the file: games.log may not exist yet, and a
  // rotated log is a new file under the same name
  let queued = false;
  try {
    const name = basename(logPath);
    watch(dirname(logPath), { persistent: false }, (_event, file) => {
      if (file && file !== name) return;
      if (queued) return;
      queued = true;
      setImmediate(() => { queued = false; poll(); });
    }).on("error", (e) => log(`stats: watch stopped (${e.message}); polling every ${POLL_MS / 1000} s`));
    log(`stats: following ${logPath}`);
  } catch (e) {
    log(`stats: following ${logPath} (polling every ${POLL_MS / 1000} s: ${e.message})`);
  }
}

function topOf(counts, n) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function statsSnapshot() {
  poll();
  const players = [...state.players.values()]
    .filter((p) => p.kills || p.deaths || p.matches)
    .map((p) => {
      const [weapon] = topOf(p.weapons, 1);
      const [rival] = topOf(p.victims, 1);
      return {
        name: p.name,
        bot: p.bot,
        kills: p.kills,
        deaths: p.deaths,
        suicides: p.suicides,
        kd: p.deaths ? Math.round((p.kills / p.deaths) * 100) / 100 : p.kills,
        matches: p.matches,
        wins: p.wins,
        favoriteWeapon: weapon ? weapon[0] : null,
        favoriteVictim: rival ? { name: state.players.get(rival[0])?.name ?? rival[0], kills: rival[1] } : null,
        lastSeen: p.lastSeen,
      };
    })
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  return {
    enabled: Boolean(logPath),
    totalKills: state.totalKills,
    players,
    weapons: [...state.weapons.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, kills]) => ({ name, kills })),
    maps: [...state.maps.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, matches]) => ({ name, matches })),
    recentMatches: [...state.matches].reverse(),
    since: admin.resetAt ? admin.resetAt.at ?? null : null,
  };
}

// --- admin clean-up API (gateway /admin/api/stats) --------------------------------

export function statsAdmin() {
  poll();
  return {
    removed: [...admin.removed],
    merges: Object.entries(admin.merges).map(([from, into]) => ({ from, into })),
    removedMatches: [...admin.removedMatches],
    resetAt: admin.resetAt,
    // every player counted now, with the names merged into them
    players: [...state.players.values()].map((p) => ({ key: p.key, name: p.name, bot: p.bot,
      kills: p.kills, deaths: p.deaths, names: [...p.names] }))
      .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)),
    recentMatches: [...state.matches].reverse(),
  };
}

const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

// One clean-up change; the stats are then rebuilt from the log.
export function statsAdminChange(action, body = {}) {
  if (!logPath) fail("stats are off (STATS_LOG empty)");
  const key = (v) => keyOf(v ?? "") || fail("player name missing");
  switch (action) {
    case "remove": {
      const k = resolveKey(key(body.name));
      if (!admin.removed.includes(k)) admin.removed = [...admin.removed, k];
      break;
    }
    case "restore":
      admin.removed = admin.removed.filter((k) => k !== key(body.name));
      break;
    case "merge": {
      const from = key(body.from);
      const into = resolveKey(key(body.into));
      if (from === into) fail("cannot merge a player into itself");
      admin.merges = { ...admin.merges, [from]: into };
      break;
    }
    case "unmerge": {
      const { [key(body.from)]: _gone, ...rest } = admin.merges;
      admin.merges = rest;
      break;
    }
    case "removeMatch": {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 0) fail("match id missing");
      if (!admin.removedMatches.includes(id)) admin.removedMatches = [...admin.removedMatches, id];
      break;
    }
    case "restoreMatch":
      admin.removedMatches = admin.removedMatches.filter((id) => id !== Number(body.id));
      break;
    case "reset": {
      // everything up to now stops counting; the next match starts fresh
      let stat;
      try { stat = statOf(logPath); } catch { fail("no games.log yet"); }
      admin.resetAt = { offset: stat.size, ino: stat.ino, at: Date.now() };
      break;
    }
    case "undoReset":
      admin.resetAt = null;
      break;
    default:
      fail(`unknown action ${action}`);
  }
  saveAdmin();
  rebuild();
  return statsAdmin();
}
