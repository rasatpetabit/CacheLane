#!/usr/bin/env bash
# Install CacheLane runtime into /srv/cachelane and (re)write hardened *system* units.
# Units:
#   cachelane-litellm  :7332 → LiteLLM (LiteLLM upstream; Pi / agent-dispatch / skynet)
#   cachelane-claude  :7333 → api.anthropic.com (Claude Code)
set -euo pipefail

INSTALL="${CACHELANE_INSTALL:-/srv/cachelane}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR=/etc/systemd/system

echo "Installing CacheLane from $REPO_ROOT → $INSTALL"
sudo mkdir -p "$INSTALL"
sudo rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.worktrees' \
  "$REPO_ROOT/" "$INSTALL/"
# Prefer already-built dist in repo; otherwise build
if [[ ! -f "$INSTALL/dist/cli/index.cjs" ]]; then
  (cd "$INSTALL" && npm ci && npm run build)
fi
git -C "$REPO_ROOT" rev-parse HEAD | sudo tee "$INSTALL/GIT_SHA" >/dev/null
date -u +%Y-%m-%dT%H:%M:%SZ | sudo tee "$INSTALL/INSTALLED_AT" >/dev/null

# Home dirs (canonical names + back-compat symlinks)
HOME_LITELLM="${CACHELANE_LITELLM_HOME:-$HOME/.cachelane-litellm}"
HOME_CLAUDE="${CACHELANE_CLAUDE_HOME:-$HOME/.cachelane-claude}"
mkdir -p "$HOME_LITELLM" "$HOME_CLAUDE"
# legacy names
[[ -e "$HOME/.cachelane-smoke" ]] || ln -sfn "$(basename "$HOME_LITELLM")" "$HOME/.cachelane-smoke"
[[ -e "$HOME/.cachelane-openai" ]] || ln -sfn "$(basename "$HOME_LITELLM")" "$HOME/.cachelane-openai"
if [[ -d "$HOME/.cachelane" && ! -L "$HOME/.cachelane" && "$HOME/.cachelane" -ef "$HOME_CLAUDE" ]]; then
  : # already same
elif [[ ! -e "$HOME/.cachelane" ]]; then
  ln -sfn "$(basename "$HOME_CLAUDE")" "$HOME/.cachelane"
fi

sudo tee "$UNIT_DIR/cachelane-litellm.service" >/dev/null <<UNIT
[Unit]
Description=CacheLane LiteLLM proxy (:7332 → LiteLLM)
Documentation=file:///srv/dev/ai/cachelane/docs/runbook-litellm.md
After=network-online.target litellm.service litellm-gateway-proxy.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER
Group=$USER
Environment=CACHELANE_HOME=$HOME_LITELLM
Environment=HOME=$HOME
WorkingDirectory=$INSTALL
ExecStart=/usr/bin/node dist/cli/index.cjs proxy
Restart=always
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME_LITELLM $HOME/.cachelane-openai $HOME/.cachelane-smoke
PrivateTmp=yes
NoNewPrivileges=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=512M
TasksMax=256

[Install]
WantedBy=multi-user.target
UNIT

sudo tee "$UNIT_DIR/cachelane-claude.service" >/dev/null <<UNIT
[Unit]
Description=CacheLane Claude/Anthropic proxy (:7333 → api.anthropic.com)
Documentation=file:///srv/dev/ai/cachelane/docs/runbook-litellm.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER
Group=$USER
Environment=CACHELANE_HOME=$HOME_CLAUDE
Environment=HOME=$HOME
WorkingDirectory=$INSTALL
ExecStart=/usr/bin/node dist/cli/index.cjs proxy
Restart=always
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME_CLAUDE $HOME/.cachelane
PrivateTmp=yes
NoNewPrivileges=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=512M
TasksMax=256

[Install]
WantedBy=multi-user.target
UNIT

# Healthcheck (idempotent)
sudo tee /usr/local/sbin/cachelane-healthcheck >/dev/null <<'HEALTH'
#!/usr/bin/env bash
set -euo pipefail
LOG_TAG=cachelane-healthcheck
fail=0
probe_tcp() { timeout 2 bash -c "echo >/dev/tcp/127.0.0.1/$1" 2>/dev/null; }
probe_litellm() { curl -sf -m 3 -H 'Authorization: Bearer noauth' http://127.0.0.1:7332/v1/models >/dev/null; }
probe_claude() {
  local code
  code=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
    -H 'x-api-key: invalid-probe-key' \
    -d '{"model":"probe","max_tokens":1,"messages":[{"role":"user","content":"x"}]}' \
    http://127.0.0.1:7333/v1/messages || true)
  [[ -n "$code" && "$code" != "000" ]]
}
check_one() {
  local name="$1" port="$2" probe_fn="$3"
  if ! systemctl is-active --quiet "$name"; then
    logger -t "$LOG_TAG" "WARN $name inactive; starting"
    systemctl start "$name" || true; fail=$((fail+1)); return
  fi
  if ! probe_tcp "$port" || ! "$probe_fn"; then
    logger -t "$LOG_TAG" "WARN $name port/probe failed; restarting"
    systemctl restart "$name" || true; fail=$((fail+1)); return
  fi
}
check_one cachelane-litellm.service 7332 probe_litellm
check_one cachelane-claude.service 7333 probe_claude
[[ "$fail" -eq 0 ]]
HEALTH
sudo chmod 755 /usr/local/sbin/cachelane-healthcheck

sudo tee "$UNIT_DIR/cachelane-healthcheck.service" >/dev/null <<'UNIT'
[Unit]
Description=CacheLane dual-proxy healthcheck (restart on failure)
After=cachelane-litellm.service cachelane-claude.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cachelane-healthcheck
UNIT

sudo tee "$UNIT_DIR/cachelane-healthcheck.timer" >/dev/null <<'UNIT'
[Unit]
Description=Run CacheLane healthcheck every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=cachelane-healthcheck.service
[Install]
WantedBy=timers.target
UNIT

# Disable legacy user units if present
systemctl --user disable --now cachelane-smoke.service cachelane-anthropic.service 2>/dev/null || true

sudo systemctl daemon-reload
sudo systemctl enable --now cachelane-litellm.service cachelane-claude.service cachelane-healthcheck.timer
sudo systemctl restart cachelane-litellm.service cachelane-claude.service
sleep 1
node "$INSTALL/scripts/health-dual.mjs"
echo "installed $(cat "$INSTALL/GIT_SHA") at $(cat "$INSTALL/INSTALLED_AT")"
