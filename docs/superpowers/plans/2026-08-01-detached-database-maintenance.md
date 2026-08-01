# Detached CacheLane Database Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a supported database-compaction command whose systemd-owned worker restores both CacheLane lanes and the healthcheck timer even when the initiating API session disconnects or maintenance fails.

**Architecture:** `scripts/compact-runtime-databases.sh` has a launcher mode and a privileged `--worker` mode. The launcher submits the installed worker to a named transient systemd unit; the worker compacts one lane at a time and owns an unconditional recovery trap. Vitest drives the real shell script through injected fake executables so ordering and failure recovery are deterministic.

**Tech Stack:** Bash 5, systemd/systemd-run, Node.js 22, better-sqlite3, Vitest, TypeScript.

## Global Constraints

- Production-facing execution must use the installed `/srv/cachelane` copy, never `/srv/dev/**`.
- Never stop both lane services in one command or leave `cachelane-healthcheck.timer` stopped.
- Run database mutation as the lane service user, not root.
- Do not terminate unrelated Claude Code, Pi, or MCP processes.
- Add no npm dependencies.
- Preserve `scripts/install-runtime.sh` as the deployment path; it already stages all files under `scripts/`.
- Every failure must remain non-zero after best-effort recovery.

## File Structure

- Create `scripts/compact-runtime-databases.sh`: launcher, systemd worker, one-lane maintenance flow, SQLite checks, and recovery trap.
- Create `src/runtime/__tests__/compact-runtime-databases.test.ts`: isolated fake-command integration harness covering detached launch, ordering, and recovery.
- Modify `src/runtime/__tests__/install-runtime.test.ts`: assert the installer stages the maintenance script through its canonical `scripts/` copy and does not inline database maintenance.

---

### Task 1: Failure-safe one-lane-at-a-time worker

**Files:**
- Create: `src/runtime/__tests__/compact-runtime-databases.test.ts`
- Create: `scripts/compact-runtime-databases.sh`

**Interfaces:**
- Consumes: environment overrides `CACHELANE_SYSTEMCTL_BIN`, `CACHELANE_CURL_BIN`, `CACHELANE_RUNUSER_BIN`, `CACHELANE_NODE_BIN`, `CACHELANE_INSTALL`, `CACHELANE_SERVICE_USER`, `CACHELANE_LITELLM_DB`, and `CACHELANE_CLAUDE_DB`.
- Produces: `scripts/compact-runtime-databases.sh --worker`, exiting `0` only after both lanes and the final healthcheck pass; any failure exits non-zero after recovery attempts.

- [ ] **Step 1: Write the shell integration harness and failing recovery tests**

Create a temporary bin directory containing executable `systemctl`, `curl`, and `runuser` fakes. Each fake appends one line to `CACHELANE_TEST_LOG`. `systemctl is-active --quiet` succeeds; `systemctl show -p User --value` prints `ras`; `curl` prints `{"status":"ok","inflight":0}`. `runuser` exits with `42` when `CACHELANE_TEST_FAIL_ACTION` matches an argument such as `CACHELANE_DB_ACTION=vacuum`.

Use this test shape:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/compact-runtime-databases.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeHarness(failAction = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-maintenance-test-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  const install = path.join(root, "runtime");
  const log = path.join(root, "commands.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(install, "node_modules", "better-sqlite3"), { recursive: true });
  fs.writeFileSync(path.join(root, "claude.db"), "fixture");
  fs.writeFileSync(path.join(root, "litellm.db"), "fixture");

  const fake = `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$CACHELANE_TEST_LOG"
case "$name" in
  systemctl)
    [[ "$*" == *"show -p User --value"* ]] && { echo ras; exit 0; }
    exit 0 ;;
  curl) printf '%s\\n' '{"status":"ok","inflight":0}' ;;
  runuser)
    [[ -n "\${CACHELANE_TEST_FAIL_ACTION:-}" && "$*" == *"\${CACHELANE_TEST_FAIL_ACTION}"* ]] && exit 42
    exit 0 ;;
esac
`;
  const fakeTool = path.join(bin, "fake-tool");
  fs.writeFileSync(fakeTool, fake, { mode: 0o755 });
  for (const name of ["systemctl", "curl", "runuser"]) fs.symlinkSync(fakeTool, path.join(bin, name));

  return {
    root,
    log,
    env: {
      ...process.env,
      CACHELANE_MAINTENANCE_TESTING: "1",
      CACHELANE_TEST_LOG: log,
      CACHELANE_TEST_FAIL_ACTION: failAction,
      CACHELANE_SYSTEMCTL_BIN: path.join(bin, "systemctl"),
      CACHELANE_CURL_BIN: path.join(bin, "curl"),
      CACHELANE_RUNUSER_BIN: path.join(bin, "runuser"),
      CACHELANE_NODE_BIN: "/usr/bin/node",
      CACHELANE_INSTALL: install,
      CACHELANE_SERVICE_USER: "ras",
      CACHELANE_CLAUDE_DB: path.join(root, "claude.db"),
      CACHELANE_LITELLM_DB: path.join(root, "litellm.db"),
      CACHELANE_READY_TIMEOUT_SEC: "0",
    },
  };
}

function runWorker(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [script, "--worker"], { env, encoding: "utf8" });
}

describe("detached database maintenance worker", () => {
  it("restores both lanes and the timer when compaction fails", () => {
    const harness = makeHarness("CACHELANE_DB_ACTION=vacuum");
    const result = runWorker(harness.env);
    const log = fs.readFileSync(harness.log, "utf8");

    expect(result.status).not.toBe(0);
    expect(log).toContain("systemctl start cachelane-claude.service");
    expect(log).toContain("systemctl start cachelane-litellm.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.timer");
  });

  it("maintains one lane at a time and runs the final healthcheck", () => {
    const harness = makeHarness();
    const result = runWorker(harness.env);
    const log = fs.readFileSync(harness.log, "utf8");
    const lines = log.split("\n");
    const stopLines = lines.filter((line) => line.startsWith("systemctl stop"));

    expect(result.status).toBe(0);
    expect(stopLines).toContain("systemctl stop cachelane-claude.service");
    expect(stopLines).toContain("systemctl stop cachelane-litellm.service");
    expect(stopLines.every((line) => !(line.includes("cachelane-claude") && line.includes("cachelane-litellm")))).toBe(true);
    expect(lines.indexOf("systemctl start cachelane-claude.service")).toBeLessThan(lines.indexOf("systemctl stop cachelane-litellm.service"));
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
  });
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```bash
npm test -- src/runtime/__tests__/compact-runtime-databases.test.ts
```

Expected: FAIL because `scripts/compact-runtime-databases.sh` does not exist, so the worker returns non-zero and no recovery log exists.

- [ ] **Step 3: Implement the minimal worker**

Create `scripts/compact-runtime-databases.sh`, mark it executable with `chmod 0755 scripts/compact-runtime-databases.sh`, and use:

```bash
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
  if (rows.length !== 1 || rows[0].quick_check !== "ok") throw new Error(JSON.stringify(rows));
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
    if "$SYSTEMCTL_BIN" is-active --quiet "$service" && [[ "$body" == *'"status":"ok"'* ]]; then return 0; fi
    sleep 1
  done
  echo "error: $service failed its post-maintenance health gate" >&2
  return 1
}

maintain_lane() {
  local service="$1" port="$2" db="$3"
  "$SYSTEMCTL_BIN" stop "$service"
  run_db_action "$db" quick_check
  run_db_action "$db" vacuum
  run_db_action "$db" quick_check
  "$SYSTEMCTL_BIN" start "$service"
  wait_for_health "$service" "$port"
}

run_worker() {
  local claude_user litellm_user home_dir
  [[ "${EUID:-$(id -u)}" -eq 0 || "${CACHELANE_MAINTENANCE_TESTING:-0}" == 1 ]] || { echo "error: --worker must run as root" >&2; return 1; }
  if [[ -z "$SERVICE_USER" ]]; then
    claude_user="$($SYSTEMCTL_BIN show -p User --value "$CLAUDE_SERVICE")"
    litellm_user="$($SYSTEMCTL_BIN show -p User --value "$LITELLM_SERVICE")"
    [[ -n "$claude_user" && "$claude_user" == "$litellm_user" ]] || { echo "error: lane service users differ or are empty" >&2; return 1; }
    SERVICE_USER="$claude_user"
  fi
  home_dir="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  [[ -n "$CLAUDE_DB" ]] || CLAUDE_DB="$home_dir/.cachelane-claude/cachelane.db"
  [[ -n "$LITELLM_DB" ]] || LITELLM_DB="$home_dir/.cachelane-litellm/cachelane.db"
  [[ -f "$CLAUDE_DB" && -f "$LITELLM_DB" ]] || { echo "error: expected CacheLane databases are missing" >&2; return 1; }
  [[ -f "$INSTALL/node_modules/better-sqlite3/package.json" ]] || { echo "error: installed better-sqlite3 is missing" >&2; return 1; }

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
}

[[ "${1:-}" == "--worker" ]] && run_worker
```

Keep the default launcher branch unimplemented in this task so the next test can drive it.

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run:

```bash
npm test -- src/runtime/__tests__/compact-runtime-databases.test.ts
```

Expected: 2 tests pass. Confirm the forced VACUUM failure returns non-zero while all three recovery starts appear in the command log.

- [ ] **Step 5: Commit the worker and recovery test**

```bash
git add scripts/compact-runtime-databases.sh src/runtime/__tests__/compact-runtime-databases.test.ts
git commit -m "fix: make database maintenance recover lanes"
```

---

### Task 2: Detached systemd launcher and complete acceptance harness

**Files:**
- Modify: `scripts/compact-runtime-databases.sh`
- Modify: `src/runtime/__tests__/compact-runtime-databases.test.ts`
- Modify: `src/runtime/__tests__/install-runtime.test.ts`

**Interfaces:**
- Consumes: stable installed worker path `$CACHELANE_INSTALL/scripts/compact-runtime-databases.sh`.
- Produces: default launcher invocation that runs `sudo systemd-run --unit=cachelane-db-maintenance --collect --wait --property=Type=oneshot <installed-worker> --worker`.

- [ ] **Step 1: Add failing detached-launch and health-failure tests**

Extend the fake tool harness with `sudo` and `systemd-run` symlinks. `sudo` must execute its arguments in the harness; `systemd-run` logs and exits `0`. Copy the source script into `$install/scripts/compact-runtime-databases.sh` for the launcher test.

Add assertions:

```ts
it("submits the installed worker to a detached transient systemd unit", () => {
  const harness = makeHarness();
  const installedScript = path.join(harness.env.CACHELANE_INSTALL!, "scripts", "compact-runtime-databases.sh");
  fs.mkdirSync(path.dirname(installedScript), { recursive: true });
  fs.copyFileSync(script, installedScript);
  fs.chmodSync(installedScript, 0o755);

  const result = spawnSync("bash", [script], { env: harness.env, encoding: "utf8" });
  const log = fs.readFileSync(harness.log, "utf8");

  expect(result.status).toBe(0);
  expect(log).toContain("systemd-run --unit=cachelane-db-maintenance --collect --wait --property=Type=oneshot");
  expect(log).toContain(`${installedScript} --worker`);
});

it("returns non-zero and recovers every unit when a health gate fails", () => {
  const harness = makeHarness();
  harness.env.CACHELANE_HEALTH_FAIL = "1";
  const result = runWorker(harness.env);
  const log = fs.readFileSync(harness.log, "utf8");

  expect(result.status).not.toBe(0);
  expect(log).toContain("systemctl start cachelane-claude.service");
  expect(log).toContain("systemctl start cachelane-litellm.service");
  expect(log).toContain("systemctl start cachelane-healthcheck.timer");
});
```

Make fake `curl` exit `22` when `CACHELANE_HEALTH_FAIL=1`.

Add an installer boundary assertion:

```ts
it("stages maintenance scripts without inlining compaction into deployment", () => {
  expect(installer).toContain('rsync -a "$REPO_ROOT/scripts/" "$STAGE/scripts/"');
  expect(installer).not.toContain("VACUUM");
});
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run:

```bash
npm test -- src/runtime/__tests__/compact-runtime-databases.test.ts src/runtime/__tests__/install-runtime.test.ts
```

Expected: detached-launch test fails because the script currently exits without invoking systemd-run. The health-failure test also fails until the fake health behavior is connected to the worker gate.

- [ ] **Step 3: Implement the launcher with explicit injectable command paths**

Add defaults:

```bash
SUDO_BIN="${CACHELANE_SUDO_BIN:-sudo}"
SYSTEMD_RUN_BIN="${CACHELANE_SYSTEMD_RUN_BIN:-systemd-run}"
UNIT_NAME="${CACHELANE_MAINTENANCE_UNIT:-cachelane-db-maintenance}"
```

Add:

```bash
launch_worker() {
  local worker="$INSTALL/scripts/compact-runtime-databases.sh"
  [[ -x "$worker" ]] || {
    echo "error: installed maintenance worker is missing: $worker" >&2
    echo "deploy the current runtime with scripts/install-runtime.sh first" >&2
    return 1
  }
  "$SUDO_BIN" "$SYSTEMD_RUN_BIN" \
    --unit="$UNIT_NAME" \
    --collect \
    --wait \
    --property=Type=oneshot \
    "$worker" --worker
}

case "${1:-}" in
  --worker) run_worker ;;
  "") launch_worker ;;
  *) echo "usage: $0 [--worker]" >&2; exit 2 ;;
esac
```

Do not pass test command overrides through `systemd-run`; the privileged worker must use production defaults. The fake `sudo`/`systemd-run` only exercises launcher argument construction in the unprivileged test process.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
npm test -- src/runtime/__tests__/compact-runtime-databases.test.ts src/runtime/__tests__/install-runtime.test.ts
```

Expected: all maintenance and installer tests pass.

- [ ] **Step 5: Run shell static checks**

Run:

```bash
bash -n scripts/compact-runtime-databases.sh scripts/install-runtime.sh
```

Expected: exit `0` with no output.

- [ ] **Step 6: Commit detached launch behavior**

```bash
git add scripts/compact-runtime-databases.sh src/runtime/__tests__/compact-runtime-databases.test.ts src/runtime/__tests__/install-runtime.test.ts
git commit -m "feat: detach CacheLane database compaction"
```

---

### Task 3: Repository verification and production deployment

**Files:**
- No source changes expected.
- Installed artifact: `/srv/cachelane/scripts/compact-runtime-databases.sh`

**Interfaces:**
- Consumes: committed script and tests from Tasks 1-2.
- Produces: verified repository state and an installed maintenance command while both live CacheLane routes remain healthy.

- [ ] **Step 1: Run the repository verification suite**

Run from `/srv/dev/ai/cachelane`:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Expected: every command exits `0`; no test, lint, type, or build errors.

- [ ] **Step 2: Run the installer dry run**

```bash
CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh
```

Expected output includes `dry run passed` and `production was not changed`.

- [ ] **Step 3: Verify the live pre-deploy surface**

Run one agent-runnable probe that asserts:

```bash
systemctl is-active --quiet cachelane-litellm.service
systemctl is-active --quiet cachelane-claude.service
systemctl is-active --quiet cachelane-healthcheck.timer
curl -fsS http://127.0.0.1:7332/healthz | grep -F '"status":"ok"'
curl -fsS http://127.0.0.1:7333/healthz | grep -F '"status":"ok"'
```

Expected: all assertions exit `0`.

- [ ] **Step 4: Deploy through the canonical installer**

```bash
scripts/install-runtime.sh
```

Expected: build and native SQLite smoke pass, each lane drains and restarts separately, `health-dual.mjs` succeeds, and the timer starts.

- [ ] **Step 5: Verify the installed maintenance launcher without compacting live data**

Run:

```bash
test -x /srv/cachelane/scripts/compact-runtime-databases.sh
bash -n /srv/cachelane/scripts/compact-runtime-databases.sh
systemd-run --help | grep -F -- '--wait'
```

Expected: all commands exit `0`. Do not run live VACUUM as part of deployment verification.

- [ ] **Step 6: Verify the post-deploy live surface**

Re-run the five assertions from Step 3, then run:

```bash
sudo systemctl start cachelane-healthcheck.service
systemctl show cachelane-healthcheck.service --property=Result,ExecMainStatus
```

Expected: both endpoints return HTTP 200 with `"status":"ok"`; the one-shot reports `Result=success` and `ExecMainStatus=0`.

- [ ] **Step 7: Review the final diff**

Run the repository diff-review gate against the two implementation commits. Resolve every high-severity finding, rerun affected checks, and record the review receipt before declaring completion.
