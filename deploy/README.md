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
| `server/Dockerfile`, `server/entrypoint.sh`, `server/defaults/*.cfg` | Linux ioq3ded build + startup (`baseq3.cfg` / `demoq3.cfg` defaults) |
| `docker-compose.yml` | q3ded + gateway + caddy |
| `Caddyfile` | TLS, static site, `/ws` proxy, `/assets` PK3 serving, `/admin/api` proxy |
| `quake3-data/<game>/` | Your game-data mount; shared read-only by server/gateway, writable for server-published pk3s |
| `test/` | Local smoke test scripts (WS client, UDP client) |

## Game data you must provide

**Nothing proprietary ships with this repo.** Put your legally obtained files
in `quake3-data/` (this directory is git-ignored):

```
quake3-data/
  baseq3/            <- retail point release 1.32
    pak0.pk3 .. pak8.pk3     (required: the 9 official paks)
  demoq3/            <- free demo pack, wired by default (no purchase needed)
    pak0.pk3, oxodm1.pk3, oxodm6.pk3, padcrash.pk3
```

Switch modes with the `FS_BASEGAME` environment variable in
`docker-compose.yml` (`"baseq3"` or `"demoq3"` — default `baseq3` when the
retail paks are present).

Two small pk3s are **built by the server image and copied in automatically on
every container start** — do not add or delete them by hand:

| pk3 | Where it ends up | What it carries |
| --- | --- | --- |
| `zz-scorekeep.pk3` | server only (`/game/baseq3/`) | fork `qagame.qvm` (score keep via `g_scoreKeep`) |
| `zz-cgame.pk3` | server + re-published into `quake3-data/baseq3/` so the launcher downloads it | fork `cgame.qvm` only: mouse-wheel weapon cycling for browser clients |

Later paks override earlier ones, so the `zz-` prefix guarantees they win over
the retail VMs. The `zz-` names are expected on disk after `docker compose up`;
deleting them just makes the container re-copy them on next restart. Client
machines download `zz-cgame.pk3` automatically like any other asset (one
~98 KB file in the OPFS cache).

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

## All-in-one image (single container)

`Dockerfile.allinone` packs ioq3ded, the gateway and Caddy into one image
(`allinone/start.sh` supervises them; if one exits the container restarts as a
whole). One data volume, one service:

```sh
RCON_PASSWORD=... DOMAIN=quake.example.com \
  docker compose -f docker-compose.allinone.yml up -d --build
```

It uses the same ports as the three-container stack (80, 443, 27960/udp) —
stop that one first, or set `HTTP_PORT` / `HTTPS_PORT` / `GAME_UDP_PORT`.
`./quake3-data` is mounted read-write (the server publishes `zz-cgame.pk3`
into it); TLS certificates persist in the `caddy-state` volume. Inside the
container the gateway and Caddy's admin endpoint listen on loopback only.

## Custom maps

Drop map pk3s into `quake3-data/baseq3/` (or the active game dir) and restart
the server container. The server loads every `*.pk3` there, and the launcher
asks the gateway (`/paks`) for that same list, so browsers download the new
maps too (cached after the first time). The admin panel's map list picks them
up within a minute.

Both the launcher (below the server picker) and the admin panel (Game card)
show a map gallery with each map's `levelshots/<map>.jpg|tga` screenshot,
served by the gateway at `/levelshot/<map>`; the map being played is marked.
In the admin panel, click a screenshot to select it, then **Load Map**.

**Upload from the browser:** the admin panel's *Upload maps* card puts
`.pk3` files straight into the game dir (password required, max
`MAX_UPLOAD_MB`, default 300 MB). Only map pk3s are accepted: the file must
contain `maps/*.bsp`, must not carry game code (`vm/`, `.qvm`, native
libraries), and cannot replace or delete retail `pak*.pk3` / `zz-*.pk3`. The
game server only loads new pk3s when it starts, so press **Restart server to
load** afterwards (~10 s, everyone reconnects). Works with the all-in-one
image; the three-container stack mounts the data read-only for the gateway,
so there the card stays disabled. Behind Cloudflare, uploads over 100 MB
(free plan limit) must go through the LAN address instead.

Play them via the admin panel (Map card), `callvote map <name>` in-game, or
the rotation in `server/defaults/baseq3.cfg` / `Q3JS_SERVER_CONFIG`. The map
name is the `maps/<name>.bsp` inside the pk3, not the pk3's file name
(`unzip -Z1 file.pk3 | grep bsp`). Maps without a `.aas` file have no bot
navigation, so bots stand still there.

## Leaderboard

`/stats.html` (linked from the launcher and admin panel) shows frags,
deaths, K/D, suicides, matches, wins (FFA/duel top score), favourite weapon
and victim per player, frags by weapon, most played maps and recent match
podiums. The gateway rebuilds it from the game server's own `games.log`
(`STATS_LOG`, on the server-state volume), so there is no database and
history survives restarts; `g_logsync 1` in the server defaults makes new
frags show up within seconds. Players are keyed by name (color codes
stripped); bots are hidden unless *include bots* is ticked. To reset the
stats, delete `games.log` from the server-state volume.

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

The official point-release paks carry baseline game code: `pak7.pk3`/`pak8.pk3`
contain the id 1.32 QVMs (cgame/qagame/ui). On top of that this stack loads two
build-product pk3s (see the table above): the **server** runs the fork's
`qagame.qvm` (score keep) and **browser clients** run the fork's `cgame.qvm`
(weapon-wheel fix), while menus (`ui.qvm`) stay vanilla — the fork's UI needs
menu data files we cannot redistribute. Native desktop players also load the
fork's game module from the server (fair: the ping-limiting and score rules
apply to everyone).

## Admin panel

`admin.html` talks to gateway endpoints under `/admin/api/`. The gateway
authenticates requests against `RCON_PASSWORD` (required by the compose files —
`docker compose up` refuses to start without it, e.g.
`RCON_PASSWORD=... docker compose up -d` or a line in `deploy/.env`) and
injects it into rcon datagrams; the game server validates the password again.

- **Unlock** validates the password once per browser tab; `/admin/api/auth`
  returns 403 with a clear hint when it does not match `RCON_PASSWORD`.
- **Flags** card toggles rule cvars through rcon (`set <cvar> 0|1`):
  `g_scoreKeep` (keep disconnected players' scores until the map changes),
  `g_friendlyFire`, `g_allowVote`, `g_doWarmup`, `g_teamForceBalance`,
  `g_forcerespawn`.
- **Bots** card adds bots with a skill slider (`addbot <name> <skill 1-5>`,
  skills: 1 I-can-win … 5 nightmare) and removes them with
  `kick <name>` / `kickbots`. `bot_minplayers` is a one-fill field that adds
  bots until the map has that many players (set it back to `0` to stop
  auto-filling).
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
- **Mouse wheel sensitivity**: the toolbar's `wheel −` / `wheel +` buttons set
  `in_wheelPx` — pixels of wheel scroll per weapon step (lower = more
  sensitive). It takes effect immediately and is remembered per browser
  (localStorage + the engine's archived config). The wheel cycles every owned
  weapon slot in one step, including empty-ammo guns.
- **Server picker**: the launcher home page lists the live community servers
  registered on the Q3JS master (relayed by this gateway at `/servers`).
  `Play` joins the selected server — your own stack is the default first
  option, and the launcher applies `wss://<host>:<proxyPort>/ws` plus the
  listed UDP port per entry. Grayed-out rows are unjoinable from this site
  because they need content it does not host: a different `fs_game` mod, a
  password, or a map whose `.bsp` is missing from the local pk3 set (checked
  against the paks' central directories). A `?server=`/`?connect=` link still
  overrides the picker directly.
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
game/apply-emsdk-sdl-patch.sh   # emsdk SDL2 port: audio divide-by-zero guard
./game/build-client.sh          # (or: make client)
cp game/build/client/Release/ioquake3.{js,wasm} deploy/public/
```

## Listing on q3js.com (community server)

q3js.com's live server list is fed by heartbeats to its master
(`master.q3js.com`). Once your stack runs on a **public domain with real TLS**,
opt in by setting an environment variable before `docker compose up`:

```sh
Q3JS_PUBLISH_HOST=quake.example.com docker compose up -d
```

The gateway then sends the same anonymous heartbeat as the packaged q3js
server (`PUT /api/servers/heartbeat`, every 5 s) announcing:

- `wss://quake.example.com:443/ws` — where browser players connect (Caddy
  already routes `/ws` to the gateway, so no extra ports are needed)
- `udp://quake.example.com:27960` — for native ioquake3 players

The master validates reachability by opening the `/ws` WebSocket and querying
the game status through it; a validated server appears in
[the browser list](https://q3js.com/#servers), and stops sending heartbeats to
be pruned after ~5 minutes.

Related variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `Q3JS_MASTER_URL` | `https://master.q3js.com` | registry to send heartbeats to |
| `Q3JS_PUBLISH_HOST` | *(unset = disabled)* | public hostname to announce |
| `Q3JS_PUBLISH_PORT` | `443` | public ws port (Caddy TLS) |
| `Q3JS_SECURE` | `true` | players reach `/ws` over `wss://` |
| `Q3JS_TARGET_PORT` | `27960` | public UDP port for native players |

Notes:

- `localhost`/private hostnames are refused on purpose — the master has to be
  able to connect back, so a self-signed local deployment cannot be listed.
- Players joining from q3js.com run the upstream q3js client with
  q3js.com-hosted assets against this server; nothing extra is required on
  their side (server runs `sv_pure 0`).
- No heartbeat for a private network — just leave `Q3JS_PUBLISH_HOST` unset
  and the gateway stays unlisted.

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
