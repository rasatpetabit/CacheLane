# CacheLane routing state

**What this document is for.** Nothing else on this host records whether CacheLane is in the
traffic path. Before this file existed, the only evidence that both lanes had been deliberately
bypassed was three `.bak-pre-cachelane-bypass-*` files in `$HOME` — which reads as debris, not as
a decision. If you are trying to work out why the proxies are running but the stats are empty,
this is the answer.

Last verified: **2026-08-06**.

---

## Current state: LiteLLM lane restored (2026-08-06), Claude lane still bypassed

| lane | unit | port | upstream | in traffic path? |
|---|---|---|---|---|
| Claude | `cachelane-claude.service` | 127.0.0.1:7333 | `api.anthropic.com` (TLS) | **no** |
| LiteLLM | `cachelane-litellm.service` | 127.0.0.1:7332 | `127.0.0.1:4000` (plain HTTP) | **yes — features-off passthrough, soaking** |

The LiteLLM lane was restored on 2026-08-06 after GATE A opened: `~/.pi/agent/models.json`
`providers.litellm.baseUrl` is back to `http://127.0.0.1:7332/v1` (backup of the pre-restore
file: `models.json.bak-pre-cachelane-restore-20260806T044602Z`). Preconditions executed first:

- **Stage 2a Class A canary** — 7/7 probes PASS against the deployed artifact (`b7fc668`) with
  a scratch home and a local mock upstream: header fidelity, response byte-equality,
  incremental SSE, 400/429/500 propagation with `retry-after`, hard-abort propagation upstream
  in 0.76 s, 1 MB body integrity.
- **Stage 2a Class B canary** — real-credential smoke through a scratch proxy to the real
  LiteLLM: roster, non-streaming, streaming-to-`[DONE]` all pass. (A bad-key probe returned
  200 — but it does so *direct to LiteLLM too*; that is upstream behaviour faithfully
  mirrored, not a proxy fault. See the LiteLLM exposure note below.)
- **Traffic proof** — a real `pi -p` dispatch recorded as a new turn (`request_mutated: 0`).
- **Revert proof** — baseUrl flipped back once deliberately: the dispatch succeeded direct and
  the proxy recorded zero turns; then re-restored. The revert is one edit and it works.

Two side observations from the cutover:

**(1) The gateway's open-auth posture is intentional — do not "fix" it.** The B3 canary probe
noted that a bogus key returns 200. That is the fleet's deliberate design, not a proxy fault
and not a defect: the gateway runs on a trusted network, and the auth-less production slot is
enforced on purpose in three places — `lib/compile-litellm.mjs:703-709` omits
`master_key`/`database_url` from the prod branch with a comment saying so, and both
`test/compile-litellm.mjs:366` and
`roles/litellm_gateway/tests/test_litellm_gateway.py:156` assert their *absence*. Confirmed by
the operator on 2026-08-06. The probe is retained in the canary only as a fidelity check that
CacheLane mirrors upstream behaviour unchanged; **it is not a pass/fail security assertion**,
and a future reader should not read it as one.

**(2)** Occasional non-Pi consumers already hit `:7332` (e.g. the `~/.cachelane-smoke` lane
symlink; turns observed during the bypass window) — harmless, and their traffic counts toward
the soak denominators.

The Claude lane remains bypassed. CacheLane's only role there is post-hoc usage metering via
the Claude Code Stop and UserPromptSubmit hooks.

Evidence, taken 2026-08-06: `:7333` had served 3 requests since restart, all `4xx`; `:7332` had
served 2. Those are healthcheck probes. `cachelane_requests_total` on both lanes shows nothing
resembling real traffic.

### How each lane is bypassed

**Claude lane.** Claude Code reaches `api.anthropic.com` directly because `ANTHROPIC_BASE_URL` is
set **nowhere** — not in `~/.claude/settings.json` `env`, not in `~/.bashrc`, not in `~/.profile`,
and not in the live process environment. Setting it is the single wiring point that restores the
lane, and it takes effect for **new sessions only**.

**LiteLLM lane.** `~/.pi/agent/models.json` no longer points at the proxy. The pre-bypass value is
preserved at `~/.pi/agent/models.json.bak-pre-cachelane-bypass-20260731T220751Z:93`:

```json
"baseUrl": "http://127.0.0.1:7332/v1"
```

Diff the backup against the live file before restoring — later unrelated edits may have landed in
`models.json` since, and the backup should not be restored wholesale over them.

### Why

On **2026-07-31** a measured production hang was mitigated by disabling the pruner and taking
CacheLane out of the traffic path. Root cause (`docs/spec-hang-remediation-v4.md` §1): the
k-pruner called `countTokens()` once per prunable block, synchronously, before any byte was
forwarded upstream, and that call rebuilt a 696,615-byte Tiktoken WASM encoder every time —
~45.7 ms per call. At observed stub counts this blocked the Node event loop for seconds
(production p99 8.0 s, max 11.6 s), freezing every concurrent request and in-flight SSE stream.
Nothing errored; clients simply hung.

The bypass was **broader than the incident required** — it severed both lanes, and the LiteLLM
lane was never the one carrying the interactive session. That is a side effect worth knowing
about, not a deliberate scope decision.

---

## Feature latches

The stateless elision arm requires **all three** of these to be true before it elides anything.
`elisionDisabled()` (`src/hooks/pre-request.ts:259`) ORs the first two;
`statelessElisionDisabled()` (`:270`) adds the third.

| flag | Claude home | LiteLLM home |
|---|---|---|
| `pruner.enabled` | `false` | `false` |
| `features.k_pruner` | `false` | `false` |
| `features.mutation_enabled` | `false` | `false` |
| `features.elision_mode` | `"stateless"` | `"stateless"` |

Config homes: `~/.cachelane-claude` and `~/.cachelane-litellm`. Note the symlinks —
`~/.cachelane` → `.cachelane-claude`; `~/.cachelane-openai` and `~/.cachelane-smoke` →
`.cachelane-litellm`. Editing the two real files covers all five paths.

### Two hardening changes made 2026-08-06

1. **`elision_mode: "stateless"` added to both homes.** Neither config had the key, so both
   defaulted to `"legacy"` (`src/config/defaults.ts:42`, pinned by `config.test.ts:42`). A future
   flag flip would therefore have re-enabled the **legacy** database-backed pruner — the one whose
   path still calls `countTokens` per block (`src/pruner/k-pruning.ts:58`) — rather than the
   audited stateless transform. This is a no-op today (mutation is off, so the arm stands down
   either way); it exists so that turning the feature back on selects the right implementation.

2. **`pruner.enabled` set to `false` on the Claude home.** It had been `true`, leaving `k_pruner`
   as the *single* latch between that lane and the legacy pruner, where the LiteLLM home already
   had two. Both lanes now carry all three latches off.

Backups: `config.json.bak-pre-elision-mode-20260806T034542Z` in each home.

**Mitigating context, so the risk above is not overstated:** commit `0711d26` made the Tiktoken
encoder a process-level singleton (`src/tokenizer/index.ts:24-26`), removing the ~45.7 ms
*constructor* cost that dominated the incident. Re-enabling the legacy arm today would therefore
not be a guaranteed re-hang — but it would be an unmeasured regression on the exact code path
that caused an 8 s p99, and the legacy arm additionally carries the R-1b sticky-`is_stub` defect.

Also deployed: `safeFallbackConfig()`, which closed C19 — previously *any* unparseable value in
the config file caused `loadConfig` to fall back to `DEFAULT_CONFIG`, whose defaults turn
`pruner.enabled`, `k_pruner` **and** `mutation_enabled` all back **on**. A one-letter typo in an
unrelated field would have silently re-armed the outage at proxy start. It now falls back to
defaults with those three forced off.

---

## What restores each lane

Do not restore routing before the observability last mile is installed — see below.

| lane | edit | takes effect |
|---|---|---|
| LiteLLM | restore `"baseUrl": "http://127.0.0.1:7332/v1"` in `~/.pi/agent/models.json` | next dispatch |
| Claude | add `ANTHROPIC_BASE_URL=http://127.0.0.1:7333` to `~/.claude/settings.json` `env` | **new sessions only** |

Each is a single-line revert in the same place. Restoring the LiteLLM lane first is the intended
order: it carries the dispatch/subagent volume where CacheLane could actually pay for itself, and
a proxy fault there is contained to background jobs rather than taking down an interactive
session.

## Blocker: the recurrence alarm is not armed

`deploy/observability/` contains a vmagent scrape fragment and a set of vmalert rules — including
`CacheLaneEventLoopBlocked`, the direct signature of the July 31 failure. **None of it is
installed.** `/etc/vmagent/scrape.d/cachelane.yml` is absent, no cachelane rules exist under
`/etc/vmalert/rules/`, and the files were never landed in the Ansible source of truth at
`/srv/dev/petabit/sysadmin/observability/`.

Both target directories are Ansible-managed, so a file copied straight into `/etc` works until
the next playbook run and then disappears — alerts stop existing with nobody told. Land them via
the `vmagent` and `vmalert` roles, per `deploy/observability/README.md`.

Restoring traffic to a proxy whose recurrence alarm does not exist is how the July 31 incident
gets repeated silently. Install first.

### Update 2026-08-06 — installed and verified

Landed through Ansible, not hand-copied. The scrape fragment needed a new `cachelane` role
(`roles/cachelane/` in the sysadmin repo) because the `vmagent` role deploys only its own
`_seam-fixture.yml` and does **not** glob `scrape.d` — every domain ships its own fragment. The
alert rules were a plain directory drop into `observability/vmalert/`, which the `vmalert` role
does sweep. Deploy with `--tags cachelane,vmalert --limit epyc2`; re-running reports `changed=0`.

Verified live: both targets `health: "up"` with empty `lastError`; `up{job="cachelane"} == 1`
for `lane=litellm` and `lane=claude`; all nine rules loaded and `inactive`. Every metric the
rules reference was cross-checked against the exported set first, so none of them is an alert
that can never fire. A tenth rule, `CacheLaneHealthcheckStale`, was added later the same day —
see below.

`/healthz` probe latency is exported too, but **not** via blackbox_exporter — CacheLane binds
loopback only and blackbox runs on a different, pinned host, so it cannot reach these ports.
Instead `cachelane-healthcheck.sh` (already probing both lanes every 60 s) now times the probe
and writes `cachelane_healthz_probe_duration_seconds{lane=}` /
`cachelane_healthz_probe_success{lane=}` to node_exporter's textfile collector. Measured ~6 ms
on both lanes against a 250 ms gate.

### Post-install review findings (2026-08-06, second pass)

**The probe metrics could pass gates vacuously — closed.** If
`cachelane-healthcheck.timer` stops, node_exporter keeps serving the last-written textfile
forever: `cachelane_healthz_probe_success` stays `1` and the duration stays frozen at a good
value while nothing is probing. Every promotion gate built on those series would pass on stale
data. `CacheLaneHealthcheckStale` (the tenth rule) now fires when
`cachelane_healthcheck_last_run_timestamp_seconds` stops advancing for 3+ timer intervals, or
when the series disappears outright. Any soak-window gate read must confirm this alert did not
fire during the window.

**Installer landmine: never run `install-runtime.sh` from `/srv/cachelane`.** The installer
copies `$REPO_ROOT/scripts/cachelane-healthcheck.sh` to `/usr/local/sbin/cachelane-healthcheck`
(`install-runtime.sh:232`). The operative copy in `/usr/local/sbin` is current, but
`/srv/cachelane` is a `b7fc668` snapshot whose `scripts/` copy predates the metric export — an
install run *from that tree* would silently revert it. Install from `/srv/dev/ai/cachelane`
only, or redeploy `/srv/cachelane` to HEAD first.

### Known gap: alerts evaluate but notify nobody

`/etc/alertmanager/alertmanager.yml` is in **bare mode** — a single `null-default` receiver with
no notifier configured. Its own generated header says alerts "group here and are dropped". This
is host-wide and pre-existing, not specific to CacheLane: *every* alert on this machine is
currently silent at the notification layer.

So a firing CacheLane alert is observable in vmalert (`:8880/vmalert`) and queryable in
VictoriaMetrics, but nobody is paged. That is adequate for an attended soak and inadequate for
an unattended one. The fix is named in the config header: place a Slack webhook secret on-host
and re-run the `alertmanager` role.

### Deliberately waived (2026-08-06, operator decision)

The synthetic-stall end-to-end proof of `CacheLaneEventLoopBlocked` — standing up a scratch
instance, inducing a real multi-second synchronous stall, and confirming the metric climbs, is
scraped, and the alert fires — was **not** performed. The rule's expression, its threshold, and
the existence and shape of the metric it reads were all verified statically, but the full
emit → scrape → evaluate → fire chain has never been exercised for that specific alert. Treat
it as untested until it is.

## The deadlock this creates

The v4 gates that would authorize re-enabling elision — the primary `/healthz` gate, Gate 1
(dose-response), Gate 5 (price-weighted economics) and Gate 6 (orphaned requests) — all require
production traffic to measure. The mitigation removed all production traffic. Nothing can
qualify re-enablement until routing is restored, which is the substantive reason to restore it
rather than leaving CacheLane as a metering tool indefinitely.

Remaining work is scoped in `spec-hang-remediation-v5.md`.
