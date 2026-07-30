import type { CachelaneDb } from "../storage/index.js";
import type {
  ExpandStubErrorCode,
  ExpandStubParams,
  ExpandStubResult,
  RestoreExpandedBlockParams,
} from "./types.js";

function expandFailure(
  code: ExpandStubErrorCode,
  message: string,
): ExpandStubResult {
  return { ok: false, error: { code, message } };
}

// Full Anthropic/OpenAI tool ids may be short (tests and some compatible
// providers use ids such as "call_A"). Prefix shorthand remains deliberately
// stricter: at least 8 characters, bounded to keep queries predictable.
const EXPAND_BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EXPAND_BLOCK_ID_PREFIX_RE = /^[A-Za-z0-9_-]{8,128}$/;

// True only if a block can round-trip through expandStub. The pruner calls this
// with the full row id, so exact lookup proves both identity and session scope.
export function isExpandableBlockId(
  db: CachelaneDb,
  workspace_id: string,
  session_id: string,
  block_id: string,
): boolean {
  if (!EXPAND_BLOCK_ID_RE.test(block_id)) return false;
  const row = db.getBlock(block_id, session_id);
  return (
    row !== null &&
    row.workspace_id === workspace_id &&
    row.session_id === session_id
  );
}

export function expandStub(
  db: CachelaneDb,
  params: ExpandStubParams,
): ExpandStubResult {
  if (!EXPAND_BLOCK_ID_RE.test(params.block_id)) {
    return expandFailure(
      "invalid_block_id",
      "Block id must be 1-128 characters (letters, digits, '_' or '-')",
    );
  }

  // Prefer exact lookup so short but valid full ids round-trip. Only fall back
  // to prefix lookup when the caller supplied at least 8 characters.
  const exact = db.getBlock(params.block_id, params.session_id);
  let row =
    exact?.workspace_id === params.workspace_id ? exact : undefined;

  if (!row && EXPAND_BLOCK_ID_PREFIX_RE.test(params.block_id)) {
    const rows = db.getBlocksByIdPrefix({
      workspace_id: params.workspace_id,
      session_id: params.session_id,
      block_id_prefix: params.block_id,
    });
    if (rows.length > 1) {
      return expandFailure(
        "ambiguous_prefix",
        `Ambiguous block id prefix: ${params.block_id}`,
      );
    }
    row = rows[0];
  }

  if (!row) {
    return expandFailure("missing_block", `No block found for id: ${params.block_id}`);
  }
  if (row.is_stub !== 1) {
    return expandFailure("not_stub", `Block is not a stub: ${row.id}`);
  }

  if (row.refetch_handle === null) {
    return expandFailure(
      "missing_refetch_handle",
      `Stub block is missing refetch_handle: ${row.id}`,
    );
  }

  db.restoreStub({
    workspace_id: params.workspace_id,
    session_id: params.session_id,
    block_id: row.id,
    turn_number: params.turn_number,
    updated_at: params.updated_at ?? Date.now(),
  });

  return {
    ok: true,
    block_id: row.id,
    refetch_request: {
      type: "trusted_refetch",
      refetch_handle: row.refetch_handle,
    },
    stub_summary: row.stub_summary,
  };
}

export function markExpandedBlockRestored(
  db: CachelaneDb,
  params: RestoreExpandedBlockParams,
): void {
  db.restoreStub({
    workspace_id: params.workspace_id,
    session_id: params.session_id,
    block_id: params.block_id,
    turn_number: params.turn_number,
    updated_at: params.updated_at ?? Date.now(),
  });
}
