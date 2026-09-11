#!/bin/sh
# Restart the bridge WITHOUT killing running jobs: waits until no job is running
# (or queued), then restarts. A plain `systemctl restart` marks every active job
# `interrupted` — fine in an emergency, wrong during a routine deploy.
#   scripts/restart-safe.sh [--max-wait-seconds N]   (default 1800)
set -e
cd "$(dirname "$0")/.."
MAX="${2:-1800}"; [ "${1:-}" = "--max-wait-seconds" ] || MAX=1800
waited=0
while :; do
  if sh scripts/check-idle.sh; then break; else status=$?; fi
  [ "$status" -eq 2 ] || exit "$status"
  if [ "$waited" -ge "$MAX" ]; then echo "still active after ${MAX}s — not restarting" >&2; exit 1; fi
  echo "waiting for active job(s)"
  sleep 15; waited=$((waited+15))
done
systemctl restart code-bridge
sleep 2
systemctl --no-pager --lines=2 status code-bridge | head -3
