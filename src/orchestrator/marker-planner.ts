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

function stripApiMarkers<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripApiMarkers(item)) as T;
  const { cache_control: _marker, ...rest } = value as Record<string, unknown>;
  void _marker;
  return rest as T;
}

function hashPayload(
  request: AnthropicMessagesRequest,
  messageEnd: number | null,
  contentEnd?: number,
): unknown {
  return {
    model: request.model,
    // Only API-level blocks own cache_control. Tool schemas are opaque and may
    // legitimately contain a property with that name.
    tools: (request.tools ?? []).map(stripApiMarkers),
    system: (request.system ?? []).map(stripApiMarkers),
    messages: messageEnd === null ? [] : request.messages.slice(0, messageEnd + 1).map((message, index) => ({
      ...message,
      content: message.content
        .slice(0, index === messageEnd && contentEnd !== undefined ? contentEnd + 1 : undefined)
        .map(stripApiMarkers),
    })),
  };
}

export function cumulativePrefixHash(
  request: AnthropicMessagesRequest,
  messageEnd: number | null,
  contentEnd?: number,
): string {
  return createHash("sha256").update(canonical(hashPayload(request, messageEnd, contentEnd))).digest("hex");
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
  const cumulative_hash = cumulativePrefixHash(request, null);
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
  if (staticPrefix && prefixTtl === "5m" && incoming.some((m) => m.ttl === "1h")) {
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
  const anchorMessage = deepest ? request.messages[deepest.message_index] : undefined;
  const anchorContentValid = anchorMessage && deepest && deepest.content_index >= 0 &&
    deepest.content_index < anchorMessage.content.length;
  const anchorHash = deepest && anchorContentValid
    ? cumulativePrefixHash(request, deepest.message_index, deepest.content_index)
    : null;
  // Client-marker provenance has no persisted CacheLane hash to validate.
  // Persisted CacheLane frontiers do: never reuse them after history edits.
  const usingPreviousAnchor = incoming.length === 0 && previous?.middle_hash !== undefined;
  const previousAnchorValid = !usingPreviousAnchor || previous?.middle_hash === anchorHash;
  if (deepest && frontier && anchorContentValid && previousAnchorValid &&
      (deepest.message_index < frontier.message_index ||
       (deepest.message_index === frontier.message_index && deepest.content_index < frontier.content_index))) {
    markers.push({
      location: "message",
      message_index: deepest.message_index,
      content_index: deepest.content_index,
      ttl: deepest.ttl,
      role: "read_anchor",
      cumulative_hash: anchorHash!,
    });
  }

  if (frontier) {
    markers.push({
      location: "message",
      ...frontier,
      ttl: "5m",
      role: "write_frontier",
      cumulative_hash: cumulativePrefixHash(request, frontier.message_index, frontier.content_index),
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
