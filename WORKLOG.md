# WORKLOG — cachelane

Handoff log for collaborating agents (Codex, future Claude sessions). Terse
entries: scope, key decisions, and *why* — the diff shows *what*.

## 2026-07-28 — report integrity: lossless-mode violation + headless report hang

**Scope:** removed a stray worktree, fixed two defects behind "cachelane
reporting is broken". Commit `b1b0580`.

**Stray worktree.** `/srv/dev/ai/cachelane-report-integrity` was a *linked git
worktree* on branch `fix/report-integrity`, not a random directory — but placed
as a sibling of the repo instead of under `.worktrees/`, violating the
`/srv/dev/AGENTS.md` worktree-placement rule. Every other repo under `/srv/dev`
complies; cachelane was the sole outlier. The branch was byte-identical to
`headroom-litellm-integration` (76122d5) and fully merged, so the worktree was
removed with `git worktree remove`. The branch ref is kept — it costs nothing
and removing it is not needed to satisfy the rule.

**Defect 1 — shell compressor ignored lossless mode (the real integrity bug).**
`shellCompressor` declared `supportedModes: ["lossless","balanced","aggressive"]`
but `compressShell` always returned `lossiness: "lossy"`. The `json` and `log`
compressors both degrade gracefully in lossless mode; `shell` was the only one
that did not. With the live config (`compression.mode: "lossless"`, shell
profiles on, `retention.enabled: false`) this silently mangled
`git log` / `git status` / `git diff` tool output — 406 lossy events in the local
DB, every `retention_handle` NULL and `compression_originals` empty, so the
`refetch via cachelane_expand` stub had nothing to restore from. That breaks the
non-lossy invariant asserted in CLAUDE.md.

*Why the chosen fix:* shell profiles **summarise** rather than re-encode, so
their output can never be reconstructed — there is no lossless variant to fall
back to. Passing content through untouched in lossless mode mirrors the `log`
compressor's existing idiom, so the registry keeps one consistent rule.
Regression test reproduces the exact observed corruption (three commit lines
collapsing into `76122d5 8c8c629 … (?)`).

**Defect 2 — `cachelane report` hung forever on headless hosts.** `xdg-open`
blocks rather than failing when there is no `DISPLAY`/`WAYLAND_DISPLAY`, and
`execFile`'s callback kept the stdio pipes open so Node could not exit. Now
detects headless up front, spawns detached with ignored stdio, and prints what
actually happened instead of an unconditional "opening in browser...". Report
generation went from >120 s (hang) to ~0.9 s.

**Verified:** 609 tests passed / 2 skipped, `tsc --noEmit` clean, lint clean,
build clean, and `report` exercised end-to-end without `--no-open`.

**Deployed.** `scripts/install-runtime.sh` (dry run first, then real) installed
`47ed5a9` to `/srv/cachelane`; both units restarted and active. Prior slot kept
at `/srv/cachelane.backup-20260728T200303Z`. Live round-trip confirms the fix at
the surface where it is consumed: the same `git log -12 --pretty=format:...` that
previously came back as `76122d5 8c8c629 … (?)` now returns all 12 commits
byte-intact.

**DB prune.** Deleted 57,611 `passthrough` rows with `tokens_saved <= 0` from
`compression_events`, keeping all 861 real events (247 lossless + 614 lossy) as
an audit trail. `VACUUM` + `integrity_check` clean. Note the file barely shrank:
`compression_events` was never the space driver — `turn_explanations` (~26 MB
logical) dominates, and that is live reporting data the report reads, so it was
left alone. Post-prune `stats` and `report` both verified working (902 KB,
2052 turns, 19 sessions, self-contained HTML with no external refs).

**Not done / open:**
- The 614 already-corrupted lossy events are unrecoverable (no retained
  originals). They are kept deliberately as a record of what was affected.
- `retention.enabled` is still `false`. Nothing currently backs the
  "refetch via `cachelane_expand`" promise for lossy events. In lossless mode
  nothing new becomes lossy, so this is latent — but flipping the mode to
  `balanced`/`aggressive` without enabling retention would reintroduce
  unrecoverable loss.
- Worktree placement is governed only by prose in `/srv/dev/AGENTS.md`; there is
  no deterministic control that would have prevented the stray worktree.
  Explicitly deferred this pass.
- Growth of `turn_explanations` is unbounded; no retention policy on it yet.

## 2026-07-28 (cont.) — stub refetch handles were never expandable

Found only on a second pass, after being asked whether the earlier work was
actually complete. It had been visible in every tool result all session and was
walked past. Commit `fb29ca5`.

**The bug.** `formatStubText` emitted `block_id.slice(0, 8)`. Real block ids are
Anthropic tool_use_ids (`toolu_` + suffix), so that slice is always `"toolu_01"`
— which `expandStub`'s `/^[A-Za-z0-9]{8}$/` rejects for the underscore, and
which is non-discriminating regardless since every id shares it. **0 of 1,624
stubs** could ever be rehydrated through the handle they advertised. The
"refetchable stubs (non-lossy)" invariant in CLAUDE.md was broken for every stub
CacheLane has ever emitted.

**Why nothing caught it.** `cachelane verify` has a rehydrate gate that does
exactly this round-trip — but it used `blockId = "verifyaa"`, a bare
alphanumeric fixture chosen to satisfy the validator. Every unit test used the
same synthetic id space (`01KPRUNE…`). The gate passed by construction while
100% of production stubs failed. A verification whose fixture is shaped to fit
the validator instead of reality is worth less than no verification, because it
actively signals safety.

*Fix:* stub advertises the full block id (display tag stays truncated);
`expandStub` accepts >=8 chars over the real id charset, honoring the spec's
"8-char prefix **accepted**" as shorthand rather than a hard requirement;
`verify.ts` uses a `toolu_`-shaped fixture. Added a round-trip regression test
binding `formatStubText`'s advertised handle to `expandStub`'s acceptance.

*Verified:* 610 tests pass, tsc/lint clean, `cachelane verify` green, and 5/5
real stubs from the live DB expand successfully via the deployed build.

**Still open — the MCP servers are stale.** The four
`/srv/cachelane/dist/cli/index.cjs mcp` processes predate the deploy and still
answer with the old `invalid_block_id` message. They are Claude Code child
processes, so they need an MCP reconnect (`/mcp`) or a Claude Code restart to
pick up `fb29ca5`. Until then the tool surface still rejects valid handles.
Stubs already sitting in a live context also retain their old, unusable handles;
only newly-emitted stubs get the corrected format.

## 2026-07-28 (cont.) — Decisions tab is substantively empty: orphaned explanations

Found only by actually rendering the report and looking at it (headless Chrome
screenshot), after an earlier claim that structural checks — well-formed HTML,
SVG count, zero external refs — were sufficient. They were not: the page renders
cleanly while two of its three tabs carry no usable content.

- **Usage tab:** genuinely good. Metrics internally consistent (the per-profile
  table sums to exactly the 144,727 compression total; 235 git-log + 291
  git-status + 88 git-diff = the 614 lossy events found earlier).
- **Curve tab:** empty under the default `workspace` scope — by design, it
  declines to concatenate unrelated session timelines into a synthetic series.
  Defensible, but the default `cachelane report` ships a dead tab.
- **Decisions tab:** renders, but every row reads `details missing`, the
  Region (S/M/V) column is blank, and Prune decisions are all `—`.

**Root cause (measured, not inferred):** `13,217 of 14,803` (89.3%)
`turn_explanations` rows are orphaned — their `turn_id` matches no row in
`turns`. Only 1,586 join. The report is correct to ignore them; the write path
is producing explanation records whose turn ids never resolve.

This also corrects an earlier entry in this log: `turn_explanations` (~26 MB,
the DB's bulk) was described as "live reporting data the report reads, so it was
left alone." It is in fact ~89% orphaned rows the report discards. The DB bloat
and the broken Decisions tab are the same defect.

**Not fixed — deliberately.** This is a data-model/write-path bug outside the
scope that was being worked, and diagnosing where turn ids diverge (hook vs
proxy turn recording, session/workspace keying, or ordering between the turns
and turn_explanations writes) warrants its own investigation rather than a
guessed patch.

## 2026-07-28 (cont.) — investigation outcome: two disjoint defects, C2 blocked

Four independent lenses (2x Explore, 2x Plan) plus a cross-vendor adversarial
pass. Spec: `docs/specs/2026-07-28-decisions-tab-and-probe-exhaust-v1.md` (v2).
Every load-bearing agent claim was re-verified directly against the DB before
being acted on. Commits `f06d373` (C1+C3), `18737af` (number formatting).

**The framing in the entry above was wrong.** "89% orphaned" welded together two
disjoint populations:
- **D1** — the Decisions tab "details missing" is 778 turns, **100% `mode:hook`**.
- **D2** — the orphan pile is **99.5% `model='probe'`**, from the systemd
  healthcheck POSTing a fake inference request through the recording path.

Orphans are not in the report's driving set at all (`readCompletedTurns` is
`FROM turns LEFT JOIN turn_explanations`), so deleting every orphan would not
have changed one pixel of the Decisions tab. The two were never causally linked.

**Landed.** C1: `probe_claude` now GETs `/v1/models` — no adapter claims a GET, so
it short-circuits to `forwardUpstream` with zero recording. Verified live: 3
new-style probes wrote 0 rows; the old probe wrote 1 each. C3: the explanation
upsert no longer reassigns `turn_id`, matching `turns`' INSERT OR IGNORE
first-wins semantics; regression test added. C4: deleted 13,256 probe-orphans by
the conjunction `model='probe' AND NOT EXISTS(...)`, **preserving all 74
non-probe orphans** as diagnostic evidence.

**Rejected on measured evidence (do not revisit without new data):**
- *Adding `REFERENCES turns(id)`.* The most dangerous obvious fix. Explanations
  are written on the request leg, turns on the response leg, so the FK would
  reject every explanation insert on the happy path — inside a catch that only
  `console.error`s, blanking the Decisions tab entirely. The asymmetry with
  `block_references` is explained by write order, not oversight.
- *Relaxing the report join to the tuple.* Counterfactual measured: rescues
  **exactly 0 rows** (`tuple match BUT id mismatch = 0`).
- *"Prune orphans to reclaim 26 MB."* Probe rows were **1.14 MB of 27.85 MB
  (4.1%)**. The bulk is legitimate `block_metadata_json` on real rows
  (`claude-opus-4-8`: 11.63 MB / 514 rows). Size and orphanhood are unrelated.

**C2 (write explanations on the hook path) — BLOCKED, not implemented.**
`handleHookEvent` (`src/cli/index.ts:218`) reconstructs turns post-hoc from the
Claude Code transcript. It hardcodes `prefix_breakpoint_hash: null`,
`middle_breakpoint_hash: null`, `pruned_blocks_count: 0` because in hook mode the
proxy is bypassed and **the CacheLane pipeline never ran**. There are no prune
decisions or region classifications to record. Implementing C2 would fabricate
empty rows. "details missing" on hook turns is therefore *accurate reporting*.

**Hook/proxy coexistence — investigated; the initial "double-counting" read was
OVERSTATED and is retracted.** Hook and proxy turns do coexist in the same
sessions (this session: 221 hook + 308 proxy), recorded under different ids
(`call.id` vs `randomUUID()`). The first reading was that the `hook stop` handler
re-records the same logical turns, inflating headline metrics. **Measurement does
not support that.**

Pairing hook turns to proxy turns on identical `(input_tokens, output_tokens)`
within the same session:

| window | pairs |
|---|---|
| < 1s | 32 |
| 1–10s | 34 |
| 10–60s | 83 |
| > 60s | 289 |

Only the tight buckets are credible evidence of the same call recorded twice —
**~66 of 906 hook turns (~7%)**. The 289 pairs more than a minute apart are almost
certainly coincidental token-count collisions, and 468 hook turns have no twin at
all. So hook recording is **largely complementary, not duplicative** — plausibly
covering turns the proxy dropped at the `if (!usage) return;` gate
(`proxy/server.ts:972`), which is exactly the population that produces orphans.

What *is* still substantiated: all hook turns carry `request_mutated: 1`
(`cli/index.ts:275`) while having `pruned_blocks_count: 0` and a null breakpoint
hash. CacheLane did not mutate those requests, so counting them in the report's
"Mutated turns" tile overstates what the orchestrator actually did. That is a
narrow, well-evidenced defect and is the only part worth acting on without
further investigation.

**Lesson for the next reader:** the token-match heuristic is weak; do not treat a
same-token pair as a duplicate without a tight time bound. Suppressing hook
recording on the strength of the original reading would have deleted real
coverage.
