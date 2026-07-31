import type {
  AnthropicCacheControl,
  AnthropicMessageContent,
  AnthropicMessagesRequest,
  AnthropicToolResultContent,
  AnthropicToolUseContent,
  Breakpoints,
  PrefixState,
  RegionBoundaries,
} from "./types.js";
import { markerControl, type MarkerPlan } from "./marker-planner.js";

function isToolUse(c: AnthropicMessageContent): c is AnthropicToolUseContent {
  return c.type === "tool_use";
}

function isToolResult(c: AnthropicMessageContent): c is AnthropicToolResultContent {
  return c.type === "tool_result";
}

export function mutateRequest(
  originalRequest: AnthropicMessagesRequest,
  boundaries: RegionBoundaries,
  breakpoints: Breakpoints,
  prefixTtl: PrefixState["ttl_class"] = "5m",
  markerPlan?: MarkerPlan,
): AnthropicMessagesRequest {
  const prefixMarker: AnthropicCacheControl = {
    type: "ephemeral",
    ttl: prefixTtl,
  };
  // Legacy callers/tests that do not supply a plan retain the old breakpoint
  // contract. The orchestrator supplies an explicit plan for production paths.
  const plan = markerPlan;
  if (plan?.strategy === "fail_preserve_client") {
    return structuredClone(originalRequest);
  }
  // Strip ALL existing cache_control markers before placing CacheLane's own.
  // Claude Code pre-populates its own 5m markers; leaving them in creates
  // ordering violations when CacheLane places a 1h prefix marker after them
  // (Anthropic rejects: 1h must not follow 5m in tools→system→messages order).
  const stripCc = <T extends { cache_control?: unknown }>(block: T): Omit<T, "cache_control"> => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { cache_control: _cc, ...rest } = block;
    return rest as Omit<T, "cache_control">;
  };

  const out: AnthropicMessagesRequest = {
    ...originalRequest,
    system: originalRequest.system?.map((s) => ({ ...stripCc(s) })),
    tools: originalRequest.tools?.map((t) => ({ ...stripCc(t) })),
    messages: originalRequest.messages.map((m) => {
      // Anthropic API allows content as a plain string; skip deep-copy in that case
      if (typeof m.content === "string") return { ...m };
      return {
        ...m,
        content: (m.content as AnthropicMessageContent[]).map((c) => ({ ...stripCc(c) })) as AnthropicMessageContent[],
      };
    }),
  };

  // FIX: Claude Code has a bug where parallel tool results are sometimes sent out of order.
  // Anthropic API rejects this with 400 "tool use concurrency issues".
  // We transparently sort the tool_result blocks to match the preceding tool_use order!
  for (let i = 1; i < out.messages.length; i++) {
    const msg = out.messages[i];
    const prevMsg = out.messages[i - 1];
    
    if (msg?.role === "user" && Array.isArray(msg.content) && prevMsg?.role === "assistant" && Array.isArray(prevMsg.content)) {
      const toolUseOrder = prevMsg.content
        .filter(isToolUse)
        .map((c) => c.id);

      if (toolUseOrder.length > 0) {
        const orderMap = new Map(toolUseOrder.map((id, idx) => [id, idx]));
        // Unmatched tool_results sort to the end (stable sort preserves their
        // relative order); this index is larger than any real tool_use index.
        const unmatchedRank = toolUseOrder.length;

        // Extract all tool_result blocks
        const toolResults = msg.content.filter(isToolResult);
        // Sort ONLY the tool_results based on the tool_use_id order
        toolResults.sort((a, b) => {
          const idxA = orderMap.get(a.tool_use_id) ?? unmatchedRank;
          const idxB = orderMap.get(b.tool_use_id) ?? unmatchedRank;
          return idxA - idxB;
        });

        // Rebuild the array by popping from our sorted toolResults queue
        msg.content = msg.content.map((c) =>
          isToolResult(c) ? toolResults.shift()! : c,
        );
      }
    }
  }

  if (plan) {
    for (const marker of plan.markers) {
      const control = markerControl(marker.ttl);
      if (marker.location === "system" && marker.system_index !== undefined) {
        const block = out.system?.[marker.system_index];
        if (block) block.cache_control = control;
      } else if (marker.location === "tool" && marker.tool_index !== undefined) {
        const tool = out.tools?.[marker.tool_index];
        if (tool) tool.cache_control = control;
      } else if (
        marker.location === "message" &&
        marker.message_index !== undefined &&
        marker.content_index !== undefined
      ) {
        const content = out.messages[marker.message_index]?.content[marker.content_index];
        if (content) content.cache_control = control;
      }
    }
  } else {
    if (out.system && out.system.length > 0) {
      const lastSystem = out.system.at(-1);
      if (lastSystem) lastSystem.cache_control = prefixMarker;
    } else if (out.tools && out.tools.length > 0) {
      const lastTool = out.tools.at(-1);
      if (lastTool) lastTool.cache_control = prefixMarker;
    }
    if (
      breakpoints.include_middle_breakpoint &&
      boundaries.middle_end_in_messages !== null &&
      boundaries.middle_end_in_messages > 0
    ) {
      const content = out.messages[boundaries.middle_end_in_messages - 1]?.content.at(-1);
      if (content) content.cache_control = markerControl("5m");
    }
  }

  return out;
}
