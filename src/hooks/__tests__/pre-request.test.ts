import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Classification } from "../../classifier/index.js";
import { CacheStateTracker } from "../../orchestrator/index.js";
import type { AnthropicMessagesRequest } from "../../orchestrator/index.js";
import { openDatabase, type CachelaneDb } from "../../storage/index.js";
import type { Volatility } from "../../types/index.js";
import type { PromptBlockPlacement } from "../../pruner/index.js";
import { handlePreRequest } from "../pre-request.js";

let tmpDir: string;
let db: CachelaneDb;

function cl(volatility: Volatility): Classification {
  return {
    kind: "tool_output",
    volatility,
    isPinned: false,
    signals: ["tool_output"],
  };
}

function insertBlock(
  id: string,
  overrides: Partial<Parameters<typeof db.insertBlock>[0]> = {},
): void {
  const now = 1_715_000_000_000;
  db.insertBlock({
    id,
    workspace_id: "ws-1",
    session_id: "sess-1",
    content_hash: id.padEnd(64, "0").slice(0, 64),
    kind: "tool_output",
    volatility: "VOLATILE",
    is_pinned: false,
    token_count: 250,
    added_at_turn: 1,
    last_referenced_at_turn: 1,
    unused_turns: 0,
    is_stub: false,
    stub_summary: null,
    refetch_handle: "tool:read:src/auth.ts",
    restored_at_turn: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function baseRequest(text = "raw block content"): AnthropicMessagesRequest {
  return {
    model: "claude-opus-4-7",
    system: [{ type: "text", text: "You are Claude." }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
    max_tokens: 1024,
  };
}

function placement(block_id: string): PromptBlockPlacement {
  return {
    block_id,
    message_index: 0,
    content_index: 0,
    kind: "tool_output",
    volatility: "VOLATILE",
    is_pinned: false,
    refetch_handle: "tool:read:src/auth.ts",
    token_count: 0,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-pre-request-"));
  db = openDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handlePreRequest", () => {
  it("runs classification input through pruner materialization before orchestration", () => {
    const blockId = "01KPREQ1000000000000001";
    insertBlock(blockId, { unused_turns: 3 });
    const tracker = new CacheStateTracker();

    const result = handlePreRequest({
      db,
      route: "other",
      tracker,
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 4,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [placement(blockId)],
      pruner: { enabled: true, k: 3, mode: "default" },
      now_ms: 1_715_000_004_000,
    });

    expect(result.pruned_blocks_count).toBe(1);
    expect(result.request.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "[stub:01KPREQ1] tool_output tool:read:src/auth.ts (250 tokens elided) | refetch via cachelane_expand(block_id=01KPREQ1000000000000001)",
    });
    // H5: prefix marker lands on the last system block (covers tools + system).
    expect(result.request.system?.at(-1)?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  it("writes metadata-only turn explanations after pruning and orchestration", () => {
    const blockId = "01KPREQEXPLAIN00000001";
    insertBlock(blockId, { unused_turns: 3 });

    handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_id: "turn-explain-hook",
      current_turn: 4,
      original_request: baseRequest("raw fixture prompt content"),
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [placement(blockId)],
      pruner: { enabled: true, k: 3, mode: "default" },
      now_ms: 1_715_000_004_000,
    });

    const explanation = db.getTurnExplanation({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 4,
    });

    expect(JSON.stringify(explanation)).not.toContain("raw fixture prompt content");
    expect(explanation?.pruned_blocks_count).toBe(1);
    expect(explanation?.block_metadata[0]).toMatchObject({
      block_id: blockId,
      has_refetch_handle: true,
    });
  });

  it("starts pruning a K=3 turn-1 block on turn 4", () => {
    const blockId = "01KPREQ2000000000000001";
    insertBlock(blockId);

    for (const turnNumber of [1, 2, 3]) {
      db.updateBlockCounters({
        workspace_id: "ws-1",
        session_id: "sess-1",
        turn_number: turnNumber,
        referenced_ids: new Set(),
        updated_at: 1_715_000_000_000 + turnNumber,
      });
    }

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 4,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [placement(blockId)],
      pruner: { enabled: true, k: 3, mode: "default" },
    });

    expect(result.pruned_blocks_count).toBe(1);
    expect(db.getBlock(blockId)?.is_stub).toBe(1);
  });

  it("keeps a restored block suffix-only for one warming turn", () => {
    const blockId = "01KPREQ3000000000000001";
    insertBlock(blockId, {
      volatility: "SEMI",
      restored_at_turn: 6,
      last_referenced_at_turn: 6,
    });

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 7,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("SEMI")],
      block_placements: [placement(blockId)],
      pruner: { enabled: false, k: 3, mode: "default" },
      marker_strategy: "candidate",
    });

    expect(result.effective_message_classifications[0]?.volatility).toBe(
      "VOLATILE",
    );
    expect(result.middle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signals).toContain("middle_marker_emitted");
  });

  it("allows normal classification on the turn after suffix warming", () => {
    const blockId = "01KPREQ4000000000000001";
    insertBlock(blockId, {
      volatility: "SEMI",
      restored_at_turn: 6,
      last_referenced_at_turn: 6,
    });

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 8,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("SEMI")],
      block_placements: [placement(blockId)],
      pruner: { enabled: false, k: 3, mode: "default" },
      marker_strategy: "candidate",
    });

    expect(result.effective_message_classifications[0]?.volatility).toBe("SEMI");
    expect(result.middle_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails open when message_classifications length mismatches messages", () => {
    const original = baseRequest();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 1,
      original_request: original,
      // original has 2 messages; supply only 1 classification
      message_classifications: [cl("SEMI")],
      block_placements: [],
      pruner: { enabled: false, k: 3, mode: "default" },
    });

    expect(result.request).toBe(original);
    expect(result.mutated).toBe(false);
    expect(result.signals).toContain("error:fallback");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("mismatch"),
      expect.any(Object),
    );
  });

  it("records passthrough marker ownership and explicit hook provenance", () => {
    const result = handlePreRequest({
      db,
      route: "hook",
      marker_strategy: "passthrough",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-pass",
      session_id: "sess-pass",
      turn_id: "turn-pass",
      current_turn: 1,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [],
      pruner: { enabled: false, k: 3, mode: "default" },
    });

    expect(result.signals).toContain("markers:preserved_client");
    expect(db.getTurnExplanation({ workspace_id: "ws-pass", session_id: "sess-pass", turn_number: 1 })?.provenance).toMatchObject({
      route: "hook",
      experiment_arm: "passthrough",
      marker_owner: "client",
    });
  });

  it("fails open with the original request when storage fails", () => {
    const original = baseRequest("do not touch");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingDb = {
      getPrunableBlocks: () => {
        throw new Error("storage unavailable");
      },
    } as unknown as CachelaneDb;

    const result = handlePreRequest({
      db: failingDb,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 4,
      original_request: original,
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [],
      pruner: { enabled: true, k: 3, mode: "default" },
    });

    expect(result.request).toBe(original);
    expect(result.mutated).toBe(false);
    expect(result.signals).toContain("error:fallback");
    expect(spy).toHaveBeenCalled();
  });
});

/**
 * The stateless arm (features.elision_mode = "stateless").
 *
 * The legacy path decided what to elide by querying the database and writing
 * `is_stub` back. That write-back is what made it cost 45 ms per block per turn
 * and, separately, what made elision silently stop after the first turn per
 * block once the un-stubbing bug was removed. These tests pin the two
 * properties that combination made impossible.
 */
describe("handlePreRequest — stateless elision arm", () => {
  const BIG = "y".repeat(8000);

  /**
   * A valid Anthropic tool-use conversation.
   *
   * Every tool_result is paired with a tool_use in the immediately preceding
   * assistant message. An orphaned tool_result is rejected by the API, so a
   * fixture built that way would never be forwardable and the tests would be
   * exercising a shape production never sends.
   */
  function conversation(turns: number): AnthropicMessagesRequest {
    const messages: AnthropicMessagesRequest["messages"] = [];
    for (let t = 0; t < turns; t++) {
      messages.push({ role: "user", content: [{ type: "text", text: `ask ${t}` }] });
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `toolu_${t}`, name: "Read", input: {} }],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `toolu_${t}`, content: BIG }],
      });
    }
    return {
      model: "claude-opus-4-7",
      system: [{ type: "text", text: "You are Claude." }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages,
      max_tokens: 1024,
    } as AnthropicMessagesRequest;
  }

  function run(request: AnthropicMessagesRequest, turn: number) {
    return handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: turn,
      original_request: request,
      message_classifications: request.messages.map(() => cl("VOLATILE")),
      block_placements: [],
      pruner: { enabled: true, k: 4, mode: "default" },
      elision_mode: "stateless",
      now_ms: 1_715_000_004_000,
    });
  }

  it("elides without any block ever having been inserted in the database", () => {
    // The legacy path can only elide what getPrunableBlocks returns, so with an
    // empty blocks table it elides nothing. Deciding from the request alone is
    // the whole difference.
    const result = run(conversation(20), 20);

    expect(result.pruned_blocks_count).toBeGreaterThan(0);
    expect(result.elision_mode).toBe("stateless");
    expect(result.elision_active).toBe(true);
    expect(db.getBlocksBySession("ws-1", "sess-1")).toHaveLength(0);
  });

  it("does not mark stubs, so nothing accumulates state to un-stub later", () => {
    insertBlock("toolu_0", { unused_turns: 9 });
    run(conversation(20), 20);

    const rows = db.getBlocksBySession("ws-1", "sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_stub).toBe(0);
    expect(rows[0]!.token_count).toBe(250); // untouched by the arm
  });

  it("keeps eliding on every turn — the failure that made the feature a no-op", () => {
    // With sticky is_stub, elision applies once per block and then stops:
    // getPrunableBlocks filters is_stub = 0. Re-eliding every turn is required,
    // because the client re-sends full history and never learns what was elided.
    const counts: number[] = [];
    for (let turns = 8; turns <= 20; turns++) {
      counts.push(run(conversation(turns), turns).pruned_blocks_count);
    }

    expect(counts.every((c) => c > 0)).toBe(true);
    expect(counts.at(-1)!).toBeGreaterThan(counts[0]!);
    // Monotone: the elided set only ever grows as the conversation grows.
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it("records the arm and byte savings, not fabricated token counts", () => {
    const result = run(conversation(20), 20);
    const explanation = db.getTurnExplanation({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 20,
    });

    expect(result.elision_decisions.length).toBe(result.pruned_blocks_count);
    // prune_decisions carries token counts that would have to be invented here.
    expect(result.prune_decisions).toEqual([]);
    expect(explanation?.provenance?.elision_mode).toBe("stateless");
    expect(explanation?.provenance?.elided_bytes).toBeGreaterThan(0);
  });

  it("respects pruner.enabled = false", () => {
    const request = conversation(20);
    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 20,
      original_request: request,
      message_classifications: request.messages.map(() => cl("VOLATILE")),
      block_placements: [],
      pruner: { enabled: false, k: 4, mode: "default" },
      elision_mode: "stateless",
      now_ms: 1_715_000_004_000,
    });

    expect(result.pruned_blocks_count).toBe(0);
    expect(JSON.stringify(result.request.messages)).toContain(BIG);
  });

  it.each(["stateless", "legacy"] as const)(
    "honours the k_pruner kill switch on the %s arm",
    (mode) => {
      // k_pruner used to be checked only on the OpenAI path, so the Anthropic
      // lane kept eliding with the feature switched off. Both arms check it now.
      const blockId = "01KPREQKILLSWITCH00001";
      insertBlock(blockId, { unused_turns: 9 });
      const request = conversation(20);

      const result = handlePreRequest({
        db,
        route: "other",
        tracker: new CacheStateTracker(),
        workspace_id: "ws-1",
        session_id: "sess-1",
        current_turn: 20,
        original_request: request,
        message_classifications: request.messages.map(() => cl("VOLATILE")),
        block_placements: [placement(blockId)],
        pruner: { enabled: true, k: 4, mode: "default" },
        elision_mode: mode,
        k_pruner_enabled: false,
        now_ms: 1_715_000_004_000,
      });

      expect(result.pruned_blocks_count).toBe(0);
      expect(JSON.stringify(result.request.messages)).toContain(BIG);
      expect(db.getBlock(blockId)!.is_stub).toBe(0);
    },
  );

  it("stands down when mutation is disabled, but is still recorded as the stateless arm", () => {
    // This configuration IS the Gate 5 control lane: stateless selected,
    // mutation off. It must elide nothing (the body is forwarded unchanged, so
    // recording elided bytes would be a lie) while still being labelled
    // stateless — labelling it legacy would compare the wrong two things.
    const request = conversation(20);
    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 20,
      original_request: request,
      message_classifications: request.messages.map(() => cl("VOLATILE")),
      block_placements: [],
      pruner: { enabled: true, k: 4, mode: "default" },
      elision_mode: "stateless",
      mutation_enabled: false,
      now_ms: 1_715_000_004_000,
    });

    expect(result.pruned_blocks_count).toBe(0);
    expect(result.elision_decisions).toEqual([]);
    expect(result.elision_mode).toBe("stateless");
    expect(JSON.stringify(result.request.messages)).toContain(BIG);
    // The arm is stateless AND it did not run. Recording only the first would
    // make this turn indistinguishable from one that elided nothing usefully.
    expect(result.elision_active).toBe(false);

    const explanation = db.getTurnExplanation({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 20,
    });
    expect(explanation?.provenance?.elision_mode).toBe("stateless");
    expect(explanation?.provenance?.elision_active).toBe(false);
    expect(explanation?.provenance?.elided_bytes ?? 0).toBe(0);
  });

  it("reports mutated for an elided request the orchestrator left alone", () => {
    // orchestrate() reports whether IT placed cache breakpoints, and places
    // none on a request with no system prompt and no tools. The proxy forwards
    // the ORIGINAL body whenever mutated is false — so if elision did not count
    // as mutation, this request would be elided, the bytes recorded as saved,
    // and the original sent anyway.
    const request = conversation(20);
    delete (request as { system?: unknown }).system;
    delete (request as { tools?: unknown }).tools;

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 20,
      original_request: request,
      message_classifications: request.messages.map(() => cl("VOLATILE")),
      block_placements: [],
      pruner: { enabled: true, k: 4, mode: "default" },
      elision_mode: "stateless",
      now_ms: 1_715_000_004_000,
    });

    expect(result.pruned_blocks_count).toBeGreaterThan(0);
    expect(result.mutated).toBe(true);
    // And the returned body really is the elided one.
    expect(JSON.stringify(result.request.messages)).toContain("cachelane:elided");
  });

  it("defaults to the legacy arm when no mode is given", () => {
    const blockId = "01KPREQDEFAULT00000001";
    insertBlock(blockId, { unused_turns: 3 });

    const result = handlePreRequest({
      db,
      route: "other",
      tracker: new CacheStateTracker(),
      workspace_id: "ws-1",
      session_id: "sess-1",
      current_turn: 4,
      original_request: baseRequest(),
      message_classifications: [cl("SEMI"), cl("VOLATILE")],
      block_placements: [placement(blockId)],
      pruner: { enabled: true, k: 3, mode: "default" },
      now_ms: 1_715_000_004_000,
    });

    expect(result.elision_mode).toBe("legacy");
    expect(db.getBlock(blockId)!.is_stub).toBe(1); // legacy still marks stubs
  });
});
