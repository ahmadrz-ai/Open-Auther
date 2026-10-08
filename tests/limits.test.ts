import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/api/limits.js";

describe("gateway rate limiter", () => {
  it("allows the configured burst and then asks the caller to retry", () => {
    const limiter = new RateLimiter(60, 2);
    expect(limiter.take("client", 0)).toMatchObject({ ok: true, remaining: 1 });
    expect(limiter.take("client", 0)).toMatchObject({ ok: true, remaining: 0 });
    expect(limiter.take("client", 0)).toMatchObject({ ok: false, retryAfter: 1 });
  });

  it("refills continuously and keeps clients in separate buckets", () => {
    const limiter = new RateLimiter(60, 1);
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 500).ok).toBe(false);
    expect(limiter.take("a", 1000).ok).toBe(true);
    expect(limiter.take("b", 0).ok).toBe(true);
  });

  it("can be disabled with a zero rate", () => {
    const limiter = new RateLimiter(0, 1);
    expect(limiter.take("client", 0).ok).toBe(true);
    expect(limiter.take("client", 0).ok).toBe(true);
  });
});
