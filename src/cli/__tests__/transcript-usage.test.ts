import { describe, expect, test } from "vitest";
import {
  parseTranscriptApiCalls,
  type TranscriptApiCall,
} from "../transcript-usage.js";

const FALLBACK_MS = 1_700_000_000_000;

function assistantLine(opts: {
  id: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  timestamp?: string | number | null;
}): string {
  const entry: Record<string, unknown> = {
    type: "assistant",
    message: {
      id: opts.id,
      role: "assistant",
      model: opts.model ?? "claude-opus-4-1",
      ...(opts.usage === null ? {} : { usage: opts.usage }),
    },
  };
  if (opts.timestamp !== undefined && opts.timestamp !== null) {
    entry.timestamp = opts.timestamp;
  } else if (opts.timestamp === null) {
    // explicitly omit
  }
  return JSON.stringify(entry);
}

describe("parseTranscriptApiCalls", () => {
  test("reads nested cache_creation tiers and ISO timestamps", () => {
    const usage = {
      input_tokens: 2,
      output_tokens: 18,
      cache_creation_input_tokens: 4_000,
      cache_read_input_tokens: 40_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 4_000,
      },
    };
    const content = assistantLine({
      id: "msg_nested",
      usage,
      timestamp: "2026-08-04T01:44:56.194Z",
    });

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);

    expect(calls).toHaveLength(1);
    const call: TranscriptApiCall = calls[0]!;
    expect(call.id).toBe("msg_nested");
    expect(call.input_tokens).toBe(2);
    expect(call.output_tokens).toBe(18);
    expect(call.cache_creation_5m_tokens).toBe(0);
    expect(call.cache_creation_1h_tokens).toBe(4_000);
    expect(call.cache_read_tokens).toBe(40_000);
    expect(call.created_at).toBe(Date.parse("2026-08-04T01:44:56.194Z"));
  });

  test("accepts numeric timestamps", () => {
    const ts = 1_722_740_000_000;
    const content = assistantLine({
      id: "msg_numeric_ts",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 0,
      },
      timestamp: ts,
    });

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.created_at).toBe(ts);
  });

  test("falls back to legacy top-level cache-tier fields", () => {
    const content = assistantLine({
      id: "msg_legacy",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 1_000,
        cache_creation_5m_tokens: 800,
        cache_creation_1h_tokens: 200,
        cache_read_tokens: 50,
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cache_creation_5m_tokens).toBe(800);
    expect(calls[0]!.cache_creation_1h_tokens).toBe(200);
    expect(calls[0]!.cache_read_tokens).toBe(50);
  });

  test("skips malformed JSONL lines", () => {
    const content = [
      "{not-json",
      assistantLine({
        id: "msg_ok",
        usage: { input_tokens: 1, output_tokens: 1 },
        timestamp: 100,
      }),
      "",
      "null",
    ].join("\n");

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("msg_ok");
  });

  test("skips assistant entries without usage", () => {
    const content = [
      assistantLine({ id: "msg_no_usage", usage: null, timestamp: 1 }),
      assistantLine({
        id: "msg_with_usage",
        usage: { input_tokens: 3, output_tokens: 4 },
        timestamp: 2,
      }),
    ].join("\n");

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("msg_with_usage");
  });

  test("uses supplied fallback for invalid or missing timestamps", () => {
    const content = [
      assistantLine({
        id: "msg_bad_ts",
        usage: { input_tokens: 1, output_tokens: 1 },
        timestamp: "not-a-date",
      }),
      JSON.stringify({
        message: {
          id: "msg_missing_ts",
          role: "assistant",
          model: "claude-opus-4-1",
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }),
    ].join("\n");

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.created_at).toBe(FALLBACK_MS);
    expect(calls[1]!.created_at).toBe(FALLBACK_MS);
  });
});
