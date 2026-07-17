import { describe, it, expect } from "vitest";
import { renderReportHtml } from "../render-html.js";
import type { ReportData, ReportTurn } from "../types.js";
import type { RecordedBenchmarkReport } from "../../benchmark/types.js";

function reportTurn(
  turnNumber: number,
  outcome: NonNullable<ReportTurn["outcome"]>,
  explanationAvailable = true,
): ReportTurn {
  return {
    workspace_id: "ws",
    session_id: "s1",
    turn_number: turnNumber,
    created_at: 1_750_000_000_000 + turnNumber,
    model: "m",
    mutated: outcome === "mutated",
    input_tokens: 100,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    effective_cost_units: 100,
    baseline_cost_units: 100,
    outcome,
    explanation_available: explanationAvailable,
    stable_count: explanationAvailable ? 1 : 0,
    semi_count: explanationAvailable ? 1 : 0,
    volatile_count: explanationAvailable ? 1 : 0,
    pruned_blocks_count: 0,
    prune_decisions: [],
    signals: outcome === "fail_open" ? ["error:fallback"] : [],
  };
}

const data: ReportData = {
  generated_at: "2026-06-16T00:00:00Z",
  scope: "workspace",
  workspace_id: "ws",
  session_id: null,
  long_session_threshold_turns: 15,
  source: {
    cachelane_home: "/home/ras/.cachelane-smoke",
    db_path: "/home/ras/.cachelane-smoke/cachelane.db",
    proxy: {
      host: "127.0.0.1",
      port: 7332,
      upstream_host: "127.0.0.1",
      upstream_port: 4000,
      upstream_ssl: false,
    },
  },
  explanation_coverage: {
    recorded_turns: 4,
    explained_turns: 3,
    missing_explanations: 1,
    ignored_orphan_explanations: 2,
    displayed_turns: 4,
    display_limit: 500,
    truncated: false,
  },
  stats: {
    scope: "workspace",
    workspace_id: "ws",
    session_id: null,
    since_ms: null,
    turns: 4,
    cache_hit_ratio: 0.4,
    effective_cost_units: 128,
    baseline_cost_units: 300,
    savings_ratio: 0.573,
    pipeline_fallback_turns: 1,
    outcome_counts: { mutated: 1, no_op: 1, baseline: 1, fail_open: 1 },
    pruner_counts: {
      pruned_blocks: 2,
      tokens_reclaimed: 420,
      turns_with_pruning: 1,
    },
    keepalive_counts: { pings: 0, turns_with_keepalive: 0 },
    compression_counts: {
      compressed_blocks: 3,
      tokens_saved: 198,
      by_profile: [
        { profile_id: "(unprofiled)", tokens_saved: 48, compressed_blocks: 1 },
        { profile_id: "git-status", tokens_saved: 150, compressed_blocks: 2 },
      ],
    },
  },
  turns: [
    reportTurn(1, "mutated"),
    reportTurn(2, "baseline"),
    reportTurn(3, "no_op", false),
    reportTurn(4, "fail_open"),
  ],
  sessions: [],
  privacy: { content_persisted: false },
};

const benchmark: RecordedBenchmarkReport = {
  run_id: "demo-run",
  generated_at: "2026-06-16T00:00:00Z",
  source: { kind: "normalized_trace", provider: "fake", normalized_dir: null, model: "m" },
  counts: { sessions: 1, turns: 2, blocks: 3, tool_calls: 1 },
  totals: {
    input_tokens: 100,
    cache_read_tokens: 400,
    baseline_cost_units: 500,
    effective_cost_units: 140,
    savings_ratio: 0.72,
    cache_hit_ratio: 0.8,
    pruned_blocks: 1,
    keepalive_pings: 0,
  },
  scenarios: [
    {
      scenario_id: "read-summarize-file",
      session_id: "s1",
      turns: 2,
      blocks: 3,
      tool_calls: 1,
      input_tokens: 100,
      cache_read_tokens: 400,
      baseline_cost_units: 500,
      effective_cost_units: 140,
      savings_ratio: 0.72,
      cache_hit_ratio: 0.8,
      pruned_blocks: 1,
      keepalive_pings: 0,
    },
  ],
  privacy: { content_persisted: false },
};

describe("renderReportHtml", () => {
  it("is self-contained (no external resource refs)", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("uses the warm theme, not the old dark theme", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("--color-accent");
    expect(html).not.toContain("#0b0d12");
  });

  it("declares content_persisted false and includes all three panels", () => {
    const html = renderReportHtml(data);
    expect(html).toContain('name="cachelane:content_persisted" content="false"');
    expect(html).toContain('id="p-usage"');
    expect(html).toContain('id="p-curve"');
    expect(html).toContain('id="p-decisions"');
  });

  it("renders distinct pipeline outcomes and only fail-open as danger", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("Mutated turns");
    expect(html).toContain("Baseline turns");
    expect(html).toContain("No-op turns");
    expect(html).toContain("Fail-open turns");
    expect(html).toContain('<span class="badge ok">mutated</span>');
    expect(html).toContain('<span class="badge neutral">baseline</span>');
    expect(html).toContain('<span class="badge neutral">no-op</span>');
    expect((html.match(/<span class="badge fail">fail-open<\/span>/g) ?? [])).toHaveLength(1);
  });

  it("shows explanation coverage, missing details, and ignored orphans", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("3 of 4 recorded turns have decision metadata");
    expect(html).toContain("1 turn is missing decision details");
    expect(html).toContain("2 orphan explanation records ignored");
    expect(html).toContain("details missing");
  });

  it("disables the cumulative curve outside session scope", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("Select a single session to render a meaningful cumulative curve");
    expect(html).not.toContain("naive prefix cache");

    const sessionHtml = renderReportHtml({ ...data, scope: "session", session_id: "s1" });
    expect(sessionHtml).toContain("naive prefix cache");
    expect(sessionHtml).toContain("CacheLane");
  });

  it("sorts only the curve by logical turn number when completion timestamps arrive out of order", () => {
    const completedTurns: ReportTurn[] = [
      {
        ...reportTurn(2, "mutated"),
        created_at: 1_000,
        baseline_cost_units: 200,
        recorded_baseline_cost_units: 200,
        effective_cost_units: 200,
      },
      {
        ...reportTurn(1, "mutated"),
        created_at: 2_000,
        baseline_cost_units: 100,
        recorded_baseline_cost_units: 100,
        effective_cost_units: 100,
      },
    ];
    const html = renderReportHtml({
      ...data,
      scope: "session",
      session_id: "s1",
      completed_turns: completedTurns,
      explanation_coverage: {
        recorded_turns: 2,
        explained_turns: 2,
        missing_explanations: 0,
        ignored_orphan_explanations: 0,
        displayed_turns: 2,
        display_limit: 500,
        truncated: false,
      },
    });

    expect(html).toContain(
      'points="40.0,200.0 680.0,40.0"',
    );
    expect(html.indexOf("1970-01-01T00:00:01.000Z")).toBeLessThan(
      html.indexOf("1970-01-01T00:00:02.000Z"),
    );
  });

  it("uses precise prune terminology and renders reclaimed tokens", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("Prune actions");
    expect(html).toContain("Tokens reclaimed");
    expect(html).toContain("420");
    expect(html).not.toContain("Pruned blocks");
  });

  it("renders reconciled per-profile compression savings", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("(unprofiled)");
    expect(html).toContain("git-status");
    expect(html).toContain("198");
  });

  it("renders the actual database and route identity", () => {
    const html = renderReportHtml(data);
    expect(html).toContain("/home/ras/.cachelane-smoke/cachelane.db");
    expect(html).toContain("127.0.0.1:7332");
    expect(html).toContain("127.0.0.1:4000");
    expect(html).not.toContain("~/.cachelane/cachelane.db");
  });

  it("omits benchmark panels when no benchmark is supplied", () => {
    const html = renderReportHtml(data);
    expect(html).not.toContain('id="p-totals"');
    expect(html).not.toContain('id="p-scenarios"');
  });

  it("appends benchmark totals and scenarios panels when a benchmark is supplied", () => {
    const html = renderReportHtml(data, benchmark);
    expect(html).toContain('id="p-usage"');
    expect(html).toContain('id="p-totals"');
    expect(html).toContain('id="p-scenarios"');
    expect(html).toContain("read-summarize-file");
  });

  it("never leaks content (there is none to leak)", () => {
    const html = renderReportHtml(data);
    expect(html).not.toContain("export const");
  });
});
