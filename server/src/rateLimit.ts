/**
 * Counts failed attempts per client IP in a fixed window, in memory. Only failures count, because a whole class shares
 * the college's one public IP: students playing normally never fail, but someone guessing codes or passwords does.
 * Once an IP has had `max` failures it's refused, even with the right code, until its window ends.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the IP may try again, or 0 if it isn't blocked. */
  retryAfter(ip: string) {
    const hit = this.current(ip);
    return hit && hit.count >= this.max ? Math.ceil((hit.resetAt - this.now()) / 1000) : 0;
  }

  fail(ip: string) {
    const hit = this.current(ip);
    if (hit) hit.count++;
    else this.hits.set(ip, { count: 1, resetAt: this.now() + this.windowMs });
    if (this.hits.size > 10_000) this.sweep();
  }

  private current(ip: string) {
    const hit = this.hits.get(ip);
    if (hit && hit.resetAt <= this.now()) {
      this.hits.delete(ip);
      return undefined;
    }
    return hit;
  }

  private sweep() {
    const now = this.now();
    for (const [ip, hit] of this.hits) if (hit.resetAt <= now) this.hits.delete(ip);
  }
}
