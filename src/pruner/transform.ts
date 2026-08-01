/**
 * Layer 1 — the pure elision transform.
 *
 * This replaces the decision half of the K-pruner. The old path asked the
 * database which blocks were prunable (`getPrunableBlocks`), wrote `is_stub`
 * back, and derived eligibility from `added_at_turn` / `unused_turns` — a
 * per-HTTP-request counter that reached 1748 in a session with 267 real turns
 * and gave two concurrent requests different answers for the same conversation.
 *
 * Everything here is computed from the messages array the client just sent.
 * No database, no clock, no counters, no memory of previous turns. That buys
 * the four properties the old design could not have:
 *
 *   I1  input/output separation — the input is never mutated, and a stub is
 *       always shorter than `min_bytes`, so re-running the transform on its own
 *       output is a no-op. There is a fixed point and it is reached in one step.
 *   I2  monotonicity — eligibility is `userMessagesAfter(block) >= K_eff` with
 *       `K_eff` non-increasing in a band that only grows. Appending to a
 *       conversation can only ever elide more, never fewer, blocks.
 *   I3  determinism — identical across processes, restarts, database loss and
 *       concurrent requests, because none of those are inputs.
 *   M1  the elision is recomputed from scratch every turn, which is *required*:
 *       the client re-sends full history and never learns what was elided, so
 *       durable per-block elision state is unrepresentable. The old code only
 *       ever worked because a bug un-stubbed blocks behind its own back.
 *
 * Recomputing every block every turn is only affordable because the tokenizer
 * no longer rebuilds a 697 KB BPE table per call (see `src/tokenizer/index.ts`);
 * this module additionally avoids the tokenizer entirely, measuring in bytes.
 */

/**
 * Wiring note: this module is deliberately not called yet. Layer 2 (the nominal
 * `ForwardBody`/`OriginalBody` types that stop the recorder reading the mutated
 * buffer) must never land without Layer 1, so Layer 1 lands first, inert, and
 * the next commit switches the request path onto it behind an experiment arm.
 * Until then the legacy database-backed pruner remains the live path — and is
 * disabled in production config.
 */

/** Longest stub this module can emit, in bytes. Asserted by its tests. */
export const MAX_STUB_BYTES = 256;

/**
 * Byte budget for the block id inside a stub. `MAX_STUB_BYTES` minus the
 * longest possible fixed text (~90 bytes with a 16-digit byte count), rounded
 * down. Block ids are ASCII in practice (`toolu_…`, `call_…`), but the bound
 * has to hold for whatever a client actually sends.
 */
const ID_BYTE_BUDGET = 128;

export interface ElisionPolicy {
  /** Base cutoff at band 0: elide a block with at least this many user messages after it. */
  k: number;
  /** Never elide content smaller than this. Must exceed `MAX_STUB_BYTES` — see I1. */
  min_bytes: number;
  /** Floor for the band-adjusted cutoff. */
  k_min?: number;
  /**
   * Blocks the caller wants kept verbatim. Supplied by the caller rather than
   * read here, so the transform stays pure.
   */
  pinned_block_ids?: ReadonlySet<string>;
}

export interface ElisionDecision {
  block_id: string;
  message_index: number;
  content_index: number;
  original_bytes: number;
  stub_bytes: number;
}

export interface TransformResult<TRequest> {
  body: TRequest;
  decisions: ElisionDecision[];
  /** Coarse quantization of conversation length; see `elisionBand`. */
  band: number;
  /** The cutoff actually applied this turn. */
  k_eff: number;
}

export const DEFAULT_ELISION_POLICY: ElisionPolicy = {
  k: 8,
  min_bytes: 2048,
  k_min: 2,
};

/**
 * Quantize conversation length to a coarse band.
 *
 * The input must be monotone in the *conversation*, not in request size: the
 * count of user messages in the incoming request is append-only, so the band
 * only ever rises. Banding on the forwarded (post-elision) body would feed the
 * output back into the input and rebuild the feedback loop this design exists
 * to remove.
 *
 * log2 means the band — and therefore the cutoff, and therefore the elided set
 * — changes about once per doubling of the conversation. Since eliding *is*
 * cache invalidation, a cutoff that moved every turn would invalidate the
 * prefix every turn and cost more than it saves.
 */
export function elisionBand(userMessageCount: number): number {
  if (userMessageCount <= 1) return 0;
  return Math.floor(Math.log2(userMessageCount));
}

/**
 * The band-adjusted cutoff. **Non-increasing in `band`** — this direction is
 * load-bearing and easy to get backwards. Eligibility is
 * `userMessagesAfter(block) >= K_eff`, so a *larger* cutoff elides *fewer*
 * blocks. If the cutoff rose as the conversation grew, growing into a higher
 * band would un-elide blocks and make their content reappear, breaking I2.
 * Longer conversation, more elision, smaller cutoff.
 */
export function effectiveK(band: number, policy: ElisionPolicy): number {
  const floor = policy.k_min ?? 1;
  return Math.max(floor, policy.k - band);
}

/** Byte length of a tool result payload, whatever shape it arrived in. */
function contentBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (content === null || content === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(content), "utf8");
  } catch {
    // Circular or otherwise unserializable — treat as unmeasurable and so
    // ineligible, rather than throwing on the request path.
    return 0;
  }
}

/**
 * The stub that replaces elided content.
 *
 * Deliberately makes no retrieval promise. `blocks` has no content column and
 * `compression_originals` has zero rows in both production homes, so the
 * `cachelane_expand(...)` offer the legacy stub advertises cannot be honoured.
 * Until escrow actually exists, saying so is the honest form — and a stub that
 * invites a call which always fails is worse than one that does not.
 *
 * Must stay under `MAX_STUB_BYTES`; `min_bytes > MAX_STUB_BYTES` is what makes
 * the transform idempotent.
 */
export function formatElisionStub(blockId: string, originalBytes: number): string {
  const id = truncateToBytes(blockId, ID_BYTE_BUDGET);
  return `[cachelane:elided ${id}] ${originalBytes} bytes of tool output removed from this turn's context.`;
}

/**
 * Truncate to a UTF-8 *byte* budget without splitting a multi-byte character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so slicing to 64 "characters"
 * admits 192 bytes of CJK or 256 bytes of astral-plane text — which would let a
 * stub exceed `MAX_STUB_BYTES`, become eligible for elision itself, and destroy
 * the fixed point that `min_bytes > MAX_STUB_BYTES` is supposed to guarantee.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // A non-fatal decode renders any trailing partial sequence as U+FFFD; drop it
  // so the result is always a prefix of the original.
  return new TextDecoder("utf-8").decode(cut).replace(/�+$/u, "");
}

/**
 * The smallest content this transform will ever elide.
 *
 * `min_bytes > MAX_STUB_BYTES` is the entire mechanism behind the one-step
 * fixed point: a stub must be too small to be elided again. Leaving that as a
 * documented precondition would make `{k: 0, min_bytes: 1}` — a perfectly
 * type-valid policy — silently reintroduce the tail-chasing the old pruner had.
 *
 * Clamped rather than rejected: this runs on the request path, where failing
 * open on a misconfiguration beats throwing at a live client.
 */
function effectiveMinBytes(policy: ElisionPolicy): number {
  return Math.max(policy.min_bytes, MAX_STUB_BYTES + 1);
}

function eligible(
  blockId: string,
  bytes: number,
  userMessagesAfter: number,
  kEff: number,
  minBytes: number,
  policy: ElisionPolicy,
): boolean {
  if (userMessagesAfter < kEff) return false;
  if (bytes < minBytes) return false;
  if (policy.pinned_block_ids?.has(blockId)) return false;
  return true;
}

// ------------------------------------------------------------------ Anthropic

interface AnthropicContentItem {
  type?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

interface AnthropicMessageLike {
  role?: unknown;
  content: unknown;
  [key: string]: unknown;
}

export interface AnthropicTransformable {
  messages: AnthropicMessageLike[];
  [key: string]: unknown;
}

/**
 * Suffix counts: `after[i]` is the number of user messages at an index greater
 * than `i`. Computed once per request rather than per block, so the transform
 * is linear in message count rather than quadratic.
 */
function userMessagesAfterEach(messages: { role?: unknown }[]): number[] {
  const after = new Array<number>(messages.length).fill(0);
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    after[i] = running;
    if (messages[i]?.role === "user") running++;
  }
  return after;
}

export function transformAnthropic<TRequest extends AnthropicTransformable>(
  request: TRequest,
  policy: ElisionPolicy = DEFAULT_ELISION_POLICY,
): TransformResult<TRequest> {
  const messages = request.messages;
  const userCount = messages.reduce(
    (n, m) => (m?.role === "user" ? n + 1 : n),
    0,
  );
  const band = elisionBand(userCount);
  const kEff = effectiveK(band, policy);
  const minBytes = effectiveMinBytes(policy);
  const after = userMessagesAfterEach(messages);

  const decisions: ElisionDecision[] = [];
  // Copy-on-write: only messages that actually change are cloned, so an
  // untouched request costs one array copy rather than a deep clone of the
  // whole history. The input is never mutated either way (I1).
  let outMessages: AnthropicMessageLike[] | undefined;

  for (let mi = 0; mi < messages.length; mi++) {
    const message = messages[mi];
    // Claude Code sends plain-string content for simple user turns; a string
    // can never hold a tool_result, so there is nothing to consider.
    if (!message || !Array.isArray(message.content)) continue;

    const content = message.content as AnthropicContentItem[];
    let outContent: AnthropicContentItem[] | undefined;

    for (let ci = 0; ci < content.length; ci++) {
      const item = content[ci];
      if (!item || item.type !== "tool_result") continue;
      const blockId =
        typeof item.tool_use_id === "string" ? item.tool_use_id : undefined;
      if (blockId === undefined) continue;

      const bytes = contentBytes(item.content);
      if (!eligible(blockId, bytes, after[mi] ?? 0, kEff, minBytes, policy)) continue;

      const stub = formatElisionStub(blockId, bytes);
      outContent ??= content.slice();
      outContent[ci] = { ...item, content: stub };
      decisions.push({
        block_id: blockId,
        message_index: mi,
        content_index: ci,
        original_bytes: bytes,
        stub_bytes: Buffer.byteLength(stub, "utf8"),
      });
    }

    if (outContent !== undefined) {
      outMessages ??= messages.slice();
      outMessages[mi] = { ...message, content: outContent };
    }
  }

  const body =
    outMessages === undefined
      ? request
      : ({ ...request, messages: outMessages } as TRequest);

  return { body, decisions, band, k_eff: kEff };
}

// --------------------------------------------------------------------- OpenAI

interface OpenAIMessageLike {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  [key: string]: unknown;
}

export interface OpenAITransformable {
  messages: OpenAIMessageLike[];
  [key: string]: unknown;
}

/**
 * Chat-completions shape: a tool output is a whole `role:"tool"` message whose
 * `content` is the payload. The message itself must survive — the API requires
 * one tool message per `tool_calls` id in the preceding assistant message — so
 * only `content` is replaced.
 */
export function transformOpenAI<TRequest extends OpenAITransformable>(
  request: TRequest,
  policy: ElisionPolicy = DEFAULT_ELISION_POLICY,
): TransformResult<TRequest> {
  const messages = request.messages;
  const userCount = messages.reduce(
    (n, m) => (m?.role === "user" ? n + 1 : n),
    0,
  );
  const band = elisionBand(userCount);
  const kEff = effectiveK(band, policy);
  const minBytes = effectiveMinBytes(policy);
  const after = userMessagesAfterEach(messages);

  const decisions: ElisionDecision[] = [];
  let outMessages: OpenAIMessageLike[] | undefined;

  for (let mi = 0; mi < messages.length; mi++) {
    const message = messages[mi];
    if (!message || message.role !== "tool") continue;
    const blockId =
      typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
    if (blockId === undefined) continue;

    const bytes = contentBytes(message.content);
    if (!eligible(blockId, bytes, after[mi] ?? 0, kEff, minBytes, policy)) continue;

    const stub = formatElisionStub(blockId, bytes);
    outMessages ??= messages.slice();
    outMessages[mi] = { ...message, content: stub };
    decisions.push({
      block_id: blockId,
      message_index: mi,
      content_index: 0,
      original_bytes: bytes,
      stub_bytes: Buffer.byteLength(stub, "utf8"),
    });
  }

  const body =
    outMessages === undefined
      ? request
      : ({ ...request, messages: outMessages } as TRequest);

  return { body, decisions, band, k_eff: kEff };
}
