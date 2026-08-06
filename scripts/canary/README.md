# Stage 2a cutover canaries

Run these **before** putting a client behind a CacheLane lane, and again after any change to
the proxy's forwarding path. They exist because *features-off does not make the proxy
transparent*: passthrough still terminates and re-opens the connection, re-frames headers, and
re-streams the body, so auth forwarding, SSE, cancellation, backpressure, timeouts, and error
propagation are live risks that no feature flag disables.

Both run against a **scratch `CACHELANE_HOME`** on spare ports, so production stats and
databases are untouched. Both exercise the **deployed** artifact (`/srv/cachelane`), not a
fresh build — the point is to test what is actually serving.

| script | upstream | asserts |
|---|---|---|
| `stage2a-class-a.py` | a local mock on `:7441` | byte-level fidelity |
| `stage2a-class-b.py` | the real LiteLLM on `:4000` | structural success |

```bash
python3 scripts/canary/stage2a-class-a.py   # exit 0 = all pass
python3 scripts/canary/stage2a-class-b.py
```

## Why two classes

**Byte-equality is only meaningful against a controlled upstream.** Two calls to a real model
are separate generations with different ids, sampled content, and usage — a *correct* proxy can
never make them byte-identical. Asserting that against a live API would be a gate no
implementation can pass. So Class A uses a mock that returns fixed bytes and asserts equality;
Class B uses real credentials and asserts only structure.

## Class A probes

- **A1 header fidelity** — `Authorization`, `x-api-key`, `anthropic-version`, `anthropic-beta`
  arrive at the upstream unaltered.
- **A2 body byte-equality** — proxied response identical to direct, including named headers.
- **A3 SSE incremental** — events arrive spread over time, not coalesced or buffered to EOF.
  Checks the *arrival timing*, since a proxy that buffers the whole stream still delivers
  correct final bytes.
- **A4 error propagation** — 400/429/500 with status, body, and `retry-after` preserved.
- **A5 abort propagation** — a hard client abort reaches the upstream promptly and leaves no
  orphaned in-flight request.
- **A6 large body** — a >1 MB request arrives intact (sha256-compared), no timeout, no 413.

### "Unaltered" never means a byte-equal header set

A correct HTTP proxy **must** regenerate hop-by-hop headers — `Connection`, `Keep-Alive`, `TE`,
`Trailer`, `Transfer-Encoding`, `Upgrade`, `Proxy-Authenticate`, `Proxy-Authorization`
(RFC 7230 §6.1). `Content-Length` is *not* hop-by-hop, but it is a framing header that
legitimately changes whenever the body is re-framed. A whole-header-set comparison therefore
fails a correct implementation, so every fidelity assertion is scoped to **named end-to-end
headers** only (`NAMED_HEADERS` in the script).

### A5 needs a real abort, and `http.client` cannot produce one

Closing an `http.client` connection's socket does **not** send FIN or RST — the response object
holds its own `makefile()` reference and the fd stays alive. A first version of A5 failed for
this reason and the failure looked exactly like a proxy defect. It was diagnosed by running the
same abort **directly against the mock, with no proxy in the path**: the mock did not observe a
close there either, which located the fault in the test harness rather than in CacheLane. A5
now uses a raw socket with `SO_LINGER(1, 0)` to force an RST. Keep that: if this probe ever
fails again, re-run the direct-to-mock control before suspecting the proxy.

## Class B probes

Roster, non-streaming completion, streaming through to `[DONE]`, a behaviour-mirroring check,
and proxy health afterwards. Never asserts byte-equality.

**B3 is a fidelity probe, not a security assertion.** The gateway is deliberately auth-less on
a trusted network — enforced on purpose at `lib/compile-litellm.mjs:703-709` in the litellm
repo and asserted by two test suites. A bogus key returning 200 is therefore *correct
upstream behaviour*. B3 checks only that the proxied status **equals** the direct status: that
CacheLane neither adds nor removes auth behaviour. Do not "fix" it into a 401 assertion.

## Per-lane, not once

Run the canary against **the lane being cut over**. The Claude lane and the LiteLLM lane use
different adapters, different upstream schemes (TLS vs plain HTTP), and different credentials —
the Claude lane authenticates with an OAuth bearer from `~/.claude/.credentials.json`, not the
`ANTHROPIC_API_KEY` in the environment. A clean run on one lane transfers no evidence to the
other.
