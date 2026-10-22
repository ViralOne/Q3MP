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

// Settings every preset writes unless it says otherwise, so switching away
// from a mode never leaves its physics (or a mutator) behind.
const BASE_CVARS = { g_gravityOverride: 0, g_selfDamage: 1, g_vampire: 0, g_grapple: 0, g_quadAll: 0 };

// Mutators (admin panel): extra rules stacked on top of whatever mode runs.
// Each is a set of fork qagame cvars; the admin's choice is saved and laid
// over every preset, and put back if the server restarts.
export const MUTATORS = [
  { id: "lowgrav", name: "Low gravity", description: "gravity 400 — jumps twice as high",
    cvars: { g_gravityOverride: 400 } },
  { id: "freerj", name: "Free rocket jumps", description: "your own splash pushes you but does no damage",
    cvars: { g_selfDamage: 0 } },
  { id: "vampire", name: "Vampire", description: "half the damage you deal heals you (up to 200)",
    cvars: { g_vampire: 0.5 } },
  { id: "grapple", name: "Grappling hook", description: "everyone carries the hook (mouse wheel, or weapon 10)",
    cvars: { g_grapple: 1 } },
  { id: "quad", name: "Quad for all", description: "permanent quad damage for everyone",
    cvars: { g_quadAll: 1 } },
];

export const PRESETS = [
  {
    id: "ffa",
    name: "Free for all",
    description: "everyone for themselves · 20 frags / 15 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 20, timelimit: 15, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 0, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  {
    id: "tdm",
    name: "Team deathmatch",
    description: "red vs blue · 50 frags / 20 min · balanced teams",
    gametype: 3,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 50, timelimit: 20, capturelimit: 0, g_teamForceBalance: 1, g_weaponMode: 0, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  {
    id: "ctf",
    name: "Capture the flag",
    description: "8 captures / 20 min · balanced teams",
    gametype: 4,
    maps: (all) => all.filter(CTF),
    cvars: { fraglimit: 0, timelimit: 20, capturelimit: 8, g_teamForceBalance: 1, g_weaponMode: 0, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  {
    id: "duel",
    name: "Duel (1v1)",
    description: "tournament maps · 10 frags / 10 min · others spectate",
    gametype: 1,
    maps: (all) => all.filter(DUEL),
    cvars: { fraglimit: 10, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 0, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  // freeze tag (fork qagame, g_freeze): team deathmatch where kills freeze
  {
    id: "freeze",
    name: "Freeze tag",
    description: "red vs blue · kills freeze, teammates thaw · first to 7 rounds",
    gametype: 3,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 7, timelimit: 20, capturelimit: 0, g_teamForceBalance: 1, g_weaponMode: 0, g_freeze: 1, g_knockback: 1000, dmflags: 0 },
  },
  // weapon arenas (fork qagame, g_weaponMode): free for all, nothing on the map
  {
    id: "instagib",
    name: "Instagib",
    description: "railgun only · one hit kills · endless ammo · 30 frags / 10 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 30, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 1, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  {
    id: "rockets",
    name: "Rocket arena",
    description: "rocket launcher + gauntlet · endless rockets · 100 armor · 30 frags / 10 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 30, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 2, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
  // e+-style chaos (fork qagame g_weaponMode 3): every weapon, haste, double
  // knockback, no falling damage (dmflags 8 = DF_NO_FALLING), low gravity and
  // free rocket jumps
  {
    id: "excessive",
    name: "Excessive",
    description: "e+-style · every weapon · endless ammo · haste · fast rockets · double knockback · low gravity · free rocket jumps · 50 frags / 10 min",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    // gravity 600 (maps reset g_gravity, so via g_gravityOverride): jumps
    // ~33% higher; g_selfDamage 0: your own splash pushes but does no damage
    cvars: { fraglimit: 50, timelimit: 10, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 3, g_freeze: 0, g_knockback: 2000, dmflags: 8,
      g_gravityOverride: 600, g_selfDamage: 0 },
  },
  // gun game (fork qagame g_weaponMode 4): the score is the weapon level, so
  // the fraglimit is the number of levels (machinegun ... BFG, gauntlet)
  {
    id: "gungame",
    name: "Gun game",
    description: "every kill moves you to the next weapon · win with a gauntlet kill · gauntlet kills set the victim back",
    gametype: 0,
    maps: (all) => [...all.filter(CUSTOM_DM), ...all.filter(DM)],
    cvars: { fraglimit: 9, timelimit: 15, capturelimit: 0, g_teamForceBalance: 0, g_weaponMode: 4, g_freeze: 0, g_knockback: 1000, dmflags: 0 },
  },
];

// Chat aliases players can type after !mode (see chatvote.mjs); the id
// itself always works too.
const ALIASES = {
  ffa: ["dm", "deathmatch"],
  tdm: ["team", "teams", "teamdm"],
  ctf: ["flag", "flags", "capture"],
  duel: ["1v1", "tourney"],
  freeze: ["ft", "freezetag"],
  instagib: ["insta", "ig", "rail"],
  rockets: ["ra", "rocket", "rocketarena"],
  excessive: ["e+", "xs", "eplus", "chaos"],
  gungame: ["gg", "gun", "guns", "armsrace"],
};

export function presetByAlias(word) {
  const w = String(word || "").toLowerCase();
  return PRESETS.find((p) => p.id === w || (ALIASES[p.id] || []).includes(w)) || null;
}

export function presetAliases(id) {
  return ALIASES[id] || [];
}

// Which preset the server is running, from its serverinfo (works after a
// gateway restart, and when someone set the cvars by hand).
export function presetOfInfo(info) {
  const gt = Number(info.g_gametype ?? 0);
  const weapon = Number(info.g_weaponMode ?? 0);
  if (weapon === 1) return PRESETS.find((p) => p.id === "instagib");
  if (weapon === 2) return PRESETS.find((p) => p.id === "rockets");
  if (weapon === 3) return PRESETS.find((p) => p.id === "excessive");
  if (weapon === 4) return PRESETS.find((p) => p.id === "gungame");
  if (gt === 3 && Number(info.g_freeze ?? 0)) return PRESETS.find((p) => p.id === "freeze");
  return PRESETS.find((p) => p.gametype === gt && p.cvars.g_weaponMode === 0 && !p.cvars.g_freeze) || null;
}

// --- saved per-preset map lists and settings (PRESETS_FILE) --------------------

let saved = {};
let settings = {};
try {
  const file = JSON.parse(readFileSync(presetsFile, "utf8"));
  saved = file.maps ?? {};
  settings = file.settings ?? {};
} catch {
  saved = {};                                    // first start, or unreadable
  settings = {};
}

function writeFile() {
  mkdirSync(dirname(presetsFile), { recursive: true });
  const temp = `${presetsFile}.tmp`;
  writeFileSync(temp, JSON.stringify({ maps: saved, settings }, null, 2));
  renameSync(temp, presetsFile);
}

export function getSetting(key, fallback) {
  return key in settings ? settings[key] : fallback;
}

export function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  writeFile();
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
  saved = next;
  writeFile();
}

export const rotationMax = ROTATION_MAX;

// The console commands that apply `preset` given the available map names;
// throws when the server has no map for it.
export function presetCommands(preset, availableMaps) {
  const { maps } = presetMaps(preset, availableMaps);
  if (!maps.length) throw new Error(`no maps for ${preset.name} in the server paks`);
  // the server rate-limits rcon (burst 10, then 1/s), so the gametype and
  // limits go out as a few vstrs instead of one command each; a cvar holds
  // at most 255 characters, hence the chunks
  const settings = [`g_gametype ${preset.gametype}`,
    ...Object.entries(presetCvars(preset)).map(([cvar, value]) => `set ${cvar} ${value}`)];
  const commands = [];
  const chunks = [];
  for (const setting of settings) {
    const last = chunks[chunks.length - 1];
    if (last && (last + " ; " + setting).length <= 240) chunks[chunks.length - 1] = last + " ; " + setting;
    else chunks.push(setting);
  }
  chunks.forEach((chunk, i) => commands.push(`set q3preset${i + 1} "${chunk}"`, `vstr q3preset${i + 1}`));
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

// A preset's settings: shared defaults, the preset's own, then the mutators
// the admin turned on.
export function presetCvars(preset, mutatorIds = activeMutators()) {
  const out = { ...BASE_CVARS, ...preset.cvars };
  for (const m of MUTATORS) if (mutatorIds.includes(m.id)) Object.assign(out, m.cvars);
  return out;
}

export function activeMutators() {
  const ids = getSetting("mutators", []);
  return Array.isArray(ids) ? ids.filter((id) => MUTATORS.some((m) => m.id === id)) : [];
}

export function saveMutators(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  const unknown = list.filter((id) => !MUTATORS.some((m) => m.id === id));
  if (unknown.length) throw Object.assign(new Error(`unknown mutator: ${unknown.join(", ")}`), { status: 400 });
  setSetting("mutators", list);
  return list;
}

// The mutator cvars as the server should have them while `preset` runs
// (or with no known preset, over the plain defaults): a vstr and its call
// (rcon runs one command per packet). g_gravity is set too:
// g_gravityOverride alone waits for the next map.
export function mutatorCommands(preset) {
  const all = presetCvars(preset || { cvars: {} });
  const wanted = Object.fromEntries(Object.keys(BASE_CVARS).map((k) => [k, all[k]]));
  wanted.g_gravity = wanted.g_gravityOverride > 0 ? wanted.g_gravityOverride : 800;
  return [`set q3mutators "${Object.entries(wanted).map(([k, v]) => `set ${k} ${v}`).join(" ; ")}"`, "vstr q3mutators"];
}

// Mutators the server is running now, from its serverinfo.
export function mutatorsOfInfo(info) {
  return MUTATORS.filter((m) => Object.entries(m.cvars).every(([k, v]) => Number(info[k] ?? BASE_CVARS[k]) === v))
    .map((m) => m.id);
}

// Does the server's serverinfo match what the presets and mutators want?
export function mutatorsInSync(info) {
  const preset = presetOfInfo(info);
  const all = presetCvars(preset || { cvars: {} });
  return Object.keys(BASE_CVARS).every((k) => Number(info[k] ?? BASE_CVARS[k]) === Number(all[k]));
}

export function presetList(availableMaps) {
  return PRESETS.map((p) => {
    const { maps, custom } = presetMaps(p, availableMaps);
    return { id: p.id, name: p.name, description: p.description, gametype: p.gametype, maps, custom,
      aliases: presetAliases(p.id) };
  });
}
