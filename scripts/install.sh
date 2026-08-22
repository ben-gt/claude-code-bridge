#!/bin/sh
# Install (or update) the systemd unit and start the service.
set -e
cd "$(dirname "$0")/.."
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH" >&2; exit 1; fi
NODE_DIR="$(dirname "$NODE_BIN")"
sed -e "s#/root/.nvm/versions/node/v22.14.0/bin#$NODE_DIR#g" \
    -e "s#/root/code/claude-code-bridge#$(pwd)#g" \
    deploy/claude-code-bridge.service > /etc/systemd/system/claude-code-bridge.service
systemctl daemon-reload
systemctl enable claude-code-bridge >/dev/null
systemctl restart claude-code-bridge
sleep 1
systemctl --no-pager --lines=5 status claude-code-bridge || true
echo
echo "Token file: $(node -e "import('./src/config.js').then(m=>console.log(m.loadConfig().server.token_file))")"
echo "Print it with: scripts/token.sh"
