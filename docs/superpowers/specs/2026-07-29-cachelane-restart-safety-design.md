# CacheLane restart safety design

## Problem

`cachelane-healthcheck.timer` probes each proxy every 60 seconds. The current
probe traverses CacheLane and the upstream gateway with a three-second deadline;
one miss immediately invokes `systemctl restart`. Under four concurrent Pi
sessions, a slow probe at 18:39:18 and another at 18:40:19 restarted
`cachelane-litellm.service` and severed active streaming sockets at those exact
timestamps.

The health check must distinguish local process liveness from upstream health,
and it must never restart a proxy while clients are connected.

## Design

### Local liveness endpoint

CacheLane serves `GET /healthz` locally before provider routing, request parsing,
storage, pruning, or upstream forwarding. It returns HTTP 200 with a small JSON
body. Upstream LiteLLM health remains LiteLLM's responsibility; restarting
CacheLane cannot repair a slow upstream.

### Failure threshold

The health checker records consecutive failures per lane under
`/run/cachelane-healthcheck/`. A successful local probe resets the lane counter.
One or two misses only log and defer. The third consecutive miss makes a lane
eligible for restart.

The oneshot unit owns the state directory through
`RuntimeDirectory=cachelane-healthcheck` and preserves it between timer runs.
An inactive service may still be started immediately.

### Active-connection drain guard

Before every restart attempt, the checker counts established server-side TCP
connections on the lane's port after the failed probe has closed. It checks a
second time immediately before invoking `systemctl restart` to narrow the race.
If either check sees an active connection, restart is forbidden: the threshold
state is retained, a warning is logged, and the next timer tick retries.

This is fail-safe by design. A wedged proxy with connected clients requires the
connections to drain or explicit operator action; the timer may not destroy
active streams.

### Testable runtime artifact

The healthcheck becomes canonical `scripts/cachelane-healthcheck.sh` rather than
an installer heredoc. `scripts/install-runtime.sh` copies the tested script into
`/usr/local/sbin/` and installs the runtime-directory unit settings.

The installer must also use the same drain guard before its intentional lane
restarts. Installing the script and unit can occur without restarting either
proxy; deployment of the new `/healthz` runtime waits until the lane is idle.

## Verification

Automated tests use fake `systemctl`, `curl`, `ss`, and `logger` commands to prove:

1. `/healthz` bypasses adapters and storage.
2. One or two failed probes do not restart.
3. A third failed probe with no clients restarts once.
4. A third failed probe with active clients never restarts and preserves state.
5. A successful probe resets failure state.
6. Both ports 7332 and 7333 follow the same policy.

Live acceptance runs four concurrent streaming requests across multiple timer
ticks and requires a stable CacheLane PID, complete `[DONE]` sentinels, and no
new Pi connection errors.
