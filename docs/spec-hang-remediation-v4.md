# CacheLane hang remediation — spec v4

**Supersedes** v1–v3 (all kept as the record). Product of a 5-lens independent investigation
plus **three rounds** of rigorous cross-vendor adversarial review:

| round | verdict | findings |
|---|---|---|
| 1 (2 reviewers) | `rework` | 1 major + 3 minor |
| 2 (2 reviewers) | `rework` | 5 major + 1 minor |
| 3 (3 reviewers, 1 approve) | `rework` | 5 major |

**Status (updated 2026-08-06): SUPERSEDED — historical.** The line below was true when written
and is now false; it is kept rather than deleted so the revision history reads honestly.

> ~~**Status:** awaiting spec approval. No production code written. **Date:** 2026-07-31~~

Most of §8 was subsequently built and deployed. As of 2026-08-06, `/srv/cachelane` runs
`b7fc668` (= repo HEAD, `INSTALLED_AT` 2026-08-05T19:39:40Z), whose `dist/` carries the
`elision_mode` arm flag, the stateless `cachelane:elided` transform, and `safeFallbackConfig`.

| §8 step | state |
|---|---|
| 0 — config off both lanes | done (and hardened 2026-08-06: `elision_mode: "stateless"` added, `pruner.enabled` set false on the Claude home so both lanes carry all three latches off) |
| 1 — tokenizer one-encoder-per-process | done + deployed (`0711d26`) |
| 2(a) logger honours `CACHELANE_HOME` | done (`dc5925e`) |
| 2(b) test suite off the production home | done (`5f73095`) |
| 2(c) request spans / 2(d) `clientError` | done (`4433a22`) |
| 2(e) `/metrics` | done (`cb907ed`) — verified live; note `cachelane_proxy_overhead_seconds` was deliberately **not** built, see C12 |
| 2(f) vmagent scrape + vmalert rules | **written but NOT installed** — the files exist only at `deploy/observability/`; `/etc/vmagent/scrape.d/cachelane.yml` is absent and they were never landed in the Ansible source of truth |
| 3 — bounds | done + deployed (`948e9a7`) |
| 4 — Layer 1 + Layer 2 behind an arm | done + deployed (`e61102c`, `6cd4ae4`, `6793bb6`), config-gated **off** |
| 5 — DB hygiene | partial: `quick_check` landed (`b682739`); MCP read-only still blocked by `expand` mutating `is_stub`; `VACUUM`/`wal_checkpoint` deferred |

**Read `hang-remediation-implementation-notes.md` alongside this document** — it records C11–C19,
nine places where implementing this spec proved the spec wrong. Where the two disagree, the
implementation notes win. Remaining open work is scoped in `spec-hang-remediation-v5.md` rather
than by revising this document.
**Repo:** `/srv/dev/ai/cachelane` @ `main` = `3883ee7`

**All fourteen findings across all three rounds landed on the design and gate sections. No
reviewer in any round challenged the root cause (§1), its measurements, or M1 (§2).** The
remediation *design* needed four passes; the diagnosis has been stable since v1.

---

## 0. Revision history

**v2 changes (review round 1 + one finding it led me to):**

| # | Change | Source |
|---|---|---|
| **M1** | **The un-stubbing bug is load-bearing. Fixing it naively disables pruning entirely.** See §2 — it inverts v1's Step 4. | Found while checking reviewer #2's major finding |
| **M2** | **The convergence invariant `sum(prune_events) <= count(distinct blocks)` is retracted.** A *correct* pruner must re-elide every eligible block every turn. | Reviewer #2 (major) + M1 |
| **M3** | Multi-turn closed-loop test rewritten to feed the **original growing history** forward, not the forwarded body. | Reviewer #2 (major) |
| **M4** | The v1 mutation experiment was **confounded** — it disabled `pruner.enabled` *and* `mutation_enabled` together. | Reviewer #1 (minor) |
| **M5** | The primary gate contradicted itself ("needs no traffic" / "requires a real agentic session") and set no minimum depth. | Reviewer #1 (minor) |
| **M6** | The keep-alive gate wrongly treated normal idle expiry as failure. | Reviewer #2 (minor) |

**v3 changes (review round 2):**

| # | Change | Source |
|---|---|---|
| **M7** | **Layer 3 hysteresis contradicted the mandatory stateless transform** — remembering a threshold crossing *is* state, and applying elision only at the crossing makes content reappear next turn. Replaced with a deterministic bucket-derived cutoff. §6 Layer 3. | Reviewer #1 (major) |
| **M8** | **The content-hash escrow had no ownership or authorization model** — a bare `sha256(content)` key lets any caller retrieve another session's tool output. Now keyed and authorized per session. §6 Layer 4. | Reviewer #1 (major) |
| **M9** | **The "economics falsify the feature" claim was confounded** and is **retracted as a decision premise** — it compared two different lanes with different providers, workloads, `marker_strategy`, and prune volumes. §6, §7. | Reviewer #1 (major) |
| **M10** | **Gate 4 demanded advertised == effective keep-alive close**, which removes Node's deliberate `keepAliveTimeoutBuffer` safety margin and causes resets at the boundary. Now advertised **≤** effective, with explicit headroom. §9 Gate 4. | Reviewer #2 (major) |
| **M11** | **The keepAliveTimeout target was unmeasurable** (a mean and one threshold, no percentile). **Measured the real distribution** and set a derived target. §9 Gate 4. | Reviewer #2 (major) |
| **M12** | **Gate 2 was self-contradictory** — `O(elided)` cost and "flat in elided count" cannot both hold; the per-item bound had no percentile and could breach Gate 1. Now a concrete slope + percentile. §9 Gate 2. | Reviewer #2 (minor) |

**v4 changes (review round 3):**

| # | Change | Source |
|---|---|---|
| **M13** | **The monotonicity direction was backwards.** Eligibility is `userMessagesAfter >= K_eff`, so a rising `K_eff` *un-elides* blocks and makes content reappear. `f` must be **non-increasing** in band. §6 Layer 3. | Reviewer #1 (major) |
| **M14** | **A pure function cannot supply hysteresis** — if the banding input oscillates, so does the output, and a dead-zone only moves the boundary. Fixed by banding on a **monotone conversation-derived** input (incoming, pre-elision) instead of on request size. §6 Layer 3. | Reviewer #1 (major) |
| **M15** | **Gate 5's metric omitted cache-creation tokens and was not price-weighted**, so mutation-on could pass while costing more — invalidating the sole keep/kill gate. §9 Gate 5. | Reviewer #2 (major) |
| **M16** | **Gate 5 had no effect size or confidence requirement**; noise alone could re-enable mutation. §9 Gate 5. | Reviewer #2 (major) |
| **M17** | **The `clientError` guidance would leak sockets** — attaching a listener *replaces* Node's default 400/431-and-close, so a logging-only handler never disposes the connection. The v1–v3 claim that the default "silently destroys" the socket was also inaccurate. §8 Step 2(d). | Reviewer #2 (major) |

Unchanged and still confirmed across all three rounds: the root cause (§1), M1 (§2), the
corrections to the original brief (§3), and the incomplete-bypass finding (§4).

---

## 1. Root cause (confirmed, unchanged)

`@anthropic-ai/tokenizer@0.0.4`'s `countTokens()` builds a fresh Tiktoken WASM encoder from a
696,615-byte BPE table **on every call**, then frees it. `src/pruner/k-pruning.ts:58` calls it
**once per prunable block**, synchronously, **before any byte is forwarded upstream**.

Measured in-repo: **45.7 ms/call** for 30-char stub text, 57.2 ms for 4,000 chars — the cost is
the *constructor*, not the encode. At observed per-turn stub counts: 68 → 3.1 s, 127 → 5.8 s,
261 → 11.9 s of fully blocked event loop.

Confirmed in production from CacheLane's own log — the `incoming` (`server.ts:572`) →
`mutated request` (`server.ts:906`) window contains **no `await`**, so it is pure loop-block
time. Over 11,715 PID-segmented turns, bucketed by the `pruned` field already logged:

```
pruned = 0      n=6572   median     47 ms
pruned 10–39    n=1544   median  1,061 ms
pruned 80–119   n= 538   median  4,344 ms
pruned 120+     n= 474   median  6,715 ms      overall p99 8,034 ms · max 11,573 ms
```

Slope ≈ **47 ms/block**, within 7% of bench. **Turn depth is irrelevant once prune count is
controlled** — `pruned=0` is 47–104 ms at *every* turn depth, which kills the "big session =
slow" intuition. Independent live proof: a `/healthz` probe (no I/O, excluded from the inflight
counter — so its latency *is* loop-block time) hit **max 4,675 ms** on `:7332` under load.

**Why no errors:** nothing fails. The stall precedes the upstream call. Node is single-threaded,
so each stall freezes every concurrent request and in-flight SSE stream at once. The client waits.

---

## 2. M1 — the un-stubbing bug is load-bearing (new, and it inverts v1)

v1 (and three of five investigation lenses) treated the re-prune loop as a pure defect: the
mutated body is recorded (`server.ts:814`/`:930` → `:1108`), so `content_hash` becomes
CacheLane's own stub text, defeating the guard at `data-access.ts:310-320`, resetting
`is_stub = 0`, and re-pruning the block next turn. v1's Step 4 proposed threading a separate
`recordBody` so `is_stub` sticks.

**That fix would silently disable the feature.** Two facts, both verified:

1. `getPrunableBlocks` filters **`AND is_stub = 0`** (`data-access.ts:379`). A block with
   `is_stub = 1` is never selected again, so it yields **no decision**.
2. Only *this turn's new decisions* are materialized into the forwarded body:
   `pre-request.ts:264` calls `materializePrunedBlocks({decisions: actionableDecisions})`,
   where `actionableDecisions` derives solely from `pruneResult.decisions`
   (`pre-request.ts:240-242`). Already-stubbed blocks are **not** re-materialized.

So with a sticky `is_stub`: turn *N* elides block X once; turn *N+1* the client re-sends X's
full original content, X produces no decision, nothing materializes it, and **the full content
forwards upstream — permanently.** The stub applies for exactly one turn per block, ever.

The query's own comment concedes the premise: *"this fires even when Claude Code sends full
history on every turn (`unused_turns` stays 0 because the block is always 'present' in the
messages array)."*

**Consequences:**

- **The 21× re-prune ratio is not the bug.** Re-eliding every turn is *required* for the
  forwarded body to stay pruned, because the client re-sends everything every turn. The bug is
  that each re-elision costs 45 ms.
- **`is_stub` as durable state is incoherent** for a transparent proxy. It is simultaneously
  (a) the flag that makes elision persist and (b) the flag that prevents elision from being
  reapplied. It cannot be both.
- **v1's Step 4 is retracted.** The `recordBody`/nominal-types change remains correct *hygiene*
  (`:1108` should never see the forwarded buffer), but on its own it is a **second, independent
  way to silently turn the feature off** — the same failure class as R-1, approached from the
  opposite side. It must not land without the stateless transform.
- **The stateless design is not an improvement; it is the only coherent option.** Elision must
  be recomputed from the messages array on every request. That is exactly Layer 1.

---

## 3. Corrections to the original brief

Unchanged from v1 §2 and still standing: `synchronous` is **NORMAL** not FULL (C1); the 512 MB
cap was **never** approached — `max 0 / oom 0` (C2); `NRestarts=0` is not evidence, the
healthcheck restarts via `systemctl restart` which zeroes it (C3); "zero errors in journalctl"
is vacuous since `logger.error` never reaches stdout (C4); **the LiteLLM lane has never written
an application log** — `Logger` hardcodes `os.homedir()/.cachelane` (`logger/index.ts:33`),
excluded from that unit's `ReadWritePaths` under `ProtectHome=read-only`, every write failing
EROFS into a bare `catch {}` — verified: no `cachelane.log` exists in `~/.cachelane-litellm/`
(C5); the freelist is largely a `012_session_scoped_blocks.sql` migration artifact (C6); the
45.3 MB WAL is multi-process checkpoint starvation, not write volume (C7); **my own F8b
benchmark was right in fact but closed the wrong inquiry** — it measured only SQLite (7.4 ms)
while the same synchronous section takes 1,141 ms median in production; the 154× residual was
the tokenizer (C8); `~/.cachelane` is a symlink to `.cachelane-claude` (C9).

---

## 4. The bypass was incomplete — and M4

All five lenses independently found live traffic post-cutover. **I verified it.** The on-disk
config *is* correctly repointed (zero `127.0.0.1:733x` refs across all five client surfaces),
but **processes started before the cutover hold the old values in their inherited environment,
and so does everything they spawn**:

| pid | started | still pinned to |
|---|---|---|
| `2597440` `claude` | 13:20 | `:7332`, `:7333` |
| `3343481` `pi` | 14:31 | `:7332` |
| `56245` `agent-dispatch review` | **15:47** | `:7332` — spawned *after* the cutover, from a stale parent env |

An env edit fixes new logins; it cannot reach a running process.

### Action taken (reversible, no restart, no deploy)

Config is re-read per request (`server.ts:617`, no caching) and `k-pruning.ts:11-13`
short-circuits **before** the `rows.map` tokenizer loop. In **both**
`~/.cachelane-claude/config.json` and `~/.cachelane-litellm/config.json`:

```json
"pruner":   { "enabled": false },
"features": { "k_pruner": false, "mutation_enabled": false }
```

Backups: `config.json.bak-pre-pruner-off-20260731T225120Z` in each home. Both lanes verified
serving (`/healthz` 200 in <1 ms). This zeroes the 45 ms × N term on the next request for the
sessions the env edit could not reach. Revert by restoring either backup.

**M4 — this is the mitigation, NOT the discriminating experiment.** v1 claimed this config also
tests whether preserving the original body makes the pruner converge. It does not: with
`pruner.enabled=false` the loop never runs, so `pruned_blocks_count` is trivially 0 and cannot
distinguish the two causes. The real experiment requires **`pruner.enabled=true` +
`k_pruner=true` + `mutation_enabled=false`**, varying only mutation — and per **M1** its
predicted outcome is now the opposite of v1's: with `forwardBody === body` the guard holds,
`is_stub` sticks, and **pruning stops after the first turn per block**. That is the falsifiable
prediction, and confirming it confirms M1.

---

## 5. Q2 — one causal chain or two?

**Y-shaped.** One root — per-turn `O(session_blocks)` work — with two independent branches:

- **Latency branch:** `O(blocks)` × 45 ms tokenizer = **the hang, the whole symptom.**
- **Storage branch:** `O(blocks)` rewrites of `turn_explanations.block_metadata` (avg 7,307 B,
  written twice per turn at `server.ts:741-751` and `:1264`) plus `updateBlockCounters`
  UPDATEing every non-stub block per request (`data-access.ts:704-718`) = freelist churn.
  **Off the latency path.**

The 45.3 MB WAL is a **third, unrelated** problem. Fixing the pruner will **not** fix the
freelist — `block_metadata` enumerates all placements regardless of `is_stub`.

---

## 6. Q3 — is body mutation sound?

**Not as built.** Three invariants, all violated:

- **I1 — idempotence + input/output separation.** Violated: `:814`/`:930` → `:1108`.
  *No transform whose output is its own input has a fixed point anyone chose.*
- **I2 — monotonicity** (prompt caching is prefix-keyed; once elided, always elided). Violated
  by `restoreStub` (`data-access.ts:355-365`) and by the ON-CONFLICT `ELSE` branch un-stubbing
  as a **side effect of recording**.
- **I3 — determinism from client-visible input only.** Violated by `db.allocateTurnNumber`
  (`server.ts:616`), a **per-HTTP-request** counter. Claude Code fans sub-agent requests under
  one session id, so blocks become eligible within three HTTP requests. `added_at_turn` reaches
  **1748** in a session with 267 real turns, and **two concurrent requests materialize different
  stub sets for the same conversation.**

**M1 adds a fourth:** durable per-block elision state is unrepresentable when the client re-sends
full history and never learns what was elided. Any design keyed on `is_stub` is incoherent.

### Target architecture

1. **Layer 1 — pure transform** (now mandatory, not preferred).
   `transform(parsedRequest, policy) -> {body, decisions[]}`. No DB, no clock, no counters.
   Elide a `tool_result` iff (a) `userMessagesAfter(block) >= K` counted **from the messages
   array itself**, (b) `byteLen >= MIN_BYTES`, (c) not pinned. Monotone under append → **I2 by
   construction**; stub below `MIN_BYTES` → **I1**; identical across processes, restarts, DB
   loss and concurrency → **I3**; recomputed every turn → **M1 by construction**.
   Removes `getPrunableBlocks`, `is_stub`, `unused_turns`, `added_at_turn` from the *decision*
   path entirely. **Requires a per-call tokenizer cost near zero** (§8 Step 1) — this design
   deliberately re-elides every block every turn.
2. **Layer 2 — write-only ledger.** `blocks`/`turn_explanations` become telemetry nothing reads
   back. Enforce at the type level: `proxyAndRecord({forwardBody: ForwardBody, recordBody:
   OriginalBody})` as **distinct nominal types**, so `:1108` cannot compile against the mutated
   buffer. **Must land with Layer 1, never before it** (M1).
3. **Layer 3 — hysteresis via a deterministic bucket-derived cutoff (M7).**
   Elision *is* cache invalidation, so eliding a little more each turn invalidates the prefix
   every turn. v2 proposed batch-converting on a threshold crossing — **that was wrong**: a
   "crossing" is an event only an observer with memory can see, and memory is state (violating
   I3/M1); worse, if elision applies only *at* the crossing, the next request re-sends originals
   and the content reappears.

   The fix is to make the cutoff a **pure function of the current request**. Quantize the
   request to a coarse band and derive the effective cutoff `K_eff = f(band)` from that band
   alone. Two properties must hold, and **v3 got both wrong** (M13, M14).

   **(a) `f` must be monotone NON-INCREASING in `band` (M13).** v3 said "non-decreasing" — that
   is backwards. Eligibility is `userMessagesAfter(block) >= K_eff`, so a *larger* `K_eff` makes
   *fewer* blocks eligible. If `K_eff` rose with the band, then growing into a higher band would
   **un-elide** previously elided blocks and make their content reappear — a direct violation of
   I2 and of M1's "no reappearance" requirement. As the conversation grows we want to elide
   *more*, which means `K_eff` must **shrink**. `f` non-increasing gives a monotonically growing
   elided set.

   **(b) The band input must be monotone in the conversation, not in request size (M14).** v3
   proposed `band = floor(log2(total_prompt_tokens))` plus a "dead-zone" for hysteresis. A pure
   function cannot provide hysteresis: if the input oscillates across a boundary, the output
   must oscillate too, and a dead-zone only *moves* the boundary rather than removing it. That
   objection is correct and fatal to the v3 formulation — **but it applies to the input choice,
   not to statelessness itself.**

   The resolution is to band on a quantity that **only grows as the conversation grows**, so no
   oscillation is possible in the first place. Two admissible inputs:
   - `count(user messages in the incoming request)` — append-only within a conversation;
   - the **pre-elision** byte/token size of the incoming client request.

   The critical detail: the band must be computed from the **client's incoming request**, never
   from the forwarded post-elision body. Incoming history is append-only, hence monotone; the
   forwarded body *shrinks* when elision fires, which would feed the output back into the input
   and recreate exactly the M1 feedback loop in a new place.

   With a monotone input and a non-increasing `f`, band changes are one-way, the elided set only
   grows, the prefix is invalidated **once per band change (~per doubling)** rather than once per
   turn, and no component remembers anything.

   **Stated limitation:** client-side compaction truncates the history, so any
   conversation-derived metric drops at that point and `K_eff` jumps back up. This is acceptable
   — compaction rewrites the prefix anyway, so the cache is invalidated regardless — but it must
   be documented, and Gate 2's monotonicity assertion must scope itself to *between* compaction
   events.
4. **Layer 4 — escrow with ownership and authorization, or stop lying (M8).**
   `blocks` has **no content column** (`migrations/012:7-26`); `expandStub` returns only
   `{type:'tool_use', id}` (`pruner/tools.ts:93-101`); `compression_originals` has
   `retention.enabled: false` and **0 rows** in both DBs. The stub text advertises a
   `cachelane_expand` retrieval that is **structurally impossible**.

   If escrow is built, **`sha256(content)` alone must not be the key.** A bare content hash is a
   bearer token: any caller who obtains or guesses one retrieves another session's — potentially
   another tenant's — tool output, and tool outputs are exactly where credentials, file
   contents, and internal URLs live. Required instead:
   - store under **`(workspace_id, session_id, sha256(content))`**, with the hash never
     sufficient on its own;
   - `cachelane_expand` / `cachelane_retrieve_tool_output` must **authorize the caller against
     the owning session** and return not-found (not forbidden) on mismatch, so the endpoint is
     not an existence oracle;
   - real TTL + eviction, and a documented retention policy — this table durably stores
     verbatim tool output that the elision was meant to remove.

   Otherwise remove the promise from `formatStubText` (`pruner/stubs.ts:13`). **Make `expand`
   non-mutating either way** — today it side-effects `is_stub = 0`, which any prefix-stable
   design must forbid.
5. **End state — invert it.** The proxy *advises* (a response header enumerating elided ids, or
   the existing `cachelane_expand`/`cachelane_retrieve_tool_output`) and the **client** mutates
   its own transcript. The client is the sole authority on the conversation — the only place
   elision state can be authoritative. Requires a client change; 1–4 is the interim.

### Honest self-critique

Even corrected, the feature may not pay. Caching charges 1.25× to write and 0.1× to read;
eliding at position *p* forces a 1.25× re-write of the `(N − p)` suffix to save 0.1× per turn.
Hysteresis helps; it does not make the sign obviously positive.

**A suggestive but confounded signal (M9 — retracted as a decision premise).** The lane that
mutates *least* performs *best*: LiteLLM (heavy pruning, 6,278 prune events) runs **37–41%**
cache-read ratio; the Claude lane (`marker_strategy: passthrough`, 159–564 events) runs
**84–100%**.

v1 and v2 called this "a standing falsification of the feature." **That was overstated and is
withdrawn.** The two lanes differ in provider (LiteLLM-fronted grok/glm vs api.anthropic.com),
in workload and session shape, in `marker_strategy` (`candidate` vs `passthrough`), and in prune
volume — so the comparison is confounded on at least four axes and **cannot establish
causation**. Different providers also implement prompt caching differently, which alone could
produce this gap.

It remains a genuine warning sign, and it is the reason mutation must not be re-enabled on
faith. But **the only admissible evidence is Gate 5** (§9): the same workload, on the same lane,
with mutation as the sole varying factor. No keep/kill decision should rest on the cross-lane
number.

Two consequences worth stating plainly:

- **`blocks.token_count` is destroyed fleet-wide.** `markStubStmt` (`data-access.ts:349`)
  overwrote originals with stub sizes (live: min 46 / max 112 / avg 82.7). Because
  `makeStubSummary` (`pruner/stubs.ts:4-7`) embeds `row.token_count`, every re-stub renders a
  *different* string → different hash → guaranteed guard miss. **A second, independent driver of
  the limit cycle**, and stubs read "(45 tokens elided)" for blocks that were thousands of tokens.
- **The savings telemetry is therefore fabricated.**
  `tokens_reclaimed = max(original_tokens − stub_tokens, 0)` (`server.ts:736-739`) computes
  stub-vs-stub after the first prune. **Any keep/kill decision citing CacheLane's own savings
  numbers is citing invented data.**

Recommend positioning the feature as **context-window headroom, not cost savings**, and noting
it is invisibly lossy: the model's context and the user's transcript diverge permanently, which
no proxy-side design fixes.

---

## 7. Recommended decision

Given M1 (the feature has never worked as designed — it "worked" only via a bug that costs
45 ms/block/turn) and the fabricated savings telemetry, the defensible options are:

**A. Fix the hang, leave pruning off.** Steps 1–3 + 5 below. CacheLane becomes a recording,
cache-hint-injecting, observable proxy. No mutation, no elision. Lowest risk, restores service,
and defers the keep/kill question until there is admissible evidence to answer it.

**B. A, then rebuild pruning as Layer 1 behind an experiment arm,** shipped only if Gate 5
(same workload, mutation as the sole variable) shows mutation-on beating mutation-off.

**C. Retire the pruner.** Delete the mutation path and its schema. Largest simplification;
forecloses the context-headroom benefit.

**Note on the evidence for this choice (M9).** v2 leaned on the cross-lane cache-read gap to
argue for A or C over B. **That premise is withdrawn as confounded.** What actually supports A
today is narrower and still sufficient: the feature has never worked as designed (M1), its own
savings telemetry is fabricated (§6), and its cost is a measured 45 ms per block per turn (§1).
A is therefore the right *first* move regardless — but it is a **deferral** of the keep/kill
decision, not a verdict on the feature's value. Choosing C on today's evidence would be
premature.

**Not recommended: threading `recordBody` on today's architecture** — per M1 that silently
disables pruning while appearing to fix the loop.

---

## 8. Sequenced plan

**Step 0 — done (§4).** Config-only, no restart. Pruner off on both lanes.

**Step 1 — smallest code fix, ~5 lines, best value/risk.** In `src/tokenizer/index.ts`, hold one
module-scope `Tiktoken` from the package's exported `getTokenizer()` and call
`enc.encode(text.normalize("NFKC"), "all").length`. Identical counts, 45 ms → sub-ms. Fixes the
pruner path (`k-pruning.ts:58`), the post-response extractor (`server.ts:1348` → `:55`), and
`orchestrator/index.ts:64` in one edit. **In-repo precedent:** `src/tokenizer/openai.ts:21-29`
already caches encodings at module scope; `src/tokenizer/index.ts:14-28` does not. Measured
cached tiktoken: **0.28 ms** — ~150× cheaper. *Sufficient for stubs alone:* stop calling the real
tokenizer at `:58` — its own comment concedes a fallback multiplier is fine for ~80-token text.
**This is a prerequisite for Layer 1**, which re-elides every block every turn by design.

**Step 2 — observability, before claiming anything is fixed.**
(a) Fix `Logger` to honour `CACHELANE_HOME` and stop swallowing write errors
(`logger/index.ts:33-34,120-122,143`) — otherwise the LiteLLM lane stays mute.
(b) Move the test suite off the production log/DB home (vitest inherits `CACHELANE_HOME`; 1,992
`listening` events across 258 PIDs are interleaved into the live Claude-lane log).
(c) Spans `{req_id, session, bytes_in, bytes_out, t_ttfb_ms, t_upstream_ms, t_total_ms,
upstream_status}` at `server.ts:572` and `:1282`.
(d) A `server.on('clientError')` handler **that still terminates the socket (M17)**. Correcting
v1–v3 on two points: Node's default handler does **not** silently destroy the socket — it
responds `400 Bad Request` (or `431` for oversized headers) and *then* closes. And **attaching a
listener replaces that default**, so a logging-only handler leaks every malformed connection.
The handler must log *and* respond-then-destroy — write the `400`/`431` when the socket is
still writable and `err.code !== 'ECONNRESET'`, then `socket.destroy()` unconditionally. The
real gap being closed is observability (a pre-parse failure never logs `incoming` today), not
socket disposal, which already works.
(e) `/metrics`: `cachelane_proxy_overhead_seconds`, `cachelane_upstream_seconds`,
`cachelane_inflight` (`server.ts:527` already holds it and throws it away), `requests_total`,
`prune_events_total`, `wal_bytes`, RSS, plus event-loop lag from
`perf_hooks.monitorEventLoopDelay()`.
(f) `/etc/vmagent/scrape.d/cachelane.yml` copying the existing `litellm.yml` label scheme — **a
full VictoriaMetrics + vmagent + vmalert + Alertmanager stack is already running and nobody used
it** — plus alerts on overhead p99 > 250 ms, `inflight > 32` for 5 min, and RSS > 400 MB.
*(The v1 "convergence alarm" `rate(prune_events) > rate(blocks_inserted)` is **dropped** per M2 —
under a correct stateless pruner that condition is normal.)*

**Step 3 — bounds (all currently absent).** `server.keepAliveTimeout` raised (see §9 gate 4 for
the correct target), `headersTimeout` above it, `requestTimeout` sized for multi-MB uploads;
upstream **headers/first-byte** and **inter-chunk idle** timeouts with an explicit 504; a bounded
in-flight cap returning 503. **Never a total-duration timeout** — legitimate agentic streams run
for minutes.

**Step 4 — only under decision B.** Layer 1 stateless transform *together with* Layer 2 nominal
types, behind an experiment arm, gated on §9 gate 5. **Layer 2 must not land alone (M1).**

**Step 5 — DB hygiene (ops).** Flip MCP processes to open the DB **readonly**
(`src/server/index.ts:139`); stop `PRAGMA integrity_check` on every open
(`data-access.ts:268`); one offline `VACUUM` + `wal_checkpoint(TRUNCATE)` per home **with MCP
servers stopped**; retention on `turn_explanations`.

---

## 9. The evidence standard (live observables)

**Primary gate (M5-corrected).** Poll `GET /healthz` on `:7332` and `:7333` at 100 ms.
`/healthz` does no I/O and is excluded from the inflight counter, so its latency **is**
event-loop block time.

- **Required workload — this is not a no-traffic gate.** The lane must concurrently serve a
  session that reaches the formerly pathological bucket: **≥ 200 turns with ≥ 120 elidable
  blocks per turn** (the `pruned 120+` bucket, median 6,715 ms today). A shallow session proves
  nothing. If pruning is off (decision A), substitute a synthetic replay of the largest recorded
  session against a stub upstream, asserting the same per-turn block counts.
- **Known-bad, measured live under load: max 4,675 ms on `:7332`, 2 samples > 3 s.**
- **Pass: max < 250 ms and ZERO samples above 1 s on both ports, across ≥ 30 min at that depth.**
- *Post-mitigation reading with lanes near-idle: `:7332` p50 1.0 ms / max 77 ms; `:7333` p50
  1.0 ms / max 9 ms. Green, but at near-zero load — **this does not satisfy the gate.***

**Gate 1 — the dose-response curve must flatten.** Re-run the `incoming`→`mutated request`
delta bucketed by `pruned`. Today: `pruned=0` → 47 ms, `pruned 120+` → 6,715 ms; p99 8,034 ms.
**Pass: median at `pruned ≥ 120` within 2× of median at `pruned = 0`**, and p99 < 100 ms over
≥ 500 turns with `pruned > 0`.

**Gate 2 — elision correctness (M2/M3-corrected; replaces v1's convergence gate).**
v1 asserted `sum(prune_events) <= count(distinct blocks)` and non-increasing
`pruned_blocks_count`. **Retracted** — per M1 a correct pruner re-elides every eligible block
every turn, so both would fail on a correct implementation. Replace with:

- **Determinism:** the same messages array, submitted twice (different processes, cold DB, and
  concurrently), yields **byte-identical** forwarded bodies.
- **Monotonicity under append:** if block X is elided for prefix *P*, it is elided for every
  *P + suffix*. No block ever un-elides. **Scoped between compaction events** (M14): client-side
  compaction truncates the history, so any conversation-derived band drops and `K_eff` rises at
  that point. Compaction rewrites the prefix anyway, so this costs nothing — but the assertion
  must reset at each compaction rather than fail on it.
- **Bounded cost (M12).** v2 asked for both `O(elided) × <1 ms` *and* "flat in elided count" —
  those contradict, and an unqualified "<1 ms" per item would allow 120 ms at 120 blocks,
  breaching Gate 1's own 100 ms budget. The gate is on the **fitted slope and a percentile**,
  consistent with Gate 1:
  - regress `handler_ms` on `elided_count` over ≥ 500 turns spanning ≥ 3 count buckets;
  - **pass: fitted slope ≤ 0.20 ms per elided block** (today: **47 ms**, a 235× reduction, and
    ~0.28 ms is the measured cached-tokenizer cost for the *whole* call, so ≤0.20 ms/block is
    achievable once the encoder is built once per process rather than once per block);
  - **and p95 `handler_ms` < 60 ms, p99 < 100 ms, at `elided ≥ 120`** — which is what makes
    Gate 1's p99 budget hold at the pathological depth rather than only on average.

  "Flat" is the intent; the slope bound is the measurable form of it.

**Gate 3 — the multi-turn closed-loop test (M3-corrected).** v1 fed each turn's *forwarded* body
back as the next turn's client history. **Wrong protocol** — a transparent proxy's client never
sees the forwarded body. The test must feed the **original, growing, unpruned history** forward,
exactly as Claude Code does, for ≥ 12 turns, and assert Gate 2's three properties plus flat
per-turn overhead. **Against `main` today this test reproduces the 45 ms × N ramp**, and against
a sticky-`is_stub` build it reproduces **M1** (elision silently stops after turn 1 per block) —
so it discriminates all three states. `extractAndInsertToolResults` currently has **zero tests**
and no test anywhere iterates more than one turn.

**Gate 4 — connection lifetime (M6/M10/M11-corrected).** v1 asserted "no FIN within 120 s on an
idle socket", which wrongly treats normal idle expiry as failure and encourages unbounded socket
retention. v2 then required the advertised timeout to *equal* the effective close — **also
wrong**: Node deliberately closes a keep-alive socket slightly *after* the advertised value
(`server.keepAliveTimeoutBuffer`, 1 s by default) precisely so a client that starts a request at
the advertised boundary is not reset mid-flight. Demanding equality deletes that safety margin.
The corrected gate:

- **No in-flight termination:** the proxy never closes a socket with a request in flight or an
  SSE stream open, at any idle-timer boundary. *(This is the substantive assertion — the others
  are tuning.)*
- **Advertisement ≤ effective, with headroom (M10):**
  `advertised Keep-Alive timeout + headroom ≤ effective close time`, headroom ≥ 1 s. A client
  that begins a request any time before the advertised deadline must never meet a FIN.
  **Today the server advertises `timeout=5` and closes at ~6.0 s** — verified: `:7333` 6.008 s,
  `:7332` 6.007 s, while LiteLLM:4000 was still open at 20 s. So today's *headroom* is
  structurally correct; the *magnitude* is the defect.
- **Measured target (M11).** v1/v2 gave only a mean, which is not a testable target. Measured
  from the live Claude lane (`recorded turn` → next `incoming`, PID-segmented to the live proxy
  3459652, n=332):

  | | idle gap |
  |---|---|
  | p50 | 0.24 s |
  | p75 | 0.42 s |
  | p90 | 3.30 s |
  | p95 | **19.33 s** |
  | p99 | **113.53 s** |
  | max | 428.94 s |
  | mean | 5.72 s |

  The distribution is strongly **bimodal**, which matters: p50 is 240 ms (rapid agentic turns
  reuse the socket easily) while the tail is long. **8.1% of gaps exceed 5 s** and lose the
  socket at today's default. *(This also corrects the investigation's claim that interactive
  sessions "would exceed it on nearly every turn" — the real figure is ~8% of turns, so
  connection lifetime is a genuine but minority-tail defect, consistent with it being secondary
  to the tokenizer.)*

  **Set `keepAliveTimeout = 120 s`,** which covers p99 (113.5 s) — i.e. ~99% of reuse attempts —
  with `headersTimeout` strictly greater and `requestTimeout` sized for multi-MB uploads.
  **Pass: gaps below 120 s never encounter a proxy-initiated FIN.** Residual accepted and
  stated: **~0.9% of gaps exceed 120 s** (max 429 s); those must fall back to a clean new
  connection, never a reset mid-request — which is what the first bullet enforces.

**Gate 5 — economics, before mutation is ever re-enabled (M9).** This is now the **only**
admissible evidence on the feature's value; the cross-lane 37–41% vs 84–100% comparison is
withdrawn as confounded (§6). Requirements:

- **Same lane, same provider, same workload** — replay one recorded session, or run an A/B on
  one lane with traffic split by session id. Never compare `:7332` against `:7333`.
- **Mutation is the sole varying factor** — `pruner.enabled=true` and `k_pruner=true` in both
  arms, varying only `mutation_enabled` (the de-confounded config of §4, not the Step 0
  mitigation, which disables all three).
- **Metric — price-weighted cost, not a ratio (M15).** v3 used
  `cache_read / (cache_read + input)`, which **omits cache-creation tokens entirely** and treats
  all token classes as equally priced. Both are wrong: elision's whole cost mechanism is forcing
  1.25×-billed cache *writes*, so a metric blind to them can show mutation-on "winning" while it
  bills more. Use per-session cost in **price-weighted units**:

  ```
  cost = uncached_input × 1.00
       + cache_read      × R_read      (0.1 for OpenAI-family, 0.1 for Anthropic)
       + cache_write_5m  × 1.25
       + cache_write_1h  × 2.00
  ```

  with the multipliers taken from the **actual provider's** published rates for that lane, not
  assumed. Report absolute billed tokens per class alongside, so a regression in any one class
  is visible.
- **Pass — effect size and confidence, not "beats" (M16).** v3 accepted mutation on a bare
  win over 20 sessions, which noise alone can produce. Require:
  - a **paired** design (same replayed session in both arms) so per-session variance cancels;
  - **≥ 10% reduction in price-weighted cost** — below that the feature is not worth its
    complexity and risk;
  - **p < 0.05** on a paired test (Wilcoxon signed-rank; the distribution is not normal), over
    **≥ 30 paired sessions** reaching the elision depth of the primary gate;
  - **no regression** in any individual token class, and no increase in p95 turn latency.

  If the result is inconclusive, mutation stays off. Absence of a demonstrated benefit is a
  fail, not a tie.

**Gate 6 — zero orphaned requests.** Every logged `incoming` has a terminal span. Today 21/365
and 10/249 have none.

**Do NOT accept end-to-end latency as evidence.** LiteLLM's p50 swings 1.3 s → 180 s and
`litellm_llm_api_latency_metric` p50 tracks `litellm_request_total_latency_metric` p50 within
noise — the multi-minute latency is the **model**, not queueing. Upstream variance swamps any
end-to-end measurement, which is why the earlier 5×1-token probe was inconclusive.

---

## 10. Must-fix risks (severity-ordered)

| # | Sev | Risk | Mitigation |
|---|---|---|---|
| R-1 | **CRITICAL** | **The naive fix at `server.ts:814`/`:930` silently disables the feature.** `proxyAndRecord`'s single `body` param feeds **both** `extractAndInsertToolResults(body)` (`:1108`) **and** `upstreamReq.write(body)` (**`:1163`**). Swapping to the original body forwards the unmutated request upstream. | Thread a separate `recordBody`; distinct nominal types. **Test must assert forwarded bytes ≠ recorded bytes.** |
| **R-1b** | **CRITICAL** | **(M1) Making `is_stub` sticky also silently disables the feature**, from the opposite direction: `getPrunableBlocks` filters `is_stub = 0` and only this turn's decisions are materialized, so elision stops after the first turn per block. | **Layer 2 must never land without Layer 1.** Gate 3 discriminates. |
| R-2 | **CRITICAL** | **Measurements taken now are invalid — the bypass is incomplete (§4)**, and no request-rate metric exists, so nobody can tell. | Recycle stale-env sessions; confirm zero requests for 30 min before any baseline or A/B. |
| R-3 | **CRITICAL** | **Concurrent-request divergence.** `current_turn` is per-HTTP-request (`server.ts:616`); two concurrent requests in one session materialize different stub sets. | Layer-1 statelessness. **Not fixable by patching the counter.** |
| R-4 | HIGH | **`blocks.token_count` is destroyed fleet-wide**; any migration or savings report reading it reads fabricated data. | Treat as unrecoverable; do not migrate forward. |
| R-5 | HIGH | **The test suite gives false assurance.** `storage.test.ts:1071` passes `content_hash:'same-hash'` on both inserts — the precondition production never satisfies. No test iterates >1 turn; `extractAndInsertToolResults` has zero tests. A passing suite coexists with a 21× re-prune loop. | Gate 3. Plus the guard's negative case (different hash while `is_stub=1`). |
| R-6 | HIGH | **No upstream timeout at all** (`server.ts:1114-1116`, `:412-429`). A backend that accepts and goes silent hangs the client forever — a second, independent hang mechanism the evidence cannot exclude. | Step 3. |
| R-7 | HIGH | **The LiteLLM lane is forensically blind** (C5). Any conclusion of the form "the LiteLLM lane logged nothing" is an artifact. | Fix before drawing further log-based conclusions. |
| R-8 | MEDIUM | **The production log is the test log.** Unsegmented analysis produces phantom findings — one lens generated and killed a false "request leak" caused by exactly this. | Separate homes; until then **always segment by PID**. |
| R-9 | MEDIUM | **VACUUM/checkpoint against live readers** will block or fail; `wal_checkpoint(TRUNCATE)` cannot reset under a pinned read-mark. | Offline, MCP servers stopped. |
| R-10 | MEDIUM | **Memory under concurrency.** Each in-flight request holds chunks + concat Buffer + parsed graph + full deep clone (`materialization.ts:9-26`) + `forwardBody` + the **entire retained response** (`server.ts:1098,1124`) ≈ 20–30 MB. The cap has never been hit, but a concurrency cap plus faster turnaround changes the arrival profile. | Parse usage incrementally from SSE `message_delta`; bound in-flight. |
| R-11 | MEDIUM | **Silent SSE truncation.** 620 `socket hang up` + 102 `ENOTFOUND`; once headers are sent the handler does a bare `res.destroy()` (`server.ts:1156-1158`) — no error frame, no retry. **Indistinguishable from a hang.** | Emit an SSE error event before destroying; count it. |
| R-12 | MEDIUM | **Idle keep-alive teardown at ~6.0 s** against origins holding idle connections >75 s, plus HTTP/2 → HTTP/1.1 downgrade fanning one multiplexed connection into N short-lived TLS connections. Real and cheap, but a minority tail — **not** the reported symptom. | Step 3 + Gate 4. |
| **R-13** | **HIGH** | **(M8) If escrow is built keyed on `sha256(content)` alone, the content hash becomes a bearer token** — any caller holding or guessing one retrieves another session's (potentially another tenant's) verbatim tool output, which is exactly where credentials, file contents and internal URLs live. The endpoint would also be an existence oracle. | Key on `(workspace_id, session_id, sha256(content))`; authorize the caller against the owning session; return not-found on mismatch; real TTL + eviction + a stated retention policy. |
| R-13b | LOW | **The stub text advertises a retrieval that cannot happen** (§6 Layer 4), and `expand` side-effects `is_stub=0`, which any prefix-stable design must forbid. | Enable escrow (per R-13) or remove the promise; make `expand` non-mutating either way. |
| R-14 | LOW | **journald has no headroom.** `k-pruning.ts:80` emits the full pretty-printed `kinds` array — ~130 lines per request at 127 stubs. | Log a count; set explicit `RateLimit*`. |

**Explicitly deprioritized:** the 512 MB `MemoryMax` and 256-task cap (never approached); the
91–98% freelist (~520 MB of disk, largely a migration artifact, off the latency path); SQLite
read latency (7.4 ms — correctly refuted, but that refutation was then used to close the wrong
inquiry). Host swap is oversubscription from an unrelated 165 GB `python3` on zram — a capacity
item, not CacheLane.
