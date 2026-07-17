# ADR-013: Require Node 22 and Verify Node 24 LTS

**Status:** Accepted  
**Date:** 2026-07-17  
**Supersedes:** The Node 20.10 runtime floor in REQ-NF-001 and the Node 20-only
development guidance

## Context

CacheLane still declared Node 20.10, built `node20` output, and pinned CI to
Node 20 even after production moved to Node 22. Node 20 is end-of-life. The
old pin existed because `better-sqlite3` 11.x did not provide a reliable Node
24 installation path.

The runtime contract had therefore drifted across five surfaces:

- production used `/usr/bin/node` 22;
- `.nvmrc`, package engines, tsup, and CI still targeted Node 20;
- `cachelane doctor` accepted Node 20.10;
- contributor and design documentation still required Node 20;
- the deployment script could retain an old native module after the package
  lock changed.

## Decision

1. Node 22 is the minimum supported runtime and the emitted build target.
2. CI runs the full test, type, lint, build, and recorded-benchmark gates on
   Node 22 and Node 24 LTS.
3. `better-sqlite3` moves to ^12.10.0, whose release line provides Node 22 and
   Node 24 prebuilt binaries. The database schema and application storage API
   remain unchanged.
4. `cachelane doctor` rejects Node majors below 22.
5. Runtime installation stages dependencies and loads an in-memory SQLite
   database before changing `/srv/cachelane`.
6. Production services continue to invoke the system runtime explicitly at
   `/usr/bin/node`; upgrading the host from Node 22 to Node 24 is a separate
   operational change.

## Alternatives Considered

| Alternative | Rejection reason |
|---|---|
| Keep Node 20 | Node 20 is end-of-life and no longer an acceptable production baseline. |
| Require only Node 22 and cap engines below 24 | Creates another short-lived single-major pin and leaves the next LTS migration unresolved. |
| Require Node 24 immediately | The current production host already runs Node 22; forcing a host-runtime change would unnecessarily increase this deployment's blast radius. |
| Declare `>=22` without updating `better-sqlite3` | The package contract would claim Node 24 support while retaining the native-binding failure that caused the old pin. |

## Consequences

**Positive**

- Repository, diagnostics, CI, build output, and production agree on the
  minimum runtime.
- Node 24 compatibility is continuously verified without requiring an
  immediate production runtime upgrade.
- Native-module mismatch is caught before either traffic lane restarts.

**Negative**

- `better-sqlite3` changes major version and must pass the full storage,
  migration, corruption-recovery, and live-database read-only rehearsal.
- CI duration increases because the main job runs on two Node LTS majors.
- Node 20 users must upgrade before installing the next CacheLane release.

## Verification

- Node 22: `npm ci`, full tests, lint, type-check, build, and recorded benchmark.
- Node 24: clean `npm ci`, full tests, type-check, and build.
- Native smoke: open, query, and close an in-memory `better-sqlite3` database.
- Deployment rehearsal:
  `CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh`.

