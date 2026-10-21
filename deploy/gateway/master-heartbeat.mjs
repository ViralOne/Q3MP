// Community-listing heartbeat for the Q3JS master server (master.q3js.com).
//
// Same anonymous protocol the packaged q3js server uses (upstream
// game/server/src/master-heartbeat.ts): a periodic `PUT /api/servers/heartbeat`
// announces the public browser-facing endpoint. The master then verifies the
// server by opening a WebSocket to `ws(s)://targetHost:proxyPort/ws` (which is
// exactly where Caddy routes to this gateway), querying the Quake status
// through it, and wiring the server into q3js.com's live server list. Stop
// sending heartbeats and the listing is pruned after ~5 minutes.
//
// Disabled unless BOTH Q3JS_MASTER_URL and Q3JS_PUBLISH_HOST are set.
//
// Env:
//   Q3JS_MASTER_URL     master base URL, e.g. https://master.q3js.com
//   Q3JS_PUBLISH_HOST   public hostname players reach this stack on
//   Q3JS_PUBLISH_PORT   public ws port (default 443, via Caddy TLS)
//   Q3JS_TARGET_PORT    public UDP port for native players (default 27960)
//   Q3JS_SECURE         "true" when players reach the ws endpoint over wss
//   Q3JS_HEARTBEAT_INTERVAL_MS / Q3JS_HEARTBEAT_TIMEOUT_MS (defaults 5000/3000)

const env = (name, fallback) => process.env[name] || fallback;
const num = (name, fallback, min, max) => {
  const item = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(item) && item >= min && item <= max ? item : fallback;
};

// Hosts that can never be listed publicly; always reject these so an
// unattended deployment does not publish a useless entry.
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$)/;

const options = {
  masterBaseUrl: env("Q3JS_MASTER_URL", "").replace(/\/+$/, ""),
  publishHost: env("Q3JS_PUBLISH_HOST", ""),
  publishPort: num("Q3JS_PUBLISH_PORT", 443, 1, 65535),
  targetPort: num("Q3JS_TARGET_PORT", num("TARGET_PORT", 27960), 1, 65535),
  secure: env("Q3JS_SECURE", "true") !== "false",
  intervalMs: num("Q3JS_HEARTBEAT_INTERVAL_MS", 5000, 1000, 3600000),
  timeoutMs: num("Q3JS_HEARTBEAT_TIMEOUT_MS", 3000, 100, 60000),
};

export function startMasterHeartbeat(log = console) {
  if (!options.masterBaseUrl || !options.publishHost) {
    log(`master heartbeat: disabled (set Q3JS_MASTER_URL and Q3JS_PUBLISH_HOST to list on q3js.com)`);
    return;
  }
  if (PRIVATE_HOST.test(options.publishHost)) {
    log(`master heartbeat: refused to publish private host "${options.publishHost}"`);
    return;
  }

  const where = `${options.secure ? "wss" : "ws"}://${options.publishHost}:${options.publishPort}/ws`;

  let timer;
  let sending = false;

  const send = async () => {
    if (sending) {
      return;
    }
    sending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const url = new URL("/api/servers/heartbeat", options.masterBaseUrl);
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetHost: options.publishHost,
          proxyPort: options.publishPort,
          targetPort: options.targetPort,
          secure: options.secure,
        }),
        signal: controller.signal,
      });
      if (response.ok) {
        log(`master heartbeat: listed at ${options.masterBaseUrl} via ${where}`);
      } else {
        log(`master heartbeat: HTTP ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      log(`master heartbeat: ${error && error.name === "AbortError" ? `timed out after ${options.timeoutMs}ms` : (error && error.message) || error}`);
    } finally {
      clearTimeout(timeout);
      sending = false;
    }
  };

  timer = setInterval(() => void send(), options.intervalMs);
  timer.unref();
  void send();
}
