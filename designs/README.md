# Cachelane Design Suite — May 2026 spec (history)

**Kind:** decision/history. Synthesized May 2026 from five source documents.

This folder is **not** the current-state map of the shipped system. Code
(`src/`), the production install (`/srv/cachelane`), and
[`docs/README.md`](../docs/README.md) win on drift.

Still binding from this suite (also restated in `AGENTS.md`):

- Vocabulary `STABLE | SEMI | VOLATILE`
- Prune/elide **before** placing `cache_control` breakpoints
- Fail-open; local-only
- Cache-stability gate (prefix SHA-256 identical across 3 identical-input runs)
- snake_case at storage / API boundaries

Superseded by the shipped system (do not implement these as if they were now):

- A `Reorderer` that physically reorders conversation blocks — code classifies and
  marks breakpoints; `README.md` states it does **not** reorder
- stdio-only MCP, “no network ports” (ADR-005) — the hot path is `cachelane proxy`
- MCP tool names `cachelane:stats` — registered names are `cachelane_*`
- `cachelane:expand` re-issues the original tool — `cachelane_expand` returns
  refetch metadata and restores the stub row
- Pino + `~/.cachelane/logs/` daily/7-day — `src/logger` writes
  `$CACHELANE_HOME/cachelane.log` (10 MiB × 5)
- MIT license (ADR-010) — `LICENSE` / `package.json` are Apache-2.0
- MCP registration at `~/.claude/mcp.json` — default is `~/.claude.json`

## Reading Order

**For an agent starting implementation today:** [`../docs/README.md`](../docs/README.md), then
[`../README.md`](../README.md), then code. Use this folder for *why* a 2026 decision was made.

**For a reviewer of the original design:** start with `01` and `05`.

## File Map

| File | Question it answers | Kind |
|------|---------------------|------|
| [`01-system-overview.md`](01-system-overview.md) | What did v1 claim to be (goals, glossary)? | history |
| [`02-architecture.md`](02-architecture.md) | How were the seven diagrams described? | history |
| [`03-engineering-specs.md`](03-engineering-specs.md) | What were REQ-F / REQ-NF / AC? | history + some still-normative |
| [`04-turns-and-pruning.md`](04-turns-and-pruning.md) | How was K-pruning specified? | history (algorithm still close) |
| [`05-token-reduction.md`](05-token-reduction.md) | Why M1+M2 over the other four methods? | history |
| [`06-systems-design.md`](06-systems-design.md) | What module/schema/milestone plan was written? | history |
| [`07-open-questions.md`](07-open-questions.md) | Which Q### were open in May 2026? | history — statuses not refreshed |
| [`2026-05-24-zero-config-auto-proxy.md`](2026-05-24-zero-config-auto-proxy.md) | How was auto-proxy designed? | history |
| [`decisions/README.md`](decisions/README.md) | Why was each ADR accepted? Check **Status** | history |

## Stable ID Prefixes

| Prefix | Namespace | File |
|--------|-----------|------|
| `REQ-F-###` | Functional requirements | `03-engineering-specs.md` |
| `REQ-NF-###` | Non-functional requirements | `03-engineering-specs.md` |
| `AC-###` | Acceptance criteria | `03-engineering-specs.md` |
| `ADR-###` | Architecture decision records | `decisions/ADR-###-*.md` |
| `Q###` | Open questions | `07-open-questions.md` |
