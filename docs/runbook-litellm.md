# Runbook — CacheLane in front of LiteLLM

Status (2026-07-17, epyc2):

| Stage | State |
|---|---|
| Phase 1a smoke | **PASSED** (2026-07-16) |
| Phase 2 OpenAI K-pruning | **COMMITTED** (`0b95a49`) + live-verified on :7332 |
| Shadow mode | **PASSED** then graduated to live pruning |
| Canaries (option 3, shadow) | **PASSED** 2026-07-17 — grok-4.5 / streaming / long context / multi-turn prune estimates |
| Live pruning (`mutation_enabled=true`) | **ON + canary-verified** 2026-07-17 on smoke instance |
| Live Pi `litellm.baseUrl` repoint | **DONE** 2026-07-17 — `http://127.0.0.1:7332/v1` |

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
#   features.mutation_enabled=true    # LIVE pruning (was false during shadow)
#   features.k_pruner=true
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

## Live pruning canaries (2026-07-17)

Config flip (no restart; per-request loadConfig):

```bash
# ~/.cachelane-smoke/config.json
"features": { "mutation_enabled": true, "k_pruner": true, "auto_proxy": false, "keepalive": true }
```

Proof that the **upstream body is stubbed** (not just estimated): prompt tokens collapse at K=3.

| Model | turns 1–3 prompt toks | turn 4 | turn 5 | signals @4+ |
|---|---|---|---|---|
| qwen36-27b | 3187 → 3221 | **308** | **321** | `pruned:2`, `request_mutated=1`, no `mode:baseline` |
| grok-4.5 | 6339 → 6369 | **460** | **473** | `pruned:2`, `request_mutated=1`, no `mode:baseline` |

Decision-time reclaim on first prune fire: ~2874 (qwen) / ~2876 (grok).
Streaming (qwen) + short grok still 200 under live mode.
Artifact: `/tmp/cachelane-canary-live.json`.

Rollback to shadow: set `mutation_enabled=false` in `~/.cachelane-smoke/config.json` (hot).

## Next gates (do NOT skip)

1. ~~Shadow soak / live pruning~~ — **done** on smoke.
2. ~~Pi litellm baseUrl repoint~~ — **done** 2026-07-17 (see below).
3. **Model-routing consolidation audit** — measure coverage % (litellm vs openai-codex
   vs xai-auth); decide whether default `grok-4.5` stays on `xai-auth` or moves to
   `litellm/grok-4.5` so default traffic also hits CacheLane.
4. **7-day soak** with K-prune metrics + rollback drill.
5. Follow-ups before broad multi-client: `blocks.id` session-scoped PK; stop extract
   UPSERT from clearing `is_stub`.

## Pi litellm baseUrl repoint (2026-07-17)

| Field | Value |
|---|---|
| File | `~/.pi/agent/models.json` → `providers.litellm.baseUrl` |
| Before | `http://192.168.109.71:4000/v1` |
| After | `http://127.0.0.1:7332/v1` |
| Backup | `~/.pi/agent/models.json.bak-pre-cachelane-20260717T043930Z` |
| apiKey | unchanged (`noauth`) |
| CacheLane upstream | still `192.168.109.71:4000` |

Path now:

```
Pi (litellm/* models) → CacheLane 127.0.0.1:7332 → LiteLLM 192.168.109.71:4000 → provider
```

**Coverage note (not full fleet traffic):**
- Routes **through** CacheLane: any model under `providers.litellm` (`litellm/qwen36-27b`,
  `litellm/glm-5.2`, `litellm/gpt-5.6*`, `litellm/fable-5`, …).
- Stays **outside** CacheLane: `defaultProvider=xai-auth` / `defaultModel=grok-4.5`,
  and `openai-codex/*` (Responses API — no CacheLane adapter).
- Existing Pi sessions keep the old baseUrl until restart; **new** sessions load the
  repointed config.

Verify (disposable):
```bash
# already ran: qwen36-27b + glm-5.2 via :7332 → 200, request_mutated=1
CACHELANE_HOME=~/.cachelane-smoke node /srv/dev/ai/cachelane/dist/cli/index.cjs stats
```

**Rollback (one line):**
```bash
# restore backup, or:
python3 -c "import json,pathlib;p=pathlib.Path.home()/'.pi/agent/models.json';d=json.loads(p.read_text());d['providers']['litellm']['baseUrl']='http://192.168.109.71:4000/v1';p.write_text(json.dumps(d,indent=2)+chr(10))"
# then start a new Pi session
```

## Ops notes

- Proxy currently: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs proxy`
  (nohup from Phase 2 verify; binds `127.0.0.1:7332` only).
- Do **not** set `auto_proxy=true` or touch `~/.claude` / Pi baseUrl without an
  explicit go-ahead.
- Stats: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs stats`
- Explain latest: `CACHELANE_HOME=~/.cachelane-smoke node dist/cli/index.cjs explain`
