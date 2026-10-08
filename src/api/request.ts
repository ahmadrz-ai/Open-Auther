/** Request correlation and coarse HTTP boundary protection. */

import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "../config.js";
import { errorResponse } from "./errors.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const supplied = c.req.header("x-request-id")?.trim();
    const id = supplied && SAFE_REQUEST_ID.test(supplied)
      ? supplied
      : `req_${randomUUID().replace(/-/g, "")}`;
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}

/** Reject oversized requests before JSON parsing or base64 decoding. */
export function requestSizeLimit(cfg: Config) {
  return bodyLimit({
    maxSize: cfg.maxRequestBytes,
    onError: (c) => errorResponse(
      c,
      413,
      `Request body exceeds the ${Math.ceil(cfg.maxRequestBytes / 1048576)} MB gateway limit.`,
      "invalid_request_error",
      "request_too_large",
      { "retry-after": "0" },
    ),
  });
}
