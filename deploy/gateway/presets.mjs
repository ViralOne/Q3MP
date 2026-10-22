// Game-mode presets for the admin panel: one click sets the gametype, its
// limits and a map rotation built from the maps the server paks actually
// contain, then loads the first map (g_gametype only applies on map load).
//
// Each preset is a list of server console commands; the rotation is the
// classic vstr chain: d1 = "map A ; set nextmap vstr d2", ... last -> d1.
// The admin panel can replace a preset's default map list; those choices are
// kept in PRESETS_FILE (JSON) so they survive restarts.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const presetsFile = process.env.PRESETS_FILE ?? "/state/gateway/presets.json";

// q3dm0 is the single-player intro map
const DM = (m) => /^(q3dm\d+|pro-q3dm\d+)$/.test(m) && m !== "q3dm0";
const CTF = (m) => /^q3ctf\d+$/.test(m) || m.endsWith("_ctf");
const DUEL = (m) => /^(pro-)?q3tourney\d+$/.test(m);
// custom maps that are not obviously CTF/duel are played as deathmatch maps
// (listed first by default, so a full rotation never crowds them out)
const CUSTOM_DM = (m) => !DM(m) && !CTF(m) && !DUEL(m) && !/^test_|^q3dm0$/.test(m);

const ROTATION_MAX = 16;

// q3dm2 before q3dm10
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export const PRESETS = [
  {
    id: "ffa",
    name: "Free for all",
    description: "everyone for themselves · 20 frags / 15 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 20, timelimit: 15, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 0 },
  },
  {
    id: "tdm",
    name: "Team deathmatch",
    description: "red vs blue · 50 frags / 20 min · balanced teams",
    gametype: 4,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 50, timelimit: 20, capturelimit: 0, g_teamForceBalance: 1, g_weaponMode: 0 },
  },
  {
    id: "ctf",
    name: "Capture the flag",
    description: "8 captures / 20 min · balanced teams",
    gametype: 3,
    maps: (all) => all.filter(CTF),
    cvars: { fraglimit: 0, timelimit: 20, capturelimit: 8, g_teamForceBalance: 1, g_weaponMode: 0 },
  },
  {
    id: "duel",
    name: "Duel (1v1)",
    description: "tournament maps · 10 frags / 10 min · others spectate",
    gametype: 1,
    maps: (all) => all.filter(DUEL),
    cvars: { fraglimit: 10, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 0 },
  },
  // weapon arenas (fork qagame, g_weaponMode): free for all, nothing on the map
  {
    id: "instagib",
    name: "Instagib",
    description: "railgun only · one hit kills · endless ammo · 30 frags / 10 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 30, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 1 },
  },
  {
    id: "rockets",
    name: "Rocket arena",
    description: "rocket launcher + gauntlet · endless rockets · 100 armor · 30 frags / 10 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 30, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 2 },
  },
];

// The console commands that apply `preset` given the available map names;
// throws when the server has no map for it.
// --- saved per-preset map lists ------------------------------------------------

let saved = {};
try {
  saved = JSON.parse(readFileSync(presetsFile, "utf8")).maps ?? {};
} catch {
  saved = {};                                    // first start, or unreadable
}

// The rotation a preset plays: the admin's saved list (minus maps that were
// removed from the paks since) or the preset's default selection.
export function presetMaps(preset, availableMaps) {
  const available = new Set(availableMaps);
  const custom = saved[preset.id];
  if (Array.isArray(custom) && custom.length) {
    const kept = custom.filter((m) => available.has(m));
    if (kept.length) return { maps: kept.slice(0, ROTATION_MAX), custom: true };
  }
  const defaults = [...new Set(preset.maps([...availableMaps].sort(natural)))];
  return { maps: defaults.slice(0, ROTATION_MAX), custom: false };
}

// Store (or with an empty list, forget) the admin's map list for a preset.
export function savePresetMaps(id, maps, availableMaps) {
  if (!PRESETS.some((p) => p.id === id)) throw Object.assign(new Error(`unknown preset ${id}`), { status: 404 });
  const available = new Set(availableMaps);
  const list = [...new Set((Array.isArray(maps) ? maps : []).map(String))];
  const unknown = list.filter((m) => !available.has(m));
  if (unknown.length) throw Object.assign(new Error(`not in the server paks: ${unknown.join(", ")}`), { status: 400 });
  if (list.length > ROTATION_MAX) throw Object.assign(new Error(`at most ${ROTATION_MAX} maps per rotation`), { status: 400 });
  const next = { ...saved };
  if (list.length) next[id] = list; else delete next[id];
  mkdirSync(dirname(presetsFile), { recursive: true });
  const temp = `${presetsFile}.tmp`;
  writeFileSync(temp, JSON.stringify({ maps: next }, null, 2));
  renameSync(temp, presetsFile);
  saved = next;
}

export const rotationMax = ROTATION_MAX;

export function presetCommands(preset, availableMaps) {
  const { maps } = presetMaps(preset, availableMaps);
  if (!maps.length) throw new Error(`no maps for ${preset.name} in the server paks`);
  // the server rate-limits rcon (burst 10, then 1/s), so the gametype and
  // limits go out as one vstr instead of one command each
  const settings = [`g_gametype ${preset.gametype}`,
    ...Object.entries(preset.cvars).map(([cvar, value]) => `set ${cvar} ${value}`)];
  const commands = [`set q3preset "${settings.join(" ; ")}"`, "vstr q3preset"];
  // the end-of-match map vote offers maps from this rotation (cvar max ~250)
  let pool = "";
  for (const map of maps) {
    if ((pool + " " + map).length > 240) break;
    pool = pool ? `${pool} ${map}` : map;
  }
  commands.push(`set g_mapvoteMaps "${pool}"`);
  maps.forEach((map, i) => {
    const next = i + 1 < maps.length ? i + 2 : 1;
    commands.push(`set d${i + 1} "map ${map} ; set nextmap vstr d${next}"`);
  });
  commands.push("vstr d1");
  return { commands, maps };
}

export function presetList(availableMaps) {
  return PRESETS.map((p) => {
    const { maps, custom } = presetMaps(p, availableMaps);
    return { id: p.id, name: p.name, description: p.description, gametype: p.gametype, maps, custom };
  });
}
