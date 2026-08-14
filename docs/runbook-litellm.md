# Runbook — CacheLane in front of LiteLLM

How to operate the LiteLLM lane (`:7332`) and the shared dual-proxy install on
this host. Claude-lane marker gates live in
[runbook-claude-effectiveness.md](runbook-claude-effectiveness.md).

**Kind:** current-state. Dated canaries, coverage tables, and the 2026-07-17
rollout diary: [runbook-litellm-history.md](runbook-litellm-history.md).

## Topology (this host)

```
Pi litellm/*                     → CacheLane :7332 → 127.0.0.1:4000 (LiteLLM)
agent-dispatch gateway-client    → CacheLane :7332 → LiteLLM
skynet MCP (when still spawned)  → CacheLane :7332/v1 → LiteLLM
Claude Code                      → CacheLane :7333 → api.anthropic.com   (NOT LiteLLM)
openai-codex/*                   → Responses API (bypasses both)
```

Three URL surfaces — do not mix them:

| Surface | This host |
|---|---|
| Client → CacheLane (Pi) | `http://127.0.0.1:7332/v1` in `~/.pi/agent/models.json` `providers.litellm.baseUrl` |
| CacheLane → LiteLLM (proxy upstream) | `~/.cachelane-litellm/config.json` `proxy.upstream_*` = `127.0.0.1:4000` `ssl=false` |
| Client bypass (skip CacheLane) | point `baseUrl` at LiteLLM directly (`http://127.0.0.1:4000/v1`; older backups used `http://192.168.109.71:4000/v1`) |

Live flags: [operations/lane-state.md](operations/lane-state.md).
The LiteLLM home currently has `mutation_enabled=false` and `k_pruner=false`.
A 2026-07-17 canary that ran with mutation on is history, not current state.

## Health

Units are **system** units (`WorkingDirectory=/srv/cachelane`), not user units.

```bash
systemctl is-active cachelane-litellm.service cachelane-claude.service cachelane-healthcheck.timer
curl -fsS http://127.0.0.1:7332/healthz
curl -fsS http://127.0.0.1:7333/healthz
node /srv/cachelane/scripts/health-dual.mjs
```

`GET /healthz` is process-local. It does not call LiteLLM, Anthropic, SQLite, or
the pipeline. `/usr/local/sbin/cachelane-healthcheck` (source:
`scripts/cachelane-healthcheck.sh`) requires three consecutive local misses plus
an idle drain before it restarts a lane.

`ProtectSystem=strict` plus `ReadWritePaths` requires every listed directory to
exist. If `~/.cachelane-smoke` (or a sibling) was deleted, the LiteLLM unit
crash-loops with `Failed at step NAMESPACE`. `mkdir -p` the missing path, then
`systemctl restart cachelane-litellm.service`.

## Install / restart

[operations/production-install.md](operations/production-install.md). Short form:

```bash
# from the checkout, as the service user — not sudo
CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh
scripts/install-runtime.sh
```

The installer drain-restarts Claude (`:7333`) first, then LiteLLM (`:7332`).
Drain timeout aborts; it does not force a restart. Do not start
`cachelane proxy` by hand against a port a unit already owns.

## Stats

Two homes. Do not mix them.

```bash
node /srv/cachelane/scripts/stats-dual.mjs

CACHELANE_HOME=~/.cachelane-litellm node /srv/cachelane/dist/cli/index.cjs stats --scope all
CACHELANE_HOME=~/.cachelane-claude  node /srv/cachelane/dist/cli/index.cjs stats --scope all
```

`token_reuse_index` is `cache_read / logical_input`, not USD savings. LiteLLM
OpenAI-style cached-token fields may reflect provider automatic caching; they
do not prove the Anthropic marker planner. CLI `--version` prints `0.0.1`
regardless of `package.json` (`1.1.7`); use `/srv/cachelane/GIT_SHA`.

MCP (after Claude Code reload): server `cachelane` → Claude home;
`cachelane-pi` → LiteLLM home. Tools: `cachelane_stats`, `cachelane_explain`,
`cachelane_expand`, `cachelane_retrieve_tool_output`, `cachelane_health`.

## Client rollback

Restores `~/.pi` / `~/.claude` `.bak-pre-*` files. Does **not** restore
`/srv/cachelane`.

```bash
DRY_RUN=1 scripts/rollback-client-config.sh
DRY_RUN=0 scripts/rollback-client-config.sh
```

LiteLLM bypass (next Pi session) — edit `~/.pi/agent/models.json`
`providers.litellm.baseUrl` to the listener that is actually up:

```text
http://127.0.0.1:4000/v1
```

Or restore a `.bak-pre-*` via `rollback-client-config.sh` above. Do not paste a
host-specific IP from history without checking that it still answers.

Stop proxies: `systemctl stop cachelane-litellm cachelane-claude` (system
units). There is no `systemctl --user` pair for these.

## Shadow vs live mutation

When `features.mutation_enabled` is false, the proxy still intercepts and may
record would-have-pruned decisions (`mode:baseline`) but forwards the original
body. Flip is hot (config re-read per request). Do not flip LiteLLM mutation
on without reading [lane-state.md](operations/lane-state.md) and the hang notes
in [routing-state.md](operations/routing-state.md).
