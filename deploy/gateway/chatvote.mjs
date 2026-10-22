// Game-mode voting from in-game chat.
//
//   !modes / !help      list the modes and their short names
//   !mode <name>        start a vote for a mode (ffa, tdm, ctf, duel, freeze,
//                       insta, rockets, excessive, or any alias in presets.mjs)
//   !yes / !no          answer the running vote
//
// Chat comes from the game server's own log (games.log, followed by
// stats.mjs); answers go back as server chat (`say`) and private messages
// (`tell`) over rcon. A passing vote applies the same preset — settings and
// rotation — as the admin panel. Bots do not vote; with a single human the
// mode changes right away.

import { PRESETS, presetByAlias, presetAliases, presetOfInfo, getSetting, setSetting } from "./presets.mjs";

const VOTE_MS = 20_000;
const COOLDOWN_MS = 60_000;
const SWITCH_DELAY_MS = 3_000;
const WELCOME_EVERY_MS = 30 * 60_000;

// ^1A^2n^3a -> Ana, lowercased: chat lines carry names, not slots
const plain = (name) => String(name).replace(/\^[^^]/g, "").trim();
const keyOf = (name) => plain(name).toLowerCase();

// rcon `say` / `tell` take the rest of the line; quotes would end it early
const clean = (text) => String(text).replace(/["\\;\n\r]/g, "").slice(0, 200);

export function startChatVote({ rcon, applyPreset, serverInfo, log = console.log }) {
  const clients = new Map();      // slot -> { name, bot }
  const welcomed = new Map();     // name key -> last welcome time
  let vote = null;                // { preset, caller, yes:Set, no:Set, timer }
  let cooldownUntil = 0;
  let pending = Promise.resolve();

  const enabled = () => getSetting("chatvote", true);
  // rcon calls go out one at a time (the server rate-limits them)
  const send = (command) => {
    pending = pending.then(() => rcon(command)).catch(() => {});
    return pending;
  };
  const say = (text) => send(`say "${clean(text)}"`);
  const tell = (slot, text) => send(`tell ${slot} "${clean(text)}"`);

  const humans = () => [...clients.values()].filter((c) => !c.bot);
  const modeList = () => PRESETS.map((p) => p.id === "instagib" ? "insta" : p.id).join(" | ");

  async function currentPreset() {
    try {
      const info = await serverInfo();
      return info ? presetOfInfo(info) : null;
    } catch {
      return null;
    }
  }

  async function help(slot) {
    const now = await currentPreset();
    const head = now ? `Now playing ${now.name.toUpperCase()}. ` : "";
    const body = enabled()
      ? `Vote a mode: !mode ${modeList()} - then !yes or !no`
      : "Mode voting is turned off on this server";
    if (slot === undefined) say(head + body);
    else tell(slot, head + body);
  }

  function finish(passed, reason) {
    const v = vote;
    if (!v) return;
    clearTimeout(v.timer);
    vote = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    if (!passed) {
      say(`Vote for ${v.preset.name.toUpperCase()} failed (${reason})`);
      log(`chat vote: ${v.preset.id} failed (${reason})`);
      return;
    }
    say(`${v.preset.name.toUpperCase()} wins (${reason}) - switching in ${SWITCH_DELAY_MS / 1000} s...`);
    log(`chat vote: ${v.preset.id} passed (${reason})`);
    setTimeout(() => {
      applyPreset(v.preset.id).catch((error) => {
        say(`Could not switch: ${error.message || error}`);
        log(`chat vote: applying ${v.preset.id} failed: ${error.message || error}`);
      });
    }, SWITCH_DELAY_MS);
  }

  // decide as soon as the outcome cannot change
  function check() {
    if (!vote) return;
    const voters = humans().length || 1;
    if (vote.yes.size > voters / 2) finish(true, `${vote.yes.size} yes`);
    else if (vote.no.size >= voters / 2 && vote.no.size >= vote.yes.size) finish(false, `${vote.no.size} no`);
  }

  async function startVote(name, word) {
    if (!enabled()) return say("Mode voting is turned off on this server");
    const preset = presetByAlias(word);
    if (!preset) return say(`Unknown mode "${word}". Modes: ${modeList()}`);
    if (vote) return say(`A vote for ${vote.preset.name.toUpperCase()} is running - type !yes or !no`);
    const wait = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (wait > 0) return say(`Next mode vote in ${wait} s`);
    const now = await currentPreset();
    if (now && now.id === preset.id) return say(`Already playing ${preset.name.toUpperCase()}`);

    vote = { preset, caller: name, yes: new Set([keyOf(name)]), no: new Set(), timer: null };
    log(`chat vote: ${plain(name)} called ${preset.id}`);
    if (humans().length <= 1) return finish(true, "only player");
    say(`${plain(name)} wants ${preset.name.toUpperCase()} (${preset.description}) - type !yes or !no (${VOTE_MS / 1000} s)`);
    vote.timer = setTimeout(() => {
      if (!vote) return;
      finish(vote.yes.size > vote.no.size, `${vote.yes.size} yes / ${vote.no.size} no`);
    }, VOTE_MS);
  }

  function answer(name, yes) {
    if (!vote) return;
    const key = keyOf(name);
    if (yes) { vote.yes.add(key); vote.no.delete(key); } else { vote.no.add(key); vote.yes.delete(key); }
    check();
  }

  function onChat(name, text) {
    const sender = [...clients.values()].find((c) => keyOf(c.name) === keyOf(name));
    if (sender && sender.bot) return;
    const t = text.trim().toLowerCase();
    if (t === "!modes" || t === "!mode" || t === "!help" || t === "!vote") return help();
    const m = /^!(?:mode|vote)\s+(\S+)/.exec(t);
    if (m) return startVote(name, m[1]);
    if (t === "!yes" || t === "!y") return answer(name, true);
    if (t === "!no" || t === "!n") return answer(name, false);
  }

  function onLine(line) {
    const m = /^\s*\d+:\d+\s+([A-Za-z]+):\s?(.*)$/.exec(line);
    if (!m) return;
    const [, event, rest] = m;
    if (event === "InitGame") {
      clients.clear();               // everyone reconnects and is logged again
      return;
    }
    if (event === "ClientUserinfoChanged") {
      const u = /^(\d+)\s+(.*)$/.exec(rest);
      if (!u) return;
      const parts = ("\\" + u[2]).split("\\");
      const info = {};
      for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
      if (info.n) clients.set(u[1], { name: info.n, bot: info.skill !== undefined });
      return;
    }
    if (event === "ClientDisconnect") {
      const c = clients.get(rest.trim());
      clients.delete(rest.trim());
      if (c && vote) {
        vote.yes.delete(keyOf(c.name));
        vote.no.delete(keyOf(c.name));
        check();
      }
      return;
    }
    if (event === "ClientBegin") {
      // a short hint for each human, at most every half hour
      const slot = rest.trim();
      const c = clients.get(slot);
      if (!c || c.bot || !enabled()) return;
      const key = keyOf(c.name);
      if (Date.now() - (welcomed.get(key) || 0) < WELCOME_EVERY_MS) return;
      welcomed.set(key, Date.now());
      currentPreset().then((now) => tell(slot,
        `Welcome ${plain(c.name)}! ${now ? `Now playing ${now.name.toUpperCase()}. ` : ""}Type !modes in chat (T) to vote another mode`));
      return;
    }
    if (event === "say" || event === "sayteam") {
      // "<name>: <text>" (names cannot be split reliably on ": ", so try each)
      let at = rest.indexOf(": ");
      while (at !== -1) {
        const name = rest.slice(0, at);
        const text = rest.slice(at + 2);
        if (text.startsWith("!") && (clients.size === 0 || [...clients.values()].some((c) => keyOf(c.name) === keyOf(name)))) {
          return onChat(name, text);
        }
        at = rest.indexOf(": ", at + 2);
      }
    }
  }

  return {
    onLine,
    status: () => ({
      enabled: enabled(),
      vote: vote ? { preset: vote.preset.id, name: vote.preset.name, caller: plain(vote.caller),
        yes: vote.yes.size, no: vote.no.size } : null,
      cooldown: Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)),
    }),
    setEnabled: (on) => {
      setSetting("chatvote", Boolean(on));
      if (!on && vote) finish(false, "voting turned off");
    },
    aliases: () => PRESETS.map((p) => ({ id: p.id, name: p.name, aliases: presetAliases(p.id) })),
  };
}
