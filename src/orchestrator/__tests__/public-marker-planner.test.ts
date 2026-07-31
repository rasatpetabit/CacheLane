import { describe, expect, it } from "vitest";
import { planAndApplyMarkers } from "../public-marker-planner.js";
import type { AnthropicMessagesRequest } from "../types.js";

const request = (): AnthropicMessagesRequest => ({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1,
  system: [{ type: "text", text: "stable" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "question" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "text", text: "current" }] },
  ],
});

describe("planAndApplyMarkers", () => {
  it("applies the production candidate marker plan", () => {
    const result = planAndApplyMarkers(request(), "candidate");

    expect(result.plan.strategy).toBe("cachelane_plan");
    expect(result.request.system?.[0]?.cache_control?.ttl).toBe("5m");
    expect(result.request.messages[1]?.content[0]?.cache_control?.ttl).toBe("5m");
  });

  it("keeps prefix-only behavior explicit", () => {
    const result = planAndApplyMarkers(request(), "prefix_only");

    expect(result.plan.strategy).toBe("prefix_only");
    expect(result.request.system?.[0]?.cache_control?.ttl).toBe("5m");
    expect(result.request.messages.flatMap((message) => message.content).some((block) => block.cache_control)).toBe(false);
  });
});
