import { describe, expect, it } from "vitest";
import { CacheStateTracker, orchestrate } from "../index.js";
import type { Volatility } from "../../types/index.js";
import type { Classification } from "../../classifier/index.js";
import type { AnthropicMessagesRequest, OrchestratorInput } from "../types.js";

// The Anthropic API accepts `system` and `message.content` as a plain string as
// well as a block array. The declared types only model the array form, so these
// fixtures cast — the wire format is what reaches the proxy in production.
// Regression: markerTopology() called .entries() on both, which throws on a
// string and made every such turn fail open with no cache orchestration at all.

function cl(volatility: Volatility): Classification {
  return { kind: "user_message", volatility, isPinned: false, signals: ["user_message"] };
}

function requestWith(overrides: Partial<AnthropicMessagesRequest>): AnthropicMessagesRequest {
  return {
    model: "claude-opus-4-7",
    system: [{ type: "text", text: "You are Claude." }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "new" }] },
    ],
    max_tokens: 1024,
    ...overrides,
  };
}

function run(request: AnthropicMessagesRequest) {
  const input: OrchestratorInput = {
    workspace_id: "ws-1",
    session_id: "s-1",
    current_turn: 5,
    message_classifications: [cl("SEMI"), cl("SEMI"), cl("VOLATILE")],
    original_request: request,
  };
  return orchestrate(input, new CacheStateTracker(), undefined, "candidate");
}

describe("orchestrate tolerates string-form system and message content", () => {
  it("does not fail open when a message.content is a string", () => {
    const request = requestWith({
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "new" }] },
      ] as unknown as AnthropicMessagesRequest["messages"],
    });
    const out = run(request);
    expect(out.signals).not.toContain("error:fallback");
    expect(out.mutated).toBe(true);
  });

  it("does not fail open when every message.content is a string", () => {
    const request = requestWith({
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new" },
      ] as unknown as AnthropicMessagesRequest["messages"],
    });
    expect(run(request).signals).not.toContain("error:fallback");
  });

  it("does not fail open when system is a string", () => {
    const request = requestWith({
      system: "You are Claude." as unknown as AnthropicMessagesRequest["system"],
    });
    const out = run(request);
    expect(out.signals).not.toContain("error:fallback");
    expect(out.mutated).toBe(true);
  });

  it("does not fail open when both system and content are strings", () => {
    const request = requestWith({
      system: "You are Claude." as unknown as AnthropicMessagesRequest["system"],
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new" },
      ] as unknown as AnthropicMessagesRequest["messages"],
    });
    expect(run(request).signals).not.toContain("error:fallback");
  });
});
