/**
 * Task 7 — proxy SAFELY handles OpenAI /v1/chat/completions requests.
 *
 * OpenAI requests MUST NOT pass through the Anthropic breakpoint pipeline (which
 * injects `cache_control` blocks OpenAI rejects with HTTP 400). Instead they get
 * OpenAI cache hints (`prompt_cache_key`) and keepalive/Bedrock signing are skipped.
 *
 * Mirrors the integration harness in server.test.ts: real proxy + fake upstream +
 * real SQLite DB.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startProxy } from "../server.js";
import { selectAdapter } from "../../providers/registry.js";

// ---------------------------------------------------------------------------
// Unit: adapter policy
// ---------------------------------------------------------------------------

describe("openai pipeline — adapter policy", () => {
  it("openai adapter disables keepalive", () => {
    const a = selectAdapter("POST", "/v1/chat/completions");
    expect(a?.cachePolicy.supportsKeepalive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: OpenAI request through the proxy
// ---------------------------------------------------------------------------

/** An OpenAI chat request with tools + messages → exercises the OpenAI branch. */
function buildOpenAIRequest(): Record<string, unknown> {
  return {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "What is 2+2?" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    max_tokens: 256,
  };
}

function openAIResponseBody(): string {
  return JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  });
}

function postChat(
  proxyPort: number,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, "utf-8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(bodyBuf.length),
          authorization: "Bearer sk-test-key",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function waitForServer(server: http.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    if (server.listening) {
      resolve((server.address() as net.AddressInfo).port);
      return;
    }
    server.once("listening", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const s = server as { closeAllConnections?: () => void };
    if (typeof s.closeAllConnections === "function") s.closeAllConnections();
    server.close(() => resolve());
  });
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let fakeUpstream: http.Server;
let fakeUpstreamPort: number;
let lastCaptured: CapturedRequest | null = null;

beforeAll(async () => {
  fakeUpstream = http.createServer((req, upstreamRes) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastCaptured = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      upstreamRes.writeHead(200, { "content-type": "application/json" });
      upstreamRes.end(openAIResponseBody());
    });
  });
  fakeUpstream.listen(0, "127.0.0.1");
  fakeUpstreamPort = await waitForServer(fakeUpstream);
});

afterAll(async () => {
  await closeServer(fakeUpstream);
});

let tmpDir: string;
let dbPath: string;
let proxy: http.Server;
let proxyPort: number;
let originalEnvCachelaneHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-openai-test-"));
  dbPath = path.join(tmpDir, "test.db");
  originalEnvCachelaneHome = process.env.CACHELANE_HOME;
  process.env.CACHELANE_HOME = tmpDir;
  lastCaptured = null;

  proxy = startProxy({
    port: 0,
    db_path: dbPath,
    workspace_id: "test-ws",
    session_id: "test-session",
    upstream: { host: "127.0.0.1", port: fakeUpstreamPort, ssl: false },
  });
  proxyPort = await waitForServer(proxy);
});

afterEach(async () => {
  await closeServer(proxy);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalEnvCachelaneHome !== undefined) {
    process.env.CACHELANE_HOME = originalEnvCachelaneHome;
  } else {
    delete process.env.CACHELANE_HOME;
  }
});

describe("openai pipeline — forwarded request", () => {
  it("injects prompt_cache_key into the forwarded OpenAI body", async () => {
    const res = await postChat(proxyPort, JSON.stringify(buildOpenAIRequest()));

    expect(res.status).toBe(200);
    expect(lastCaptured).not.toBeNull();
    const forwarded = JSON.parse(lastCaptured!.body) as { prompt_cache_key?: string };
    expect(typeof forwarded.prompt_cache_key).toBe("string");
    expect(forwarded.prompt_cache_key).toMatch(/^cachelane-/);
  });

  // Regression: the OpenAI branch wrote a turn explanation with no `provenance`
  // at all, so the column fell back to its '{}' default. In production that left
  // 7,856 of 7,856 LiteLLM-lane turns untagged — a regression on that lane could
  // not be attributed to a build, because no turn carried one.
  it("records build-attributable provenance on the OpenAI path", async () => {
    const res = await postChat(proxyPort, JSON.stringify(buildOpenAIRequest()));
    expect(res.status).toBe(200);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT provenance_json FROM turn_explanations ORDER BY id DESC LIMIT 1")
        .get() as { provenance_json: string } | undefined;
      expect(row).toBeDefined();

      const provenance = JSON.parse(row!.provenance_json) as Record<string, unknown>;
      expect(typeof provenance.build_sha).toBe("string");
      expect((provenance.build_sha as string).length).toBeGreaterThan(0);
      expect(provenance.route).toBe("proxy");
      expect(provenance.outcome).toBe("ok");

      // Empty by construction, not unknown: this path never plans or emits an
      // Anthropic cache_control marker, so asserting [] is the honest contract.
      expect(provenance.incoming_markers).toEqual([]);
      expect(provenance.emitted_markers).toEqual([]);
      // The OpenAI prefix hash is real and drives prompt_cache_key.
      expect(Array.isArray(provenance.prefix_hash_at_bp)).toBe(true);
      expect((provenance.prefix_hash_at_bp as string[]).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("never injects Anthropic cache_control anywhere in the forwarded body", async () => {
    await postChat(proxyPort, JSON.stringify(buildOpenAIRequest()));

    expect(lastCaptured).not.toBeNull();
    expect(lastCaptured!.body).not.toContain("cache_control");
  });

  it("preserves the messages array order (chat order is semantic)", async () => {
    await postChat(proxyPort, JSON.stringify(buildOpenAIRequest()));

    expect(lastCaptured).not.toBeNull();
    const forwarded = JSON.parse(lastCaptured!.body) as {
      messages: { role: string; content: string }[];
    };
    expect(forwarded.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(forwarded.messages.map((m) => m.content)).toEqual([
      "You are a helpful assistant.",
      "Hello",
      "Hi there",
      "What is 2+2?",
    ]);
  });

  it("forwards the inbound Authorization header (no SigV4, no x-api-key strip)", async () => {
    await postChat(proxyPort, JSON.stringify(buildOpenAIRequest()));

    expect(lastCaptured?.headers["authorization"]).toBe("Bearer sk-test-key");
  });
});

// ---------------------------------------------------------------------------
// Integration: the stateless elision arm on the OpenAI path
// ---------------------------------------------------------------------------

/**
 * The OpenAI branch has its own elision code path, separate from
 * handlePreRequest. It gets its own end-to-end coverage: the arm is selected
 * from config, the transformed body is what actually reaches the upstream, and
 * both kill switches still work.
 */
describe("openai pipeline — stateless elision arm", () => {
  const BIG = "z".repeat(8000);
  let armTmp: string;
  let armProxy: http.Server;
  let armPort: number;

  /** An OpenAI conversation deep enough for elision to fire. */
  function toolConversation(turns: number): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    for (let t = 0; t < turns; t++) {
      messages.push({ role: "user", content: `turn ${t}` });
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${t}`,
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      });
      messages.push({ role: "tool", tool_call_id: `call_${t}`, content: BIG });
    }
    return { model: "gpt-4o", messages };
  }

  async function startWithFeatures(features: Record<string, unknown>): Promise<void> {
    armTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-openai-arm-"));
    const configPath = path.join(armTmp, "config.json");
    const base = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"),
    ) as { features: Record<string, unknown> };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...base, features: { ...base.features, ...features } }),
    );

    lastCaptured = null;
    armProxy = startProxy({
      port: 0,
      db_path: path.join(armTmp, "arm.db"),
      config_path: configPath,
      workspace_id: "test-ws",
      session_id: "arm-session",
      upstream: { host: "127.0.0.1", port: fakeUpstreamPort, ssl: false },
    });
    armPort = await waitForServer(armProxy);
  }

  afterEach(async () => {
    if (armProxy) await closeServer(armProxy);
    if (armTmp) fs.rmSync(armTmp, { recursive: true, force: true });
  });

  /** Tool messages in the forwarded body whose content was replaced by a stub. */
  function forwardedStubCount(): number {
    const forwarded = JSON.parse(lastCaptured!.body) as {
      messages: { role: string; content?: unknown }[];
    };
    return forwarded.messages.filter(
      (m) => m.role === "tool" && String(m.content).includes("cachelane:elided"),
    ).length;
  }

  it("elides tool output in the body that actually reaches the upstream", async () => {
    await startWithFeatures({ elision_mode: "stateless", mutation_enabled: true });
    await postChat(armPort, JSON.stringify(toolConversation(20)));

    expect(lastCaptured).not.toBeNull();
    expect(forwardedStubCount()).toBeGreaterThan(0);
    // The pairing invariant survives: one tool message per tool_calls id.
    const forwarded = JSON.parse(lastCaptured!.body) as {
      messages: { role: string; tool_call_id?: string }[];
    };
    expect(forwarded.messages.filter((m) => m.role === "tool")).toHaveLength(20);
  });

  it("forwards nothing elided under the legacy arm with an empty block table", async () => {
    // The discriminator: legacy decides from the DB, which has no rows here.
    await startWithFeatures({ elision_mode: "legacy", mutation_enabled: true });
    await postChat(armPort, JSON.stringify(toolConversation(20)));

    expect(lastCaptured).not.toBeNull();
    expect(forwardedStubCount()).toBe(0);
  });

  it("honours the k_pruner kill switch", async () => {
    await startWithFeatures({
      elision_mode: "stateless",
      mutation_enabled: true,
      k_pruner: false,
    });
    await postChat(armPort, JSON.stringify(toolConversation(20)));

    expect(lastCaptured).not.toBeNull();
    expect(forwardedStubCount()).toBe(0);
    expect(lastCaptured!.body).toContain(BIG);
  });

  it("forwards the client's body untouched when mutation is disabled", async () => {
    // Checking only that BIG survives is not enough: elision keeps the most
    // recent tool outputs, so a body with the old ones stubbed still contains
    // BIG. Assert zero stubs, and that every tool message is byte-identical.
    await startWithFeatures({ elision_mode: "stateless", mutation_enabled: false });
    const sent = toolConversation(20);
    await postChat(armPort, JSON.stringify(sent));

    expect(lastCaptured).not.toBeNull();
    expect(forwardedStubCount()).toBe(0);

    const forwarded = JSON.parse(lastCaptured!.body) as {
      messages: { role: string; content?: unknown }[];
    };
    const toolContents = (m: { messages: { role: string; content?: unknown }[] }) =>
      m.messages.filter((x) => x.role === "tool").map((x) => x.content);
    expect(toolContents(forwarded)).toEqual(
      toolContents(sent as { messages: { role: string; content?: unknown }[] }),
    );
  });

  it("does not claim elided bytes for a body it forwarded intact", async () => {
    // elided_bytes is what Gate 5 measures the feature by. Reporting bytes
    // removed while sending the original is worse than reporting nothing.
    await startWithFeatures({ elision_mode: "stateless", mutation_enabled: false });
    await postChat(armPort, JSON.stringify(toolConversation(20)));

    const db = new Database(path.join(armTmp, "arm.db"), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT provenance_json FROM turn_explanations")
        .all() as { provenance_json: string | null }[];
      // Without this the whole assertion passes on an empty table.
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        const provenance = JSON.parse(row.provenance_json ?? "{}") as {
          elided_bytes?: number;
          elision_mode?: string;
        };
        expect(provenance.elided_bytes ?? 0).toBe(0);
        // Mutation-off IS the Gate 5 control lane. It must still be recorded as
        // the stateless arm — labelling it "legacy" would compare
        // stateless-on against legacy-off and call the difference an effect.
        expect(provenance.elision_mode).toBe("stateless");
      }
    } finally {
      db.close();
    }
  });
});
