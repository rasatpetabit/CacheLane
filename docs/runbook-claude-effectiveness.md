# Claude cache effectiveness runbook

CacheLane's Claude lane is native Anthropic on port `7333`. Never point Claude Code at LiteLLM. LiteLLM's OpenAI-style automatic-cache counters are not evidence that CacheLane's Anthropic marker planner works.

## Marker strategies

`features.marker_strategy` is hot-reloaded with the rest of `config.json`:

- `passthrough`: preserve incoming Claude Code markers; do not update CacheLane frontier state.
- `prefix_only` (default): current production behavior; own one tools/system marker.
- `candidate`: bounded static-prefix/read-anchor/write-frontier planner.

Keep production on `prefix_only` until the conformance and three-arm gates below pass.

## Direct-provider conformance

```bash
node scripts/anthropic-cache-conformance.mjs \
  --out ~/.cachelane-ops/conformance-$(date +%Y%m%d-%H%M%S).json
```

The suite uses Claude OAuth directly and covers moving breakpoints, the four-breakpoint limit, retained anchors, parallel tools/results, legal and illegal TTL ordering, prune/stub invalidation, and Claude-Code-shaped pass-through growth. Any false gate blocks candidate deployment.

Verified 2026-07-31 with `claude-haiku-4-5-20251001`: all ten v3 gates passed, including the >20-block retained-anchor case. Durable evidence: `~/.cachelane-ops/conformance-2026-07-31-v3.json`.

## Three-arm gate

```bash
node scripts/claude-ab-cache-probe.mjs \
  --sessions 3 --turns 20 \
  --out ~/.cachelane-ops/claude-ab-$(date +%Y%m%d-%H%M%S).json
```

Each arm/session receives a byte-distinct but token-length-matched stable prefix. The report records marker topology on every request. Candidate passes only when it has no provider errors, is within 5% of Claude Code pass-through, beats prefix-only cost, grows reads beyond its static prefix, and emits distinct topologies.

The earlier v4 run passed the old gates but is superseded because its candidate arm approximated rather than executed the production planner. Corrected production-planner attempts v5–v7 were blocked by Anthropic OAuth rate limits (`429` on nearly every request); they are failure evidence, not acceptance evidence. Candidate deployment remains blocked until a fresh corrected run passes all gates.

## Stats and snapshots

```bash
node scripts/stats-dual.mjs
node scripts/effectiveness-snapshot.mjs --label post-instrumentation \
  >> ~/.cachelane-ops/effectiveness.jsonl
```

Read both end-to-end and route/outcome strata. `token_reuse_index = cache_read / logical_input`; it is not USD savings. Marker signals are provenance only. Causal cache claims require the isolated experiment.

## Rollout

1. Build and install to `/srv/cachelane` using project-local installer/runbook.
2. Snapshot before changing behavior.
3. Drain-restart the Claude lane first; leave LiteLLM routing unchanged.
4. Canary `marker_strategy: candidate` only after reviewing the durable gate files.
5. Snapshot and inspect provider errors, usage-missing rate, and effective input units.
6. Roll back to `prefix_only` immediately on regressions.
