# Current lane flags and client wiring

Whether each proxy is in the traffic path, and which feature latches are open.
Re-derive from the files in the tables — do not trust a remembered status.

**Kind:** current-state. Last opened this rebuild: `~/.cachelane-{claude,litellm}/config.json`,
`~/.claude/settings.json`, `~/.pi/agent/models.json`, live systemd units.

Incident / restore narrative: [routing-state.md](routing-state.md).
How the units got there: [production-install.md](production-install.md).

## In the path?

| Lane | Unit | Client wiring | This host |
|---|---|---|---|
| Claude | `cachelane-claude.service` | `ANTHROPIC_BASE_URL=http://127.0.0.1:7333` in `~/.claude/settings.json` `env` | **yes** — new Claude Code sessions only |
| LiteLLM | `cachelane-litellm.service` | `providers.litellm.baseUrl` = `http://127.0.0.1:7332/v1` in `~/.pi/agent/models.json` | **yes** — next Pi dispatch |

Bypass Claude: unset `ANTHROPIC_BASE_URL` (running sessions keep the path they started with).
Bypass LiteLLM: point `baseUrl` at the LiteLLM listener itself (`http://127.0.0.1:4000/v1` on
this host; older notes also mention `http://192.168.109.71:4000/v1` as a remote bypass).

`~/.cachelane` → `.cachelane-claude`. `~/.cachelane-openai` and `~/.cachelane-smoke` →
`.cachelane-litellm`. Edit the two real homes.

## Feature latches (live `config.json`)

Elision requires **all three** of `pruner.enabled`, `features.k_pruner`, and
`features.mutation_enabled`. `elision_mode` chooses the implementation
(`stateless` vs the legacy `countTokens`-per-block path). Config is re-read per
request (`src/proxy/server.ts`); flipping these does not need a restart.

| Flag | Code default (`src/config/defaults.ts`) | Claude home | LiteLLM home |
|---|---|---|---|
| `proxy.port` | `7332` | **7333** | **7332** |
| `proxy.upstream_host` | `api.anthropic.com` | `api.anthropic.com` | `127.0.0.1` |
| `proxy.upstream_port` | `443` | `443` | `4000` |
| `proxy.upstream_ssl` | `true` | `true` | `false` |
| `features.auto_proxy` | `true` | `false` | `false` |
| `pruner.enabled` | `true` | **`true`** | `false` |
| `features.k_pruner` | `true` | **`true`** | `false` |
| `features.mutation_enabled` | `true` | **`true`** | `false` |
| `features.elision_mode` | `legacy` | `stateless` | `stateless` |
| `features.marker_strategy` | `prefix_only` | `passthrough` | `candidate` |
| `pruner.k` | `3` | `3` | `3` |

Read this as three surfaces:

- **Code defaults** — what a fresh `~/.cachelane/config.json` gets.
- **Claude home** — mutation + stateless elision on; markers passed through. Not
  “features-off passthrough.”
- **LiteLLM home** — mutation and k-pruner off. The 2026-07-17 “live pruning ON”
  canary is **not** the current LiteLLM home. See [runbook-litellm-history.md](../runbook-litellm-history.md).

`marker_strategy: candidate` on the LiteLLM home is inert for Anthropic-style
planner claims: that lane’s upstream is LiteLLM, and the Claude-lane candidate
rollout is still gated by [runbook-claude-effectiveness.md](../runbook-claude-effectiveness.md).
The Claude lane is on `passthrough` (operator choice), not the code default
`prefix_only`.

## Version string

`package.json` is `1.1.7`. `src/cli/index.ts` hard-codes `.version("0.0.1")`.
`/usr/bin/node /srv/cachelane/dist/cli/index.cjs --version` prints `0.0.1`.
Do not take CLI `--version` as the package or install SHA. Use
`/srv/cachelane/GIT_SHA` and `package.json`.
