#!/usr/bin/env bash
# Install CacheLane production runtime to /srv/cachelane and (re)start dual units.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${CACHELANE_INSTALL:-/srv/cachelane}"

echo "==> build from $ROOT"
cd "$ROOT"
npm run build

echo "==> install to $INSTALL"
mkdir -p "$INSTALL"
rsync -a --delete \
  --exclude '.git' --exclude 'src' --exclude 'node_modules' \
  --exclude 'coverage' --exclude '*.log' \
  "$ROOT/dist/" "$INSTALL/dist/"
cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$INSTALL/"
mkdir -p "$INSTALL/scripts"
cp -a "$ROOT/scripts/health-dual.mjs" "$INSTALL/scripts/" 2>/dev/null || true
if [[ ! -d "$INSTALL/node_modules" ]]; then
  (cd "$INSTALL" && npm ci --omit=dev)
else
  # refresh if package-lock changed
  (cd "$INSTALL" && npm ci --omit=dev)
fi
git -C "$ROOT" rev-parse HEAD > "$INSTALL/GIT_SHA"
date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL/INSTALLED_AT"

# Ensure dual user units point at install
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/cachelane-smoke.service" <<UNIT
[Unit]
Description=CacheLane Pi/LiteLLM proxy (:7332 → LiteLLM)
After=network-online.target

[Service]
Type=simple
Environment=CACHELANE_HOME=%h/.cachelane-smoke
WorkingDirectory=$INSTALL
ExecStart=/usr/bin/node dist/cli/index.cjs proxy
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
cat > "$UNIT_DIR/cachelane-anthropic.service" <<UNIT
[Unit]
Description=CacheLane Claude Code proxy (:7333 → api.anthropic.com, NOT LiteLLM)
After=network-online.target

[Service]
Type=simple
Environment=CACHELANE_HOME=%h/.cachelane
WorkingDirectory=$INSTALL
ExecStart=/usr/bin/node dist/cli/index.cjs proxy
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now cachelane-smoke.service cachelane-anthropic.service
systemctl --user restart cachelane-smoke.service cachelane-anthropic.service
sleep 1
node "$INSTALL/scripts/health-dual.mjs"
echo "installed $(cat "$INSTALL/GIT_SHA") at $(cat "$INSTALL/INSTALLED_AT")"
