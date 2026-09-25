/**
 * HTTP helpers shared by the version-specific PTV clients and adapters.
 * Nothing here knows a PTV wire shape.
 */

/** Concurrent page (or item) requests an adapter keeps in flight while scanning a list. */
export const PAGE_FETCH_CONCURRENCY = 6;

/** 429 and 5xx are worth retrying; any other failure is final. */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Retry-After (in seconds) when PTV sends one, otherwise exponential
 * backoff from 250 ms with up to 25 % jitter.
 */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const base = 250 * 2 ** attempt;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a client error is PTV answering 404 (both clients' errors carry `status`). */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status: unknown }).status === 404;
}

/**
 * `Promise.all(items.map(fn))` with at most `concurrency` calls in flight.
 * Results keep the order of `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(0, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}
