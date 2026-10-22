// Player statistics from the game server's own match log (games.log, g_log).
//
// qagame writes one line per event — "Kill: <killer> <victim> <mod>: A killed B
// by MOD_X", "ClientUserinfoChanged: <slot> n\Name\...", "InitGame:", "Exit:",
// "score: N ping: P client: <slot> Name" — so the whole history can be rebuilt
// from the file at any time: no database, and stats survive restarts because
// the log lives on the server's state volume. The file is re-read from the last
// offset every few seconds; a shrunk/rotated file is parsed again from scratch.
//
// Env:
//   STATS_LOG   path to games.log (default /state/baseq3/games.log; empty = off)

import { openSync, readSync, fstatSync, closeSync } from "node:fs";

const logPath = process.env.STATS_LOG ?? "/state/baseq3/games.log";
// 1 s: the chat mode vote (chatvote.mjs) reacts to chat through this follower
const POLL_MS = 1000;
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
const listeners = [];

// Other modules (the chat mode vote) get every new log line as it arrives;
// history read at start-up is not replayed to them.
export function onLogLine(fn) {
  listeners.push(fn);
}

function player(name) {
  const key = plain(name).toLowerCase();
  if (!key) return null;
  let p = state.players.get(key);
  if (!p) {
    p = { name: plain(name), display: name, kills: 0, deaths: 0, suicides: 0,
      matches: 0, wins: 0, bot: false, weapons: {}, victims: {}, lastSeen: null };
    state.players.set(key, p);
  }
  p.display = name;
  return p;
}

function onLine(line, live) {
  const m = /^\s*\d+:\d+\s+([A-Za-z]+):\s?(.*)$/.exec(line);
  if (!m) return;
  const [, event, rest] = m;
  const match = state.match;
  switch (event) {
    case "InitGame": {
      const info = {};
      const parts = rest.split("\\");
      for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
      const map = String(info.mapname || "?").toLowerCase();
      state.match = { map, gametype: Number(info.g_gametype ?? 0), clients: {},
        seen: new Set(), kills: 0, startedAt: live ? Date.now() : null };
      state.maps.set(map, (state.maps.get(map) || 0) + 1);
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
      if (!p) break;
      if (info.skill !== undefined) p.bot = true;
      match.clients[slot[1]] = p;
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
      victim.deaths += 1;
      const killer = match.clients[killerSlot];
      if (killerSlot === "1022" || !killer || killer === victim) {
        victim.suicides += 1;                      // world, falling, own rocket
        break;
      }
      killer.kills += 1;
      const weapon = WEAPONS[mod] || mod.replace(/^MOD_/, "").toLowerCase();
      killer.weapons[weapon] = (killer.weapons[weapon] || 0) + 1;
      killer.victims[victim.name] = (killer.victims[victim.name] || 0) + 1;
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
      (match.scores ||= []).push({ name: plain(s[3]), score: Number(s[1]) });
      break;
    }
    case "ShutdownGame": {
      if (!match) break;
      if (match.exit && match.scores?.length) {
        match.scores.sort((a, b) => b.score - a.score);
        // a win is the top score in free-for-all and duel, with no tie
        const [top, second] = match.scores;
        if (match.gametype <= 1 && top.score > 0 && (!second || top.score > second.score)) {
          const p = state.players.get(top.name.toLowerCase());
          if (p) p.wins += 1;
        }
        state.matches.push({
          map: match.map,
          gametype: match.gametype,
          exit: match.exit,
          kills: match.kills,
          scores: match.scores.slice(0, 5),
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

function poll() {
  if (!logPath) return;
  let fd;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return;                                        // no log yet
  }
  try {
    const size = fstatSync(fd).size;
    const live = offset > 0;
    if (size < offset) {                           // rotated or truncated
      state = emptyState();
      offset = 0;
      carry = "";
    }
    if (size === offset) return;
    const chunk = Buffer.alloc(Math.min(size - offset, 8 << 20));
    readSync(fd, chunk, 0, chunk.length, offset);
    offset += chunk.length;
    const lines = (carry + chunk.toString("latin1")).split("\n");
    carry = lines.pop();
    for (const line of lines) {
      onLine(line, live);
      if (live) for (const fn of listeners) {
        try { fn(line); } catch { /* a listener never breaks the stats */ }
      }
    }
  } finally {
    closeSync(fd);
  }
}

export function startStats(log = console.log) {
  if (!logPath) {
    log("stats: disabled (STATS_LOG empty)");
    return;
  }
  poll();
  setInterval(poll, POLL_MS).unref?.();
  log(`stats: following ${logPath}`);
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
        favoriteVictim: rival ? { name: rival[0], kills: rival[1] } : null,
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
  };
}
