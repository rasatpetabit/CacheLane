export interface TranscriptApiCall {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
  created_at: number;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseCreatedAt(
  timestamp: unknown,
  fallbackTimestampMs: number,
): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackTimestampMs;
}

function readCacheCreationTiers(
  usage: Record<string, unknown>,
): { fiveMinute: number; oneHour: number } {
  const nested = usage.cache_creation;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    return {
      fiveMinute: asNumber(nestedRecord.ephemeral_5m_input_tokens),
      oneHour: asNumber(nestedRecord.ephemeral_1h_input_tokens),
    };
  }

  // Legacy top-level fields. Prefer explicit tier fields.
  // - No explicit tiers: total → historical 5m fallback.
  // - Exactly one explicit tier: derive the missing tier as
  //   max(0, total - explicitTier) so mixed total+1h / total+5m shapes
  //   do not undercount or double-count.
  // - Both explicit: use both as-is (total is ignored).
  const explicitFiveMinute =
    usage.ephemeral_5m_input_tokens ?? usage.cache_creation_5m_tokens;
  const explicitOneHour =
    usage.ephemeral_1h_input_tokens ?? usage.cache_creation_1h_tokens;
  const hasExplicitFiveMinute = explicitFiveMinute !== undefined;
  const hasExplicitOneHour = explicitOneHour !== undefined;
  const total = asNumber(usage.cache_creation_input_tokens);

  if (!hasExplicitFiveMinute && !hasExplicitOneHour) {
    return { fiveMinute: total, oneHour: 0 };
  }

  if (hasExplicitFiveMinute && !hasExplicitOneHour) {
    const fiveMinute = asNumber(explicitFiveMinute);
    return {
      fiveMinute,
      oneHour: Math.max(0, total - fiveMinute),
    };
  }

  if (!hasExplicitFiveMinute && hasExplicitOneHour) {
    const oneHour = asNumber(explicitOneHour);
    return {
      fiveMinute: Math.max(0, total - oneHour),
      oneHour,
    };
  }

  return {
    fiveMinute: asNumber(explicitFiveMinute),
    oneHour: asNumber(explicitOneHour),
  };
}

/**
 * Parse Claude Code JSONL transcript content for assistant usage records.
 * Pure: no Date.now(), no IO. Invalid timestamps use the caller-supplied fallback.
 */
export function parseTranscriptApiCalls(
  content: string,
  fallbackTimestampMs: number,
): TranscriptApiCall[] {
  const calls: TranscriptApiCall[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg || msg.role !== "assistant" || !msg.id || !msg.usage) continue;
      if (typeof msg.usage !== "object" || msg.usage === null) continue;

      const usage = msg.usage as Record<string, unknown>;
      const tiers = readCacheCreationTiers(usage);

      calls.push({
        id: String(msg.id),
        model: typeof msg.model === "string" ? msg.model : "",
        input_tokens: asNumber(usage.input_tokens),
        output_tokens: asNumber(usage.output_tokens),
        cache_creation_5m_tokens: tiers.fiveMinute,
        cache_creation_1h_tokens: tiers.oneHour,
        cache_read_tokens: asNumber(
          usage.cache_read_input_tokens ?? usage.cache_read_tokens,
        ),
        created_at: parseCreatedAt(entry.timestamp, fallbackTimestampMs),
      });
    } catch {
      // Skip malformed lines — fail-open.
    }
  }

  return calls;
}
