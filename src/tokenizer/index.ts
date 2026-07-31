import { getTokenizer } from "@anthropic-ai/tokenizer";
import type { Tiktoken } from "tiktoken/lite";
import { MODEL_TABLE, SUPPORTED_MODELS } from "./model-table.js";

export { SUPPORTED_MODELS } from "./model-table.js";

/**
 * The package's own `countTokens` constructs a fresh `Tiktoken` from a
 * 696,615-byte BPE rank table on *every* call and frees it immediately. That
 * costs ~45 ms per call regardless of input length — the cost is the
 * constructor, not the encode.
 *
 * `src/pruner/k-pruning.ts` calls this once per pruned block inside a
 * synchronous request handler, so at the stub counts CacheLane produces
 * (68-139/turn, peaking at 261) it blocked the single-threaded event loop for
 * 3-12 seconds per turn, freezing every concurrent request and in-flight
 * stream. That was the production hang.
 *
 * Hold one encoder for the process instead. `src/tokenizer/openai.ts` already
 * caches its encodings this way. Deliberately never `.free()`d: the instance
 * lives for the lifetime of the process, and freeing it would reintroduce the
 * per-call construction it exists to avoid.
 */
let encoder: Tiktoken | undefined;

function sharedEncoder(): Tiktoken {
  if (encoder === undefined) {
    encoder = getTokenizer();
  }
  return encoder;
}

/**
 * Byte-for-byte equivalent to the package's `countTokens`, which does exactly
 * `tokenizer.encode(text.normalize("NFKC"), "all").length`. Both arguments are
 * load-bearing — dropping the NFKC normalization or the "all" special-token
 * mode changes counts.
 */
function encodedLength(text: string): number {
  return sharedEncoder().encode(text.normalize("NFKC"), "all").length;
}

/**
 * Count tokens in `text` for the given Anthropic model ID. Throws for
 * unknown model IDs so callers can't silently miscost a request (REQ-F-003).
 * Applies a per-model multiplier (see model-table.ts and ADR-011) so 4.6
 * and 4.7 produce distinct counts as the M1 gate requires.
 */
export function countTokens(text: string, modelId: string): number {
  let entry = MODEL_TABLE[modelId];
  if (!entry && modelId.startsWith("claude-")) {
    // Unknown Claude model — use multiplier 1.0 as a safe approximation
    entry = { variant: "claude", tokenCountMultiplier: 1.0 };
  }
  if (!entry) {
    throw new Error(
      `unsupported model "${modelId}" — add it to src/tokenizer/model-table.ts. ` +
        `Supported: ${SUPPORTED_MODELS.join(", ")}`
    );
  }
  if (text.length === 0) {
    return 0;
  }
  return Math.round(encodedLength(text) * entry.tokenCountMultiplier);
}
