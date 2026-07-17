# Runbook — CacheLane in front of LiteLLM

Status (2026-07-17, epyc2):

| Stage | State |
|---|---|
| Phase 1a smoke | **PASSED** (2026-07-16) |
| Phase 2 OpenAI K-pruning | **COMMITTED** (`0b95a49`) + live-verified on :7332 |
| Shadow mode | **ON** (`features.mutation_enabled=false`) |
| Canaries (option 3) | **PASSED** 2026-07-17 — grok-4.5 / streaming / long context / multi-turn prune estimates |
| Live Pi `litellm.baseUrl` repoint | **NOT done** — separate confirmation required |
| Live pruning (`mutation_enabled=true`) | **NOT done** — next gated step after shadow soak |

## Topology

```
canary/curl → CacheLane 127.0.0.1:7332 → LiteLLM 192.168.109.71:4000 (noauth) → provider
```

Shadow semantics: proxy still intercepts, classifies, ages tool blocks, and records
would-have-pruned decisions (`mode:baseline`, `pruned:N`, `tokens_reclaimed`) but
forwards the **original unmutated body** upstream.

## Setup (isolated smoke home)

```bash
export CACHELANE_HOME=~/.cachelane-smoke
# config.json deltas from defaults:
#   proxy.upstream_host=192.168.109.71
#   proxy.upstream_port=4000
#   proxy.upstream_ssl=false
#   features.auto_proxy=false
#   features.mutation_enabled=false   # shadow
#   features.k_pruner=true            # still compute reclaim estimates
cd /srv/dev/ai/cachelane
node dist/cli/index.cjs proxy
```

Config is re-read per request — flipping `mutation_enabled` does not require a restart.

Build baseline: Node 22.22.1, `npm ci && npm run build && npm test` → 579 passed /
2 skipped after Phase 2. The `.nvmrc` Node 20 pin is obsolete.

## Phase 1a smoke results (2026-07-16)

| Check | Result |
|---|---|
| OpenAI path `POST /v1/chat/completions`, qwen36-27b | 200, content round-trips |
| Anthropic path `POST /v1/messages`, qwen36-27b | 200, LiteLLM translates to Anthropic shape |
| `cachelane stats` | records turns |
| Byte-stability probe (3 identical requests) | `prefix_changed: false`, signals `prefix_cached, middle_cached` |

## Phase 2 (code) — OpenAI K-pruning

Committed as `0b95a49` on `headroom-litellm-integration`:

- Ingest OpenAI `role:"tool"` messages as pruner blocks keyed by `tool_call_id`
- `materializePrunedBlocksOpenAI` stubs content in place (pairing invariant)
- Adapter-aware cost accounting + `tokens_reclaimed` stat
- Live mutation verify (pre-shadow): idle 6K-token tool output stubbed at K=3 on qwen

## Shadow + canaries (option 3, 2026-07-17)

Script: `scripts/canary-shadow.mjs`

```bash
export CACHELANE_HOME=~/.cachelane-smoke
# ensure mutation_enabled=false in $CACHELANE_HOME/config.json
node scripts/canary-shadow.mjs
# → /tmp/cachelane-canary-shadow.json
```

| Canary | Result |
|---|---|
| grok-4.5 short non-stream | 200 (~0.9s) |
| streaming SSE (qwen36-27b) | 200, SSE + `[DONE]` |
| streaming SSE (grok-4.5) | 200, SSE + `[DONE]` |
| long context (~32k system chars, qwen) | 200 (~1.6s, ~4k prompt tokens) |
| parallel tool_call ids (qwen) | 200 |
| multi-turn shadow prune (qwen, K=3) | turns 4–5: `pruned:2` + `mode:baseline`, `request_mutated=0`, ~2922 tok reclaim estimate |
| multi-turn shadow prune (grok-4.5, K=3) | turns 4–5: `pruned:2` + `mode:baseline`, `request_mutated=0`, ~2872 tok reclaim estimate |

Invariant across all canary turns: `request_mutated=0` and signals contain `mode:baseline`.

Sticky multi-turn sessions use header `x-claude-code-session-id`.

### Known issues found during canaries

1. **`blocks.id` is a global PRIMARY KEY** (not `(session_id, id)`). Two sessions that
   reuse the same `tool_call_id` (e.g. both use `call_1`) collide; the second
   insert is swallowed on UNIQUE and that session never ages/prunes those tools.
   Canary script uses per-session unique tool ids. Schema fix is a follow-up
   before broad multi-client traffic.
2. **Post-response extract UPSERTs `is_stub=0`**, so a block marked stubbed on the
   pre-request path is unmarked after the response is recorded if the client still
   re-sends the full tool message. Shadow estimates still fire each eligible turn
   (good for observation); live mode relies on body materialization rather than
   durable `is_stub` alone. Worth tightening before soak.
3. Anthropic-path tokenizer model-table is still Claude-centric (OpenAI/heuristic
   path via `countCompressionTokens` is fine for chat-completions).

## Next gates (do NOT skip)

1. **Shadow soak** — leave `mutation_enabled=false` and collect reclaim estimates on
   more sessions (optional: point a disposable client at :7332).
2. **Enable live pruning** — flip `mutation_enabled=true` on the smoke instance only;
   re-run canaries; confirm stubs land in the upstream body and agents still complete.
3. **Pi repoint** (separate confirmation): `~/.pi/agent/models.json` litellm
   `baseUrl` → `http://127.0.0.1:7332/v1` (upstream stays :4000). Rollback = one line.
4. Model-routing consolidation audit + 7-day soak (plan Task #12).

## Ops notes

- Proxy currently: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs proxy`
  (nohup from Phase 2 verify; binds `127.0.0.1:7332` only).
- Do **not** set `auto_proxy=true` or touch `~/.claude` / Pi baseUrl without an
  explicit go-ahead.
- Stats: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs stats`
- Explain latest: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs explain`
