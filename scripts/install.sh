#!/bin/sh
# Install (or update) the systemd unit and start the service.
set -e
cd "$(dirname "$0")/.."
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH" >&2; exit 1; fi
NODE_DIR="$(dirname "$NODE_BIN")"
# Refuse to interrupt jobs when replacing either service name. Also fail if
# the running service cannot be queried, rather than assuming it is idle.
for service in code-bridge claude-code-bridge; do
  if systemctl is-active --quiet "$service"; then
    sh scripts/check-idle.sh
  fi
done
sed -e "s#/root/.nvm/versions/node/v22.14.0/bin#$NODE_DIR#g" \
    -e "s#/root/code/code-bridge#$(pwd)#g" \
    deploy/code-bridge.service > /etc/systemd/system/code-bridge.service
systemctl daemon-reload
# The old unit must not compete for the same port after a reboot.
if systemctl cat claude-code-bridge.service >/dev/null 2>&1; then
  systemctl disable --now claude-code-bridge.service
fi
systemctl enable code-bridge >/dev/null
systemctl restart code-bridge
sleep 1
systemctl --no-pager --lines=5 status code-bridge
echo
echo "Token file: $(node -e "import('./src/config.js').then(m=>console.log(m.loadConfig().server.token_file))")"
echo "Print it with: scripts/token.sh"
