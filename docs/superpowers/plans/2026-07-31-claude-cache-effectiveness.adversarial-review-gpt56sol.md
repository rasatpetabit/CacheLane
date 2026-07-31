# Findings

## Blocker

### B1. The proposed warming condition prevents a growing middle cache from being written

The plan retains:

> `prevState.middle_hash === middle_hash`

A genuinely growing transcript changes the cumulative middle prefix whenever a completed assistant/user/tool exchange moves into history. Therefore:

- The hash normally changes every turn.
- The first appearance is not marked, so no explicit middle cache write occurs.
- The next appearance has a different hash, so it is still not marked.
- Equality may occur during retries or repeated tool-loop requests, but cannot support the claimed growing-history design.

The integration expectation that the middle hash “stabilizes for turns 3–9” directly contradicts the instruction to simulate growing history. This test would validate a static fixture, not a multi-turn conversation.

“Write then read” is also described incorrectly: an unmarked first request does not perform an explicit middle write. The design must separate:

1. A previously written anchor eligible for reading.
2. A new frontier to write for the next request.

That may require retaining a prior message breakpoint while placing a new frontier, subject to Anthropic’s breakpoint count and lookback rules. At minimum, the first eligible frontier must actually be marked.

### B2. “Everything except the trailing volatile suffix” is not a stable Anthropic prefix

Anthropic caching requires an exact cumulative prefix, not merely a structurally plausible conversation prefix. The plan assumes conversation history is append-only, but CacheLane’s pipeline can rewrite that history:

- A raw tool result can become a stub after aging.
- Prune eligibility can change between requests.
- Stub contents or metadata may be nondeterministic.
- Client markers are removed or relocated.
- Tool/system definitions, beta settings, model, TTL, or serialization may change.
- Older history is currently classified VOLATILE, which is evidence against blindly treating it as stable.

If any early block changes, every later breakpoint loses the exact-prefix match. Moving the breakpoint farther toward the end does not repair that invalidation.

The algorithm must operate on the final provider-visible representation and define one of these policies before implementation:

- Never mutate content once it has entered a cached prefix.
- Stub deterministically on first appearance.
- Place the cache anchor before the earliest content that may later mutate.
- Disable pruning for the controlled cache-effectiveness experiment.

The cache identity must cover the complete cumulative provider prefix, not only `messages[0..middle_end)`: tools, system, message content, relevant marker TTLs, model/configuration, and other provider cache-key inputs must be addressed.

### B3. The plan does not establish that a moving middle breakpoint can reuse the prior cache

The design assumes that removing the old middle marker and placing a single deeper marker will receive credit for the previously cached prefix. That depends on Anthropic’s explicit prefix-search/lookback behavior and block limits.

This is especially fragile when one turn contains:

- Parallel `tool_use` blocks.
- Multiple `tool_result` blocks.
- Mixed text and tool-result content.
- More blocks between the old anchor and new frontier than the provider searches.

A unit test cannot prove provider cache behavior. Phase 0 needs either a cited, applicable provider guarantee or a direct conformance probe covering:

1. A moving breakpoint within the lookback limit.
2. A movement exceeding that limit.
3. Retained old anchor plus new frontier.
4. Parallel tool blocks.
5. 5-minute and 1-hour TTL combinations.

Without this, the core algorithm is speculative.

### B4. The A/B design cannot prove “no regression versus Claude Code alone”

The raw Claude Code baseline is optional in Task 1.4, despite being central to the stated goal. Comparing only against the previous CacheLane build cannot establish that CacheLane stopped damaging Claude Code’s native marker strategy.

A valid experiment needs mandatory arms:

1. **CC pass-through:** preserve the original request and all client markers.
2. **Current/prefix-only CacheLane:** existing production behavior.
3. **Candidate CacheLane:** new marker planner.
4. Optionally, raw direct Anthropic as a transport sanity check.

The proposed “same session shape” also risks provider-cache contamination between arms. Running one arm can warm the other. The harness must isolate prefixes or counterbalance randomized arms with repeated sessions.

The gate is internally inconsistent:

- It claims to compare effective cost.
- It then fails based on `cache_read`, which is not cost.
- More reads can still lose after 1.25×/2× writes.
- A single 50-turn session has no noise or confidence rule.
- “Or document why the fixture cannot” converts a gate into a waiver.

Require cumulative and post-warmup effective input cost, cache writes, cache reads, errors, and confidence/sample thresholds. The CC-alone arm must not be optional.

## High

### H1. “Attribution” is causal language unsupported by the available telemetry

A signal such as `attribution:cachelane` only proves that CacheLane mutated the request. It does not prove that returned `cache_read_tokens` came from:

- CacheLane’s prefix breakpoint.
- CacheLane’s middle breakpoint.
- A client-created cache entry.
- Provider automatic caching.
- A cache warmed by a previous experimental arm.

Anthropic usage is aggregate; it does not award read tokens to individual breakpoints. Likewise, `prompt_cache_key` does not prove that all OpenAI cached tokens were caused by CacheLane.

Replace attribution with request-strategy/provenance fields, such as:

- Incoming client markers.
- Emitted marker topology, positions, and TTLs.
- CacheLane mutation strategy.
- Provider automatic-cache capability.
- Observed aggregate provider usage.
- Causal attribution: `unknown` except where established by an isolated experiment.

`middle_cached` must not be emitted merely because a hash matched or a marker was placed. Use `middle_marker_emitted`; estimate incremental middle reads only in a controlled prefix-only comparison.

### H2. `anthropic_v1` is not automatically apples-to-apples across providers

The providers expose different token semantics:

- Anthropic input, cache-read, and cache-creation fields are generally separate components.
- OpenAI prompt tokens commonly include the cached-token subset.

Applying the same expression directly can double-count OpenAI cached tokens or invent an Anthropic-style write cost that OpenAI does not report.

Phase 0 must normalize adapter data first into explicitly defined fields such as:

- Logical input tokens.
- Uncached input tokens.
- Cache-read tokens.
- 5-minute and 1-hour write tokens.
- Missing/unavailable fields.

A hypothetical Anthropic weighting applied to OpenAI should be labelled a normalized token-reuse index, not provider cost savings. Provider-native cost requires exact model family, price version, and field semantics.

### H3. The marker policy is not a global TTL-safe planner

“Preserve one deepest message marker” is insufficient. Marker legality and TTL ordering apply across tools → system → messages as one ordered prompt.

For example, preserving a deeper 1-hour client marker while emitting an earlier 5-minute CacheLane prefix marker violates the plan’s own “no 1h after 5m” invariant. The plan does not specify whether to upgrade, remove, or reject one marker.

The implementation needs one global planner that accounts for:

- All incoming marker locations and durations.
- Provider breakpoint-count limits.
- Legal content-block attachment points.
- Global TTL ordering.
- Static prefix, retained read anchor, and new write frontier.
- Fail-preserve behavior when a safe transformation cannot be proven.

Blindly stripping all tool/system markers may itself regress CC-alone behavior by changing TTL or removing a valuable anchor.

### H4. Tool-loop detection is underspecified and partly misframed

A marker does not reorder messages, so “keep tool pair adjacency” is not enough. The hard part is finding a legal, useful content-block boundary.

A role-level trailing-run function will mishandle:

- User messages containing only `tool_result`.
- User messages mixing text and tool results.
- Multiple and parallel tool uses.
- Partial or unmatched tool IDs.
- Several tool iterations for one human turn.

The plan needs a content-block state machine keyed by tool-use IDs and a conservative fallback. It must also justify why the current request’s final user/tool-result content is excluded: at request time it is already immutable input and is often the best new write frontier. “Read anchor” and “write frontier” should not be conflated into one `middle_end`.

### H5. The path split can still hide regressions

`hook`, `proxy`, and `fallback` are not necessarily mutually exclusive path values. A hook request may also fail over. The proposed ternary classification can hide fallbacks depending on precedence.

Additionally:

- Zero usage on hook rows may mean “not observed,” not a true zero.
- Hook rows may be duplicate telemetry rather than independent turns.
- Reporting only the improved proxy line can conceal a route-share shift or end-to-end regression.

Store route and outcome as separate dimensions. Report:

- End-to-end totals.
- Stratified totals.
- Route share over time.
- Missing-usage rate.
- A fixed-route-mix standardized comparison.

The runbook must not simply instruct operators to ignore the hook line.

### H6. Phase 0 is not sufficient to make the A/B trustworthy

Aggregate signals and a snapshot script are not enough. An instrumentation-only release must capture, per request:

- Build/config version and experiment arm.
- Session/turn/model.
- Incoming marker topology.
- Final emitted marker topology and TTLs.
- Exact cumulative-prefix hashes at each emitted breakpoint.
- Prune/stub transformations and before/after estimates.
- Provider cache-read and cache-creation usage.
- Route, outcome, and whether usage is missing.

This instrumentation must soak before Phase 1 so the CC-alone baseline is measured rather than reconstructed after behavior changes.

## Medium

### M1. The success criteria measure marker engagement, not effectiveness

A 60% `middle_cached` signal rate can be satisfied by local inference without one provider token being read from the middle region.

Use eligible candidate proxy turns as the explicit denominator and require observed incremental cache reads over a prefix-only arm. Also partition by model, build, session length, and route; a global `turn_number >= 20` median can mix unrelated populations.

“Beyond plateau,” “beyond noise,” and “existing health threshold” need numeric definitions.

### M2. Prune accounting is at risk of becoming another misleading savings claim

`tokens_reclaimed` should distinguish:

- Blocks selected for pruning.
- Blocks actually replaced.
- Estimated tokens removed.
- Provider-billed tokens avoided.

The last item is counterfactual and cannot be inferred merely from stub length. Label reclaimed tokens as an estimate unless an isolated comparison proves billed savings. Use the applicable tokenizer and record before/after provider-visible content.

### M3. Key architecture decisions are improperly deferred to implementation

These are not test-forced details:

- First middle write policy.
- Read-anchor versus write-frontier design.
- Volatile suffix semantics.
- Client-marker ownership and TTL conflict resolution.
- Whether pruning may mutate cached history.
- Meaning of `middle_cached`.
- Whether SEMI classification remains part of the architecture.

The stated goal says “growing SEMI history,” while Phase 1 explicitly bypasses SEMI classification. Resolve that design contradiction before assigning workers.

### M4. A reorderer is not the demonstrated fallback

Reordering cannot repair an unstable exact prefix caused by pruning or nondeterministic stubs, and it risks semantic changes. The fallback decision should follow provider-conformance and wire-stability evidence, not merely a failed cache-read metric.

## What the Plan Gets Right

- It correctly identifies stripping Claude Code markers as a likely regression source.
- It prioritizes measurement before broad behavior changes.
- It recognizes that LiteLLM headline savings are not evidence for the Anthropic design.
- It preserves the no-arbitrary-reordering constraint and calls out tool semantics.
- It includes production snapshots, dual-home deployment discipline, fail-open testing, and prune-accounting investigation.

# Verdict

## Minimal Patch List Required Before Implementation

1. Replace hash-equality warming with an explicit read-anchor/write-frontier design; first eligible middle prefixes must actually be written.
2. Define cache stability over the final provider-visible cumulative prefix, including a deterministic policy for prune/stub transitions.
3. Add a Phase 0 provider-conformance probe for moving breakpoints, lookback limits, parallel tools, retained anchors, and TTL combinations.
4. Replace local “attribution” with marker provenance and observed usage; rename inferred `middle_cached` signals.
5. Normalize provider token semantics before presenting any cross-lane weighted metric.
6. Implement one global marker planner covering client markers, TTL ordering, legal block positions, and breakpoint limits.
7. Make CC pass-through, current CacheLane, and candidate CacheLane mandatory isolated A/B arms with numeric cost and regression gates.
8. Separate route from outcome, represent missing hook usage as missing, and retain an end-to-end regression view.
9. Resolve the first-write, suffix, pruning, SEMI, and marker-ownership decisions in the plan rather than during implementation.

**REJECT**