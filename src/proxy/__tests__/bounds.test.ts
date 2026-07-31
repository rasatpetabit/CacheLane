/**
 * Connection and request bounds.
 *
 * The proxy had none of these. A grep for setTimeout/timeout/maxSockets across
 * server.ts returned only the inflight drain counter, so:
 *
 *   - idle keep-alive sockets were torn down at Node's 5 s default (measured:
 *     FIN at 6.0 s) while both real upstreams held them past 75 s, and 8.1% of
 *     measured client idle gaps exceeded 5 s;
 *   - an upstream that accepted a request and went silent hung the client
 *     forever, with no error and nothing to retry;
 *   - admission was unbounded, so a burst became an OOM rather than backpressure.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startProxy, createProxyServer } from "../server.js";
import { openDatabase } from "../../storage/index.js";
import { CacheStateTracker } from "../../orchestrator/index.js";

let tmpDir: string;
let proxy: http.Server;
let proxyPort: number;

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-bounds-"));
});

afterEach(async () => {
  if (proxy) await close(proxy);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function start(upstreamPort: number, idleTimeoutMs?: number): Promise<number> {
  proxy = startProxy({
    port: 0,
    db_path: path.join(tmpDir, "test.db"),
    workspace_id: "ws",
    session_id: "sess",
    upstream: { host: "127.0.0.1", port: upstreamPort, ssl: false },
    upstream_idle_timeout_ms: idleTimeoutMs,
  });
  return listening(proxy);
}

describe("inbound connection bounds", () => {
  it("keeps idle connections far longer than Node's 5s default", async () => {
    proxyPort = await start(1); // upstream unused

    expect(proxy.keepAliveTimeout).toBe(120_000);
    // Node races these: if headers may arrive up to the keep-alive deadline but
    // the headers timer fires first, a client writing at the boundary is reset.
    expect(proxy.headersTimeout).toBeGreaterThan(proxy.keepAliveTimeout);
    // Sized for multi-MB conversation uploads on a slow link.
    expect(proxy.requestTimeout).toBeGreaterThanOrEqual(300_000);
  });

  // The bounds must be set where the server is created, not where startProxy
  // happens to listen: createProxyServer is exported and lifecycle.tryBindProxy
  // calls listen() itself, so a listen-site assignment would leave that whole
  // path on Node's defaults — including the 5s keep-alive this exists to fix.
  it("applies the bounds to createProxyServer, not only to startProxy", () => {
    const db = openDatabase(path.join(tmpDir, "direct.db"));
    try {
      const server = createProxyServer(
        { port: 0, workspace_id: "ws", session_id: "sess" },
        db,
        new CacheStateTracker(),
      );
      expect(server.keepAliveTimeout).toBe(120_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      expect(server.requestTimeout).toBeGreaterThanOrEqual(300_000);
      server.close();
    } finally {
      db.close();
    }
  });

  it("does not send FIN on an idle keep-alive socket within the old 6s window", async () => {
    const upstream = http.createServer((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end("{}");
    });
    upstream.listen(0, "127.0.0.1");
    const upstreamPort = await listening(upstream);
    proxyPort = await start(upstreamPort);

    try {
      const closedEarly = await new Promise<boolean>((resolve, reject) => {
        const socket = net.connect(proxyPort, "127.0.0.1");
        // Observed pre-fix behaviour was a FIN at ~6.0s; wait past that.
        const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 8000);
        socket.on("connect", () =>
          socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n"),
        );
        socket.on("data", () => { /* drain, then sit idle */ });
        socket.on("end", () => { clearTimeout(timer); resolve(true); });
        socket.on("error", reject);
      });

      expect(closedEarly).toBe(false);
    } finally {
      await close(upstream);
    }
  }, 15_000);
});

describe("upstream idle timeout", () => {
  it("answers 504 when the upstream accepts the request and goes silent", async () => {
    // An upstream that accepts and never answers. Before this change the client
    // waited forever: no error, no timeout, nothing to retry — the operator's
    // "hanging with no error messages".
    const silent = http.createServer(() => { /* no response, ever */ });
    silent.listen(0, "127.0.0.1");
    const silentPort = await listening(silent);
    proxyPort = await start(silentPort, 400);

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "claude-3", messages: [] }));
      });

      expect(status).toBe(504);
    } finally {
      await close(silent);
    }
  }, 15_000);

  it("does not fire while the upstream is still sending — it is idle, not total, time", async () => {
    // Chunks every 100ms for ~600ms, against a 400ms idle timeout. A
    // total-duration cap would kill this; an inactivity timer must not, because
    // legitimate agentic streams run for minutes.
    const dripping = http.createServer((_q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        r.write(`data: chunk${n++}\n\n`);
        if (n >= 6) { clearInterval(t); r.end(); }
      }, 100);
    });
    dripping.listen(0, "127.0.0.1");
    const drippingPort = await listening(dripping);
    proxyPort = await start(drippingPort, 400);

    try {
      const { status, body } = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
            (res) => {
              let text = "";
              res.on("data", (c: Buffer) => { text += c.toString(); });
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify({ model: "claude-3", messages: [] }));
        },
      );

      expect(status).toBe(200);
      // Every chunk arrived: the stream ran ~600ms against a 400ms idle bound.
      expect(body).toContain("chunk0");
      expect(body).toContain("chunk5");
    } finally {
      await close(dripping);
    }
  }, 15_000);
});

describe("admission control", () => {
  it("sheds load with 503 and Retry-After once the in-flight cap is reached", async () => {
    // A stalling upstream lets requests pile up in flight.
    const stalling = http.createServer(() => { /* never responds */ });
    stalling.listen(0, "127.0.0.1");
    const stallingPort = await listening(stalling);
    proxyPort = await start(stallingPort);

    const pending: http.ClientRequest[] = [];
    const CAP = 16;
    const TOTAL = CAP + 8;
    try {
      const results = await Promise.all(
        Array.from({ length: TOTAL }, () =>
          new Promise<{ status: number; retryAfter?: string }>((resolve) => {
            const req = http.request(
              { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
              (res) => {
                res.resume();
                resolve({
                  status: res.statusCode ?? 0,
                  retryAfter: res.headers["retry-after"] as string | undefined,
                });
              },
            );
            req.on("error", () => resolve({ status: -1 }));
            pending.push(req);
            req.end(JSON.stringify({ model: "claude-3", messages: [] }));
            // Held-open requests never resolve on their own; 0 means "still in
            // flight", which is the expected outcome for the admitted ones.
            setTimeout(() => resolve({ status: 0 }), 3000);
          }),
        ),
      );

      const shed = results.filter((r) => r.status === 503);
      const admitted = results.filter((r) => r.status === 0);

      // The cap is the contract, not merely "some request was rejected".
      expect(admitted).toHaveLength(CAP);
      expect(shed).toHaveLength(TOTAL - CAP);
      // Retry-After is what makes this backpressure rather than a bare failure.
      expect(shed.every((r) => r.retryAfter === "1")).toBe(true);
    } finally {
      for (const req of pending) req.destroy();
      await close(stalling);
    }
  }, 20_000);

  it("keeps answering /healthz while saturated — liveness must not be shed", async () => {
    const stalling = http.createServer(() => { /* never responds */ });
    stalling.listen(0, "127.0.0.1");
    const stallingPort = await listening(stalling);
    proxyPort = await start(stallingPort);

    const pending: http.ClientRequest[] = [];
    try {
      for (let i = 0; i < 80; i++) {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          path: "/v1/messages",
          method: "POST",
        });
        req.on("error", () => { /* expected */ });
        pending.push(req);
        req.end(JSON.stringify({ model: "claude-3", messages: [] }));
      }
      await new Promise((r) => setTimeout(r, 300));

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: proxyPort, path: "/healthz" },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
      });

      // This is the point of exempting it: liveness has to answer precisely when
      // the proxy is saturated, which is when the operator most needs to see it.
      expect(status).toBe(200);
    } finally {
      for (const req of pending) req.destroy();
      await close(stalling);
    }
  }, 20_000);
});
