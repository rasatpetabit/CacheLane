# docs/ — operator and history index

Each child answers one question. Start at the matching row; do not read the
directory in order.

## Operate now

- [`why-it-saves-money.md`](why-it-saves-money.md) — Anthropic cache intuition (not a live measurement)
- [`runbook-litellm.md`](runbook-litellm.md) — how to run the LiteLLM lane and the dual-proxy install
- [`runbook-claude-effectiveness.md`](runbook-claude-effectiveness.md) — how to measure Claude-lane Anthropic cache (never use LiteLLM counters)
- [`operations/production-install.md`](operations/production-install.md) — how `/srv/cachelane` is installed, drained, and pruned
- [`operations/lane-state.md`](operations/lane-state.md) — which lane flags and client URLs are live
- [`operations/cachelane-hook-stats-repair.md`](operations/cachelane-hook-stats-repair.md) — how to repair historical Claude hook telemetry (procedure only; not executed)
- [`deploy/observability/README.md`](../deploy/observability/README.md) — how CacheLane scrape/alert files reach VictoriaMetrics
- [`scripts/canary/README.md`](../scripts/canary/README.md) — Stage 2a cutover canaries before putting a client behind a lane
- [`scripts/corpus/README.md`](../scripts/corpus/README.md) — how the M4 reference-detection corpus is built

## History (do not treat as current state)

- [`runbook-litellm-history.md`](runbook-litellm-history.md) — 2026-07 LiteLLM rollout diary and canaries
- [`operations/routing-state.md`](operations/routing-state.md) — hang, bypass, restore, alerting narrative
- [`hang-remediation-implementation-notes.md`](hang-remediation-implementation-notes.md) — implementation notes for the hang remediation
- [`spec-hang-remediation-v5.md`](spec-hang-remediation-v5.md) — latest hang-remediation spec (v1–v4 are prior drafts)
- [`spec-hang-remediation-v4.md`](spec-hang-remediation-v4.md) — prior hang-remediation spec
- [`spec-hang-remediation-v3.md`](spec-hang-remediation-v3.md) — prior hang-remediation spec
- [`spec-hang-remediation-v2.md`](spec-hang-remediation-v2.md) — prior hang-remediation spec
- [`spec-hang-remediation-v1.md`](spec-hang-remediation-v1.md) — prior hang-remediation spec
- [`benchmarks/compression-baseline-2026-06-20.md`](benchmarks/compression-baseline-2026-06-20.md) — dated compression baseline receipt
- [`benchmarks/latency-baseline-2026-06-18.md`](benchmarks/latency-baseline-2026-06-18.md) — dated latency baseline receipt
- [`specs/2026-07-28-decisions-tab-and-probe-exhaust-v1.md`](specs/2026-07-28-decisions-tab-and-probe-exhaust-v1.md) — dated UI/probe spec
- [`superpowers/plans/`](superpowers/plans/) — dated implementation plans
- [`superpowers/specs/`](superpowers/specs/) — dated design specs
- [`../src/docs/superpowers/`](../src/docs/superpowers/) — earlier milestone plans (duplicate tree; archive)
