#!/bin/sh
# Print the bridge's bearer token (for registering the MCP connection). Keep it out of logs.
cd "$(dirname "$0")/.."
FILE="$(node -e "import('./src/config.js').then(m=>console.log(m.loadConfig().server.token_file))")"
cat "$FILE"
