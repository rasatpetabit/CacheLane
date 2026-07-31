import { describe, expect, it } from "vitest";
import { orchestrate, CacheStateTracker } from "../index.js";
import type { AnthropicMessage, AnthropicMessagesRequest, OrchestratorInput } from "../types.js";

const classification = {
  kind: "prior_turn" as const,
  volatility: "SEMI" as const,
  isPinned: false,
  signals: ["prior_turn"] as const,
};

function request(messages: AnthropicMessage[]): AnthropicMessagesRequest {
  return {
    model: "claude-test",
    max_tokens: 1,
    system: [{ type: "text", text: "stable" }],
    messages,
  };
}

function text(role: "user" | "assistant", value: string): AnthropicMessage {
  return { role, content: [{ type: "text", text: value }] };
}

describe("growing multi-turn cache frontier", () => {
  it("retains the prior write anchor and advances a deeper frontier", () => {
    const tracker = new CacheStateTracker();
    const firstMessages = [text("user", "u1"), text("assistant", "a1"), text("user", "u2")];
    const first = orchestrate({
      workspace_id: "w",
      session_id: "s",
      current_turn: 1,
      message_classifications: firstMessages.map(() => classification),
      original_request: request(firstMessages),
    } satisfies OrchestratorInput, tracker);

    const secondMessages = [
      ...firstMessages.slice(0, 2),
      text("user", "u2"),
      text("assistant", "a2"),
      text("user", "u3"),
    ];
    const second = orchestrate({
      workspace_id: "w",
      session_id: "s",
      current_turn: 2,
      message_classifications: secondMessages.map(() => classification),
      original_request: request(secondMessages),
    } satisfies OrchestratorInput, tracker);

    expect(first.request.messages[1]?.content[0]?.cache_control).toBeDefined();
    expect(second.request.messages[1]?.content[0]?.cache_control).toBeDefined();
    expect(second.request.messages[3]?.content[0]?.cache_control).toBeDefined();
    expect(second.signals).toContain("markers:preserved_client");
    expect(second.middle_hash).not.toBe(first.middle_hash);
  });
});
