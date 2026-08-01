/**
 * Layer 1 — the pure elision transform.
 *
 * These tests are the executable form of the invariants the old K-pruner
 * violated. The old design derived eligibility from database state written by
 * previous turns, so it had no fixed point, un-elided blocks behind its own
 * back, and gave concurrent requests different answers. Each `describe` below
 * pins one of the properties that failure taught us to require.
 */

import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELISION_POLICY,
  MAX_STUB_BYTES,
  effectiveK,
  elisionBand,
  formatElisionStub,
  transformAnthropic,
  transformOpenAI,
  type AnthropicTransformable,
  type ElisionPolicy,
  type OpenAITransformable,
} from "../transform.js";

const BIG = "x".repeat(8000);

/** An Anthropic conversation of `turns` user/assistant pairs, each carrying a tool result. */
function anthropicConversation(turns: number, payload = BIG): AnthropicTransformable {
  const messages: AnthropicTransformable["messages"] = [];
  for (let t = 0; t < turns; t++) {
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${t}`, content: payload },
        { type: "text", text: `user turn ${t}` },
      ],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `assistant turn ${t}` }],
    });
  }
  return { model: "claude-3", messages };
}

function openaiConversation(turns: number, payload = BIG): OpenAITransformable {
  const messages: OpenAITransformable["messages"] = [];
  for (let t = 0; t < turns; t++) {
    messages.push({ role: "user", content: `user turn ${t}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${t}`,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: `f${t}` }) },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `call_${t}`, content: payload });
  }
  return { model: "gpt-4", messages };
}

function elidedIds(request: AnthropicTransformable): Set<string> {
  return new Set(transformAnthropic(request).decisions.map((d) => d.block_id));
}

describe("banding", () => {
  it("is non-decreasing in conversation length", () => {
    let previous = -1;
    for (let n = 0; n <= 400; n++) {
      const band = elisionBand(n);
      expect(band).toBeGreaterThanOrEqual(previous);
      previous = band;
    }
  });

  it("changes about once per doubling, not once per turn", () => {
    // Eliding is cache invalidation. A cutoff that moved every turn would
    // invalidate the prompt prefix every turn and cost more than it saves.
    const bands = new Set<number>();
    for (let n = 1; n <= 512; n++) bands.add(elisionBand(n));
    expect(bands.size).toBe(10); // log2(512) + 1
  });

  it("derives the cutoff as NON-INCREASING in the band", () => {
    // The direction is load-bearing and is the easy thing to get backwards.
    // Eligibility is `userMessagesAfter >= K_eff`, so a larger cutoff elides
    // FEWER blocks; a cutoff that rose with conversation length would un-elide
    // content as the conversation grew.
    let previous = Infinity;
    for (let band = 0; band <= 20; band++) {
      const k = effectiveK(band, DEFAULT_ELISION_POLICY);
      expect(k).toBeLessThanOrEqual(previous);
      previous = k;
    }
  });

  it("never lets the cutoff fall below its floor", () => {
    const policy: ElisionPolicy = { k: 8, min_bytes: 2048, k_min: 3 };
    expect(effectiveK(99, policy)).toBe(3);
  });
});

describe("I1 — input/output separation and idempotence", () => {
  it("never mutates the request it was given", () => {
    const request = anthropicConversation(30);
    const before = JSON.stringify(request);
    const { decisions } = transformAnthropic(request);

    expect(decisions.length).toBeGreaterThan(0);
    expect(JSON.stringify(request)).toBe(before);
  });

  it("reaches its fixed point in one step", () => {
    // The old transform's output was its own input, so it had no fixed point
    // anyone had chosen. Re-running this one must be a no-op.
    const request = anthropicConversation(30);
    const once = transformAnthropic(request);
    const twice = transformAnthropic(once.body);

    expect(once.decisions.length).toBeGreaterThan(0);
    expect(twice.decisions).toEqual([]);
    expect(JSON.stringify(twice.body)).toBe(JSON.stringify(once.body));
  });

  it("keeps every stub below the minimum elidable size — which is what makes it idempotent", () => {
    // If a stub could exceed min_bytes it would be eligible for elision itself,
    // and the transform would chase its own tail.
    const longest = formatElisionStub("t".repeat(200), Number.MAX_SAFE_INTEGER);
    expect(Buffer.byteLength(longest, "utf8")).toBeLessThanOrEqual(MAX_STUB_BYTES);
    expect(MAX_STUB_BYTES).toBeLessThan(DEFAULT_ELISION_POLICY.min_bytes);
  });

  it("bounds the stub in BYTES, not characters, for non-ASCII block ids", () => {
    // slice(0, n) counts UTF-16 code units: 64 CJK characters are 192 bytes and
    // an astral-plane id is 4 bytes per code point. A character-based bound
    // would let the stub outgrow MAX_STUB_BYTES and re-elide itself.
    for (const id of ["漢".repeat(200), "🙂".repeat(200), "é".repeat(200), "a".repeat(400)]) {
      const stub = formatElisionStub(id, Number.MAX_SAFE_INTEGER);
      expect(
        Buffer.byteLength(stub, "utf8"),
        `stub for ${id.slice(0, 4)}… exceeded the byte bound`,
      ).toBeLessThanOrEqual(MAX_STUB_BYTES);
      // Truncation must not leave a mangled half-character behind.
      expect(stub).not.toContain("�");
    }
  });

  it("actually elides a block whose id is non-ASCII, and stays idempotent doing it", () => {
    const request: AnthropicTransformable = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "漢".repeat(300), content: BIG }] },
        ...anthropicConversation(40).messages,
      ],
    };
    const once = transformAnthropic(request);
    expect(once.decisions.some((d) => d.message_index === 0)).toBe(true);
    expect(transformAnthropic(once.body).decisions).toEqual([]);
  });

  it("keeps its fixed point even under a policy that would destroy it", () => {
    // `{k: 0, min_bytes: 1}` is type-valid and would make every stub eligible
    // for elision again, so the transform would rewrite its own output forever.
    // The floor has to be enforced, not merely documented.
    const hostile: ElisionPolicy = { k: 0, min_bytes: 1, k_min: 0 };
    const once = transformAnthropic(anthropicConversation(30), hostile);
    const twice = transformAnthropic(once.body, hostile);

    expect(once.decisions.length).toBeGreaterThan(0);
    expect(twice.decisions).toEqual([]);
    expect(JSON.stringify(twice.body)).toBe(JSON.stringify(once.body));
  });

  it("returns the original object untouched when nothing is eligible", () => {
    const request = anthropicConversation(2);
    const { body, decisions } = transformAnthropic(request);
    expect(decisions).toEqual([]);
    expect(body).toBe(request);
  });
});

describe("I2 — monotonicity under append", () => {
  it("only ever grows the elided set as the conversation grows", () => {
    // If block X is elided for prefix P it must be elided for every P + suffix.
    // Nothing may reappear: the client never learns what was elided, so a block
    // that un-elides silently re-inflates the context and re-invalidates cache.
    let previous = new Set<string>();
    for (let turns = 1; turns <= 64; turns++) {
      const current = elidedIds(anthropicConversation(turns));
      for (const id of previous) {
        expect(current.has(id), `block ${id} un-elided at ${turns} turns`).toBe(true);
      }
      previous = current;
    }
    expect(previous.size).toBeGreaterThan(40);
  });

  it("survives the band boundary that a non-increasing cutoff exists to protect", () => {
    // Crossing a doubling lowers K_eff. With the sign reversed this is exactly
    // where blocks would pop back into the request.
    const before = elidedIds(anthropicConversation(31));
    const after = elidedIds(anthropicConversation(32));
    expect(elisionBand(32)).toBeGreaterThan(elisionBand(31));
    for (const id of before) expect(after.has(id)).toBe(true);
  });
});

describe("I3 — determinism", () => {
  it("gives byte-identical output for equal input, with no shared state between calls", () => {
    const a = transformAnthropic(anthropicConversation(40));
    const b = transformAnthropic(anthropicConversation(40));
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(a.decisions).toEqual(b.decisions);
  });

  it("depends on nothing but the messages array and the policy", () => {
    // Same conversation, different surrounding request fields and different
    // object identities — the old path would have answered differently here
    // because it consulted a per-HTTP-request turn counter.
    const one = transformAnthropic({ ...anthropicConversation(40), metadata: { a: 1 } });
    const two = transformAnthropic({ ...anthropicConversation(40), metadata: { a: 2 } });
    expect(one.decisions).toEqual(two.decisions);
  });
});

describe("eligibility", () => {
  it("leaves recent tool results alone", () => {
    const { decisions } = transformAnthropic(anthropicConversation(40));
    const kEff = effectiveK(elisionBand(40), DEFAULT_ELISION_POLICY);
    // The final k_eff user messages' worth of blocks must survive.
    const maxIndex = Math.max(...decisions.map((d) => d.message_index));
    expect(maxIndex).toBeLessThan(80 - kEff * 2);
  });

  it("leaves small payloads alone — a stub would not save anything", () => {
    const { decisions } = transformAnthropic(anthropicConversation(40, "tiny"));
    expect(decisions).toEqual([]);
  });

  it("honours pinned blocks", () => {
    const pinned = new Set(["toolu_0", "toolu_1"]);
    const { decisions } = transformAnthropic(anthropicConversation(40), {
      ...DEFAULT_ELISION_POLICY,
      pinned_block_ids: pinned,
    });
    for (const d of decisions) expect(pinned.has(d.block_id)).toBe(false);
  });

  it("ignores string-content messages instead of throwing on them", () => {
    // Claude Code sends plain-string content for simple user turns.
    const request: AnthropicTransformable = {
      messages: [
        { role: "user", content: "just a string" },
        ...anthropicConversation(40).messages,
      ],
    };
    expect(() => transformAnthropic(request)).not.toThrow();
    expect(transformAnthropic(request).decisions.length).toBeGreaterThan(0);
  });

  it("skips tool_result blocks with no tool_use_id rather than eliding them anonymously", () => {
    const request: AnthropicTransformable = {
      messages: [
        { role: "user", content: [{ type: "tool_result", content: BIG }] },
        ...anthropicConversation(40).messages,
      ],
    };
    const { decisions } = transformAnthropic(request);
    expect(decisions.some((d) => d.message_index === 0)).toBe(false);
  });

  it("does not measure content it cannot serialize", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const request: AnthropicTransformable = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: circular }] },
        ...anthropicConversation(40).messages,
      ],
    };
    expect(() => transformAnthropic(request)).not.toThrow();
    expect(transformAnthropic(request).decisions.some((d) => d.block_id === "t")).toBe(false);
  });
});

describe("OpenAI chat-completions shape", () => {
  it("replaces only the content, keeping the tool message that pairs with tool_calls", () => {
    const request = openaiConversation(40);
    const { body, decisions } = transformOpenAI(request);
    expect(decisions.length).toBeGreaterThan(0);
    // Dropping a tool message would break the API's pairing invariant.
    expect(body.messages.length).toBe(request.messages.length);
    for (const d of decisions) {
      const message = body.messages[d.message_index]!;
      expect(message.role).toBe("tool");
      expect(message.tool_call_id).toBe(d.block_id);
      expect(String(message.content)).toContain("cachelane:elided");
    }
  });

  it("holds the same invariants as the Anthropic path", () => {
    const request = openaiConversation(40);
    const before = JSON.stringify(request);
    const once = transformOpenAI(request);
    const twice = transformOpenAI(once.body);

    expect(JSON.stringify(request)).toBe(before);
    expect(twice.decisions).toEqual([]);
    expect(JSON.stringify(twice.body)).toBe(JSON.stringify(once.body));
  });

  it("is monotone under append — the two shapes must not diverge on I2", () => {
    let previous = new Set<string>();
    for (let turns = 1; turns <= 48; turns++) {
      const current = new Set(
        transformOpenAI(openaiConversation(turns)).decisions.map((d) => d.block_id),
      );
      for (const id of previous) {
        expect(current.has(id), `block ${id} un-elided at ${turns} turns`).toBe(true);
      }
      previous = current;
    }
    expect(previous.size).toBeGreaterThan(30);
  });

  it("is deterministic across independent calls", () => {
    const a = transformOpenAI(openaiConversation(40));
    const b = transformOpenAI(openaiConversation(40));
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(a.decisions).toEqual(b.decisions);
  });
});

/**
 * Gate 3. The old suite had no test anywhere that iterated more than one turn,
 * which is precisely why a bug that only manifests across turns survived.
 *
 * The protocol matters: a transparent proxy's client never sees the forwarded
 * body, so each turn must feed the ORIGINAL growing history forward, not the
 * previous turn's output. Feeding the output back is what the old design
 * effectively did, and it is what this test would fail to detect.
 */
describe("Gate 3 — multi-turn closed loop", () => {
  it("stays monotone across 16 turns of growing client history", () => {
    const elidedByTurn: Set<string>[] = [];

    for (let turns = 1; turns <= 16; turns++) {
      // The client re-sends everything, unpruned, exactly as Claude Code does.
      const clientHistory = anthropicConversation(turns);
      const result = transformAnthropic(clientHistory);
      elidedByTurn.push(new Set(result.decisions.map((d) => d.block_id)));
    }

    // Nothing reappears.
    for (let t = 1; t < elidedByTurn.length; t++) {
      for (const id of elidedByTurn[t - 1]!) {
        expect(elidedByTurn[t]!.has(id), `block ${id} reappeared at turn ${t + 1}`).toBe(true);
      }
    }

    // Elision actually happens — a build where it silently stops after the
    // first turn per block (the old sticky-is_stub failure) fails here.
    expect(elidedByTurn.at(-1)!.size).toBeGreaterThan(elidedByTurn[0]!.size);
    expect(elidedByTurn.at(-1)!.size).toBeGreaterThanOrEqual(10);
  });

  it("does not re-elide an already-stubbed block when history is replayed through it", () => {
    // Belt and braces on I1 across turns: even if a stubbed body were somehow
    // fed forward, it must not produce a second generation of stubs.
    let body = anthropicConversation(20);
    for (let i = 0; i < 5; i++) {
      const result = transformAnthropic(body);
      if (i > 0) expect(result.decisions).toEqual([]);
      body = result.body;
    }
  });
});

/**
 * Gate 2's bounded-cost requirement is a fitted slope of at most 0.20 ms per
 * elided block, measured over 500+ production turns — that measurement belongs
 * on the live lane, not in a unit suite, where wall-clock assertions are
 * decided as much by host load as by the code.
 *
 * What a unit test *can* pin deterministically is the mechanism that made the
 * old path cost 45 ms per block: it called `countTokens`, which rebuilt a
 * 697 KB BPE table every time. This module must never acquire that dependency.
 * The timing check below is a coarse smoke bound with three orders of magnitude
 * of headroom, present only to catch an accidental quadratic — not to enforce
 * the gate.
 */
describe("Gate 2 — bounded cost", () => {
  it("has no imports at all, so it cannot reach the tokenizer by any path", async () => {
    // Checking for the string "tokenizer" would miss a transitive import and
    // trip over a comment. Zero imports is the airtight form of the same claim:
    // a module that imports nothing cannot depend on anything, directly or
    // otherwise. Keeping it that way is the point — the 45 ms/block cost came
    // in through exactly such a dependency.
    const source = await fs.readFile(new URL("../transform.ts", import.meta.url), "utf8");
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");

    expect(stripped).not.toMatch(/^\s*import\s/m);
    expect(stripped).not.toMatch(/\brequire\s*\(/);
    expect(stripped).not.toMatch(/\bimport\s*\(/);
  });

  it("stays far below the old per-block cost at the pathological depth", () => {
    // The old path took ~45 ms per elided block: 200 blocks was ~9 seconds.
    // Anything under a second here means the per-block work is not in that
    // regime at all, which is the only thing a timing test can honestly claim.
    const request = anthropicConversation(200);
    const count = transformAnthropic(request).decisions.length;
    expect(count).toBeGreaterThan(120);

    transformAnthropic(request); // warm
    const start = performance.now();
    transformAnthropic(request);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
