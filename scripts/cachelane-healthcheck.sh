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

# Probe latency is exported so the remediation spec's primary gate ("/healthz
# max < 250 ms at depth") has a data source. It cannot come from blackbox_exporter:
# CacheLane binds loopback only (127.0.0.1:7332/7333) by design, and blackbox runs
# on a different, pinned host, so it physically cannot reach these ports. It also
# must not come from cachelane_request_duration_seconds, which is end-to-end and
# therefore dominated by how long the model took to answer.
#
# This script already probes /healthz locally once a minute, so it is the natural
# prober. Results go to node_exporter's textfile collector, which vmagent already
# scrapes on this host.
declare -A PROBE_DURATION PROBE_SUCCESS

probe_local() {
  local port="$1" lane="${2:-}" start end rc
  start="${EPOCHREALTIME/,/.}"
  curl -fsS --max-time "$PROBE_TIMEOUT" \
    "http://127.0.0.1:${port}/healthz" >/dev/null
  rc=$?
  end="${EPOCHREALTIME/,/.}"
  if [[ -n "$lane" ]]; then
    PROBE_DURATION["$lane"]="$(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.6f", b-a}')"
    PROBE_SUCCESS["$lane"]=$(( rc == 0 ? 1 : 0 ))
  fi
  return "$rc"
}

# Written atomically: node_exporter reads this directory on every scrape, and a
# partially-written file is a parse error that drops the whole collector.
emit_textfile_metrics() {
  local dir="${CACHELANE_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
  local out="${dir}/cachelane_healthcheck.prom" tmp lane
  [[ -d "$dir" && -w "$dir" ]] || return 0
  tmp="$(mktemp "${out}.XXXXXX")" || return 0
  {
    echo "# HELP cachelane_healthz_probe_duration_seconds Duration of the local /healthz probe."
    echo "# TYPE cachelane_healthz_probe_duration_seconds gauge"
    for lane in "${!PROBE_DURATION[@]}"; do
      echo "cachelane_healthz_probe_duration_seconds{lane=\"${lane}\"} ${PROBE_DURATION[$lane]}"
    done
    echo "# HELP cachelane_healthz_probe_success Whether the last local /healthz probe succeeded."
    echo "# TYPE cachelane_healthz_probe_success gauge"
    for lane in "${!PROBE_SUCCESS[@]}"; do
      echo "cachelane_healthz_probe_success{lane=\"${lane}\"} ${PROBE_SUCCESS[$lane]}"
    done
    echo "# HELP cachelane_healthcheck_last_run_timestamp_seconds Unix time of the last healthcheck run."
    echo "# TYPE cachelane_healthcheck_last_run_timestamp_seconds gauge"
    echo "cachelane_healthcheck_last_run_timestamp_seconds $(date +%s)"
  } >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$out"
}

# Deliberately socket-based, unlike the installer's drain check. This runs only
# AFTER the local probe already failed, so the lane cannot be trusted to report
# its own in-flight count -- and a lane that is merely slow would answer
# "inflight: 0" and get severed, which is the false positive this guard exists
# to prevent. Sockets are the conservative signal here: never restart a lane
# that anything is still connected to.
has_active_connections() {
  local port="$1" connections
  connections="$(ss -Htn state established "( sport = :$port )" 2>/dev/null || true)"
  [[ -n "$connections" ]]
}

defer_for_active_connections() {
  local name="$1" port="$2" failures="$3"
  log_warn "$name local probe failed $failures consecutive times; restart deferred: active connections on port $port"
  # Roll the counter back to one below the threshold. Without this the count
  # accumulates for as long as clients stay connected, so the moment the last
  # session disconnects a restart fires on hours-old evidence -- observed live
  # at 23/3 on the litellm lane. Holding it at THRESHOLD-1 keeps the lane armed
  # but forces one FRESH failing probe against an idle lane before severing it.
  if (( failures >= FAILURE_THRESHOLD )); then
    write_failure_count "$name" "$(( FAILURE_THRESHOLD - 1 ))"
  fi
}

check_one() {
  local name="$1" port="$2"
  local failures lane
  # cachelane-litellm.service -> litellm; matches the `lane` label carried by
  # the vmagent scrape fragment and keyed on by every cachelane alert rule.
  lane="${name#cachelane-}"
  lane="${lane%.service}"
  PROBE_SUCCESS["$lane"]=0

  if ! systemctl is-active --quiet "$name"; then
    log_warn "$name inactive; starting"
    if systemctl start "$name"; then
      reset_failure_count "$name"
    else
      fail=$((fail + 1))
    fi
    return
  fi

  if probe_local "$port" "$lane"; then
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

emit_textfile_metrics

exit "$fail"
