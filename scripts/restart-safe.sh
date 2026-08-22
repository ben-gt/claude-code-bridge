#!/bin/sh
# Restart the bridge WITHOUT killing running jobs: waits until no job is running
# (or queued), then restarts. A plain `systemctl restart` marks every active job
# `interrupted` — fine in an emergency, wrong during a routine deploy.
#   scripts/restart-safe.sh [--max-wait-seconds N]   (default 1800)
set -e
cd "$(dirname "$0")/.."
MAX="${2:-1800}"; [ "$1" = "--max-wait-seconds" ] || MAX=1800
waited=0
while :; do
  active=$(scripts/mcp-call.sh list_jobs '{"limit":50}' 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).jobs.filter(j=>j.state==="running"||j.state==="queued");console.log(j.map(j=>j.job_id+"("+j.project+")").join(" "))})' 2>/dev/null || true)
  [ -z "$active" ] && break
  if [ "$waited" -ge "$MAX" ]; then echo "still active after ${MAX}s: $active — not restarting" >&2; exit 1; fi
  echo "waiting for active job(s): $active"
  sleep 15; waited=$((waited+15))
done
systemctl restart claude-code-bridge
sleep 2
systemctl --no-pager --lines=2 status claude-code-bridge | head -3
