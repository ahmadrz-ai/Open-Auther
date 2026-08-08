/**
 * Structured JSON logging with hard secret redaction.
 *
 * Redaction runs at the *serialisation* layer, not at the call site. That is
 * deliberate: the failure mode we are defending against is a secret escaping
 * through an exception message or a stack trace that nobody remembered to
 * sanitise. Anything that reaches this module gets scrubbed, including strings
 * we never explicitly marked as sensitive.
 */

export const REDACTED = "***REDACTED***";

/** Secrets registered at runtime (tokens, gateway keys) for exact-match scrubbing. */
const knownSecrets = new Set<string>();

/**
 * Register a literal secret so it is scrubbed anywhere it appears in log output,
 * including inside error messages produced by third-party code.
 *
 * Short values are ignored: scrubbing a 6-character string would mangle
 * unrelated log text for no security benefit.
 */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === "string" && value.length >= 12) knownSecrets.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (typeof value === "string") knownSecrets.delete(value);
}

/** Test-only: drop all registered secrets. */
export function _resetSecrets(): void {
  knownSecrets.clear();
}

/** Keys whose values are always replaced wholesale, regardless of shape. */
const SENSITIVE_KEY = /^(access_?token|refresh_?token|id_?token|api_?key|apikey|key|secret|password|authorization|auth|cookie|set-cookie|client_?secret|device_?code|bearer)$/i;

/** JWTs: three base64url segments. Matches id_token / access_token material. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** OpenAI-style and generic long opaque credentials. */
const PREFIXED_KEY_RE = /\b(?:sk|rk|pk|gsk|oauth|aia)[-_][A-Za-z0-9_-]{16,}\b/g;

/**
 * Long unbroken high-entropy runs. Tuned to 40+ chars so it catches opaque
 * bearer tokens without eating base64 payloads we actually want to read
 * (which are usually broken up by punctuation).
 */
const OPAQUE_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

/**
 * Any URL query string. We never put secrets in query strings ourselves, but a
 * dependency might, and a full URL in a log line is exactly how that leaks.
 */
const QUERY_RE = /([?&][A-Za-z0-9_.\[\]-]+=)[^&\s"'`]+/g;

/** Scrub a single string through every rule. */
export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(PREFIXED_KEY_RE, REDACTED);
  out = out.replace(QUERY_RE, `$1${REDACTED}`);
  out = out.replace(OPAQUE_RE, (m) => (m === REDACTED ? m : REDACTED));
  return out;
}

/**
 * Recursively scrub an arbitrary value. Handles Errors (including `cause`),
 * cycles, Maps, Sets, and Buffers.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
      };
      if (value.stack) out.stack = redactString(value.stack);
      if ((value as { code?: unknown }).code !== undefined) {
        out.code = redact((value as { code?: unknown }).code, seen);
      }
      if (value.cause !== undefined) out.cause = redact(value.cause, seen);
      return out;
    }
    if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength}b]`;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => redact(v, seen));
    if (value instanceof Map) {
      return Object.fromEntries([...value].map(([k, v]) => [String(k), redact(v, seen)]));
    }
    if (value instanceof Set) return [...value].map((v) => redact(v, seen));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== null && v !== undefined ? REDACTED : redact(v, seen);
    }
    return out;
  }
  return String(value);
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  /** Injection point for tests. */
  sink?: (line: string) => void;
}

let currentLevel: LogLevel = "info";
let pretty = false;
let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

export function configureLogging(opts: LoggerOptions): void {
  if (opts.level) currentLevel = opts.level;
  if (opts.pretty !== undefined) pretty = opts.pretty;
  if (opts.sink) sink = opts.sink;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "[90m",
  info: "[36m",
  warn: "[33m",
  error: "[31m",
};

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const scrubbed = redact(fields) as Record<string, unknown>;
  const record = {
    ts: new Date().toISOString(),
    level,
    event: redactString(event),
    ...scrubbed,
  };

  if (pretty) {
    const { ts, level: lv, event: ev, ...rest } = record;
    const detail = Object.keys(rest).length ? " " + safeStringify(rest) : "";
    sink(
      `${LEVEL_COLOR[level]}${String(lv).toUpperCase().padEnd(5)}[0m ` +
        `[90m${String(ts).slice(11, 23)}[0m ${ev}${detail}`,
    );
    return;
  }
  sink(safeStringify(record));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Last-resort path: still redacted, because `redact` already ran.
    return JSON.stringify({ error: "unserialisable log record" });
  }
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

export function createLogger(bound: Record<string, unknown> = {}): Logger {
  return {
    debug: (event, fields) => emit("debug", event, { ...bound, ...fields }),
    info: (event, fields) => emit("info", event, { ...bound, ...fields }),
    warn: (event, fields) => emit("warn", event, { ...bound, ...fields }),
    error: (event, fields) => emit("error", event, { ...bound, ...fields }),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

export const log = createLogger();

/** Mask an email for display: `ahmad.raza@example.com` -> `ah***za@example.com`. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "unknown";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? "*"}***${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
}
