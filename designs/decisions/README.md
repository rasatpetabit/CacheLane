# ADRs — why a choice was made

**Kind:** decision/history. Check each file's **Status** before treating it as current
(ADR-005 proxy rejection and ADR-010 MIT are superseded).

- [`ADR-001-cache-discipline-positioning.md`](ADR-001-cache-discipline-positioning.md) — why sit on the prompt cache rather than another reduction axis
- [`ADR-002-pair-m1-m2-in-v1.md`](ADR-002-pair-m1-m2-in-v1.md) — why ship orchestration and K-pruning together
- [`ADR-003-defer-m3-m4-reject-m5.md`](ADR-003-defer-m3-m4-reject-m5.md) — why defer rewriting / speculative inclusion and reject distillation
- [`ADR-004-no-embeddings-or-ml.md`](ADR-004-no-embeddings-or-ml.md) — why reference detection stays deterministic
- [`ADR-005-mcp-hooks-deployment.md`](ADR-005-mcp-hooks-deployment.md) — May 2026 stdio-MCP decision (**superseded in practice** by `cachelane proxy`)
- [`ADR-006-three-region-two-breakpoints.md`](ADR-006-three-region-two-breakpoints.md) — why two breakpoints, three volatility regions
- [`ADR-007-local-only.md`](ADR-007-local-only.md) — why no hosted backend
- [`ADR-008-conservative-pruner-default.md`](ADR-008-conservative-pruner-default.md) — why default K=3
- [`ADR-009-measure-on-api-fields.md`](ADR-009-measure-on-api-fields.md) — why bill from Anthropic `usage` fields
- [`ADR-010-mit-npm-distribution.md`](ADR-010-mit-npm-distribution.md) — May 2026 MIT + npm plan (**license superseded** by Apache-2.0)
- [`ADR-011-tokenizer-multiplier-approximation.md`](ADR-011-tokenizer-multiplier-approximation.md) — why a per-model multiplier is an approximation
- [`ADR-012-openai-tokenizer.md`](ADR-012-openai-tokenizer.md) — why the OpenAI tokenizer path exists
- [`ADR-013-node22-runtime-floor.md`](ADR-013-node22-runtime-floor.md) — why Node 22 is the floor (CI also 24)
