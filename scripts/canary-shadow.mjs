#!/usr/bin/env node
/**
 * CacheLane shadow+canary suite (option 3).
 *
 * Assumes:
 *   - proxy listening on 127.0.0.1:7332 → LiteLLM :4000
 *   - features.mutation_enabled = false (shadow: observe only)
 *   - features.k_pruner = true (still compute reclaim estimates)
 *
 * Canaries:
 *   1. grok-4.5 short non-stream
 *   2. streaming SSE (qwen free + short grok)
 *   3. long context (~32k chars system) on qwen
 *   4. multi-turn K-pruning shadow estimate (tool outputs age to K=3)
 *
 * Usage:
 *   node scripts/canary-shadow.mjs
 *   CACHELANE_URL=http://127.0.0.1:7332 node scripts/canary-shadow.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = process.env.CACHELANE_URL ?? "http://127.0.0.1:7332";
const AUTH = process.env.LITELLM_AUTH ?? "Bearer noauth";
const OUT = process.env.CANARY_OUT ?? "/tmp/cachelane-canary-shadow.json";

const results = {
  started_at: new Date().toISOString(),
  base: BASE,
  mutation_enabled_expected: false,
  cases: [],
};

function sessionHeaders(sessionId) {
  return {
    "Content-Type": "application/json",
    Authorization: AUTH,
    "x-claude-code-session-id": sessionId,
  };
}

async function postChat({ sessionId, body, stream = false }) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: sessionHeaders(sessionId),
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (stream) {
    const text = await res.text();
    return {
      status: res.status,
      ms,
      contentType: res.headers.get("content-type") || "",
      bodyText: text,
      sse: text.includes("data:"),
      done: text.includes("[DONE]") || /data:\s*\[DONE\]/.test(text),
    };
  }
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  return { status: res.status, ms, json };
}

function pad(n, ch = "x") {
  return ch.repeat(n);
}

async function caseGrokShort() {
  const sessionId = `canary-grok-short-${randomUUID()}`;
  const r = await postChat({
    sessionId,
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
      temperature: 0,
    },
  });
  const content = r.json?.choices?.[0]?.message?.content ?? "";
  return {
    name: "grok-4.5 short non-stream",
    sessionId,
    status: r.status,
    ms: r.ms,
    ok: r.status === 200 && typeof content === "string" && content.length > 0,
    content_preview: String(content).slice(0, 80),
    usage: r.json?.usage ?? null,
    error: r.json?.error ?? null,
  };
}

async function caseStream(model, label) {
  const sessionId = `canary-stream-${model}-${randomUUID()}`;
  const r = await postChat({
    sessionId,
    stream: true,
    body: {
      model,
      messages: [{ role: "user", content: "Count: 1 2 3" }],
      max_tokens: 24,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    },
  });
  return {
    name: `streaming SSE (${label})`,
    sessionId,
    status: r.status,
    ms: r.ms,
    contentType: r.contentType,
    ok: r.status === 200 && r.sse,
    sse: r.sse,
    done: r.done,
    body_preview: r.bodyText.slice(0, 200).replace(/\n/g, "\\n"),
  };
}

async function caseLongContext() {
  const sessionId = `canary-longctx-${randomUUID()}`;
  // ~32k chars ≈ ~8k tokens heuristic; free qwen route
  const big = `LONGCTX_MARKER_BEGIN\n${pad(32000, "A")}\nLONGCTX_MARKER_END`;
  const r = await postChat({
    sessionId,
    body: {
      model: "qwen36-27b",
      messages: [
        { role: "system", content: big },
        { role: "user", content: "Reply with exactly: LONG_OK (ignore the padding)." },
      ],
      max_tokens: 16,
      temperature: 0,
    },
  });
  const content = r.json?.choices?.[0]?.message?.content ?? "";
  return {
    name: "long context (~32k system chars, qwen)",
    sessionId,
    status: r.status,
    ms: r.ms,
    ok: r.status === 200 && typeof content === "string",
    content_preview: String(content).slice(0, 80),
    prompt_tokens: r.json?.usage?.prompt_tokens ?? r.json?.usage?.input_tokens ?? null,
    usage: r.json?.usage ?? null,
    error: r.json?.error ?? null,
  };
}

/**
 * Multi-turn shadow prune canary.
 * Injects large role:tool outputs client-side (simulating agent tool history),
 * ages them past K=3, and expects:
 *   - request still succeeds (body unmutated under shadow)
 *   - turn signals include mode:baseline
 *   - pruned_blocks_count / tokens_reclaimed recorded as estimates
 */
async function caseMultiTurnShadowPrune(model, label) {
  const sessionId = `canary-prune-${model}-${randomUUID()}`;
  const bigTool = (id, n) => ({
    role: "tool",
    tool_call_id: id,
    content: `TOOL_BLOB_${id}\n${pad(n, "B")}\nEND_${id}`,
  });

  // blocks.id is a GLOBAL primary key (not session-scoped). Use unique ids per
  // canary session so parallel sessions don't collide on insert (UNIQUE swallow).
  const toolA = `call_${sessionId}_a`;
  const toolB = `call_${sessionId}_b`;
  // ~6k chars each ≈ substantial reclaim estimate
  const toolMsgA = bigTool(toolA, 6000);
  const toolMsgB = bigTool(toolB, 6000);

  const history = [
    { role: "system", content: "You are a terse test assistant. Reply with one short word." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolA,
          type: "function",
          function: { name: "read_log", arguments: "{}" },
        },
        {
          id: toolB,
          type: "function",
          function: { name: "read_diff", arguments: "{}" },
        },
      ],
    },
    toolMsgA,
    toolMsgB,
  ];

  const turns = [];
  // Turns 1..5: keep tool outputs present; K default=3 so by turn 4+ they should be prunable
  for (let i = 1; i <= 5; i++) {
    const messages = [
      ...history,
      ...Array.from({ length: i }, (_, k) => ({
        role: "user",
        content: `turn ${k + 1}: ack`,
      })),
      // re-include assistant/tool pairs only once at start (already in history)
    ];
    // For subsequent turns, append short user/assistant chatter after tools so tools age
    if (i > 1) {
      // history already has tools; add prior user acks + fake assistant replies
      const msgs = [
        history[0],
        history[1],
        history[2],
        history[3],
      ];
      for (let k = 1; k < i; k++) {
        msgs.push({ role: "user", content: `turn ${k}: ack` });
        msgs.push({ role: "assistant", content: `ack${k}` });
      }
      msgs.push({ role: "user", content: `turn ${i}: ack` });
      const r = await postChat({
        sessionId,
        body: {
          model,
          messages: msgs,
          max_tokens: 8,
          temperature: 0,
        },
      });
      turns.push({
        turn: i,
        status: r.status,
        ms: r.ms,
        content: r.json?.choices?.[0]?.message?.content ?? null,
        usage: r.json?.usage ?? null,
        error: r.json?.error ?? null,
      });
      if (r.status !== 200) break;
      continue;
    }
    // turn 1
    const r = await postChat({
      sessionId,
      body: {
        model,
        messages: [
          history[0],
          history[1],
          history[2],
          history[3],
          { role: "user", content: "turn 1: ack" },
        ],
        max_tokens: 8,
        temperature: 0,
      },
    });
    turns.push({
      turn: i,
      status: r.status,
      ms: r.ms,
      content: r.json?.choices?.[0]?.message?.content ?? null,
      usage: r.json?.usage ?? null,
      error: r.json?.error ?? null,
    });
    if (r.status !== 200) break;
  }

  return {
    name: `multi-turn shadow prune (${label})`,
    sessionId,
    model,
    ok: turns.length === 5 && turns.every((t) => t.status === 200),
    turns,
  };
}

async function caseParallelToolIds() {
  // Single request with two parallel tool outputs present; ensure 200 under shadow
  const sessionId = `canary-parallel-${randomUUID()}`;
  const r = await postChat({
    sessionId,
    body: {
      model: "qwen36-27b",
      messages: [
        { role: "system", content: "Reply with POK" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "p1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "p2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "p1", content: "A" + pad(1000) },
        { role: "tool", tool_call_id: "p2", content: "B" + pad(1000) },
        { role: "user", content: "done" },
      ],
      max_tokens: 8,
      temperature: 0,
    },
  });
  return {
    name: "parallel tool_call ids (qwen)",
    sessionId,
    status: r.status,
    ms: r.ms,
    ok: r.status === 200,
    content_preview: String(r.json?.choices?.[0]?.message?.content ?? "").slice(0, 80),
    error: r.json?.error ?? null,
  };
}

async function main() {
  console.log(`CacheLane shadow+canary → ${BASE}`);
  const cases = [
    { name: "grok-4.5 short non-stream", run: () => caseGrokShort() },
    { name: "streaming SSE (qwen)", run: () => caseStream("qwen36-27b", "qwen free") },
    { name: "streaming SSE (grok-4.5)", run: () => caseStream("grok-4.5", "grok-4.5") },
    { name: "long context qwen", run: () => caseLongContext() },
    { name: "parallel tool_call ids", run: () => caseParallelToolIds() },
    { name: "multi-turn shadow prune (qwen)", run: () => caseMultiTurnShadowPrune("qwen36-27b", "qwen free") },
    // one paid multi-turn on grok to exercise the real canary model path
    { name: "multi-turn shadow prune (grok-4.5)", run: () => caseMultiTurnShadowPrune("grok-4.5", "grok-4.5") },
  ];

  for (const { name, run } of cases) {
    process.stdout.write(`… ${name} `);
    try {
      const result = await run();
      results.cases.push(result);
      console.log(result.ok ? `OK (${result.status ?? ""} ${result.ms ?? ""}ms)` : `FAIL ${JSON.stringify(result).slice(0, 200)}`);
    } catch (err) {
      const fail = { name, ok: false, error: String(err) };
      results.cases.push(fail);
      console.log("ERR", err);
    }
  }

  results.finished_at = new Date().toISOString();
  results.passed = results.cases.filter((c) => c.ok).length;
  results.failed = results.cases.filter((c) => !c.ok).length;
  writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`\n${results.passed}/${results.cases.length} passed → ${OUT}`);
  process.exit(results.failed ? 1 : 0);
}

main();
