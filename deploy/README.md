# Quake III Arena — self-hosted web server

Browser-based Quake III multiplayer on your own domain, built from the GPL
ioquake3 engine (as vendored in `../game/engine`) compiled to WebAssembly, with
a WebSocket-to-UDP gateway and a native Linux `ioq3ded` server — no code from
proprietary components.

```
Browser (ioquake3 WASM)  ──ws(s)──▶  Caddy (TLS)  ──▶  Gateway (Node)  ──UDP──▶  ioq3ded
        ▲                                  │
        └────────── static site + PK3 assets (Caddy) ─────────┘
```

- Each browser connection gets its own UDP socket, so the game server sees
  every player as a normal, distinct Q3 client using the original protocol.
- Emscripten's socket layer sends exactly one WebSocket binary frame per UDP
  datagram (and treats every incoming frame as one datagram), which is what the
  gateway bridges 1:1.
- Optionally expose `27960/udp` so desktop ioquake3 players can join the same
  server as well.

## Licensing

- Engine (WebAssembly client, `ioq3ded`, QVMs): GPL v2 (ioquake3).
- Gateway, launcher page, Docker plumbing in this folder: GPL v2.
- **Quake III Arena game data is not included.** You must mount your legally
  obtained `pak0.pk3`..`pak8.pk3` (Point Release 1.32). The built-in demo data
  is *not* sufficient for a multiplayer server with the vanilla 1.32 VMs.

## Files

| File | Purpose |
| --- | --- |
| `public/` | Static site: launcher (`index.html`) + WASM engine (`ioquake3.js`, `ioquake3.wasm`) + `admin.html` |
| `gateway/Dockerfile`, `gateway/gateway.mjs` | WebSocket-to-UDP gateway + admin API |
| `server/Dockerfile`, `server/entrypoint.sh`, `server/defaults/server.cfg` | Linux ioq3ded build + startup |
| `docker-compose.yml` | q3ded + gateway + caddy |
| `Caddyfile` | TLS, static site, `/ws` proxy, `/assets` PK3 serving, `/admin/api` proxy |
| `test/` | Local smoke test scripts (WS client, UDP client) |

## Server setup (Linux VPS with Docker)

1. **Copy this folder** to the VPS (e.g. `rsync -a deploy/ host:/srv/q3/deploy/`).

2. **Game data.** The stack ships with **demo content** (id's free Quake 3
   demo pack) already wired:

   ```
   quake3-data/demoq3/  pak0.pk3 (demo), zz-webvm.pk3 (QVMs), community maps*
   ```

   * de_dust2 (`oxodm1`), de_aztec (`oxodm6`), PadCrash — freeware maps from
     ..::LvL (lvlworld.com), already in the rotation.

   The q3ded service defaults to `FS_BASEGAME: demoq3`. To switch to the full
   retail game: create `quake3-data/baseq3/` with your legally obtained
   `pak0.pk3`..`pak8.pk3` and change the environment to `FS_BASEGAME: "baseq3"`.

3. **DNS**: point an `A`/`AAAA` record of your domain at the VPS; open ports
   `80/tcp`, `443/tcp` (and optionally `27960/udp` for native players).
   Add the variable `DOMAIN` before starting:

   ```sh
   DOMAIN=quake.example.com docker compose up -d --build
   ```

   Caddy gets a Let's Encrypt certificate automatically. For local testing,
   omit `DOMAIN` to serve on `localhost` with an internal cert.

4. **Verify** after 2-3 minutes:

   ```sh
   curl -s https://quake.example.com/ioquake3.wasm | head -c 100 >/dev/null
   docker compose logs q3ded      # should show map loading, no errors
   ```

   Then open `https://quake.example.com/` and click through; the game connects
   via the gateway at `/ws` by default.

## Player-facing URLs

| URL | Description |
| --- | --- |
| `https://<host>/` | game with default name "Player" |
| `https://<host>/admin.html` | admin panel (status, map, gametype, kick, rcon console) |
| `https://<host>/?server=wss://<host>/ws&connect=<host>:27960&name=<name>` | explicit overrides |
| `https://<host>/?game=demoq3` | load the free demo pack |
| `wss://<host>/ws` | WebSocket gateway (engine sockets) |
| `https://<host>/assets/baseq3/pak0.pk3` | asset downloads |

## Game code (VMs)

The official point-release paks carry the game code: `pak7.pk3`/`pak8.pk3`
contain the id 1.32 QVMs (cgame/qagame/ui), so both the dedicated server and the
browser client run the vanilla VMs straight out of the paks. Set
`FS_BASEGAME: "baseq3"` and all nine paks are everything you need.

## Admin panel

`admin.html` talks to gateway endpoints under `/admin/api/`. The gateway
authenticates requests against `RCON_PASSWORD` (compose default `q3admin` —
**change it**, e.g. `RCON_PASSWORD=... docker compose up -d`) and injects it
into rcon datagrams; the game server validates the password again. An empty
`RCON_PASSWORD` disables the admin API entirely.

- **Unlock** validates the password once per browser tab; `/admin/api/auth`
  returns 403 with a clear hint when it does not match `RCON_PASSWORD`.
- **Flags** card toggles rule cvars through rcon (`set <cvar> 0|1`):
  `g_scoreKeep` (keep disconnected players' scores until the map changes),
  `g_friendlyFire`, `g_allowVote`, `g_doWarmup`, `g_teamForceBalance`,
  `g_forcerespawn`.
- **Maps** dropdown is built live from the installed paks
  (`/admin/api/maps` — the gateway reads only the zip central directory),
  grouped FFA / duel / CTF / pro, with a filter field.

For a public deployment, add basic auth for `/admin*` in the `Caddyfile`, since
anyone who knows the password could otherwise use the panel.

## Playing, voting, in-game helpers

- **Game menu**: `ESC` opens the engine's own menu (drawn in the canvas) —
  leave, team selection, and so on. `~` opens the engine console.
- **Voting**: with `g_allowVote 1` any player can call votes from the `~`
  console: `callvote map q3dm17`, `callvote nextmap`, `callvote g_gametype 3`,
  `callvote kick <player>`, `callvote clientkill…` (see `callvote` for the full
  list: map, map_restart, nextmap, g_gametype, kick, clientkick, g_doWarmup,
  timelimit, fraglimit). Everyone answers `/vote yes` / `/vote no`; the vote
  passes on a majority when the timer ends. Admins disable it with
  `set g_allowVote 0`.
- **Log overlay**: `F1` toggles the browser-side log (the engine console stays
  on `~` alone); a `logs` button sits bottom-right.
- **Fullscreen**: browsers can exit fullscreen/pointer-lock on ESC — the
  `fullscreen` button (bottom-right, hidden while the game owns the mouse)
  restores it in one click; it flips to `window` while fullscreen is active.
- **Score keep**: `g_scoreKeep 1` (default) preserves each player's score
  across disconnects until the map changes — reconnect and continue where you
  left off. Stashes are keyed by netname, max 32 per map.

## Client downloads (browser cache)

The launcher stores every PK3 in OPFS persistent storage: a pak is downloaded
once per *origin* and mounted from disk on later visits. Freshness is tracked
per file by ETag (`HEAD` probe), so a changed pak re-downloads automatically.
Use the "(clear)" link on the login panel to drop the cache.

For a total-content-blocked server (e.g. only-players known link), keep the URL
unguessable or add basic auth in the `Caddyfile`.

## Configuring the game server

Full server config (hostname, gametype, rotation, fraglimit…):

```sh
# in compose, environment:
Q3JS_SERVER_CONFIG: |
  seta sv_hostname "My Arena"
  seta sv_maxclients "16"
  seta g_gametype "3"          # 0=FFA 3=CTF 4=1v1 (see README.ioq3)
  seta sv_pure "0"             # required: clients load server-transferred QVM pk3
  seta fraglimit "25"
  seta timelimit "15"
  map q3dm17
```

Or edit `server/defaults/server.cfg` (the default is FFA with the classic
rotation) and rebuild with `docker compose up -d --build q3ded`.

## Rebuilding the WASM client

Only needed if you change engine code. On a Mac/WSL box with the emsdk:

```sh
cd q3js-web
source tools/emsdk/emsdk_env.sh
emcmake cmake -S game/engine -B game/build/client -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_CLIENT=ON -DBUILD_SERVER=OFF \
  -DBUILD_GAME_LIBRARIES=OFF -DBUILD_GAME_QVMS=OFF \
  -DBUILD_RENDERER_GL1=OFF -DBUILD_RENDERER_GL2=ON \
  -DUSE_RENDERER_DLOPEN=OFF -DUSE_OPENAL=OFF -DUSE_VOIP=OFF
cmake --build game/build/client --parallel
cp game/build/client/Release/ioquake3.{js,wasm} deploy/public/
```

## Smoke test (already verified on this Mac)

```sh
# 1) gateway bridging + ioq3ded answer (needs node + ws)
PATH=../tools/emsdk/node/24.19.0_64bit/bin:$PATH node test/smoke-client.mjs \
  ws://127.0.0.1:8091/ws          # gateway on 8091 -> UDP 27960
# expected: "ÿÿÿÿstatusResponse\..."

# 2) docker: both images build and the site routes work
docker compose up -d web gateway
curl -sk https://localhost/ioquake3.wasm -o /dev/null -w '%{http_code}\n'   # 200
```

## Troubleshooting

- **q3ded restarts with `no pak0`** — the retail paks are not mounted in
  `quake3-data/baseq3/`.
- **q3ded restarts with libcurl error** — rebuild the image after pulling the
  latest Dockerfile (`docker compose up -d --build q3ded`).
- **Gateway health** — `curl https://<host>/assets/../../healthz` (8080 hits the
  gateway through the web container on the internal network):
  `{"status":"ok", ...}`.
- **Client hangs at "fetching game data"** — check `/assets/baseq3/pak0.pk3`
  returns 200 in the browser; the launcher skips missing files but needs at
  least one PK3.
- **WASM client aborts with "cannot create socket"** — ensure `server=` points
  to the `/ws` path and that the container `gateway` is up; the engine also
  needs `net_enabled 1` (the launcher sets this).
