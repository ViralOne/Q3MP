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

# Link the paks from the data mount into the staged game dir.
if [ ! -f "$Q3_DATA_DIR/pak0.pk3" ]; then
  echo "DEPLOY-WARN: no pak0.pk3 at $Q3_DATA_DIR - game data is missing." >&2
fi
for f in "$Q3_DATA_DIR"/*.pk3 "$Q3_DATA_DIR"/*.cfg; do
  [ -e "$f" ] || continue
  ln -sf "$f" "$FS_BASEPATH/$BASEGAME/$(basename "$f")"
done

# If the data mount already provides a zz-scorekeep.pk3 it overrode the copy
# above via the symlink; otherwise stage the image-bundled one, server-side
# only (retail baseq3; the demo build stays untouched).
if [ "$BASEGAME" != "demoq3" ]; then
  if [ ! -e "$FS_BASEPATH/$BASEGAME/zz-scorekeep.pk3" ]; then
    cp -f /opt/baseq3-extra/zz-scorekeep.pk3 "$FS_BASEPATH/$BASEGAME/zz-scorekeep.pk3"
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
