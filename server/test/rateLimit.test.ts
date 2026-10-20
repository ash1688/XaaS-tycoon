import { describe, expect, it } from "vitest";
import { FailureLimiter } from "../src/rateLimit.ts";

describe("FailureLimiter", () => {
  it("blocks after max failures and lets the IP back in when the window ends", () => {
    let now = 0;
    const limiter = new FailureLimiter(2, 60_000, () => now);
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(60);
    expect(limiter.retryAfter("b")).toBe(0);
    now = 59_000;
    expect(limiter.retryAfter("a")).toBe(1);
    now = 60_000;
    expect(limiter.retryAfter("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(0);
  });
});
