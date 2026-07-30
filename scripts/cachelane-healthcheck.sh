#!/usr/bin/env bash
set -uo pipefail

LOG_TAG=cachelane-healthcheck
STATE_DIR="${CACHELANE_HEALTHCHECK_STATE_DIR:-/run/cachelane-healthcheck}"
FAILURE_THRESHOLD="${CACHELANE_HEALTHCHECK_FAILURE_THRESHOLD:-3}"
PROBE_TIMEOUT="${CACHELANE_HEALTHCHECK_PROBE_TIMEOUT:-10}"
RECHECK_DELAY="${CACHELANE_HEALTHCHECK_RECHECK_DELAY:-1}"
fail=0

mkdir -p "$STATE_DIR"

log_warn() {
  logger -t "$LOG_TAG" "WARN $*"
}

failure_file() {
  printf '%s/%s.failures' "$STATE_DIR" "$1"
}

read_failure_count() {
  local file value
  file="$(failure_file "$1")"
  if [[ ! -f "$file" ]]; then
    printf '0'
    return
  fi
  value="$(cat "$file" 2>/dev/null || true)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf '0'
  fi
}

write_failure_count() {
  local file tmp
  file="$(failure_file "$1")"
  tmp="${file}.tmp.$$"
  printf '%s\n' "$2" >"$tmp"
  mv -f "$tmp" "$file"
}

reset_failure_count() {
  rm -f "$(failure_file "$1")"
}

probe_local() {
  local port="$1"
  curl -fsS --max-time "$PROBE_TIMEOUT" \
    "http://127.0.0.1:${port}/healthz" >/dev/null
}

has_active_connections() {
  local port="$1" connections
  connections="$(ss -Htn state established "( sport = :$port )" 2>/dev/null || true)"
  [[ -n "$connections" ]]
}

defer_for_active_connections() {
  local name="$1" port="$2" failures="$3"
  log_warn "$name local probe failed $failures consecutive times; restart deferred: active connections on port $port"
}

check_one() {
  local name="$1" port="$2"
  local failures

  if ! systemctl is-active --quiet "$name"; then
    log_warn "$name inactive; starting"
    if systemctl start "$name"; then
      reset_failure_count "$name"
    else
      fail=$((fail + 1))
    fi
    return
  fi

  if probe_local "$port"; then
    reset_failure_count "$name"
    return
  fi

  failures=$(( $(read_failure_count "$name") + 1 ))
  write_failure_count "$name" "$failures"

  if (( failures < FAILURE_THRESHOLD )); then
    log_warn "$name local probe failed ($failures/$FAILURE_THRESHOLD); restart deferred until threshold"
    return
  fi

  # The failed curl has closed before these checks, so only real clients remain.
  # Check twice to narrow the arrival race. Active streams always win: retain the
  # threshold state and retry on the next timer tick instead of severing them.
  if has_active_connections "$port"; then
    defer_for_active_connections "$name" "$port" "$failures"
    return
  fi
  sleep "$RECHECK_DELAY"
  if has_active_connections "$port"; then
    defer_for_active_connections "$name" "$port" "$failures"
    return
  fi

  log_warn "$name local probe failed $failures consecutive times with no active connections; restarting"
  if systemctl restart "$name"; then
    reset_failure_count "$name"
  else
    fail=$((fail + 1))
  fi
}

check_one cachelane-litellm.service 7332
check_one cachelane-claude.service 7333
exit "$fail"
