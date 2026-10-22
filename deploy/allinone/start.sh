#!/bin/bash
# Supervisor for the all-in-one image: runs ioq3ded, the gateway and Caddy.
# If any of them exits, stop the rest and exit non-zero so Docker's restart
# policy brings the whole stack back up together.
set -uo pipefail

GAME_DATA_DIR="/data/${FS_BASEGAME:-baseq3}"
STATS_LOG="/state/${FS_BASEGAME:-baseq3}/games.log"
export GAME_DATA_DIR STATS_LOG

pids=()
# Ask everything to stop, give it 10 s, then force it: a hung or stopped
# process (the reason the watchdog fired) never acts on SIGTERM.
shutdown() {
  trap - TERM INT
  kill -TERM "${pids[@]}" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && return
    sleep 1
  done
  echo "start.sh: forcing the remaining services down" >&2
  kill -KILL "${pids[@]}" 2>/dev/null
}
trap 'shutdown; exit 0' TERM INT

/usr/local/bin/q3ded-entrypoint.sh "$@" &
pids+=($!)

(cd /opt/gateway && exec node gateway.mjs) &
pids+=($!)

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
pids+=($!)

# Watchdog: Docker only *marks* an unhealthy container, it does not restart
# it. After a start-up grace period, WATCHDOG_FAILS failed health checks in a
# row (30 s apart) end the container so the restart policy brings it back.
(
  sleep "${WATCHDOG_GRACE:-90}"
  fails=0
  while sleep 30; do
    if node /usr/local/bin/healthcheck.mjs >/dev/null 2>&1; then
      fails=0
    else
      fails=$((fails + 1))
      echo "start.sh: health check failed ($fails/${WATCHDOG_FAILS:-4})" >&2
      if [ "$fails" -ge "${WATCHDOG_FAILS:-4}" ]; then
        echo "start.sh: unhealthy - restarting the container" >&2
        exit 1
      fi
    fi
  done
) &
pids+=($!)

wait -n
status=$?
echo "start.sh: a service exited (status $status) - stopping the container" >&2
shutdown
exit "${status/#0/1}"
