import { describe, expect, it } from "vitest";
import { cumulativePrefixHash, planMarkers } from "../marker-planner.js";
import type { AnthropicMessagesRequest } from "../types.js";

function request(messages: AnthropicMessagesRequest["messages"]): AnthropicMessagesRequest {
  return {
    model: "claude-test",
    max_tokens: 1,
    system: [{ type: "text", text: "stable" }],
    tools: [{ name: "Read", input_schema: {} }],
    messages,
  };
}

const cc = { type: "ephemeral" as const, ttl: "5m" as const };

describe("planMarkers", () => {
  it("emits a static prefix plus a write frontier on completed history", () => {
    const p = planMarkers(request([
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
    ]), "5m");
    expect(p.strategy).toBe("cachelane_plan");
    expect(p.markers.map((m) => m.role)).toEqual(["static_prefix", "write_frontier"]);
    expect(p.markers[1]).toMatchObject({ location: "message", message_index: 1, content_index: 0 });
  });

  it("preserves a client anchor as read anchor and adds a deeper frontier", () => {
    const p = planMarkers(request([
      { role: "user", content: [{ type: "text", text: "u1", cache_control: cc }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
    ]), "5m");
    expect(p.markers.map((m) => m.role)).toEqual(["static_prefix", "read_anchor", "write_frontier"]);
  });

  it("uses the previous CacheLane frontier as the next read anchor", () => {
    const p = planMarkers(request([
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
      { role: "user", content: [{ type: "text", text: "u3" }] },
    ]), "5m", {
      workspace_id: "w",
      prefix_hash: "p",
      middle_hash: cumulativePrefixHash(request([
        { role: "user", content: [{ type: "text", text: "u1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "u2" }] },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: [{ type: "text", text: "u3" }] },
      ]), 1, 0),
      middle_message_index: 1,
      middle_content_index: 0,
      prefix_token_count: 10,
      ttl_class: "5m",
      cached_at_ms: 0,
      last_read_at_ms: 0,
      expected_expiry_ms: 1,
      keepalive_pings_since_last_turn: 0,
    });
    expect(p.markers.map((m) => m.role)).toEqual(["static_prefix", "read_anchor", "write_frontier"]);
    expect(p.markers[1]).toMatchObject({ message_index: 1, role: "read_anchor" });
    expect(p.markers[2]).toMatchObject({ message_index: 3, role: "write_frontier" });
  });

  it("fails preserve when a 1h message marker would follow a 5m static prefix", () => {
    const p = planMarkers(request([
      { role: "user", content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
    ]), "5m");
    expect(p.strategy).toBe("fail_preserve_client");
    expect(p.signals).toContain("markers:fail_preserve");
  });
});
