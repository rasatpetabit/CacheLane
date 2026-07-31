import type { CacheTier, CachelaneConfig } from "../types/index.js";
import type {
  AnthropicMessagesRequest,
  MarkerTopologyEntry,
  MutatedRequest,
  OrchestratorInput,
} from "./types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { countTokens } from "../tokenizer/index.js";
import { CacheStateTracker } from "./cache-state-tracker.js";
import { findRegionBoundaries } from "./region-boundaries.js";
import { placeBreakpoints } from "./breakpoint-placer.js";
import { mutateRequest } from "./request-mutator.js";
import { planMarkers } from "./marker-planner.js";

export type {
  AnthropicCacheControl,
  AnthropicMessage,
  AnthropicMessageContent,
  AnthropicMessagesRequest,
  AnthropicSystemBlock,
  AnthropicTool,
  Breakpoints,
  Classification,
  MutatedRequest,
  OrchestratorInput,
  RegionBoundaries,
} from "./types.js";

export { CacheStateTracker } from "./cache-state-tracker.js";

const TTL_MS: Record<CacheTier, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

function markerTopology(request: AnthropicMessagesRequest): MarkerTopologyEntry[] {
  const topology: MarkerTopologyEntry[] = [];
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (tool.cache_control) topology.push({ location: "tool", index: String(index), ttl: tool.cache_control.ttl });
  }
  for (const [index, block] of (request.system ?? []).entries()) {
    if (block.cache_control) topology.push({ location: "system", index: String(index), ttl: block.cache_control.ttl });
  }
  for (const [messageIndex, message] of request.messages.entries()) {
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.cache_control) topology.push({
        location: "message",
        index: `${messageIndex}:${contentIndex}`,
        ttl: block.cache_control.ttl,
      });
    }
  }
  return topology;
}

function prefixTokenCount(input: OrchestratorInput): number {
  try {
    const prefixText = JSON.stringify({
      system: input.original_request.system ?? [],
      tools: input.original_request.tools ?? [],
    });
    return countTokens(prefixText, input.original_request.model);
  } catch (err) {
    console.warn("[cachelane] prefix token count unavailable", err);
    return 0;
  }
}

function ttlForPrefix(
  tokenCount: number,
  keepaliveConfig: CachelaneConfig["keepalive"],
): CacheTier {
  return tokenCount >= keepaliveConfig.large_prefix_threshold_tokens
    ? "1h"
    : "5m";
}

export function orchestrate(
  input: OrchestratorInput,
  tracker: CacheStateTracker,
  keepaliveConfig: CachelaneConfig["keepalive"] = DEFAULT_CONFIG.keepalive,
  markerStrategy: CachelaneConfig["features"]["marker_strategy"] = "prefix_only",
): MutatedRequest {
  try {
    const boundaries = findRegionBoundaries(input.message_classifications);
    const prevState = tracker.get(input.workspace_id, input.session_id);
    const keepalivePings = prevState?.keepalive_pings_since_last_turn ?? 0;

    const breakpoints = placeBreakpoints(
      input.original_request,
      boundaries,
      prevState,
    );
    const tokenCount = prefixTokenCount(input);
    const ttlClass = ttlForPrefix(tokenCount, keepaliveConfig);
    const markerPlan = markerStrategy === "candidate"
      ? planMarkers(input.original_request, ttlClass, prevState)
      : undefined;
    const mutated = markerStrategy === "passthrough"
      ? input.original_request
      : mutateRequest(
          input.original_request,
          boundaries,
          breakpoints,
          ttlClass,
          markerPlan,
        );

    const now = Date.now();
    const writeFrontier = markerPlan?.markers.find((marker) => marker.role === "write_frontier");
    const didMutate = markerStrategy === "candidate"
      ? markerPlan?.strategy !== "fail_preserve_client" && (markerPlan?.markers.length ?? 0) > 0
      : markerStrategy === "prefix_only" && (
          mutated.system?.some((block) => block.cache_control !== undefined) === true ||
          mutated.tools?.some((tool) => tool.cache_control !== undefined) === true
        );
    if (didMutate) {
      tracker.update(input.workspace_id, input.session_id, {
        workspace_id: input.workspace_id,
        prefix_hash: breakpoints.prefix_hash,
        middle_hash: writeFrontier?.cumulative_hash ?? null,
        middle_message_index: writeFrontier?.message_index,
        middle_content_index: writeFrontier?.content_index,
        prefix_token_count: tokenCount,
        ttl_class: ttlClass,
        cached_at_ms: now,
        last_read_at_ms: now,
        expected_expiry_ms: now + TTL_MS[ttlClass],
        keepalive_pings_since_last_turn: 0,
      });
    }

    const signals: MutatedRequest["signals"] = markerStrategy === "passthrough"
      ? ["markers:preserved_client"]
      : markerStrategy === "prefix_only"
        ? didMutate ? ["prefix_cached", "prefix_marker_emitted"] : []
        : markerPlan?.signals ?? [];

    console.error("[cachelane] orchestrate", {
      prefix_changed: prevState?.prefix_hash !== breakpoints.prefix_hash,
      ttl_class: ttlClass,
      signals,
      mutated: didMutate,
    });

    return {
      request: mutated,
      mutated: didMutate,
      prefix_hash: breakpoints.prefix_hash,
      middle_hash: writeFrontier?.cumulative_hash ?? null,
      signals,
      incoming_markers: markerTopology(input.original_request),
      emitted_markers: markerTopology(mutated),
      prefix_hashes_at_breakpoints: markerPlan?.markers.map((marker) => marker.cumulative_hash),
      keepalive_pings_since_last_turn: keepalivePings,
    };
  } catch (err) {
    // Fail-open: never let an orchestration error block the model call.
    console.error(
      "[cachelane] orchestrate: error — failing open",
      err instanceof Error ? err.message : String(err),
    );
    return {
      request: input.original_request,
      mutated: false,
      prefix_hash: "",
      middle_hash: null,
      signals: ["error:fallback"],
    };
  }
}
