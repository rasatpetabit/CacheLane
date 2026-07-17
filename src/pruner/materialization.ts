import type {
  MaterializableRequest,
  MaterializePrunedBlocksParams,
  PromptBlockPlacement,
  PruneDecision,
} from "./types.js";
import { formatStubText } from "./stubs.js";

function cloneMaterializableRequest<TRequest extends MaterializableRequest>(
  request: TRequest,
): TRequest {
  // ...request spreads all TRequest properties beyond MaterializableRequest,
  // so the shape is preserved even though TS can't prove it structurally.
  // Guard: Claude Code sometimes sends messages with string content (e.g. simple
  // user turns). String content cannot contain tool_results so no block placement
  // will ever point at such a message — but we must not call .map() on a string.
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((content) => ({ ...content }))
        : message.content,
    })),
  } as TRequest;
}

function placementKey(placement: PromptBlockPlacement): string {
  return `${placement.message_index}:${placement.content_index}`;
}

export function materializePrunedBlocks<
  TRequest extends MaterializableRequest,
>(params: MaterializePrunedBlocksParams<TRequest>): TRequest {
  const out = cloneMaterializableRequest(params.request); // returns TRequest
  const placementsByBlockId = new Map<string, PromptBlockPlacement>();
  const seenLocations = new Set<string>();

  for (const placement of params.block_placements) {
    if (placementsByBlockId.has(placement.block_id)) {
      throw new Error(`Duplicate placement for block: ${placement.block_id}`);
    }
    const key = placementKey(placement);
    if (seenLocations.has(key)) {
      throw new Error(`Duplicate placement location: ${key}`);
    }
    placementsByBlockId.set(placement.block_id, placement);
    seenLocations.add(key);
  }

  for (const decision of params.decisions) {
    const placement = placementsByBlockId.get(decision.block_id);
    if (!placement) {
      throw new Error(
        `Pruned block has no placement metadata: ${decision.block_id}`,
      );
    }

    const message = out.messages[placement.message_index];
    if (!message) {
      throw new Error(
        `Invalid message_index for block ${decision.block_id}: ${placement.message_index}`,
      );
    }

    if (!message.content[placement.content_index]) {
      throw new Error(
        `Invalid content_index for block ${decision.block_id}: ${placement.content_index}`,
      );
    }

    const originalBlock = message.content[placement.content_index];
    if (originalBlock && originalBlock.type === "tool_result") {
      message.content[placement.content_index] = {
        ...originalBlock,
        content: formatStubText(decision),
      };
    } else {
      message.content[placement.content_index] = {
        type: "text",
        text: formatStubText(decision),
      };
    }
  }

  return out;
}

// ---------------------------------------------------------------- OpenAI chat

/**
 * OpenAI chat-completions shape: a pruned tool output is a whole
 * `role:"tool"` message whose `content` (string or content-part array) IS the
 * result payload. The message itself must survive — the OpenAI API requires a
 * tool message for every `tool_calls` id in the preceding assistant message
 * (pairing invariant) — so only `content` is replaced with the stub text.
 * `content_index` in the placement is always 0 for this shape.
 */
export interface OpenAIChatMessageLike {
  role: string;
  content: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAIMaterializableRequest {
  messages: OpenAIChatMessageLike[];
  [key: string]: unknown;
}

export function materializePrunedBlocksOpenAI<
  TRequest extends OpenAIMaterializableRequest,
>(params: {
  request: TRequest;
  decisions: PruneDecision[];
  block_placements: PromptBlockPlacement[];
}): TRequest {
  const out = {
    ...params.request,
    messages: params.request.messages.map((message) => ({ ...message })),
  } as TRequest;

  const placementsByBlockId = new Map<string, PromptBlockPlacement>();
  for (const placement of params.block_placements) {
    if (placementsByBlockId.has(placement.block_id)) {
      throw new Error(`Duplicate placement for block: ${placement.block_id}`);
    }
    placementsByBlockId.set(placement.block_id, placement);
  }

  for (const decision of params.decisions) {
    const placement = placementsByBlockId.get(decision.block_id);
    if (!placement) {
      throw new Error(
        `Pruned block has no placement metadata: ${decision.block_id}`,
      );
    }

    const message = out.messages[placement.message_index];
    if (!message) {
      throw new Error(
        `Invalid message_index for block ${decision.block_id}: ${placement.message_index}`,
      );
    }
    if (message.role !== "tool" || message.tool_call_id !== decision.block_id) {
      // Placement drift (conversation edited/reordered between turns) — fail
      // loud so handlePreRequest-style callers fall back to the unmutated
      // request rather than stubbing the wrong message.
      throw new Error(
        `Placement mismatch for block ${decision.block_id}: ` +
          `message ${placement.message_index} is role=${message.role} ` +
          `tool_call_id=${String(message.tool_call_id)}`,
      );
    }

    message.content = formatStubText(decision);
  }

  return out;
}
