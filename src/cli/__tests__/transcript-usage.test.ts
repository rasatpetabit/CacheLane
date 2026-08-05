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

  test("maps total-only legacy cache_creation_input_tokens to historical 5m fallback", () => {
    const content = assistantLine({
      id: "msg_legacy_total_only",
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_creation_input_tokens: 4_000,
        cache_read_input_tokens: 40_000,
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cache_creation_5m_tokens).toBe(4_000);
    expect(calls[0]!.cache_creation_1h_tokens).toBe(0);
    expect(calls[0]!.cache_read_tokens).toBe(40_000);
  });

  test.each([
    {
      name: "ephemeral_1h_input_tokens",
      oneHourField: "ephemeral_1h_input_tokens" as const,
    },
    {
      name: "cache_creation_1h_tokens",
      oneHourField: "cache_creation_1h_tokens" as const,
    },
  ])(
    "does not map total into 5m when only explicit 1h exists ($name)",
    ({ oneHourField }) => {
      const content = assistantLine({
        id: `msg_legacy_total_plus_${oneHourField}`,
        usage: {
          input_tokens: 2,
          output_tokens: 18,
          cache_creation_input_tokens: 4_000,
          cache_read_input_tokens: 40_000,
          [oneHourField]: 4_000,
        },
        timestamp: "2026-08-04T01:44:56.194Z",
      });

      const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cache_creation_5m_tokens).toBe(0);
      expect(calls[0]!.cache_creation_1h_tokens).toBe(4_000);
      expect(calls[0]!.cache_read_tokens).toBe(40_000);
    },
  );

  test.each([
    {
      name: "total+explicit 1h derives missing 5m",
      total: 5_000,
      fiveMinuteField: undefined as string | undefined,
      fiveMinuteValue: undefined as number | undefined,
      oneHourField: "ephemeral_1h_input_tokens" as const,
      oneHourValue: 4_000,
      expectedFiveMinute: 1_000,
      expectedOneHour: 4_000,
    },
    {
      name: "total+explicit 1h (cache_creation_1h_tokens) derives missing 5m",
      total: 5_000,
      fiveMinuteField: undefined as string | undefined,
      fiveMinuteValue: undefined as number | undefined,
      oneHourField: "cache_creation_1h_tokens" as const,
      oneHourValue: 4_000,
      expectedFiveMinute: 1_000,
      expectedOneHour: 4_000,
    },
    {
      name: "total+explicit 5m derives missing 1h",
      total: 5_000,
      fiveMinuteField: "ephemeral_5m_input_tokens" as const,
      fiveMinuteValue: 1_000,
      oneHourField: undefined as string | undefined,
      oneHourValue: undefined as number | undefined,
      expectedFiveMinute: 1_000,
      expectedOneHour: 4_000,
    },
    {
      name: "total+explicit 5m (cache_creation_5m_tokens) derives missing 1h",
      total: 5_000,
      fiveMinuteField: "cache_creation_5m_tokens" as const,
      fiveMinuteValue: 1_000,
      oneHourField: undefined as string | undefined,
      oneHourValue: undefined as number | undefined,
      expectedFiveMinute: 1_000,
      expectedOneHour: 4_000,
    },
  ])(
    "derives missing tier from total when exactly one explicit tier exists ($name)",
    ({
      name,
      total,
      fiveMinuteField,
      fiveMinuteValue,
      oneHourField,
      oneHourValue,
      expectedFiveMinute,
      expectedOneHour,
    }) => {
      const usage: Record<string, unknown> = {
        input_tokens: 2,
        output_tokens: 18,
        cache_creation_input_tokens: total,
        cache_read_input_tokens: 40_000,
      };
      if (fiveMinuteField !== undefined) {
        usage[fiveMinuteField] = fiveMinuteValue;
      }
      if (oneHourField !== undefined) {
        usage[oneHourField] = oneHourValue;
      }

      const content = assistantLine({
        id: `msg_derive_${name.replace(/\s+/g, "_")}`,
        usage,
        timestamp: "2026-08-04T01:44:56.194Z",
      });

      const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cache_creation_5m_tokens).toBe(expectedFiveMinute);
      expect(calls[0]!.cache_creation_1h_tokens).toBe(expectedOneHour);
    },
  );

  test.each([
    {
      name: "total smaller than explicit 1h",
      total: 1_000,
      fiveMinuteField: undefined as string | undefined,
      fiveMinuteValue: undefined as number | undefined,
      oneHourField: "ephemeral_1h_input_tokens" as const,
      oneHourValue: 4_000,
      expectedFiveMinute: 0,
      expectedOneHour: 4_000,
    },
    {
      name: "total smaller than explicit 5m",
      total: 500,
      fiveMinuteField: "ephemeral_5m_input_tokens" as const,
      fiveMinuteValue: 1_000,
      oneHourField: undefined as string | undefined,
      oneHourValue: undefined as number | undefined,
      expectedFiveMinute: 1_000,
      expectedOneHour: 0,
    },
  ])(
    "never creates negative tokens when total is smaller than explicit tier ($name)",
    ({
      name,
      total,
      fiveMinuteField,
      fiveMinuteValue,
      oneHourField,
      oneHourValue,
      expectedFiveMinute,
      expectedOneHour,
    }) => {
      const usage: Record<string, unknown> = {
        input_tokens: 2,
        output_tokens: 18,
        cache_creation_input_tokens: total,
        cache_read_input_tokens: 40_000,
      };
      if (fiveMinuteField !== undefined) {
        usage[fiveMinuteField] = fiveMinuteValue;
      }
      if (oneHourField !== undefined) {
        usage[oneHourField] = oneHourValue;
      }

      const content = assistantLine({
        id: `msg_no_neg_${name.replace(/\s+/g, "_")}`,
        usage,
        timestamp: "2026-08-04T01:44:56.194Z",
      });

      const calls = parseTranscriptApiCalls(content, FALLBACK_MS);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cache_creation_5m_tokens).toBe(expectedFiveMinute);
      expect(calls[0]!.cache_creation_1h_tokens).toBe(expectedOneHour);
      expect(calls[0]!.cache_creation_5m_tokens).toBeGreaterThanOrEqual(0);
      expect(calls[0]!.cache_creation_1h_tokens).toBeGreaterThanOrEqual(0);
    },
  );

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
