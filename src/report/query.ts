import path from "node:path";
import type {
  CachelaneDb,
  PipelineOutcome,
  SessionSummaryRow,
} from "../storage/index.js";
import type {
  ReportData,
  ReportOptions,
  ReportSource,
  ReportTurn,
} from "./types.js";

const LONG_SESSION_THRESHOLD_TURNS = 15;
const DETAIL_LIMIT = 500;

interface JoinedTurnRow {
  workspace_id: string;
  session_id: string;
  turn_number: number;
  created_at: number;
  model: string;
  input_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
  effective_cost_units: number;
  pruned_blocks_count: number;
  request_mutated: number;
  turn_signals: string | null;
  explanation_id: number | null;
  explanation_mutated: number | null;
  prune_decisions_json: string | null;
  region_metadata_json: string | null;
  explanation_signals_json: string | null;
}

interface LegacyExplanationRow {
  workspace_id: string;
  session_id: string;
  turn_number: number;
  created_at: number;
  model: string;
  mutated: number;
  pruned_blocks_count: number;
  prune_decisions_json: string;
  region_metadata_json: string;
  signals_json: string;
  usage_input_tokens: number;
  usage_cache_creation_5m_tokens: number;
  usage_cache_creation_1h_tokens: number;
  usage_cache_read_tokens: number;
  usage_effective_cost_units: number;
}

interface RegionMetadata {
  stable_count: number;
  semi_count: number;
  volatile_count: number;
}

interface PruneDecision {
  block_id: string;
  action: string;
  reason: string;
  kind: string;
}

interface ParsedSignals {
  valid: boolean;
  values: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseSignals(value: string | null): ParsedSignals {
  if (value === null) return { valid: false, values: [] };
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return { valid: false, values: [] };
  }
  return { valid: true, values: parsed };
}

function parseRegion(value: string | null): RegionMetadata {
  const parsed = parseJson(value);
  if (!isObject(parsed)) {
    return { stable_count: 0, semi_count: 0, volatile_count: 0 };
  }
  const values = [
    parsed.stable_count,
    parsed.semi_count,
    parsed.volatile_count,
  ];
  if (
    !values.every(
      (count) =>
        typeof count === "number" && Number.isFinite(count) && count >= 0,
    )
  ) {
    return { stable_count: 0, semi_count: 0, volatile_count: 0 };
  }
  return {
    stable_count: parsed.stable_count as number,
    semi_count: parsed.semi_count as number,
    volatile_count: parsed.volatile_count as number,
  };
}

function parsePruneDecisions(value: string | null): PruneDecision[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (decision): decision is PruneDecision =>
      isObject(decision) &&
      typeof decision.block_id === "string" &&
      typeof decision.action === "string" &&
      typeof decision.reason === "string" &&
      typeof decision.kind === "string",
  );
}

function pipelineOutcome(
  mutated: boolean,
  signals: readonly string[],
): PipelineOutcome {
  if (signals.includes("error:fallback")) return "fail_open";
  if (signals.includes("mode:baseline")) return "baseline";
  return mutated ? "mutated" : "no_op";
}

function ingestionMode(
  signals: readonly string[],
  signalsValid: boolean,
): ReportTurn["ingestion_mode"] {
  if (!signalsValid) return "unknown";
  return signals.includes("mode:hook") ? "hook" : "proxy";
}

function scopedWhere(
  opts: ReportOptions,
  alias: "t" | "e",
  includeSince = true,
): { sql: string; bindings: Record<string, string | number> } {
  const clauses: string[] = [];
  const bindings: Record<string, string | number> = {};

  if (opts.scope === "session") {
    clauses.push(`${alias}.workspace_id = @workspace_id`);
    clauses.push(`${alias}.session_id = @session_id`);
    bindings.workspace_id = opts.workspace_id;
    bindings.session_id = opts.session_id;
  } else if (opts.scope === "workspace") {
    clauses.push(`${alias}.workspace_id = @workspace_id`);
    bindings.workspace_id = opts.workspace_id;
  }
  if (includeSince && opts.since_ms !== undefined) {
    clauses.push(`${alias}.created_at >= @since_ms`);
    bindings.since_ms = opts.since_ms;
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    bindings,
  };
}

function joinedSelect(fromSql: string): string {
  return `
    SELECT
      t.workspace_id,
      t.session_id,
      t.turn_number,
      t.created_at,
      t.model,
      t.input_tokens,
      t.cache_creation_5m_tokens,
      t.cache_creation_1h_tokens,
      t.cache_read_tokens,
      t.effective_cost_units,
      t.pruned_blocks_count,
      t.request_mutated,
      t.signals AS turn_signals,
      e.id AS explanation_id,
      e.mutated AS explanation_mutated,
      e.prune_decisions_json,
      e.region_metadata_json,
      e.signals_json AS explanation_signals_json
    ${fromSql}
    LEFT JOIN turn_explanations e
      ON e.turn_id = t.id
     AND e.workspace_id = t.workspace_id
     AND e.session_id = t.session_id
     AND e.turn_number = t.turn_number
  `;
}

function readCompletedTurns(
  db: CachelaneDb,
  opts: ReportOptions,
): JoinedTurnRow[] {
  const where = scopedWhere(opts, "t");
  return db.prepare(`
    WITH selected_turns AS (
      SELECT t.*
      FROM turns t
      ${where.sql}
      ORDER BY t.created_at DESC, t.turn_number DESC, t.id DESC
      LIMIT @detail_limit
    )
    ${joinedSelect("FROM selected_turns t")}
    ORDER BY t.created_at ASC, t.workspace_id ASC, t.session_id ASC, t.turn_number ASC
  `).all({
    ...where.bindings,
    detail_limit: DETAIL_LIMIT,
  }) as JoinedTurnRow[];
}

function readLegacyTurns(
  db: CachelaneDb,
  opts: ReportOptions,
): LegacyExplanationRow[] {
  // This deliberately preserves the public pre-canonical behavior: explanation
  // rows only, always workspace-filtered (including legacy scope=all), newest
  // 500, then stable-sorted by turn number.
  const where = opts.scope === "session"
    ? {
        sql: "WHERE e.workspace_id = @workspace_id AND e.session_id = @session_id",
        bindings: {
          workspace_id: opts.workspace_id,
          session_id: opts.session_id,
        },
      }
    : {
        sql: "WHERE e.workspace_id = @workspace_id",
        bindings: { workspace_id: opts.workspace_id },
      };
  const rows = db.prepare(`
    SELECT e.*
    FROM turn_explanations e
    ${where.sql}
    ORDER BY e.created_at DESC, e.turn_number DESC, e.id DESC
    LIMIT @detail_limit
  `).all({
    ...where.bindings,
    detail_limit: DETAIL_LIMIT,
  }) as LegacyExplanationRow[];
  return rows.sort((a, b) => a.turn_number - b.turn_number);
}

function readCoverage(
  db: CachelaneDb,
  opts: ReportOptions,
): { explained_turns: number; ignored_orphan_explanations: number } {
  const turnWhere = scopedWhere(opts, "t");
  const coverage = db.prepare(`
    SELECT COUNT(e.id) AS explained_turns
    FROM turns t
    LEFT JOIN turn_explanations e
      ON e.turn_id = t.id
     AND e.workspace_id = t.workspace_id
     AND e.session_id = t.session_id
     AND e.turn_number = t.turn_number
    ${turnWhere.sql}
  `).get(turnWhere.bindings) as { explained_turns: number };

  const explanationWhere = scopedWhere(opts, "e");
  const orphanPredicate = `${explanationWhere.sql}${
    explanationWhere.sql ? " AND" : " WHERE"
  } t.id IS NULL`;
  const orphans = db.prepare(`
    SELECT COUNT(*) AS ignored_orphan_explanations
    FROM turn_explanations e
    LEFT JOIN turns t
      ON e.turn_id = t.id
     AND e.workspace_id = t.workspace_id
     AND e.session_id = t.session_id
     AND e.turn_number = t.turn_number
    ${orphanPredicate}
  `).get(explanationWhere.bindings) as {
    ignored_orphan_explanations: number;
  };

  return {
    explained_turns: coverage.explained_turns,
    ignored_orphan_explanations: orphans.ignored_orphan_explanations,
  };
}

function readScopedSessions(
  db: CachelaneDb,
  opts: ReportOptions,
): SessionSummaryRow[] {
  const where = scopedWhere(opts, "t");
  const rows = db.prepare(`
    SELECT
      t.workspace_id,
      t.session_id,
      COUNT(*) AS turns,
      COALESCE(SUM(t.cache_read_tokens), 0) AS cache_read,
      COALESCE(SUM(
        t.input_tokens +
        t.cache_creation_5m_tokens +
        t.cache_creation_1h_tokens +
        t.cache_read_tokens
      ), 0) AS baseline,
      COALESCE(SUM(t.effective_cost_units), 0) AS effective,
      MAX(t.created_at) AS last_active_ms
    FROM turns t
    ${where.sql}
    GROUP BY t.workspace_id, t.session_id
    ORDER BY last_active_ms DESC
  `).all(where.bindings) as Array<{
    workspace_id: string;
    session_id: string;
    turns: number;
    cache_read: number;
    baseline: number;
    effective: number;
    last_active_ms: number;
  }>;
  return rows.map((row) => ({
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    turns: row.turns,
    cache_hit_ratio:
      row.baseline === 0 ? 0 : row.cache_read / row.baseline,
    savings_ratio:
      row.baseline === 0
        ? 0
        : (row.baseline - row.effective) / row.baseline,
    last_active_ms: row.last_active_ms,
  }));
}

function reportCompletedTurn(row: JoinedTurnRow): ReportTurn {
  const turnSignals = parseSignals(row.turn_signals);
  const explanationSignals = parseSignals(row.explanation_signals_json);
  const selectedSignals = turnSignals.valid ? turnSignals : explanationSignals;
  const region = parseRegion(row.region_metadata_json);
  const pruneDecisions = parsePruneDecisions(row.prune_decisions_json);
  const cacheCreation =
    row.cache_creation_5m_tokens + row.cache_creation_1h_tokens;
  const mutated = row.explanation_mutated === null
    ? row.request_mutated === 1
    : row.explanation_mutated === 1;

  return {
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    turn_number: row.turn_number,
    created_at: row.created_at,
    model: row.model,
    mutated,
    input_tokens: row.input_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: cacheCreation,
    effective_cost_units: row.effective_cost_units,
    baseline_cost_units: row.input_tokens + row.cache_read_tokens,
    recorded_baseline_cost_units:
      row.input_tokens + cacheCreation + row.cache_read_tokens,
    outcome: pipelineOutcome(
      row.request_mutated === 1,
      selectedSignals.values,
    ),
    explanation_available: row.explanation_id !== null,
    ingestion_mode: ingestionMode(
      selectedSignals.values,
      selectedSignals.valid,
    ),
    stable_count: region.stable_count,
    semi_count: region.semi_count,
    volatile_count: region.volatile_count,
    pruned_blocks_count: row.pruned_blocks_count,
    prune_decisions: pruneDecisions,
    signals: selectedSignals.values,
  };
}

function reportLegacyTurn(row: LegacyExplanationRow): ReportTurn {
  const signals = parseSignals(row.signals_json);
  const region = parseRegion(row.region_metadata_json);
  const cacheCreation =
    row.usage_cache_creation_5m_tokens +
    row.usage_cache_creation_1h_tokens;
  const mutated = row.mutated === 1;
  return {
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    turn_number: row.turn_number,
    created_at: row.created_at,
    model: row.model,
    mutated,
    input_tokens: row.usage_input_tokens,
    cache_read_tokens: row.usage_cache_read_tokens,
    cache_creation_tokens: cacheCreation,
    effective_cost_units: row.usage_effective_cost_units,
    baseline_cost_units:
      row.usage_input_tokens + row.usage_cache_read_tokens,
    recorded_baseline_cost_units:
      row.usage_input_tokens + cacheCreation + row.usage_cache_read_tokens,
    outcome: pipelineOutcome(mutated, signals.values),
    explanation_available: true,
    ingestion_mode: ingestionMode(signals.values, signals.valid),
    stable_count: region.stable_count,
    semi_count: region.semi_count,
    volatile_count: region.volatile_count,
    pruned_blocks_count: row.pruned_blocks_count,
    prune_decisions: parsePruneDecisions(row.prune_decisions_json),
    signals: signals.values,
  };
}

function inferSource(db: CachelaneDb): ReportSource {
  const databases = db.prepare("PRAGMA database_list").all() as Array<{
    name: string;
    file: string;
  }>;
  const main = databases.find((entry) => entry.name === "main");
  const dbPath = main?.file ? path.resolve(main.file) : ":memory:";
  return {
    cachelane_home: dbPath === ":memory:" ? "" : path.dirname(dbPath),
    db_path: dbPath,
    proxy: null,
  };
}

export function buildReportData(db: CachelaneDb, opts: ReportOptions): ReportData {
  const readSnapshot = db.transaction((): ReportData => {
    const stats = db.getStats({
      scope: opts.scope,
      workspace_id: opts.scope === "all" ? undefined : opts.workspace_id,
      session_id: opts.scope === "session" ? opts.session_id : undefined,
      since_ms: opts.since_ms,
    });
    const completedTurns = readCompletedTurns(db, opts).map(reportCompletedTurn);
    const legacyTurns = readLegacyTurns(db, opts).map(reportLegacyTurn);
    const coverage = readCoverage(db, opts);
    const legacySessions = db.listSessions(
      opts.scope === "all" ? undefined : opts.workspace_id,
    );
    const scopedSessions = readScopedSessions(db, opts);

    return {
      generated_at: opts.generated_at,
      scope: opts.scope,
      workspace_id: opts.scope === "all" ? null : opts.workspace_id,
      session_id: opts.scope === "session" ? opts.session_id : null,
      long_session_threshold_turns: LONG_SESSION_THRESHOLD_TURNS,
      source: opts.source ?? inferSource(db),
      explanation_coverage: {
        recorded_turns: stats.turns,
        explained_turns: coverage.explained_turns,
        missing_explanations: Math.max(
          stats.turns - coverage.explained_turns,
          0,
        ),
        ignored_orphan_explanations: coverage.ignored_orphan_explanations,
        displayed_turns: completedTurns.length,
        display_limit: DETAIL_LIMIT,
        truncated: completedTurns.length < stats.turns,
      },
      stats,
      turns: legacyTurns,
      completed_turns: completedTurns,
      sessions: legacySessions,
      scoped_sessions: scopedSessions,
      privacy: { content_persisted: false },
    };
  });

  return readSnapshot();
}
