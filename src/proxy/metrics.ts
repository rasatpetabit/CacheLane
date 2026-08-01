import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Prometheus exposition for the proxy.
 *
 * Nothing here existed before. The only latency column in the entire schema was
 * `compression_events.latency_ms`, which measures a 0.11 ms compressor step and
 * had zero rows on the lane carrying most of the traffic. The `inflight` gauge
 * was computed on every request and then thrown away — the single most useful
 * live signal in the system, exported nowhere.
 *
 * The event-loop lag histogram is the one that matters most. The production hang
 * was a synchronous stall on the request path, and lag is its direct signature:
 * `/healthz` latency was standing in as a proxy for it, which worked only because
 * that handler does no I/O. This measures it properly.
 *
 * A hand-rolled exposition rather than prom-client: the surface is small, and a
 * metrics endpoint should not add a dependency to a proxy whose failure mode was
 * doing too much work per request.
 */

/** Seconds. Spans a stalled event loop (10s+) down to a healthy one (sub-ms). */
const DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];

interface Histogram {
  counts: number[];
  sum: number;
  total: number;
}

function emptyHistogram(): Histogram {
  return { counts: new Array<number>(DURATION_BUCKETS.length).fill(0), sum: 0, total: 0 };
}

function observe(h: Histogram, seconds: number): void {
  h.sum += seconds;
  h.total += 1;
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]!) h.counts[i]! += 1;
  }
}

export class ProxyMetrics {
  private requestsTotal = new Map<string, number>();
  private requestDuration = emptyHistogram();
  private upstreamErrors = new Map<string, number>();
  private shedTotal = 0;
  private loopDelay: IntervalHistogram | undefined;

  constructor(private readonly inflight: () => number) {
    try {
      // resolution 10ms: fine enough to see a multi-second stall, cheap enough
      // to leave running permanently.
      this.loopDelay = monitorEventLoopDelay({ resolution: 10 });
      this.loopDelay.enable();
    } catch {
      // Unavailable on some runtimes — metrics degrade rather than fail.
      this.loopDelay = undefined;
    }
  }

  recordRequest(status: number, durationSeconds: number, completed = true): void {
    // An aborted request has no meaningful status: res.statusCode defaults to
    // 200, so counting it by code would report client disconnects and truncated
    // streams as successes — exactly the failures this is meant to surface.
    // Bucketed by class otherwise, not by exact code: per-code series on a proxy
    // fronting arbitrary upstreams is unbounded cardinality.
    const cls = completed ? `${Math.floor(status / 100)}xx` : "aborted";
    this.requestsTotal.set(cls, (this.requestsTotal.get(cls) ?? 0) + 1);
    observe(this.requestDuration, durationSeconds);
  }

  recordUpstreamError(kind: "error" | "timeout"): void {
    this.upstreamErrors.set(kind, (this.upstreamErrors.get(kind) ?? 0) + 1);
  }

  recordShed(): void {
    this.shedTotal += 1;
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const out: string[] = [];

    out.push("# HELP cachelane_inflight Requests currently being served.");
    out.push("# TYPE cachelane_inflight gauge");
    out.push(`cachelane_inflight ${this.inflight()}`);

    out.push("# HELP cachelane_requests_total Completed requests by status class.");
    out.push("# TYPE cachelane_requests_total counter");
    if (this.requestsTotal.size === 0) {
      out.push(`cachelane_requests_total{status="none"} 0`);
    }
    for (const [cls, n] of this.requestsTotal) {
      out.push(`cachelane_requests_total{status="${cls}"} ${n}`);
    }

    out.push("# HELP cachelane_request_duration_seconds End-to-end request duration.");
    out.push("# TYPE cachelane_request_duration_seconds histogram");
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      out.push(
        `cachelane_request_duration_seconds_bucket{le="${DURATION_BUCKETS[i]}"} ${this.requestDuration.counts[i]}`,
      );
    }
    out.push(
      `cachelane_request_duration_seconds_bucket{le="+Inf"} ${this.requestDuration.total}`,
    );
    out.push(`cachelane_request_duration_seconds_sum ${this.requestDuration.sum}`);
    out.push(`cachelane_request_duration_seconds_count ${this.requestDuration.total}`);

    out.push("# HELP cachelane_upstream_errors_total Upstream failures by kind.");
    out.push("# TYPE cachelane_upstream_errors_total counter");
    for (const kind of ["error", "timeout"] as const) {
      out.push(
        `cachelane_upstream_errors_total{kind="${kind}"} ${this.upstreamErrors.get(kind) ?? 0}`,
      );
    }

    out.push("# HELP cachelane_shed_total Requests rejected at the in-flight cap.");
    out.push("# TYPE cachelane_shed_total counter");
    out.push(`cachelane_shed_total ${this.shedTotal}`);

    // The direct signature of the failure this whole effort was about: a
    // synchronous stall on the request path shows up here and nowhere else.
    if (this.loopDelay) {
      out.push(
        "# HELP cachelane_event_loop_lag_seconds Event loop delay since process start.",
      );
      out.push("# TYPE cachelane_event_loop_lag_seconds summary");
      const ns = (v: number) => v / 1e9;
      for (const q of [50, 90, 99]) {
        out.push(
          `cachelane_event_loop_lag_seconds{quantile="0.${q}"} ${ns(this.loopDelay.percentile(q))}`,
        );
      }
      out.push(`cachelane_event_loop_lag_seconds_max ${ns(this.loopDelay.max)}`);
      out.push(`cachelane_event_loop_lag_seconds_mean ${ns(this.loopDelay.mean)}`);
    }

    const mem = process.memoryUsage();
    out.push("# HELP cachelane_process_resident_bytes Resident set size.");
    out.push("# TYPE cachelane_process_resident_bytes gauge");
    out.push(`cachelane_process_resident_bytes ${mem.rss}`);
    out.push("# HELP cachelane_process_heap_used_bytes Heap in use.");
    out.push("# TYPE cachelane_process_heap_used_bytes gauge");
    out.push(`cachelane_process_heap_used_bytes ${mem.heapUsed}`);

    return out.join("\n") + "\n";
  }

  /** Release the event-loop monitor. */
  stop(): void {
    try {
      this.loopDelay?.disable();
    } catch {
      // Already disabled or unsupported.
    }
  }
}
