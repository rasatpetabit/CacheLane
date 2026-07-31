#!/usr/bin/env node
/**
 * Real-provider Anthropic prompt-cache conformance suite.
 * Direct OAuth only; reports contain hashes/topologies/usage, never prompt text.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const out = arg("--out", join(homedir(), ".cachelane-ops", `conformance-${Date.now()}.json`));
const model = arg("--model", process.env.CACHELANE_CONFORMANCE_MODEL ?? "claude-haiku-4-5-20251001");
const p = join(homedir(), ".claude", ".credentials.json");
const token = JSON.parse(readFileSync(p, "utf8"))?.claudeAiOauth?.accessToken;
if (typeof token !== "string" || token.length < 10) throw new Error(`Claude OAuth token unavailable at ${p}`);
const salt = randomUUID();
const stable = `Cache conformance stable context ${salt}. `.repeat(700);
const marker5m = { type: "ephemeral", ttl: "5m" };
const marker1h = { type: "ephemeral", ttl: "1h" };
const text = (value, marker) => ({ type: "text", text: value, ...(marker ? { cache_control: marker } : {}) });
const message = (role, value, marker) => ({ role, content: [text(value, marker)] });

function topology(body) {
  const rows = [];
  for (const [i, block] of (body.system ?? []).entries()) if (block.cache_control) rows.push(`system:${i}:${block.cache_control.ttl}`);
  for (const [i, tool] of (body.tools ?? []).entries()) if (tool.cache_control) rows.push(`tool:${i}:${tool.cache_control.ttl}`);
  for (const [mi, msg] of body.messages.entries()) for (const [ci, block] of msg.content.entries()) {
    if (block.cache_control) rows.push(`message:${mi}:${ci}:${block.cache_control.ttl}`);
  }
  return rows;
}

async function call(probe, step, body, expectStatus = 200) {
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ model, max_tokens: 1, ...body }),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* status is enough */ }
  const usage = json?.usage ?? {};
  return {
    probe,
    step,
    expected_status: expectStatus,
    status: res.status,
    latency_ms: Date.now() - started,
    topology: topology(body),
    usage: {
      input_tokens: usage.input_tokens ?? null,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    },
    error_type: res.ok ? null : (json?.error?.type ?? "unknown"),
  };
}

const results = [];
const run = async (...args) => { const row = await call(...args); results.push(row); return row; };

// P1/P3: write A, move deeper with and without retained anchor, then read deeper.
const anchor = [message("user", stable, marker5m), message("assistant", "ack")];
const p1a = await run("moving_within_lookback", "write_anchor", { messages: [...anchor, message("user", "p1-a")] });
const moving = [...anchor.map((m) => structuredClone(m)), message("user", "stable exchange"), message("assistant", "complete", marker5m)];
delete moving[0].content[0].cache_control;
const p1b = await run("moving_within_lookback", "single_deeper_write", { messages: [...moving, message("user", "p1-b")] });
const p1c = await run("moving_within_lookback", "single_deeper_read", { messages: [...moving, message("user", "p1-c")] });
// P1b: move the breakpoint beyond Anthropic's documented 20-block lookback.
// Retaining the original anchor should still allow the deeper frontier to reuse
// the cached prefix, while a single moving marker would not be discoverable.
const beyondLookback = [message("user", stable, marker5m)];
for (let i = 0; i < 11; i++) {
  beyondLookback.push(message("assistant", `lookback-answer-${i}`));
  beyondLookback.push(message("user", `lookback-question-${i}`));
}
beyondLookback.push(message("assistant", "lookback-frontier", marker5m));
const p1d = await run("moving_beyond_lookback", "frontier_write", { messages: [...beyondLookback, message("user", "p1-d")] });
const p1e = await run("moving_beyond_lookback", "frontier_read", { messages: [...beyondLookback, message("user", "p1-e")] });
const retained = [...anchor.map((m) => structuredClone(m)), message("user", "retained exchange"), message("assistant", "complete", marker5m)];
const p3a = await run("retained_anchor_frontier", "frontier_write", { messages: [...retained, message("user", "p3-a")] });
const p3b = await run("retained_anchor_frontier", "frontier_read", { messages: [...retained, message("user", "p3-b")] });

// P2: five message markers document/provider-enforce the max-four breakpoint limit.
const tooMany = Array.from({ length: 5 }, (_, i) => message(i % 2 === 0 ? "user" : "assistant", i === 0 ? stable : `limit-${i}`, marker5m));
const p2 = await run("breakpoint_limit", "five_markers", { messages: tooMany }, 400);

// P4: parallel tool calls/results remain one completed unit before the frontier.
const tools = [
  { name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } }, cache_control: marker5m },
  { name: "Grep", description: "grep", input_schema: { type: "object", properties: { q: { type: "string" } } } },
];
const parallel = [
  message("user", stable),
  { role: "assistant", content: [
    { type: "tool_use", id: "toolu_a", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "toolu_b", name: "Grep", input: { q: "b" } },
  ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_a", content: "a-result" },
    { type: "tool_result", tool_use_id: "toolu_b", content: "b-result", cache_control: marker5m },
  ] },
];
const p4a = await run("parallel_tools", "write", { tools, messages: [...parallel, message("user", "p4-a")] });
const p4b = await run("parallel_tools", "read", { tools, messages: [...parallel, message("user", "p4-b")] });

// P5: legal and illegal TTL combinations.
const ttl55 = { system: [text(stable, marker5m)], messages: [message("user", "ttl-55"), message("assistant", "done", marker5m), message("user", "go")] };
const ttl15 = { system: [text(stable, marker1h)], messages: [message("user", "ttl-15"), message("assistant", "done", marker5m), message("user", "go")] };
const ttl51 = { system: [text(stable, marker5m)], messages: [message("user", "ttl-51"), message("assistant", "done", marker1h), message("user", "go")] };
const p5a = await run("ttl_order", "5m_then_5m", ttl55);
const p5b = await run("ttl_order", "1h_then_5m", ttl15);
const p5c = await run("ttl_order", "5m_then_1h_illegal", ttl51, 400);

// P6: same-depth stub replacement invalidates the modified prefix instead of reading it.
const pruneOriginal = [message("user", stable, marker5m), message("assistant", "tool output original ".repeat(80), marker5m)];
const p6a = await run("prune_stub_invalidation", "write_original", { messages: [...pruneOriginal, message("user", "p6-a")] });
const pruneStub = structuredClone(pruneOriginal);
pruneStub[1].content[0].text = "[cachelane stub: pruned tool output]";
const p6b = await run("prune_stub_invalidation", "same_depth_stub", { messages: [...pruneStub, message("user", "p6-b")] });

// P7: Claude-Code-shaped topology: static system marker + moving completed-history marker.
const ccBase = { system: [text(stable, marker5m)] };
let ccMessages = [message("user", "cc-1")];
const p7a = await run("cc_shaped_passthrough", "turn_1", { ...ccBase, messages: ccMessages });
ccMessages = [message("user", "cc-1"), message("assistant", "cc-a1", marker5m), message("user", "cc-2")];
const p7b = await run("cc_shaped_passthrough", "turn_2", { ...ccBase, messages: ccMessages });
ccMessages = [message("user", "cc-1"), message("assistant", "cc-a1"), message("user", "cc-2"), message("assistant", "cc-a2", marker5m), message("user", "cc-3")];
const p7c = await run("cc_shaped_passthrough", "turn_3", { ...ccBase, messages: ccMessages });

const read = (row) => row.usage.cache_read_input_tokens ?? 0;
const create = (row) => row.usage.cache_creation_input_tokens ?? 0;
const gates = {
  moving_within_lookback: p1a.status === 200 && p1b.status === 200 && p1c.status === 200 && read(p1c) > 0,
  moving_beyond_lookback: p1d.status === 200 && p1e.status === 200 && read(p1e) > 0,
  breakpoint_limit_enforced: p2.status === 400,
  retained_anchor_frontier: p3a.status === 200 && p3b.status === 200 && read(p3b) > read(p1a),
  parallel_tools: p4a.status === 200 && p4b.status === 200 && read(p4b) > 0,
  ttl_5m_5m: p5a.status === 200,
  ttl_1h_5m: p5b.status === 200,
  ttl_illegal_rejected: p5c.status === 400,
  prune_stub_invalidates: p6a.status === 200 && p6b.status === 200 && create(p6b) > 0,
  cc_shaped_growth: p7a.status === 200 && p7b.status === 200 && p7c.status === 200 && read(p7c) > read(p7b),
};
const report = {
  ts: new Date().toISOString(), model, probe_version: 3,
  salt_sha256: createHash("sha256").update(salt).digest("hex"),
  results, gates,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: results.map(({ probe, step, status, usage, topology }) => ({ probe, step, status, usage, topology })) }, null, 2));
console.error(`wrote → ${out}`);
if (!Object.values(gates).every(Boolean)) process.exitCode = 2;
