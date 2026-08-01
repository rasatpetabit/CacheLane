#!/usr/bin/env bash
set -euo pipefail

INSTALL="${CACHELANE_INSTALL:-/srv/cachelane}"
SYSTEMCTL_BIN="${CACHELANE_SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CACHELANE_CURL_BIN:-curl}"
RUNUSER_BIN="${CACHELANE_RUNUSER_BIN:-runuser}"
NODE_BIN="${CACHELANE_NODE_BIN:-/usr/bin/node}"
READY_TIMEOUT_SEC="${CACHELANE_READY_TIMEOUT_SEC:-30}"
CLAUDE_SERVICE=cachelane-claude.service
LITELLM_SERVICE=cachelane-litellm.service
TIMER=cachelane-healthcheck.timer
SERVICE_USER="${CACHELANE_SERVICE_USER:-}"
CLAUDE_DB="${CACHELANE_CLAUDE_DB:-}"
LITELLM_DB="${CACHELANE_LITELLM_DB:-}"

recover() {
  local status="$1"
  trap - EXIT INT TERM
  set +e
  "$SYSTEMCTL_BIN" start "$CLAUDE_SERVICE"
  "$SYSTEMCTL_BIN" start "$LITELLM_SERVICE"
  "$SYSTEMCTL_BIN" start "$TIMER"
  exit "$status"
}

run_db_action() {
  local db="$1" action="$2"
  "$RUNUSER_BIN" --user "$SERVICE_USER" -- /usr/bin/env \
    CACHELANE_DB_FILE="$db" \
    CACHELANE_DB_ACTION="$action" \
    CACHELANE_SQLITE_MODULE="$INSTALL/node_modules/better-sqlite3" \
    "$NODE_BIN" <<'NODE'
const Database = require(process.env.CACHELANE_SQLITE_MODULE);
const db = new Database(process.env.CACHELANE_DB_FILE, {
  readonly: process.env.CACHELANE_DB_ACTION === "quick_check",
  fileMustExist: true,
});
db.pragma("busy_timeout = 5000");
if (process.env.CACHELANE_DB_ACTION === "quick_check") {
  const rows = db.pragma("quick_check");
  if (rows.length !== 1 || rows[0].quick_check !== "ok") {
    throw new Error(`quick_check failed: ${JSON.stringify(rows)}`);
  }
} else if (process.env.CACHELANE_DB_ACTION === "vacuum") {
  db.exec("VACUUM");
} else {
  throw new Error(`unsupported database action: ${process.env.CACHELANE_DB_ACTION}`);
}
db.close();
NODE
}

wait_for_health() {
  local service="$1" port="$2" deadline body
  deadline=$((SECONDS + READY_TIMEOUT_SEC))
  while (( SECONDS <= deadline )); do
    body="$($CURL_BIN -fsS --max-time 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
    if "$SYSTEMCTL_BIN" is-active --quiet "$service" && [[ "$body" == *'"status":"ok"'* ]]; then
      return 0
    fi
    sleep 1
  done
  echo "error: $service failed its post-maintenance health gate" >&2
  return 1
}

maintain_lane() {
  local service="$1" port="$2" db="$3"
  echo "Compacting $service database"
  "$SYSTEMCTL_BIN" stop "$service"
  run_db_action "$db" quick_check
  run_db_action "$db" vacuum
  run_db_action "$db" quick_check
  "$SYSTEMCTL_BIN" start "$service"
  wait_for_health "$service" "$port"
}

run_worker() {
  local claude_user litellm_user home_dir
  [[ "${EUID:-$(id -u)}" -eq 0 || "${CACHELANE_MAINTENANCE_TESTING:-0}" == "1" ]] || {
    echo "error: --worker must run as root" >&2
    return 1
  }

  if [[ -z "$SERVICE_USER" ]]; then
    claude_user="$($SYSTEMCTL_BIN show -p User --value "$CLAUDE_SERVICE")"
    litellm_user="$($SYSTEMCTL_BIN show -p User --value "$LITELLM_SERVICE")"
    [[ -n "$claude_user" && "$claude_user" == "$litellm_user" ]] || {
      echo "error: lane service users differ or are empty" >&2
      return 1
    }
    SERVICE_USER="$claude_user"
  fi

  home_dir="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  [[ -n "$CLAUDE_DB" ]] || CLAUDE_DB="$home_dir/.cachelane-claude/cachelane.db"
  [[ -n "$LITELLM_DB" ]] || LITELLM_DB="$home_dir/.cachelane-litellm/cachelane.db"
  [[ -f "$CLAUDE_DB" && -f "$LITELLM_DB" ]] || {
    echo "error: expected CacheLane databases are missing" >&2
    return 1
  }
  [[ -f "$INSTALL/node_modules/better-sqlite3/package.json" ]] || {
    echo "error: installed better-sqlite3 is missing" >&2
    return 1
  }
  [[ -x "$NODE_BIN" ]] || {
    echo "error: required Node runtime is missing: $NODE_BIN" >&2
    return 1
  }

  trap 'recover $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  "$SYSTEMCTL_BIN" stop "$TIMER"
  run_db_action "$CLAUDE_DB" quick_check
  run_db_action "$LITELLM_DB" quick_check
  maintain_lane "$CLAUDE_SERVICE" 7333 "$CLAUDE_DB"
  maintain_lane "$LITELLM_SERVICE" 7332 "$LITELLM_DB"
  "$SYSTEMCTL_BIN" start "$TIMER"
  "$SYSTEMCTL_BIN" start cachelane-healthcheck.service

  trap - EXIT INT TERM
  echo "CacheLane database maintenance completed successfully"
}

case "${1:-}" in
  --worker) run_worker ;;
  *) echo "usage: $0 --worker" >&2; exit 2 ;;
esac
