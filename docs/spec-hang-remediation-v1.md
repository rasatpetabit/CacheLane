# CacheLane hang remediation — spec v1

**Status:** pre-approval draft. Produced by a 5-lens independent deep-dive (run `wf_e6f94677-bb9`)
plus operator-side verification. Not yet adversarially reviewed. No code written.

**Date:** 2026-07-31 · **Repo:** `/srv/dev/ai/cachelane` @ `main` = `3883ee7`

---

## 1. Root cause (confirmed)

`@anthropic-ai/tokenizer@0.0.4`'s `countTokens()` constructs a fresh Tiktoken WASM encoder
from a 696,615-byte BPE rank table **on every call**, then frees it.
`src/pruner/k-pruning.ts:58` calls it **once per prunable block**, inside a synchronous
`rows.map(...)`, on the request path, **before any byte is forwarded upstream**.

Measured independently on this host (`node` in-repo, 20 iterations):

| input | per call |
|---|---|
| 30-char stub text | **45.7 ms** |
| 4,000-char text | 57.2 ms |

The cost is the **constructor**, not the encode — it is essentially constant per call.
Multiplied by the observed per-turn stub counts:

| stubs/turn (observed live) | blocked event loop |
|---|---|
| 68 | 3.1 s |
| 91 | 4.2 s |
| 127 | 5.8 s |
| 139 | 6.4 s |
| 261 | 11.9 s |

**Production confirmation, from CacheLane's own log.** The `incoming` (`server.ts:572`) →
`mutated request` (`server.ts:906`) window contains **no `await`** (the first is
`signForBedrock` at `:919`), so its duration is pure event-loop block time. Over 11,715
PID-segmented turns:

```
overall:       p50 78ms  p90 3,298ms  p95 4,979ms  p99 8,034ms  max 11,573ms
pruned = 0     n=6572   median     47 ms
pruned 1–9     n=1399   median    147 ms
pruned 10–39   n=1544   median  1,061 ms
pruned 40–79   n=1188   median  2,556 ms
pruned 80–119  n= 538   median  4,344 ms
pruned 120+    n= 474   median  6,715 ms
```

Slope ≈ **47 ms per pruned block** — within 7% of the bench figure. Turn depth is
irrelevant once prune count is controlled (`pruned=0` is 47–104 ms at *every* turn depth),
which kills the "big session = slow" intuition.

**Independent live proof, no log analysis:** a `/healthz` probe — a handler that touches no
DB, no upstream, and is excluded from the inflight counter (`server.ts:530,558-568`), so its
latency **is** loop-block time — recorded **max 4,675 ms** on `:7332` while under load.

**Why there are no error messages:** nothing fails. The block precedes the upstream call, so
no timeout fires and no upstream errors. Node is single-threaded, so each stall freezes every
concurrent request and every in-flight SSE stream simultaneously. The client simply waits.

### The amplifier

The K-pruner's non-convergence (`server.ts:814`/`:930` feed the **mutated** body into
`proxyAndRecord`, whose `finish()` at `:1108` hashes CacheLane's own stub text, defeating the
`is_stub` guard at `data-access.ts:310-320`) makes the prunable set grow **monotonically**
instead of decaying. Per-turn stub count observed ramping 68 → 91 → 127 → 261 → 378.
Each unit of that count costs ~45 ms of dead event loop. That is the hang.

---

## 2. Corrections to the prior brief

Five lenses independently overturned parts of my earlier evidence. Recording them so no
future analysis rests on them:

| # | Prior claim | Correction |
|---|---|---|
| C1 | `synchronous=FULL` forces an fsync per commit | **`synchronous=1` (NORMAL).** better-sqlite3 compiles `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`; nothing in `src/storage/` sets it. The FULL reading came from a `sqlite3`-CLI connection, not the proxy's. The WAL-stall mechanism does not exist. |
| C2 | 512 MB `MemoryMax` is being hit (F6) | **Refuted.** `memory.events`: `max 0 / oom 0` on both units; peak 23–25% of cap. Observed swap is host oversubscription (an unrelated 165 GB `python3`) on zram. |
| C3 | `NRestarts=0` proves no restart loop (F7) | **Invalid as evidence.** The healthcheck restarts via `systemctl restart`, which zeroes the counter. Use `ExecMainStartTimestamp`. |
| C4 | "Zero errors in journalctl" proves health (F7) | **Vacuous.** `logger.error` writes to a file, never stdout; journald receives only the 7 `console.*` sites. |
| C5 | The LiteLLM lane logged nothing | **Artifact of a bug.** `Logger` hardcodes `os.homedir()/.cachelane` (`logger/index.ts:33`), ignoring `CACHELANE_HOME`. `cachelane-litellm.service` has `ProtectHome=read-only` and `ReadWritePaths` excluding that path, so every `appendFileSync` throws EROFS into a bare `catch {}` (`:120-122`). **Verified: `~/.cachelane-litellm/` contains no `cachelane.log` at all.** That lane has never written an application log. |
| C6 | The 91–98% freelist is pruner churn | **Largely a one-time migration artifact.** `migrations/012_session_scoped_blocks.sql` rebuilds and `DROP`s the whole `blocks` table with no `VACUUM`. |
| C7 | The 45.3 MB WAL is pruner write volume | **Checkpoint starvation from multi-process readers.** Four processes hold `.cachelane-claude/cachelane.db` open. Decisive: the LiteLLM DB has ~3× the blocks, half the readers, and a **10× smaller** WAL. |
| C8 | My F8b benchmark refuted "SQLite blocks the loop" | **Correct in fact, but used to close the wrong inquiry.** It benchmarked only SQLite reads (7.4 ms). Production says the same synchronous section takes 1,141 ms median. The 154× residual was the tokenizer, which the benchmark never touched. |
| C9 | The `:7333` home is `~/.cachelane` | **`~/.cachelane` is a symlink to `.cachelane-claude`.** The unit is `cachelane-claude.service`; `cachelane.service` is inactive. Config edits must target the real path. |
| C10 | CacheLane was bypassed as of 22:07:51Z | **Incomplete — see §3.** |

---

## 3. Operator finding: the bypass was incomplete

**All five lenses independently found live traffic on `:7332`/`:7333` after the declared
cutover. I verified this myself.**

The on-disk config *is* correctly repointed — `grep` finds zero `127.0.0.1:733x` references
across `~/.pi/agent/models.json`, `~/.config/environment.d/50-cachelane-dispatch.conf`,
`~/.claude/settings.json`, `~/.claude.json`, `~/.bashrc`. But **processes started before the
cutover hold the old values in their inherited environment**, and so does everything they
spawn. Confirmed live:

| pid | started | still pinned to |
|---|---|---|
| `2597440` `claude` | 13:20 | `:7332` (+ `:7333` for its API traffic) |
| `3343481` `pi` | 14:31 | `:7332` |
| `56245` `agent-dispatch review` | **15:47** | `:7332` — spawned *after* the cutover, inheriting a stale parent env |

The env edit fixes new logins. It cannot reach a running process. Any A/B measurement taken
before those sessions are recycled compares CacheLane against CacheLane.

### Action taken (reversible, no restart, no deploy)

Since the pruner loop is the harm and config is re-read per request
(`server.ts:617` → `config/index.ts` `readFileSync` + Zod, no caching) with a short-circuit
at `k-pruning.ts:11-13` **before** the `rows.map` tokenizer loop, I set in **both**
`~/.cachelane-claude/config.json` and `~/.cachelane-litellm/config.json`:

```json
"pruner":   { "enabled": false },
"features": { "k_pruner": false, "mutation_enabled": false }
```

Backups: `config.json.bak-pre-pruner-off-20260731T225120Z` in each home.
Both lanes verified serving (`/healthz` 200 in <1 ms). This drives the 45 ms × N term to
zero on the very next request for the sessions still attached, which the env edit could not
reach. Reverse by restoring either backup — it takes effect on the next request.

`mutation_enabled=false` is also a **discriminating experiment**: with `forwardBody === body`
the extractor hashes true client content, the guard at `data-access.ts:310-320` holds,
`is_stub` survives, and the pruner *must* converge. Falsifiable in one session from
`turns.pruned_blocks_count`, which is already recorded.

---

## 4. Q2 — one causal chain, or two?

**Y-shaped, not linear.** One root — per-turn `O(session_blocks)` work driven by a
non-converging pruner — with two independent downstream branches:

- **Latency branch:** `O(blocks)` × 45 ms tokenizer = **the hang. This is the whole symptom.**
- **Storage branch:** `O(blocks)` rewrites of `turn_explanations.block_metadata` (avg 7,307 B,
  rewritten twice per turn at `server.ts:741-751` then `:1264`) plus `updateBlockCounters`
  UPDATEing every non-stub block per request (`data-access.ts:704-718`) = freelist churn.
  **Off the latency path.**

The 45.3 MB WAL is a **third, unrelated** problem (C7). Fixing the pruner fixes the hang and
will **not** fix the freelist — `block_metadata` enumerates all placements regardless of
`is_stub`.

---

## 5. Q3 — is body mutation sound?

**No, not as built.** The transform is sound only under three invariants, all violated:

- **I1 — idempotence + input/output separation.** `T(T(x)) == T(x)`, and nothing may observe
  `T(x)` where `x` is meant. Violated: `:814`/`:930` → `:1108`. *No transform whose output is
  its own input has a fixed point anyone chose.*
- **I2 — monotonicity** (prompt caching is prefix-keyed; once elided, always elided).
  Violated by `restoreStub` (`data-access.ts:355-365`) and by the ON-CONFLICT `ELSE` branch
  un-stubbing as a **side effect of recording**.
- **I3 — determinism from client-visible input only.** Violated by `db.allocateTurnNumber`
  (`server.ts:616`), a **per-HTTP-request** counter. Claude Code fans sub-agent requests under
  one session id, so blocks become eligible within three HTTP requests — the same second under
  fan-out. `added_at_turn` reaches **1748** in a session with 267 real turns, and two
  concurrent requests materialize **different stub sets for the same conversation**.

### Target architecture

1. **Layer 1 — pure transform.** `transform(parsedRequest, policy) -> {body, decisions[]}`.
   No DB, no clock, no counters. Elide a `tool_result` iff (a) `userMessagesAfter(block) >= K`
   counted **from the messages array itself**, (b) `byteLen >= MIN_BYTES`, (c) not pinned.
   Both predicates are monotone under append → **I2 by construction**; stub text is below
   `MIN_BYTES` → **I1 by construction**; identical across processes, restarts, DB loss and
   concurrency → **I3 by construction**. Removes `getPrunableBlocks`, `is_stub`,
   `unused_turns`, `added_at_turn` from the *decision* path entirely.
2. **Layer 2 — write-only ledger.** `blocks`/`turn_explanations` become telemetry nothing
   reads back. Enforce at the type level:
   `proxyAndRecord({forwardBody: ForwardBody, recordBody: OriginalBody})` as **distinct
   nominal types**, so `:1108` cannot compile against the mutated buffer.
3. **Layer 3 — hysteresis.** Elision *is* cache invalidation. Batch-convert all eligible
   blocks on a threshold crossing (prompt > X tokens), not per turn. Turns "one invalidation
   per turn" into "one per doubling" — the only shape where the arithmetic can close.
4. **Layer 4 — escrow, or stop lying.** `blocks` has **no content column**
   (`migrations/012:7-26`); `expandStub` returns only `{type:'tool_use', id}`
   (`pruner/tools.ts:93-101`); `compression_originals` has `retention.enabled: false` and
   **0 rows** in both DBs. The stub text advertises a `cachelane_expand` retrieval that is
   **structurally impossible**. Either store originals keyed by `sha256(content)` with real
   TTL/eviction, or remove the promise from `formatStubText` (`pruner/stubs.ts:13`).
5. **End state — invert it.** The proxy *advises* (response header enumerating elided ids, or
   the existing `cachelane_expand`/`cachelane_retrieve_tool_output`) and the **client** mutates
   its own transcript. The client is the sole authority on the conversation; that is the only
   place prune state can be authoritative. Requires a client change, hence 1–4 as interim.

### Honest self-critique

Even the corrected design may not pay. Caching charges 1.25× to write and 0.1× to read;
eliding at position *p* forces a 1.25× re-write of the `(N − p)` suffix to save 0.1× per turn.
Hysteresis helps but does not make the sign obviously positive.

**The live economics currently falsify the feature.** The lane that mutates *least* performs
*best*: LiteLLM (heavy pruning, 6,278 prune events) runs **37–41%** cache-read ratio; the
Claude lane (`marker_strategy: passthrough`, 159–564 events) runs **84–100%**.

Two further consequences worth stating plainly:

- **`blocks.token_count` is destroyed fleet-wide.** `markStubStmt` (`data-access.ts:349`)
  overwrote originals with stub sizes; live values are min 46 / max 112 / avg 82.7. Because
  `makeStubSummary` (`pruner/stubs.ts:4-7`) embeds `row.token_count`, every re-stub renders a
  *different* string → different hash → guaranteed guard miss. This is a **second, independent
  driver of the limit cycle**, and it means stubs read "(45 tokens elided)" for blocks that
  were thousands of tokens.
- **The pruner's savings telemetry is therefore fabricated.**
  `tokens_reclaimed = max(original_tokens − stub_tokens, 0)` (`server.ts:736-739`) computes
  stub-vs-stub after the first prune. **Any keep/kill decision citing CacheLane's own savings
  numbers is citing invented data.**

Recommend positioning the feature as **context-window headroom, not cost savings** — and
noting it is invisibly lossy: the model's context and the user's transcript diverge
permanently, which no proxy-side design fixes.

---

## 6. Q4 — sequenced plan

**Step 0 — done (§3).** Config-only, no restart. Pruner off on both lanes.

**Step 1 — the smallest code fix; best value/risk in the investigation (~5 lines).**
In `src/tokenizer/index.ts`, hold one module-scope `Tiktoken` from the package's exported
`getTokenizer()` and call `enc.encode(text.normalize("NFKC"), "all").length`. Identical
counts, 45 ms → sub-ms. Fixes the pruner path (`k-pruning.ts:58`), the post-response
extractor (`server.ts:1348` → `:55`), and `orchestrator/index.ts:64` in one edit.
**In-repo precedent:** `src/tokenizer/openai.ts:21-29` already caches encodings in a
module-scope `Map`; `src/tokenizer/index.ts:14-28` does not. Measured cached tiktoken:
0.28 ms — ~150× cheaper.
*Cheaper still, and sufficient for stubs alone:* stop calling the real tokenizer at `:58` —
the comment there already concedes a fallback multiplier is fine for ~80-token stub text.

**Step 2 — observability, before claiming anything is fixed.**
(a) Fix `Logger` to honour `CACHELANE_HOME` and stop swallowing write errors
(`logger/index.ts:33-34,120-122,143`) — otherwise the LiteLLM lane stays mute.
(b) Move the test suite off the production log/DB home (vitest inherits `CACHELANE_HOME`;
1,992 `listening` events and 258 PIDs are interleaved into the live Claude-lane log).
(c) Add `{req_id, session, bytes_in, bytes_out, t_ttfb_ms, t_upstream_ms, t_total_ms,
upstream_status}` spans at `server.ts:572` and `:1282`.
(d) Add a `server.on('clientError')` handler — Node's default destroys pre-parse sockets
silently, so a failed request never even logs `incoming`.
(e) Expose `/metrics`: `cachelane_proxy_overhead_seconds`, `cachelane_upstream_seconds`,
`cachelane_inflight` (`server.ts:527` already holds it and throws it away), `requests_total`,
`prune_events_total`, `wal_bytes`, RSS, plus an event-loop-lag histogram from
`perf_hooks.monitorEventLoopDelay()`.
(f) Drop `/etc/vmagent/scrape.d/cachelane.yml` copying the existing `litellm.yml` label
scheme — **a full VictoriaMetrics + vmagent + vmalert + Alertmanager stack is already running
and nobody used it** — and `/etc/vmalert/rules/cachelane.yml` alerting on overhead p99 >
250 ms, `inflight > 32` for 5 min, `rate(prune_events) > rate(blocks_inserted)` (the
convergence alarm), and RSS > 400 MB.

**Step 3 — bounds (all currently absent).**
`server.keepAliveTimeout >= 120000` with `headersTimeout` above it and `requestTimeout` sized
for multi-MB uploads; upstream **headers/first-byte** and **inter-chunk idle** timeouts with an
explicit 504; a bounded in-flight cap returning 503.
**Do NOT add a total-duration timeout** — legitimate agentic streams run for minutes.

**Step 4 — only if the pruner returns.** `recordBody` threading + nominal types (§5 Layer 2),
then the stateless monotone transform behind an experiment arm, with escrow enabled or the
`cachelane_expand` promise removed from the stub text.

**Step 5 — DB hygiene (ops, not code path).** Flip MCP processes to open the DB **readonly**
(`src/server/index.ts:139`); stop running `PRAGMA integrity_check` on every open
(`data-access.ts:268`); one offline `VACUUM` + `wal_checkpoint(TRUNCATE)` per home **with the
MCP servers stopped**; add retention on `turn_explanations`.

---

## 7. The live observable (the evidence standard)

**Primary gate — one number, known-bad today, needs no traffic, no API key, no test suite.**
Poll `GET /healthz` on `:7332` and `:7333` at 100 ms for 30 minutes while a real agentic
session runs. `/healthz` does no I/O and is excluded from the inflight counter, so its
latency **is** event-loop block time.

- **Known-bad (measured live, under load): max 4,675 ms on `:7332`, 2 samples > 3 s.**
- **Pass: max < 250 ms and ZERO samples above 1 s on both ports.**

*(Measured again post-mitigation with the lanes near-idle: `:7332` p50 1.0 ms / max 77 ms;
`:7333` p50 1.0 ms / max 9 ms. Green, but under near-zero load — this is not yet the gate,
which requires a real agentic session.)*

**Secondary gates, all from data that already exists:**

1. **The dose-response curve must flatten.** Re-run the `incoming`→`mutated request` delta
   bucketed by `pruned`. Today: `pruned=0` → 47 ms, `pruned 120+` → 6,715 ms; p99 8,034 ms.
   **Pass: median at `pruned ≥ 120` within 2× of median at `pruned = 0`**, and p99 < 100 ms
   over ≥ 500 turns with `pruned > 0`.
2. **Convergence — one SQL query, never run.** `turns.pruned_blocks_count` within a session
   must be **non-increasing** once the eligible set stops growing, and
   `sum(prune_events) <= count(distinct blocks)`. Today it ramps `0…88,88,88,90,90,90` and the
   ratio is **21×**.
3. **Zero orphaned requests:** every logged `incoming` must have a terminal span. Today
   21/365 and 10/249 have none.
4. **No proxy-initiated FIN:** hold an idle keep-alive socket to `:7333`; assert no FIN within
   120 s. **Today: FIN at 6.0 s** (verified myself: `:7333` 6.008 s, `:7332` 6.007 s, while
   LiteLLM:4000 was still open at 20 s), with `Keep-Alive: timeout=5` advertised.
5. **Economics gate before mutation is ever re-enabled:** per-session
   `cache_read / (cache_read + input)` from the live `turns` table, mutation-on vs
   mutation-off on the same workload. **Re-enable only if on > off.** Today 37–41% (mutating)
   vs 84–100% (near-passthrough).

**Do NOT accept end-to-end latency as evidence.** LiteLLM's own p50 swings 1.3 s → 180 s and
`litellm_llm_api_latency_metric` p50 tracks `litellm_request_total_latency_metric` p50 within
noise — the multi-minute latency is the **model**, not queueing. Upstream variance will swamp
any end-to-end measurement, which is exactly why the earlier 5×1-token probe was inconclusive.

---

## 8. Must-fix risks (severity-ordered)

| # | Sev | Risk | Mitigation |
|---|---|---|---|
| R-1 | **CRITICAL** | **The naive fix at `server.ts:814`/`:930` silently disables the feature.** `proxyAndRecord`'s single `body` param feeds **both** `extractAndInsertToolResults(body)` at `:1108` **and** `upstreamReq.write(body)` at **`:1163`**. Swapping to the original body forwards the unmutated request upstream — pruning silently off, looking fixed. | Thread a separate `recordBody` through `RecordOptions`; distinct nominal types. **The test must assert forwarded bytes ≠ recorded bytes.** |
| R-2 | **CRITICAL** | **Measurements taken now are invalid — the bypass is incomplete (§3),** and no request-rate metric exists so nobody can tell. | Recycle the stale-env sessions and confirm zero requests for 30 min *before* any baseline or A/B. |
| R-3 | **CRITICAL** | **Concurrent-request divergence.** `current_turn` is per-HTTP-request (`server.ts:616`); two concurrent requests in one session materialize different stub sets. Any stateful design reintroduces this. | Layer-1 statelessness. **Not fixable by patching the counter.** |
| R-4 | HIGH | **`blocks.token_count` is already destroyed fleet-wide.** Any migration or savings report reading it reads fabricated data. | Treat as unrecoverable; do not migrate forward. |
| R-5 | HIGH | **The test suite gives false assurance.** `storage.test.ts:1071` passes `content_hash:'same-hash'` on both inserts — the precondition production never satisfies. No test iterates >1 turn through prune/forward/extract; `extractAndInsertToolResults` has **zero** tests. A passing suite coexists with a 21× re-prune loop. | Add a **multi-turn closed-loop proxy test**: feed each turn's *forwarded* body back as the next turn's client history over ≥12 turns; assert `sum(pruned) <= distinct blocks` and non-increasing prune count. **Fails on turn 5 of `main` today.** Add the guard's negative case. |
| R-6 | HIGH | **No upstream timeout at all** (`server.ts:1114-1116`, `:412-429`). A backend that accepts and goes silent hangs the client forever — a second, independent hang mechanism the evidence cannot exclude. | Headers/first-byte + inter-chunk idle → explicit 504. Never a total-duration timeout. |
| R-7 | HIGH | **The LiteLLM lane is forensically blind** (C5). Every conclusion of the form "the LiteLLM lane logged nothing" is an artifact. | Fix before drawing any further log-based conclusion. |
| R-8 | MEDIUM | **The production log is the test log** (C5/§6 Step 2b). Unsegmented analysis produces phantom findings — one lens generated and killed a false "request leak" caused by exactly this. | Separate homes; until then **always segment by PID**. |
| R-9 | MEDIUM | **VACUUM/checkpoint against live readers** will block or fail; `wal_checkpoint(TRUNCATE)` cannot reset under a pinned read-mark. | Schedule offline with MCP servers stopped. |
| R-10 | MEDIUM | **Memory under concurrency.** Each in-flight request holds chunks + concat Buffer + parsed graph + full deep clone (`materialization.ts:9-26`) + `forwardBody` + the **entire retained response** (`server.ts:1098,1124`) ≈ 20–30 MB. The cap has never been hit, but a concurrency cap plus faster turnaround changes the arrival profile. | Parse usage incrementally from the SSE `message_delta`; bound in-flight. |
| R-11 | MEDIUM | **Silent SSE truncation.** 620 logged `socket hang up` + 102 `ENOTFOUND`; once headers are sent the handler does a bare `res.destroy()` (`server.ts:1156-1158`) — no error frame, no retry. **Indistinguishable from a hang.** | Emit an SSE error event before destroying; count it. |
| R-12 | MEDIUM | **Idle keep-alive teardown at 6.0 s** in front of origins holding idle connections >75 s, plus an HTTP/2 → HTTP/1.1 downgrade fanning one multiplexed connection into N short-lived TLS connections. Real and cheap to fix, but explains a minority tail — **not** the reported symptom. | Step 3. |
| R-13 | LOW | **The stub text advertises a retrieval that cannot happen** (§5 Layer 4), and `expand` side-effects `is_stub=0`, which any prefix-stable design must forbid. | Enable escrow or remove the promise; make `expand` non-mutating either way. |
| R-14 | LOW | **journald has no headroom.** `k-pruning.ts:80` emits the full pretty-printed `kinds` array — ~130 journal lines per request at 127 stubs. | Log a count, not the array; set explicit `RateLimit*`. |

**Explicitly deprioritized:** the 512 MB `MemoryMax` and 256-task cap (never approached);
the 91–98% freelist (~520 MB of disk, largely a migration artifact, off the latency path);
SQLite read latency (7.4 ms, correctly refuted — but that refutation was then used to close
the wrong inquiry; the 154× residual was the tokenizer all along). Host swap is
oversubscription from an unrelated 165 GB `python3` on zram — a capacity item, not CacheLane.
