#!/bin/bash
# Stage the Quake 3 game directory for ioq3ded.
#
# Inside the container:
#   /data/<game>       pak mount, read-only (baseq3 retail or demoq3 demo)
#   /game/<game>       staged fs_basepath: QVM pk3 (copied) + symlinks into /data
#   /state             fs_homepath (writable server state)
#
# Optional env:
#   FS_BASEGAME        baseq3 (default) | demoq3
#   FS_BASEPATH        default /game
#   FS_HOMEPATH        default /state
#   Q3_DATA_DIR        default /data
#   Q3JS_SERVER_CONFIG full server config text; overrides the bundled default
set -euo pipefail

FS_BASEPATH="${FS_BASEPATH:-/game}"
FS_HOMEPATH="${FS_HOMEPATH:-/state}"
BASEGAME="${FS_BASEGAME:-baseq3}"
Q3_DATA_DIR="${Q3_DATA_DIR:-/data}/$BASEGAME"

mkdir -p "$FS_BASEPATH/$BASEGAME" "$FS_HOMEPATH"

# The VMs (cgame/qagame/ui) come from the point-release paks themselves:
# pak7/pak8 carry the official 1.32 QVMs, so nothing needs to be staged here.

# Drop links to paks that were removed from the data mount since the last
# start (admin-panel map deletes), then link the current ones.
find "$FS_BASEPATH/$BASEGAME" -maxdepth 1 -type l ! -exec test -e {} \; -delete

# Link the paks from the data mount into the staged game dir.
if [ ! -f "$Q3_DATA_DIR/pak0.pk3" ]; then
  echo "DEPLOY-WARN: no pak0.pk3 at $Q3_DATA_DIR - game data is missing." >&2
fi
for f in "$Q3_DATA_DIR"/*.pk3 "$Q3_DATA_DIR"/*.cfg; do
  [ -e "$f" ] || continue
  ln -sf "$f" "$FS_BASEPATH/$BASEGAME/$(basename "$f")"
done

# Always overwrite with this image's copy — the pk3 is rebuilt here and a stale
# one must never survive a container recreate.
if [ "$BASEGAME" != "demoq3" ]; then
  cp -f /opt/baseq3-extra/zz-scorekeep.pk3 "$FS_BASEPATH/$BASEGAME/zz-scorekeep.pk3"
  cp -f /opt/baseq3-extra/zz-cgame.pk3 "$FS_BASEPATH/$BASEGAME/zz-cgame.pk3"
  # publish the client cgame for the browsers: /out is the same host directory
  # the web server serves under /assets/ (compose binds ./quake3-data there).
  if [ -d /out ]; then
    mkdir -p "/out/$BASEGAME"
    cp -f /opt/baseq3-extra/zz-cgame.pk3 "/out/$BASEGAME/zz-cgame.pk3"
  fi
fi

# Server config: user-provided file contents or the bundled default for this
# base game (server.cfg for baseq3, demoq3.cfg for the demo).
CONFIG_FILE="$FS_BASEPATH/$BASEGAME/zz-server-defaults.cfg"
if [ -n "${Q3JS_SERVER_CONFIG:-}" ]; then
  printf '%s\n' "$Q3JS_SERVER_CONFIG" > "$CONFIG_FILE"
else
  cp "/defaults/${BASEGAME}.cfg" "$CONFIG_FILE"
fi

# Remote console password for the admin panel; empty disables rcon server-side.
# NB: this ioquake3 fork registers the rcon password cvar as "rconPassword".
if [ -n "${RCON_PASSWORD:-}" ]; then
  printf 'seta rconPassword "%s"\n' "$RCON_PASSWORD" >> "$CONFIG_FILE"
fi

ARGS=(
  +set fs_basepath "$FS_BASEPATH"
  +set fs_homepath "$FS_HOMEPATH"
  +set com_basegame "$BASEGAME"
  +exec zz-server-defaults.cfg
)
if [ -n "${Q3_FS_GAME:-}" ]; then
  ARGS+=(+set fs_game "$Q3_FS_GAME")
fi

exec /usr/local/bin/ioq3ded "${ARGS[@]}" "$@"
