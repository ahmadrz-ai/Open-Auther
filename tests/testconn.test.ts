/**
 * Which model a connection test probes with.
 *
 * The rule that matters: the probe must not stake a credential's health on an
 * id the provider merely listed. A Gemini key lists `antigravity-preview-…`
 * first, cannot serve it, and four healthy keys all reported failure.
 */

import { describe, expect, it } from "vitest";
import { probeModels } from "../src/api/testconn.js";
import { loadConfig } from "../src/config.js";
import type { Credential } from "../src/pool/types.js";

const cfg = loadConfig({ configPath: "" });

const cred = (over: Partial<Credential> = {}): Credential =>
  ({
    id: 1,
    accountId: "a",
    providerId: "gemini",
    providerType: "gemini",
    baseUrl: null,
    customModels: null,
    validationModel: null,
    priority: 1,
    excludedModels: [],
    customUserAgent: null,
    routingTags: [],
    perModelQuota: false,
    modelCooldowns: {},
    modelStats: {},
    email: null,
    planType: null,
    label: null,
    accessToken: "k",
    refreshToken: null,
    idToken: null,
    accessExpiresAt: null,
    state: "active",
    cooldownUntil: null,
    resetsAt: null,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    tokenCount: 0,
    lastUsedAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Credential;

describe("probeModels", () => {
  it("honours an explicit validation model, alone", () => {
    const c = cred({ validationModel: "pinned", customModels: ["a", "b"] });
    expect(probeModels(cfg, c)).toEqual(["pinned"]);
  });

  it("does not probe with a non-chat model the provider happens to list first", () => {
    // This is the exact shape that broke four Gemini keys.
    const c = cred({
      customModels: ["imagen-4.0-ultra-generate-001", "gemini-2.5-flash"],
    });
    expect(probeModels(cfg, c)[0]).toBe("gemini-2.5-flash");
  });

  it("prefers a model already proven to work on this credential", () => {
    const c = cred({
      customModels: ["untried-a", "known-good", "untried-b"],
      modelStats: { "known-good": { ok: true, latencyMs: 400, ts: 0 } },
    });
    expect(probeModels(cfg, c)[0]).toBe("known-good");
  });

  it("avoids ids already known to fail when something untried remains", () => {
    const c = cred({
      customModels: ["known-bad", "untried"],
      modelStats: { "known-bad": { ok: false, latencyMs: 0, ts: 0, error: "model_not_found" } },
    });
    expect(probeModels(cfg, c)[0]).toBe("untried");
  });

  it("returns alternatives, so one bad id does not condemn the connection", () => {
    // Antigravity lists six models and serves two; the rest 404.
    const c = cred({ customModels: ["m1", "m2", "m3", "m4", "m5", "m6"] });
    expect(probeModels(cfg, c).length).toBe(6);
  });

  it("skips excluded models", () => {
    const c = cred({ customModels: ["hidden", "shown"], excludedModels: ["hidden"] });
    expect(probeModels(cfg, c)).not.toContain("hidden");
  });

  it("falls back to the configured list when the credential declares nothing", () => {
    const picked = probeModels(cfg, cred())[0]!;
    expect(cfg.models).toContain(picked);
  });

  it("falls back to a per-provider guess when the configured list suits nothing", () => {
    // Probing a ChatGPT Auth with a Gemini id reports "model does not exist",
    // which hides whatever is actually wrong with the account.
    const bare = { ...cfg, models: [] as string[] };
    expect(probeModels(bare, cred({ providerType: "codex_oauth" }))[0]).toBe("gpt-5.6-luna");
  });
});
