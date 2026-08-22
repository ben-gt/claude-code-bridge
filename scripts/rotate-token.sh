#!/bin/sh
# Rotate the bridge's bearer token: generate a new one, restart the service, print it.
# Re-register the Open WebUI connection afterwards (scripts/register-openwebui.sh).
set -e
cd "$(dirname "$0")/.."
FILE="$(node -e "import('./src/config.js').then(m=>console.log(m.loadConfig().server.token_file))")"
mkdir -p "$(dirname "$FILE")"; chmod 700 "$(dirname "$FILE")"
umask 077
printf 'ccb_%s\n' "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" > "$FILE"
chmod 600 "$FILE"
if systemctl is-active --quiet claude-code-bridge; then systemctl restart claude-code-bridge; fi
echo "new token written to $FILE"
