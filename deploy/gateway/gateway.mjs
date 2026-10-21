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

import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { timingSafeEqual } from "node:crypto";
import { readdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { WebSocketServer } from "ws";

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
  maxConnections: num("MAX_CONNECTIONS", 64),
  maxPacketBytes: num("MAX_PACKET_BYTES", 1400),
  maxBufferedBytes: num("MAX_BUFFERED_BYTES", 1_048_576),
  idleTimeoutMs: num("IDLE_TIMEOUT_MS", 120_000),
  rconPassword: env("RCON_PASSWORD", ""),
  mapsDir: env("GAME_DATA_DIR", "/data/baseq3"),
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

function serverStatus() {
  return udpQuery(OOB("getstatus"), 700).then(parseStatus);
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

function authorized(body) {
  if (!options.rconPassword) return false;
  const given = Buffer.from(String(body.password ?? ""));
  const known = Buffer.from(options.rconPassword);
  return given.length === known.length && timingSafeEqual(given, known);
}

// --- map list: scan installed pk3s for maps/*.bsp ------------------------------
//
// pk3 files are zip archives; every map name lives in the zip central
// directory, so we never decompress anything — we just read the directory
// records at the end of each file (cheap even for the 450 MB pak0).

let mapsCache = { at: 0, maps: [], warning: "", };

function listAvailableMaps() {
  if (Date.now() - mapsCache.at < 60_000) return mapsCache;
  const maps = new Set();
  let warning = "";
  try {
    const files = readdirSync(options.mapsDir)
      .filter((f) => f.endsWith(".pk3"))
      .sort();
    if (!files.length) warning = `no pk3 files found in ${options.mapsDir}`;
    for (const file of files) {
      try {
        for (const name of zipNames(`${options.mapsDir}/${file}`)) {
          if (name.endsWith(".bsp") && name.startsWith("maps/")) {
            maps.add(name.slice("maps/".length, -".bsp".length));
          }
        }
      } catch (e) {
        warning = `${file}: ${String(e && e.message || e)}`;
      }
    }
  } catch (e) {
    warning = `cannot list ${options.mapsDir}: ${String(e && e.message || e)}`;
  }
  mapsCache = { at: Date.now(), maps: [...maps].sort(), warning };
  return mapsCache;
}

// Read one zip archive's central directory and return every file name.
function zipNames(path) {
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

    const names = [];
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      names.push(cd.toString("latin1", off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
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
  if (url.pathname === "/healthz" && request.method === "GET") {
    respond(response, 200, {
      status: "ok",
      clients: socketServer.clients.size,
      target: `${options.targetHost}:${options.targetPort}`,
      admin: Boolean(options.rconPassword),
    });
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
    if (url.pathname === "/admin/api/maps" && request.method === "GET") {
      const { maps, warning } = listAvailableMaps();
      respond(response, 200, { maps, warning });
      return true;
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
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const ws of socketServer.clients) ws.terminate();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
