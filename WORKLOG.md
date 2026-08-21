# WORKLOG — cachelane

Handoff log for collaborating agents (Codex, future Claude sessions). Terse
entries: scope, key decisions, and *why* — the diff shows *what*.

## 2026-08-16 — cachelane disabled on both lanes (operator decision)

Scope: live ops on this host, not code. User: "causing too many problems."

- Stopped + disabled `cachelane-claude`, `cachelane-litellm`, and
  `cachelane-healthcheck.timer` (the timer restarts inactive units — it had to
  go first or it would resurrect the proxies within 60 s).
- Clients rewired: `~/.claude/settings.json` env `ANTHROPIC_BASE_URL` /
  `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` (7333) removed → Claude Code direct to
  api.anthropic.com; `~/.pi/agent/models.json` litellm `baseUrl` 7332 →
  127.0.0.1:4000/v1 (direct LiteLLM).
- Backups named to match `scripts/rollback-client-config.sh` globs
  (`settings.json.bak-pre-cc-cachelane-20260816-181308`,
  `models.json.bak-pre-cachelane-20260816-181308`) so that script is the
  documented re-enable path (restore config, re-enable + start units+timer).
- `/srv/cachelane` install and unit files left in place for rollback; nothing
  under `/srv` changed beyond unit enablement.

