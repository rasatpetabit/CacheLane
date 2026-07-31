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
