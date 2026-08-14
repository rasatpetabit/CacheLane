---
type: index
resource: /srv/dev/okf-workspace/repos/ai/cachelane.md
title: CacheLane — knowledge catalog index
timestamp: 2026-07-01T00:00:00Z
privacy: private
tags: [cachelane, claude-code, prompt-caching, mcp, cli]
---

# CacheLane

CacheLane is a local HTTP proxy plus optional MCP server and Claude Code hooks.
On this host it runs as two systemd units from `/srv/cachelane`. The npm CLI
(`cachelane install`) is a different, single-user surface.

Two Anthropic-path mechanisms, per the README and current `src/`:

1. **Cache-aware orchestration** — classifies each request into three
   volatility regions (`STABLE | SEMI | VOLATILE`) and places `cache_control`
   markers (code default `prefix_only` = one tools/system marker; `candidate`
   can own more — [runbook-claude-effectiveness.md](../docs/runbook-claude-effectiveness.md)).
   Pipeline: classify → prune/elide → place breakpoints. There is no Reorderer.
2. **K-pruning** — replaces tool-call result blocks idle ≥ K turns with
   refetchable stubs. `cachelane_expand` returns refetch metadata.

Users verify with `cachelane doctor`, `cachelane sessions`, `cachelane stats`.
CLI `--version` prints `0.0.1` even when `package.json` is `1.1.7`.

## Key components (from `src/`)

- `classifier/` — assigns STABLE/SEMI/VOLATILE volatility class to prompt blocks.
- `pruner/` — implements K-pruning (idle tool-result stubbing).
- `orchestrator/` — places `cache_control` breakpoints on STABLE / SEMI / VOLATILE regions.
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
  Node >= 22. CI verifies Node 22 and Node 24 LTS; `better-sqlite3` ^12 provides
  native bindings for both.
- Next.js web dashboard (`next.config.ts`, `app/`, `components/`, Tailwind
  via `tailwind.config.ts`, `postcss.config.mjs`).
- Vitest for tests (`vitest.config.ts`).
- SQLite storage (`better-sqlite3`), `blocks/turns/block_references` schema
  using snake_case per `CLAUDE.md`.

## Pointers to existing docs

- [`README.md`](../README.md) — user-facing quickstart, mechanism explainer, pricing math.
- [`CLAUDE.md`](../CLAUDE.md) — thin shim; canonical instructions are `AGENTS.md`.
- [`docs/README.md`](../docs/README.md) — operator + history routing table.
- [`INTEGRATION.md`](../INTEGRATION.md) — dated Headroom/LiteLLM working notes.
- [`BENCHMARK.md`](../BENCHMARK.md) — recorded-benchmark methodology.
- [`designs/README.md`](../designs/README.md) — May 2026 spec index (history).
- `docs/superpowers/plans/` — dated implementation plans (archive).

## Invariants worth knowing before touching code

Per `AGENTS.md`: fail-open on **pre-forward pipeline** errors (forward the
unmutated request). Startup / upstream / mid-stream failures cannot
transparently fail open. Local-only: prompt content leaves only on the
configured upstream hop (Anthropic or LiteLLM). Cache-stability gate:
prefix SHA-256 identical across 3 identical-input runs
(`src/orchestrator/__tests__/cache-stability.test.ts`).
