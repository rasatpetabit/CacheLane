import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../index.js";
import type { CachelaneDb, InsertTurnParams } from "../types.js";

let tmpDir: string;
let db: CachelaneDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-measurement-"));
  db = openDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function turn(
  id: string,
  overrides: Partial<InsertTurnParams> = {},
): InsertTurnParams {
  return {
    id,
    workspace_id: "w",
    session_id: "s",
    turn_number: Number(id.replace(/\D/g, "")) || 1,
    model: "claude",
    provider: "anthropic",
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    effective_cost_units: 102,
    prefix_breakpoint_hash: "prefix",
    middle_breakpoint_hash: null,
    pruned_blocks_count: 0,
    keepalive_pings_since_last_turn: 0,
    signals: JSON.stringify(["prefix_cached"]),
    request_mutated: 1,
    created_at: Date.now(),
    ...overrides,
  };
}

describe("measurement dimensions", () => {
  it("keeps route independent from pipeline outcome", () => {
    db.insertTurn(turn("t1"));
    db.insertTurn(turn("t2", {
      signals: JSON.stringify(["mode:hook"]),
      request_mutated: 0,
    }));
    db.insertTurn(turn("t3", {
      signals: JSON.stringify(["error:fallback"]),
      request_mutated: 0,
    }));

    const stats = db.getStats({ scope: "all" });
    expect(stats.route_counts).toEqual({ proxy: 2, hook: 1, other: 0 });
    expect(stats.outcome_counts).toEqual({
      fail_open: 1,
      baseline: 0,
      mutated: 1,
      no_op: 1,
    });
  });

  it("treats usage presence as explicit provenance, not a zero-token heuristic", () => {
    db.insertTurn(turn("t1", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      effective_cost_units: 0,
      signals: JSON.stringify(["usage:recorded"]),
      request_mutated: 0,
    }));
    db.insertTurn(turn("t2", {
      input_tokens: 500,
      signals: JSON.stringify(["usage:missing"]),
      request_mutated: 0,
    }));
    db.insertTurn(turn("t3", {
      signals: JSON.stringify([]),
      request_mutated: 0,
    }));

    const stats = db.getStats({ scope: "all" });
    expect(stats.usage_counts).toEqual({ recorded: 1, missing: 1, unknown: 1 });
    expect(stats.usage_missing_rate).toBeCloseTo(1 / 3);
  });

  it("normalizes OpenAI prompt totals without double-counting cached tokens", () => {
    db.insertTurn(turn("t1", {
      model: "gpt-5.6",
      provider: "openai-chat",
      // OpenAI adapter stores prompt_tokens in input_tokens. cached_tokens is a subset.
      input_tokens: 1_000,
      cache_read_tokens: 400,
      effective_cost_units: 640,
      signals: JSON.stringify(["provider:openai-chat", "usage:recorded"]),
    }));

    const stats = db.getStats({ scope: "all" });
    expect(stats.logical_input_tokens).toBe(1_000);
    expect(stats.token_reuse_index).toBeCloseTo(0.4);
  });

  it("normalizes Anthropic input as uncached plus read plus writes", () => {
    db.insertTurn(turn("t1", {
      input_tokens: 600,
      cache_read_tokens: 200,
      cache_creation_5m_tokens: 100,
      effective_cost_units: 745,
      signals: JSON.stringify(["usage:recorded"]),
    }));

    const stats = db.getStats({ scope: "all" });
    expect(stats.logical_input_tokens).toBe(900);
    expect(stats.token_reuse_index).toBeCloseTo(200 / 900);
  });
});
