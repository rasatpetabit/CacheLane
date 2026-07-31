/**
 * Request spans and the clientError handler.
 *
 * Before this, the proxy recorded no request durations anywhere: every
 * `Date.now()` in server.ts was a record timestamp, never a t0/t1 pair. The
 * operator's "CacheLane is slow" was therefore unfalsifiable, and so was any
 * claim that it had been fixed. The single per-request log line (`incoming`)
 * had no completion event and no correlation id, so an aborted request left a
 * start line indistinguishable from one still in flight.
 *
 * Requests that fail before Node can parse them never reached the handler at
 * all and produced no line of any kind.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The log home must be set before `../server.js` is imported, not in a
 * beforeEach: src/logger builds its singleton at import time and binds its
 * directory then. `vi.hoisted` is the only hook that runs ahead of the import
 * graph, so this is hoisted above the static import below.
 */
const { HOME, ORIGINAL_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  // Captured before the overwrite, so teardown can genuinely restore it.
  const original = process.env.CACHELANE_HOME;
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "cachelane-spans-"));
  process.env.CACHELANE_HOME = dir;
  return { HOME: dir, ORIGINAL_HOME: original };
});

import { startProxy } from "../server.js";

const LOG_FILE = path.join(HOME, "cachelane.log");

let tmpDir: string;
let proxy: http.Server;
let proxyPort: number;
let upstream: http.Server;
let upstreamPort: number;
let savedHome: string | undefined;

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

/** Every line the proxy has logged so far, newest last. */
function readLog(): Record<string, unknown>[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs
    .readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function payload(entry: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(entry.message)) as Record<string, unknown>;
}

/** Poll until `predicate` holds — log writes land on a later tick than the response. */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met within timeout");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-spans-db-"));
  savedHome = process.env.CACHELANE_HOME;
  process.env.CACHELANE_HOME = HOME;
  // The logger appends to one file for the whole file's lifetime, so each test
  // starts from an empty one rather than a fresh directory.
  fs.writeFileSync(LOG_FILE, "");

  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  upstreamPort = await listening(upstream);

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
  if (savedHome === undefined) delete process.env.CACHELANE_HOME;
  else process.env.CACHELANE_HOME = savedHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The hoisted block reassigned a process-global before any test ran, so restore
// it here rather than leaving the next test file to inherit this one's home.
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.CACHELANE_HOME;
  else process.env.CACHELANE_HOME = ORIGINAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("request spans", () => {
  it("emits a terminal span carrying a duration, correlated to its incoming line", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "claude-3", messages: [] }));
    });

    await until(() => readLog().some((e) => e.event === "request complete"));

    const log = readLog();
    const incoming = log.find((e) => e.event === "incoming");
    const complete = log.find((e) => e.event === "request complete");
    expect(incoming).toBeDefined();
    expect(complete).toBeDefined();

    const started = payload(incoming!);
    const finished = payload(complete!);

    // The correlation id is the point: without it a start line cannot be
    // matched to its outcome, which is what made orphaned requests invisible.
    expect(typeof started.req_id).toBe("string");
    expect(finished.req_id).toBe(started.req_id);

    expect(typeof finished.t_total_ms).toBe("number");
    expect(finished.t_total_ms as number).toBeGreaterThanOrEqual(0);
    expect(finished.completed).toBe(true);
    expect(finished.status).toBe(200);
  });

  it("marks a client-aborted request as not completed", async () => {
    // A hanging upstream, so the client can abort mid-flight. It signals when
    // the proxy has actually forwarded the request — waiting a fixed delay
    // instead would race under load and destroy the client before the proxy had
    // begun, leaving no span at all.
    let upstreamGotRequest: () => void;
    const forwarded = new Promise<void>((r) => { upstreamGotRequest = r; });
    const stalling = http.createServer((req) => {
      req.resume();
      req.on("end", () => upstreamGotRequest());
    });
    stalling.listen(0, "127.0.0.1");
    const stallingPort = await listening(stalling);

    const stalledProxy = startProxy({
      port: 0,
      db_path: path.join(tmpDir, "stalled.db"),
      workspace_id: "ws",
      session_id: "sess",
      upstream: { host: "127.0.0.1", port: stallingPort, ssl: false },
    });
    const stalledPort = await listening(stalledProxy);

    try {
      const req = http.request({
        host: "127.0.0.1",
        port: stalledPort,
        path: "/v1/messages",
        method: "POST",
      });
      req.on("error", () => { /* expected — we destroy it below */ });
      req.end(JSON.stringify({ model: "claude-3", messages: [] }));

      await forwarded;
      req.destroy();

      await until(() => readLog().some((e) => e.event === "request complete"));
      const complete = readLog().find((e) => e.event === "request complete");
      // This is the distinction that makes a silent truncation visible: the
      // span exists, but it did not finish.
      expect(payload(complete!).completed).toBe(false);
    } finally {
      await close(stalledProxy);
      await close(stalling);
    }
  });

  it("does not emit spans for /healthz, which is excluded from request accounting", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: proxyPort, path: "/healthz" },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
    });

    // Sleeping and then asserting absence would pass by default if the write
    // were merely late. Instead drive a request that *must* produce a span, wait
    // for it, and then assert the only span present is that one — by which point
    // any /healthz span would already have been flushed.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "claude-3", messages: [] }));
    });

    await until(() => readLog().some((e) => e.event === "request complete"));

    const spans = readLog().filter((e) => e.event === "request complete");
    expect(spans).toHaveLength(1);
    expect(payload(spans[0]!).path).toBe("/v1/messages");
  });
});

describe("clientError handler", () => {
  /** Send raw bytes, resolve with whatever comes back before close. */
  function raw(bytes: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let received = "";
      socket.on("connect", () => socket.write(bytes));
      socket.on("data", (c) => { received += c.toString(); });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      setTimeout(() => socket.destroy(), 2000);
    });
  }

  it("answers a malformed request with 400 rather than a bare reset", async () => {
    // Garbage where the request line belongs.
    const response = await raw("!!! NOT HTTP !!!\r\n\r\n");
    expect(response).toContain("400 Bad Request");
  });

  it("logs the client error, so a pre-parse failure is no longer invisible", async () => {
    await raw("!!! NOT HTTP !!!\r\n\r\n");
    await until(() => readLog().some((e) => e.event === "client error"));

    const entry = readLog().find((e) => e.event === "client error");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("warn");
  });

  it("closes the socket — a logging-only handler would leak the connection", async () => {
    // Must observe the *server* closing the connection. `raw()` cannot prove
    // this: its own 2s destroy timer resolves the promise either way, so a
    // handler that only logged would still pass. Here the FIN from the server
    // ('end') is the signal, and the fallback timer reports failure rather than
    // masquerading as success.
    const closedByServer = await new Promise<boolean>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false); // server never closed it — the leak this guards against
      }, 3000);
      socket.on("connect", () => socket.write("!!! NOT HTTP !!!\r\n\r\n"));
      socket.on("data", () => { /* drain */ });
      socket.on("end", () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // A reset is also the server disposing of the connection.
        if (e.code === "ECONNRESET") resolve(true);
        else reject(e);
      });
    });

    expect(closedByServer).toBe(true);
  });

  // clientError can fire for a malformed *pipelined* request while an earlier
  // valid one on the same socket is still being answered. Writing a status line
  // then would splice "HTTP/1.1 400..." into that response's body.
  it("never splices an error status into a response already in flight", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let received = "";
      socket.on("connect", () => {
        // A valid request immediately followed by garbage, in one write, so the
        // parser meets the malformed bytes while the first is still in flight.
        const bodyText = JSON.stringify({ model: "claude-3", messages: [] });
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: x\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(bodyText)}\r\n\r\n${bodyText}` +
            `!!! NOT HTTP !!!\r\n\r\n`,
        );
      });
      socket.on("data", (c) => { received += c.toString(); });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      setTimeout(() => socket.destroy(), 2000);
    });

    const firstStatusEnd = response.indexOf("\r\n");
    const firstStatus = response.slice(0, firstStatusEnd);
    expect(firstStatus).toContain("200");

    // The corruption this guards against: a second status line appearing inside
    // what the client is reading as the first response's body.
    expect(response.slice(firstStatusEnd)).not.toContain("HTTP/1.1 400");
  });

  // Several valid pipelined requests can be outstanding at once. Tracking them
  // with a set rather than a count meant the first response to finish tore the
  // socket down, truncating the others.
  it("delivers every pipelined response before closing, not just the first", async () => {
    const bodyText = JSON.stringify({ model: "claude-3", messages: [] });
    const one =
      `POST /v1/messages HTTP/1.1\r\nHost: x\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(bodyText)}\r\n\r\n${bodyText}`;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let received = "";
      // Three valid requests, then garbage — so clientError fires while more
      // than one response is still outstanding.
      socket.on("connect", () =>
        socket.write(one + one + one + "!!! NOT HTTP !!!\r\n\r\n"),
      );
      socket.on("data", (c) => { received += c.toString(); });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      setTimeout(() => socket.destroy(), 4000);
    });

    const statusLines = response.split("\r\n").filter((l) => l.startsWith("HTTP/1.1"));
    expect(statusLines).toHaveLength(3);
    expect(statusLines.every((l) => l.includes("200"))).toBe(true);
  });
});
