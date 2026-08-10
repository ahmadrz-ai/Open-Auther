/**
 * Upstream failure classification.
 *
 * Three outcomes matter to the router:
 *   terminal  - the credential is dead. Never retry it, drop it from rotation.
 *   transient - the credential is fine but unavailable now. Cool down, try the next.
 *   client    - the *caller* sent something invalid. Do not rotate; surfacing a
 *               400 to the client is correct, and retrying it would burn the
 *               whole pool on a malformed request.
 */

export type FailureKind = "terminal" | "transient" | "client";

/**
 * Error codes that permanently invalidate a credential. Retrying any of these
 * cannot succeed, and in the case of `refresh_token_reused` a retry actively
 * makes things worse.
 */
export const TERMINAL_CODES = new Set([
  "token_invalidated",
  "token_revoked",
  "invalid_grant",
  "unauthorized_client",
  "refresh_token_reused",
  "invalid_client",
  "access_denied",
  "account_deactivated",
  "insufficient_quota",
  "billing_hard_limit_reached",
]);

export interface UpstreamFailure {
  kind: FailureKind;
  /** HTTP status, or 0 for transport-level errors. */
  status: number;
  /** Machine-readable code from the upstream body when present. */
  code: string | null;
  message: string;
  /** Epoch seconds when the account's quota refills, from `usage_limit_reached`. */
  resetsAt: number | null;
  /** True when upstream explicitly said the usage limit was hit. */
  usageLimited: boolean;
}

/** Pull the various shapes an error code can arrive in out of a parsed body. */
function extractCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [
    b.type,
    b.code,
    b.error,
    (b.error as Record<string, unknown> | undefined)?.code,
    (b.error as Record<string, unknown> | undefined)?.type,
    (b.detail as Record<string, unknown> | undefined)?.type,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0 && c.length < 128) return c;
  }
  return null;
}

function extractMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [
    b.message,
    (b.error as Record<string, unknown> | undefined)?.message,
    typeof b.error === "string" ? b.error : undefined,
    b.detail,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return fallback;
}

function extractResetsAt(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw =
    b.resets_at ??
    b.reset_at ??
    b.resets_in_seconds ??
    (b.error as Record<string, unknown> | undefined)?.resets_at;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;

  // Some fields are absolute epochs, some are relative durations. Anything
  // below ~1e9 cannot be a plausible epoch, so treat it as seconds-from-now.
  if (raw > 1_000_000_000) return Math.floor(raw);
  if (raw > 0) return Math.floor(Date.now() / 1000 + raw);
  return null;
}

/** Classify an HTTP response from the Codex backend or the OAuth token endpoint. */
export function classifyHttp(status: number, body: unknown, rawText?: string): UpstreamFailure {
  const code = extractCode(body);
  const message = extractMessage(body, rawText?.slice(0, 500) || `HTTP ${status}`);
  const resetsAt = extractResetsAt(body);
  const usageLimited = code === "usage_limit_reached" || code === "usage_limit_exceeded";

  if (
    (message && /account is not active/i.test(message)) ||
    (rawText && /account is not active/i.test(rawText))
  ) {
    return {
      kind: "terminal",
      status,
      code: "account_deactivated",
      message: "Your OpenAI API account is not active. Check billing details on platform.openai.com.",
      resetsAt: null,
      usageLimited: false,
    };
  }

  if (
    (message && /(no credits remaining|insufficient_quota|credit_balance_exhausted)/i.test(message)) ||
    (rawText && /(no credits remaining|insufficient_quota|credit_balance_exhausted)/i.test(rawText))
  ) {
    return {
      kind: "terminal",
      status,
      code: "insufficient_quota",
      message: "You have no credits remaining ($0.00 balance). Add credits on platform.openai.com.",
      resetsAt: null,
      usageLimited: false,
    };
  }

  if (
    (rawText && /is not supported when using Codex with a ChatGPT account/i.test(rawText)) ||
    (message && /is not supported when using Codex with a ChatGPT account/i.test(message))
  ) {
    return {
      kind: "client",
      status,
      code: "plan_unsupported_on_codex",
      message:
        "The Codex backend rejected this model/account combination. The OAuth credential remains active; verify the account-scoped Codex catalogue and model selection.",
      resetsAt: null,
      usageLimited: false,
    };
  }

  if (code && TERMINAL_CODES.has(code)) {
    return { kind: "terminal", status, code, message, resetsAt, usageLimited };
  }

  // Quota exhaustion. Cool the credential until `resets_at` and move on.
  if (status === 429 || status === 402 || usageLimited) {
    return { kind: "transient", status, code, message, resetsAt, usageLimited: true };
  }

  // Auth failures with no terminal code: the token is stale or has been
  // invalidated server-side. The refresh path decides which; from the router's
  // point of view this credential is unusable right now.
  if (status === 401 || status === 403) {
    return { kind: "terminal", status, code, message, resetsAt, usageLimited };
  }

  if (status >= 500) {
    return { kind: "transient", status, code, message, resetsAt, usageLimited };
  }

  if (status === 408 || status === 409 || status === 425) {
    return { kind: "transient", status, code, message, resetsAt, usageLimited };
  }

  // Everything else in 4xx is the caller's problem.
  return { kind: "client", status, code, message, resetsAt, usageLimited };
}

/** Classify a transport-level failure (DNS, TCP, TLS, timeout, aborted socket). */
export function classifyTransport(err: unknown): UpstreamFailure {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code ?? e?.name ?? "network_error";
  return {
    kind: "transient",
    status: 0,
    code: String(code),
    message: e?.message ? String(e.message) : "upstream connection failed",
    resetsAt: null,
    usageLimited: false,
  };
}
