# AGENTS.md — cachelane


<!-- agentic-dispatch:central-pointer v2 -->
## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), Serena, Hindsight,
context-mode, and subagent/model-dispatch policy is centralized in the
agent-dispatch repo. Read it via `agent-dispatch where` (repo root) or
`agent-dispatch digest` (live routing policy). Do not duplicate or override
that policy here.

Cachelane is a local HTTP proxy plus optional MCP server and Claude Code hooks. On this host it
runs as two systemd units from `/srv/cachelane` (`cachelane-claude` `:7333` → Anthropic,
`cachelane-litellm` `:7332` → LiteLLM). The npm CLI (`cachelane install`) is a different surface:
a single-user Claude Code home with `auto_proxy` starting `:7332`.

**Two mechanisms (Anthropic path):**
1. **Cache-aware orchestration** — classifies blocks `STABLE | SEMI | VOLATILE` and places
   `cache_control` breakpoints. It does **not** reorder the conversation (`README.md`,
   `src/orchestrator/index.ts`).
2. **K-pruning / elision** — replaces idle tool-result blocks (≥ K turns, default K=3) with
   refetchable stubs. `cachelane_expand` returns trusted refetch metadata and restores the stub
   row; it does not re-issue the original tool.

A third mechanism, lossless/lossy **tool-output compression**, ships in `src/compressor/`.

## Where to Start

Do not implement from `designs/` as if it were current. That suite is the May 2026 spec
(history + still-binding vocabulary/invariants). Code and this-host ops win on drift.

| Question | File |
|------|-----------------|
| What does the code do, and how do I build it? | [`README.md`](README.md) |
| How is `/srv/cachelane` installed? | [`docs/operations/production-install.md`](docs/operations/production-install.md) |
| Which lane flags / URLs are live? | [`docs/operations/lane-state.md`](docs/operations/lane-state.md) |
| LiteLLM lane ops | [`docs/runbook-litellm.md`](docs/runbook-litellm.md) |
| Claude-lane cache measurement | [`docs/runbook-claude-effectiveness.md`](docs/runbook-claude-effectiveness.md) |
| All operator + history docs | [`docs/README.md`](docs/README.md) |
| May 2026 spec index (history) | [`designs/README.md`](designs/README.md) |
| ADRs (history; check Status) | [`designs/decisions/README.md`](designs/decisions/README.md) |
| Agent handoff log | [`WORKLOG.md`](WORKLOG.md) |

## Critical Invariants (do not violate without updating the spec **and** the code)

- **Pipeline order**: classify → prune/elide → place breakpoints (`handlePreRequest` then
  `orchestrate`). Pruner runs first because pruning changes sizes before breakpoints are computed.
  There is no `Reorderer` module.
- **Vocabulary**: `STABLE | SEMI | VOLATILE` — these are the only accepted names for volatility
  classes everywhere (spec, code, logs, tests, comments).
- **Naming**: storage and API-contract types use `snake_case` (e.g. the `Block` interface,
  `PrefixState`, `blocks/turns/block_references` rows, `CachelaneConfig` fields, SQLite columns).
  In-process working types (function parameters, local helpers) may use `camelCase`. Rule of
  thumb: if it crosses a process / storage / network boundary, snake_case.
- **Source of truth on drift**: checkout code (`src/`), then live install (`/srv/cachelane` +
  lane `config.json`), then `designs/`. The original `.docx` sources named in older notes are
  **not on this host** (`/mnt/c/Users/jujum/Downloads/`, `/tmp/cachelane-extracts`).
- **Fail-open**: any error in Cachelane must forward the unmutated request. Never silently drop
  a turn or block the model.
- **Local-only**: no prompt content, API keys, or user data leave the direct upstream path
  (Anthropic or the configured LiteLLM hop). No hosted backend.
- **Cache-stability gate**: SHA-256 of the prefix region must be byte-identical across 3
  consecutive identical-input runs (`src/orchestrator/__tests__/cache-stability.test.ts`).
  Treat a failing gate as merge-blocking.
- **Production never runs from `/srv/dev`.** Install by copying into `/srv/cachelane`.
  Units already `WorkingDirectory=/srv/cachelane`. Their `Documentation=` still points at
  `/srv/dev/.../docs/runbook-litellm.md` — a pointer leak, not a license to exec from checkout.

## Per-Milestone Implementation Workflow (lean)

For each milestone (M2 → M9), follow this discipline:

1. **Plan** — Read the live operator docs first, then the matching `designs/` section as history. Draft a plan file under `docs/superpowers/plans/YYYY-MM-DD-mN-<topic>.md` using an existing plan as a template.
2. **Branch** — `superpowers:using-git-worktrees` to create `feat/mN-<topic>` off `main`. Confirm Node 22 (`nvm use 22`) and a green baseline (`npm test`) before writing code.
3. **TDD per task** — `superpowers:test-driven-development`. Write fixtures + red tests first. Watch them fail for the right reason. Implement minimum to green. No mocks unless crossing a process/network boundary.
4. **Lean code** — One module per milestone unless the spec says otherwise. No new npm deps without an ADR. snake_case for storage/API-contract types; camelCase for in-process working types. Vocabulary: `STABLE | SEMI | VOLATILE` everywhere — no synonyms.
5. **Subagent delegation** — `superpowers:subagent-driven-development` when tasks are independent (e.g., fixtures + glob helper + rules can run in parallel agents). Two-stage review (spec compliance, then code quality).
6. **Verify before claiming done** — `superpowers:verification-before-completion`: run `npm test`, `npm run lint`, `npx tsc --noEmit` AND paste the output before saying "complete".
7. **Debug systematically** — `superpowers:systematic-debugging` when a test fails unexpectedly. Root-cause; don't guess-and-patch.
8. **Finish the branch** — `superpowers:finishing-a-development-branch` to merge / PR / clean up.

**Test discipline (lean):** one assertion per test where possible; table-driven (`describe.each`) for enumerable cases (e.g., all 11 `BlockKind` values); fixtures as JSON so reviewers can audit without parsing test code. Keep test files focused — split when one file grows past ~300 lines.

**Node version:** Node 22 is the minimum runtime and local development baseline. CI runs the
full suite on Node 22 and Node 24 LTS. `better-sqlite3` must remain on a release line with
prebuilt bindings for both majors; see ADR-013.
<!-- agent-dispatch:begin routing hash=ab9bc373a67846a9f7ca9d9e4cff415f061bf461e385ef3020963d0799821040 -->
## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard):
- Some models are gated and require a live override grant; run `agent-dispatch digest` for current dispositions.
- model param MUST be explicit — missing model is denied, EXCEPT the built-in read-only types below (Explore/Plan), which inherit the session model.
- Route work to the roster role its class names (routing.yaml classes[].agent); the role pins the lane. Explore/Plan are exempt built-ins that BYPASS lane routing: dispatch them WITHOUT a model param (they inherit the session model; an explicit model outside the lineup is denied). Prefer the role.

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: policy/dispatch-policy.jsonc in the agent-dispatch repo (run `agent-dispatch where` for its root).
<!-- agent-dispatch:end -->
