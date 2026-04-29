import type { AppConfig, PeerFailure } from "../core/types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  config: AppConfig,
  run: (attempt: number) => Promise<T>,
  onFailure: (error: unknown, attempt: number, started: number) => PeerFailure,
): Promise<T> {
  const started = Date.now();
  let last: PeerFailure | null = null;
  for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      last = onFailure(error, attempt, started);
      if (!last.retryable || attempt >= config.retry.max_attempts) throw error;
      const wait = Math.min(
        config.retry.max_delay_ms,
        config.retry.base_delay_ms * 2 ** (attempt - 1),
      );
      await delay(last.retry_after_ms ?? wait);
    }
  }
  throw new Error(last?.message ?? "retry loop exhausted");
}
