import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../index.js";
import type { CachelaneDb, InsertTurnParams } from "../types.js";

let db: CachelaneDb;
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-provenance-"));
  db = openDatabase(path.join(tmpDir, "test.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const turn = (id: string, signals: string[]): InsertTurnParams => ({
  id,
  workspace_id: "ws",
  session_id: "sess",
  turn_number: Number(id.slice(1)),
  model: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_5m_tokens: 0,
  cache_creation_1h_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  effective_cost_units: 1,
  prefix_breakpoint_hash: null,
  middle_breakpoint_hash: null,
  pruned_blocks_count: 0,
  keepalive_pings_since_last_turn: 0,
  request_mutated: 1,
  signals: JSON.stringify(signals),
  created_at: Date.now(),
});

describe("measurement provenance stats", () => {
  it("aggregates marker ownership from persisted provenance", () => {
    for (const [i, owner] of (["client", "cachelane", "mixed"] as const).entries()) {
      const row = turn(`t${i + 1}`, ["mode:proxy", "usage:recorded"]);
      db.insertTurn(row);
      db.insertTurnExplanation({
        turn_id: row.id,
        workspace_id: row.workspace_id,
        session_id: row.session_id,
        turn_number: row.turn_number,
        model: row.model,
        prefix_breakpoint_hash: null,
        middle_breakpoint_hash: null,
        mutated: true,
        pruned_blocks_count: 0,
        prune_decisions: [],
        block_metadata: [],
        region_metadata: { message_count: 0, stable_count: 0, semi_count: 0, volatile_count: 0 },
        signals: [],
        provenance: {
          build_sha: "abc123",
          config_hash: "def456",
          experiment_arm: "candidate",
          route: "proxy",
          marker_owner: owner,
          outcome: "ok",
          usage_missing: false,
          incoming_markers: [],
          emitted_markers: [],
          prefix_hash_at_bp: [],
          prune_transforms: [],
        },
        created_at: row.created_at,
        updated_at: row.created_at,
      });
    }

    expect(db.getStats({ scope: "all" }).marker_owner_counts).toEqual({
      client: 1,
      cachelane: 1,
      mixed: 1,
      unknown: 0,
    });
  });
});
