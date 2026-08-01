# Detached CacheLane Database Maintenance Design

**Date:** 2026-08-01
**Status:** Approved design

## Problem

Database compaction was performed as a sequence of interactive shell commands. One command stopped both CacheLane services and `cachelane-healthcheck.timer`. The active agent session depended on one of those services, so stopping the lanes severed the API connection before a later command could restart them. Because the timer was also stopped, no independent recovery mechanism remained.

The live incident ended before VACUUM began. Both databases retained their pre-maintenance sizes and passed `PRAGMA quick_check` after the services were restored.

## Goal

Provide one supported command for CacheLane database compaction whose recovery path continues even if the initiating shell or CacheLane-backed API session disconnects.

## Non-goals

- Do not add compaction to every runtime deployment.
- Do not terminate unrelated Claude Code, Pi, or MCP processes merely because they hold a database file open.
- Do not change CacheLane request, pruning, cache, or storage semantics.
- Do not make `scripts/install-runtime.sh` responsible for routine database maintenance.

## Architecture

Add a dedicated maintenance script with two modes:

1. **Launcher mode** validates prerequisites and submits the worker as a detached transient systemd unit.
2. **Worker mode** owns the complete maintenance transaction. It is never run as an interactive sequence split across agent turns.

The transient unit runs independently of the launching session. Losing the launcher connection may hide its final output, but cannot cancel cleanup or prevent service recovery.

The privileged worker is installed at the fixed path `/usr/local/sbin/cachelane-compact-runtime-databases` as `root:root` mode `0755`. The unprivileged launcher uses fixed `/usr/bin/sudo` and `/usr/bin/systemd-run` paths, validates the worker and `/usr/local/sbin` ownership and permissions, and passes no caller-controlled executable, install path, service user, database path, or binary override across the privilege boundary.

## Maintenance flow

The worker performs these steps in order:

1. Require `cachelane-claude.service`, `cachelane-litellm.service`, and `cachelane-healthcheck.timer` to already be active. If a prerequisite is inactive, exit without mutating service state.
2. Install an unconditional exit trap that starts both lane services, runs `cachelane-healthcheck.service`, and starts `cachelane-healthcheck.timer`.
3. Stop `cachelane-healthcheck.timer` and any already-running `cachelane-healthcheck.service` so they cannot interfere with intentional lane maintenance.
4. Run read-only `PRAGMA quick_check` for both databases.
5. For the Claude lane:
   - stop only `cachelane-claude.service`;
   - compact its database as the lane service user;
   - run `PRAGMA quick_check` again;
   - start the service;
   - require systemd active state and HTTP `200` with `"status":"ok"` from port 7333.
6. Repeat the same sequence for `cachelane-litellm.service` and port 7332.
7. Start `cachelane-healthcheck.timer`.
8. Run `cachelane-healthcheck.service` once and require a successful result.
9. Disarm the recovery trap only after all recovery and health checks pass.

At most one lane is intentionally stopped at a time. The worker must never stop both lanes in one command.

## Failure handling

Any error, signal, failed compaction, failed integrity check, failed restart, or failed health gate exits through the same recovery trap. Because inactive prerequisites are rejected before mutation, the trap can safely restore the known active baseline by starting both services, invoking the one-shot healthcheck, and starting the timer. Recovery commands are best-effort individually so one failed start does not prevent attempts to restore the remaining units.

A failed maintenance unit remains a visible systemd failure with journal output. It must not report success merely because the recovery trap ran.

The worker refuses concurrent execution using a systemd unit name or equivalent single-owner guard. It validates database paths before stopping any service.

## Installation boundary

`scripts/install-runtime.sh` remains the canonical deployment path. It stages the unprivileged launcher under `/srv/cachelane/scripts/` and separately installs the privileged worker to `/usr/local/sbin/cachelane-compact-runtime-databases` as `root:root` mode `0755`. Production-facing systemd execution targets only that fixed root-owned worker and never `/srv/dev/**` or the service-user-writable `/srv/cachelane` tree.

## Testing

Add a shell integration harness executed by Vitest. The harness supplies fake `systemctl` and health probes, but its fake `runuser` executes the embedded Node program against real temporary SQLite databases loaded through the repository's `better-sqlite3`. Successful maintenance must reduce file size and freelist pages while leaving `PRAGMA quick_check` equal to `ok`.

Required cases:

1. The launcher submits a detached transient systemd unit rather than running the worker in the initiating process.
2. A successful worker compacts and verifies Claude before LiteLLM, restores each lane before proceeding, restarts the timer, and runs the final healthcheck.
3. A forced compaction failure exits non-zero and still attempts to start both lane services and the timer.
4. A forced health-gate failure exits non-zero and runs the same recovery path.
5. An inactive lane or timer prerequisite exits non-zero without any service mutation.
6. The launcher dry run contains only fixed privileged paths and no caller-controlled `--setenv` values.
7. No execution path contains a command that stops both lane services together.

The failure-path test is the regression test for the 2026-07-31 self-cutoff incident.

## Acceptance criteria

- The failure-path regression test is observed failing before implementation and passing afterward.
- Targeted maintenance tests pass.
- The full repository test suite, lint, and TypeScript checks pass.
- A dry-run or test-mode invocation proves the launcher creates the detached transaction without mutating live services or databases.
- Live CacheLane services remain active and both `/healthz` endpoints return HTTP 200 after deployment of the maintenance tooling.
