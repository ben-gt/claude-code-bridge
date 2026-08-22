#!/bin/sh
# Register (or update) this bridge as an MCP connection in the local Open WebUI,
# using the same helper the other MCP servers on this box use.
#   scripts/register-openwebui.sh [id] [url] [--public|--private]
# Defaults: id=claude_code, url=http://172.20.0.1:4010/mcp (host as seen from the open-webui container).
set -e
cd "$(dirname "$0")/.."
ID="${1:-claude_code}"
URL="${2:-http://172.20.0.1:4010/mcp}"
ACCESS="${3:---private}"
OPENUI_DIR="${OPENUI_DIR:-/root/code/openui}"
TOKEN="$(sh scripts/token.sh)"
MCP_TOKEN="$TOKEN" sh "$OPENUI_DIR/scripts/mcp-connections.sh" add "$ID" "$URL" "$ACCESS" Claude Code
