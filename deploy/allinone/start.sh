#!/bin/bash
# Supervisor for the all-in-one image: runs ioq3ded, the gateway and Caddy.
# If any of them exits, stop the rest and exit non-zero so Docker's restart
# policy brings the whole stack back up together.
set -uo pipefail

GAME_DATA_DIR="/data/${FS_BASEGAME:-baseq3}"
export GAME_DATA_DIR

pids=()
shutdown() {
  trap - TERM INT
  kill -TERM "${pids[@]}" 2>/dev/null
  wait
}
trap 'shutdown; exit 0' TERM INT

/usr/local/bin/q3ded-entrypoint.sh "$@" &
pids+=($!)

(cd /opt/gateway && exec node gateway.mjs) &
pids+=($!)

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
pids+=($!)

wait -n
status=$?
echo "start.sh: a service exited (status $status) - stopping the container" >&2
shutdown
exit "${status/#0/1}"
