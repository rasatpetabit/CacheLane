import { describe, expect, it } from "vitest";
import { findWriteFrontier } from "../frontier.js";
import type { AnthropicMessage } from "../types.js";

const text = (role: "user" | "assistant", value: string): AnthropicMessage => ({
  role,
  content: [{ type: "text", text: value }],
});

describe("findWriteFrontier", () => {
  it("uses the last completed assistant response before the current user input", () => {
    const messages = [text("user", "u1"), text("assistant", "a1"), text("user", "u2")];
    expect(findWriteFrontier(messages)).toEqual({ message_index: 1, content_index: 0 });
  });

  it("uses a trailing assistant message as completed history", () => {
    const messages = [text("user", "u1"), text("assistant", "a1")];
    expect(findWriteFrontier(messages)).toEqual({ message_index: 1, content_index: 0 });
  });

  it("keeps a completed parallel tool-use/result exchange together", () => {
    const messages: AnthropicMessage[] = [
      text("user", "u1"),
      { role: "assistant", content: [
        { type: "tool_use", id: "a", name: "Read", input: {} },
        { type: "tool_use", id: "b", name: "Read", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "b", content: "b" },
        { type: "tool_result", tool_use_id: "a", content: "a" },
      ] },
      text("assistant", "done"),
      text("user", "next"),
    ];
    expect(findWriteFrontier(messages)).toEqual({ message_index: 3, content_index: 0 });
  });

  it("falls back before an unmatched tool result", () => {
    const messages: AnthropicMessage[] = [
      text("user", "u1"),
      text("assistant", "a1"),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }] },
    ];
    expect(findWriteFrontier(messages)).toEqual({ message_index: 1, content_index: 0 });
  });
});
