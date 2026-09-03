/**
 * Test fixtures.
 *
 * Every token here is SYNTHETIC, generated at test time. No real credential
 * ever enters this repository, in any form, including test data.
 */

import { randomBytes } from "node:crypto";
import { openDatabase } from "../src/db.js";
import { CredentialStore, type NewCredentialInput } from "../src/pool/store.js";
import type { Config } from "../src/config.js";

const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** A structurally valid JWT with no real signature. */
export function syntheticJwt(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: "none", typ: "JWT" }),
    b64({ exp: now + 3600, iat: now, ...claims }),
    randomBytes(24).toString("base64url"),
  ].join(".");
}

export function syntheticIdToken(opts: {
  email?: string;
  accountId?: string;
  planType?: string;
  exp?: number;
} = {}): string {
  return syntheticJwt({
    email: opts.email ?? "tester@example.com",
    ...(opts.exp ? { exp: opts.exp } : {}),
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId ?? `acct-${randomBytes(6).toString("hex")}`,
      chatgpt_plan_type: opts.planType ?? "free",
    },
  });
}

export function syntheticOpaqueToken(prefix = "sk"): string {
  return `${prefix}-${randomBytes(32).toString("base64url")}`;
}

export function makeStore(): CredentialStore {
  return new CredentialStore(openDatabase(":memory:"));
}

export function credentialInput(overrides: Partial<NewCredentialInput> = {}): NewCredentialInput {
  const accountId = overrides.accountId ?? `acct-${randomBytes(6).toString("hex")}`;
  return {
    accountId,
    email: `user-${accountId.slice(-4)}@example.com`,
    planType: "free",
    accessToken: syntheticJwt({ sub: accountId }),
    refreshToken: syntheticOpaqueToken("rt"),
    idToken: syntheticIdToken({ accountId }),
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    home: "/tmp/ai-auther-test",
    dbPath: ":memory:",
    configPath: "/tmp/ai-auther-test/config.json",
    host: "127.0.0.1",
    port: 0,
    gatewayKeys: [{ name: "test", key: syntheticOpaqueToken("aia") }],
    rotation: "fill_first",
    maxAttempts: 4,
    defaultCooldownSeconds: 300,
    refreshSkewSeconds: 120,
    requestTimeoutMs: 30_000,
    upstreamBaseUrl: "https://platform.example/v1",
    codexBaseUrl: "https://chatgpt.example/backend-api/codex",
    oauthIssuer: "https://auth.example",
    oauthClientId: "test-client",
    models: ["gpt-4o"],
    defaultModel: "gpt-4o",
    logLevel: "error",
    logPretty: false,
    ui: false,
    // Off by default: a test must never start a background sweep that reaches
    // for the network.
    modelSyncHours: 0,
    ...overrides,
  };
}
