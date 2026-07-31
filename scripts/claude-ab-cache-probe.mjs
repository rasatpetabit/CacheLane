#!/usr/bin/env node
/** Direct-Anthropic, cache-isolated three-arm cache experiment. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { candidatePrefixState, countTokens, planAndApplyMarkers } from "../dist/index.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback; };
const sessions = Number(arg("--sessions", "3"));
const turns = Number(arg("--turns", "20"));
const model = arg("--model", "claude-haiku-4-5-20251001");
const out = arg("--out", join(homedir(), ".cachelane-ops", `claude-ab-${Date.now()}.json`));
const token = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"))?.claudeAiOauth?.accessToken;
if (typeof token !== "string" || token.length < 10) throw new Error("Claude OAuth token unavailable");
const requestDelayMs = Number(arg("--delay-ms", "1500"));
const maxRateLimitRetries = Number(arg("--rate-limit-retries", "2"));
const marker = { type: "ephemeral", ttl: "5m" };
const content = (text, cached = false) => ({ type: "text", text, ...(cached ? { cache_control: marker } : {}) });

function topology(body) {
  const rows = [];
  for (const [i, b] of (body.system ?? []).entries()) if (b.cache_control) rows.push(`system:${i}:${b.cache_control.ttl}`);
  for (const [mi, m] of body.messages.entries()) for (const [ci, b] of m.content.entries()) if (b.cache_control) rows.push(`message:${mi}:${ci}:${b.cache_control.ttl}`);
  return rows;
}
async function call(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const result = { status: res.status, usage: json.usage ?? null, error: res.ok ? null : json.error?.type ?? "unknown" };
    if (res.status !== 429) return result;
    if (attempt >= maxRateLimitRetries) throw new Error(`Anthropic rate limit persisted after ${attempt + 1} attempts; aborting experiment`);
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000 * (attempt + 1);
    console.error(`rate limited; backing off ${backoffMs}ms before retry ${attempt + 1}/${maxRateLimitRetries}`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

function applyArm(arm, stable, completedHistory, currentTurn, previous) {
  const messages = structuredClone(completedHistory);
  const system = [content(stable, true)];
  if (arm === "passthrough") {
    // Claude-Code-shaped incoming topology: system marker plus the latest
    // completed assistant response as a moving conversation breakpoint.
    const latestAssistant = messages.findLastIndex((m) => m.role === "assistant");
    if (latestAssistant >= 0) messages[latestAssistant].content.at(-1).cache_control = marker;
  }
  messages.push({ role: "user", content: [content(`current-${currentTurn}`)] });
  const body = { model, max_tokens: 1, system, messages };
  if (arm === "candidate") return planAndApplyMarkers(body, "candidate", "5m", previous);
  if (arm === "prefix_only") return planAndApplyMarkers(body, "prefix_only");
  return { request: body, plan: null };
}

async function runArm(arm, session) {
  const salt = `${arm}-${session}-${randomUUID()}`;
  // Use byte-distinct isolation words that the project tokenizer confirms have
  // equal token counts. The gate below still checks every generated prefix.
  const saltHash = createHash("sha256").update(salt).digest("hex");
  const isolationWords = ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "kappa", "lambda", "sigma"];
  const isolationIndex = session - 1 + ["passthrough", "prefix_only", "candidate"].indexOf(arm) * sessions;
  const stable = `CacheLane controlled stable context ${isolationWords[isolationIndex]}. `.repeat(3000);
  const stable_prefix_tokens = countTokens(stable, model);
  const history = [];
  const rows = [];
  let previous;
  for (let turn = 1; turn <= turns; turn++) {
    if (turn > 1) {
      history.push({ role: "user", content: [content(`question-${turn - 1}`)] });
      history.push({ role: "assistant", content: [content(`answer-${turn - 1}`)] });
    }
    const planned = applyArm(arm, stable, history, turn, previous);
    const body = planned.request;
    if (requestDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    const result = await call(body);
    if (arm === "candidate" && result.status >= 200 && result.status < 300) {
      previous = candidatePrefixState(planned, `experiment-${session}`);
    }
    const u = result.usage ?? {};
    rows.push({
      turn,
      status: result.status,
      topology: topology(body),
      input: u.input_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
      create_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0,
      create_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      effective: (u.input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0) + 1.25 * (u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0) + 2 * (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      error: result.error,
    });
  }
  return { arm, session, salt_sha256: saltHash, stable_prefix_tokens, rows };
}

const runs = [];
for (const arm of ["passthrough", "prefix_only", "candidate"]) for (let s = 1; s <= sessions; s++) runs.push(await runArm(arm, s));
const summary = Object.fromEntries(["passthrough", "prefix_only", "candidate"].map((arm) => {
  const armRuns = runs.filter((r) => r.arm === arm);
  const rows = armRuns.flatMap((r) => r.rows.filter((x) => x.turn >= 5));
  const lateMedians = armRuns.map((run) => {
    const values = run.rows.filter((row) => row.turn >= Math.min(20, turns)).map((row) => row.read).sort((a, b) => a - b);
    return values.length === 0 ? 0 : values[Math.floor(values.length / 2)];
  });
  return [arm, {
    samples: rows.length,
    effective: rows.reduce((a, r) => a + r.effective, 0),
    read: rows.reduce((a, r) => a + r.read, 0),
    create_5m: rows.reduce((a, r) => a + r.create_5m, 0),
    create_1h: rows.reduce((a, r) => a + r.create_1h, 0),
    errors: rows.filter((r) => r.status < 200 || r.status >= 300).length,
    late_read_medians: lateMedians,
    topologies: [...new Set(rows.map((r) => r.topology.join("|")))],
  }];
}));
const gates = {
  no_errors: Object.values(summary).every((s) => s.errors === 0),
  candidate_not_worse_than_passthrough: summary.candidate.effective <= summary.passthrough.effective * 1.05,
  candidate_beats_prefix_only: summary.candidate.effective < summary.prefix_only.effective,
  equal_stable_prefix_tokens: new Set(runs.map((run) => run.stable_prefix_tokens)).size === 1,
  candidate_grows_beyond_static_prefix: summary.candidate.late_read_medians.filter(
    (value, index) => {
      const run = runs.find((candidate) => candidate.arm === "candidate" && candidate.session === index + 1);
      const staticCreation = run?.rows[0]?.create_5m ?? 0;
      return value > staticCreation;
    },
  ).length >= 2,
  distinct_arm_topologies:
    JSON.stringify(summary.passthrough.topologies) !== JSON.stringify(summary.prefix_only.topologies) &&
    JSON.stringify(summary.candidate.topologies) !== JSON.stringify(summary.prefix_only.topologies) &&
    JSON.stringify(summary.candidate.topologies) !== JSON.stringify(summary.passthrough.topologies),
};
const report = { ts: new Date().toISOString(), model, sessions, turns, summary, gates, runs };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, runs: undefined }, null, 2));
console.error(`wrote → ${out}`);
if (!Object.values(gates).every(Boolean)) process.exitCode = 2;
