---
type: index
resource: /srv/dev/okf-workspace/repos/ai/cachelane.md
title: CacheLane — knowledge catalog index
timestamp: 2026-07-01T00:00:00Z
privacy: private
tags: [cachelane, claude-code, prompt-caching, mcp, cli]
---

# CacheLane

CacheLane is a local MCP server plus Claude Code hooks (PreRequest/PostResponse)
that sits between Claude Code and `api.anthropic.com` to cut input-token cost
on every turn, targeting 30%-60% lower input-token cost on long sessions with
no change to how the user drives Claude Code.

Two mechanisms, per the README and `CLAUDE.md`:

1. **Cache-aware orchestration** — classifies each request into three
   volatility regions (`STABLE | SEMI | VOLATILE`) and places two
   `cache_control` breakpoints so Anthropic's prompt cache serves the stable
   prefix at 0.1x instead of full price. Pipeline order is canonical:
   Classifier -> Pruner -> Reorderer.
2. **K-pruning** — replaces tool-call result blocks that have been idle for
   >= K consecutive turns with refetchable stubs, non-lossily, to flatten
   token growth across long sessions.

Ships as an installable CLI (`npm install -g cachelane`, then `cachelane
install` to wire hooks into Claude Code) plus a companion web dashboard
(`web/` — README references `cache-lane.vercel.app`). Users verify it's
working with `cachelane doctor`, `cachelane sessions`, `cachelane stats`.

## Key components (from `src/`)

- `classifier/` — assigns STABLE/SEMI/VOLATILE volatility class to prompt blocks.
- `pruner/` — implements K-pruning (idle tool-result stubbing).
- `orchestrator/` — reorders/breaks the prompt per the STABLE -> SEMI -> VOLATILE pipeline.
- `proxy/` — intercepts Claude Code <-> `api.anthropic.com` traffic.
- `hooks/` — Claude Code PreRequest/PostResponse hook integration.
- `server/` — the local MCP server.
- `storage/` — SQLite-backed state (blocks/turns/block_references per `CLAUDE.md`).
- `tokenizer/`, `compressor/`, `reconciler/`, `references/`, `report/`, `keepalive/`,
  `providers/`, `config/`, `logger/`, `cli/`, `types/`, `scripts/` — supporting subsystems.
- `web/` — dashboard app (Next.js: see top-level `app/`, `components/`, `next.config.ts`).
- `benchmark/` — perf/benchmark harness (see also top-level `BENCHMARK.md`).

## Tech stack (grounded in repo files observed)

- TypeScript / Node.js (`.nvmrc`, `tsconfig.json`, `tsup.config.ts`), requires
  Node >= 20.10; storage tests specifically need Node 20 because
  `better-sqlite3`'s native binding fails on Node 24.
- Next.js web dashboard (`next.config.ts`, `app/`, `components/`, Tailwind
  via `tailwind.config.ts`, `postcss.config.mjs`).
- Vitest for tests (`vitest.config.ts`).
- SQLite storage (`better-sqlite3`), `blocks/turns/block_references` schema
  using snake_case per `CLAUDE.md`.

## Pointers to existing docs

- [`README.md`](../README.md) — user-facing quickstart, mechanism explainer, pricing math.
- [`CLAUDE.md`](../CLAUDE.md) — project context for agent sessions: critical
  invariants (pipeline order, vocabulary, naming, fail-open, local-only,
  cache-stability gate), source documents, and the per-milestone (M2-M9)
  implementation workflow.
- [`INTEGRATION.md`](../INTEGRATION.md) — integration details (not read in depth here).
- [`BENCHMARK.md`](../BENCHMARK.md) — benchmark methodology/results.
- `designs/README.md` — full spec index and required reading order
  (system overview, architecture, engineering specs, turns-and-pruning
  algorithm, token-reduction research/ADRs, systems design, open questions).
- `docs/superpowers/plans/` — per-milestone implementation plans.

## Invariants worth knowing before touching code

Per `CLAUDE.md`: fail-open on any internal error (always return the
unmutated request rather than block the model), local-only (no prompt
content or API keys leave the direct `api.anthropic.com` request path, no
hosted backend), and a cache-stability gate requiring byte-identical
SHA-256 of the prefix region across 3 consecutive identical-input runs
before merge.
