# Quake III Arena — self-hosted web server

Part of **Q3MP**, a fork of [lklacar/q3js](https://github.com/lklacar/q3js)
(credit to Luka Klacar and the ioquake3 authors). Feature overview: the
[root README](../README.md#what-this-fork-adds).

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
RCON_PASSWORD=... DOMAIN=quake.example.com BIND_IP=0.0.0.0 \
  docker compose -f docker-compose.allinone.yml up -d --build
```

Ports are published on `127.0.0.1` unless `BIND_IP` says otherwise, so a
local test run is not reachable from the network; a public server needs
`BIND_IP=0.0.0.0`. `SV_FPS` (default 30) sets the server's update rate.

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

## Game-mode presets

The admin panel's *Game mode* card switches the whole server with one click:
**Free for all**, **Team deathmatch**, **Capture the flag**, **Duel**,
**Freeze tag**, **Instagib**, **Rocket arena**, **Excessive** or **Gun game**. Each
sets the gametype and its limits, builds a map rotation (`d1`…`dN` vstr chain,
up to 16 maps) from the maps in the server paks, and loads the first map.
**edit maps** picks a mode's rotation yourself — tick maps in play order,
custom maps included; the choice is saved in `PRESETS_FILE` (all-in-one:
`/state/gateway/presets.json`, split stack: the `gateway-state` volume).
Without a saved list, FFA/TDM use your custom maps first and then the stock
DM maps, CTF the `q3ctf*` / `*_ctf` maps, Duel the tourney maps. **Next Map**
advances the rotation. The mode lasts until the server restarts (then the
config defaults apply again).

Two weapon arenas come from the fork's game code (`g_weaponMode`, latched,
applies on map load — the presets reload the map for you):

| Preset | `g_weaponMode` | Rules |
| --- | --- | --- |
| **Instagib** | 1 | railgun only, endless ammo, any railgun hit kills |
| **Rocket arena** | 2 | rocket launcher + gauntlet, endless rockets, spawn with 100 armor |
| **Excessive** | 3 | inspired by Excessive Plus (e+): every weapon incl. BFG with endless ammo, permanent haste, rockets 1.5× faster; the preset adds double knockback (`g_knockback 2000`), no falling damage (`dmflags 8`), low gravity (`g_gravityOverride 600`, jumps ~33% higher) and free rocket jumps (`g_selfDamage 0`: your own splash pushes you but does no damage) |
| **Gun game** | 4 | one weapon at a time, each kill moves you to the next; win with a gauntlet kill on the last level |

In Instagib and Rocket arena every weapon, ammo, armor, health and powerup
pickup is removed from the map (CTF flags stay); Excessive removes only
weapons and ammo. Dead players drop nothing. Bots play all three. Excessive is
our own take on the e+ style — Excessive Plus itself is closed source and not
included.

**Gun game** (`g_weaponMode 4`, free for all): everyone starts on the
machinegun and every kill moves you to the next weapon — machinegun, shotgun,
lightning gun, plasma gun, grenade launcher, rocket launcher, railgun, BFG and
finally the gauntlet; a gauntlet kill on that last level wins. Your score is
your level (the preset's fraglimit is the 9 levels). A gauntlet kill knocks
the victim down a level, and so does a suicide or a death to the world.
Weapons and ammo are removed from the map (health, armor and powerups stay),
ammo never runs out, and the game client switches to each new weapon by
itself. Bots always fight in this mode instead of retreating with a weak gun.
Chat: `!mode gungame` (or `gg`).

Maps set `g_gravity` themselves on load, so modes change gravity through
`g_gravityOverride` (0 = the map's own value); `g_selfDamage 0` works in any
mode (`g_debugDamage 1` logs each blocked hit as `SelfDamage:`). Every preset
resets both, so leaving Excessive restores normal physics.

**Spawn protection** (all weapon arenas): for `g_spawnProtect` milliseconds
after spawning (default 2000, `0` = off) other players can neither hurt nor
push you, shown as the battle suit shell and its HUD timer. Firing ends it
early, so it cannot be used to attack safely. `g_debugDamage 1` logs every
blocked hit as `SpawnProtect:` in games.log.

**Freeze tag** (`g_freeze 1`, latched, team deathmatch): a kill by an enemy
freezes the victim in place instead of killing them (it still counts as a
frag) — frozen players cannot move, shoot or be damaged and glow with a
battle suit shell. A teammate who stands next to a frozen player for
`g_thawTime` seconds (default 3) thaws them and earns a point. When a whole
team is frozen the other team wins the round (team score = rounds) and after
3 seconds everyone respawns for the next round; the preset plays to 7 rounds.
Deaths to the world (lava, falling) or your own rockets are normal deaths,
and `/kill` is blocked while frozen. Bots ignore frozen enemies and thaw
teammates only when they happen to pass by.

## Mutators

The admin panel's *Mutators* card stacks extra rules on top of any mode:

| Mutator | cvars | Effect |
| --- | --- | --- |
| **Low gravity** | `g_gravityOverride 400` | jumps twice as high |
| **Free rocket jumps** | `g_selfDamage 0` | your own splash pushes you but does no damage |
| **Vampire** | `g_vampire 0.5` | half the health you take from enemies heals you (up to 200) |
| **Grappling hook** | `g_grapple 1` | everyone carries the hook — mouse wheel, or `weapon 10` in the console |
| **Quad for all** | `g_quadAll 1` | permanent quad damage for everyone |

The choice is saved in `PRESETS_FILE`, laid over every preset, and put back
by the gateway after a server restart (it compares the serverinfo after each
map load and once a minute). Gravity, rocket jumps and vampire apply at once;
the hook and quad go to everyone alive right away and on every spawn. A mode's
own rule (Excessive's free rocket jumps) shows as "from mode". The start page
lists active mutators next to the mode, e.g. *Free for all + vampire*.

## Unlagged (hitscan lag compensation)

Browser players reach the server through WebSockets (and often Cloudflare),
which adds latency. With `g_unlagged 1` (default) the server records every
player's position each frame and, when someone fires an instant-hit weapon
(gauntlet, machinegun, shotgun, lightning gun, railgun), traces the shot
against where the other players were on the shooter's screen — so you hit
what you aim at instead of leading targets by your ping. Rewinds are capped
at `g_unlaggedMax` (default 400 ms); rockets, grenades, plasma and BFG are
projectiles and are not rewound. `g_unlaggedDebug 1` prints every rewind to
the server log. Our own implementation in the fork's `qagame`
(`g_weapon.c`), in the spirit of Neil Toronto's Unlagged mod.

## Voting a game mode in chat

Players switch modes themselves from in-game chat (`T`):

| Chat | Does |
| --- | --- |
| `!modes` (or `!help`) | lists the modes: `ffa · tdm · ctf · duel · freeze · insta · rockets · excessive` |
| `!mode insta` | starts a 20 s vote for a mode (the caller counts as *yes*) |
| `!yes` / `!no` | answers the running vote |

Short names work too: `dm`, `team`, `flag`, `1v1`, `ft`, `ig`/`rail`, `ra`,
`e+`/`xs` (see `ALIASES` in `gateway/presets.mjs`). A vote passes with more
*yes* than *no* (as soon as a majority says yes, or when time runs out); a
tie or a *no* majority fails it. With a single human the mode changes right
away; bots never vote. After a vote there is a 60 s cooldown. A passing vote
applies the same preset as the admin panel — settings and your saved map
rotation — announced 3 s ahead.

Each human gets a short private welcome on joining (at most every 30
minutes) naming the current mode and `!modes`. The launcher shows the mode
being played and a **Chat commands** card listing every mode with its
`!mode` command and short names (click one to copy it), the current mode
marked, plus the vote and map-vote keys — served by the gateway at `/modes`. Turn chat voting off with the checkbox in the admin
*Game mode* card. The gateway reads the chat from the server's `games.log`
and answers with `say` / `tell` over rcon. In the all-in-one image a mode
switch is one `exec` of a generated `q3preset.cfg` (instant); the
three-container stack sends the preset command by command (~15 s, rcon rate
limit).

## End-of-match map vote

When a match ends, a ballot with three maps appears over the scoreboard and
players pick the next one by typing **1**, **2** or **3** in chat (`T`), or
`/mapvote 2` in the console. Candidates come from the current game-mode
preset's rotation (`g_mapvoteMaps`, set by the preset) or, without one, from
every map on the server that fits the gametype (CTF maps for CTF, no CTF or
tourney maps otherwise). The vote closes after `g_mapvoteTime` seconds
(default 15) or as soon as every human player has voted; the most voted map
loads next (ties broken at random), and with no votes the normal rotation
continues. Bots do not vote. Duels skip it (they restart instead of changing
map). Turn it off with the *end-of-match map vote* flag in the admin panel
(`g_mapvote 0`). Server-side code is the fork's `qagame`; the ballot is drawn
by the fork's `cgame` (`zz-cgame.pk3`, downloaded by the launcher).

## Bots

Bots only move on maps with bot navigation (`maps/<name>.aas`). The
all-in-one image bundles **bspc** (the GPL bot-navigation compiler, pinned
from github.com/TTimo/bspc) and the gateway runs it for maps that lack it:
automatically for every map in an uploaded pk3, and for the rest with
**Generate missing** in the admin *Bots* card. The result is written as
`zz-aas-<map>.pk3` next to the map (a few seconds to minutes per map) and
loads on the next server restart; deleting the map pk3 removes it too. Maps
still without navigation are marked *no bots* in both galleries.

**Auto-fill** keeps the server at N players with bots (`bot_minplayers`;
bots leave as humans join) at the difficulty picked next to it (`g_spSkill`,
1 easy … 5 nightmare).

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

**Clean-up** (admin panel → *Leaderboard*): **remove** a player (their row and
every kill they were part of, both ways), **merge** two names one person
used into one player, **remove** a match from the stats, or **reset** the
leaderboard so only what is played from now on counts. `games.log` is never
changed — the choices live in `stats-admin.json` next to `PRESETS_FILE`
(override with `STATS_ADMIN_FILE`) and are applied while the log is parsed,
so every one of them has an *undo*. API: `GET /admin/api/stats`, `POST
/admin/api/stats {password, action: remove|restore|merge|unmerge|removeMatch|restoreMatch|reset|undoReset, ...}`.

## Cloudflare caching for PK3 downloads

Every new browser downloads ~530 MB of paks once. Behind Cloudflare these can
come from Cloudflare's edge instead of your upload link — **but a cached pak
is served to anyone who asks**, without passing through your server. So it is
opt-in, and only safe when the site is public or gated *at Cloudflare* with
**Cloudflare Access** (Zero Trust → Access → Applications; free for small
teams). With a password in your own Caddy (`basic_auth`) behind Cloudflare,
leave it off: Cloudflare caches authenticated responses marked `public` and
would hand the paks to people without the password.

To enable it:

1. Set `PAK_CACHE_CONTROL="public, max-age=0, s-maxage=86400"` in the
   compose environment / `.env` and recreate the container. Paks under
   `/assets/` then tell shared caches to keep them for a day; browsers still
   revalidate. `zz-*.pk3` (rebuilt or generated in place) stay `no-cache`.
2. In Cloudflare: *Caching → Cache Rules → Create rule* — when *URI Path*
   *starts with* `/assets/`, set *Cache eligibility: Eligible for cache*,
   *Edge TTL: Use cache-control header if present*. (`.pk3` is not in
   Cloudflare's default cached extensions, so without this rule nothing is
   cached.) The free plan caches files up to 512 MB, which covers `pak0.pk3`.
3. Check with `curl -sI https://<host>/assets/baseq3/pak1.pk3 | grep -i cf-cache-status`
   twice: `MISS`, then `HIT`.

After replacing a pak under the same name, purge it (*Caching → Configuration
→ Purge by URL*) or wait a day.

## Health checks

The gateway's `/healthz` returns 200 only while the game server answers a
status query too. Docker shows the result (`docker compose ps` → *healthy* /
*unhealthy*; UGOS and other NAS UIs show it as well):

- **All-in-one image:** a `HEALTHCHECK` checks gateway + game server + Caddy.
  Docker only *marks* an unhealthy container, so `start.sh` also runs a
  watchdog: after a 90 s start-up grace, 4 failed checks in a row (30 s apart,
  `WATCHDOG_GRACE` / `WATCHDOG_FAILS`) stop the container — hung processes
  are force-killed after 10 s — and `restart: unless-stopped` starts it fresh.
- **Three-container stack:** `q3ded` answers `getstatus` on UDP, `gateway`
  serves `/healthz`, `web` (Caddy) answers its admin API. These only report;
  add an autoheal container if you want automatic restarts there.

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
