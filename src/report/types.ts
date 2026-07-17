import type {
  CachelaneStats,
  PipelineOutcome,
  SessionSummaryRow,
} from "../storage/index.js";

export interface ReportSource {
  cachelane_home: string;
  db_path: string;
  proxy: {
    host: string;
    port: number;
    upstream_host: string;
    upstream_port: number;
    upstream_ssl: boolean;
  } | null;
}

export interface ExplanationCoverage {
  recorded_turns: number;
  explained_turns: number;
  missing_explanations: number;
  ignored_orphan_explanations: number;
  displayed_turns: number;
  display_limit: number | null;
  truncated: boolean;
}

export interface ReportTurn {
  workspace_id?: string;
  session_id?: string;
  turn_number: number;
  created_at?: number;
  model: string;
  mutated: boolean;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  effective_cost_units: number;
  /** Legacy baseline: input + cache read. */
  baseline_cost_units: number;
  /** Recorded baseline: input + cache creation + cache read. */
  recorded_baseline_cost_units?: number;
  outcome?: PipelineOutcome;
  explanation_available?: boolean;
  ingestion_mode?: "hook" | "proxy" | "unknown";
  stable_count: number;
  semi_count: number;
  volatile_count: number;
  pruned_blocks_count: number;
  prune_decisions: { block_id: string; action: string; reason: string; kind: string }[];
  signals: string[];
}

export interface ReportData {
  generated_at: string;
  scope: "session" | "workspace" | "all";
  workspace_id: string | null;
  session_id: string | null;
  long_session_threshold_turns: number; // 15 (roadmap §T4)
  source?: ReportSource;
  explanation_coverage?: ExplanationCoverage;
  stats: CachelaneStats;
  /** Legacy explanation-backed detail rows. */
  turns: ReportTurn[];
  /** Canonical completed-turn detail rows, capped to the newest display window. */
  completed_turns?: ReportTurn[];
  /** Legacy session summaries. */
  sessions: SessionSummaryRow[];
  /** Scope- and since-aware canonical session summaries. */
  scoped_sessions?: SessionSummaryRow[];
  privacy: { content_persisted: false };
}

export interface ReportOptions {
  scope: "session" | "workspace" | "all";
  workspace_id: string;
  session_id: string;
  since_ms?: number;
  generated_at: string;
  source?: ReportSource;
}
