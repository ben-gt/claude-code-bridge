#!/bin/sh
# Exit 0 when idle, 2 when jobs are active, 1 when status cannot be checked.
set -e
cd "$(dirname "$0")/.."
for state in running queued; do
  result=$(sh scripts/mcp-call.sh list_jobs "{\"state\":\"$state\",\"limit\":1}") || exit 1
  if printf '%s' "$result" | node -e '
    let s="";
    process.stdin.on("data", d => s += d).on("end", () => {
      const result = JSON.parse(s);
      if (!Array.isArray(result.jobs)) process.exit(1);
      if (result.jobs.length) {
        console.error("Code Bridge has active jobs; retry after they finish.");
        process.exit(2);
      }
    });'
  then
    :
  else
    exit "$?"
  fi
done
