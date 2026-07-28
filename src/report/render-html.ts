import type {
  ExplanationCoverage,
  ReportData,
  ReportSource,
  ReportTurn,
} from "./types.js";
import type {
  CachelaneStats,
  PipelineOutcome,
  PipelineOutcomeCounts,
} from "../storage/index.js";
import type { RecordedBenchmarkReport } from "../benchmark/types.js";
import { renderCurveSvg, renderStackedBarSvg } from "./charts.js";
import { pageShell } from "./theme.js";
import { benchmarkTabs } from "../benchmark/render-html.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Thousands-separated integer — raw counts like 259297408 are unreadable. */
function num(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

function cumulative(values: number[]): number[] {
  let acc = 0;
  return values.map((value) => (acc += value));
}

function card(label: string, value: string, danger = false): string {
  return `<div class="card${danger ? " danger" : ""}"><div class="card-value">${esc(value)}</div><div class="card-label">${esc(label)}</div></div>`;
}

function plural(value: number, singular: string, pluralValue = `${singular}s`): string {
  return value === 1 ? singular : pluralValue;
}

function outcomeBadge(outcome: PipelineOutcome): string {
  if (outcome === "mutated") {
    return `<span class="badge ok">mutated</span>`;
  }
  if (outcome === "fail_open") {
    return `<span class="badge fail">fail-open</span>`;
  }
  const label = outcome === "no_op" ? "no-op" : "baseline";
  return `<span class="badge neutral">${label}</span>`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

function reportOutcome(turn: ReportTurn): PipelineOutcome {
  if (turn.outcome !== undefined) return turn.outcome;
  if (turn.signals.includes("error:fallback")) return "fail_open";
  if (turn.signals.includes("mode:baseline")) return "baseline";
  return turn.mutated ? "mutated" : "no_op";
}

function normalizedOutcomes(stats: CachelaneStats): PipelineOutcomeCounts {
  const failOpen =
    stats.fail_open_turns ?? stats.outcome_counts?.fail_open ?? 0;
  const baseline = stats.outcome_counts?.baseline ?? 0;
  const mutated =
    stats.outcome_counts?.mutated ??
    Math.max(stats.turns - stats.pipeline_fallback_turns, 0);
  const noOp =
    stats.outcome_counts?.no_op ??
    Math.max(stats.pipeline_fallback_turns - baseline - failOpen, 0);
  return { fail_open: failOpen, baseline, mutated, no_op: noOp };
}

function normalizedSource(data: ReportData): ReportSource {
  return data.source ?? {
    cachelane_home: "unknown",
    db_path: "unknown",
    proxy: null,
  };
}

function normalizedCoverage(
  data: ReportData,
  displayedTurns: number,
): ExplanationCoverage {
  if (data.explanation_coverage !== undefined) {
    return data.explanation_coverage;
  }
  const explainedTurns = Math.min(data.turns.length, data.stats.turns);
  return {
    recorded_turns: data.stats.turns,
    explained_turns: explainedTurns,
    missing_explanations: Math.max(data.stats.turns - explainedTurns, 0),
    ignored_orphan_explanations: 0,
    displayed_turns: displayedTurns,
    display_limit: null,
    truncated: displayedTurns < data.stats.turns,
  };
}

function decisionRows(turns: ReportTurn[]): string {
  return turns
    .map((turn) => {
      const bar = renderStackedBarSvg([
        { label: "STABLE", value: turn.stable_count },
        { label: "SEMI", value: turn.semi_count },
        { label: "VOLATILE", value: turn.volatile_count },
      ]);
      const detailsBadge = turn.explanation_available === false
        ? ` <span class="badge warn">details missing</span>`
        : "";
      const ingestionBadge = turn.ingestion_mode === "hook"
        ? ` <span class="badge warn">hook</span>`
        : "";
      const prunes = turn.prune_decisions
        .map(
          (decision) =>
            `${esc(decision.block_id)} (${esc(decision.action)}: ${esc(decision.reason)})`,
        )
        .join("<br>") || "—";
      const timestamp = turn.created_at === undefined
        ? "—"
        : formatTimestamp(turn.created_at);
      return `<tr><td>${esc(timestamp)}</td><td>${esc(turn.workspace_id ?? "—")}</td><td>${esc(turn.session_id ?? "—")}</td><td>${turn.turn_number}</td><td>${esc(turn.model)}</td><td>${outcomeBadge(reportOutcome(turn))}${ingestionBadge}${detailsBadge}</td><td class="bar-cell">${bar}</td><td>${turn.pruned_blocks_count}</td><td class="prunes">${prunes}</td><td>${esc(turn.signals.join(", ") || "—")}</td></tr>`;
    })
    .join("");
}

function coverageHtml(data: ReportData, turns: ReportTurn[]): string {
  const coverage = normalizedCoverage(data, turns.length);
  const missing = coverage.missing_explanations;
  const orphans = coverage.ignored_orphan_explanations;
  const limit = coverage.display_limit === null
    ? ""
    : ` Detail limit: ${coverage.display_limit}.`;
  const truncation = coverage.truncated
    ? " The table shows the newest completed turns only."
    : "";
  return `<p class="note integrity-note">${coverage.explained_turns} of ${coverage.recorded_turns} recorded turns have decision metadata. ${missing} ${plural(missing, "turn is", "turns are")} missing decision details. ${orphans} orphan ${plural(orphans, "explanation record", "explanation records")} ignored. Showing ${coverage.displayed_turns} of ${coverage.recorded_turns} completed turns.${limit}${truncation}</p>`;
}

function curveHtml(
  data: ReportData,
  turns: ReportTurn[],
  coverage: ExplanationCoverage,
): string {
  if (data.scope !== "session") {
    return `<p class="note">Select a single session to render a meaningful cumulative curve. Workspace and all scopes contain unrelated session timelines, so CacheLane does not concatenate them into a synthetic series.</p>`;
  }

  const curveTurns = [...turns].sort(
    (a, b) =>
      a.turn_number - b.turn_number ||
      (a.created_at ?? 0) - (b.created_at ?? 0),
  );
  const baselineCum = cumulative(
    curveTurns.map(
      (turn) =>
        turn.recorded_baseline_cost_units ?? turn.baseline_cost_units,
    ),
  );
  const effectiveCum = cumulative(
    curveTurns.map((turn) => turn.effective_cost_units),
  );
  const firstPruneIndex = curveTurns.findIndex(
    (turn) => turn.pruned_blocks_count > 0,
  );
  const turnNumbers = curveTurns.map((turn) => turn.turn_number);
  const curve = renderCurveSvg({
    baselineCumulative: baselineCum,
    effectiveCumulative: effectiveCum,
    turnNumbers,
    longSessionThreshold: data.long_session_threshold_turns,
    firstPruneTurn:
      firstPruneIndex >= 0
        ? curveTurns[firstPruneIndex]!.turn_number
        : null,
  });
  const windowNote = coverage.truncated
    ? ` This curve covers only the newest ${coverage.displayed_turns} completed turns in the displayed window.`
    : "";

  return `
${curve}
<p class="note">The baseline and headline cards use the same recorded units: input + cache creation + cache reads. The CacheLane line uses the provider-weighted effective units. The shaded long-session region starts on turn ${data.long_session_threshold_turns}; pruning is marked at its first recorded action.${windowNote}</p>`;
}

function sourceRoute(source: ReportSource): string | null {
  const proxy = source.proxy;
  if (proxy === null) return null;
  const upstream = `${proxy.upstream_ssl ? "TLS " : ""}${proxy.upstream_host}:${proxy.upstream_port}`;
  return `${proxy.host}:${proxy.port} → ${upstream}`;
}

export function renderReportHtml(
  data: ReportData,
  benchmark?: RecordedBenchmarkReport,
): string {
  const turns = data.completed_turns ?? data.turns;
  const sessions = data.scoped_sessions ?? data.sessions;
  const coverage = normalizedCoverage(data, turns.length);
  const source = normalizedSource(data);
  const sessionRows = sessions
    .map(
      (session) =>
        `<tr><td>${esc(session.workspace_id)}</td><td>${esc(session.session_id)}</td><td>${session.turns}</td><td>${pct(session.cache_hit_ratio)}</td><td>${pct(session.savings_ratio)}</td><td>${esc(formatTimestamp(session.last_active_ms))}</td></tr>`,
    )
    .join("") || `<tr><td colspan="6">No sessions yet</td></tr>`;

  const profileRows = data.stats.compression_counts.by_profile
    .map(
      (profile) =>
        `<tr><td>${esc(profile.profile_id)}</td><td>${profile.compressed_blocks}</td><td>${profile.tokens_saved}</td></tr>`,
    )
    .join("");
  const profileTableHtml = profileRows
    ? `<table><thead><tr><th>Profile</th><th>Compressed blocks</th><th>Tokens saved</th></tr></thead><tbody>${profileRows}</tbody></table>`
    : "";

  const outcomes = normalizedOutcomes(data.stats);
  const usageHtml = `
  <div class="cards">
  ${card("Savings", pct(data.stats.savings_ratio))}
  ${card("Cache hit ratio", pct(data.stats.cache_hit_ratio))}
  ${card("Turns", num(data.stats.turns))}
  ${card("Effective units", num(data.stats.effective_cost_units))}
  ${card("Baseline units", num(data.stats.baseline_cost_units))}
  ${card("Mutated turns", num(outcomes.mutated))}
  ${card("Baseline turns", num(outcomes.baseline))}
  ${card("No-op turns", num(outcomes.no_op))}
  ${card("Fail-open turns", num(outcomes.fail_open), outcomes.fail_open > 0)}
  ${card("Prune actions", num(data.stats.pruner_counts.pruned_blocks))}
  ${card("Tokens reclaimed", num(data.stats.pruner_counts.tokens_reclaimed))}
  ${card("Compression tokens saved", num(data.stats.compression_counts.tokens_saved))}
</div>
<p class="note">Prune actions are cumulative decision events; the same logical block can be pruned again on a later turn.</p>
<table><thead><tr><th>Workspace</th><th>Session</th><th>Turns</th><th>Hit</th><th>Savings</th><th>Last active</th></tr></thead><tbody>${sessionRows}</tbody></table>
${profileTableHtml}`;

  const decisionsHtml = `
${coverageHtml(data, turns)}
<table><thead><tr><th>Time</th><th>Workspace</th><th>Session</th><th>Turn</th><th>Model</th><th>Outcome</th><th>Region (S/M/V)</th><th>Prune actions</th><th>Prune decisions</th><th>Signals</th></tr></thead>
<tbody>${decisionRows(turns) || `<tr><td colspan="10">No completed turns recorded yet.</td></tr>`}</tbody></table>`;

  const route = sourceRoute(source);
  const subtitle = [
    `Scope: ${data.scope}`,
    `Database: ${source.db_path}`,
    ...(route === null ? [] : [`Current configured proxy route: ${route}`]),
    `Generated ${data.generated_at}`,
  ].join(" · ");
  const routeFooter = route === null
    ? ""
    : ` Current configured proxy route: ${esc(route)} (not per-turn persisted provenance).`;

  return pageShell({
    title: "CacheLane Report",
    subtitle,
    tabs: [
      { id: "usage", label: "Usage", html: usageHtml },
      { id: "curve", label: "Curve", html: curveHtml(data, turns, coverage) },
      { id: "decisions", label: "Decisions", html: decisionsHtml },
      ...(benchmark ? benchmarkTabs(benchmark) : []),
    ],
    footerHtml: `<footer>Local report generated from ${esc(source.db_path)} (home ${esc(source.cachelane_home)}).${routeFooter} By default CacheLane stores metadata only. If compression retention is explicitly enabled, original tool outputs may be stored locally until expiry for MCP retrieval.</footer>`,
  });
}
