/**
 * Redaction is the security boundary of this project. These tests exist
 * because of a real bug in a library that put a key in a URL query string:
 * every subsequent failure wrote the full secret into logs and exception
 * messages. The defence is that redaction runs at the serialisation layer,
 * so it catches secrets nobody remembered to mark.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  REDACTED,
  _resetSecrets,
  configureLogging,
  createLogger,
  maskEmail,
  redactString,
  registerSecret,
} from "../src/logging.js";
import { syntheticIdToken, syntheticOpaqueToken } from "./fixtures.js";

function captureLogs(): { lines: string[]; text: () => string } {
  const lines: string[] = [];
  configureLogging({ level: "debug", pretty: false, sink: (l) => lines.push(l) });
  return { lines, text: () => lines.join("\n") };
}

beforeEach(() => {
  _resetSecrets();
});

describe("redactString", () => {
  it("removes JWTs", () => {
    const jwt = syntheticIdToken({ email: "a@b.com" });
    const out = redactString(`token was ${jwt} at the end`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED);
  });

  it("removes prefixed API keys", () => {
    const key = syntheticOpaqueToken("sk");
    expect(redactString(`key=${key}`)).not.toContain(key);
  });

  it("strips every URL query-string value", () => {
    const secret = syntheticOpaqueToken("aia");
    const out = redactString(`GET https://api.example/v1/thing?key=${secret}&mode=fast`);
    expect(out).not.toContain(secret);
    // The parameter names survive so the log stays diagnosable.
    expect(out).toContain("key=");
    expect(out).toContain("mode=");
    expect(out).not.toContain("fast");
  });

  it("removes registered secrets even when they look ordinary", () => {
    const secret = "correct-horse-battery-staple-1234";
    registerSecret(secret);
    expect(redactString(`the value is ${secret}`)).not.toContain(secret);
  });

  it("ignores short registrations so ordinary text is not mangled", () => {
    registerSecret("abc");
    expect(redactString("abc def")).toBe("abc def");
  });
});

describe("logger", () => {
  it("redacts values under sensitive keys", () => {
    const cap = captureLogs();
    const log = createLogger();
    log.info("test", { access_token: "whatever", authorization: "Bearer xyz", safe: "keep-me" });
    expect(cap.text()).not.toContain("whatever");
    expect(cap.text()).not.toContain("Bearer xyz");
    expect(cap.text()).toContain("keep-me");
  });

  it("redacts a token that leaks through an exception message", () => {
    // The scenario this whole module exists for.
    const token = syntheticIdToken();
    registerSecret(token);
    const cap = captureLogs();
    const log = createLogger();

    const err = new Error(`request failed for token ${token}`);
    log.error("upstream_failed", { err });

    expect(cap.text()).not.toContain(token);
    expect(cap.text()).toContain("request failed for token");
  });

  it("redacts a token that leaks through a stack trace", () => {
    const token = syntheticOpaqueToken("rt");
    registerSecret(token);
    const cap = captureLogs();
    const log = createLogger();

    const err = new Error("outer");
    err.stack = `Error: outer\n    at doThing (${token}:1:1)\n    at main`;
    log.error("boom", { err });

    expect(cap.text()).not.toContain(token);
  });

  it("redacts secrets nested inside a cause chain", () => {
    const token = syntheticOpaqueToken("sk");
    const cap = captureLogs();
    const log = createLogger();

    const inner = new Error(`inner failure ${token}`);
    const outer = new Error("outer failure", { cause: inner });
    log.error("nested", { err: outer });

    expect(cap.text()).not.toContain(token);
  });

  it("redacts deeply nested object values", () => {
    const token = syntheticIdToken();
    registerSecret(token);
    const cap = captureLogs();
    createLogger().info("deep", { a: { b: { c: [{ d: token }] } } });
    expect(cap.text()).not.toContain(token);
  });

  it("survives circular references", () => {
    const cap = captureLogs();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => createLogger().info("circular", { circular })).not.toThrow();
    expect(cap.text()).toContain("[Circular]");
  });

  it("never emits a raw credential from a realistic failure payload", () => {
    const access = syntheticJwtLike();
    const refresh = syntheticOpaqueToken("rt");
    registerSecret(access);
    registerSecret(refresh);

    const cap = captureLogs();
    createLogger().error("refresh_failed", {
      request: {
        url: `https://auth.example/oauth/token?client_id=abc&refresh_token=${refresh}`,
        headers: { authorization: `Bearer ${access}` },
        body: { refresh_token: refresh, grant_type: "refresh_token" },
      },
      err: new Error(`invalid_grant for ${refresh}`),
    });

    const text = cap.text();
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh);
    expect(text).toContain("invalid_grant");
    expect(text).toContain("grant_type");
  });
});

function syntheticJwtLike(): string {
  return syntheticIdToken({ email: "leak@example.com" });
}

describe("maskEmail", () => {
  it("keeps the shape without revealing the address", () => {
    expect(maskEmail("ahmad.raza@example.com")).toBe("ah***a@example.com");
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail(null)).toBe("unknown");
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
