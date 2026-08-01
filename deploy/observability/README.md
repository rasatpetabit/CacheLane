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

The source of truth is `/srv/dev/petabit/sysadmin/observability`:

- scrape fragment → `vmagent/scrape.d/cachelane.yml`, deployed by the `vmagent`
  role, which already copies every fragment in that directory;
- alert rules → `vmalert/cachelane.yml`, deployed by the `vmalert` role.

That repository had uncommitted work in it when these files were written, so
landing them there is a separate, deliberate step rather than something to fold
into a CacheLane commit.

For a temporary local test before that lands, copy both files into place and
reload — accepting that Ansible will revert them:

```bash
sudo cp vmagent-scrape.d-cachelane.yml /etc/vmagent/scrape.d/cachelane.yml
sudo cp vmalert-cachelane.yml          /etc/vmalert/rules/cachelane.yml
sudo systemctl reload vmagent vmalert
```

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
