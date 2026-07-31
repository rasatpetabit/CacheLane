import { describe, expect, it } from "vitest";
import { candidatePrefixState, planAndApplyMarkers } from "../public-marker-planner.js";
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

  it("carries the previous frontier into a retained read anchor", () => {
    const first = planAndApplyMarkers(request(), "candidate");
    const nextRequest = request();
    nextRequest.messages.splice(2, 0,
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
      { role: "assistant", content: [{ type: "text", text: "follow-up answer" }] },
    );
    const second = planAndApplyMarkers(nextRequest, "candidate", "5m", candidatePrefixState(first));

    expect(second.plan.markers.map((marker) => marker.role)).toEqual([
      "static_prefix",
      "read_anchor",
      "write_frontier",
    ]);
  });

  it("keeps prefix-only behavior explicit", () => {
    const result = planAndApplyMarkers(request(), "prefix_only");

    expect(result.plan.strategy).toBe("prefix_only");
    expect(result.request.system?.[0]?.cache_control?.ttl).toBe("5m");
    expect(result.request.messages.flatMap((message) => message.content).some((block) => block.cache_control)).toBe(false);
  });
});
