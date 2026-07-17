import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type CachelaneDb } from "../../storage/index.js";
import { buildReportData } from "../query.js";
import type { ReportOptions } from "../types.js";

let dir: string;
let db: CachelaneDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cl-report-"));
  db = openDatabase(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const defaultOptions: ReportOptions = {
  scope: "workspace",
  workspace_id: "ws",
  session_id: "s1",
  generated_at: "2026-06-16T00:00:00Z",
  source: {
    cachelane_home: "/home/ras/.cachelane-smoke",
    db_path: "/home/ras/.cachelane-smoke/cachelane.db",
    proxy: null,
  },
};

interface SeedTurnOptions {
  turn_number: number;
  workspace_id?: string;
  session_id?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_5m_tokens?: number;
  request_mutated?: number;
  signals?: string[];
  explanation?: boolean;
  created_at?: number;
}

function seedTurn(options: SeedTurnOptions): string {
  const workspaceId = options.workspace_id ?? "ws";
  const sessionId = options.session_id ?? "s1";
  const turnId = `${workspaceId}-${sessionId}-${options.turn_number}`;
  const input = options.input_tokens ?? 100;
  const cacheRead = options.cache_read_tokens ?? 0;
  const cacheCreation5m = options.cache_creation_5m_tokens ?? 0;
  const signals = options.signals ?? ["prefix_cached"];
  const createdAt = options.created_at ?? 1000 + options.turn_number;
  db.insertTurn({
    id: turnId,
    workspace_id: workspaceId,
    session_id: sessionId,
    turn_number: options.turn_number,
    model: "claude-opus-4-7",
    provider: "anthropic",
    input_tokens: input,
    output_tokens: 10,
    cache_creation_5m_tokens: cacheCreation5m,
    cache_creation_1h_tokens: 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheCreation5m,
    effective_cost_units: input + 1.25 * cacheCreation5m + 0.1 * cacheRead,
    prefix_breakpoint_hash: "abc",
    middle_breakpoint_hash: null,
    pruned_blocks_count: 0,
    keepalive_pings_since_last_turn: 0,
    request_mutated: options.request_mutated ?? 1,
    signals: JSON.stringify(signals),
    created_at: createdAt,
  });
  if (options.explanation !== false) {
    seedExplanation({
      turn_id: turnId,
      workspace_id: workspaceId,
      session_id: sessionId,
      turn_number: options.turn_number,
      signals,
      created_at: createdAt,
    });
  }
  return turnId;
}

function seedExplanation(options: {
  turn_id: string;
  workspace_id: string;
  session_id: string;
  turn_number: number;
  signals?: string[];
  created_at?: number;
}): void {
  const createdAt = options.created_at ?? 1000 + options.turn_number;
  db.insertTurnExplanation({
    turn_id: options.turn_id,
    workspace_id: options.workspace_id,
    session_id: options.session_id,
    turn_number: options.turn_number,
    model: "claude-opus-4-7",
    prefix_breakpoint_hash: "abc",
    middle_breakpoint_hash: null,
    mutated: true,
    pruned_blocks_count: 0,
    prune_decisions: [],
    block_metadata: [],
    region_metadata: {
      message_count: 3,
      stable_count: 1,
      semi_count: 1,
      volatile_count: 1,
    },
    signals: options.signals ?? ["prefix_cached"],
    created_at: createdAt,
    updated_at: createdAt,
  });
}

describe("buildReportData", () => {
  it("uses canonical turn usage and includes cache creation in the baseline", () => {
    seedTurn({ turn_number: 1, input_tokens: 100 });
    seedTurn({
      turn_number: 2,
      input_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_5m_tokens: 10,
    });
    const data = buildReportData(db, defaultOptions);
    expect(data.completed_turns).toHaveLength(2);
    expect(data.completed_turns![1]!.baseline_cost_units).toBe(100);
    expect(data.completed_turns![1]!.recorded_baseline_cost_units).toBe(110);
    expect(data.completed_turns![1]!.effective_cost_units).toBeCloseTo(40.5, 5);
    expect(data.privacy.content_persisted).toBe(false);
    expect(data.long_session_threshold_turns).toBe(15);
  });

  it("keeps completed turns, ignores orphan explanations, and reports coverage", () => {
    seedTurn({ turn_number: 1 });
    seedTurn({ turn_number: 2, explanation: false });
    seedExplanation({
      turn_id: "orphan-turn",
      workspace_id: "ws",
      session_id: "s1",
      turn_number: 99,
    });

    const data = buildReportData(db, defaultOptions);
    expect(data.stats.turns).toBe(2);
    expect(data.completed_turns!.map((turn) => turn.turn_number)).toEqual([1, 2]);
    expect(data.completed_turns![1]!.explanation_available).toBe(false);
    expect(data.explanation_coverage).toEqual({
      recorded_turns: 2,
      explained_turns: 1,
      missing_explanations: 1,
      ignored_orphan_explanations: 1,
      displayed_turns: 2,
      display_limit: 500,
      truncated: false,
    });
  });

  it("applies all scope to every workspace without merging session identities", () => {
    seedTurn({ turn_number: 1, workspace_id: "ws-a", session_id: "same", created_at: 1001 });
    seedTurn({ turn_number: 1, workspace_id: "ws-b", session_id: "same", created_at: 1002 });

    const data = buildReportData(db, {
      ...defaultOptions,
      scope: "all",
    });
    expect(data.stats.turns).toBe(2);
    expect(data.completed_turns!.map((turn) => `${turn.workspace_id}/${turn.session_id}`)).toEqual([
      "ws-a/same",
      "ws-b/same",
    ]);
    expect(data.workspace_id).toBeNull();
  });

  it("derives distinct intentional and failure outcomes", () => {
    seedTurn({ turn_number: 1, request_mutated: 1, signals: ["prefix_cached"] });
    seedTurn({ turn_number: 2, request_mutated: 0, signals: ["mode:baseline"] });
    seedTurn({ turn_number: 3, request_mutated: 0, signals: ["prefix_cached"] });
    seedTurn({ turn_number: 4, request_mutated: 0, signals: ["error:fallback"] });

    const data = buildReportData(db, defaultOptions);
    expect(data.completed_turns!.map((turn) => turn.outcome)).toEqual([
      "mutated",
      "baseline",
      "no_op",
      "fail_open",
    ]);
  });

  it("preserves explanation mutated metadata while matching canonical stats outcomes", () => {
    seedTurn({
      turn_number: 1,
      request_mutated: 0,
      signals: ["prefix_cached"],
    });

    const data = buildReportData(db, defaultOptions);
    expect(data.completed_turns![0]).toMatchObject({
      mutated: true,
      outcome: "no_op",
    });
    expect(data.stats.outcome_counts).toEqual({
      fail_open: 0,
      baseline: 0,
      mutated: 0,
      no_op: 1,
    });
  });

  it("caps multi-session details explicitly while preserving the recorded total", () => {
    const insert = db.prepare(`
      INSERT INTO turns (
        id, workspace_id, session_id, turn_number, model, provider,
        input_tokens, output_tokens, cache_creation_5m_tokens,
        cache_creation_1h_tokens, cache_read_tokens, cache_write_tokens,
        effective_cost_units, pruned_blocks_count,
        keepalive_pings_since_last_turn, signals, request_mutated, created_at
      ) VALUES (?, 'ws', ?, 1, 'm', 'anthropic', 1, 0, 0, 0, 0, 0, 1, 0, 0, '[]', 0, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 501; index++) {
        insert.run(`bulk-${index}`, `session-${index}`, 10_000 + index);
      }
    })();

    const data = buildReportData(db, defaultOptions);
    expect(data.stats.turns).toBe(501);
    expect(data.completed_turns).toHaveLength(500);
    expect(data.explanation_coverage!.displayed_turns).toBe(500);
    expect(data.explanation_coverage!.truncated).toBe(true);
  });

  it("empty DB yields valid no-data report", () => {
    const data = buildReportData(db, defaultOptions);
    expect(data.turns).toEqual([]);
    expect(data.completed_turns).toEqual([]);
    expect(data.stats.turns).toBe(0);
  });
});
