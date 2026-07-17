# Runbook — CacheLane in front of LiteLLM (Phase 1a smoke, 2026-07-16)

Status: **Phase 1a PASSED** on epyc2. CacheLane (rebased onto upstream `a768b05`)
proxies both API formats to LiteLLM with byte-stable prefixes. K-pruning was NOT
a 1a gate (OpenAI pruning lands in Phase 2).

## Topology proven

```
curl/agent → CacheLane 127.0.0.1:7332 → LiteLLM 192.168.109.71:4000 (noauth) → vLLM qwen36-27b
```

## Setup used

Isolated home so the live `~/.claude` dispatch path is untouched:

```bash
export CACHELANE_HOME=~/.cachelane-smoke
node dist/cli/index.cjs proxy   # one run generates $CACHELANE_HOME/config.json
```

`config.json` deltas from defaults:

```json
"proxy": { "upstream_host": "192.168.109.71", "upstream_port": 4000, "upstream_ssl": false },
"features": { "auto_proxy": false }
```

Build: Node 22.22.1 works (`npm ci && npm run build && npm test` → 573 passed /
2 skipped). The `.nvmrc` Node 20 pin is obsolete — better-sqlite3 compiles
cleanly on 22 (INTEGRATION.md §7 correction).

## Smoke results (2026-07-16)

| Check | Result |
|---|---|
| OpenAI path `POST /v1/chat/completions`, qwen36-27b | 200, content round-trips |
| Anthropic path `POST /v1/messages`, qwen36-27b | 200, LiteLLM translates to Anthropic shape (thinking block present) |
| `cachelane stats` | records turns (6 turns from the smoke) |
| Byte-stability probe (3 identical requests) | `prefix_changed: false`, signals `prefix_cached, middle_cached`, `mutated: false` — no byte drift introduced by the LiteLLM hop |

## Known gaps → Phase 2 work items

1. **Tokenizer model-table is Claude-only** (`src/tokenizer/model-table.ts`).
   Non-Claude models throw `unsupported model` → `prefix token count
   unavailable` → pipeline-fallback turns on the Anthropic path. Phase 2 needs a
   generic fallback estimator (heuristic chars/4 or cl100k) so any LiteLLM model
   gets orchestration instead of fallback. This is the "generic any-model
   support" requirement.
2. **K-pruning is a no-op on the OpenAI path** (`server.ts` skip; extractor and
   materialization are Anthropic-shaped). Phase 2 core: ingest OpenAI
   `role:"tool"`/`tool_calls` as blocks, prune + materialize with OpenAI-shaped
   stubs, tests.
3. Cache hit ratio 0% on this route is expected: vLLM/qwen has no explicit
   prompt-cache tiers; realized savings on open-model routes come from
   K-pruning + accounting, not breakpoints (INTEGRATION.md §1 reframe).
