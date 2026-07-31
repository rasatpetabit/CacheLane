export async function fetchWithRateLimitRetry(
  fetchOnce,
  {
    maxRetries = 2,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => undefined,
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchOnce();
    if (response.status !== 429) return response;
    if (attempt >= maxRetries) {
      throw new Error(`Anthropic rate limit persisted after ${attempt + 1} attempts; aborting experiment`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 30_000 * (attempt + 1);
    onRetry({ attempt: attempt + 1, maxRetries, backoffMs });
    await sleep(backoffMs);
  }
}
