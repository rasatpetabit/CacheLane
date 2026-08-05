import { describe, expect, test } from "vitest";
import {
  formatReportCompletion,
  formatSessions,
  formatStats,
} from "../format.js";
import type { CachelaneStats, SessionSummaryRow } from "../../storage/index.js";

describe("formatStats", () => {
  test("formats stats with distinct pipeline outcomes", () => {
    const stats: CachelaneStats = {
      scope: "workspace",
      workspace_id: "wk-123",
      session_id: null,
      since_ms: null,
      turns: 10,
      cache_hit_ratio: 0.85,
      outcome_counts: {
        mutated: 5,
        baseline: 2,
        no_op: 1,
        fail_open: 2,
      },
      pipeline_fallback_turns: 2,
      // savings_ratio must match effective/baseline arithmetic:
      // (120.00 - 100.50) / 120.00 = 0.1625
      effective_cost_units: 100.5,
      baseline_cost_units: 120.0,
      savings_ratio: 0.1625,
      pruner_counts: {
        pruned_blocks: 4,
        turns_with_pruning: 2,
        tokens_reclaimed: 0,
      },
      keepalive_counts: {
        pings: 5,
        turns_with_keepalive: 3,
      },
      compression_counts: {
        compressed_blocks: 0,
        tokens_saved: 0,
        by_profile: [],
      },
      route_counts: { proxy: 9, hook: 1, other: 0 },
      usage_counts: { recorded: 7, missing: 2, unknown: 1 },
      usage_missing_rate: 0.2,
      logical_input_tokens: 1_000,
      token_reuse_index: 0.85,
      provider_native_cost: 0,
    };

    // Arithmetic proof for the fixture:
    // savings_ratio = (baseline - effective) / baseline
    //               = (120.00 - 100.50) / 120.00
    //               = 19.50 / 120.00
    //               = 0.1625 → 16.3% when formatted to 1 decimal place.
    const output = formatStats(stats);
    expect(output).toContain("Telemetry records: 10");
    expect(output).toContain("Observed provider cache reuse ratio: 85.0%");
    expect(output).toContain("Estimated provider input-cost savings: 16.3%");
    expect(output).toContain("Estimated compression tokens saved: 0");
    expect(output).not.toContain("Cache hit ratio:");
    expect(output).not.toContain("Savings ratio:");
    expect(output).not.toContain("Usage events:");
    expect(output).toBe(
      [
        "Scope: workspace",
        "Telemetry records: 10",
        "Observed provider cache reuse ratio: 85.0%",
        "Pipeline fallback turns: 2",
        "Legacy metric (deprecated): pipeline fallback turns means request_mutated=0; use the exclusive outcome counts below.",
        "Mutated turns: 5",
        "Baseline turns: 2",
        "No-op turns: 1",
        "Fail-open turns: 2",
        "Effective cost units: 100.50",
        "Baseline cost units: 120.00",
        "Estimated provider input-cost savings: 16.3%",
        "Token reuse index: 85.0%",
        "Pruned blocks: 4",
        "Prune actions (cumulative): 4",
        "Prune actions are cumulative; the same logical block can be pruned again on a later turn.",
        "Tokens reclaimed by pruning: 0",
        "Keepalive pings: 5",
        "Route: proxy 9 / hook 1 / other 0",
        "Usage: recorded 7 / missing 2 / unknown 1",
        "Usage missing rate: 20.0%",
        "Provider native cost: n/a",
        "Estimated compression tokens saved: 0",
        "Provider cache reuse and input-cost savings are observed provider telemetry; they are not attributed to CacheLane mutations.",
      ].join("\n")
    );
  });
});

describe("formatSessions", () => {
  test("uses non-causal session table headers", () => {
    const rows: SessionSummaryRow[] = [
      {
        workspace_id: "wk-123",
        session_id: "sess-abc",
        turns: 3,
        cache_hit_ratio: 0.5,
        // (baseline - effective) / baseline = 0.25 → 25.0% in EST.SAV column
        savings_ratio: 0.25,
        last_active_ms: 1_715_000_000_000,
      },
    ];

    const output = formatSessions(rows);
    expect(output).toContain("RECORDS");
    expect(output).toContain("REUSE");
    expect(output).toContain("EST.SAV");
    expect(output).not.toMatch(/\bTURNS\b/);
    expect(output).not.toMatch(/\bEVENTS\b/);
    expect(output).not.toMatch(/\bHIT\b/);
    expect(output).not.toMatch(/\bSAVINGS\b/);
    expect(output.split("\n")[0]).toBe(
      `${"SESSION ID".padEnd(38)}  ${"RECORDS".padStart(7)}  ${"REUSE".padStart(6)}  ${"EST.SAV".padStart(7)}  LAST ACTIVE`,
    );
  });
});

describe("formatReportCompletion", () => {
  test("falls back to the legacy turns count when additive counters are absent", () => {
    expect(
      formatReportCompletion({
        out_path: "/tmp/report.html",
        turns: 7,
        sessions: 2,
      }),
    ).toBe(
      "wrote /tmp/report.html (7 recorded turns, 7 shown, 2 sessions)",
    );
  });
});

describe("formatStats session and usage warnings", () => {
  test("prints Session ID after Scope when session-scoped", () => {
    const stats: CachelaneStats = {
      scope: "session",
      workspace_id: "wk-123",
      session_id: "sess-abc",
      since_ms: null,
      turns: 5,
      cache_hit_ratio: 0.8,
      outcome_counts: { mutated: 2, baseline: 1, no_op: 1, fail_open: 1 },
      pipeline_fallback_turns: 2,
      effective_cost_units: 90,
      baseline_cost_units: 100,
      savings_ratio: 0.1,
      pruner_counts: { pruned_blocks: 0, turns_with_pruning: 0, tokens_reclaimed: 0 },
      keepalive_counts: { pings: 0, turns_with_keepalive: 0 },
      compression_counts: { compressed_blocks: 0, tokens_saved: 0, by_profile: [] },
      route_counts: { proxy: 5, hook: 0, other: 0 },
      usage_counts: { recorded: 3, missing: 1, unknown: 1 },
      usage_missing_rate: 0.2,
      logical_input_tokens: 500,
      token_reuse_index: 0.8,
      provider_native_cost: 0,
    };

    const output = formatStats(stats);
    expect(output).toContain("Scope: session");
    expect(output).toContain("Session ID: sess-abc");
    expect(output).toMatch(/^Scope: session\nSession ID: sess-abc\n/);
  });

  test("warns when provider usage is unavailable", () => {
    const stats: CachelaneStats = {
      scope: "workspace",
      workspace_id: "wk-123",
      session_id: null,
      since_ms: null,
      turns: 3,
      cache_hit_ratio: 0.5,
      outcome_counts: { mutated: 0, baseline: 1, no_op: 1, fail_open: 1 },
      pipeline_fallback_turns: 2,
      effective_cost_units: 50,
      baseline_cost_units: 100,
      savings_ratio: 0.5,
      pruner_counts: { pruned_blocks: 0, turns_with_pruning: 0, tokens_reclaimed: 0 },
      keepalive_counts: { pings: 0, turns_with_keepalive: 0 },
      compression_counts: { compressed_blocks: 0, tokens_saved: 0, by_profile: [] },
      route_counts: { proxy: 3, hook: 0, other: 0 },
      usage_counts: { recorded: 0, missing: 2, unknown: 1 },
      usage_missing_rate: 2 / 3,
      logical_input_tokens: 300,
      token_reuse_index: 0.5,
      provider_native_cost: 0,
    };

    const output = formatStats(stats);
    expect(output).toContain("Provider usage is unavailable for this selection; cache reuse and input-cost estimates are not meaningful.");
  });

  test("does not warn when some usage is recorded", () => {
    const stats: CachelaneStats = {
      scope: "workspace",
      workspace_id: "wk-123",
      session_id: null,
      since_ms: null,
      turns: 3,
      cache_hit_ratio: 0.5,
      outcome_counts: { mutated: 0, baseline: 1, no_op: 1, fail_open: 1 },
      pipeline_fallback_turns: 2,
      effective_cost_units: 50,
      baseline_cost_units: 100,
      savings_ratio: 0.5,
      pruner_counts: { pruned_blocks: 0, turns_with_pruning: 0, tokens_reclaimed: 0 },
      keepalive_counts: { pings: 0, turns_with_keepalive: 0 },
      compression_counts: { compressed_blocks: 0, tokens_saved: 0, by_profile: [] },
      route_counts: { proxy: 3, hook: 0, other: 0 },
      usage_counts: { recorded: 1, missing: 1, unknown: 1 },
      usage_missing_rate: 1 / 3,
      logical_input_tokens: 300,
      token_reuse_index: 0.5,
      provider_native_cost: 0,
    };

    const output = formatStats(stats);
    expect(output).not.toContain("Provider usage is unavailable for this selection; cache reuse and input-cost estimates are not meaningful.");
  });

  test("does not warn when turns is zero", () => {
    const stats: CachelaneStats = {
      scope: "workspace",
      workspace_id: "wk-123",
      session_id: null,
      since_ms: null,
      turns: 0,
      cache_hit_ratio: 0,
      outcome_counts: { mutated: 0, baseline: 0, no_op: 0, fail_open: 0 },
      pipeline_fallback_turns: 0,
      effective_cost_units: 0,
      baseline_cost_units: 0,
      savings_ratio: 0,
      pruner_counts: { pruned_blocks: 0, turns_with_pruning: 0, tokens_reclaimed: 0 },
      keepalive_counts: { pings: 0, turns_with_keepalive: 0 },
      compression_counts: { compressed_blocks: 0, tokens_saved: 0, by_profile: [] },
      route_counts: { proxy: 0, hook: 0, other: 0 },
      usage_counts: { recorded: 0, missing: 0, unknown: 0 },
      usage_missing_rate: 0,
      logical_input_tokens: 0,
      token_reuse_index: 0,
      provider_native_cost: 0,
    };

    const output = formatStats(stats);
    expect(output).not.toContain("Provider usage is unavailable for this selection; cache reuse and input-cost estimates are not meaningful.");
  });
});
