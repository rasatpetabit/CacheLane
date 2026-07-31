import { findRegionBoundaries } from "./region-boundaries.js";
import { placeBreakpoints } from "./breakpoint-placer.js";
import { planMarkers, type MarkerPlan } from "./marker-planner.js";
import { mutateRequest } from "./request-mutator.js";
import type { CacheTier, PrefixState } from "../types/index.js";
import type {
  AnthropicMessagesRequest,
  Classification,
} from "./types.js";

export type PublicMarkerStrategy = "prefix_only" | "candidate";

export interface PlannedRequest {
  request: AnthropicMessagesRequest;
  plan: MarkerPlan;
}

/** Build the next-turn planner state from a completed candidate plan. */
export function candidatePrefixState(
  planned: PlannedRequest,
  workspaceId = "experiment",
): PrefixState | undefined {
  const staticPrefix = planned.plan.markers.find((marker) => marker.role === "static_prefix");
  const frontier = planned.plan.markers.find((marker) => marker.role === "write_frontier");
  if (!staticPrefix || !frontier) return undefined;
  const now = Date.now();
  return {
    workspace_id: workspaceId,
    prefix_hash: staticPrefix.cumulative_hash,
    middle_hash: frontier.cumulative_hash,
    middle_message_index: frontier.message_index,
    middle_content_index: frontier.content_index,
    prefix_token_count: 0,
    ttl_class: frontier.ttl,
    cached_at_ms: now,
    last_read_at_ms: now,
    expected_expiry_ms: now + (frontier.ttl === "1h" ? 3_600_000 : 300_000),
  };
}

function defaultClassifications(request: AnthropicMessagesRequest): Classification[] {
  return request.messages.map(() => ({
    kind: "prior_turn",
    volatility: "SEMI",
    isPinned: false,
    signals: [],
  }));
}

/**
 * Apply the same marker planner and mutator used by production orchestration.
 * Intended for controlled experiments and provider-conformance probes.
 */
export function planAndApplyMarkers(
  request: AnthropicMessagesRequest,
  strategy: PublicMarkerStrategy,
  prefixTtl: CacheTier = "5m",
  previous?: PrefixState,
  classifications: Classification[] = defaultClassifications(request),
): PlannedRequest {
  const boundaries = findRegionBoundaries(classifications);
  const breakpoints = placeBreakpoints(request, boundaries, previous);
  const plan = strategy === "candidate"
    ? planMarkers(request, prefixTtl, previous)
    : planMarkers(
        { ...request, messages: [] },
        prefixTtl,
      );
  return {
    request: mutateRequest(request, boundaries, breakpoints, prefixTtl, plan),
    plan,
  };
}
