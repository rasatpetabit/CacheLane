/**
 * The /metrics endpoint.
 *
 * The proxy exported nothing. The only latency column in the schema measured a
 * 0.11 ms compressor step and had zero rows on the busier lane, and the
 * `inflight` gauge was computed per request and discarded. A full
 * VictoriaMetrics + vmagent + vmalert stack was already running on the host with
 * nothing to scrape here.
 *
 * The event-loop lag series is the one that matters: the production hang was a
 * synchronous stall on the request path, and lag is its direct signature.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startProxy } from "../server.js";

let tmpDir: string;
let proxy: http.Server;
let proxyPort: number;
let upstream: http.Server;

function listening(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    if (server.listening) return resolve((server.address() as net.AddressInfo).port);
    server.once("listening", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => resolve());
  });
}

function get(pathname: string): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: proxyPort, path: pathname }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"] as string | undefined,
        }),
      );
    });
    req.on("error", reject);
  });
}

function postChat(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-3", messages: [] }));
  });
}

/** Value of a single metric line, or undefined. */
function metricValue(body: string, name: string): number | undefined {
  const line = body.split("\n").find((l) => l.startsWith(name + " "));
  return line ? Number(line.slice(name.length + 1)) : undefined;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-metrics-"));
  upstream = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  const upstreamPort = await listening(upstream);

  proxy = startProxy({
    port: 0,
    db_path: path.join(tmpDir, "test.db"),
    workspace_id: "ws",
    session_id: "sess",
    upstream: { host: "127.0.0.1", port: upstreamPort, ssl: false },
  });
  proxyPort = await listening(proxy);
});

afterEach(async () => {
  await close(proxy);
  await close(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("/metrics", () => {
  it("serves Prometheus text exposition", async () => {
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/plain");
    expect(res.contentType).toContain("version=0.0.4");
    // Every metric must carry HELP and TYPE or scrapers drop it silently.
    expect(res.body).toContain("# HELP cachelane_inflight");
    expect(res.body).toContain("# TYPE cachelane_inflight gauge");
  });

  it("exports the inflight gauge that was previously computed and thrown away", async () => {
    const res = await get("/metrics");
    expect(metricValue(res.body, "cachelane_inflight")).toBe(0);
  });

  it("exports event-loop lag — the direct signature of the hang", async () => {
    const res = await get("/metrics");
    expect(res.body).toContain("cachelane_event_loop_lag_seconds{quantile=\"0.99\"}");
    expect(res.body).toContain("cachelane_event_loop_lag_seconds_max");
    // A healthy loop under a test harness should be nowhere near a second.
    const max = metricValue(res.body, "cachelane_event_loop_lag_seconds_max");
    expect(max).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(5);
  });

  it("counts completed requests by status class and records their duration", async () => {
    await postChat();
    await postChat();

    const res = await get("/metrics");
    expect(res.body).toContain('cachelane_requests_total{status="2xx"} 2');

    const count = metricValue(res.body, "cachelane_request_duration_seconds_count");
    expect(count).toBe(2);
    const sum = metricValue(res.body, "cachelane_request_duration_seconds_sum");
    expect(sum).toBeGreaterThan(0);
  });

  it("uses status classes, not per-code series — a proxy fronting arbitrary upstreams would otherwise blow up cardinality", async () => {
    await postChat();
    const res = await get("/metrics");
    const series = res.body
      .split("\n")
      .filter((l) => l.startsWith("cachelane_requests_total{"));
    expect(series.every((l) => /status="\dxx"/.test(l))).toBe(true);
  });

  it("does not count itself or /healthz as request traffic", async () => {
    await get("/healthz");
    await get("/metrics");

    const res = await get("/metrics");
    // Both are operational endpoints; counting them would inflate the very rate
    // an alert on request volume is meant to watch.
    expect(res.body).not.toContain('cachelane_requests_total{status="2xx"}');
  });

  it("reports process memory, so the 512MB cgroup limit can be watched", async () => {
    const res = await get("/metrics");
    const rss = metricValue(res.body, "cachelane_process_resident_bytes");
    expect(rss).toBeGreaterThan(0);
  });
});

/**
 * Failure-path telemetry. A counter that always reads zero is worse than absent:
 * during an outage it reads as "no upstream errors".
 */
describe("/metrics — failure paths", () => {
  it("counts upstream timeouts rather than reporting zero through an outage", async () => {
    await close(proxy);
    await close(upstream);

    const silent = http.createServer(() => { /* accepts, never answers */ });
    silent.listen(0, "127.0.0.1");
    const silentPort = await listening(silent);
    proxy = startProxy({
      port: 0,
      db_path: path.join(tmpDir, "timeout.db"),
      workspace_id: "ws",
      session_id: "sess",
      upstream: { host: "127.0.0.1", port: silentPort, ssl: false },
      upstream_idle_timeout_ms: 300,
    });
    proxyPort = await listening(proxy);
    upstream = silent;

    expect(await postChat()).toBe(504);

    const res = await get("/metrics");
    expect(res.body).toContain('cachelane_upstream_errors_total{kind="timeout"} 1');
  });

  it("counts upstream connection errors", async () => {
    await close(proxy);
    await close(upstream);

    // Nothing listening on this port.
    const dead = http.createServer();
    dead.listen(0, "127.0.0.1");
    const deadPort = await listening(dead);
    await close(dead);

    proxy = startProxy({
      port: 0,
      db_path: path.join(tmpDir, "err.db"),
      workspace_id: "ws",
      session_id: "sess",
      upstream: { host: "127.0.0.1", port: deadPort, ssl: false },
    });
    proxyPort = await listening(proxy);
    upstream = http.createServer();
    upstream.listen(0, "127.0.0.1");
    await listening(upstream);

    expect(await postChat()).toBe(502);

    const res = await get("/metrics");
    expect(res.body).toContain('cachelane_upstream_errors_total{kind="error"} 1');
  });

  it("records a shed 503 as served traffic, not only as a shed counter", async () => {
    await close(proxy);
    await close(upstream);

    const stalling = http.createServer(() => { /* never responds */ });
    stalling.listen(0, "127.0.0.1");
    const stallingPort = await listening(stalling);
    proxy = startProxy({
      port: 0,
      db_path: path.join(tmpDir, "shed.db"),
      workspace_id: "ws",
      session_id: "sess",
      upstream: { host: "127.0.0.1", port: stallingPort, ssl: false },
    });
    proxyPort = await listening(proxy);
    upstream = stalling;

    const pending: http.ClientRequest[] = [];
    try {
      for (let i = 0; i < 24; i++) {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          path: "/v1/messages",
          method: "POST",
        });
        req.on("error", () => { /* expected */ });
        req.on("response", (r) => r.resume());
        pending.push(req);
        req.end(JSON.stringify({ model: "claude-3", messages: [] }));
      }
      await new Promise((r) => setTimeout(r, 400));

      const res = await get("/metrics");
      expect(metricValue(res.body, "cachelane_shed_total")).toBeGreaterThan(0);
      // Omitting shed responses would understate both traffic and error rate at
      // exactly the moment they matter.
      expect(res.body).toContain('cachelane_requests_total{status="5xx"}');
    } finally {
      for (const req of pending) req.destroy();
    }
  }, 20_000);

  it("labels an aborted request as aborted, never as a 2xx success", async () => {
    await close(proxy);
    await close(upstream);

    let sawRequest: () => void;
    const arrived = new Promise<void>((r) => { sawRequest = r; });
    const stalling = http.createServer((req) => {
      req.resume();
      req.on("end", () => sawRequest());
    });
    stalling.listen(0, "127.0.0.1");
    const stallingPort = await listening(stalling);
    proxy = startProxy({
      port: 0,
      db_path: path.join(tmpDir, "abort.db"),
      workspace_id: "ws",
      session_id: "sess",
      upstream: { host: "127.0.0.1", port: stallingPort, ssl: false },
    });
    proxyPort = await listening(proxy);
    upstream = stalling;

    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/v1/messages",
      method: "POST",
    });
    req.on("error", () => { /* expected */ });
    req.end(JSON.stringify({ model: "claude-3", messages: [] }));

    await arrived;
    req.destroy();
    await new Promise((r) => setTimeout(r, 300));

    const res = await get("/metrics");
    // res.statusCode defaults to 200, so a naive implementation records this
    // client disconnect as a success — the exact failure the metric should show.
    expect(res.body).toContain('cachelane_requests_total{status="aborted"} 1');
    expect(res.body).not.toContain('cachelane_requests_total{status="2xx"}');
  }, 20_000);
});
