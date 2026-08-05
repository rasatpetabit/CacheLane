import type {
  CachelaneStats,
  SessionSummaryRow,
  TurnExplanationRecord,
} from "../storage/index.js";
import type { GenerateReportResult } from "../report/index.js";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percent3(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

export function formatStats(stats: CachelaneStats): string {
  const failOpen =
    stats.fail_open_turns ?? stats.outcome_counts?.fail_open ?? 0;
  const baseline = stats.outcome_counts?.baseline ?? 0;
  const mutated =
    stats.outcome_counts?.mutated ??
    Math.max(stats.turns - stats.pipeline_fallback_turns, 0);
  const noOp =
    stats.outcome_counts?.no_op ??
    Math.max(stats.pipeline_fallback_turns - baseline - failOpen, 0);
  const lines: string[] = [`Scope: ${stats.scope}`];
  if (stats.session_id !== null) {
    lines.push(`Session ID: ${stats.session_id}`);
  }
  lines.push(
    `Telemetry records: ${stats.turns}`,
    `Observed provider cache reuse ratio: ${(stats.cache_hit_ratio * 100).toFixed(3)}% (${stats.cache_read_tokens} / ${stats.logical_input_tokens} cache-read / logical tokens)`,
    `Pipeline fallback turns: ${stats.pipeline_fallback_turns}`,
    "Legacy metric (deprecated): pipeline fallback turns means request_mutated=0; use the exclusive outcome counts below.",
    `Mutated turns: ${mutated}`,
    `Baseline turns: ${baseline}`,
    `No-op turns: ${noOp}`,
    `Fail-open turns: ${failOpen}`,
    `Effective cost units: ${stats.effective_cost_units.toFixed(2)}`,
    `Baseline cost units: ${stats.baseline_cost_units.toFixed(2)}`,
    `Estimated provider input-cost savings: ${percent3(stats.savings_ratio)}`,
    `Token reuse index: ${percent3(stats.token_reuse_index ?? 0)}`,
    `Logical input tokens: ${stats.logical_input_tokens}`,
    `Uncached input tokens: ${stats.uncached_input_tokens}`,
    `Cache-read tokens: ${stats.cache_read_tokens}`,
    `5-minute cache-write tokens: ${stats.cache_creation_5m_tokens}`,
    `1-hour cache-write tokens: ${stats.cache_creation_1h_tokens}`,
    `Pruned blocks: ${stats.pruner_counts.pruned_blocks}`,
    `Prune actions (cumulative): ${stats.pruner_counts.pruned_blocks}`,
    "Prune actions are cumulative; the same logical block can be pruned again on a later turn.",
    `Tokens reclaimed by pruning: ${stats.pruner_counts.tokens_reclaimed}`,
    `Keepalive pings: ${stats.keepalive_counts.pings}`,
    `Route: proxy ${stats.route_counts?.proxy ?? 0} / hook ${stats.route_counts?.hook ?? 0} / other ${stats.route_counts?.other ?? 0}`,
    `Usage: recorded ${stats.usage_counts?.recorded ?? 0} / missing ${stats.usage_counts?.missing ?? 0} / unknown ${stats.usage_counts?.unknown ?? 0}`,
    `Usage missing rate: ${percent(stats.usage_missing_rate ?? 0)}`,
  );
  const recorded = stats.usage_counts?.recorded ?? 0;
  const missing = stats.usage_counts?.missing ?? 0;
  const unknown = stats.usage_counts?.unknown ?? 0;
  if (recorded === 0 && missing + unknown === stats.turns && stats.turns > 0) {
    lines.push("Provider usage is unavailable for this selection; cache reuse and input-cost estimates are not meaningful.");
  }
  lines.push(
    `Provider native cost: ${(stats.provider_native_cost ?? 0) > 0 ? stats.provider_native_cost.toFixed(2) : "n/a"}`,
    `Estimated compression tokens saved: ${stats.compression_counts.tokens_saved}`,
    "Provider cache reuse and input-cost savings are observed provider telemetry; they are not attributed to CacheLane mutations.",
  );
  return lines.join("\n");
}

export function formatExplanation(
  result: { found: false } | { found: true; explanation: TurnExplanationRecord },
): string {
  if (!result.found) return "No turn explanation found.";

  const explanation = result.explanation;
  return [
    `Turn: ${explanation.turn_number}`,
    `Model: ${explanation.model}`,
    `Mutated: ${explanation.mutated ? "yes" : "no"}`,
    `Prefix hash: ${explanation.prefix_breakpoint_hash ?? "none"}`,
    `Middle hash: ${explanation.middle_breakpoint_hash ?? "none"}`,
    `Pruned blocks: ${explanation.pruned_blocks_count}`,
    `Messages: ${explanation.region_metadata.message_count}`,
    `Signals: ${explanation.signals.join(", ") || "none"}`,
  ].join("\n");
}

export function formatSessions(rows: SessionSummaryRow[]): string {
  if (rows.length === 0) return "No sessions recorded.";
  const lines = [
    `${"SESSION ID".padEnd(38)}  ${"RECORDS".padStart(7)}  ${"REUSE".padStart(6)}  ${"EST.SAV".padStart(7)}  LAST ACTIVE`,
    "-".repeat(80),
  ];
  for (const r of rows) {
    const date = new Date(r.last_active_ms).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    lines.push(
      `${r.session_id.padEnd(38)}  ${String(r.turns).padStart(7)}  ${(r.cache_hit_ratio * 100).toFixed(1).padStart(5)}%  ${(r.savings_ratio * 100).toFixed(1).padStart(6)}%  ${date}`,
    );
  }
  return lines.join("\n");
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatReportCompletion(result: GenerateReportResult): string {
  const recordedTurns = result.recorded_turns ?? result.turns;
  const displayedTurns = result.displayed_turns ?? result.turns;
  return `wrote ${result.out_path} (${recordedTurns} recorded turns, ${displayedTurns} shown, ${result.sessions} sessions)`;
}

function tierMultiplier(tier: string): number {
  switch (tier) {
    case "cache_read": return 0.1;
    case "cache_creation_5m": return 1.25;
    case "cache_creation_1h": return 2.0;
    case "cache_creation": return 1.25;
    default: return 1.0;
  }
}

export function formatTopBlocks(
  result: { found: false } | { found: true; explanation: TurnExplanationRecord },
  limit: number
): string {
  if (!result.found) return "No turn explanation found.";

  const explanation = result.explanation;
  const blocks = [...explanation.block_metadata].sort((a, b) => b.token_count - a.token_count);
  
  const lines = [
    `Turn ${explanation.turn_number} — Top blocks by token weight`,
    ``,
    `  ${"Block ID".padEnd(38)}  ${"Kind".padEnd(14)}  ${"Region".padEnd(8)}  ${"Tokens".padStart(8)}  ${"Tier".padEnd(16)}  ${"Est. Cost"}`,
    `  ${"─".repeat(98)}`
  ];

  let shownCount = 0;
  for (const block of blocks) {
    if (shownCount >= limit) break;
    
    let tier = "unknown";
    let estCost = 0;
    if (explanation.region_cost) {
      const region = block.volatility.toLowerCase() as "stable" | "semi" | "volatile";
      const regionCost = explanation.region_cost[region];
      if (regionCost) {
        tier = regionCost.tier;
        const mult = tierMultiplier(tier);
        estCost = block.token_count * mult;
      }
    }
    
    let displayTier = tier;
    if (tier === "input") displayTier = "input (1x)";
    else if (tier === "cache_read") displayTier = "cache_read";
    
    lines.push(`  ${block.block_id.padEnd(38)}  ${block.kind.padEnd(14)}  ${block.volatility.padEnd(8)}  ${String(block.token_count).padStart(8)}  ${displayTier.padEnd(16)}  ${estCost.toFixed(1)} cu`);
    shownCount++;
  }

  if (blocks.length > limit) {
    lines.push(`  (${blocks.length - limit} more blocks below threshold)`);
  }

  lines.push(``);
  lines.push(`  Region totals:`);
  
  if (explanation.region_cost) {
    for (const region of ["stable", "semi", "volatile"] as const) {
      const rc = explanation.region_cost[region];
      const multText = rc.tier === "input" ? "(1x)" : rc.tier === "cache_read" ? "(0.1x)" : rc.tier.startsWith("cache_creation") ? "(1.25x/2x)" : "";
      lines.push(`    ${region.toUpperCase().padEnd(8)}: ${String(rc.tokens).padStart(8)} tokens → ${rc.tier.padEnd(18)} ${multText.padEnd(10)} → ${rc.cost_units.toFixed(1).padStart(7)} cu`);
    }
    const baseline = explanation.usage.input_tokens + explanation.usage.cache_read_tokens + explanation.usage.cache_creation_5m_tokens + explanation.usage.cache_creation_1h_tokens;
    const savings = baseline > 0 ? ((baseline - explanation.usage.effective_cost_units) / baseline * 100).toFixed(1) : "0.0";
    lines.push(`    Total effective: ${explanation.usage.effective_cost_units.toFixed(1)} cu  (vs. ${baseline.toFixed(1)} baseline — ${savings}% savings)`);
  } else {
    lines.push(`    (No region cost breakdown available for this turn)`);
  }

  return lines.join("\n");
}
