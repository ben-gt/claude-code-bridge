#!/bin/sh
# Call one bridge tool from the shell (handy for debugging / acceptance checks).
#   scripts/mcp-call.sh <tool_name> ['{"json":"args"}']
# Env: BRIDGE_URL (default http://127.0.0.1:4010/mcp)
set -e
cd "$(dirname "$0")/.."
TOOL="$1"; ARGS="${2:-{\}}"
URL="${BRIDGE_URL:-http://127.0.0.1:4010/mcp}"
TOKEN="$(sh scripts/token.sh)"
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error){console.error(JSON.stringify(j.error));process.exit(1)}const r=j.result;if(r.isError){console.error(r.content.map(c=>c.text).join("\n"));process.exit(2)}console.log(r.structuredContent?JSON.stringify(r.structuredContent,null,2):r.content.map(c=>c.text).join("\n"))})'
