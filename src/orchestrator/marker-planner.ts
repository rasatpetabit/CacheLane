import { createHash } from "node:crypto";
import type { CacheTier, PrefixState } from "../types/index.js";
import { findWriteFrontier } from "./frontier.js";
import type {
  AnthropicCacheControl,
  AnthropicMessageContent,
  AnthropicMessagesRequest,
} from "./types.js";

export type MarkerRole = "static_prefix" | "read_anchor" | "write_frontier";
export type MarkerLocation = "tool" | "system" | "message";

export interface PlannedMarker {
  location: MarkerLocation;
  role: MarkerRole;
  ttl: CacheTier;
  tool_index?: number;
  system_index?: number;
  message_index?: number;
  content_index?: number;
  cumulative_hash: string;
}

export interface MarkerPlan {
  strategy: "cachelane_plan" | "fail_preserve_client" | "prefix_only";
  markers: PlannedMarker[];
  signals: string[];
}

interface ClientMarker {
  message_index: number;
  content_index: number;
  ttl: CacheTier;
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k], seen)}`).join(",")}}`;
}

function withoutMarkers<T>(value: T, seen = new Map<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(withoutMarkers(item, seen));
    return out as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k !== "cache_control") out[k] = withoutMarkers(v, seen);
  }
  return out as T;
}

function hashThrough(request: AnthropicMessagesRequest, messageEnd: number | null): string {
  const prefix = {
    model: request.model,
    tools: withoutMarkers(request.tools ?? []),
    system: withoutMarkers(request.system ?? []),
    messages: messageEnd === null ? [] : withoutMarkers(request.messages.slice(0, messageEnd + 1)),
  };
  return createHash("sha256").update(canonical(prefix)).digest("hex");
}

function clientMarkers(request: AnthropicMessagesRequest): ClientMarker[] {
  const out: ClientMarker[] = [];
  request.messages.forEach((message, mi) => {
    message.content.forEach((content: AnthropicMessageContent, ci) => {
      if (content.cache_control) out.push({ message_index: mi, content_index: ci, ttl: content.cache_control.ttl });
    });
  });
  return out;
}

function staticMarker(request: AnthropicMessagesRequest, ttl: CacheTier): PlannedMarker | null {
  const cumulative_hash = hashThrough(request, null);
  if ((request.system?.length ?? 0) > 0) {
    return { location: "system", system_index: request.system!.length - 1, ttl, role: "static_prefix", cumulative_hash };
  }
  if ((request.tools?.length ?? 0) > 0) {
    return { location: "tool", tool_index: request.tools!.length - 1, ttl, role: "static_prefix", cumulative_hash };
  }
  return null;
}

/** Plan globally ordered Anthropic markers without mutating the request. */
export function planMarkers(
  request: AnthropicMessagesRequest,
  prefixTtl: CacheTier,
  previous?: PrefixState,
): MarkerPlan {
  const staticPrefix = staticMarker(request, prefixTtl);
  const incoming = clientMarkers(request);
  if (prefixTtl === "5m" && incoming.some((m) => m.ttl === "1h")) {
    return { strategy: "fail_preserve_client", markers: [], signals: ["markers:fail_preserve"] };
  }

  const frontier = findWriteFrontier(request.messages);
  const markers: PlannedMarker[] = staticPrefix ? [staticPrefix] : [];

  // Preserve the deepest client marker or previous CacheLane write frontier as
  // a read anchor. Anthropic's real-provider probe confirms this retained
  // anchor lets a deeper frontier reuse the prior cumulative prefix.
  const deepest = incoming.at(-1) ?? (
    previous?.middle_message_index !== undefined && previous.middle_content_index !== undefined
      ? {
          message_index: previous.middle_message_index,
          content_index: previous.middle_content_index,
          ttl: "5m" as const,
        }
      : undefined
  );
  if (deepest && frontier && deepest.message_index < request.messages.length &&
      (deepest.message_index < frontier.message_index ||
       (deepest.message_index === frontier.message_index && deepest.content_index < frontier.content_index))) {
    markers.push({
      location: "message",
      message_index: deepest.message_index,
      content_index: deepest.content_index,
      ttl: deepest.ttl,
      role: "read_anchor",
      cumulative_hash: hashThrough(request, deepest.message_index),
    });
  }

  if (frontier) {
    markers.push({
      location: "message",
      ...frontier,
      ttl: "5m",
      role: "write_frontier",
      cumulative_hash: hashThrough(request, frontier.message_index),
    });
  }

  return {
    strategy: frontier ? "cachelane_plan" : "prefix_only",
    markers,
    signals: [
      ...(staticPrefix ? ["prefix_cached", "prefix_marker_emitted"] : []),
      ...(markers.some((m) => m.role === "read_anchor") ? ["markers:preserved_client"] : []),
      ...(frontier ? ["middle_marker_emitted"] : []),
    ],
  };
}

export const markerControl = (ttl: CacheTier): AnthropicCacheControl => ({ type: "ephemeral", ttl });
