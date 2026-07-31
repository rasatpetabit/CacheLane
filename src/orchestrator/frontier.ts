import type { AnthropicMessage, AnthropicMessageContent } from "./types.js";

export interface MessageFrontier {
  message_index: number;
  content_index: number;
}

function toolUseIds(content: AnthropicMessageContent[]): Set<string> {
  return new Set(content.filter((c) => c.type === "tool_use").map((c) => c.id));
}

function toolResultIds(content: AnthropicMessageContent[]): Set<string> {
  return new Set(content.filter((c) => c.type === "tool_result").map((c) => c.tool_use_id));
}

function hasUnmatchedToolResult(messages: AnthropicMessage[], index: number): boolean {
  const message = messages[index];
  if (!message || message.role !== "user") return false;
  const results = toolResultIds(message.content);
  if (results.size === 0) return false;
  const previous = messages[index - 1];
  if (!previous || previous.role !== "assistant") return true;
  const uses = toolUseIds(previous.content);
  for (const id of results) if (!uses.has(id)) return true;
  return false;
}

/**
 * Return the deepest safe message content block that belongs to completed
 * history. The final user message is the current request input and is not used
 * as a write frontier. Ambiguous/unmatched tool results conservatively move the
 * frontier before that message.
 */
export function findWriteFrontier(messages: AnthropicMessage[]): MessageFrontier | null {
  if (messages.length < 2) return null;
  let candidate = messages.length - 2;

  for (let i = 0; i <= candidate; i++) {
    if (hasUnmatchedToolResult(messages, i)) {
      candidate = i - 1;
      break;
    }
  }

  while (candidate >= 0) {
    const content = messages[candidate]?.content;
    if (Array.isArray(content) && content.length > 0) {
      return { message_index: candidate, content_index: content.length - 1 };
    }
    candidate--;
  }
  return null;
}
