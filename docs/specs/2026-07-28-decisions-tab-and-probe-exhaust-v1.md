# Spec v1 — Decisions tab "details missing" + health-probe exhaust

Status: **v2, pre-approval.** No code written against this yet.
Date: 2026-07-28. Repo: `/srv/dev/ai/cachelane` (branch `headroom-litellm-integration`).

> **v2 changes** — folded in a cross-vendor adversarial pass. That review ran
> **degraded** (`harness.degraded:true`, 1 reviewer, second reviewer errored), so
> per repo policy it is **advisory, not an approval**, and its `approve` verdict
> string must not be read as a clean bill. Its four findings are addressed below.
> All counts are now from a **single snapshot** (2026-07-28 ~22:30 UTC); the
> earlier draft mixed two snapshots of a live, growing DB, which is what produced
> the apparent 61-vs-72 arithmetic inconsistency it flagged.

## Summary

What was reported as one defect ("89% of `turn_explanations` are orphaned") is
**two unrelated defects welded together by a false causal claim**. Four
independent investigation lenses converged on this, and every load-bearing
claim below was re-verified directly against `~/.cachelane/cachelane.db`.

| # | Defect | Cause | User-visible effect |
|---|---|---|---|
| **D1** | Decisions tab shows `details missing` | Hook path writes `turns` and never writes an explanation | 778 of 2,515 turns (31%) render blank |
| **D2** | `turn_explanations` orphan pile | systemd healthcheck POSTs a fake inference request through the recording path every 60s | Cosmetic banner noise; counter/turn-number pollution |

**These populations are disjoint.** Deleting every orphan would not change one
pixel of the Decisions table.

## Verified evidence

Measured directly (not taken from agent reports):

- **D1.** `turns` with an explanation: **1,737**. Without: **778**. Of those 778,
  `signals = ["mode:hook"]` for **778 — 100%**. Every turn *with* an explanation
  is proxy-mode (`prefix_cached` 1,724, `error:fallback` 9, `prefix_cached+middle_cached` 4).
  Hook path writes `turns` at `src/cli/index.ts:256` and never calls
  `insertTurnExplanation`.
- **D2.** Single snapshot: orphans **13,244** total — `model='probe'` **13,172
  (99.46%)**, non-probe **72**. Separately verified: **0** probe rows join to a
  `turns` row, i.e. probes are 100% orphans. Source is `probe_claude()` in
  `scripts/install-runtime.sh:167`, POSTing
  `{"model":"probe",...}` with a deliberately invalid API key at
  `127.0.0.1:7333/v1/messages`, driven by `cachelane-healthcheck.timer`
  (`OnUnitActiveSec=60s`). Measured rate: **1,124 rows/day over 11.7 days**.
- **Ordering.** Explanation is written on the *request* leg
  (`proxy/server.ts:537`, `hooks/pre-request.ts:139`, fallback `server.ts:809`);
  the turn on the *response* leg (`server.ts:994`), gated by `if (!usage) return;`
  (`server.ts:972`). Not one transaction; both `try/catch`-swallowed. The probe
  never yields parseable usage, so it is orphaned by construction.
- **Live report path.** `render-html.ts:208` reads `data.completed_turns ?? data.turns`;
  `buildReportData:475` always populates `completed_turns` from `readCompletedTurns`,
  which is `FROM turns t LEFT JOIN turn_explanations e`. Orphans are therefore
  **not in the driving set** for the table. `readLegacyTurns` still feeds the
  coverage banner (`render-html.ts:98`), which is the only place orphans surface.

## Rejected options (and why)

These were each proposed by at least one lens and are rejected on measured evidence:

1. **Add `REFERENCES turns(id)` to `turn_explanations.turn_id`.** *Most dangerous
   "obvious" fix on the table.* Explanations are written before the turn exists, so
   the FK would reject **every** explanation insert on the happy path — and the write
   is inside a catch that only `console.error`s, so the Decisions tab would silently
   go fully blank. The asymmetry with `block_references.turn_id` (`001_initial.sql:49`)
   is explained by write order, not oversight.
2. **Relax the report join to the tuple.** Measured counterfactual: rescues
   **exactly 0 rows** — `tuple match BUT id mismatch = 0`. `turn_id` is perfectly
   redundant with the tuple here. Would ship as "the fix" and change nothing.
3. **`DELETE ... WHERE turn_id NOT IN (SELECT id FROM turns)`.** Destroys the ~72
   real-model orphans, which are the only evidence of a third, smaller bug
   (fail-open/error paths writing an explanation but no turn). Also does not
   reclaim meaningful space (see below) and regrows in ~9 days without the probe fix.
4. **"Prune the orphans to reclaim 26 MB."** **Measured and closed.** Probe rows are
   **1.14 MB of 27.85 MB (4.1%)**; real rows are 26.71 MB, dominated by
   `block_metadata_json` (`claude-opus-4-8`: 11.63 MB across 514 rows, ~23 KB/row).
   Size and orphanhood are unrelated. If size is the goal the target is block-metadata
   retention, not orphans — a separate piece of work, not in this spec.

## Proposed changes

**C1 — Stop the probe writing turn rows (fixes D2 at source).**
Point `probe_claude()` at a non-adapter route so it short-circuits at
`server.ts:427` to `forwardUpstream` with zero recording — exactly as
`probe_litellm()` already does (`install-runtime.sh:161`). The probe's assertion is
only `[[ -n "$code" && "$code" != "000" ]]`, so liveness semantics are unchanged.
*Deploy wrinkle:* the script is heredoc'd to `/usr/local/sbin/cachelane-healthcheck`;
editing the repo file alone changes nothing until the installer re-runs.

**C2 — Write an explanation on the hook path (fixes D1, the actual user-visible bug).**
*Review finding P1: the draft left the core decision unresolved. Resolved here.*
- **Canonical identity: `call.id`** (the transcript-derived Anthropic message id
  already passed to `insertTurn` at `src/cli/index.ts:256-257`). It is allocated
  before either write and is already the `turns.id` the report joins on.
  `fallbackTurnId` (`hooks/pre-request.ts:86-88`) is **not** adopted — it yields a
  non-UUID composite `${workspace}:${session}:${turn}` that would not match.
- **Ordering:** write `turns` first, then the explanation, in that order, so the
  hook path never creates the request-before-response inversion that makes an FK
  impossible on the proxy path.
- **Metadata source:** hook mode has no pipeline result, so `prune_decisions_json`
  and `region_metadata_json` must come from the same `handlePreRequest` output the
  proxy records. **If the hook path cannot produce that metadata, C2 is not
  implementable as stated and the design must change** — this is the single
  largest implementation risk and must be settled before coding.

**C3 — Reconcile the `INSERT OR IGNORE` / `UPSERT` asymmetry (latent).**
`turns` uses `INSERT OR IGNORE` (`data-access.ts:391`); explanations use
`ON CONFLICT(...) DO UPDATE SET turn_id = excluded.turn_id` (`:474`). On a tuple
collision `turns` keeps the first id and explanations adopt the last — a guaranteed
orphan generator. Measured divergence today: **0**, so latent, not active.
*Review finding P2: pick a policy, don't just "reconcile".*
- **Chosen policy: both statements keep the FIRST writer's identity.** Change the
  explanation upsert to `DO UPDATE SET ... ` **without** reassigning `turn_id`,
  matching `INSERT OR IGNORE`'s first-wins semantics on `turns`. Rationale: the
  `turns` row is the one the report drives from, so the explanation must not drift
  away from an id that already exists.
- **Acceptance test:** replay two requests onto the same
  `(workspace_id, session_id, turn_number)` and assert the resulting explanation's
  `turn_id` still matches the surviving `turns.id` — i.e. zero orphans created.

**C4 — Scoped hygiene delete.** *Review finding P1: `model` is user-controlled, so
`WHERE model='probe'` alone could delete a legitimate model named `probe`.*
Use the conjunction, which is provably safe today (0 probe rows join):
```sql
DELETE FROM turn_explanations
 WHERE model = 'probe'
   AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = turn_explanations.turn_id);
```
Count rows before and after and log the delta — never an implicit filter. Only
after C1, else it regrows. Preserves all 72 non-probe orphans.

## Sequencing

C1 → C2 → C4 → C3. C1 is zero-schema-risk and stops the bleeding. C2 is the only
change that alters what the user sees. C3 is hardening. C4 is hygiene and must
follow C1.

## Open items before implementation

- Re-measure the actual byte contribution of probe rows vs `block_metadata_json`
  before any size-motivated work (rejected option 4).
- Verify whether probe sessions inflated `turn_counters` for sessions that also
  carry real traffic (a small overlap was reported; unquantified here).
- Decide whether hook-mode turns should backfill explanations historically or only
  going forward. Backfill may be impossible — the metadata was never captured.

## Acceptance criteria

1. After C1, `SELECT count(*) FROM turn_explanations WHERE model='probe'` stops
   growing over a 1-hour window with the timer running.
2. After C2, a newly recorded hook-mode turn renders with a populated
   Region (S/M/V) column and non-`—` prune decisions in the Decisions tab,
   verified by rendering the HTML and inspecting it — not by structural checks.
3. No regression: full suite green, `tsc --noEmit` clean, lint clean.
4. `cachelane verify` still passes against a production-shaped fixture.
