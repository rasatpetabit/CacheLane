# CacheLane observability configs

Two files, both intended for the host's existing VictoriaMetrics stack:

| file | installs to |
|---|---|
| `vmagent-scrape.d-cachelane.yml` | `/etc/vmagent/scrape.d/cachelane.yml` |
| `vmalert-cachelane.yml` | `/etc/vmalert/rules/cachelane.yml` |

## Install them through Ansible, not by copying

A full VictoriaMetrics + vmagent + vmalert + Alertmanager stack was already
running on this host with nothing scraping CacheLane. Both target directories
are **Ansible-managed** — `/etc/vmagent/scrape.d/litellm.yml` opens with
`# Ansible managed` and names the role that renders it. A file copied straight
into `/etc` works until the next playbook run and then disappears, which is a
worse failure than no monitoring at all: the alerts stop existing without
anyone being told.

The source of truth is `/srv/dev/petabit/sysadmin/observability`. **The two files
land by different mechanisms** — an earlier version of this README said both go
in a directory that the `vmagent` role sweeps, and that was wrong for the scrape
fragment. Following it would have produced a committed file that nothing ever
deployed.

**Alert rules — a directory drop, no role needed.** Put `cachelane.yml` in
`observability/vmalert/`. The `vmalert` role implements SEAM (d): it `find`s
every `*.yml` in that directory and syncs the lot to `/etc/vmalert/rules/`,
which vmalert loads via its `-rule=/etc/vmalert/rules/*.yml` glob. Each domain
drops its own file and no role ever edits a shared one.

**Scrape fragment — needs its own role.** The `vmagent` role creates
`/etc/vmagent/scrape.d/` and deploys exactly one file into it, its own
`_seam-fixture.yml`. It does **not** glob the directory. Every domain ships its
own fragment from its own role — see
`roles/litellm_gateway/tasks/main.yml:491`, which templates
`scrape.d/litellm.yml.j2` straight to `/etc/vmagent/scrape.d/litellm.yml` and
notifies a `Reload vmagent config` handler.

CacheLane's equivalent is `roles/cachelane/` in that repo (added 2026-08-06):
`tasks/main.yml` plus `templates/scrape.d/cachelane.yml.j2`, gated on
`inventory_hostname in cachelane_hosts`, tagged `[cachelane, vmagent]`, and
auto-discovered through `meta/register.yml` by the `site.yml` seam. The lane
list and ports live in `defaults/main.yml` rather than being hardcoded, and
`instance` templates from `inventory_hostname` instead of a literal `epyc2`.

Deploy both with a tag-scoped run — this deliberately avoids applying unrelated
in-progress work elsewhere in that repo:

```bash
cd /srv/dev/petabit/sysadmin/observability/ansible
ansible-playbook playbooks/site.yml --tags cachelane,vmalert --limit epyc2 --check --diff   # dry run
ansible-playbook playbooks/site.yml --tags cachelane,vmalert --limit epyc2                  # apply
```

The `cachelane` tag alone deploys only the scrape fragment; the rules need
`vmalert` as well, because the sync task belongs to that role.

**Status: landed and verified 2026-08-06.** Both files are deployed through the
Ansible path above, not hand-copied. Verified live: two scrape targets
(`lane=litellm`, `lane=claude`) reporting `health: "up"` with empty `lastError`,
`up{job="cachelane"} == 1` for both lanes in VictoriaMetrics, and all rules
loaded and `inactive` on a healthy system (nine at first landing; a tenth,
`CacheLaneHealthcheckStale`, added later the same day — see below).

The copies in *this* directory are now the upstream reference for what the role
templates render — keep them in step with
`roles/cachelane/templates/scrape.d/cachelane.yml.j2` and
`observability/vmalert/cachelane.yml`, or delete them in favour of pointing at
those. Hand-copying them into `/etc` is not a supported path: both target
directories are Ansible-managed, so a manual copy survives only until the next
playbook run and then vanishes, taking the alerts with it and leaving silence
that reads exactly like health.

One caveat found while verifying: `CacheLaneScrapeConfigMissing` goes `pending`
for a minute or two immediately after first deployment. That is the `absent()`
rule evaluating against a moment before the `up` series existed — vmalert
evaluates slightly behind ingest. It clears on its own well inside the rule's
`for: 10m`, so it never pages, but do not mistake it for a broken rule on a
fresh install.

Verify the targets are actually up before believing any of it — a scrape config
that loads but resolves nothing reports as silence, not as an error:

```bash
curl -s localhost:8429/api/v1/targets | jq '.data.activeTargets[]
  | select(.labels.job=="cachelane") | {instance: .labels.lane, health, lastError}'
```

## What is alerted on, and one deliberate substitution

The remediation spec asked for an alert on **overhead p99 > 250 ms**. CacheLane
exports no overhead metric. `cachelane_request_duration_seconds` is end-to-end
and therefore dominated by how long the model took to answer — LiteLLM's p50
swings between 1.3 s and 180 s on upstream variance alone. Alerting on it would
page on a slow model rather than a slow proxy, and would contradict the spec's
own evidence standard, which says not to accept end-to-end latency as evidence.

`cachelane_event_loop_lag_seconds` is the signal that was actually wanted. The
outage was a synchronous stall on the request path — a tokenizer rebuilt once
per elided block, 45 ms each — and event-loop lag is its direct signature. It is
also immune to upstream slowness, because waiting on a socket does not block the
loop. So the latency alert is on lag, at the 250 ms threshold the spec named.

| alert | fires on | severity |
|---|---|---|
| `CacheLaneProxyDown` | target unscrapeable 3m | warning |
| `CacheLaneScrapeConfigMissing` | `up` series absent for a lane 10m | warning |
| `CacheLaneHealthcheckStale` | healthcheck timestamp frozen >180 s, or series absent | warning |
| `CacheLaneEventLoopStalled` | lag p99 > 250 ms for 5m | warning |
| `CacheLaneEventLoopBlocked` | lag max > 3 s for 2m | critical |
| `CacheLaneInflightHigh` | in-flight > 12 for 5m | warning |
| `CacheLaneSheddingLoad` | any 503 shedding for 5m | warning |
| `CacheLaneMemoryHigh` | RSS > 400 MiB for 10m | warning |
| `CacheLaneUpstreamErrors` | upstream error rate > 0.1/s for 5m | warning |
| `CacheLaneAbortedRequests` | aborted rate > 0.1/s for 10m | info |

The two lanes are scraped as separate targets carrying `lane=litellm` and
`lane=claude`. They are not averaged: the LiteLLM lane carries the
pruning-heavy traffic and fails independently of the Claude lane.

## Thresholds

Every number above is a judgement, not a measurement — nothing here was derived
from a baseline run, so treat them as starting points to tune once there is
history to tune against. The two that are grounded in something concrete:

- **RSS > 400 MiB** (419430400 bytes) is 78% of the units'
  `MemoryMax=536870912` — which is 512 **MiB**, not 512 MB. Above it the cgroup
  OOM killer becomes a realistic outcome, and it takes every in-flight request
  with it.
- **lag max > 3 s** sits below the incident's own measurements: the median turn
  eliding 120+ blocks blocked for 6,715 ms, with p99 at 8,034 ms.

- **in-flight > 12** is 75% of `MAX_INFLIGHT_REQUESTS`, which is 16. The proxy
  sheds with 503 at the cap, so `cachelane_inflight` can reach 16 and never
  exceed it. The spec's original "inflight > 32" was written when the cap was
  64; carried over unchanged it would have been an alert that could not fire.
