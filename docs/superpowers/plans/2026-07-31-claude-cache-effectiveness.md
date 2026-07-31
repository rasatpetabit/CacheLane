# Claude CacheLane Effectiveness + Consistent Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude/Anthropic CacheLane path deliver growing conversation-prefix caching without net-regressing Claude Code alone, and report metrics that cannot be misread as “LiteLLM proves CacheLane works.”

**Architecture:** Keep classify → prune → marker-plan → mutate on the Anthropic path. Replace leading-SEMI middle placement with a **read-anchor / write-frontier** marker planner that operates on the **final provider-visible** request. Measurement comes first: normalized token fields, marker provenance (not causal “attribution”), and a 3-arm A/B (CC pass-through / current CacheLane / candidate). Do not change LiteLLM OpenAI adapters beyond measurement honesty.

**Tech Stack:** TypeScript (Node 22), better-sqlite3, existing `src/orchestrator/*`, `src/classifier/*`, `src/pruner/*`, `src/storage/data-access.ts`, `src/providers/*`, dual homes `~/.cachelane-claude` / `~/.cachelane-litellm`, vitest.

**Review status:** Adversarial review by `gpt-5.6-sol` (high) on 2026-07-31 → **REJECT** on v1. Full text: `docs/superpowers/plans/2026-07-31-claude-cache-effectiveness.adversarial-review-gpt56sol.md`. This document is **v2** and absorbs the required patch list (B1–B4, H1–H6). Implementation must not start until Phase 0 conformance probes land and open decisions below are closed.

**Evidence baseline (2026-07-31 epyc2 production DBs):**

| Metric | LiteLLM (:7332) | Claude (:7333) |
|---|---:|---:|
| Cache hit (headline) | 43.5% | 11.3% |
| Savings (headline) | 70.4% | 2.1% |
| Savings (Anthropic-style 0.1×, proxy only) | ~39% | ~10% |
| Avg `cache_read` | ~106k | ~20–24k (flat) |
| `middle_cached` rate | n/a (OpenAI path) | ~0.06% (4 turns) |
| Tokens reclaimed (stats) | 33.6M | **0** |
| Dominant signals | `provider:openai-chat` | `prefix_cached` + `mode:hook` |

**Non-goals:**

- Matching LiteLLM headline % 1:1.
- Implementing a full STABLE|SEMI|VOLATILE message reorderer in this plan (reorderer is not the default fallback; see Risk register).
- Changing dual-lane topology/ports except deploy of fixed binary to `/srv/cachelane`.
- Claiming causal “CacheLane caused these cache_read tokens” from aggregate provider usage alone.
- Retroactively rewriting historical SQLite rows (forward metrics only).

---

## Decisions locked before implementation (from adversarial review)

These are **not** deferred to implementers:

| ID | Decision | Locked value |
|---|---|---|
| D1 | Middle warming | **Read-anchor / write-frontier**, not `prev.middle_hash === middle_hash`. First eligible frontier **must be written** (explicit marker). Next request may **read** a prior anchor and **write** a new frontier when history grows. |
| D2 | Cache identity | Hash/compare the **final provider-visible cumulative prefix** at each emitted breakpoint (tools + system + messages through that block, TTLs, model). Not classifications alone. |
| D3 | Prune vs cache experiment | During Phase 1 A/B effectiveness runs: **disable pruning** (or pin stub content deterministically and place anchors **before** any mutable content). Production default prune policy decided only after A/B. |
| D4 | Volatile suffix | Content-block state machine by `tool_use_id`. Default write-frontier includes completed history **and may include** the current request’s immutable input when beneficial; read-anchor and write-frontier are **separate positions**. |
| D5 | Marker ownership | One **global marker planner** across tools → system → messages. Never emit illegal TTL order (no 1h after 5m). Prefer fail-preserve (pass client markers through) when a safe CacheLane plan cannot be proven. |
| D6 | Signal naming | Do **not** emit `middle_cached` merely because a marker was placed. Use `middle_marker_emitted`, `prefix_marker_emitted`, `markers:preserved_client`, `markers:fail_preserve`. Cache **effect** is measured from provider usage + controlled A/B, not from signal names. |
| D7 | Cross-lane metric | Normalize token fields per adapter first. Cross-lane column is a **token-reuse index** under explicit formula, **not** “USD savings.” Provider-native $ only with model-family price table. |
| D8 | A/B arms | **Mandatory:** (1) CC pass-through, (2) current/prefix-only CacheLane, (3) candidate planner. Isolate prefixes between arms (no shared warmed cache). |
| D9 | Route vs outcome | Store **route** (proxy/hook/…) and **outcome** (ok/fallback/…) as separate dimensions. Missing usage ≠ zero. |

---

## Diagnosis (locked)

1. **Claude middle breakpoint almost never engages** under leading-SEMI boundaries; live CC starts with VOLATILE user messages; only tools/system prefix (~24k) is cached.
2. **CacheLane strips Claude Code `cache_control` markers** and may net-regress CC-alone growing cache.
3. **LiteLLM headline wins** are mostly provider automatic cache + softer cost weights, not superior orchestration.
4. **Claude prune reclaim is invisible** (`tokens reclaimed: 0`) despite high `pruned_blocks_count`.
5. **Hook rows (~40%)** have missing/zero usage and dilute end-to-end totals if misread as independent failed cache turns.
6. **Hash-equality warming cannot grow a middle cache** (adversarial B1): a growing transcript changes the middle prefix every turn, so equality never holds for the intended design.

---

## Success criteria

### Effectiveness (Claude Anthropic path — measured by A/B, not marker rates)

Primary gates (candidate vs CC pass-through, isolated arms, N≥3 independent sessions of ≥20 turns each, same model):

- [ ] **Post-warmup (turns ≥ 5) cumulative effective input cost** under Anthropic field semantics (uncached + 0.1×read + 1.25×create_5m + 2.0×create_1h) for **candidate ≤ CC pass-through** within noise band (define ±5% relative or better with 95% CI if N allows).
- [ ] **Candidate ≤ current prefix-only CacheLane** on the same cost metric (proves the change is an improvement over production, not only vs CC).
- [ ] Median provider `cache_read_tokens` for turns ≥ 20 on candidate is **strictly greater** than tools+system-only plateau (~24k) on at least 2/3 of sessions, **or** conformance probe proves provider will not credit moving message breakpoints (then stop and redesign — do not ship marker theater).
- [ ] Fail-open / HTTP 400-from-marker rate does not increase vs current CacheLane beyond noise; zero new TTL-ordering rejections in soak.

Secondary (diagnostic, not sufficient alone):

- [ ] Rate of `middle_marker_emitted` on candidate proxy turns after turn ≥ 3 (informational).
- [ ] Prune reclaim accounting correct when prune is re-enabled post-A/B.

### Measurement honesty

- [ ] Per-request instrumentation (Task 0.1) records: build/config/arm, route, outcome, incoming marker topology, emitted marker topology+TTLs, cumulative prefix hashes at each BP, prune transforms, provider usage fields, `usage_missing` flag.
- [ ] `cachelane stats` reports:
  - end-to-end totals
  - stratified by route and by outcome (separate dimensions)
  - route share over time
  - missing-usage rate
  - token-reuse index (normalized) + provider_native cost when price table known
  - marker provenance counts (not causal attribution)
- [ ] README/runbook: LiteLLM headline cannot be read as CacheLane Claude-design success; document A/B commands.

### Verification gates

- [ ] `npm test`, `npm run lint`, `npx tsc --noEmit` green.
- [ ] Phase 0 provider-conformance probes pass or fail closed with documented provider limits.
- [ ] Post-deploy dual-lane snapshot to `~/.cachelane-ops/effectiveness.jsonl`.

---

## Phase 0 — Measurement + provider conformance (ship before any marker behavior change)

### Task 0.1: Per-request instrumentation + stats dimensions

**Files:**
- Modify: `src/storage/data-access.ts`, `src/storage/types.ts`
- Modify: `src/proxy/server.ts` / explanation write path
- Modify: `src/cli/index.ts`
- Modify: `scripts/stats-dual.mjs`
- Test: `src/storage/__tests__/stats-dimensions.test.ts` (new)

**Record per turn (forward-looking):**

```ts
{
  build_sha, config_hash, experiment_arm, // arm: passthrough | prefix_only | candidate | prod
  route,            // proxy | hook | other
  outcome,          // ok | fallback | error
  usage_missing,    // bool
  incoming_markers, // topology summary
  emitted_markers,  // positions + ttl + owner(cachelane|client|mixed)
  prefix_hash_at_bp, // array of cumulative provider-visible hashes
  middle_hash_at_bp,
  prune_transforms, // before/after token estimates, deterministic stub ids
  usage: { uncached_input, cache_read, create_5m, create_1h, output, raw_provider_fields }
}
```

Prefer signals + explanation JSON over a heavy migration when possible; if columns are required, add migration with defaults.

- [x] **Step 1: Failing tests** for route≠outcome, usage_missing, marker provenance fields.
- [x] **Step 2: Implement write path + `getStats` aggregates** (end-to-end + stratified + route share + missing-usage).
- [x] **Step 3: Normalize token fields in adapters** (Task 0.1b below) before computing any index.
- [x] **Step 4: Update `stats-dual.mjs`** compact human output with new fields.
- [x] **Step 5: Verify**

```bash
npm test -- stats-dimensions
CACHELANE_HOME=~/.cachelane-claude node dist/cli/index.cjs stats --scope all --json | jq .
```

### Task 0.1b: Token field normalization (both providers)

**Files:**
- Modify: Anthropic + OpenAI usage extraction in `src/proxy/server.ts` / providers
- Test: unit tests with fixture usage payloads for Anthropic and OpenAI-shaped responses

**Normalized logical fields:**

| Field | Anthropic | OpenAI-chat family |
|---|---|---|
| `uncached_input` | `input_tokens` (non-cache) | `prompt_tokens - cached_tokens` (clamp ≥0) |
| `cache_read` | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| `create_5m` / `create_1h` | from cache_creation | 0 / unavailable unless reported |
| `logical_input` | uncached + read + creates | `prompt_tokens` |

- [x] **Step 1: Fixture tests** prove no double-count of OpenAI cached tokens under token-reuse index.
- [x] **Step 2: Label metrics**
  - `token_reuse_index` = `cache_read / logical_input` (explicit formula in docs)
  - `anthropic_effective_input_units` only when create fields meaningful; for OpenAI mark `write_cost_unknown`
  - Never call OpenAI-weighted numbers “Anthropic savings”

### Task 0.2: Effectiveness snapshot harness

**Files:**
- Create: `scripts/effectiveness-snapshot.mjs`

Capture JSONL: timestamp, git sha, home, arm, end-to-end + stratified metrics, marker provenance, cache_read p50/p90 for turn≥20, prune reclaim, top signals, usage_missing rate.

- [x] **Step 1: Implement**
- [x] **Step 2: Store pre-fix baseline**

```bash
node scripts/effectiveness-snapshot.mjs --label pre-fix >> ~/.cachelane-ops/effectiveness.jsonl
```

### Task 0.3: Prune tokens_reclaimed audit

**Files:** pruner, explanation write, `getStats`

- [x] Trace one Claude turn with `pruned_blocks_count > 0` end-to-end.
- [x] Document root cause in plan progress notes: `blocks.token_count` is overwritten with stub size, so the original size survives only in `turn_explanations.prune_decisions_json`.
- [x] Pure accounting fixed in Phase 0: materialized decisions now persist `tokens_reclaimed`; stats sum those immutable decision records. If stubs not applied on Anthropic path → Phase 2 task (still after A/B design freeze).

### Task 0.4: Anthropic provider-conformance probes (blocker for Phase 1)

**Files:**
- Create: `scripts/anthropic-cache-conformance.mjs` (or `src/benchmark/cache-conformance.ts`)
- Docs: `docs/runbook-claude-effectiveness.md` (results table)

**Mandatory probes against real Anthropic (lab/OAuth; redact secrets):**

1. **Moving breakpoint within lookback** — write cache at depth A; next request move marker deeper; assert cache_read ≥ prior prefix.
2. **Moving beyond lookback / block limit** — document failure mode.
3. **Retained old anchor + new frontier** (two message markers if provider allows) vs single deeper marker only.
4. **Parallel tool_use / multi tool_result** in one user message.
5. **TTL combinations** — 5m prefix + 5m middle; 1h prefix + 5m middle; illegal 5m then 1h must 400 or be prevented by planner.
6. **Prune/stub between turns** — same marker depth after early tool_result → stub; measure cache invalidation.
7. **CC-shaped markers alone** — pass-through of Claude Code markers without CacheLane mutation (baseline growth curve).

- [x] **Step 1: Implement initial structured probe** (`scripts/anthropic-cache-conformance.mjs`)
- [x] **Step 2: Run retained-anchor/deeper-frontier probe** (2026-07-31, Haiku 4.5): write=20,305 creation; anchor read=20,305; deeper write=20,305 read + 22 creation; deeper read=20,327. HTTP 200 for all. Durable production-path result still required under `~/.cachelane-ops/` before deploy.
- [x] **Step 3: Complete remaining mandatory probes** (moving-within-lookback, block-limit enforcement, parallel tools, all TTL combinations, prune/stub invalidation, CC-shaped pass-through markers). All nine gates passed 2026-07-31; evidence `~/.cachelane-ops/conformance-2026-07-31-v2.json`.
- [x] **Step 4: Narrow algorithm gate** — passed only for retained old anchor + new frontier. This does *not* approve the single-moving-marker variant or production deployment.

### Task 0.5: Instrumentation soak

- [ ] Deploy **instrumentation-only** build (no marker behavior change) to `/srv/cachelane`.
- [ ] Soak ≥ few hours of real CC traffic; confirm topologies + usage fields populate; capture CC-pass-through baseline if arm switch exists, else measure via probe harness.

---

## Phase 1 — Marker planner (only after Phase 0 probes pass)

### Task 1.1: Global marker planner (read-anchor / write-frontier)

**Files:**
- Create: `src/orchestrator/marker-planner.ts`
- Modify: `src/orchestrator/request-mutator.ts` (consume plan; stop ad-hoc strip/place)
- Modify: `src/orchestrator/index.ts`, `breakpoint-placer.ts`, `region-boundaries.ts` (delegate or delete dead leading-SEMI middle path)
- Tests: `src/orchestrator/__tests__/marker-planner*.test.ts`

**Planner inputs:** original request (with client markers), final post-prune request bytes, prev session cache state (prior written anchors), keepalive TTL class for static prefix, provider limits from conformance.

**Planner outputs:**

```ts
{
  strategy: "cachelane_plan" | "fail_preserve_client" | "prefix_only",
  markers: Array<{ location: "tools"|"system"|"message", message_index?, content_index?, ttl: "5m"|"1h", role: "static_prefix"|"read_anchor"|"write_frontier" }>,
  cumulative_hashes: string[], // provider-visible prefix through each marker
  signals: string[], // middle_marker_emitted, markers:fail_preserve, ...
  mutated: boolean
}
```

**Rules (must unit-test):**

1. Global TTL order tools → system → messages; never 1h after 5m.
2. Respect provider max breakpoints (current bounded plan emits at most three: static_prefix + one retained read_anchor + one write_frontier). On each turn, drop older ancestors; retain only the immediately previous frontier whose provider-visible cumulative hash still matches.
3. First eligible frontier is **always written** when strategy is `cachelane_plan`.
4. If prune may mutate content earlier than frontier, either (a) A/B has prune off, or (b) place anchor before mutable zone, or (c) fail_preserve.
5. Fail_preserve returns client markers unchanged (modulo already-invalid ordering cleanup only if proven safe).

- [x] **Step 1: Failing tests** for D1–D5 cases (growing history, parallel tools, TTL illegal, stale boundary hashes, fail_preserve).
- [x] **Step 2: Implement planner + wire mutator behind `features.marker_strategy`**
- [x] **Step 3: Quarantine legacy hash-equality middle path to explicit `prefix_only` compatibility behavior**
- [x] **Step 4: Verify** `npm test -- marker-planner` && `npx tsc --noEmit`

### Task 1.2: Content-block tool-loop / frontier selection

**Files:**
- Create: `src/orchestrator/frontier.ts`
- Tests with fixtures: plain user text; user tool_result-only; mixed text+tool_result; parallel tools; unmatched tool ids; multi-iteration tool loop.

- [x] **Step 1: State machine keyed by tool_use_id**
- [x] **Step 2: Conservative fallback** — if uncertain, set write_frontier at last fully completed user/assistant exchange; never invent splits inside a tool pair
- [ ] **Step 3: Verify**

### Task 1.3: Integration — multi-turn growing history (local)

- [x] Simulate N turns with **growing** history; assert write_frontier advances and prior provider-visible boundary hashes validate before reuse.
- [x] Explicitly **do not** require middle_hash equality across growing turns.

### Task 1.4: Three-arm A/B harness

**Files:**
- Create: `scripts/claude-ab-cache-probe.mjs`
- Docs: `docs/runbook-claude-effectiveness.md`

**Arms (mandatory):**

| Arm | Behavior |
|---|---|
| `passthrough` | No CacheLane mutation; preserve a captured/synthetic **Claude Code-shaped** incoming marker topology (not marker-free traffic) |
| `prefix_only` | Current production behavior (or feature-flag equivalent) |
| `candidate` | New marker planner |

**Isolation:** unique cache-busting prefix per arm/session (e.g. distinct system salt / workspace id) so arms do not warm each other. Repeat ≥3 sessions per arm; fixed turn script.

**Metrics:** cumulative and post-warmup effective input units, cache writes, cache reads, errors, marker 400s, usage_missing.

**Gate:** candidate wins or ties passthrough and beats prefix_only on post-warmup effective cost; else **do not deploy candidate** (fail closed).

- [x] **Step 1: Implement corrected harness with distinct CC-shaped/pass-through, prefix-only, and planner topologies**
- [x] **Step 2: Run direct against Anthropic OAuth**
- [x] **Step 3: Record results and gate** — all five corrected gates passed; evidence `~/.cachelane-ops/claude-ab-2026-07-31-v4.json`.

---

## Phase 2 — Prune reclaim + production policy

### Task 2.1: Fix tokens_reclaimed accounting / behavior

After root cause from 0.3:

- [ ] Red test: prune replacing large tool_result increases `tokens_reclaimed` and reduces logical uncached input (or documented equivalent).
- [ ] Fix write path / aggregation.
- [ ] Only re-enable prune on candidate path when combined A/B still passes (prune can invalidate prefixes — re-run probe 6).

### Task 2.2: Production default policy

Choose one after A/B:

- A) Candidate planner + prune off for cached prefix zone  
- B) Candidate planner + deterministic stubs + anchors before mutable zone  
- C) Fail_preserve client markers + CacheLane prefix-only on tools/system  
- D) Stop (provider cannot support growing middle)

Document choice in short ADR under `designs/decisions/`.

### Task 2.3: Classifier / reorderer

**Not default.** Only if conformance shows need for content reordering (unlikely if frontier placement works). Any reorderer requires its own ADR and must preserve tool_use/tool_result adjacency.

---

## Phase 3 — Docs, deploy, soak

### Task 3.1: Docs

- [ ] `README.md` — correct LiteLLM vs Claude measurement story; link runbook.
- [ ] `docs/runbook-claude-effectiveness.md` — probes, A/B, stats fields, ops reading guide (end-to-end **and** stratified; do not “ignore hooks”).
- [ ] Note: causal attribution remains unknown without isolated experiments.

### Task 3.2: Deploy

- [ ] Build → `install-runtime.sh` → `/srv/cachelane` (not `/srv/dev`).
- [ ] Drain-restart `cachelane-claude` then `cachelane-litellm`.
- [ ] Snapshots: `pre-fix` (already), `post-instrumentation`, `post-candidate` (only if gated).

### Task 3.3: Exit review

- [ ] Diff-review implementation PR.
- [ ] Compare effectiveness JSONL + conformance results.
- [ ] Accept only if Success criteria met; no “document why fixture cannot” waiver for primary cost gate.

---

## Task ordering

```
Phase 0
  0.1 instrumentation + stats dims
  0.1b token normalization
  0.2 snapshot
  0.3 prune audit
  0.4 conformance probes  ──fail──► stop / redesign (often: preserve CC markers only)
  0.5 instrumentation soak
        │
        ▼
Phase 1 marker planner + frontier + 3-arm A/B ──fail gate──► no deploy
        │
        ▼
Phase 2 prune + production policy ADR
        │
        ▼
Phase 3 docs / deploy / soak / exit review
```

Worker split: A=0.1/0.1b/0.2, B=0.3/2.1, C=0.4 then 1.x (serialize planner).

---

## Risk register

| Risk | Mitigation |
|---|---|
| Moving BP does not reuse prior Anthropic cache | Conformance probe 1/3; fail closed before Phase 1 |
| Prune invalidates entire prefix | A/B with prune off; deterministic stubs; anchor before mutable zone |
| Hash-equality warming never writes growing middle | Removed (D1); read-anchor/write-frontier |
| Causal attribution theater | Provenance + A/B only (D6/D7) |
| OpenAI double-count under anthropic formula | Normalization (0.1b) |
| TTL ordering 400s | Global planner (D5) + probe 5 |
| Arms warm each other | Isolation salts (D8) |
| Hook path hides regressions | Route×outcome dims; end-to-end always shown (D9) |
| Marker theater (signals up, cost flat) | Primary gate is effective cost, not marker rate |

---

## Implementation notes

- Node 22; green baseline before edits.
- Vocabulary: `STABLE | SEMI | VOLATILE` for classifier; planner uses `static_prefix | read_anchor | write_frontier`.
- snake_case for storage/API.
- Fail-open: planner errors → fail_preserve or unmutated request, never block the model.
- Production path `/srv/cachelane`.
- No secrets in logs/JSONL (redact Authorization).
- Surgical diffs; no OpenAI adapter redesign beyond normalization labels.

---

## Acceptance checklist

- [ ] Phase 0 instrumentation + normalization + snapshots + conformance results filed
- [ ] Phase 1 planner tests green; 3-arm A/B gate passed
- [ ] No deploy of candidate without gate pass
- [ ] Stats: end-to-end + stratified + provenance + token-reuse index
- [ ] Prune reclaim fixed or production policy documents prune off in cached zone
- [ ] Docs updated; adversarial REJECT items explicitly addressed (this v2)
- [ ] Exit review complete

---

## Appendix: Adversarial review summary (`gpt-5.6-sol` / high)

**Verdict on v1:** REJECT  

**Blockers absorbed:** B1 warming equality, B2 unstable prefix under prune, B3 unproven moving BP, B4 missing CC-alone arm.  
**Highs absorbed:** H1 causal attribution, H2 anthropic_v1 cross-provider, H3 global TTL planner, H4 tool-loop SM, H5 route/outcome split, H6 Phase 0 instrumentation depth.  

Full review: `./2026-07-31-claude-cache-effectiveness.adversarial-review-gpt56sol.md`
