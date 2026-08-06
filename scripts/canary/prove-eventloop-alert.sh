#!/usr/bin/env bash
# End-to-end fire proof for CacheLaneEventLoopBlocked -- the alert that is the
# direct signature of the July 31 incident.
#
# Proves the WHOLE chain, which is the point: the metric is emitted with the
# expected lane label, vmagent scrapes it, VictoriaMetrics stores it, vmalert
# evaluates the rule against it, and the alert reaches `firing`. Evaluating the
# PromQL against backfilled series would validate only the expression.
#
# Safety: a SCRATCH CACHELANE_HOME on a spare port. No production home, no live
# unit, no live config touched. The temporary scrape fragment is removed and
# vmagent restored by the EXIT trap on every path, including failure.
set -u

SCRATCH="${TMPDIR:-/tmp}/cachelane-stall-proof"
PORT=7443
LANE=stalltest
FRAG=/etc/vmagent/scrape.d/zz-stalltest-EPHEMERAL.yml
PRELOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stall-preload.js"
DEPLOY=/srv/cachelane
PROXY_PID=""

cleanup() {
  echo "--- cleanup ---"
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null && sleep 1
  kill -9 "$PROXY_PID" 2>/dev/null
  if sudo -n test -f "$FRAG"; then
    sudo -n rm -f "$FRAG"
    sudo -n systemctl restart vmagent
    echo "removed ephemeral scrape fragment; vmagent restarted"
  fi
  # Prove we left nothing behind AND that production monitoring is healthy --
  # the cleanup itself is a config change and must be verified, not assumed.
  echo "leftover fragment: $(sudo -n test -f "$FRAG" && echo PRESENT-BAD || echo absent-good)"
  echo "scratch proxy: $(ss -Htln | grep -c ":$PORT" || true) listener(s) on :$PORT"
  echo "prod scrape targets still configured: $(sudo -n ls /etc/vmagent/scrape.d/ | tr '\n' ' ')"
  for _ in $(seq 1 15); do
    sleep 2
    [[ "$(systemctl is-active vmagent)" == "active" ]] && break
  done
  echo "vmagent: $(systemctl is-active vmagent) restarts=$(systemctl show vmagent -p NRestarts --value)"
  echo "production cachelane lanes scraped: $(curl -s -m 5 localhost:8429/api/v1/targets 2>/dev/null \
    | python3 -c "
import sys,json
try: at=json.load(sys.stdin)['data']['activeTargets']
except Exception: print('QUERY-FAILED'); raise SystemExit
print(','.join(sorted(t['labels'].get('lane','?') for t in at if t['labels'].get('job')=='cachelane')) or 'NONE-BAD')" 2>/dev/null)"
}
trap cleanup EXIT

alert_state() {
  curl -s 'http://127.0.0.1:8880/vmalert/api/v1/rules' | python3 -c "
import sys,json
d=json.load(sys.stdin)
for g in d['data']['groups']:
    for r in g.get('rules',[]):
        if r.get('name')=='CacheLaneEventLoopBlocked':
            print(r.get('state','?'))
            raise SystemExit
print('missing')"
}

echo "=== 1. scratch instance ==="
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
python3 - "$SCRATCH" "$PORT" <<'PY'
import json, os, sys
scratch, port = sys.argv[1], int(sys.argv[2])
cfg = json.load(open(os.path.expanduser("~/.cachelane-litellm/config.json")))
cfg["proxy"]["port"] = port
json.dump(cfg, open(f"{scratch}/config.json", "w"), indent=1)
print(f"scratch config written, port {port}, features:",
      {k: v for k, v in cfg["features"].items()
       if k in ("k_pruner", "mutation_enabled", "elision_mode")})
PY

# Must run FROM $DEPLOY: the CLI resolves its build SHA relative to the working
# directory and exits if it cannot ("CacheLane build SHA unavailable from env,
# installed GIT_SHA, and git checkout"). The systemd units set
# WorkingDirectory=/srv/cachelane for the same reason.
(cd "$DEPLOY" && CACHELANE_HOME="$SCRATCH" STALL_MS=6000 STALL_AFTER_MS=45000 \
  exec /usr/bin/node --require "$PRELOAD" dist/cli/index.cjs proxy) \
  >"$SCRATCH/proxy.log" 2>&1 &
PROXY_PID=$!
echo "scratch proxy pid $PROXY_PID"

for _ in $(seq 1 40); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" || { echo "FAIL: scratch proxy never came up"; exit 1; }
echo " -- scratch /healthz OK"

echo "=== 2. ephemeral scrape target ==="
# job_name MUST be unique across every file in scrape.d. A first version of
# this script reused `job_name: cachelane` to match the alert's selector;
# vmagent rejects duplicate job names outright, so it crash-looped (13 restarts)
# and stopped scraping EVERYTHING on the host until the file was removed.
# Monitoring went down while the monitoring test ran.
#
# The fix keeps the job name unique and rewrites the `job` LABEL to cachelane
# via relabel_configs, which is what the alert rule actually selects on.
sudo -n tee "$FRAG" >/dev/null <<EOF
# EPHEMERAL -- created by prove-eventloop-alert.sh, removed by its EXIT trap.
# If you are reading this in a running system, the test died uncleanly: delete
# this file and restart vmagent.
- job_name: cachelane-stalltest-ephemeral
  scheme: http
  metrics_path: /metrics
  scrape_interval: 10s
  scrape_timeout: 5s
  static_configs:
    - targets: ['127.0.0.1:$PORT']
      labels:
        instance: epyc2
        service: cachelane
        lane: $LANE
        domain: llm
  relabel_configs:
    - target_label: job
      replacement: cachelane
EOF
sudo -n systemctl restart vmagent

echo "=== 2b. GATE: vmagent must be healthy and still scraping production ==="
# Never proceed past a config change without proving the service survived it.
ok=0
for _ in $(seq 1 20); do
  sleep 3
  [[ "$(systemctl is-active vmagent)" == "active" ]] || continue
  n=$(curl -s -m 5 localhost:8429/api/v1/targets 2>/dev/null \
      | python3 -c "
import sys,json
try: at=json.load(sys.stdin)['data']['activeTargets']
except Exception: print(0); raise SystemExit
print(sum(1 for t in at if t['labels'].get('job')=='cachelane'))" 2>/dev/null)
  # 2 production lanes + 1 scratch = 3
  [[ "${n:-0}" -ge 3 ]] && { ok=1; break; }
done
if (( ! ok )); then
  echo "FAIL: vmagent unhealthy or not scraping after the config change."
  echo "      active=$(systemctl is-active vmagent) restarts=$(systemctl show vmagent -p NRestarts --value)"
  journalctl -u vmagent -n 5 --no-pager -o cat 2>/dev/null | tail -3
  exit 1   # trap removes the fragment and restarts vmagent
fi

echo "=== 3. targets confirmed ==="
curl -s localhost:8429/api/v1/targets | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['activeTargets']:
    if t['labels'].get('job')=='cachelane':
        print(' ', t['labels'].get('lane'), t['health'], repr(t.get('lastError','')))"

echo "=== 4. baseline lag (should be tiny) ==="
curl -s "http://127.0.0.1:$PORT/metrics" | grep '^cachelane_event_loop_lag_seconds_max' | sed 's/^/ /'
echo " state before stall: $(alert_state)"

echo "=== 5. waiting for the synthetic stall to land ==="
for i in $(seq 1 60); do
  sleep 10
  v=$(curl -s -m 5 "http://127.0.0.1:$PORT/metrics" | awk '/^cachelane_event_loop_lag_seconds_max/{print $2}')
  s=$(alert_state)
  echo " t+$((i*10))s  lag_max=${v:-?}  alert=$s"
  [[ "$s" == "firing" ]] && { echo "PROOF: CacheLaneEventLoopBlocked FIRED with lag_max=${v}s"; exit 0; }
done

echo "FAIL: alert did not reach firing within 10 minutes"
exit 1
