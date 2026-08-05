# CacheLane Stats Telemetry Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct future Claude hook telemetry and CLI metric semantics, deploy the corrected runtime, and document—but do not execute—a safe historical database repair.

**Architecture:** Extract transcript parsing into a focused pure module, persist hook observations with correct usage provenance/tiering/timestamps and no false mutation flag, and adjust only human-readable labels while preserving stable JSON fields. A separate operations runbook describes exact-match historical repair with backup, preview, transaction, invariants, and rollback.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Commander CLI, tsup, Bash/systemd deployment via `scripts/install-runtime.sh`.

## Global Constraints

- Follow TDD: every production behavior change requires a regression test observed failing first.
- Preserve stable JSON names: `turns`, `cache_hit_ratio`, and `savings_ratio`.
- Do not modify `~/.cachelane-claude/cachelane.db`.
- Do not add dependencies or redesign the storage schema.
- Production runtime remains `/srv/cachelane/`; no production unit may point at `/srv/dev/**`.
- Provider cache reuse is observed telemetry, not a CacheLane-attributed outcome.
- Preserve fail-open behavior for malformed transcript lines and entries without usage.

---

### Task 1: Parse Claude transcript usage correctly

**Files:**
- Create: `src/cli/transcript-usage.ts`
- Create: `src/cli/__tests__/transcript-usage.test.ts`
- Modify: `src/cli/index.ts:169-215`

**Interfaces:**
- Produces: `TranscriptApiCall` with `id`, `model`, `input_tokens`, `output_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `cache_read_tokens`, and `created_at`.
- Produces: `parseTranscriptApiCalls(content: string, fallbackTimestampMs: number): TranscriptApiCall[]`.
- Consumes: JSONL transcript text and one deterministic fallback timestamp for invalid/missing event timestamps.

- [ ] **Step 1: Write failing parser tests**

Create `src/cli/__tests__/transcript-usage.test.ts` with transcript-shaped entries that assert:

```ts
const usage = {
  input_tokens: 2,
  output_tokens: 18,
  cache_creation_input_tokens: 4_000,
  cache_read_input_tokens: 40_000,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 4_000,
  },
};
```

The first test must expect `cache_creation_5m_tokens === 0`, `cache_creation_1h_tokens === 4_000`, and `created_at === Date.parse("2026-08-04T01:44:56.194Z")`. Add separate tests for numeric timestamps, legacy top-level cache-tier fields, malformed lines, missing usage, and an invalid timestamp using the supplied fallback.

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
npx vitest run src/cli/__tests__/transcript-usage.test.ts --reporter=basic
```

Expected: FAIL because `src/cli/transcript-usage.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal pure parser**

Create the module and move parsing out of `src/cli/index.ts`. Resolve nested fields before legacy top-level fields. Use `Date.parse()` for string timestamps and accept only finite results. Do not call `Date.now()` inside the parser.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run the same focused Vitest command. Expected: all parser tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/transcript-usage.ts src/cli/__tests__/transcript-usage.test.ts src/cli/index.ts
git commit -m "fix: parse Claude transcript usage tiers"
```

---

### Task 2: Persist hook observations with honest provenance and outcomes

**Files:**
- Modify: `src/cli/index.ts:218-286`
- Modify: `src/cli/__tests__/cli.test.ts`
- Modify: `src/storage/__tests__/measurement-dimensions.test.ts`

**Interfaces:**
- Consumes: `parseTranscriptApiCalls(content, fallbackTimestampMs)` from Task 1.
- Produces: hook rows with `signals = ["mode:hook", "usage:recorded"]`, `request_mutated = 0`, corrected tier columns, and parsed event time.
- Preserves: message-ID de-duplication through `db.getTurn(call.id)` and turn-number allocation.

- [ ] **Step 1: Write failing hook-ingestion integration test**

In `src/cli/__tests__/cli.test.ts`, invoke the hook event path with a temporary transcript containing one nested one-hour usage entry and an ISO timestamp. Open the temporary database and assert the stored row has:

```ts
expect(row?.cache_creation_5m_tokens).toBe(0);
expect(row?.cache_creation_1h_tokens).toBe(4_000);
expect(row?.created_at).toBe(Date.parse("2026-08-04T01:44:56.194Z"));
expect(row?.request_mutated).toBe(0);
expect(JSON.parse(row?.signals ?? "[]")).toEqual(["mode:hook", "usage:recorded"]);
```

Invoke the same hook payload twice and assert only one row exists for that message ID.

- [ ] **Step 2: Run hook-ingestion test and verify RED**

Run:

```bash
npx vitest run src/cli/__tests__/cli.test.ts --reporter=basic
```

Expected: FAIL on the old 5m tier, mutation flag, provenance signal, or timestamp behavior.

- [ ] **Step 3: Implement minimal persistence correction**

Pass one `const fallbackTimestampMs = Date.now()` into the parser per hook event. Store `request_mutated: 0` and `signals: JSON.stringify(["mode:hook", "usage:recorded"])`. Retain exact message-ID de-duplication.

- [ ] **Step 4: Add and run outcome regression**

In `src/storage/__tests__/measurement-dimensions.test.ts`, insert a hook row with the corrected signals and flag. Assert:

```ts
expect(stats.route_counts).toEqual({ proxy: 0, hook: 1, other: 0 });
expect(stats.usage_counts).toEqual({ recorded: 1, missing: 0, unknown: 0 });
expect(stats.outcome_counts).toEqual({ fail_open: 0, baseline: 0, mutated: 0, no_op: 1 });
```

Run:

```bash
npx vitest run src/cli/__tests__/cli.test.ts src/storage/__tests__/measurement-dimensions.test.ts --reporter=basic
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/__tests__/cli.test.ts src/storage/__tests__/measurement-dimensions.test.ts
git commit -m "fix: record honest hook telemetry outcomes"
```

---

### Task 3: Make human-readable stats labels non-causal

**Files:**
- Modify: `src/cli/format.ts:22-45,68-82`
- Modify: `src/cli/__tests__/format.test.ts`
- Modify: `README.md:297`

**Interfaces:**
- Consumes: unchanged `CachelaneStats` and `SessionSummaryRow` JSON contracts.
- Produces: human-readable labels `Usage events`, `Observed provider cache reuse ratio`, and `Estimated provider input-cost savings`.
- Preserves: JSON serialization and `Estimated compression tokens saved` wording/value.

- [ ] **Step 1: Change formatter expectations first**

Update `src/cli/__tests__/format.test.ts` to expect:

```text
Usage events: 10
Observed provider cache reuse ratio: 85.0%
Estimated provider input-cost savings: 72.0%
```

Assert that output still contains `Estimated compression tokens saved: 0` and does not contain the old standalone `Cache hit ratio:` or `Savings ratio:` labels. Update the sessions header expectation from `TURNS` to `EVENTS` and from `HIT` / `SAVINGS` to concise non-causal equivalents that fit the current table width.

- [ ] **Step 2: Run formatter tests and verify RED**

```bash
npx vitest run src/cli/__tests__/format.test.ts --reporter=basic
```

Expected: FAIL because production labels are unchanged.

- [ ] **Step 3: Implement minimal label changes**

Change only human-readable formatting and README command description. Do not rename storage/API fields or alter formulas.

- [ ] **Step 4: Run formatter and CLI tests and verify GREEN**

```bash
npx vitest run src/cli/__tests__/format.test.ts src/cli/__tests__/cli.test.ts --reporter=basic
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/format.ts src/cli/__tests__/format.test.ts README.md
git commit -m "fix: clarify provider cache stats labels"
```

---

### Task 4: Document a safe historical repair procedure

**Files:**
- Create: `docs/operations/cachelane-hook-stats-repair.md`
- Modify: `README.md`

**Interfaces:**
- Produces: an operator runbook with explicit preview, backup, stop/start, exact-match update, invariant, rollback, and live-verification stages.
- Does not produce: an executable backfill or any live database mutation.

- [ ] **Step 1: Write the runbook**

Document exact operator phases:

1. identify lane homes and affected Claude transcript roots;
2. stop `cachelane-claude.service` and any hook writers;
3. checkpoint WAL and copy DB, WAL, and SHM to a timestamped backup directory;
4. run a read-only preview matching `(session_id, message.id)` and report matched, unmatched, already-correct, and ambiguous counts;
5. require explicit human authorization before write mode;
6. transactionally update only exact matches;
7. assert unchanged row count/IDs/turn numbers, exclusive bucket sums, corrected tier totals, recorded usage, no-op outcomes, and timestamp ranges;
8. rollback on any mismatch;
9. restart services and verify the installed CLI;
10. restore the backup if post-start verification fails.

State prominently that this task did not execute the repair.

- [ ] **Step 2: Run deterministic documentation checks**

```bash
test -s docs/operations/cachelane-hook-stats-repair.md
rg -n "backup|preview|exact match|transaction|rollback|authorization|did not execute|GIT_SHA" docs/operations/cachelane-hook-stats-repair.md
```

Expected: file is non-empty and every required safeguard appears.

- [ ] **Step 3: Link the runbook from README**

Add a concise operations link without claiming historical data is repaired.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/cachelane-hook-stats-repair.md README.md
git commit -m "docs: add hook stats repair runbook"
```

---

### Task 5: Verify, review, deploy, and exercise the installed runtime

**Files:**
- No planned source changes; fixes arising from review must remain scoped to Tasks 1–4 files.
- Installed artifact: `/srv/cachelane/` via `scripts/install-runtime.sh`.

**Interfaces:**
- Consumes: repository at verified HEAD and canonical installer.
- Produces: installed runtime whose `GIT_SHA` equals repository HEAD and whose installed CLI demonstrates corrected labels and future hook ingestion on temporary data.

- [ ] **Step 1: Run full repository verification**

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Expected: every command exits `0`; test output has zero failures.

- [ ] **Step 2: Run a fresh adversarial code review**

Review the exact base-to-HEAD diff. Resolve only grounded material findings, rerun affected focused tests, and rerun Step 1 after any source change.

- [ ] **Step 3: Verify installer dry-run**

```bash
CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh
```

Expected: exit `0` with staging/install actions reported and no live mutation.

- [ ] **Step 4: Record live pre-deploy state**

```bash
systemctl is-active --quiet cachelane-claude.service
curl --fail --silent --show-error http://127.0.0.1:7333/health
```

Expected: service active and health endpoint returns an OK status payload.

- [ ] **Step 5: Deploy through the canonical installer**

```bash
scripts/install-runtime.sh
```

Expected: exit `0`; runtime remains installed under `/srv/cachelane/` and Claude lane restarts through the installer.

- [ ] **Step 6: Verify installed provenance and live service**

```bash
test "$(cat /srv/cachelane/GIT_SHA)" = "$(git rev-parse HEAD)"
systemctl is-active --quiet cachelane-claude.service
curl --fail --silent --show-error http://127.0.0.1:7333/health
```

Expected: all commands exit `0` and installed SHA equals repository HEAD.

- [ ] **Step 7: Exercise installed CLI on temporary telemetry**

Create a temporary `CACHELANE_HOME` and transcript fixture with nested one-hour usage and an ISO timestamp. Invoke the installed hook event entrypoint, then run:

```bash
CACHELANE_HOME="$TMP_HOME" /usr/bin/node /srv/cachelane/dist/cli/index.cjs stats --session-id fixture-session --db "$TMP_HOME/cachelane.db"
```

Expected output includes:

```text
Usage events: 1
Observed provider cache reuse ratio:
Estimated provider input-cost savings:
No-op turns: 1
Usage: recorded 1 / missing 0 / unknown 0
```

Read back the temporary SQLite row and assert `cache_creation_5m_tokens=0`, `cache_creation_1h_tokens=4000`, `request_mutated=0`, and the exact parsed timestamp. Delete only the temporary fixture directory afterward.

- [ ] **Step 8: Confirm historical DB remained untouched by this task**

Compare the pre-recorded live DB path, row count, and file checksum/mtime evidence captured before implementation with post-deploy state. Deployment may naturally append live telemetry; no bulk update or rewrite may have occurred. Report historical repair as `Not executed` and point to `docs/operations/cachelane-hook-stats-repair.md`.

- [ ] **Step 9: Commit any final verification-only documentation update**

If no source changes arose after Step 2, no commit is needed. Never commit generated `dist/` unless repository policy explicitly tracks it.
