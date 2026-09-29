/**
 * A small fixed-window, per-key (client IP) request limiter for the OIDC
 * start route. The app has no other HTTP rate limiter; password sign-in is
 * protected by the per-account lockout instead (AuthService).
 */
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request for `key`; false once the key is over its limit in the current window. */
  allow(key: string): boolean {
    const now = this.now();
    if (this.hits.size > 10_000) this.prune(now);
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
