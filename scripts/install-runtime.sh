#!/usr/bin/env bash
# Install CacheLane runtime into /srv/cachelane and (re)write hardened *system* units.
# Units:
#   cachelane-litellm  :7332 → LiteLLM (LiteLLM upstream; Pi / agent-dispatch / skynet)
#   cachelane-claude  :7333 → api.anthropic.com (Claude Code)
set -euo pipefail

INSTALL="${CACHELANE_INSTALL:-/srv/cachelane}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR=/etc/systemd/system
NODE_BIN=/usr/bin/node
RUNTIME_NODE_DIR="$(dirname "$NODE_BIN")"
STAGE=""
BACKUP=""
DRAIN_TIMEOUT_SEC="${CACHELANE_DRAIN_TIMEOUT_SEC:-300}"

cleanup_stage() {
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
}
trap cleanup_stage EXIT

# Prefer the lane's own in-flight request count over ESTABLISHED sockets: an
# idle client holding an HTTP keep-alive connection keeps the socket count above
# zero indefinitely, so a socket-only drain check never succeeds while any
# session is open. Fall back to the socket check when the running build predates
# the inflight field, so an older lane still drains conservatively.
inflight_requests() {
  local port="$1" body
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
  [[ "$body" == *'"inflight"'* ]] || return 1
  printf '%s' "$body" | sed -E 's/.*"inflight"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/'
}

has_active_connections() {
  local port="$1" connections inflight
  if inflight="$(inflight_requests "$port")"; then
    [[ "$inflight" != "0" ]]
    return
  fi
  connections="$(ss -Htn state established "( sport = :$port )" 2>/dev/null || true)"
  [[ -n "$connections" ]]
}

wait_for_lane_drain() {
  local port="$1" deadline idle_samples=0
  deadline=$((SECONDS + DRAIN_TIMEOUT_SEC))
  while (( SECONDS <= deadline )); do
    if has_active_connections "$port"; then
      idle_samples=0
    else
      idle_samples=$((idle_samples + 1))
      if (( idle_samples >= 2 )); then
        return 0
      fi
    fi
    sleep 1
  done
  echo "error: timed out waiting for active connections to drain on port $port; refusing restart" >&2
  return 1
}

if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: required runtime $NODE_BIN is missing" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  echo "error: CacheLane requires Node >=22; $NODE_BIN reports $("$NODE_BIN" --version)" >&2
  exit 1
fi

echo "Building CacheLane with $("$NODE_BIN" --version) from $REPO_ROOT"
(cd "$REPO_ROOT" && PATH="$RUNTIME_NODE_DIR:$PATH" npm ci && npm run build)
if [[ ! -f "$REPO_ROOT/dist/cli/index.cjs" ]]; then
  echo "error: build did not produce dist/cli/index.cjs" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cachelane-runtime.XXXXXX")"
mkdir -p "$STAGE/dist" "$STAGE/scripts"
rsync -a "$REPO_ROOT/dist/" "$STAGE/dist/"
rsync -a "$REPO_ROOT/scripts/" "$STAGE/scripts/"
cp -a "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && PATH="$RUNTIME_NODE_DIR:$PATH" npm ci --omit=dev)
(cd "$STAGE" && "$NODE_BIN" --input-type=commonjs -e \
  'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close();')
git -C "$REPO_ROOT" rev-parse HEAD > "$STAGE/GIT_SHA"
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAGE/INSTALLED_AT"

if [[ "${CACHELANE_DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  echo "dry run passed: build, production dependency install, and native SQLite smoke"
  echo "production was not changed"
  exit 0
fi

# The legacy timer can restart a busy lane after one slow upstream probe. Stop
# it before mutating runtime files; successful deployment re-enables it after
# both lanes load the local /healthz implementation. A failed deploy leaves it
# stopped rather than reintroducing connection-killing false positives.
sudo systemctl stop cachelane-healthcheck.timer 2>/dev/null || true

BACKUP="${INSTALL}.backup-$(date -u +%Y%m%dT%H%M%SZ)"
if sudo test -d "$INSTALL"; then
  echo "Backing up current runtime to $BACKUP"
  sudo cp -a --reflink=auto "$INSTALL" "$BACKUP"
fi

echo "Installing staged runtime to $INSTALL"
sudo mkdir -p "$INSTALL"
sudo rsync -a --delete "$STAGE/" "$INSTALL/"

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

# Healthcheck (idempotent; canonical source is independently tested)
sudo install -m 0755 "$REPO_ROOT/scripts/cachelane-healthcheck.sh" /usr/local/sbin/cachelane-healthcheck

sudo tee "$UNIT_DIR/cachelane-healthcheck.service" >/dev/null <<'UNIT'
[Unit]
Description=CacheLane dual-proxy healthcheck (restart on failure)
After=cachelane-litellm.service cachelane-claude.service
[Service]
Type=oneshot
RuntimeDirectory=cachelane-healthcheck
RuntimeDirectoryPreserve=yes
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
sudo systemctl enable cachelane-litellm.service cachelane-claude.service cachelane-healthcheck.timer
# No-op on upgrades; ensures both lanes exist before the dual health gate on a first install.
sudo systemctl start cachelane-litellm.service cachelane-claude.service

# Restart the independently idle native-Anthropic lane first. A busy LiteLLM
# lane must not prevent Claude from receiving the installed build.
echo "Waiting for Claude lane connections to drain"
wait_for_lane_drain 7333 || exit 1
echo "Restarting Claude lane"
sudo systemctl restart cachelane-claude.service
sleep 1
"$NODE_BIN" "$INSTALL/scripts/health-dual.mjs"

echo "Waiting for LiteLLM lane connections to drain"
if ! wait_for_lane_drain 7332; then
  echo >&2 "Claude lane is already on the installed build; LiteLLM remains on its prior process (split state)."
  exit 1
fi
echo "Restarting LiteLLM lane"
sudo systemctl restart cachelane-litellm.service
sleep 1
"$NODE_BIN" "$INSTALL/scripts/health-dual.mjs"

sudo systemctl start cachelane-healthcheck.timer
echo "installed $(cat "$INSTALL/GIT_SHA") at $(cat "$INSTALL/INSTALLED_AT")"
if [[ -n "$BACKUP" ]]; then
  echo "previous runtime preserved at $BACKUP"
fi
