/** Daily admission budgets; token usage is settled independently of request logs. */

import type { Context, Next } from "hono";
import { now } from "../db.js";
import type { CredentialStore } from "../pool/store.js";
import type { CodexEvent } from "../upstream/translate.js";
import { errorResponse } from "./errors.js";

const DAY = 86_400;

interface GatewayAccounting {
  day: number;
  client: string;
  tokenLimit: number | null;
  deferred: boolean;
  settled: boolean;
  release: () => void;
}

declare module "hono" {
  interface ContextVariableMap {
    gatewayAccounting: GatewayAccounting;
  }
}

export const dailyUsageEpoch = (epoch = now()): number => Math.floor(epoch / DAY) * DAY;

/** Only real inference entry points count; admin operations and probes do not. */
export function isBudgetedInference(path: string): boolean {
  return ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/v1/messages"].includes(path)
    || /^\/admin\/chat\/conversations\/[^/]+\/send$/.test(path);
}

export function budgetMiddleware(store: CredentialStore) {
  // Token totals are learned at completion. Serialize token-budgeted requests
  // for each key in this gateway process so parallel streams cannot all pass
  // the same pre-completion usage check. Other keys retain normal concurrency.
  const active = new Set<string>();
  return async (c: Context, next: Next) => {
    if (c.req.method !== "POST" || !isBudgetedInference(new URL(c.req.url).pathname)) {
      await next();
      return;
    }
    const key = c.get("gatewayKey");
    if (!key) { await next(); return; }
    const tokenLimit = key.maxTokensPerDay ?? null;
    if (active.has(key.name)) {
      return errorResponse(c, 429, "A token-budgeted request for this key is still running. Retry when it completes.",
        "rate_limit_error", "token_budget_in_flight", { "retry-after": "1" });
    }

    const at = now();
    const day = dailyUsageEpoch(at);
    const usage = store.consumeGatewayRequest(key.name, day, key.maxRequestsPerDay ?? null, tokenLimit);
    c.header("x-ai-auther-budget-requests", `${usage.requests}${key.maxRequestsPerDay == null ? "" : `/${key.maxRequestsPerDay}`}`);
    c.header("x-ai-auther-budget-tokens", `${usage.tokens}${tokenLimit === null ? "" : `/${tokenLimit}`}`);
    if (!usage.allowed) {
      return errorResponse(c, 429, `This gateway key has reached its daily ${usage.reason === "tokens" ? "token" : "request"} budget. Try again after 00:00 UTC.`,
        "rate_limit_error", usage.reason === "tokens" ? "token_budget_exceeded" : "request_budget_exceeded",
        { "retry-after": String(day + DAY - at) });
    }

    if (tokenLimit !== null) active.add(key.name);
    const accounting: GatewayAccounting = {
      client: key.name, day, tokenLimit, deferred: false, settled: false,
      release: () => active.delete(key.name),
    };
    c.set("gatewayAccounting", accounting);
    try {
      await next();
    } finally {
      // Streaming handlers own settlement until their generator/meter ends.
      if (!accounting.deferred) settleGatewayUsage(c, store, 0);
    }
  };
}

/** Mark a response whose usage will arrive after the HTTP handler returns. */
export function deferGatewayUsage(c: Context): void {
  const accounting = c.get("gatewayAccounting");
  if (accounting) accounting.deferred = true;
}

/** Exactly-once settlement, charged to the UTC day on which admission occurred. */
export function settleGatewayUsage(c: Context, store: CredentialStore, tokens: number | null): void {
  const accounting = c.get("gatewayAccounting");
  if (!accounting || accounting.settled) return;
  try {
    // Without upstream usage we cannot safely offer more token-budgeted calls.
    // Exhaust the remaining daily allowance rather than silently charging zero.
    const charge = tokens ?? (accounting.tokenLimit === null ? 0
      : Math.max(0, accounting.tokenLimit - store.gatewayUsage(accounting.client, accounting.day).tokens));
    store.addGatewayTokens(accounting.client, accounting.day, charge);
    accounting.settled = true;
  } finally {
    accounting.release();
  }
}

/** Collect provider-reported usage even on errors or abandoned streams. */
export function meterGatewayEvents(c: Context, store: CredentialStore, events: AsyncGenerator<CodexEvent>): AsyncGenerator<CodexEvent> {
  deferGatewayUsage(c);
  return (async function* () {
    let total: number | null = null;
    try {
      for await (const event of events) {
        if (event.kind === "usage") {
          const reported = event.usage.total_tokens;
          if (Number.isSafeInteger(reported) && reported >= 0) total = Math.max(total ?? 0, reported);
        }
        yield event;
      }
    } finally {
      settleGatewayUsage(c, store, total);
    }
  })();
}

/** Cap every accepted token field, rejecting malformed values rather than coercing them. */
export function capOutputTokens(body: object, fields: string[], limit: number | null): void {
  if (limit === null) return;
  const values = body as Record<string, unknown>;
  for (const field of fields) {
    const requested = values[field];
    if (requested !== undefined && (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)) {
      throw new Error(`${field} must be a positive safe integer.`);
    }
    values[field] = Math.min(requested as number ?? limit, limit);
  }
}
