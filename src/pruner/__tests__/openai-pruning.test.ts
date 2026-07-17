import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type CachelaneDb } from "../../storage/index.js";
import { formatStubText } from "../stubs.js";
import {
  materializePrunedBlocksOpenAI,
  pruneExpiredBlocks,
  type OpenAIMaterializableRequest,
} from "../index.js";
import type { PruneDecision } from "../types.js";
import { computeBlockPlacementsOpenAI } from "../../proxy/server.js";

let tmpDir: string;
let db: CachelaneDb;

const WS = "ws-1";
const SESS = "sess-1";

function insertToolBlock(
  id: string,
  overrides: Partial<Parameters<typeof db.insertBlock>[0]> = {},
): void {
  const now = 1_715_000_000_000;
  db.insertBlock({
    id,
    workspace_id: WS,
    session_id: SESS,
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
    refetch_handle: JSON.stringify({ type: "tool_call", id }),
    restored_at_turn: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function ageBlocks(turns: number[]): void {
  for (const turn of turns) {
    db.updateBlockCounters({
      workspace_id: WS,
      session_id: SESS,
      turn_number: turn,
      referenced_ids: new Set(),
      updated_at: 1_715_000_000_000 + turn,
    });
  }
}

function decisionFor(id: string): PruneDecision {
  return {
    block_id: id,
    action: "stubbed",
    reason: "unused_turns >= 3",
    stub_summary: `tool_output (250 tokens elided)`,
    refetch_handle: JSON.stringify({ type: "tool_call", id }),
    kind: "tool_output",
    original_tokens: 250,
    stub_tokens: 20,
  };
}

function openaiRequest(): OpenAIMaterializableRequest {
  return {
    model: "qwen36-27b",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_A", type: "function", function: { name: "ls", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_A", content: "file1\nfile2\nfile3" },
      { role: "user", content: "thanks" },
    ],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-oai-pruner-"));
  db = openDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeBlockPlacementsOpenAI", () => {
  it("maps role:tool messages to placements by tool_call_id", () => {
    insertToolBlock("call_A");
    const placements = computeBlockPlacementsOpenAI(
      openaiRequest().messages as Array<{ role?: unknown; tool_call_id?: unknown }>,
      db.getBlocksBySession(WS, SESS),
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      block_id: "call_A",
      message_index: 3,
      content_index: 0,
      kind: "tool_output",
    });
  });

  it("ignores tool messages with no tracked block", () => {
    const placements = computeBlockPlacementsOpenAI(
      openaiRequest().messages as Array<{ role?: unknown; tool_call_id?: unknown }>,
      db.getBlocksBySession(WS, SESS),
    );
    expect(placements).toHaveLength(0);
  });
});

describe("materializePrunedBlocksOpenAI", () => {
  it("replaces only the tool message content, preserving the pairing invariant", () => {
    const request = openaiRequest();
    const decision = decisionFor("call_A");
    const out = materializePrunedBlocksOpenAI({
      request,
      decisions: [decision],
      block_placements: [
        {
          block_id: "call_A",
          message_index: 3,
          content_index: 0,
          kind: "tool_output",
          volatility: "VOLATILE",
          is_pinned: false,
          refetch_handle: decision.refetch_handle,
          restored_at_turn: null,
          token_count: 250,
        },
      ],
    });

    // The tool message survives with role + tool_call_id intact (OpenAI
    // requires a tool message per tool_calls id) — only content is stubbed.
    const toolMsg = out.messages[3]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_A");
    expect(toolMsg.content).toBe(formatStubText(decision));

    // Everything else is untouched, and the input request is not mutated.
    expect(out.messages[0]).toEqual(request.messages[0]);
    expect(out.messages[2]).toEqual(request.messages[2]);
    expect(request.messages[3]!.content).toBe("file1\nfile2\nfile3");
  });

  it("throws on placement pointing at a non-tool or mismatched message", () => {
    const request = openaiRequest();
    const decision = decisionFor("call_A");
    expect(() =>
      materializePrunedBlocksOpenAI({
        request,
        decisions: [decision],
        block_placements: [
          {
            block_id: "call_A",
            message_index: 1, // a user message — drifted placement
            content_index: 0,
            kind: "tool_output",
            volatility: "VOLATILE",
            is_pinned: false,
            refetch_handle: decision.refetch_handle,
            restored_at_turn: null,
            token_count: 250,
          },
        ],
      }),
    ).toThrow(/Placement mismatch/);
  });

  it("throws when a pruned decision has no placement", () => {
    expect(() =>
      materializePrunedBlocksOpenAI({
        request: openaiRequest(),
        decisions: [decisionFor("call_A")],
        block_placements: [],
      }),
    ).toThrow(/no placement metadata/);
  });
});

describe("end-to-end: age → prune → materialize (OpenAI shapes)", () => {
  it("K=3 stubs an idle OpenAI tool output and records reclaimable tokens", () => {
    insertToolBlock("call_A");
    ageBlocks([2, 3, 4]); // 3 turns without reference → unused_turns = 3

    const pruneResult = pruneExpiredBlocks(db, {
      workspace_id: WS,
      session_id: SESS,
      k: 3,
      current_turn: 4,
      enabled: true,
    });
    expect(pruneResult.pruned_blocks_count).toBe(1);
    const decision = pruneResult.decisions[0]!;
    expect(decision.block_id).toBe("call_A");
    expect(decision.original_tokens).toBe(250);
    expect(decision.stub_tokens).toBeGreaterThan(0);
    expect(decision.original_tokens - decision.stub_tokens).toBeGreaterThan(0);

    const request = openaiRequest();
    const placements = computeBlockPlacementsOpenAI(
      request.messages as Array<{ role?: unknown; tool_call_id?: unknown }>,
      db.getBlocksBySession(WS, SESS),
    );
    const out = materializePrunedBlocksOpenAI({
      request,
      decisions: pruneResult.decisions,
      block_placements: placements,
    });
    expect(out.messages[3]!.content).toContain("call_A");
    expect(out.messages[3]!.content).not.toContain("file1");
    expect(db.getBlock("call_A")?.is_stub).toBe(1);
  });
});
