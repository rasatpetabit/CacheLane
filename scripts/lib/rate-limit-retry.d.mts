export interface RateLimitRetryOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (event: { attempt: number; maxRetries: number; backoffMs: number }) => void;
}

export function fetchWithRateLimitRetry(
  fetchOnce: () => Promise<Response>,
  options?: RateLimitRetryOptions,
): Promise<Response>;
