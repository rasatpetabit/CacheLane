# Hang remediation — implementation notes

Companion to `spec-hang-remediation-v4.md`. That spec was written before any
code; this records where implementing it proved it wrong, and what was done
instead. Read it alongside the spec rather than in place of it — everything not
mentioned here was built as specified.

> **Deployment state — updated 2026-08-06.** The paragraph that stood here said *"Nothing here is
> deployed. `/srv/cachelane` still runs `3883ee7`."* That was true on 2026-07-31 and is now
> false. `/srv/cachelane` runs **`b7fc668`** (= repo HEAD, `INSTALLED_AT` 2026-08-05T19:39:40Z);
> the deployed `dist/index.cjs` contains the `elision_mode` arm flag, the stateless
> `cachelane:elided` transform, and `safeFallbackConfig`. **The code below is deployed.**
>
> The observability last mile was closed later the same day (2026-08-06): the scrape fragment
> and alert rules were landed in the Ansible source of truth (`roles/cachelane/` and
> `observability/vmalert/cachelane.yml` in the sysadmin repo) and deployed — both lanes scraped,
> all rules loaded, `/healthz` probe latency exported via the healthcheck's textfile metrics.
> The recurrence alarm is armed, though Alertmanager is host-wide in bare mode, so firing
> alerts notify nobody. Current state lives in `docs/operations/routing-state.md`.
>
> Production is held safe by configuration, not by the absence of code: as of 2026-08-06 both
> homes carry `pruner.enabled: false`, `k_pruner: false`, `mutation_enabled: false` and an
> explicit `elision_mode: "stateless"`. The Claude home previously had `pruner.enabled: true`,
> leaving a single latch between it and the *legacy* pruner; that asymmetry is closed.
>
> Both proxies are also currently **out of the traffic path entirely** — the 2026-07-31 bypass
> severed both lanes, not just Claude. See `docs/operations/routing-state.md`.

## Corrections to the spec

### C11 — `inflight > 32` is an alert that can never fire

§8 Step 2(f) asks for an alert on `inflight > 32`. That number was written when
the in-flight cap was 64. Step 3's own admission bound was implemented at
`MAX_INFLIGHT_REQUESTS = 16` — the 64 figure came with an arithmetic error in
its justifying comment (64 × ~30 MB was described as fitting inside a 512 MB
cap; it is ~1.9 GB). The proxy sheds with 503 *at* the cap, so
`cachelane_inflight` can reach 16 and never exceed it.

Carried over unchanged, the alert would have loaded cleanly, evaluated forever,
and never fired. Implemented at **`> 12`** — 75% of the real cap.

### C12 — there is no overhead metric to alert on

§8 Step 2(f) asks for `overhead p99 > 250 ms`, and Step 2(e) lists
`cachelane_proxy_overhead_seconds` among the metrics to export. Splitting proxy
overhead from upstream time cleanly would mean instrumenting the boundary on
both the request and streaming-response sides; what exists is
`cachelane_request_duration_seconds`, which is end-to-end.

Alerting on end-to-end duration would page on a slow model. It also contradicts
the spec's own §9 closing paragraph, which says in as many words not to accept
end-to-end latency as evidence, because LiteLLM's p50 swings between 1.3 s and
180 s on upstream variance alone.

`cachelane_event_loop_lag_seconds` is the signal that was actually wanted: the
failure was synchronous work on the request path, lag is its direct signature,
and waiting on a socket does not contribute to it. The latency alerts are on
lag, at the 250 ms threshold the spec named, plus a critical at 3 s (the
incident itself measured 6,715 ms median at the pathological depth).

### C13 — Layer 4's promise was removed rather than built

§6 Layer 4 offers a choice: build escrow with `(workspace_id, session_id,
sha256)` ownership, or remove the retrieval promise from the stub. The stateless
transform takes the second option. `blocks` has no content column,
`compression_originals` has zero rows in both production homes, and
`expandStub` returns only `{type:'tool_use', id}` — so
`cachelane_expand(block_id=…)` is an invitation to a call that cannot succeed.

The new stub says what happened and nothing more:

```
[cachelane:elided toolu_01ABC] 8000 bytes of tool output removed from this turn's context.
```

The legacy stub text is unchanged; the two arms emit different stubs, which is
itself a way to tell which one produced a turn. Escrow remains available to
build later, and the ownership requirements in §6 Layer 4 still stand if it is.

### C14 — `k_pruner` never applied to the Anthropic lane

Not a spec error but a pre-existing defect found while wiring the arm:
`features.k_pruner` was only ever checked on the OpenAI path
(`server.ts:814`). The Anthropic path went through `handlePreRequest`, which
consulted `pruner.enabled` alone. A flag named for the feature did not turn the
feature off on the lane carrying most of the traffic.

Both arms and both providers now check both switches. Production was never
exposed to this, because the Step 0 mitigation set `pruner.enabled: false` and
`mutation_enabled: false` as well as `k_pruner: false`.

### C15 — arm selection and mutation are separate questions

Caught in review. Gating *which implementation runs* on `mutation_enabled`
dropped the mutation-off case into the legacy branch and recorded it as
`elision_mode: "legacy"`.

That case is Gate 5's own control lane. Mislabelled, the experiment would have
compared stateless-with-mutation against **legacy**-without-mutation, and
attributed the difference to mutation. `elision_mode` now selects the
implementation and nothing else; `mutation_enabled` independently decides
whether that implementation actually elides.

### C16 — an elided body was being computed and then thrown away

Found while auditing the wiring, and it would have made the whole feature a
silent no-op on a subset of turns. The proxy decides whether to forward the
transformed body from `result.mutated`:

```ts
const actuallyMutate = config.features.mutation_enabled && (compressionMutated || result.mutated);
const forwardBody = actuallyMutate ? Buffer.from(JSON.stringify(result.request)) : body;
```

But `mutated` came straight from `orchestrate()`, which reports only whether
**it** placed cache breakpoints — and it places none on a request with no system
prompt and no tools. So such a request would be elided, the saved bytes
recorded, and the original forwarded anyway.

`mutated` now means what the caller reads it as: the forwarded body differs from
the client's. Elision counts. This affected the **legacy** path identically and
is fixed there too.

### C17 — `up == 0` cannot see a target that was never scraped

Review caught this in the alert rules. `up == 0` matches only a series that
exists; if the scrape fragment is removed — precisely the Ansible-overwrite risk
the deploy README warns about — the series disappears and every alert in the
file goes quiet. Silence then reads exactly like health. Added
`CacheLaneScrapeConfigMissing`, using `absent()` named per lane, since
`absent()` over a selector matching one live lane returns nothing even when the
other is gone.

Also corrected: the memory threshold was `400e6` against a `MemoryMax` of
536870912, which is 512 **MiB**. That is 74.5%, not the 78% the comment claimed.
Now `419430400` (400 MiB), which really is 78%.

### C18 — `elision_mode` alone cannot answer Gate 5's question

`elision_mode` deliberately records the *configured* arm, including turns where
a kill switch stood it down — that is what keeps the control lane from being
filed under "legacy" (C15). The cost is that "the arm ran and saved nothing"
became indistinguishable from "the arm never ran", and Gate 5 must not average
the second into the first. Provenance now carries `elision_active` alongside
`elision_mode` so the two can be separated.

### C19 — a config typo could silently re-enable the outage

The worst finding of the whole effort, and it was introduced by this work.

Adding `elision_mode` as a bare zod enum means an invalid value fails the
*entire* parse, and `loadConfig`'s error path then replaced the whole config
with `DEFAULT_CONFIG` — whose defaults enable mutation, `k_pruner` and the
pruner. Reproduced against the real production file with one letter changed:

```
AFTER TYPO -> mutation_enabled: true | k_pruner: true | pruner.enabled: true
```

Those are the three switches currently holding production safe. A typo in an
unrelated field would have turned all three back on, silently, at proxy start.

Two fixes, because the second is the general case:

- `.catch("legacy")` on the enum contains a bad arm value locally, so the rest
  of the file still parses and its settings survive;
- `loadConfig`'s fallback is now `safeFallbackConfig()`, which returns defaults
  with `pruner.enabled`, `k_pruner` and `mutation_enabled` forced **off**. A
  configuration we could not read is not a mandate to start rewriting requests.

The pre-existing hazard was broader than the field that exposed it: *any*
unparseable value in the file had this effect. It is closed for all of them.

## Gate status

| gate | status |
|---|---|
| Primary (`/healthz` max < 250 ms at depth) | **not run** — needs a deployed build under load |
| 1 — dose-response flattens | **not run** — production measurement |
| 2 — determinism, monotonicity | **met in tests**; slope bound is a production measurement |
| 3 — multi-turn closed loop | **met** — `transform.test.ts`, feeding original growing history forward |
| 4 — connection lifetime | **met** — `bounds.test.ts` |
| 5 — economics | **not run**; the arm and its provenance now exist to run it |
| 6 — zero orphaned requests | **instrumented** — terminal spans land on every path; needs production data |

Gates 1, 5 and the primary gate cannot be satisfied before deployment. Gate 2's
fitted slope is deliberately *not* asserted in the unit suite: a wall-clock
bound there measures the host, not the algorithm. What the suite pins instead is
the mechanism — the transform module has no imports at all, so it cannot reach
the tokenizer by any path, transitively or otherwise.

## What is still open

- **Layer 3's `K_eff` band is implemented but unmeasured.** `f` is non-increasing
  and the band input is the incoming user-message count, so the invariants hold.
  Whether `k: 8` at band 0 with a floor of 2 is a *good* policy is a Gate 5
  question, not a correctness one.
- **Layer 5 (invert it — the client mutates its own transcript)** is untouched.
  It needs a client change and remains the honest end state.
- **`expand` still mutates** (`is_stub = 0`). Any prefix-stable design forbids
  that; it is not on the stateless arm's path, but it blocks flipping the MCP
  processes to open the database read-only (§8 Step 5).
- **DB hygiene** — the offline `VACUUM` + `wal_checkpoint(TRUNCATE)` per home,
  with the MCP servers stopped, is deferred to the deployment window.
- **`blocks.token_count` is destroyed fleet-wide** and no migration repairs it.
  The stateless arm sidesteps it by measuring bytes, but any historical savings
  figure remains invented.
