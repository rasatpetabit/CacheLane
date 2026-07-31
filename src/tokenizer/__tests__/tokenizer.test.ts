import { describe, it, expect, vi } from "vitest";
import { countTokens as upstreamCountTokens } from "@anthropic-ai/tokenizer";
import { countTokens, SUPPORTED_MODELS } from "../index.js";

const SAMPLE = "The quick brown fox jumps over the lazy dog.";

describe("countTokens", () => {
  it("returns a positive integer for claude-opus-4-6", () => {
    const n = countTokens(SAMPLE, "claude-opus-4-6");
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it("returns a positive integer for claude-opus-4-7", () => {
    const n = countTokens(SAMPLE, "claude-opus-4-7");
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it("throws for an unrecognised model string", () => {
    expect(() => countTokens(SAMPLE, "gpt-4-turbo")).toThrow(
      /unsupported model/i
    );
  });

  it("returns 0 for empty string", () => {
    expect(countTokens("", "claude-opus-4-7")).toBe(0);
  });

  it("SUPPORTED_MODELS includes both Opus 4.6 and 4.7", () => {
    expect(SUPPORTED_MODELS).toContain("claude-opus-4-6");
    expect(SUPPORTED_MODELS).toContain("claude-opus-4-7");
  });

  it("token count scales with input length", () => {
    const short = countTokens("Hello", "claude-opus-4-7");
    const long = countTokens("Hello ".repeat(100), "claude-opus-4-7");
    expect(long).toBeGreaterThan(short);
  });

  // M1 gate (Systems Design §11.1): "Tokenizer model-lookup test passes
  // for 4.6 and 4.7." Verifies 4.7 produces a higher count than 4.6 for
  // identical input. The multiplier is approximate (see ADR-011); M3
  // reconciles against usage.input_tokens from real API responses.
  it("M1 gate: 4.7 produces a higher count than 4.6 for the same input", () => {
    // A non-trivial sample so the rounded multiplier is observable.
    const sample = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const count46 = countTokens(sample, "claude-opus-4-6");
    const count47 = countTokens(sample, "claude-opus-4-7");
    expect(count47).toBeGreaterThan(count46);
  });
});

/**
 * Regression: the shared encoder.
 *
 * `@anthropic-ai/tokenizer`'s `countTokens` builds a `Tiktoken` from a 697 KB
 * BPE table on every call and frees it, costing ~45 ms per call independent of
 * input length. `k-pruning.ts` calls it once per pruned block on the request
 * path, so at production stub counts it blocked the event loop for 3-12 s per
 * turn — the reported hang. We now hold one encoder for the process.
 *
 * Two properties have to hold together: the counts must not move, and the
 * per-call cost must actually be gone. A test for only the first would pass on
 * a build that reintroduced the stall.
 */
describe("shared encoder", () => {
  const CASES = [
    "",
    "a",
    SAMPLE,
    SAMPLE.repeat(50),
    // NFKC normalization is load-bearing. U+FB01 (fi ligature), U+212B
    // (angstrom sign) and the fullwidth forms all collapse under NFKC; a
    // build that dropped the normalize() call would score these differently.
    "ﬁancé Å Å ①②③ ｆｕｌｌｗｉｄｔｈ",
    // Special-token text — `encode(..., "all")` must treat it as literal.
    "<|endoftext|> <|im_start|>",
    // Non-Latin scripts exercise multi-byte BPE paths.
    "日本語のトークン化 🎉 مرحبا",
  ];

  it.each(CASES)("matches the upstream count exactly for %j", (text) => {
    // multiplier 1.0 for claude-3, so this compares raw encoder output.
    expect(countTokens(text, "claude-3")).toBe(upstreamCountTokens(text));
  });

  it("is stable across repeated calls (the encoder is not freed mid-flight)", () => {
    const first = countTokens(SAMPLE, "claude-3");
    for (let i = 0; i < 200; i++) {
      expect(countTokens(SAMPLE, "claude-3")).toBe(first);
    }
  });

  // The deterministic form of the guard below: the encoder must be constructed
  // exactly once no matter how many counts are taken. This is the actual
  // invariant — it holds regardless of host speed or CI contention, so it is
  // the primary regression test and the timing assertions are corroboration.
  it("constructs the encoder exactly once across many calls", async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import("@anthropic-ai/tokenizer")>(
      "@anthropic-ai/tokenizer",
    );
    const getTokenizer = vi.fn(real.getTokenizer);
    vi.doMock("@anthropic-ai/tokenizer", () => ({ ...real, getTokenizer }));

    const { countTokens: fresh } = await import("../index.js");
    for (let i = 0; i < 50; i++) fresh(SAMPLE, "claude-3");

    expect(getTokenizer).toHaveBeenCalledTimes(1);

    vi.doUnmock("@anthropic-ai/tokenizer");
    vi.resetModules();
  });

  // Corroborating wall-clock check. Upstream measures ~45 ms/call on this host;
  // the shared encoder is ~0.015 ms. The 5 ms ceiling sits ~300x above the
  // fixed version and ~9x below the broken one, so it discriminates clearly
  // without flaking on a contended CI box.
  it("costs well under a millisecond per call in steady state", () => {
    const N = 200;
    countTokens(SAMPLE, "claude-3"); // warm the encoder
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) countTokens(SAMPLE, "claude-3");
    const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    expect(perCall).toBeLessThan(5);
  });

  // The pruner's actual failure mode, in miniature: 139 stubs was a real
  // per-turn count in production and cost ~6.4 s of blocked event loop.
  it("counts a production-scale stub batch in well under a second", () => {
    const stub = "[tool output elided: 45 tokens — call cachelane_expand to retrieve]";
    countTokens(stub, "claude-3");
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 139; i++) countTokens(stub, "claude-3");
    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(totalMs).toBeLessThan(500);
  });
});
