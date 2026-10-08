/**
 * Gateway authentication.
 *
 * Multiple named keys so each client (Cursor, an agent, a script) can be
 * revoked independently. Logs carry the key *name*; the key itself is
 * registered as a secret and can never reach log output.
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { Config } from "../config.js";
import { keyHasScope, normaliseKey, type GatewayKey, type GatewayScope } from "../core/keys.js";
import { errorResponse } from "./errors.js";

declare module "hono" {
  interface ContextVariableMap {
    clientName: string;
    /** The matched key, so routes can apply its model policy. */
    gatewayKey: GatewayKey;
    requestId: string;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare lengths in a way that still runs the full comparison, so timing
  // does not leak key length.
  if (ba.length !== bb.length) {
    const padded = Buffer.alloc(Math.max(ba.length, bb.length));
    const other = Buffer.alloc(Math.max(ba.length, bb.length));
    ba.copy(padded);
    bb.copy(other);
    timingSafeEqual(padded, other);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function findKey(keys: GatewayKey[], presented: string): GatewayKey | null {
  let match: GatewayKey | null = null;
  for (const k of keys) {
    // No early exit: every key is compared so timing does not reveal position.
    if (constantTimeEqual(k.key, presented)) match = k;
  }
  return match;
}

function presentedKey(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  // Some OpenAI-compatible clients send the key this way instead.
  const alt = c.req.header("x-api-key");
  if (alt) return alt.trim();
  return null;
}

export function gatewayAuth(cfg: Config) {
  return async (c: Context, next: Next) => {
    const presented = presentedKey(c);
    if (!presented) {
      return errorResponse(
        c,
        401,
        "Missing API key. Send it as `Authorization: Bearer <key>`.",
        "invalid_request_error",
        "missing_api_key",
        { "www-authenticate": "Bearer" },
      );
    }

    const key = findKey(cfg.gatewayKeys, presented);
    if (!key) {
      return errorResponse(
        c,
        401,
        "Invalid API key.",
        "invalid_request_error",
        "invalid_api_key",
        { "www-authenticate": "Bearer" },
      );
    }

    const normalised = normaliseKey(key);
    if (typeof normalised.expiresAt === "number" && normalised.expiresAt <= Math.floor(Date.now() / 1000)) {
      return errorResponse(
        c,
        401,
        "API key has expired.",
        "invalid_request_error",
        "expired_api_key",
        { "www-authenticate": "Bearer" },
      );
    }

    const path = new URL(c.req.url).pathname;
    const scope: GatewayScope = path.startsWith("/admin/")
      ? /\/logs(?:\/|$)|\/stats(?:\/|$)|\/events(?:\/|$)|\/health\/detail|\/runtime/.test(path)
        ? "logs:read"
        : /\/settings(?:\/|$)/.test(path) && c.req.method !== "GET"
          ? "settings:write"
          : /\/models(?:\/|$)/.test(path) && c.req.method === "GET"
            ? "models:read"
            : "admin"
      : c.req.method === "GET" && /\/models(?:\/|$)/.test(path)
        ? "models:read"
        : "inference";
    if (!keyHasScope(normalised, scope)) {
      return errorResponse(
        c,
        403,
        `This API key does not have the ${scope} scope.`,
        "invalid_request_error",
        "insufficient_scope",
      );
    }

    c.set("clientName", key.name);
    c.set("gatewayKey", normalised);
    await next();
  };
}
