// WebSocket-to-UDP gateway for hosting ioquake3 (WebAssembly client) games.
//
// The browser engine speaks the standard Quake 3 UDP protocol, but Emscripten's
// SOCKFS maps every UDP datagram to exactly one WebSocket binary frame, so the
// gateway is a 1:1 bridge: one WS connection per browser client, each backed by
// its own UDP socket so the game server sees every browser player as a distinct
// peer (unique ip:port).
//
// Env:
//   GATEWAY_HOST   bind address for the HTTP/WebSocket listener (default 0.0.0.0)
//   GATEWAY_PORT   bind port (default 8080)
//   TARGET_HOST    UDP host of the Quake dedicated server (default 127.0.0.1)
//   TARGET_PORT    UDP port of the Quake dedicated server (default 27960)
//   MAX_CONNECTIONS  concurrent browser clients allowed (default 64)
//   MAX_PACKET_BYTES  largest accepted datagram/WebSocket frame (default 1400)
//   MAX_BUFFERED_BYTES  server->client frame drops beyond this backpressure (default 1048576)
//   IDLE_TIMEOUT_MS  close connection keys idle for this long (default 120000)
//   RCON_PASSWORD   shared secret for the /admin/api endpoints (empty = admin API off)
//   GAME_DATA_DIR   served game dir: map list, levelshots, admin pk3 uploads (default /data/baseq3)
//   MAX_UPLOAD_MB   largest map pk3 the admin panel may upload (default 300)
//   STATS_LOG       games.log the /stats leaderboard is built from (see stats.mjs)
//   PRESETS_FILE    where admin-chosen game-mode map lists are saved (see presets.mjs)
//   BSPC_PATH       bot navigation compiler for maps without .aas (see aas.mjs)
//   Q3JS_MASTER_URL master registry serving GET /api/servers for the launcher
//                   server list relay (default https://master.q3js.com);
//                   also the heartbeat target used by master-heartbeat.mjs

import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { timingSafeEqual } from "node:crypto";
import { inflateRawSync, deflateSync, crc32 } from "node:zlib";
import { readdirSync, openSync, readSync, fstatSync, closeSync, statSync, accessSync, constants as fsConstants, createWriteStream, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WebSocketServer } from "ws";

import { startMasterHeartbeat } from "./master-heartbeat.mjs";
import { startStats, statsSnapshot, onLogLine } from "./stats.mjs";
import { startChatVote } from "./chatvote.mjs";
import { PRESETS, presetCommands, presetList, savePresetMaps, rotationMax, presetOfInfo, presetAliases } from "./presets.mjs";
import { hasBspc, queueAas, aasJobs, aasPakName } from "./aas.mjs";

const env = (name, fallback) => process.env[name] || fallback;
const num = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

const options = {
  gatewayHost: env("GATEWAY_HOST", "0.0.0.0"),
  gatewayPort: num("GATEWAY_PORT", 8080),
  targetHost: env("TARGET_HOST", "127.0.0.1"),
  targetPort: num("TARGET_PORT", 27960),
  // Live server list relayed to the launcher (GET /servers); same registry
  // the master heartbeat registers this server with.
  masterListUrl: env("Q3JS_MASTER_URL", "https://master.q3js.com").replace(/\/+$/, ""),
  maxConnections: num("MAX_CONNECTIONS", 64),
  maxPacketBytes: num("MAX_PACKET_BYTES", 1400),
  maxBufferedBytes: num("MAX_BUFFERED_BYTES", 1_048_576),
  idleTimeoutMs: num("IDLE_TIMEOUT_MS", 120_000),
  rconPassword: env("RCON_PASSWORD", ""),
  mapsDir: env("GAME_DATA_DIR", "/data/baseq3"),
  // largest map pk3 the admin panel may upload
  maxUploadBytes: num("MAX_UPLOAD_MB", 300) * 1024 * 1024,
};

// Q3 servers drop a client fully only after SV_TIMEOUT (default 20s). Sending a
// final out-of-band "disconnect" packet makes the removal instant when a
// browser tab closes or the WebSocket dies.
const DISCONNECT_PACKET = Buffer.from("\xff\xff\xff\xffdisconnect\n", "latin1");

const refused = (socket, status, text) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
};

// --- out-of-band UDP queries to the game server -------------------------------

// Send one datagram, collect every reply for `waitMs`, then close the socket.
function udpQuery(payload, waitMs) {
  return new Promise((resolve) => {
    const udp = createSocket("udp4");
    const replies = [];
    let pending = true;

    const finish = () => {
      if (!pending) return;
      pending = false;
      clearTimeout(timer);
      try { udp.close(); } catch { /* already closed */ }
      resolve(replies);
    };

    const timer = setTimeout(finish, waitMs);
    timer.unref?.();

    udp.on("message", (message) => replies.push(message.toString("latin1")));
    udp.on("error", finish);

    udp.send(payload, options.targetPort, options.targetHost, () => {
      // keep listening until the timeout collects every response fragment
    });
  });
}

const OOB = (payload) => Buffer.from("\xff\xff\xff\xff" + payload + "\n", "latin1");

// "<key>\value\<key>\value..." into an object (Quake infostring).
function parseInfostring(line) {
  const info = {};
  const parts = line.split("\\");
  for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
  return info;
}

// One "statusResponse" blob (possibly split across datagrams) into
// { info: {...}, players: [{score, ping, name}] }.
function parseStatus(blobs) {
  const text = blobs.join("");
  const start = text.indexOf("statusResponse");
  if (start === -1) return null;
  const lines = text.slice(start).split("\n");
  const status = { info: parseInfostring(lines[1] ?? ""), players: [] };
  for (const line of lines.slice(2)) {
    const m = /^(-?\d+)\s+(\d+)\s+"(.*)"$/.exec(line.trim());
    if (m) status.players.push({ score: +m[1], ping: +m[2], name: m[3] });
  }
  return status;
}

// The server rate-limits out-of-band queries per address (burst 10, then
// 1/s, shared with rcon), so pages polling /maps or the admin status share
// one answer for a couple of seconds.
let statusCache = { at: 0, promise: null };
function serverStatus() {
  if (statusCache.promise && Date.now() - statusCache.at < 2000) return statusCache.promise;
  statusCache = { at: Date.now(), promise: udpQuery(OOB("getstatus"), 700).then(parseStatus) };
  return statusCache.promise;
}

// rcon: the Q3 server answers print packets on the same socket.
async function rconCommand(command) {
  const payload = Buffer.from(
    "\xff\xff\xff\xffrcon " + options.rconPassword + " " + command + "\n",
    "latin1",
  );
  const replies = await udpQuery(payload, 900);
  const text = replies
    .filter((r) => r.startsWith("\xff\xff\xff\xffprint"))
    .map((r) => r.split("\n").slice(1).join("\n"))
    .join("");
  return { command, output: text || "(no response)" };
}

// Several rcon commands in a row. The server answers every accepted rcon
// with a print packet but silently drops requests over its per-address rate
// limit (burst 10, then 1/s), so a command without a reply is retried after
// the bucket has leaked a slot.
async function rconBatch(commands) {
  const outputs = [];
  for (let i = 0; i < commands.length; i++) {
    const last = i === commands.length - 1;
    const payload = Buffer.from(
      "\xff\xff\xff\xffrcon " + options.rconPassword + " " + commands[i] + "\n",
      "latin1",
    );
    let prints = [];
    for (let attempt = 0; attempt < 4 && !prints.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1100));
      const replies = await udpQuery(payload, last ? 1500 : 300);
      prints = replies.filter((r) => r.startsWith("\xff\xff\xff\xffprint"));
    }
    if (!prints.length) throw new Error(`no reply to "${commands[i]}" (rate limit or server down)`);
    outputs.push(prints.map((r) => r.split("\n").slice(1).join("\n")).join(""));
  }
  return outputs;
}

let activePreset = null;

// Apply a game-mode preset (admin panel and chat vote): settings, rotation,
// first map. Errors carry an HTTP status for the admin API.
async function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw Object.assign(new Error(`unknown preset ${id}`), { status: 404 });
  let plan;
  try {
    plan = presetCommands(preset, listAvailableMaps().maps);
  } catch (error) {
    throw Object.assign(error, { status: 409 });
  }
  // One `exec` of a config file is instant; ~20 separate rcon commands take
  // ~15 s under the server's rcon rate limit. The file goes into the server's
  // homepath game dir (next to games.log) when the gateway can write there.
  let commands = plan.commands;
  const presetCfg = process.env.STATS_LOG ? join(dirname(process.env.STATS_LOG), "q3preset.cfg") : "";
  if (presetCfg) {
    try {
      writeFileSync(presetCfg, plan.commands.join("\n") + "\n");
      commands = ["exec q3preset.cfg"];
    } catch {
      // read-only state (three-container stack): send the commands one by one
    }
  }
  let outputs;
  try {
    outputs = await rconBatch(commands);
  } catch (error) {
    throw Object.assign(error, { status: 502 });
  }
  activePreset = { id: preset.id, name: preset.name, at: Date.now() };
  return { preset: activePreset, maps: plan.maps, commands: plan.commands,
    output: outputs[outputs.length - 1] || "(no response)" };
}

let chatVote = null;

function authorized(body) {
  if (!options.rconPassword) return false;
  const given = Buffer.from(String(body?.password ?? ""));
  const known = Buffer.from(options.rconPassword);
  return given.length === known.length && timingSafeEqual(given, known);
}

// --- map list: scan installed pk3s for maps/*.bsp ------------------------------
//
// pk3 files are zip archives; every map name lives in the zip central
// directory, so we never decompress anything — we just read the directory
// records at the end of each file (cheap even for the 450 MB pak0).

let mapsCache = { at: 0, maps: [], shots: new Map(), bsps: new Map(), aas: new Set(), warning: "", };

// Every maps/<name>.bsp, plus the levelshots/<name>.jpg|tga screenshot for
// the gallery. pk3s are scanned in name order and later ones win, the same
// precedence the engine uses; names are matched case-insensitively.
function listAvailableMaps() {
  if (Date.now() - mapsCache.at < 60_000) return mapsCache;
  const maps = new Set();
  const shots = new Map();
  const bsps = new Map();       // map -> {path, entry} of its .bsp (bot navigation source)
  const aas = new Set();        // maps that have bot navigation
  let warning = "";
  try {
    const files = readdirSync(options.mapsDir)
      .filter((f) => f.endsWith(".pk3"))
      .sort();
    if (!files.length) warning = `no pk3 files found in ${options.mapsDir}`;
    for (const file of files) {
      try {
        const path = `${options.mapsDir}/${file}`;
        for (const entry of zipEntries(path)) {
          const name = entry.name.toLowerCase();
          if (name.endsWith(".bsp") && name.startsWith("maps/")) {
            const map = name.slice("maps/".length, -".bsp".length);
            maps.add(map);
            bsps.set(map, { path, entry });
          }
          if (name.endsWith(".aas") && name.startsWith("maps/")) {
            aas.add(name.slice("maps/".length, -".aas".length));
          }
          const shot = /^levelshots\/([^/]+)\.(jpg|tga)$/.exec(name);
          if (shot) shots.set(shot[1], { path, entry, type: shot[2] });
        }
      } catch (e) {
        warning = `${file}: ${String(e && e.message || e)}`;
      }
    }
  } catch (e) {
    warning = `cannot list ${options.mapsDir}: ${String(e && e.message || e)}`;
  }
  mapsCache = { at: Date.now(), maps: [...maps].sort(), shots, bsps, aas, warning };
  return mapsCache;
}

// One file out of a pk3 (stored or deflated), capped so a bogus header cannot
// make the gateway allocate unbounded memory.
function readZipEntry(path, entry, maxBytes = 4 << 20) {
  if (entry.compSize > maxBytes || entry.size > maxBytes) throw new Error("entry too large");
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(30);
    readSync(fd, header, 0, 30, entry.lho);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
    const start = entry.lho + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = Buffer.alloc(entry.compSize);
    readSync(fd, data, 0, data.length, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
    throw new Error(`unsupported zip method ${entry.method}`);
  } finally {
    closeSync(fd);
  }
}

// Browsers cannot show TGA; re-encode raw/RLE 24/32-bit TGA pixels as a PNG
// (deflated RGB, a fraction of the size of the raw pixels).
function tgaToPng(tga) {
  const type = tga[2];
  const w = tga.readUInt16LE(12), h = tga.readUInt16LE(14);
  const depth = tga[16], topDown = (tga[17] & 0x20) !== 0;
  if ((type !== 2 && type !== 10) || (depth !== 24 && depth !== 32) || !w || !h || w > 2048 || h > 2048) {
    throw new Error("unsupported tga");
  }
  const pp = depth / 8;
  const cmapLen = tga[1] ? tga.readUInt16LE(5) * (tga[7] / 8) : 0;
  const src = tga.subarray(18 + tga[0] + cmapLen);
  let pixels = src;
  if (type === 10) {
    pixels = Buffer.alloc(w * h * pp);
    let o = 0, d = 0;
    while (o < src.length && d < pixels.length) {
      const packet = src[o++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        for (let k = 0; k < count && d + pp <= pixels.length; k++, d += pp) src.copy(pixels, d, o, o + pp);
        o += pp;
      } else {
        src.copy(pixels, d, o, o + count * pp);
        o += count * pp; d += count * pp;
      }
    }
  }
  // PNG rows are top-down RGB, each prefixed with filter byte 0 (none)
  const row = 1 + w * 3;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    const srcRow = topDown ? y : h - 1 - y;          // tga row 0 = bottom
    for (let x = 0; x < w; x++) {
      const i = (srcRow * w + x) * pp;
      const o = y * row + 1 + x * 3;
      raw[o] = pixels[i + 2] ?? 0; raw[o + 1] = pixels[i + 1] ?? 0; raw[o + 2] = pixels[i] ?? 0;
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                          // 8-bit truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Converted levelshots, keyed by pk3 path + size + mtime + entry offset so a
// replaced pk3 is picked up; bounded (gallery thumbnails are ~50-150 KB).
const shotCache = new Map();
const SHOT_CACHE_MAX = 256;

function levelshot(shot) {
  const st = statSync(shot.path);
  const key = `${shot.path}:${st.size}:${st.mtimeMs}:${shot.entry.lho}`;
  let hit = shotCache.get(key);
  if (!hit) {
    let body = readZipEntry(shot.path, shot.entry);
    let type = "image/jpeg";
    if (shot.type === "tga") { body = tgaToPng(body); type = "image/png"; }
    hit = { body, type, etag: `"${crc32(body).toString(16)}-${body.length.toString(16)}"` };
    if (shotCache.size >= SHOT_CACHE_MAX) shotCache.delete(shotCache.keys().next().value);
    shotCache.set(key, hit);
  }
  return hit;
}

// Read one zip archive's central directory: name, method, sizes and local
// header offset of every entry.
function zipEntries(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // longest possible end-of-central-directory record + one CD header
    const tail = Buffer.alloc(Math.min(size, 22 + 0xffff + 128));
    readSync(fd, tail, 0, tail.length, size - tail.length);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("not a zip archive");

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(Math.min(cdSize, size));
    if (cdOffset > size) throw new Error("zip directory out of range");
    readSync(fd, cd, 0, cd.length, cdOffset);

    const entries = [];
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      entries.push({
        name: cd.toString("latin1", off + 46, off + 46 + nameLen),
        method: cd.readUInt16LE(off + 10),
        compSize: cd.readUInt32LE(off + 20),
        size: cd.readUInt32LE(off + 24),
        lho: cd.readUInt32LE(off + 42),
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

// --- custom map pk3s (admin upload / delete) -------------------------------------
//
// Only map content: retail paks (pak*.pk3) and this stack's own zz-*.pk3 can
// never be replaced or removed, and a pk3 carrying game code (vm/, qvm, native
// libraries) is refused — maps must not be able to swap the server's or the
// browsers' game modules.

const CUSTOM_PAK = /^(?!pak\d|zz-)[a-z0-9][\w.-]{0,63}\.pk3$/i;

function dataWritable() {
  try { accessSync(options.mapsDir, fsConstants.W_OK); return true; } catch { return false; }
}

function listPaks() {
  return readdirSync(options.mapsDir)
    .filter((f) => /^[\w.-]+\.pk3$/i.test(f))
    .sort()
    .map((name) => {
      const path = `${options.mapsDir}/${name}`;
      let maps = [];
      try {
        maps = zipEntries(path)
          .map((e) => e.name.toLowerCase())
          .filter((n) => n.startsWith("maps/") && n.endsWith(".bsp"))
          .map((n) => n.slice(5, -4));
      } catch { /* unreadable pk3: listed without maps */ }
      return { name, size: statSync(path).size, custom: CUSTOM_PAK.test(name), maps };
    });
}

// Stream the request body into a temp file next to the target, enforcing the
// size cap, then validate it as a maps-only pk3 before it takes its name.
function receivePak(request, name) {
  return new Promise((resolve, reject) => {
    const target = `${options.mapsDir}/${name}`;
    const temp = `${options.mapsDir}/.upload-${process.pid}-${Date.now()}.tmp`;
    const out = createWriteStream(temp, { flags: "wx" });
    let bytes = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      request.unpipe(out);
      out.destroy();
      try { unlinkSync(temp); } catch { /* never written */ }
      reject(error);
    };
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > options.maxUploadBytes) {
        fail(Object.assign(new Error(`larger than ${options.maxUploadBytes >> 20} MB`), { status: 413 }));
        request.resume();
      }
    });
    request.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (failed) return;
      try {
        const names = zipEntries(temp).map((e) => e.name.toLowerCase());
        const maps = names.filter((n) => n.startsWith("maps/") && n.endsWith(".bsp"));
        if (!maps.length) throw Object.assign(new Error("no maps/*.bsp inside — not a map pk3"), { status: 400 });
        const code = names.find((n) => n.startsWith("vm/") || /\.(qvm|dll|so|dylib)$/.test(n));
        if (code) throw Object.assign(new Error(`contains game code (${code}) — maps only`), { status: 400 });
        renameSync(temp, target);
        resolve({ name, size: bytes, maps: maps.map((n) => n.slice(5, -4)) });
      } catch (error) {
        try { unlinkSync(temp); } catch { /* already gone */ }
        reject(error.status ? error : Object.assign(new Error(`not a valid pk3: ${error.message}`), { status: 400 }));
      }
    });
    request.pipe(out);
  });
}

// Queue bot navigation for `names` (default: every map without it) when the
// gateway can run bspc and write the data dir.
function queueMissingAas(names) {
  if (!hasBspc() || !dataWritable()) return [];
  const { bsps, aas } = listAvailableMaps();
  const wanted = (names ?? [...bsps.keys()]).filter((m) => bsps.has(m) && !aas.has(m));
  return queueAas(
    wanted.map((name) => {
      const { path, entry } = bsps.get(name);
      return { name, readBsp: () => readZipEntry(path, entry, 512 << 20) };
    }),
    options.mapsDir,
    () => { mapsCache.at = 0; },
  );
}

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (c) => {
      if (chunks.push(c) > 64) request.destroy();
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch { resolve({}); }
    });
    request.on("error", () => resolve({}));
  });

// --- admin API ----------------------------------------------------------------

const httpServer = createServer(async (request, response) => {
  await handleAdmin(request, response) ||
    respond(response, 404, { error: "not found" });
});

async function handleAdmin(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  // healthy = this gateway runs and the game server answers a status query
  if (url.pathname === "/healthz" && request.method === "GET") {
    const status = await serverStatus().catch(() => null);
    respond(response, status ? 200 : 503, {
      status: status ? "ok" : "game server not answering",
      game: Boolean(status),
      clients: socketServer.clients.size,
      target: `${options.targetHost}:${options.targetPort}`,
      admin: Boolean(options.rconPassword),
    });
    return true;
  }
  // Public list of the pk3s the launcher must download for this server: every
  // *.pk3 in the served game dir (retail paks, zz-cgame, any custom maps), so
  // dropping a map pk3 into quake3-data/<game>/ reaches browsers too. Names
  // only — the files themselves are already public under /assets/<game>/.
  if (url.pathname === "/paks" && request.method === "GET") {
    try {
      const files = readdirSync(options.mapsDir)
        .filter((f) => /^[\w.-]+\.pk3$/i.test(f))
        .sort();
      respond(response, 200, { game: basename(options.mapsDir), files });
    } catch (error) {
      respond(response, 500, { error: `cannot list paks: ${error && error.message || error}` });
    }
    return true;
  }
  // Public leaderboard / stats, rebuilt from the server's games.log
  if (url.pathname === "/stats" && request.method === "GET") {
    respond(response, 200, statsSnapshot());
    return true;
  }
  // Public list of the game modes players can vote in chat (start page help)
  if (url.pathname === "/modes" && request.method === "GET") {
    const status = await serverStatus().catch(() => null);
    const current = status ? presetOfInfo(status.info || {}) : null;
    respond(response, 200, {
      chatVote: chatVote ? chatVote.status().enabled : false,
      current: current ? current.id : null,
      modes: PRESETS.map((p) => {
        const word = p.id === "instagib" ? "insta" : p.id;
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          command: `!mode ${word}`,
          aliases: [p.id, ...presetAliases(p.id)].filter((a) => a !== word),
        };
      }),
    });
    return true;
  }
  // Public map gallery: every map in the server paks (with or without a
  // screenshot) and what is being played right now.
  if (url.pathname === "/maps" && request.method === "GET") {
    const { maps, shots } = listAvailableMaps();
    const aasHas = (name) => listAvailableMaps().aas.has(name);
    const status = await serverStatus().catch(() => null);
    const info = status?.info ?? {};
    respond(response, 200, {
      maps: maps.map((name) => ({ name, shot: shots.has(name), bots: aasHas(name) })),
      current: status ? {
        mapname: String(info.mapname ?? "").toLowerCase(),
        gametype: Number(info.g_gametype ?? 0),
        weaponMode: Number(info.g_weaponMode ?? 0),
        mode: (() => { const p = presetOfInfo(info); return p ? { id: p.id, name: p.name } : null; })(),
        chatVote: chatVote ? chatVote.status().enabled : false,
        players: status.players.length,
        maxclients: Number(info.sv_maxclients ?? 0),
        hostname: info.sv_hostname ?? "",
      } : null,
    });
    return true;
  }
  // GET /levelshot/<map>: the map's screenshot straight out of its pk3
  // (jpg as-is, tga converted to png), cached in memory with an ETag.
  const shotPath = /^\/levelshot\/([\w.-]{1,64})$/.exec(url.pathname);
  if (shotPath && request.method === "GET") {
    const shot = listAvailableMaps().shots.get(shotPath[1].toLowerCase());
    if (!shot) return respond(response, 404, { error: "no levelshot" }), true;
    try {
      const { body, type, etag } = levelshot(shot);
      const headers = { etag, "cache-control": "public, max-age=86400" };
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();
        return true;
      }
      response.writeHead(200, { ...headers, "content-type": type, "content-length": body.length });
      response.end(body);
    } catch (error) {
      respond(response, 500, { error: `levelshot: ${error && error.message || error}` });
    }
    return true;
  }
  // Public relay of the Q3JS master's community server list, used by the
  // launcher's server picker (the master itself does not send CORS headers).
  if (url.pathname === "/servers" && request.method === "GET") {
    try {
      const { data, age } = await masterServers();
      respond(response, 200, { servers: data, age });
    } catch (error) {
      respond(response, 502, {
        error: `master server list unavailable: ${error && error.message || error}`,
      });
    }
    return true;
  }
  if (!url.pathname.startsWith("/admin/api/")) return false;
  if (!options.rconPassword) {
    respond(response, 503, { error: "admin api disabled (no RCON_PASSWORD)" });
    return true;
  }
  try {
    if (url.pathname === "/admin/api/status" && request.method === "GET") {
      const status = await serverStatus();
      if (!status) return respond(response, 504, { error: "no response from game server" }), true;
      respond(response, 200, status);
      return true;
    }
    if (url.pathname === "/admin/api/auth" && request.method === "POST") {
      const body = await readBody(request);
      if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
      respond(response, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/admin/api/maps" && request.method === "GET") {
      const { maps, warning } = listAvailableMaps();
      respond(response, 200, { maps, warning });
      return true;
    }
    // custom map pk3s: list / upload (PUT raw bytes) / delete; the password
    // travels in a header because the upload body is the pk3 itself
    const pakPath = /^\/admin\/api\/paks(?:\/([^/]+))?$/.exec(url.pathname);
    if (pakPath) {
      if (!authorized({ password: request.headers["x-admin-password"] })) {
        request.resume();
        return respond(response, 403, { error: "bad password" }), true;
      }
      const name = pakPath[1] ? decodeURIComponent(pakPath[1]) : "";
      if (!name && request.method === "GET") {
        respond(response, 200, {
          files: listPaks(),
          writable: dataWritable(),
          maxUploadMb: options.maxUploadBytes >> 20,
        });
        return true;
      }
      if (!CUSTOM_PAK.test(name)) {
        request.resume();
        return respond(response, 400, { error: "name must be <name>.pk3 (letters, digits, . _ -), not pak*/zz-*" }), true;
      }
      if (!dataWritable()) {
        request.resume();
        return respond(response, 409, { error: `${options.mapsDir} is read-only for the gateway (mount it writable to manage maps)` }), true;
      }
      const target = `${options.mapsDir}/${name}`;
      let exists = false;
      try { statSync(target); exists = true; } catch { /* new file */ }
      if (request.method === "PUT") {
        if (exists) {
          request.resume();
          return respond(response, 409, { error: `${name} already exists — delete it first` }), true;
        }
        try {
          const saved = await receivePak(request, name);
          mapsCache.at = 0;
          // maps without bot navigation get it generated in the background
          const aasQueued = queueMissingAas(saved.maps);
          respond(response, 201, { ...saved, aasQueued, note: "restart the server to load it" });
        } catch (error) {
          respond(response, error.status || 500, { error: String(error.message || error) });
        }
        return true;
      }
      if (request.method === "DELETE") {
        if (!exists) return respond(response, 404, { error: `${name} not found` }), true;
        let removedMaps = [];
        try {
          removedMaps = zipEntries(target).map((e) => e.name.toLowerCase())
            .filter((n) => n.startsWith("maps/") && n.endsWith(".bsp")).map((n) => n.slice(5, -4));
        } catch { /* unreadable pk3: nothing to clean up */ }
        unlinkSync(target);
        mapsCache.at = 0;
        // generated bot navigation goes with its map (unless another pk3 still has it)
        const stillThere = listAvailableMaps().bsps;
        for (const map of removedMaps) {
          if (stillThere.has(map)) continue;
          try { unlinkSync(`${options.mapsDir}/${aasPakName(map)}`); } catch { /* none generated */ }
        }
        mapsCache.at = 0;
        respond(response, 200, { deleted: name, note: "restart the server to unload it" });
        return true;
      }
      return respond(response, 405, { error: "method not allowed" }), true;
    }
    if (url.pathname === "/admin/api/bots" && request.method === "GET") {
      const { bsps, aas } = listAvailableMaps();
      respond(response, 200, {
        bspc: hasBspc(),
        writable: dataWritable(),
        missing: [...bsps.keys()].filter((m) => !aas.has(m)).sort(),
        jobs: aasJobs(),
      });
      return true;
    }
    if (url.pathname === "/admin/api/bots/aas" && request.method === "POST") {
      const body = await readBody(request);
      if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
      if (!hasBspc()) return respond(response, 409, { error: "bspc is not available in this image (all-in-one image only)" }), true;
      if (!dataWritable()) return respond(response, 409, { error: `${options.mapsDir} is read-only for the gateway` }), true;
      const names = Array.isArray(body.maps) && body.maps.length ? body.maps.map(String) : undefined;
      respond(response, 202, { queued: queueMissingAas(names), jobs: aasJobs() });
      return true;
    }
    if (url.pathname === "/admin/api/presets" && request.method === "GET") {
      const { maps } = listAvailableMaps();
      respond(response, 200, {
        presets: presetList(maps),
        active: activePreset,
        available: [...maps].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        rotationMax,
      });
      return true;
    }
    // PUT {password, maps:[...]} replaces a preset's rotation; [] = defaults
    const presetEdit = /^\/admin\/api\/presets\/([\w-]{1,32})$/.exec(url.pathname);
    if (presetEdit && request.method === "PUT") {
      const body = await readBody(request);
      if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
      try {
        savePresetMaps(presetEdit[1], body.maps, listAvailableMaps().maps);
      } catch (error) {
        return respond(response, error.status || 500, { error: String(error.message || error) }), true;
      }
      respond(response, 200, { presets: presetList(listAvailableMaps().maps) });
      return true;
    }
    if (url.pathname === "/admin/api/preset" && request.method === "POST") {
      const body = await readBody(request);
      if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
      try {
        respond(response, 200, await applyPreset(String(body.id)));
      } catch (error) {
        respond(response, error.status || 500, { error: String(error.message || error) });
      }
      return true;
    }
    // chat mode voting (!modes / !mode / !yes / !no): status and on/off
    if (url.pathname === "/admin/api/chatvote") {
      if (!chatVote) return respond(response, 503, { error: "chat vote not running (stats log off)" }), true;
      if (request.method === "GET") {
        respond(response, 200, { ...chatVote.status(), modes: chatVote.aliases() });
        return true;
      }
      if (request.method === "PUT") {
        const body = await readBody(request);
        if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
        chatVote.setEnabled(Boolean(body.enabled));
        respond(response, 200, chatVote.status());
        return true;
      }
      return respond(response, 405, { error: "method not allowed" }), true;
    }
    if (url.pathname === "/admin/api/rcon" && request.method === "POST") {
      const body = await readBody(request);
      if (!authorized(body)) return respond(response, 403, { error: "bad password" }), true;
      const command = String(body.command ?? "").trim().slice(0, 512);
      if (!command) return respond(response, 400, { error: "empty command" }), true;
      respond(response, 200, await rconCommand(command));
      return true;
    }
  } catch (error) {
    respond(response, 500, { error: String(error && error.message || error) });
    return true;
  }
  respond(response, 404, { error: "unknown admin endpoint" });
  return true;
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

// GET /servers relay with a short cache so the launcher home page can render
// the picker from a single request while heartbeats keep the list live.
const Q3JS_LIST_CACHE_MS = 5000;
let masterList = { promise: null, data: null, at: 0, hasData: false };

async function masterServers() {
  const fresh = masterList.hasData && (Date.now() - masterList.at) < Q3JS_LIST_CACHE_MS;
  if (fresh) {
    return { data: masterList.data, age: Math.round((Date.now() - masterList.at) / 1000) };
  }
  if (!masterList.promise) {
    masterList.promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const url = new URL("/api/servers", options.masterListUrl);
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        masterList.data = await response.json();
        masterList.hasData = true;
        masterList.at = Date.now();
      } catch (error) {
        if (!masterList.hasData) throw error;
        console.error(`[servers] master list refresh failed, serving cached copy: ${error && error.message || error}`);
      } finally {
        clearTimeout(timeout);
        masterList.promise = null;
      }
    })();
  }
  await masterList.promise;
  return {
    data: masterList.data,
    age: masterList.hasData ? Math.round((Date.now() - masterList.at) / 1000) : null,
  };
}

const socketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: options.maxPacketBytes,
});

httpServer.on("upgrade", (request, socket, head) => {
  if (socketServer.clients.size >= options.maxConnections) {
    refused(socket, "503 Service Unavailable", "connection limit reached");
    return;
  }
  if (request.url !== "/" && request.url !== "/ws") {
    refused(socket, "404 Not Found", "unknown websocket path");
    return;
  }
  socketServer.handleUpgrade(request, socket, head, (ws) => {
    bindConnection(ws);
  });
});

function bindConnection(webSocket) {
  const udp = createSocket("udp4");

  let closed = false;
  let idleTimer = null;

  const refreshIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      webSocket.close(1000, "idle timeout");
    }, options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    webSocket.terminate();
    try {
      udp.close();
    } catch {
      // already closed
    }
  };

  // Browser -> game server: each WS binary frame is one UDP datagram.
  webSocket.on("message", (data, isBinary) => {
    if (!isBinary || closed) return;
    const message = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (message.byteLength > options.maxPacketBytes) {
      webSocket.close(1009, "packet too large");
      return;
    }
    refreshIdleTimer();
    udp.send(message, options.targetPort, options.targetHost);
  });

  // Game server -> browser. Drop frames instead of queueing when the browser
  // falls behind; the Quake netcode treats missing packets exactly like UDP
  // loss, which is infinitely more graceful than memory-creep buffering.
  udp.on("message", (message) => {
    refreshIdleTimer();
    if (webSocket.readyState === 1 && webSocket.bufferedAmount <= options.maxBufferedBytes) {
      try {
        webSocket.send(message, { binary: true });
      } catch {
        // closed underneath us; ignored
      }
    }
  });
  udp.on("error", () => close());
  udp.bind(() => refreshIdleTimer());

  // WebSocket died: tell the game server immediately, then let the UDP socket
  // linger a moment so the out-of-band packet can reach it.
  webSocket.on("close", () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    udp.send(DISCONNECT_PACKET, options.targetPort, options.targetHost, () =>
      udp.close(),
    );
  });
  webSocket.on("error", () => close());
}

httpServer.listen(options.gatewayPort, options.gatewayHost, () => {
  console.log(
    `[gateway] listening http://${options.gatewayHost}:${options.gatewayPort}` +
      ` -> udp://${options.targetHost}:${options.targetPort}`,
  );
  startMasterHeartbeat((line) => console.log(`[heartbeat] ${line}`));
  startStats((line) => console.log(`[stats] ${line}`));
  if (process.env.STATS_LOG !== "") {
    chatVote = startChatVote({
      rcon: (command) => rconCommand(command),
      applyPreset,
      serverInfo: () => serverStatus().then((s) => s && s.info),
      log: (line) => console.log(`[chatvote] ${line}`),
    });
    onLogLine(chatVote.onLine);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const ws of socketServer.clients) ws.terminate();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
