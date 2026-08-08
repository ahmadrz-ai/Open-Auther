/**
 * OpenAI-shaped error envelopes.
 *
 * Clients parse `error.message`, `error.type` and `error.code`; returning a
 * bare string or a Hono default breaks them in confusing ways.
 */

import type { Context } from "hono";

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export function openaiError(
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): OpenAIErrorBody {
  return { error: { message, type, param, code } };
}

export function errorResponse(
  c: Context,
  status: number,
  message: string,
  type: string,
  code: string | null = null,
  headers: Record<string, string> = {},
) {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  // Hono's typed status union does not cover every integer we may return.
  return c.json(openaiError(message, type, code), status as 400);
}
