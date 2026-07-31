// The Anthropic Messages API accepts `system` and `message.content` as either a
// block array or a plain string; `content: "hi"` is exactly equivalent to
// `content: [{ type: "text", text: "hi" }]`. Our request types only model the
// array form, so every call site that iterated one of these directly threw a
// TypeError on the string form and made the whole turn fail open.
//
// Normalise to the equivalent single text block rather than dropping to []:
// these values feed the prefix hash, and dropping them would make two requests
// with different string content hash identically — a cache-correctness bug that
// is far worse than the crash it replaces.
export function normalizeBlocks<T>(value: readonly T[] | string | undefined | null): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") return [{ type: "text", text: value } as unknown as T];
  return [];
}
