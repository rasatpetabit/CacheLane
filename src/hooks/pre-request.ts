import type { Classification } from "../classifier/index.js";
import type { CachelaneConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  CachelaneDb,
  TurnExplanationBlockMetadata,
  TurnExplanationRegionMetadata,
} from "../storage/index.js";
import {
  materializePrunedBlocks,
  pruneExpiredBlocks,
  type PromptBlockPlacement,
  type PruneDecision,
} from "../pruner/index.js";
import {
  DEFAULT_ELISION_POLICY,
  transformAnthropic,
  type ElisionDecision,
  type ElisionPolicy,
} from "../pruner/transform.js";
import {
  orchestrate,
  type AnthropicMessagesRequest,
  type CacheStateTracker,
  type MutatedRequest,
} from "../orchestrator/index.js";
import { logger } from "../logger/index.js";

export interface PreRequestInput {
  db: CachelaneDb;
  tracker: CacheStateTracker;
  workspace_id: string;
  session_id: string;
  turn_id?: string;
  current_turn: number;
  original_request: AnthropicMessagesRequest;
  message_classifications: Classification[];
  block_placements: PromptBlockPlacement[];
  pruner: CachelaneConfig["pruner"];
  marker_strategy?: CachelaneConfig["features"]["marker_strategy"];
  /**
   * The features.k_pruner kill switch.
   *
   * Historically only the OpenAI path honoured this, so the Anthropic lane
   * could still elide with k_pruner=false. Both arms check it now: a flag named
   * for the feature should turn the feature off on every provider.
   */
  k_pruner_enabled?: boolean;
  /**
   * features.mutation_enabled. When false the caller forwards the client's body
   * unchanged, so running the stateless transform would do work nobody uses and
   * — worse — record elided_bytes for content that was never actually removed.
   * Gate 5 reads that field, so a false positive there is not cosmetic.
   */
  mutation_enabled?: boolean;
  /** Which elision implementation to run. Defaults to the legacy K-pruner. */
  elision_mode?: CachelaneConfig["features"]["elision_mode"];
  /** Overrides the stateless arm's policy; ignored under "legacy". */
  elision_policy?: ElisionPolicy;
  route: "proxy" | "hook" | "other";
  build_sha?: string;
  config_hash?: string;
  now_ms?: number;
}

export interface PreRequestResult extends MutatedRequest {
  pruned_blocks_count: number;
  prune_decisions: PruneDecision[];
  effective_message_classifications: Classification[];
  /** Which arm produced this turn. */
  elision_mode: CachelaneConfig["features"]["elision_mode"];
  /** Populated only under the stateless arm; measured in bytes, never tokens. */
  elision_decisions: ElisionDecision[];
  /** Whether the selected arm actually ran, as opposed to being switched off. */
  elision_active: boolean;
}

function fallbackResult(input: PreRequestInput): PreRequestResult {
  return {
    request: input.original_request,
    mutated: false,
    prefix_hash: "",
    middle_hash: null,
    signals: ["error:fallback"],
    pruned_blocks_count: 0,
    prune_decisions: [],
    effective_message_classifications: input.message_classifications,
    keepalive_pings_since_last_turn: 0,
    elision_mode: input.elision_mode ?? "legacy",
    elision_decisions: [],
    elision_active: false,
  };
}

function applyOneTurnSuffixWarming(
  input: PreRequestInput,
): Classification[] {
  const warmedMessageIndexes = new Set<number>();

  for (const placement of input.block_placements) {
    const row = input.db.getBlock(placement.block_id);
    if (
      row !== null &&
      row.workspace_id === input.workspace_id &&
      row.session_id === input.session_id &&
      row.restored_at_turn === input.current_turn - 1
    ) {
      warmedMessageIndexes.add(placement.message_index);
    }
  }

  if (warmedMessageIndexes.size === 0) {
    return input.message_classifications;
  }

  return input.message_classifications.map((classification, index) => {
    if (!warmedMessageIndexes.has(index)) return classification;
    return {
      ...classification,
      volatility: "VOLATILE",
    };
  });
}

function fallbackTurnId(input: PreRequestInput): string {
  return `${input.workspace_id}:${input.session_id}:${input.current_turn}`;
}

function explainBlockMetadata(
  placements: PromptBlockPlacement[],
): TurnExplanationBlockMetadata[] {
  return placements.map((placement) => ({
    block_id: placement.block_id,
    message_index: placement.message_index,
    content_index: placement.content_index,
    kind: placement.kind,
    volatility: placement.volatility,
    is_pinned: placement.is_pinned,
    has_refetch_handle: placement.refetch_handle !== null,
    restored_at_turn: placement.restored_at_turn ?? null,
    token_count: placement.token_count,
  }));
}

function explainRegionMetadata(
  classifications: Classification[],
): TurnExplanationRegionMetadata {
  let stable_count = 0;
  let semi_count = 0;
  let volatile_count = 0;

  for (const classification of classifications) {
    if (classification.volatility === "STABLE") {
      stable_count++;
    } else if (classification.volatility === "SEMI") {
      semi_count++;
    } else {
      volatile_count++;
    }
  }

  return {
    message_count: classifications.length,
    stable_count,
    semi_count,
    volatile_count,
  };
}

function markerOwner(
  input: PreRequestInput,
  result: PreRequestResult,
): "client" | "cachelane" | "mixed" {
  if (input.marker_strategy === "passthrough" || result.signals.includes("markers:fail_preserve")) {
    return "client";
  }
  if ((result.incoming_markers?.length ?? 0) > 0) return "mixed";
  return "cachelane";
}

function recordExplanation(
  input: PreRequestInput,
  result: PreRequestResult,
): void {
  if (typeof input.db.insertTurnExplanation !== "function") return;

  const now = input.now_ms ?? Date.now();
  try {
    input.db.insertTurnExplanation({
      turn_id: input.turn_id ?? fallbackTurnId(input),
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      turn_number: input.current_turn,
      model: input.original_request.model,
      prefix_breakpoint_hash: result.prefix_hash || null,
      middle_breakpoint_hash: result.middle_hash,
      mutated: result.mutated,
      pruned_blocks_count: result.pruned_blocks_count,
      prune_decisions: result.prune_decisions.map((decision) => ({
        block_id: decision.block_id,
        action: decision.action,
        reason: decision.reason,
        kind: decision.kind,
        stub_summary: decision.stub_summary,
        has_refetch_handle: decision.refetch_handle.length > 0,
        tokens_reclaimed: Math.max(decision.original_tokens - decision.stub_tokens, 0),
      })),
      block_metadata: explainBlockMetadata(input.block_placements),
      region_metadata: explainRegionMetadata(
        result.effective_message_classifications,
      ),
      provenance: {
        build_sha: input.build_sha ?? process.env.CACHELANE_BUILD_SHA ?? null,
        config_hash: input.config_hash ?? process.env.CACHELANE_CONFIG_HASH ?? null,
        experiment_arm: input.marker_strategy ?? "prod",
        elision_mode: result.elision_mode,
        elision_active: result.elision_active,
        // Omitted, not zeroed, under the legacy arm: it reports token counts
        // rather than bytes, and a recorded 0 would read as "elided nothing"
        // instead of "not measured here".
        ...(result.elision_mode === "stateless"
          ? {
              elided_bytes: result.elision_decisions.reduce(
                (sum, d) => sum + Math.max(d.original_bytes - d.stub_bytes, 0),
                0,
              ),
            }
          : {}),
        route: input.route,
        marker_owner: markerOwner(input, result),
        outcome: result.signals.includes("error:fallback") ? "fallback" : "ok",
        usage_missing: true,
        incoming_markers: result.incoming_markers ?? [],
        emitted_markers: result.emitted_markers ?? [],
        prefix_hash_at_bp: result.prefix_hashes_at_breakpoints ?? [],
        prune_transforms: result.prune_decisions.map((decision) => ({
          block_id: decision.block_id,
          original_tokens: decision.original_tokens,
          stub_tokens: decision.stub_tokens,
        })),
      },
      signals: result.signals,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    console.error("[cachelane] pre-request explain log error", err);
  }
}

function recordAndReturnFallback(input: PreRequestInput): PreRequestResult {
  const result = fallbackResult(input);
  recordExplanation(input, result);
  return result;
}

/** Both kill switches, checked identically by both arms and both providers. */
function elisionDisabled(input: PreRequestInput): boolean {
  return input.pruner.enabled === false || input.k_pruner_enabled === false;
}

/**
 * The stateless arm additionally stands down when mutation is off.
 *
 * Deliberately not applied to the legacy arm: that path writes is_stub to the
 * database as a side effect, and today it does so even in the baseline (no
 * mutation) configuration. Changing that is a separate behavioural question
 * from this one.
 */
function statelessElisionDisabled(input: PreRequestInput): boolean {
  return elisionDisabled(input) || input.mutation_enabled === false;
}

/**
 * The stateless arm. Same contract as the legacy path — same orchestration,
 * same explanation record — differing only in how the elision set is decided.
 * Keeping the two behind one function signature is what lets Gate 5 vary the
 * implementation as the sole factor.
 */
function handleStateless(input: PreRequestInput): PreRequestResult {
  const policy: ElisionPolicy = input.elision_policy ?? {
    ...DEFAULT_ELISION_POLICY,
    k: input.pruner.k,
  };

  const active = !statelessElisionDisabled(input);
  const elided = !active
    ? { body: input.original_request, decisions: [] as ElisionDecision[] }
    : transformAnthropic(input.original_request, policy);

  const effectiveClassifications = applyOneTurnSuffixWarming(input);
  const orchestrated = orchestrate(
    {
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      current_turn: input.current_turn,
      message_classifications: effectiveClassifications,
      original_request: elided.body,
    },
    input.tracker,
    DEFAULT_CONFIG.keepalive,
    input.marker_strategy ?? "prefix_only",
  );

  const result: PreRequestResult = {
    ...orchestrated,
    // orchestrate() reports whether IT placed cache breakpoints. Eliding also
    // makes the forwarded body differ from the client's, and the caller
    // forwards the original whenever `mutated` is false — so without this, an
    // elision on a request with no system/tools blocks is computed, recorded as
    // bytes saved, and then thrown away before it reaches the wire.
    mutated: orchestrated.mutated || elided.decisions.length > 0,
    pruned_blocks_count: elided.decisions.length,
    // Empty by design: PruneDecision carries token counts, and the only token
    // numbers available here would be invented. The byte-accurate record lives
    // in elision_decisions.
    prune_decisions: [],
    effective_message_classifications: effectiveClassifications,
    elision_mode: "stateless",
    elision_decisions: elided.decisions,
    elision_active: active,
  };
  recordExplanation(input, result);
  return result;
}

export function handlePreRequest(input: PreRequestInput): PreRequestResult {
  try {
    if (
      !Array.isArray(input.message_classifications) ||
      input.message_classifications.length !==
        input.original_request.messages.length
    ) {
      console.error(
        "[cachelane] pre-request: message_classifications length mismatch — failing open",
        {
          classifications: Array.isArray(input.message_classifications)
            ? input.message_classifications.length
            : typeof input.message_classifications,
          messages: input.original_request.messages.length,
        }
      );
      return recordAndReturnFallback(input);
    }

    // The stateless arm short-circuits the whole database-backed decision path:
    // no getPrunableBlocks, no markStubs, no placements. Eligibility comes from
    // the messages array alone, so there is nothing to look up and nothing to
    // write back — which is the point, since the write-back is what made the
    // old path cost 45 ms per block and un-elide behind its own back.
    if ((input.elision_mode ?? "legacy") === "stateless") {
      return handleStateless(input);
    }

    const pruneResult = pruneExpiredBlocks(input.db, {
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      k: input.pruner.k,
      current_turn: input.current_turn,
      enabled: !elisionDisabled(input),
      now_ms: input.now_ms,
    });

    // Only materialize blocks that have a placement in the current request.
    // Blocks without placements (e.g. they've dropped out of the conversation
    // context) are still marked as stubs in the DB by pruneExpiredBlocks, but
    // the request body can't be mutated for them since there's no content slot
    // to replace.
    const placementIds = new Set(input.block_placements.map((p) => p.block_id));
    const actionableDecisions = pruneResult.decisions.filter((d) =>
      placementIds.has(d.block_id),
    );

    if (pruneResult.decisions.length > 0 || input.block_placements.length > 0) {
      logger.debug("pruner decision", JSON.stringify({
        session_id: input.session_id,
        turn: input.current_turn,
        k: input.pruner.k,
        decisions: pruneResult.decisions.length,
        placements: input.block_placements.length,
        placementIds: [...placementIds].slice(0, 5),
        decisionIds: pruneResult.decisions.slice(0, 5).map(d => d.block_id),
        actionable: actionableDecisions.length,
      }));
    }

    const requestWithStubs =
      actionableDecisions.length === 0
        ? input.original_request
        : materializePrunedBlocks({
            request: input.original_request,
            decisions: actionableDecisions,
            block_placements: input.block_placements,
          });

    const effectiveClassifications = applyOneTurnSuffixWarming(input);
    const orchestrated = orchestrate(
      {
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        current_turn: input.current_turn,
        message_classifications: effectiveClassifications,
        original_request: requestWithStubs,
      },
      input.tracker,
      DEFAULT_CONFIG.keepalive,
      input.marker_strategy ?? "prefix_only",
    );

    const result = {
      ...orchestrated,
      // Same reasoning as the stateless arm: stubs that the caller does not
      // forward are stubs that did nothing.
      mutated: orchestrated.mutated || actionableDecisions.length > 0,
      // Only count blocks that were actually materialized (had a placement).
      // Blocks marked as stubs in the DB but absent from the request are
      // already gone from context; they don't reduce the forwarded request.
      pruned_blocks_count: actionableDecisions.length,
      prune_decisions: actionableDecisions,
      effective_message_classifications: effectiveClassifications,
      elision_mode: "legacy" as const,
      elision_decisions: [],
      elision_active: !elisionDisabled(input),
    };
    recordExplanation(input, result);
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[cachelane] pre-request: pipeline error — failing open", errMsg);
    logger.error("pre-request pipeline error", errMsg, err);
    return recordAndReturnFallback(input);
  }
}
