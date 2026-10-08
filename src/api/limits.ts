/** Small in-memory token-bucket limiter for a single gateway process. */

import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Config } from "../config.js";
import { errorResponse } from "./errors.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
  ) {}

  take(key: string, at = Date.now()): { ok: boolean; remaining: number; retryAfter: number } {
    if (this.perMinute <= 0) return { ok: true, remaining: this.burst, retryAfter: 0 };
    const refillPerMs = this.perMinute / 60_000;
    const previous = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: at };
    const tokens = Math.min(this.burst, previous.tokens + (at - previous.updatedAt) * refillPerMs);
    if (tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000));
      this.buckets.set(key, { tokens, updatedAt: at });
      return { ok: false, remaining: 0, retryAfter };
    }
    const remaining = Math.floor(tokens - 1);
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: at });
    if (this.buckets.size > 4096) this.sweep(at);
    return { ok: true, remaining, retryAfter: 0 };
  }

  private sweep(at: number): void {
    const staleBefore = at - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < staleBefore) this.buckets.delete(key);
    }
  }
}

function remoteAddress(c: Context): string {
  // Use the actual socket address. Trusting a caller-controlled
  // X-Forwarded-For header would let clients evade the limiter by creating a
  // new bucket on every request. A deployment behind a trusted proxy should
  // terminate rate limiting there or add an explicit trusted-proxy adapter.
  try {
    return getConnInfo(c).remote.address ?? "direct";
  } catch {
    // Fetch-based tests and non-Node adapters may not expose a socket.
    return "direct";
  }
}

export function rateLimitMiddleware(
  cfg: Config,
  limiter = new RateLimiter(cfg.rateLimitPerMinute, cfg.rateLimitBurst),
) {
  return async (c: Context, next: Next) => {
    const client = c.get("clientName") ?? "anonymous";
    const result = limiter.take(`${client}:${remoteAddress(c)}`);
    c.header("x-ratelimit-limit", String(cfg.rateLimitBurst));
    c.header("x-ratelimit-remaining", String(result.remaining));
    if (!result.ok) {
      c.header("retry-after", String(result.retryAfter));
      return errorResponse(
        c,
        429,
        "Gateway rate limit exceeded. Retry after the indicated delay.",
        "rate_limit_error",
        "gateway_rate_limited",
      );
    }
    await next();
  };
}
