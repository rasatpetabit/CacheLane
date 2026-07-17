# CacheLane Node 22+ Runtime Migration Plan

**Goal:** Replace the obsolete Node 20-only contract with a Node 22 minimum,
verify Node 24 LTS compatibility, and make deployment fail before production
mutation when the runtime or native SQLite binding is incompatible.

**Base:** `fix/report-integrity` rebased onto `d053b42`, so the plan includes
the latest hardened `cachelane-litellm` and `cachelane-claude` system-service
work as well as the report-statistics corrections.

## Scope

1. Align `.nvmrc`, package engines, TypeScript build output, `cachelane
   doctor`, contributor guidance, product docs, and design requirements on a
   Node 22 floor.
2. Upgrade `better-sqlite3` from 11.10 to 12.10 so the declared `>=22`
   package contract is valid on Node 24 LTS.
3. Run the main CI gate on Node 22 and Node 24; retain cross-platform doctor
   smoke tests at the minimum Node 22 runtime.
4. Stage build/runtime dependencies and run a native SQLite smoke test before
   mutating `/srv/cachelane`.
5. Back up the installed runtime, restart LiteLLM and Claude lanes
   sequentially, and health-check after each restart.

## Non-Goals

- Do not install or upgrade the host's `/usr/bin/node`.
- Do not deploy, restart production, rewrite system units, or mutate either
  CacheLane database during implementation verification.
- Do not change the SQLite schema or application data model.
- Do not rewrite historical implementation plans that accurately describe
  their original Node 20 environment.

## Acceptance Gates

- `package.json` requires Node >=22 and `better-sqlite3` ^12.10.0.
- `cachelane doctor` rejects Node 20/21 and accepts Node 22/24.
- Clean installs load `better-sqlite3` and execute an in-memory query on Node
  22 and Node 24.
- Full tests, lint, type-check, build, and recorded benchmark pass on Node 22.
- Full tests, type-check, and build pass from a clean Node 24 install.
- `bash -n scripts/install-runtime.sh` passes.
- `CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh` completes without
  touching `/srv/cachelane` or systemd.
- Active production units, listener ports, home paths, process Node binary,
  installed commit, and post-deploy rollback path are recorded separately.

## Rollback Design

Each deployment creates `/srv/cachelane.backup-<UTC timestamp>` before
replacement. If either lane fails its health gate, restore that directory to
`/srv/cachelane`, reload systemd, and restart
`cachelane-litellm.service` followed by `cachelane-claude.service`.

