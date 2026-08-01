import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../index.js";
import type { CachelaneDb } from "../index.js";

let tmpDir: string;
let db: CachelaneDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-test-db-"));
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("opens in WAL journal mode", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const rows = db.pragma("journal_mode") as { journal_mode: string }[];
    expect(rows[0]?.journal_mode).toBe("wal");
  });

  it("applies schema — blocks, turns, block_references tables exist", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("blocks");
    expect(names).toContain("turns");
    expect(names).toContain("block_references");
  });

  it("applies restored_at_turn migration to blocks", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const columns = db.prepare("PRAGMA table_info(blocks)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toContain("restored_at_turn");
  });

  it("applies turn_explanations migration", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toContain("turn_explanations");
  });

  it("applies turn_counters migration", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toContain("turn_counters");
  });

  it("applies all six spec indexes by exact name", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_blocks_session");
    expect(names).toContain("idx_blocks_hash");
    expect(names).toContain("idx_blocks_unused");
    expect(names).toContain("idx_turns_session_num");
    expect(names).toContain("idx_refs_block");
    expect(names).toContain("idx_refs_turn");
  });

  it("passes integrity_check on fresh DB", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const result = db.pragma("integrity_check") as { integrity_check: string }[];
    expect(result[0]?.integrity_check).toBe("ok");
  });

  it("renames corrupt file and creates fresh DB", () => {
    const dbPath = path.join(tmpDir, "corrupt.db");
    fs.writeFileSync(dbPath, "this is not a valid sqlite database");

    db = openDatabase(dbPath);

    const files = fs.readdirSync(tmpDir);
    const renamed = files.find((f) => f.startsWith("corrupt.db.corrupt-"));
    expect(renamed).toBeTruthy();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("blocks");
  });

  it("propagates errors that are not file corruption (does not silently rename healthy DB)", () => {
    // Patch Database.prototype.pragma to throw a non-corruption error once
    const original = Database.prototype.pragma;
    let callCount = 0;
    Database.prototype.pragma = function (this: Database.Database, pragma: string) {
      // Let journal_mode and foreign_keys pass; throw on the corruption check.
      // Defaults to quick_check (see openDatabase); integrity_check is retained
      // here so the assertion holds under CACHELANE_FULL_INTEGRITY_CHECK too.
      if ((pragma === "quick_check" || pragma === "integrity_check") && callCount++ === 0) {
        throw new Error("SQLITE_ERROR: table 'blocks' already exists");
      }
      return original.call(this, pragma);
    };

    const dbPath = path.join(tmpDir, "healthy.db");

    try {
      // Should throw — NOT silently rename and recreate
      expect(() => openDatabase(dbPath)).toThrow(/table.*already exists/i);
      // Confirm it was never created as a valid DB (no rename happened)
      expect(fs.existsSync(`${dbPath}.corrupt-${Date.now()}`)).toBe(false);
    } finally {
      Database.prototype.pragma = original;
    }
  });

  it("insertBlock + getBlock round-trip", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01HZXQ5K0000000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "a".repeat(64),
      kind: "file_read",
      volatility: "SEMI",
      is_pinned: false,
      token_count: 500,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    const block = db.getBlock("01HZXQ5K0000000000000001");
    expect(block).not.toBeNull();
    expect(block!.kind).toBe("file_read");
    expect(block!.volatility).toBe("SEMI");
    expect(block!.token_count).toBe(500);
    expect(block!.is_pinned).toBe(0);
    expect(block!.is_stub).toBe(0);
    expect(block!.added_at_turn).toBe(1);
    expect(block!.stub_summary).toBeNull();
    expect(block!.restored_at_turn).toBeNull();
  });

  it("incrementUnusedTurns increments counter and updates updated_at", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01HZXQ5K0000000000000002",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "b".repeat(64),
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 200,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.incrementUnusedTurns("01HZXQ5K0000000000000002", now + 1000);

    const block = db.getBlock("01HZXQ5K0000000000000002");
    expect(block!.unused_turns).toBe(1);
    expect(block!.updated_at).toBe(now + 1000);
  });

  it("insertTurn + getTurn round-trip with effective_cost_units", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    // Formula: input_tokens + 1.25*cache_creation_5m + 2.0*cache_creation_1h + 0.1*cache_read
    // = 200 + 1.25*1000 + 2.0*0 + 0.1*500 = 1500
    db.insertTurn({
      id: "01HZXQ5K0000000000000010",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 1,
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 200,
      output_tokens: 80,
      cache_creation_5m_tokens: 1000,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 500,
      cache_write_tokens: 1000,
      effective_cost_units: 1500,
      prefix_breakpoint_hash: "c".repeat(64),
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      created_at: now,
    });

    const turn = db.getTurn("01HZXQ5K0000000000000010");
    expect(turn).not.toBeNull();
    expect(turn!.turn_number).toBe(1);
    expect(turn!.model).toBe("claude-opus-4-7");
    expect(turn!.provider).toBe("anthropic");
    expect(turn!.cache_write_tokens).toBe(1000);
    expect(turn!.cache_creation_5m_tokens).toBe(1000);
    expect(turn!.cache_creation_1h_tokens).toBe(0);
    expect(turn!.cache_read_tokens).toBe(500);
    expect(turn!.output_tokens).toBe(80);
    expect(turn!.effective_cost_units).toBeCloseTo(1500, 5);
  });

  it("allocateTurnNumber returns monotonic numbers scoped by workspace and session", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));

    expect(db.allocateTurnNumber({ workspace_id: "ws-1", session_id: "sess-1" })).toBe(1);
    expect(db.allocateTurnNumber({ workspace_id: "ws-1", session_id: "sess-1" })).toBe(2);
    expect(db.allocateTurnNumber({ workspace_id: "ws-1", session_id: "sess-2" })).toBe(1);
    expect(db.allocateTurnNumber({ workspace_id: "ws-2", session_id: "sess-1" })).toBe(1);
  });

  it("allocateTurnNumber seeds from existing turns when a counter is absent", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertTurn({
      id: "turn-existing-3",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 3,
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      effective_cost_units: 100,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      created_at: now,
    });

    expect(db.allocateTurnNumber({ workspace_id: "ws-1", session_id: "sess-1" })).toBe(4);
    expect(db.allocateTurnNumber({ workspace_id: "ws-1", session_id: "sess-1" })).toBe(5);
  });

  // Regression: `turns` uses INSERT OR IGNORE (first writer wins) while the
  // explanation upsert reassigned turn_id (last writer wins). On a tuple
  // collision the two disagreed, orphaning the explanation with no error.
  it("keeps the first writer's turn_id when two writes collide on the same tuple", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const explanation = (turnId: string) => ({
      turn_id: turnId,
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 7,
      model: "claude-opus-4-7",
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      mutated: true,
      pruned_blocks_count: 0,
      prune_decisions: [],
      block_metadata: [],
      region_metadata: { message_count: 1, stable_count: 0, semi_count: 0, volatile_count: 1 },
      signals: ["prefix_cached"],
      created_at: now,
      updated_at: now,
    });

    db.insertTurnExplanation(explanation("turn-first"));
    db.insertTurnExplanation(explanation("turn-second"));

    const stored = db.getTurnExplanation({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 7,
    });
    // `turns` would have kept "turn-first" via INSERT OR IGNORE, so the
    // explanation must not drift to "turn-second" or it is orphaned.
    expect(stored?.turn_id).toBe("turn-first");
  });

  it("insertTurnExplanation round-trips metadata without content fields", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertTurnExplanation({
      turn_id: "turn-explain-1",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 3,
      model: "claude-opus-4-7",
      prefix_breakpoint_hash: "a".repeat(64),
      middle_breakpoint_hash: null,
      mutated: true,
      pruned_blocks_count: 1,
      prune_decisions: [
        {
          block_id: "01EXPLAIN0000000000001",
          action: "stubbed",
          reason: "unused_turns >= 3",
          kind: "tool_output",
          stub_summary: "tool_output tool:read:src/auth.ts (100 tokens elided)",
          has_refetch_handle: true,
        },
      ],
      block_metadata: [
        {
          block_id: "01EXPLAIN0000000000001",
          message_index: 0,
          content_index: 0,
          kind: "tool_output",
          volatility: "VOLATILE",
          is_pinned: false,
          has_refetch_handle: true,
          token_count: 100,
        },
      ],
      region_metadata: {
        message_count: 2,
        stable_count: 0,
        semi_count: 1,
        volatile_count: 1,
      },
      signals: ["prefix_cached"],
      created_at: now,
      updated_at: now,
    });

    const explanation = db.getTurnExplanation({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 3,
    });
    expect(explanation).toMatchObject({
      turn_id: "turn-explain-1",
      pruned_blocks_count: 1,
      mutated: true,
      usage: { input_tokens: 0, cache_read_tokens: 0 },
    });

    const raw = db
      .prepare("SELECT * FROM turn_explanations WHERE turn_id = ?")
      .get("turn-explain-1") as Record<string, unknown>;
    expect(Object.keys(raw).some((key) => /content|prompt|assistant/i.test(key))).toBe(false);
  });

  it("getStats aggregates scoped cost, cache reads, pruning, and keepalive", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const baseTurn = {
      model: "claude-opus-4-7",
      provider: "anthropic",
      output_tokens: 0,
      cache_write_tokens: 0,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      created_at: now,
    };

    db.insertTurn({
      ...baseTurn,
      id: "turn-stats-1",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 1,
      input_tokens: 100,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 900,
      effective_cost_units: 190,
      pruned_blocks_count: 2,
      keepalive_pings_since_last_turn: 1,
    });
    db.insertTurn({
      ...baseTurn,
      id: "turn-stats-2",
      workspace_id: "ws-1",
      session_id: "sess-2",
      turn_number: 1,
      input_tokens: 200,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      effective_cost_units: 200,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
    });

    const stats = db.getStats({
      scope: "session",
      workspace_id: "ws-1",
      session_id: "sess-1",
    });

    expect(stats).toMatchObject({
      turns: 1,
      cache_hit_ratio: 0.9,
      effective_cost_units: 190,
      baseline_cost_units: 1000,
      pruner_counts: { pruned_blocks: 2, turns_with_pruning: 1 },
      keepalive_counts: { pings: 1, turns_with_keepalive: 1 },
    });
  });

  it("getStats reports mutually exclusive pipeline outcomes", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const baseTurn = {
      workspace_id: "ws-outcomes",
      session_id: "sess-outcomes",
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      effective_cost_units: 100,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      created_at: now,
    };

    db.insertTurn({
      ...baseTurn,
      id: "turn-outcome-mutated",
      turn_number: 1,
      request_mutated: 1,
      signals: JSON.stringify(["prefix_cached"]),
    });
    db.insertTurn({
      ...baseTurn,
      id: "turn-outcome-no-op",
      turn_number: 2,
      request_mutated: 0,
      signals: JSON.stringify(["prefix_cached"]),
    });
    db.insertTurn({
      ...baseTurn,
      id: "turn-outcome-baseline",
      turn_number: 3,
      request_mutated: 0,
      signals: JSON.stringify(["mode:baseline"]),
    });
    db.insertTurn({
      ...baseTurn,
      id: "turn-outcome-fail-open",
      turn_number: 4,
      request_mutated: 0,
      signals: JSON.stringify(["error:fallback"]),
    });

    const stats = db.getStats({
      scope: "session",
      workspace_id: "ws-outcomes",
      session_id: "sess-outcomes",
    });

    expect(stats.outcome_counts).toEqual({
      fail_open: 1,
      baseline: 1,
      mutated: 1,
      no_op: 1,
    });
    expect(
      Object.values(stats.outcome_counts!).reduce((total, count) => total + count, 0),
    ).toBe(stats.turns);
    expect(stats.pipeline_fallback_turns).toBe(3);
    expect(stats.fail_open_turns).toBe(1);
  });

  it("getStats gives fail-open and baseline signals precedence over mutation", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const baseTurn = {
      workspace_id: "ws-precedence",
      session_id: "sess-precedence",
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      effective_cost_units: 100,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      request_mutated: 1,
      created_at: now,
    };

    db.insertTurn({
      ...baseTurn,
      id: "turn-precedence-fail-open",
      turn_number: 1,
      signals: JSON.stringify(["mode:baseline", "error:fallback"]),
    });
    db.insertTurn({
      ...baseTurn,
      id: "turn-precedence-baseline",
      turn_number: 2,
      signals: JSON.stringify(["mode:baseline"]),
    });

    const stats = db.getStats({
      scope: "session",
      workspace_id: "ws-precedence",
      session_id: "sess-precedence",
    });

    expect(stats.outcome_counts).toEqual({
      fail_open: 1,
      baseline: 1,
      mutated: 0,
      no_op: 0,
    });
    expect(stats.pipeline_fallback_turns).toBe(0);
    expect(stats.fail_open_turns).toBe(1);
  });

  it("markStub sets is_stub=1, refetch_handle and stub_summary", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01HZXQ5K0000000000000003",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "d".repeat(64),
      kind: "file_read",
      volatility: "SEMI",
      is_pinned: false,
      token_count: 800,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 3,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.markStub(
      "01HZXQ5K0000000000000003",
      "view:auth.py:1-50",
      "Read auth.py:1-50 (800 tokens elided)",
      10,
      now + 2000
    );

    const block = db.getBlock("01HZXQ5K0000000000000003");
    expect(block!.is_stub).toBe(1);
    expect(block!.refetch_handle).toBe("view:auth.py:1-50");
    expect(block!.stub_summary).toContain("auth.py");
    expect(block!.restored_at_turn).toBeNull();
    expect(block!.updated_at).toBe(now + 2000);
  });

  it("markStubs atomically marks multiple blocks as stubs in one transaction", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const NOW = Date.now();
    const ws = "ws-stubs";
    const sess = "sess-stubs";
    for (const id of ["BS1", "BS2", "BS3"]) {
      db.insertBlock({
        id,
        workspace_id: ws,
        session_id: sess,
        content_hash: id.padEnd(64, "0"),
        kind: "file_read",
        volatility: "SEMI",
        is_pinned: false,
        token_count: 50,
        added_at_turn: 1,
        last_referenced_at_turn: 1,
        unused_turns: 5,
        is_stub: false,
        stub_summary: null,
        refetch_handle: `view:${id}.ts:1-10`,
        restored_at_turn: null,
        created_at: NOW,
        updated_at: NOW,
      });
    }

    db.markStubs([
      { id: "BS1", workspace_id: ws, session_id: sess, refetchHandle: "view:BS1.ts:1-10", stubSummary: "BS1 stub", tokenCount: 10, updatedAt: NOW + 1 },
      { id: "BS2", workspace_id: ws, session_id: sess, refetchHandle: "view:BS2.ts:1-10", stubSummary: "BS2 stub", tokenCount: 10, updatedAt: NOW + 1 },
      { id: "BS3", workspace_id: ws, session_id: sess, refetchHandle: "view:BS3.ts:1-10", stubSummary: "BS3 stub", tokenCount: 10, updatedAt: NOW + 1 },
    ]);

    for (const id of ["BS1", "BS2", "BS3"]) {
      const row = db.getBlock(id)!;
      expect(row.is_stub).toBe(1);
      expect(row.stub_summary).toBe(`${id} stub`);
      expect(row.refetch_handle).toBe(`view:${id}.ts:1-10`);
      expect(row.updated_at).toBe(NOW + 1);
    }
  });

  it("markStubs with empty array is a no-op", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    db.markStubs([]);
    // no throw, no DB change
  });

  it("restoreStub resets counters and records the restore turn", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01RESTORE00000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "r".repeat(64),
      kind: "file_read",
      volatility: "SEMI",
      is_pinned: false,
      token_count: 800,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 3,
      is_stub: true,
      stub_summary: "Read auth.py:1-50 (800 tokens elided)",
      refetch_handle: "view:auth.py:1-50",
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.restoreStub({
      workspace_id: "ws-1",
      session_id: "sess-1",
      block_id: "01RESTORE00000000000001",
      turn_number: 7,
      updated_at: now + 3000,
    });

    const block = db.getBlock("01RESTORE00000000000001");
    expect(block!.is_stub).toBe(0);
    expect(block!.unused_turns).toBe(0);
    expect(block!.last_referenced_at_turn).toBe(7);
    expect(block!.restored_at_turn).toBe(7);
    expect(block!.updated_at).toBe(now + 3000);
  });

  it("resetUnusedTurns sets counter to 0 and updates last_referenced_at_turn and updated_at", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01HZXQ5K0000000000000020",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "f".repeat(64),
      kind: "file_read",
      volatility: "SEMI",
      is_pinned: false,
      token_count: 300,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 2,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.resetUnusedTurns("01HZXQ5K0000000000000020", 5, now + 1000);

    const block = db.getBlock("01HZXQ5K0000000000000020");
    expect(block!.unused_turns).toBe(0);
    expect(block!.last_referenced_at_turn).toBe(5);
    expect(block!.updated_at).toBe(now + 1000);
  });

  it("getBlocksBySession returns all blocks for a workspace+session", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    const makeBlock = (id: string, session: string) => ({
      id,
      workspace_id: "ws-1",
      session_id: session,
      content_hash: id.slice(0, 64).padEnd(64, "0"),
      kind: "tool_output" as const,
      volatility: "VOLATILE" as const,
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.insertBlock(makeBlock("01BLOCK_S1_AAAAAAAAAAAAAAAAAAAAAAAAA", "sess-1"));
    db.insertBlock(makeBlock("01BLOCK_S1_BBBBBBBBBBBBBBBBBBBBBBBBB", "sess-1"));
    db.insertBlock(makeBlock("01BLOCK_S2_CCCCCCCCCCCCCCCCCCCCCCCCC", "sess-2"));

    const rows = db.getBlocksBySession("ws-1", "sess-1");
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("01BLOCK_S1_AAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(ids).toContain("01BLOCK_S1_BBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(ids).not.toContain("01BLOCK_S2_CCCCCCCCCCCCCCCCCCCCCCCCC");
  });

  it("getBlocksBySession returns empty array when no blocks for session", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const rows = db.getBlocksBySession("ws-99", "sess-99");
    expect(rows).toEqual([]);
  });

  it("insertBlockReference auto-assigns integer id and supports round-trip", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01BLOCK00000000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "e".repeat(64),
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    db.insertTurn({
      id: "01TURN000000000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 1,
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      effective_cost_units: 100,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      created_at: now,
    });

    const refId = db.insertBlockReference({
      block_id: "01BLOCK00000000000000001",
      turn_id: "01TURN000000000000000001",
      reference_type: "tool_call",
      evidence: "tool=Read,path=auth.py",
      created_at: now,
    });
    expect(typeof refId).toBe("number");
    expect(refId).toBeGreaterThan(0);

    const refs = db.getBlockReferencesForTurn("01TURN000000000000000001");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe(refId);
    expect(refs[0]?.block_id).toBe("01BLOCK00000000000000001");
    expect(refs[0]?.reference_type).toBe("tool_call");
    expect(refs[0]?.evidence).toBe("tool=Read,path=auth.py");
    expect(refs[0]?.created_at).toBe(now);
  });

  it("insertBlockReferences batch-inserts reference audit rows", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();

    db.insertBlock({
      id: "01BATCH0000000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "f".repeat(64),
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });
    db.insertTurn({
      id: "01BATCHTURN000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 1,
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      effective_cost_units: 100,
      prefix_breakpoint_hash: null,
      middle_breakpoint_hash: null,
      pruned_blocks_count: 0,
      keepalive_pings_since_last_turn: 0,
      created_at: now,
    });

    const ids = db.insertBlockReferences([
      {
        block_id: "01BATCH0000000000000001",
        turn_id: "01BATCHTURN000000000001",
        reference_type: "id_mention",
        evidence: "id_token=abcdef12",
        created_at: now,
      },
    ]);

    expect(ids).toHaveLength(1);
    expect(db.getBlockReferencesForTurn("01BATCHTURN000000000001")).toHaveLength(1);
  });

  it("updateBlockCounters resets referenced blocks and increments eligible idle blocks", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const base = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "a".repeat(64),
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 2,
      is_stub: false,
      stub_summary: null,
      refetch_handle: null,
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    };

    db.insertBlock({ ...base, id: "01COUNTER0000000000001" });
    db.insertBlock({ ...base, id: "01COUNTER0000000000002" });
    db.insertBlock({
      ...base,
      id: "01COUNTER0000000000003",
      volatility: "STABLE",
    });

    db.updateBlockCounters({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 4,
      referenced_ids: new Set(["01COUNTER0000000000001"]),
      updated_at: now + 1000,
    });

    expect(db.getBlock("01COUNTER0000000000001")?.unused_turns).toBe(0);
    expect(db.getBlock("01COUNTER0000000000001")?.last_referenced_at_turn).toBe(4);
    expect(db.getBlock("01COUNTER0000000000002")?.unused_turns).toBe(3);
    expect(db.getBlock("01COUNTER0000000000003")?.unused_turns).toBe(2);
  });

  it("getPrunableBlocks returns only eligible non-STABLE rows with refetch handles", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    const base = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "a".repeat(64),
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 3,
      is_stub: false,
      stub_summary: null,
      refetch_handle: "tool:read:src/auth.ts",
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    };

    db.insertBlock({ ...base, id: "01PRUNABLE000000000001" });
    db.insertBlock({
      ...base,
      id: "01PRUNABLE000000000002",
      volatility: "STABLE",
    });
    db.insertBlock({
      ...base,
      id: "01PRUNABLE000000000003",
      refetch_handle: null,
    });
    db.insertBlock({
      ...base,
      id: "01PRUNABLE000000000004",
      is_pinned: true,
    });
    db.insertBlock({
      ...base,
      id: "01PRUNABLE000000000005",
      is_stub: true,
      stub_summary: "already stubbed",
    });

    const rows = db.getPrunableBlocks({
      workspace_id: "ws-1",
      session_id: "sess-1",
      k: 3,
      current_turn: 4,
    });

    expect(rows.map((row) => row.id)).toEqual(["01PRUNABLE000000000001"]);
  });

  it("getBlocksByIdPrefix scopes prefix lookup to workspace and session", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    db.insertBlock({
      id: "01PREFIX000000000000001",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "a".repeat(64),
      kind: "stub",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 50,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 3,
      is_stub: true,
      stub_summary: "stub",
      refetch_handle: "tool:read:src/auth.ts",
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    const rows = db.getBlocksByIdPrefix({
      workspace_id: "ws-1",
      session_id: "sess-1",
      block_id_prefix: "01PREFIX",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("01PREFIX000000000000001");
  });

  it("getBlocksByIdPrefix treats SQL wildcard characters as literal prefix characters", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const now = Date.now();
    db.insertBlock({
      id: "01PREFIX000000000000002",
      workspace_id: "ws-1",
      session_id: "sess-1",
      content_hash: "b".repeat(64),
      kind: "stub",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 50,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 3,
      is_stub: true,
      stub_summary: "stub",
      refetch_handle: "tool:read:src/auth.ts",
      restored_at_turn: null,
      created_at: now,
      updated_at: now,
    });

    const rows = db.getBlocksByIdPrefix({
      workspace_id: "ws-1",
      session_id: "sess-1",
      block_id_prefix: "01%",
    });

    expect(rows).toHaveLength(0);
  });

  it("allows the same tool_call_id in two sessions (session-scoped PK)", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    const base = {
      workspace_id: "ws",
      content_hash: "hash-a",
      kind: "tool_output" as const,
      volatility: "VOLATILE" as const,
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null as string | null,
      refetch_handle: JSON.stringify({ type: "tool_call", id: "call_shared" }),
      restored_at_turn: null as number | null,
      created_at: 1,
      updated_at: 1,
    };
    db.insertBlock({ ...base, id: "call_shared", session_id: "sess-a", content_hash: "hash-a", token_count: 100 });
    db.insertBlock({ ...base, id: "call_shared", session_id: "sess-b", content_hash: "hash-b", token_count: 200 });
    expect(db.getBlock("call_shared", "sess-a")?.token_count).toBe(100);
    expect(db.getBlock("call_shared", "sess-b")?.token_count).toBe(200);
    expect(db.getBlocksBySession("ws", "sess-a")).toHaveLength(1);
    expect(db.getBlocksBySession("ws", "sess-b")).toHaveLength(1);
  });

  it("preserves is_stub on re-insert of the same content_hash", () => {
    db = openDatabase(path.join(tmpDir, "test.db"));
    db.insertBlock({
      id: "call_stub",
      workspace_id: "ws",
      session_id: "sess",
      content_hash: "same-hash",
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 5000,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: JSON.stringify({ type: "tool_call", id: "call_stub" }),
      restored_at_turn: null,
      created_at: 1,
      updated_at: 1,
    });
    db.markStub("call_stub", JSON.stringify({ type: "tool_call", id: "call_stub" }), "stub", 12, 2, "sess");
    expect(db.getBlock("call_stub", "sess")?.is_stub).toBe(1);
    // re-extract full body with same hash (client re-sends tool content)
    db.insertBlock({
      id: "call_stub",
      workspace_id: "ws",
      session_id: "sess",
      content_hash: "same-hash",
      kind: "tool_output",
      volatility: "VOLATILE",
      is_pinned: false,
      token_count: 5000,
      added_at_turn: 3,
      last_referenced_at_turn: 3,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: JSON.stringify({ type: "tool_call", id: "call_stub" }),
      restored_at_turn: null,
      created_at: 3,
      updated_at: 3,
    });
    const row = db.getBlock("call_stub", "sess");
    expect(row?.is_stub).toBe(1);
    expect(row?.token_count).toBe(12);
  });

});

/**
 * The corruption check at open.
 *
 * openDatabase ran a full `integrity_check` on every open — 227-389 ms on the
 * production databases, paid by every process every time, and on the request
 * path for the proxy. It also holds a long read lock, and with four processes
 * opening the same file those overlapping read-marks starve WAL autocheckpoint:
 * the Claude lane's WAL reached 45.3 MB against a ~4 MB threshold while the
 * busier LiteLLM lane, with three times the blocks but half the readers, stayed
 * ten times smaller.
 */
describe("openDatabase — corruption check", () => {
  let dir: string;
  const saved = process.env.CACHELANE_FULL_INTEGRITY_CHECK;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-pragma-"));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CACHELANE_FULL_INTEGRITY_CHECK;
    else process.env.CACHELANE_FULL_INTEGRITY_CHECK = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Records which check pragmas were issued during an open. */
  function pragmasDuringOpen(dbPath: string): string[] {
    const original = Database.prototype.pragma;
    const seen: string[] = [];
    Database.prototype.pragma = function (this: Database.Database, pragma: string) {
      if (pragma === "quick_check" || pragma === "integrity_check") seen.push(pragma);
      return original.call(this, pragma);
    };
    try {
      openDatabase(dbPath).close();
      return seen;
    } finally {
      Database.prototype.pragma = original;
    }
  }

  it("uses quick_check by default, not the exhaustive index cross-check", () => {
    delete process.env.CACHELANE_FULL_INTEGRITY_CHECK;
    const seen = pragmasDuringOpen(path.join(dir, "a.db"));
    expect(seen).toContain("quick_check");
    expect(seen).not.toContain("integrity_check");
  });

  it("restores the full check when explicitly asked, for investigating corruption", () => {
    process.env.CACHELANE_FULL_INTEGRITY_CHECK = "1";
    const seen = pragmasDuringOpen(path.join(dir, "b.db"));
    expect(seen).toContain("integrity_check");
    expect(seen).not.toContain("quick_check");
  });

  // The sentinel string is load-bearing: isCorruptionError classifies by message,
  // so a check that reports corruption under a name the classifier does not know
  // is rethrown instead of recovered — turning an auto-healing case into a hard
  // startup failure.
  it.each(["quick_check", "integrity_check"])(
    "routes a failing %s into the corruption-recovery path",
    (pragmaName) => {
      process.env.CACHELANE_FULL_INTEGRITY_CHECK = pragmaName === "integrity_check" ? "1" : "0";
      const dbPath = path.join(dir, `bad-${pragmaName}.db`);

      const original = Database.prototype.pragma;
      let reported = false;
      Database.prototype.pragma = function (this: Database.Database, pragma: string) {
        // Report corruption once, then behave normally so the recovery open works.
        if (pragma === pragmaName && !reported) {
          reported = true;
          return [{ [pragmaName]: "*** in database main ***\nPage 3 is never used" }];
        }
        return original.call(this, pragma);
      } as typeof Database.prototype.pragma;

      let db;
      try {
        // Must recover rather than throw.
        db = openDatabase(dbPath);
        expect(db).toBeDefined();
      } finally {
        Database.prototype.pragma = original;
        db?.close();
      }

      // The damaged file is preserved for inspection, not silently discarded.
      const renamed = fs.readdirSync(dir).find((f) => f.startsWith(`bad-${pragmaName}.db.corrupt-`));
      expect(renamed).toBeTruthy();
    },
  );

  it("still opens a healthy database successfully under either mode", () => {
    for (const mode of ["0", "1"]) {
      process.env.CACHELANE_FULL_INTEGRITY_CHECK = mode;
      const db = openDatabase(path.join(dir, `ok-${mode}.db`));
      expect(db).toBeDefined();
      db.close();
    }
  });
});
