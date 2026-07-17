# CacheLane × Headroom × LiteLLM — Integration Plan

> Working notes for the `headroom-litellm-integration` branch.
> Goal: make CacheLane cache-discipline + pruning applicable to more than
> Claude, and fit it into the existing headroom / litellm model pipeline.

## 0. Status / baseline (2026-06-29)

- Fork created at `/srv/dev/ai/cachelane` from upstream `813a0bd`.
- Remote `upstream` → `https://github.com/Aditya-Tripuraneni/CacheLane.git` (no `origin` yet — add when we publish our own).
- Branch: `headroom-litellm-integration`.
- Baseline on Node 20.20.2 (`.nvmrc` = 20). CORRECTION 2026-07-16: Node
  22.22.1 builds and tests cleanly (better-sqlite3 compiles) — the Node 20 pin
  is obsolete.
  - `npm ci` ✅ (488 pkgs)
  - `npm run build` ✅
  - `npx tsc --noEmit` ✅
  - `npm test` ✅ (CORRECTION: ~573 cases / 72 files at the 2026-07-16 rebase
    onto upstream `a768b05`, not "572 tests")
- 2026-07-16: rebased onto upstream `a768b05`; Phase 1a smoke PASSED
  (`docs/runbook-litellm.md`); Phase 2 (OpenAI K-pruning) implemented — see §4.
- 2026-07-17: shadow canaries PASSED → live pruning ON → **Pi litellm baseUrl
  repointed** to `http://127.0.0.1:7332/v1` (backup
  `models.json.bak-pre-cachelane-20260717T043930Z`). Default `xai-auth/grok-4.5`
  and `openai-codex/*` still bypass CacheLane. Details: `docs/runbook-litellm.md`.
- 2026-07-17: coverage audit 7/11 enabledModels through CacheLane; 7-day soak
  started (`soak/START`, `cachelane-soak-snapshot.timer` every 6h).
- 2026-07-17: **default flipped** to `litellm/grok-4.5` (was `xai-auth/grok-4.5`).
  Coverage 9/11 enabledModels through CacheLane; openai-codex/* still bypasses.
- 2026-07-17: all LiteLLM GPT models enabled as litellm/* through CacheLane; openai-codex/* dropped from enabledModels; gpt-5.5/pro added. Coverage 14/14.

## 1. What CacheLane actually does (mechanism split)

| Mechanism | What it is | Provider applicability |
|---|---|---|
| **`cache_control` breakpoint placement** | Marks STABLE/SEMI region boundaries so Anthropic serves the prefix at 0.1× | **Anthropic only.** OpenAI/litellm-routed models have no explicit markers. |
| **Keepalive** | Pings before the 5-min/1-h cache TTL expires | **Anthropic only** (requires explicit cache + TTL tiers). |
| **K-pruning** | Replaces idle (≥K turns) tool outputs with a stub; restores via `cachelane_expand` MCP | **Provider-agnostic.** This is the cross-provider value. |
| **Tool-output compression** | lossless/balanced/aggressive JSON·log·shell compressors | Provider-agnostic. Overlaps **headroom**'s core. |
| **Stability gate** | SHA-256 over prefix to prove byte-identical re-sends | Provider-agnostic. |

**Headline reframing for the litellm fleet:** for non-Anthropic routes (qwen, glm, gpt-4o, opus via litellm, etc.) the 30–60% "cache savings" claim does **not** hold — those providers have weaker implicit prefix caching (OpenAI ~0.25–0.5×) or none. Realized savings on the open-model fleet come from **K-pruning + compression + accounting**, with breakpoint optimization as a bonus only on Anthropic routes. Set expectations accordingly before investing in porting.

## 2. Where the seams are (read this before coding)

- `src/providers/types.ts` — `ProviderAdapter` interface (9 methods). The pluggable I/O boundary. Already models tier-less/implicit-cache providers.
- `src/providers/registry.ts` — `selectAdapter(method, path)` routes by URL. Add a litellm-aware route here if needed.
- `src/providers/{anthropic-messages,openai-chat}.ts` — the two shipped adapters. CORRECTION 2026-07-16: the earlier claim was inverted — the **OpenAI** adapter's `applyCacheHints` is fully implemented (deep-sorts tools, injects `prompt_cache_key`); it is the **Anthropic** adapter's that is the stub (breakpoints stay in the orchestrator pipeline).
- `src/orchestrator/{index,breakpoint-placer,request-mutator}.ts` — **Anthropic-coupled**: operate on `AnthropicMessagesRequest`, inject `cache_control`. Needs to become provider-aware (delegate to `adapter.applyCacheHints`; no-op for implicit-cache providers).
- `src/pruner/` — K-pruning + stubs + materialization. Provider-agnostic in spirit.
- `src/proxy/server.ts` — routing + upstream forwarding; Bedrock/SigV4 already wired. Upstream host/port come from config.
- `src/config/defaults.ts` — `proxy.upstream_*` is how we point at litellm.
- `src/server/tools.ts` — MCP tools (`cachelane_expand`, `_stats`, `_explain`, `_health`). Provider-neutral.

Headroom side (integration target, not modified yet):
- `/srv/dev/ai/headroom/crates/headroom-proxy/src/proxy.rs` + `cache_stabilization/` + `compression/` — has its own prefix-stabilization + compression (overlap/conflict surface).
- `/srv/dev/ai/headroom/wiki/{integration-guide,proxy}.md` — headroom already speaks Anthropic **and** OpenAI `/v1` routes, and explicitly routes LiteLLM/anyllm through the `/v1` translated route.

## 3. Integration shape — three options

### Option A — Chain as two proxies (fast, risky)
`Pi → headroom(:8787) → cachelane(:7332) → litellm → provider`
- Pro: zero code, config only.
- Con: **double-pruning** — both layers stub/compress tool outputs. CacheLane's own README warns exactly about this ("one stripping content the other expects stub/refetch"). And litellm translates formats *after* CacheLane arranges bytes, which can shift/invalidate `cache_control` placement. Good for a smoke test only.

### Option B — CacheLane as the host layer, headroom as compression engine (RECOMMENDED)
Keep CacheLane as the cache-discipline + K-prune proxy pointing at litellm as upstream. Make the orchestrator provider-aware (Option-B2 below). Replace/augment CacheLane's lossy compressor with **headroom's `compress()` library** (call headroom `POST /v1/compress` or the Python lib) so the two never double-prune — CacheLane K-prunes, headroom compresses, mutually exclusive per block.
- Pro: each tool does what it's best at; single coherent pipeline; litellm stays the router; no format-translation-after-arrangement.
- Con: real code on the orchestrator generalization + a headroom bridge.

### Option C — Port CacheLane logic into headroom-proxy (Rust)
Move breakpoint-placement + K-pruning + keepalive into headroom's `cache_stabilization/` + a new module. Single binary.
- Pro: one process, one language.
- Con: large rewrite; loses upstream sync; duplicates work CacheLane authors are actively building. **Too early — revisit after we measure CacheLane empirically.**

## 4. Phased plan (assuming Option B)

- **Phase 1a — Prove the CacheLane↔litellm HTTP hop (self-contained, no live-traffic change).**
  Stand CacheLane up with `proxy.upstream_host=127.0.0.1`, `upstream_port=4100`, `upstream_ssl=false`, `auto_proxy=false` (run `cachelane proxy` manually; do **not** touch `~/.claude`). Send one Anthropic-format POST `/v1/messages` for a **self-hosted** model (`qwen36-27b`, free — vLLM on skynet3) through CacheLane; confirm round-trip + `cachelane stats` records a turn + K-pruning can fire after K turns. This also empirically exposes the "litellm translates bytes after CacheLane arranges them" concern. Output: a `docs/runbook-litellm.md` + one provider-route test. ✅ self-hosted model = free, ✅ no change to the live dispatch path.
- **Phase 1b — Decide the live-traffic seam (BLOCKER, user-owned).**
  The current dispatch path is **Pi → skynet MCP (`skynet_chat`) → litellm**, an in-process MCP call — NOT an HTTP call CacheLane can intercept by sitting on a base URL. So CacheLane can't just "sit in front" of the existing path. Three ways in:
  - **(a) New HTTP clients only** — Claude Code / a new Pi HTTP model adapter points at CacheLane → litellm. skynet MCP fleet unchanged. Lowest blast radius; CacheLane manages opt-in traffic.
  - **(b) Repoint skynet-mcp.py** to call litellm over HTTP through CacheLane instead of directly. All fleet traffic flows through CacheLane. Highest coverage, touches the dispatch primitive the user owns.
  - **(c) CacheLane as a parallel anthropic-format tier** for specific model classes only (e.g., the OpenAI/gpt routes that benefit from pruning), skynet stays direct for the qwen/glm fleet.
  This is an architecture decision for the dispatch owner — do **not** repoint skynet without explicit sign-off.
- **Phase 2 — Make the orchestrator provider-aware ("more than Claude").**
  Finish upstream's in-flight refactor: move breakpoint/keepalive injection behind `adapter.applyCacheHints`. For implicit-cache providers return the request unchanged (no `cache_control`), keep K-pruning + compression + accounting on. Add a litellm adapter (or route via `openai-chat` with model-aware `discountFactor`). This is the core of the multi-provider goal.
- **Phase 3 — Headroom as the compression engine.**
  Bridge CacheLane's `compressor/` to headroom `compress()` so lossy compression is headroom's job and CacheLane only K-prunes. Gate so a block is never both stubbed and compressed. Benchmark token cost CacheLane-only vs CacheLane+headroom on a recorded session.
- **Phase 4 — Package for the dispatch pipeline.**
  Ship as a Pi extension + litellm sidecar mirroring how `autocompactor` installs (`/srv/dev/ras/autocompactor`), so it slots into the existing agent-dispatch model-routing path.

## 5. Open decisions (need user input before Phase 1+)

1. **Integration shape** — **DECIDED 2026-06-29: Option B** (CacheLane hosts, headroom as compression engine).
2. **Phase-1 first target**: which litellm-routed model do we prove the chain on first — an Anthropic route (cache value applies) or an open-model route (pruning-only value)?
3. **Publish/origin**: do we create a GitHub remote under our org now, or keep local until the shape is settled? (Advisor: keep local until settled.)
4. **Double-pruning policy** if we ever chain: which layer owns tool-output reduction?

## 6. Infra facts discovered (2026-06-29)

- **litellm** runs as podman container `litellm-external` on `0.0.0.0:4100`, config `/etc/litellm/config.yaml` (HA on epyc1+epyc2; source repo `petabit-litellm/config/models.catalog.yaml`). `:4000` is a separate listener (redis-sentinel tier). CORRECTION 2026-07-16: **Pi's actual LiteLLM target is `192.168.109.71:4000` (no-auth)** — `:4100` is 401-gated. CacheLane's upstream is therefore `:4000`, per `docs/runbook-litellm.md`.
- Exposes **both** `/v1/messages` (Anthropic, 405 on GET = route exists) and `/v1/chat/completions` (OpenAI). `/health` needs auth (401). Master key readable via passwordless `sudo -n`.
- Models include self-hosted `qwen36-27b` (vLLM `192.168.109.73:8200/8201`, **free**), `qwen36-27b-skynet1` (`192.168.104.213:8200`), and paid `gpt-4o` / `gpt-5.5` (real OpenAI). Use `qwen36-27b` for free smoke tests.
- **Dispatch path is MCP-based, not HTTP**: Pi → `skynet` MCP server (`skynet-mcp.py` → `skynet_chat`) → litellm model_name alias. CacheLane (an HTTP proxy) therefore does not intercept the existing path by default — see Phase 1b.

## 7. Risks / caveats

- **Node 20 pin** — better-sqlite3 native bindings. Keep `.nvmrc`; CI/dev must use Node 20.
- **Cache-breakpoint value is Anthropic-bound** — see §1 reframe; don't over-promise savings on the open-model fleet.
- **Byte-stability vs litellm translation** — if litellm mutates request bodies after CacheLane arranges them, `cache_control` placement drifts. Keep CacheLane as the **last** hop before the provider when breakpoints matter; accept no-op breakpoints when they don't (Phase 2).
- **7 npm vulnerabilities (4 mod, 2 high, 1 crit)** in baseline deps — track but don't fix unrelated upstream issues yet.
