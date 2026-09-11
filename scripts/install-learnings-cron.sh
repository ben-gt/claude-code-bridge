#!/bin/sh
# Install one daily, non-overlapping maintenance task. Re-running replaces it.
set -eu
cd "$(dirname "$0")/.."
node_bin=$(command -v node)
flock_bin=$(command -v flock)
repo_dir=$(pwd)
# cron treats percent and newlines specially, even within shell quotes.
case "$repo_dir$node_bin$flock_bin" in
  *"'"*|*'%'*|*'
'*) echo 'Unsupported quote, percent, or newline in install path' >&2; exit 1 ;;
esac
cron_file=/etc/cron.d/code-bridge-learnings
tmp_file=$(mktemp)
trap 'rm -f "$tmp_file"' EXIT HUP INT TERM
cat > "$tmp_file" <<EOF
# Code Bridge factual learnings maintenance, daily at 03:17 (host timezone).
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root cd '$repo_dir' && '$flock_bin' -n /run/lock/code-bridge-learnings.lock '$node_bin' scripts/maintain-learnings.js
EOF
install -m 0644 "$tmp_file" "$cron_file"
echo "Installed $cron_file (daily at 03:17, host timezone)."
