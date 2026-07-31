import { describe, expect, it, vi } from "vitest";
import { fetchWithRateLimitRetry } from "../../../scripts/lib/rate-limit-retry.mjs";

function response(status: number, retryAfter?: string): Response {
  return new Response("{}", {
    status,
    headers: retryAfter ? { "retry-after": retryAfter } : undefined,
  });
}

describe("fetchWithRateLimitRetry", () => {
  it("aborts after the configured number of persistent 429 retries", async () => {
    const fetchOnce = vi.fn(async () => response(429, "0.001"));
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await expect(fetchWithRateLimitRetry(fetchOnce, { maxRetries: 2, sleep, onRetry }))
      .rejects.toThrow("persisted after 3 attempts");
    expect(fetchOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
    expect(sleep).toHaveBeenNthCalledWith(2, 1);
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 1, maxRetries: 2, backoffMs: 1 });
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 2, maxRetries: 2, backoffMs: 1 });
  });

  it("returns the first non-429 response after bounded backoff", async () => {
    const fetchOnce = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn(async () => undefined);

    const result = await fetchWithRateLimitRetry(fetchOnce, { maxRetries: 2, sleep });

    expect(result.status).toBe(200);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });
});
