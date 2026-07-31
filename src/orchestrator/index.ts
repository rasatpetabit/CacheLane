import type { CacheTier, CachelaneConfig } from "../types/index.js";
import type { MutatedRequest, OrchestratorInput } from "./types.js";
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
    const markerPlan = planMarkers(input.original_request, ttlClass, prevState);
    const mutated = mutateRequest(
      input.original_request,
      boundaries,
      breakpoints,
      ttlClass,
      markerPlan,
    );

    const now = Date.now();
    const writeFrontier = markerPlan.markers.find((marker) => marker.role === "write_frontier");
    if (markerPlan.strategy !== "fail_preserve_client" && markerPlan.markers.length > 0) {
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

    const didMutate = markerPlan.strategy !== "fail_preserve_client" &&
      markerPlan.markers.length > 0;

    const signals: MutatedRequest["signals"] = markerPlan.signals;

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
      middle_hash:
        markerPlan.markers.find((marker) => marker.role === "write_frontier")?.cumulative_hash ?? null,
      signals,
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
