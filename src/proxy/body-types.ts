/**
 * Layer 2 — telling the two request bodies apart at the type level.
 *
 * The proxy holds two buffers per turn that are easy to confuse because they
 * have the same type and usually the same contents:
 *
 *   - the **forward** body, sent upstream, possibly with tool output elided;
 *   - the **original** body, exactly as the client sent it.
 *
 * `proxyAndRecord` used to take one `body: Buffer`, forward it, and then hand
 * that same buffer to `extractAndInsertToolResults`. With mutation on, the
 * recorder therefore ingested CacheLane's own stubs as if they were the tool
 * output the client had sent — the ledger recorded the transform's output as
 * its input. That is the concrete form of the I1 violation: a transform whose
 * output is its own input has no fixed point anyone chose.
 *
 * Branding them as distinct nominal types makes the mix-up a compile error
 * rather than a silent corruption that only shows up as nonsense in the
 * database several turns later.
 *
 * The brands are erased at runtime: these are the same Buffers, costing
 * nothing. The one remaining hole is calling `asOriginalBody` on a forwarded
 * buffer — a cast can always be written. It is deliberately a named, greppable
 * function for that reason: `asOriginalBody` should appear exactly where a body
 * genuinely is the client's, and nowhere else.
 */

declare const FORWARD_BRAND: unique symbol;
declare const ORIGINAL_BRAND: unique symbol;

/** The bytes actually sent upstream. May have tool output elided. Never recorded. */
export type ForwardBody = Buffer & { readonly [FORWARD_BRAND]: true };

/** The bytes the client sent. Never forwarded post-mutation; this is what gets recorded. */
export type OriginalBody = Buffer & { readonly [ORIGINAL_BRAND]: true };

/** Mark a buffer as the one going upstream. */
export function asForwardBody(buffer: Buffer): ForwardBody {
  return buffer as ForwardBody;
}

/**
 * Mark a buffer as the client's own request.
 *
 * Only ever call this on the body as received. Passing a mutated buffer here
 * reintroduces exactly the bug the branding exists to prevent.
 */
export function asOriginalBody(buffer: Buffer): OriginalBody {
  return buffer as OriginalBody;
}
