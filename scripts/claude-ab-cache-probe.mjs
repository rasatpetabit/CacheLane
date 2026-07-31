#!/usr/bin/env node
/**
 * Three-arm Anthropic cache experiment.
 * Arms are cache-isolated by a unique stable prefix. Passthrough uses a
 * Claude-Code-shaped system marker; prefix_only emulates current CacheLane;
 * candidate retains the previous frontier and writes a deeper one.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const sessions = Number(arg("--sessions", "3"));
const turns = Number(arg("--turns", "20"));
const model = arg("--model", "claude-haiku-4-5-20251001");
const out = arg("--out", join(homedir(), ".cachelane-ops", `claude-ab-${Date.now()}.json`));
const creds = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
const token = creds?.claudeAiOauth?.accessToken;
if (!token) throw new Error("Claude OAuth token unavailable");
const marker = { type: "ephemeral", ttl: "5m" };

async function call(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, usage: json.usage ?? null, error: res.ok ? null : json.error?.type ?? "unknown" };
}

function content(text, cached = false) {
  return { type: "text", text, ...(cached ? { cache_control: marker } : {}) };
}

async function runArm(arm, session) {
  const salt = `${arm}-${session}-${randomUUID()}`;
  const stable = `CacheLane controlled stable context ${salt}. `.repeat(500);
  const messages = [];
  const rows = [];
  let previousFrontier = null;
  for (let turn = 1; turn <= turns; turn++) {
    if (turn > 1) {
      messages.push({ role: "user", content: [content(`question-${turn - 1}`)] });
      messages.push({ role: "assistant", content: [content(`answer-${turn - 1}`)] });
    }
    const system = [content(stable, arm === "passthrough" || arm === "prefix_only" || arm === "candidate")];
    const callMessages = structuredClone(messages);
    if (arm === "candidate" && callMessages.length > 0) {
      if (previousFrontier !== null) callMessages[previousFrontier].content.at(-1).cache_control = marker;
      const frontier = callMessages.length - 1;
      callMessages[frontier].content.at(-1).cache_control = marker;
      previousFrontier = frontier;
    }
    callMessages.push({ role: "user", content: [content(`current-${turn}`)] });
    const result = await call({ model, max_tokens: 1, system, messages: callMessages });
    const u = result.usage ?? {};
    rows.push({
      turn,
      status: result.status,
      input: u.input_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
      create: u.cache_creation_input_tokens ?? 0,
      effective: (u.input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0),
      error: result.error,
    });
  }
  return { arm, session, rows };
}

const runs = [];
for (const arm of ["passthrough", "prefix_only", "candidate"]) {
  for (let s = 1; s <= sessions; s++) runs.push(await runArm(arm, s));
}
const summary = Object.fromEntries(["passthrough", "prefix_only", "candidate"].map((arm) => {
  const rows = runs.filter((r) => r.arm === arm).flatMap((r) => r.rows.filter((x) => x.turn >= 5));
  return [arm, {
    samples: rows.length,
    effective: rows.reduce((a, r) => a + r.effective, 0),
    read: rows.reduce((a, r) => a + r.read, 0),
    create: rows.reduce((a, r) => a + r.create, 0),
    errors: rows.filter((r) => r.status < 200 || r.status >= 300).length,
  }];
}));
const gates = {
  no_errors: Object.values(summary).every((s) => s.errors === 0),
  candidate_not_worse_than_passthrough: summary.candidate.effective <= summary.passthrough.effective * 1.05,
  candidate_beats_prefix_only: summary.candidate.effective < summary.prefix_only.effective,
};
const report = { ts: new Date().toISOString(), model, sessions, turns, summary, gates, runs };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, runs: undefined }, null, 2));
console.error(`wrote → ${out}`);
if (!Object.values(gates).every(Boolean)) process.exitCode = 2;
