# CacheLane Stats Telemetry Remediation Design

## Goal

Correct future Claude hook telemetry, make CLI metric semantics honest, deploy the corrected build, and document a safe historical repair procedure without modifying the live historical database.

## Verified defects

The investigation of session `d7f4b03d-c361-4d10-84c6-28ba68fefb62` established four hook-ingestion defects:

1. hook transcript observations are stored as `request_mutated=1` even though `hook-mutate` is a no-op;
2. nested one-hour cache-write tokens are stored as five-minute writes, understating weighted effective cost;
3. transcript-backed provider usage lacks `usage:recorded` and is classified as unknown;
4. ISO transcript timestamps are discarded in favor of hook execution time.

The review also established that zero compression-token savings is correct when compression and pruning events are absent. Provider cache reuse is not token removal and is not attributable to CacheLane without a counterfactual.

## Alternatives

### A. Surgical ingestion and presentation fix plus migration runbook — selected

Extract transcript usage parsing behind a small tested module, correct hook persistence fields, revise human-readable metric labels, preserve stable JSON field names, deploy, and write a transactional historical-repair runbook. This fixes the verified defects with minimal compatibility risk.

### B. Ingestion-only fix

Correct future rows but leave misleading `Turns`, `Cache hit ratio`, and `Savings ratio` labels. This has lower code scope but leaves the confirmed attribution defect visible to users, so it is insufficient.

### C. Metrics schema v2

Rename JSON fields, split provider observations from CacheLane outcomes, add event tables, and migrate consumers. This is architecturally cleaner but unnecessarily broad for the verified defects and risks breaking report and MCP consumers.

## Proposed design

### 1. Testable transcript parser

Move Claude transcript assistant-usage parsing from the large CLI module into a focused internal module under `src/cli/`. The parser will:

- de-duplicate by assistant message ID as today;
- read cache-write tier detail from `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` first;
- retain compatible top-level fallbacks for older transcript formats;
- parse numeric timestamps and ISO-8601 strings into epoch milliseconds;
- send invalid timestamps to a deterministic caller-supplied fallback rather than calling `Date.now()` inside the parser.

A transcript-shaped fixture will cover nested one-hour writes, zero five-minute writes, repeated message IDs, and ISO timestamps.

### 2. Honest hook persistence

Hook transcript ingestion will persist observed usage with:

- `signals: ["mode:hook", "usage:recorded"]`;
- `request_mutated: 0` because the current hook mutator is a no-op;
- corrected five-minute and one-hour columns;
- parsed transcript event time.

This makes exclusive outcomes classify these rows as `no_op`, while route remains `hook`. The deprecated `pipeline_fallback_turns` may rise because its legacy definition is `request_mutated=0`; its existing deprecation warning remains, and the exclusive outcome counts are authoritative.

### 3. Honest human-readable stats

Preserve stable JSON names (`turns`, `cache_hit_ratio`, `savings_ratio`) for compatibility, but revise CLI and session-table labels and explanatory copy:

- `Turns` becomes `Usage events`, because mixed scopes may contain hook and proxy provider usage records;
- `Cache hit ratio` becomes `Observed provider cache reuse ratio`;
- `Savings ratio` becomes `Estimated provider input-cost savings`;
- `Estimated compression tokens saved` remains unchanged because it correctly reports zero when no compression occurred;
- explanatory copy states that provider reuse economics are observed and are not attributed to CacheLane mutations.

The formatter receives no new inferred causality. CacheLane action outcomes remain the exclusive `mutated / baseline / no-op / fail-open` counters.

### 4. Historical migration plan, not execution

Create a runbook under `docs/operations/` covering a future explicit migration:

1. stop CacheLane writers;
2. checkpoint WAL and create a timestamped SQLite backup;
3. map historical hook rows to local Claude transcripts by `(session_id, message.id)`;
4. preview exact candidate counts and unmatched rows without writes;
5. transactionally update only exact matches: tier columns, weighted effective cost, `usage:recorded`, `request_mutated=0`, and parsed timestamp;
6. recompute and compare aggregate invariants;
7. commit only if all invariants pass; otherwise roll back and restore the backup;
8. restart and verify live CLI output.

Implementation will not modify `~/.cachelane-claude/cachelane.db` and will not claim historical data is repaired.

### 5. Deployment boundary

After tests, lint, typecheck, and build pass, use the repository's established installation and deployment path to update `/srv/cachelane/`. Verify the installed SHA, then exercise the installed CLI on a temporary fixture database and transcript so the installed artifact demonstrates corrected future ingestion and labels. Production services must not point at `/srv/dev/**`.

## Error handling

- Malformed JSONL lines remain fail-open and are skipped.
- Assistant entries without usage remain unrecorded.
- Invalid timestamps use one hook-event fallback timestamp supplied by the caller, preventing per-row timestamps from drifting during parsing.
- Missing nested cache-tier detail falls back to legacy top-level fields; total cache creation is never assigned to five-minute writes when explicit one-hour detail exists.
- Migration candidates without exact transcript matches remain untouched and are reported.

## Testing and acceptance

TDD regression tests must fail before production changes and then pass for:

1. nested one-hour cache writes stored in the one-hour column and weighted at 2.0x;
2. ISO timestamps stored as exact epoch milliseconds;
3. hook transcript usage classified `recorded` and pipeline outcome `no_op`;
4. CLI text distinguishing observed provider reuse and economics from CacheLane actions;
5. repeated transcript entries not duplicating database turns;
6. zero compression events continuing to report zero compression-token savings.

Verification commands are focused Vitest tests, full `npm test`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`. Deployment verification must inspect `/srv/cachelane/GIT_SHA` and run the installed CLI against a temporary fixture data path.

## Scope boundaries

In scope: future ingestion correctness, CLI wording, tests, deployment, and a historical repair runbook.

Out of scope: applying historical database mutations, redesigning the storage schema, changing stable JSON field names, attributing provider cache reuse to CacheLane, or changing provider billing models beyond the verified five-minute and one-hour tier correction.

## Adversarial review

The exact design received a fresh-context cross-vendor adversarial review at standard intensity. Verdict: approve, with zero blocking findings.