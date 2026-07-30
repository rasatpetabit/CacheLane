# CacheLane Restart Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one slow CacheLane health probe from restarting the proxy and guarantee automatic/runtime-deploy restarts are deferred while client connections are active.

**Architecture:** CacheLane exposes a local-only `/healthz` before adapters, storage, pruning, or upstream forwarding. A standalone shell healthchecker tracks per-lane consecutive failures in `/run/cachelane-healthcheck`, probes local liveness, and requires three failures plus two zero-connection checks before restart. The installer deploys that tested script and waits for an idle lane before intentional restarts.

**Tech Stack:** TypeScript/Node HTTP server, Bash, systemd, `ss`, Vitest.

## Global Constraints

- A successful local probe resets consecutive failure state.
- One or two misses never restart a lane.
- An inactive lane may be started immediately.
- Automatic and installer-driven restarts must not occur while established client connections exist.
- Upstream LiteLLM health must not be used as CacheLane process liveness.
- Preserve unrelated untracked `.serena/` state.

---

### Task 1: Local liveness endpoint

**Files:**
- Modify: `src/proxy/server.ts` near the top of `createProxyServer`'s request handler
- Test: `src/proxy/__tests__/server.test.ts`

**Interfaces:**
- Produces: `GET /healthz` → `200`, `content-type: application/json`, body `{"status":"ok"}`.
- Guarantees: no upstream request and no turn/explanation storage writes.

- [ ] **Step 1: Write the failing endpoint test**

Add a test that calls `getRequest(proxyPort, "/healthz")`, expects status 200 and parsed body `{ status: "ok" }`, asserts `capturedRequests` is empty, and verifies session stats remain at zero turns.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/proxy/__tests__/server.test.ts -t "serves local healthz"`

Expected: FAIL because `/healthz` is forwarded to the fake upstream instead of returning CacheLane health.

- [ ] **Step 3: Implement minimal local response**

Before `selectAdapter`, handle `GET /healthz` by writing a JSON 200 response and returning. Do not allocate a turn, load per-request config, touch SQLite, or call the upstream.

- [ ] **Step 4: Run focused and proxy tests**

Run:

```bash
npx vitest run src/proxy/__tests__/server.test.ts -t "serves local healthz"
npx vitest run src/proxy/__tests__/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/server.ts src/proxy/__tests__/server.test.ts
git commit -m "feat(proxy): add local liveness endpoint"
```

### Task 2: Stateful drain-safe healthchecker

**Files:**
- Create: `scripts/cachelane-healthcheck.sh`
- Create: `src/runtime/__tests__/healthcheck.test.ts`

**Interfaces:**
- Inputs: `CACHELANE_HEALTHCHECK_STATE_DIR`, `CACHELANE_HEALTHCHECK_FAILURE_THRESHOLD` (default `3`), `CACHELANE_HEALTHCHECK_PROBE_TIMEOUT` (default `10`).
- External commands: `systemctl`, `curl`, `ss`, `logger`.
- State: `<state-dir>/<service-name>.failures`, reset after success/restart.
- Produces: warnings for deferred failures; restart only at threshold and after two zero-connection checks.

- [ ] **Step 1: Write failing shell integration tests**

Create Vitest tests that build a temporary fake `PATH` with executable fake `systemctl`, `curl`, `ss`, and `logger` scripts and invoke `bash scripts/cachelane-healthcheck.sh`. Cover:

1. first and second failed probes write counts 1 and 2 but never invoke `restart`;
2. third failed probe with zero `ss` rows invokes exactly one restart;
3. third failed probe with an established `:7332` row invokes no restart and retains count 3;
4. after an active-client deferral, a successful probe clears the counter;
5. `:7333` follows the same policy;
6. inactive service invokes `start` without waiting for threshold.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/runtime/__tests__/healthcheck.test.ts`

Expected: FAIL because `scripts/cachelane-healthcheck.sh` does not exist.

- [ ] **Step 3: Implement the healthchecker**

Implement local `GET /healthz` probes, per-lane counters, and `has_active_connections(port)` using:

```bash
ss -Htn state established "( sport = :$port )"
```

After threshold, check active connections, sleep one second, and check again. If either check is non-empty, log `restart deferred: active connections` and retain threshold state. Treat a deferred probe miss as a handled health event; exit nonzero only when a required `start` or eligible `restart` command itself fails.

- [ ] **Step 4: Run tests and shell syntax check**

Run:

```bash
bash -n scripts/cachelane-healthcheck.sh
npx vitest run src/runtime/__tests__/healthcheck.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cachelane-healthcheck.sh src/runtime/__tests__/healthcheck.test.ts
git commit -m "fix(healthcheck): defer restarts until clients drain"
```

### Task 3: Installer wiring and drain-aware deployments

**Files:**
- Modify: `scripts/install-runtime.sh`
- Test: `src/runtime/__tests__/install-runtime.test.ts`
- Modify: `docs/runbook-litellm.md`

**Interfaces:**
- Installer copies `scripts/cachelane-healthcheck.sh` to `/usr/local/sbin/cachelane-healthcheck` mode 0755.
- Healthcheck unit declares `RuntimeDirectory=cachelane-healthcheck` and `RuntimeDirectoryPreserve=yes`.
- `wait_for_lane_drain(port, timeout)` returns success only after two consecutive zero-connection checks; timeout aborts deployment without restarting that lane.
- `CACHELANE_DRAIN_TIMEOUT_SEC` defaults to `300`.

- [ ] **Step 1: Write failing installer-source tests**

Add tests reading `scripts/install-runtime.sh` and asserting it copies the canonical healthcheck (no `<<'HEALTH'` heredoc), installs runtime-directory settings, calls `wait_for_lane_drain 7332` immediately before the LiteLLM restart and `wait_for_lane_drain 7333` before the Claude restart, and aborts on timeout rather than forcing a restart.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/runtime/__tests__/install-runtime.test.ts`

Expected: FAIL on the current heredoc and unconditional restart lines.

- [ ] **Step 3: Modify installer and runbook**

Replace the heredoc with `sudo install -m 0755 "$REPO_ROOT/scripts/cachelane-healthcheck.sh" /usr/local/sbin/cachelane-healthcheck`. Add the runtime-directory unit settings. Add `wait_for_lane_drain` using `ss`, two consecutive idle samples one second apart, and a bounded default timeout. Call it before each explicit lane restart. Document threshold, drain behavior, state path, and operator override.

- [ ] **Step 4: Run focused tests and dry-run deployment gate**

Run:

```bash
bash -n scripts/install-runtime.sh
npx vitest run src/runtime/__tests__/install-runtime.test.ts
CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh
```

Expected: PASS without changing production.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-runtime.sh src/runtime/__tests__/install-runtime.test.ts docs/runbook-litellm.md
git commit -m "fix(installer): drain CacheLane before lane restarts"
```

### Task 4: Full verification and live deployment

**Files:**
- Production install: `/srv/cachelane/`
- Live script: `/usr/local/sbin/cachelane-healthcheck`
- Live unit: `/etc/systemd/system/cachelane-healthcheck.service`

**Interfaces:**
- Consumes the tested artifacts from Tasks 1–3.
- Produces a running, drain-safe CacheLane deployment.

- [ ] **Step 1: Run repository verification**

Run:

```bash
npm test
npm run build
npm run lint
```

Expected: all pass.

- [ ] **Step 2: Install healthcheck protection without restarting proxies**

Install the tested healthcheck script and updated oneshot unit, run `systemctl daemon-reload`, and verify three simulated/fault-injected misses cannot restart while a test connection is established. Do not run the full installer until this guard is live.

- [ ] **Step 3: Deploy runtime through drain-aware installer**

Run: `scripts/install-runtime.sh`

Expected: it waits for each lane to have two idle samples before restarting. If the timeout expires, it aborts instead of interrupting sessions.

- [ ] **Step 4: Four-session streaming acceptance**

Launch four concurrent streaming requests through `:7332`, each long enough to span at least two timer ticks. Record the CacheLane PID before/during/after. Assert all four responses end with `data: [DONE]`, PID remains unchanged during active streams, timer logs contain no restart, and no new connection errors appear.

- [ ] **Step 5: Verify live health and commit any evidence documentation**

Run:

```bash
curl -fsS http://127.0.0.1:7332/healthz
curl -fsS http://127.0.0.1:7333/healthz
systemctl is-active cachelane-litellm cachelane-claude cachelane-healthcheck.timer
journalctl --since '-5 min' -u cachelane-litellm -u cachelane-healthcheck --no-pager
```

Expected: both health endpoints return `{"status":"ok"}`, units are active, and no restart occurred while streams were active.
