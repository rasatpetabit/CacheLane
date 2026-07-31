#!/usr/bin/env node
/**
 * Real-provider Anthropic cache conformance probe.
 *
 * This script is intentionally independent from CacheLane mutation. It answers
 * whether Anthropic reuses a previously written cumulative prefix when a later
 * request emits a deeper message breakpoint. Results are structured JSON and
 * never include authorization headers or prompt text.
 *
 * Usage:
 *   node scripts/anthropic-cache-conformance.mjs --out ~/.cachelane-ops/conformance.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function readOAuth() {
  const p = join(homedir(), ".claude", ".credentials.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  const token = c?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token.length < 10) throw new Error(`Claude OAuth token unavailable at ${p}`);
  return token;
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const out = arg("--out", join(homedir(), ".cachelane-ops", `conformance-${Date.now()}.json`));
const model = arg("--model", process.env.CACHELANE_CONFORMANCE_MODEL ?? "claude-haiku-4-5-20251001");
const token = readOAuth();
const salt = randomUUID();
const anchor = `Cache conformance anchor ${salt}. `.repeat(700); // exceed minimum cacheable prefix
const cc5m = { type: "ephemeral", ttl: "5m" };

function text(s, cached = false) {
  return { type: "text", text: s, ...(cached ? { cache_control: cc5m } : {}) };
}

async function call(label, messages) {
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ model, max_tokens: 1, messages }),
  });
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* record status only */ }
  const usage = body?.usage ?? {};
  return {
    label,
    status: res.status,
    latency_ms: Date.now() - started,
    usage: {
      input_tokens: usage.input_tokens ?? null,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    },
    error_type: res.ok ? null : (body?.error?.type ?? "unknown"),
  };
}

const history = [
  { role: "user", content: [text(anchor, true)] },
  { role: "assistant", content: [text("Acknowledged.")] },
];
const results = [];
results.push(await call("write_anchor", [...history, { role: "user", content: [text("Step one?")] }]));
results.push(await call("read_anchor", [...history, { role: "user", content: [text("Step two?")] }]));

// Deeper frontier: keep the exact written anchor and add a second marker at the
// end of completed history. This tests retained read-anchor + write-frontier.
const deeper = [
  ...history,
  { role: "user", content: [text("Stable completed exchange.")] },
  { role: "assistant", content: [text("Completed exchange response.", true)] },
];
results.push(await call("retained_anchor_plus_frontier_write", [...deeper, { role: "user", content: [text("Step three?")] }]));
results.push(await call("retained_anchor_plus_frontier_read", [...deeper, { role: "user", content: [text("Step four?")] }]));

const report = {
  ts: new Date().toISOString(),
  model,
  probe_version: 1,
  salt_sha_redacted: salt.slice(0, 8),
  results,
  gates: {
    anchor_read_observed: (results[1]?.usage.cache_read_input_tokens ?? 0) > 0,
    deeper_read_observed: (results[3]?.usage.cache_read_input_tokens ?? 0) > (results[1]?.usage.cache_read_input_tokens ?? 0),
    no_http_errors: results.every((r) => r.status >= 200 && r.status < 300),
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error(`wrote → ${out}`);
if (!report.gates.anchor_read_observed || !report.gates.deeper_read_observed || !report.gates.no_http_errors) process.exitCode = 2;
