# Spec v5 — closing out the hang remediation

**Status:** draft, pre-approval. **Date:** 2026-08-06.
**Supersedes:** `spec-hang-remediation-v4.md` (historical; §9's gate definitions are imported
here **by reference**, not restated).
**Companion:** `hang-remediation-implementation-notes.md` (C11–C19), `operations/routing-state.md`.

v4 is a 42 KB design document that its own implementation notes overtook in nine places. It
does not need revising — it needs closing out. This spec covers **only what is still open**.

---

## 0. What is already done (so this spec is not misread as re-opening it)

Both lanes are in the traffic path with elision and mutation off, behind installed alerting.
Per `operations/routing-state.md`:

- All three latches (`pruner.enabled`, `features.k_pruner`, `features.mutation_enabled`) are
  `false` on both homes, with `elision_mode: "stateless"` pinned so a future flip selects the
  audited arm rather than the legacy tokenizer path.
- v4 §8 steps 0–4 are landed and deployed; step 2(f), the observability last mile, landed
  2026-08-06.
- `CacheLaneEventLoopBlocked` and `CacheLaneHealthcheckStale` are proven to fire end to end
  (`scripts/canary/`). Five saturation/upstream rules remain unfired.
- The LiteLLM lane and the Claude lane both pass the promotion table except sample size.

**Open, and the subject of this spec:** Gate 5 (§2), the provenance defect found during
execution (§3), and the v4 §8 step 5 remainder (§4).

---

## 1. The one question Gate 5 answers

> **Does elision-with-mutation beat no-elision, price-weighted, on this lane?**

Not two questions. `mutation_enabled` is the **sole** variable; `pruner.enabled` and
`k_pruner` are the arm's *enabling latches* and stay `true` for the whole measurement on the
experiment lane. This is the M4 confound the v1 experiment fell into, where `pruner.enabled`
and `mutation_enabled` moved together and the result carried no information about either.

Reading a `k_pruner` decision out of this experiment is unsupported and forbidden. That is
coherent rather than a loose end: on the stateless arm, `k_pruner: false` and
`mutation_enabled: false` are behaviourally identical — both route through
`statelessElisionDisabled()` (`pre-request.ts:270`) and forward the client's body unchanged —
so the control arm **is** the elision-off state, and one comparison answers the whole question.

### 1.1 Arm table — all three latches, or the experiment measures nothing

| lane | `pruner.enabled` | `k_pruner` | `elision_mode` | `mutation_enabled` |
|---|---|---|---|---|
| control | **true** | **true** | `stateless` | `false` |
| treatment | **true** | **true** | `stateless` | `true` |

The safety posture of Stage 0 sets all three `false`. Running the experiment therefore requires
**deliberately reversing it** on the experiment lane. If only `k_pruner` and `mutation_enabled`
are turned on, `elisionDisabled()` (`pre-request.ts:259`) ORs `pruner.enabled === false` and the
arm stands down: the treatment lane becomes byte-identical to the control, Gate 5 returns "no
difference", and that null reads as *mutation does not pay* — retiring the feature on evidence
that was never collected.

### 1.2 Proof the arm actually ran, before any number is believed

`elision_mode` records **which arm was selected**; `elision_active` records **whether it did
anything** (C18). They must both be checked, because they fail differently:

- treatment turn with `elision_active: false` → latches still wrong, **no measurement is valid**;
- treatment turn with `elision_active: true` and no saving → a real negative result.

Averaging those two together is the specific error C18 exists to prevent. Per C15 the control
is still *recorded* as `stateless`, so it is not mislabelled as legacy.

### 1.3 Where these fields actually live (grounded, 2026-08-06)

They are **not columns**. An earlier draft of this spec assumed they were on `turns`; a
grounding probe falsified that. Ground truth:

- Arm fields live in **`turn_explanations.provenance_json`**, a JSON blob. Read them with
  `json_extract(e.provenance_json, '$.elision_active')` etc. Available keys, from a live row:
  `build_sha`, `config_hash`, `experiment_arm`, `elision_mode`, `elision_active`,
  `elided_bytes`, `route`, `marker_owner`, `outcome`.
- **`experiment_arm` already exists** and currently reads `passthrough` — the arm-labelling
  mechanism does not need to be built, only driven.
- **Token counts must come from `turns`, not `turn_explanations`.** The `usage_*` columns on
  `turn_explanations` are largely zero (327,924 against 59,098,629 logical tokens over the same
  rows). Any Gate 5 query therefore **joins**: `turn_explanations e JOIN turns t ON t.id = e.turn_id`,
  taking the arm from `e` and the tokens from `t`.

Confirmed live post-cutover: `arm=passthrough mode=stateless active=0 route=proxy`, and exactly
one distinct `config_hash` — consistent with §3's finding that it is start-time only.

### 1.4 BLOCKING: provenance covers only 65% of turns

Measured on 638 post-cutover turns: **416 have provenance, 222 do not — 65.2% coverage.**

The missingness is not random and not benign:

- All 222 unattributable turns have **`prefix_breakpoint_hash IS NULL`**; all 416 attributable
  ones have a hash. Provenance is written exactly when the breakpoint pipeline produced a hash.
- They are **not** noise: median `cache_read` 190,024 tokens and median output 794 tokens.
  They carry **~38.0M of the ~96.2M logical tokens** post-cutover — about **39% of cost volume**.
- It is not explained by route, provider, model family, or time window: same window, same
  provider, and `claude-opus-5` is missing provenance on 40% of its turns while
  `claude-sonnet-5` is missing on 0%.

**Why this blocks Gate 5.** Elision acts *on the breakpoint pipeline* — precisely the code path
that distinguishes attributable from unattributable turns. So the missingness is plausibly
correlated with the treatment itself. Analysing only attributable turns biases the estimate;
including the rest dilutes it with volume that cannot be assigned to an arm. Either way the
measured effect is not the causal effect, and the failure is silent: the query returns a
confident number.

**Required before the treatment arm is enabled — pick one and state which:**

1. **Emit provenance for every proxied turn**, including those that take the plain-forward path
   with no breakpoint hash. Preferred: it removes the problem rather than bounding it.
2. **Restrict the analysis population to breakpoint-pipeline turns**, declare that restriction
   in the pre-registration, and *demonstrate* that the excluded population's size and
   composition are unchanged between arms. If exclusion rate differs by arm, this option is
   void and option 1 is mandatory.

Until one is done, any Gate 5 number is uninterpretable. This was found by a grounding probe,
not by review — see §7.

---

## 2. Gate 5 — DESIGN REJECTED BY REVIEW; see §2.0 before reading further

> **§2.0 — Status of this section (2026-08-06, after cross-vendor review round 1).**
>
> The randomized design below received a **`rework`** verdict with three blocking findings, all
> of which triage as legitimate and are **accepted**:
>
> 1. **The estimator is blind to the treatment.** `Σcost / Σlogical` uses a denominator that
>    elision itself shrinks. If treatment scales every token category by *q*, both numerator and
>    denominator scale by *q* and the metric is unchanged while real spend falls by *q*. The
>    normalization was added for variance reduction and it divides away the effect being
>    measured.
> 2. **Clustering error.** Treatment is assigned per 1 h block but §2.2's power was bootstrapped
>    per turn. At 250–500 turns/block, n = 1 000/arm is **2–4 independent clusters per arm** —
>    the quoted CI does not hold, and deterministic alternation supplies no randomization.
> 3. **Post-treatment stratification.** §2.4 buckets on `turns.input_tokens`, which is
>    provider-reported usage measured *after* mutation. Conditioning on a treatment-affected
>    variable induces selection bias; the covariate must be a pre-mutation request size.
>
> **Fixing (2) exposes a feasibility wall.** Measured on live data, per-session cost has
> **CV = 4.88**, so a correct cluster-level test needs **1 525 sessions/arm to resolve a 50%
> effect** — ~3 050 sessions at ~35–40 sessions/day is **≈80 days**. A 20% effect needs
> ~9 500/arm, over a year. Shortening blocks to raise the cluster count collides with the
> ≥1 h washout that the native cache TTL forces.
>
> **Conclusion: no randomized field experiment can answer Gate 5 at this traffic volume.**
> Publishing an underpowered version would produce exactly the confident null that §1.1 exists
> to prevent. The ETA is stated here rather than discovered later, per the rule that every
> numeric gate carries its computed ETA.
>
> **Proposed replacement — shadow-mode counterfactual (§2.7).** Do not run arms at all.
> Compute, per turn, what elision *would* have removed and what it *would* have cost, while
> continuing to forward the unmutated body. Every turn then yields a **paired**
> (actual, counterfactual) observation on identical traffic, which eliminates between-session
> variance — the entire reason the randomized design is infeasible — and carries **zero
> production risk**, since nothing is mutated and no cache prefix is broken.
>
> The sections below are retained as the rejected design and the reasoning that produced it.
> They are **not** approved and must not be executed.

Everything in this section is fixed **before** the first measurement. Numbers come from 619
real post-cutover turns on the Claude lane (2026-08-06), not from estimates.

### 2.1 Metric and estimator

**Metric:** price-weighted input cost per logical input token.

```
cost   = input_tokens·1.00 + cache_read·0.10 + cache_write_5m·1.25 + cache_write_1h·2.00
logical = input_tokens + cache_read + cache_write_5m + cache_write_1h
metric  = Σcost / Σlogical          <- ratio of sums, NOT mean of per-turn ratios
```

Cache-**creation** tokens are included with their true multipliers (M15). Omitting them is what
made the v1 economics claim unsound: mutation's cost is paid almost entirely in re-creation
when a broken prefix forces the cache to be rebuilt, so a metric that ignores writes cannot see
the thing being measured.

**Why ratio-of-sums.** Measured on live data: per-turn cost has CV 1.37, and normalizing to
cost-per-token *raises* it to 1.43 — the distribution is bimodal (cache hit ≈ 0.10, miss ≈ 1.00),
so the variance lives in hit/miss, not in turn size. A mean-of-ratios estimator inherits that
bimodality; the ratio of sums does not. This was tested, not assumed — the normalization
hypothesis was falsified.

Observed point estimate on the control-equivalent traffic: **0.1455**.

### 2.2 Sample size — measured, with its ETA

Bootstrap over the live turns (1000 resamples, seeded):

| n per arm | 95% CI half-width | smallest effect it resolves |
|---|---|---|
| 200 | ±21.0% | ~29% |
| 500 | ±12.8% | ~18% |
| 1 000 | ±9.4% | ~13% |
| 2 000 | ±6.2% | ~9% |

**Decision: n = 1 000 per arm, powered to resolve a ~13% effect.**

**ETA, computed rather than assumed.** Observed throughput is ~2 500–3 000 turns/day on active
days (2026-08-04: 2 006; 2026-08-05: 2 974) and near zero on idle days. Blocked assignment with
≥1 h washout costs roughly half the duty cycle. So 2 000 measured turns ≈ 4 000 turns of
wall-clock ≈ **1.5–2 active days**.

n = 2 000/arm would resolve ~9% but costs ~3–4 active days. **This trade is the decision to
take at GATE B**, and it is stated here rather than buried because a gate whose ETA is not
computed is how the Stage 3 restoration got blocked for a fortnight behind an unreachable
≥500-request soak.

If the observed effect lands inside the CI, the honest outcome is **inconclusive**, not
"mutation loses". Pre-committing to that distinction is the point of pre-registration.

### 2.3 Assignment

- **Blocked, alternating** — not one long A followed by one long B. Sequential arms confound
  the treatment with time of day, task mix, and whichever repo is under work.
- **Block length 1 h** of active traffic (~250–500 turns at observed rates).
- **Washout ≥ 1 h between arm switches, discarded entirely.** The native prompt cache has a 1 h
  TTL: turning mutation on invalidates the standing prefix, so turns immediately after a switch
  carry a one-off re-creation cost belonging to neither arm. Charging it to the treatment arm
  would manufacture the very penalty the experiment is trying to measure.
- **Warm-up exclusion: first 20 turns of each block**, on top of washout, stated in advance.
- **Stopping rule:** stop at n = 1 000/arm. No peeking-and-extending — that inflates the false
  positive rate and is precisely how an ambiguous result gets talked into significance.

### 2.4 Comparison discipline

Compare **within class**: identical `turns.model`, bucketed by `turns.input_tokens` decile,
never pooled. Pooling lets a shift in task mix move the ratio on its own and be read as a proxy
effect. *(The +0.54 pp cache-hit reading recorded in `routing-state.md` is pooled and is
therefore explicitly "no evidence of harm", not a measured improvement — same discipline.)*

Baselines are per lane. The Claude lane's ~98% native cache-hit rate does **not** transfer to
LiteLLM, which serves a mixed model roster whose caching varies per backend.

### 2.5 Expected outcome, and why a negative is a success

A negative result on the Claude lane is *likely* and is a valid outcome. That lane gets a ~90%
discount on ~98% of its input tokens from native 1 h caching. Body mutation breaks prefix
stability; trading a ~90% discount for a token-count reduction is exactly what a price-weighted
metric exists to catch. M9 withdrew the earlier "economics falsify the feature" claim as
confounded, so this is genuinely undecided in both directions.

"Keep mutation off on Claude, possibly on for LiteLLM" is a **successful experiment**, not a
failed remediation.

### 2.6 Outcome → configuration

| outcome | resulting config on that lane |
|---|---|
| mutation wins beyond the CI | `pruner.enabled: true`, `k_pruner: true`, `elision_mode: stateless`, `mutation_enabled: true` |
| loses, or inconclusive | revert to the Stage 0 posture — all three latches **false**, `elision_mode: stateless` retained |

Tuning `k`, the Layer 3 `K_eff` band, or retiring the pruner outright (v4 §7 option C) are
**separate questions** needing their own comparisons. Out of scope.

Record the decision, the measured effect size, its CI, and the arm provenance in
`operations/routing-state.md`.

---

## 2.7 Shadow-mode counterfactual — the proposed replacement design

**Mechanism.** A fourth latch, `features.elision_shadow`. When set, the stateless arm runs its
transform, records what it *would* have elided, and then **discards the mutated body and
forwards the client's original**. Nothing reaches the provider differently; no prefix is broken.

**Per turn, record:** `shadow_elided_tokens` (removed by the transform),
`shadow_prefix_break_index` (earliest position the mutation would have disturbed), and the
per-block token counts at and after that index.

**The estimate is then arithmetic, not inference.** Both sides of the economic question are
computable from one turn's own recorded data:

- **Saving** = `shadow_elided_tokens` × (the rate that would have applied) — known exactly,
  because the transform is deterministic.
- **Cost** = tokens at/after `shadow_prefix_break_index` that were served as `cache_read` at
  0.10× but would have required re-creation at 1.25×/2.00× — known exactly from the recorded
  breakpoint hashes and usage.

Net = saving − cost, **per turn, paired**. There is no between-session variance to overcome
because both quantities come from the same turn, so the required sample is smaller by orders of
magnitude. A few thousand turns — roughly one active day — gives a tight interval.

**What it cannot capture, stated honestly.** Second-order effects where mutation changes model
behaviour and therefore the subsequent conversation. Shadow mode holds the trajectory fixed, so
it measures the direct price effect only. That is the dominant term and the one the question is
actually about, but the limitation must be declared rather than assumed away.

**Why it also dissolves the other two blockers.** No denominator is needed, so finding (1) does
not arise; and the comparison is within-turn, so there is no post-treatment stratification and
finding (3) does not arise. It also sidesteps §1.4's 65% provenance coverage as a *bias* problem
— coverage still limits which turns are measurable, but missingness can no longer differ by arm
because there are no arms.

**Cost:** one feature flag, one transform invocation on a path that already exists, and three
recorded fields. No production risk and no washout.

---

## 3. Provenance defect found during execution (new in v5)

`config_hash` is computed **once at startup** (`server.ts:571`) over the start-time config,
while feature values are read **per request** (`server.ts:797`). Provenance therefore records a
start-time hash alongside per-request feature values, so after any live config edit the hash
misdescribes the configuration that actually produced the turn.

Harmless while flags are static. **Actively misleading during a Gate 5 arm switch**, which is
exactly when provenance is load-bearing — the hash would be identical across both arms.

Verified live on 2026-08-06: across a config edit, `config_hash` stayed `003196b9…` while
`elision_mode` correctly moved `legacy` → `stateless`. An earlier plan draft asserted the hash
must change to prove adoption; trusting it would have read a correct adoption as a failure and
triggered a needless restart of both units.

**Required before Gate 5 runs:** either recompute the hash per request, or record a distinct
per-request `effective_config_hash` covering the feature values that actually applied. Without
it, arm attribution rests on `elision_mode`/`elision_active` alone, with no integrity check.

---

## 4. v4 §8 step 5 remainder

- **MCP servers read-only.** Currently blocked: `expand` still mutates (`is_stub = 0`), which
  any prefix-stable design forbids. Fix the mutation, then make the path read-only.
- **Offline maintenance per home**: `VACUUM` + `wal_checkpoint(TRUNCATE)` with MCP servers
  stopped. The Claude home's `cachelane.db` is 277 MB with a 4 MB WAL.

Neither is on the Gate 5 critical path; both should land before the treatment arm is enabled,
since `expand`'s mutation is itself a prefix-stability violation and would contaminate the
measurement.

---

## 5. Non-goals

- **Layer 5** (client mutates its own transcript) stays untouched.
- **No historical savings figure is admissible.** `blocks.token_count` was destroyed fleet-wide
  with no repairing migration, so any retrospective savings number is unsound regardless of how
  it is computed.
- **No change to the gateway's open-auth posture.** It is deliberate and test-enforced
  (`compile-litellm.mjs:703-709`); out of scope here.
- **The five unfired alert rules** (`InflightHigh`, `SheddingLoad`, `MemoryHigh`,
  `UpstreamErrors`, `AbortedRequests`) are not proven by this spec.

---

## 6. Gates for this spec

- **GATE B** — approve this design, including the n = 1 000 vs 2 000 trade in §2.2, *before*
  any arm is switched. Requires a cross-vendor adversarial review.
- **GATE C** — per-lane keep/kill decision from the measured result, per §2.6.

**Blocking preconditions for running Gate 5 at all**, in order:

1. §1.4 provenance coverage — resolve to option 1 or 2, stated explicitly.
2. §3 per-request config hash — or accept that arm attribution rests on
   `elision_mode`/`elision_active` with no integrity check, stated explicitly.
3. §4 `expand`'s `is_stub` mutation — it is itself a prefix-stability violation and would
   contaminate the measurement.

**Evidence standard:** v4 §9, imported by reference. Its core rule governs here — end-to-end
latency is not admissible as proxy-overhead evidence.

---

## 7. How this spec was checked, and what that says about review

This draft went through a **grounding pass** before any reviewer saw it: every claim about live
state was probed read-only and annotated with the observed value. That pass found three defects
in this spec's own first draft:

- `elision_mode` / `elision_active` are JSON fields in `turn_explanations.provenance_json`, not
  columns on `turns` (§1.3). Every query in the draft would have failed or, worse, returned
  empty.
- Token counts on `turn_explanations` are near-zero and unusable; the metric must join to
  `turns` (§1.3).
- Provenance covers only 65% of turns, with non-random missingness worth 39% of cost volume
  (§1.4). This one would not have failed loudly — it would have produced a confident,
  wrong number.

The precedent that motivated the pass: the v4-era plan received **five** adversarial review
rounds. Those rounds caught real logic defects — an inert experiment arm, an impossible
byte-equality gate, a header assertion no correct proxy could satisfy — but **none** of the
three defects that actually bit, all of which were claims about live state
(`config_hash` cannot change without a restart; the `vmagent` role does not sweep its
directory; blackbox cannot reach a loopback bind).

Reviewers reason over text and will approve a false premise stated fluently. So the intended
review budget for this spec is **≤3 adversarial rounds plus the grounding pass**, not five
rounds of text. Cross-vendor adversarial review is still required at GATE B — it is good at
exactly what the grounding pass is blind to: confounds, incentive errors, and unstated
assumptions in the experimental logic.
