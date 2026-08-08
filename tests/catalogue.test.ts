/**
 * Model catalogue and the auto/fast/quality selection policies.
 */

import { describe, expect, it } from "vitest";
import { buildCatalogue, looksFree } from "../src/core/catalogue.js";
import { isVirtualModel, orderCandidates, qualityScore, resolveVirtual } from "../src/core/virtual.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import type { Credential } from "../src/pool/types.js";

const cred = (over: Partial<Credential> = {}): Credential =>
  ({
    id: 1,
    accountId: "a",
    providerId: "custom",
    providerType: "openai_custom",
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

describe("looksFree", () => {
  it("uses OpenRouter's :free suffix, which is the only reliable marker", () => {
    expect(looksFree("deepseek/deepseek-chat:free", "openrouter")).toBe(true);
    expect(looksFree("openai/gpt-4o", "openrouter")).toBe(false);
  });

  it("treats every other provider's models as free, because the key decides", () => {
    // A Gemini free-tier key serves only what that key is entitled to; there
    // is nothing per-model to filter.
    expect(looksFree("gemini-3.5-flash", "gemini")).toBe(true);
    expect(looksFree("anything", "custom")).toBe(true);
  });
});

describe("buildCatalogue", () => {
  it("aggregates models across every credential", () => {
    const entries = buildCatalogue([
      cred({ id: 1, providerId: "gemini", providerType: "gemini", customModels: ["gemini-3.5-flash"] }),
      cred({ id: 2, providerId: "custom", customModels: ["llama-3.3-70b"] }),
    ]);
    expect(entries.map((e) => e.id).sort()).toEqual(["gemini-3.5-flash", "llama-3.3-70b"]);
  });

  it("records every provider that offers the same model", () => {
    const entries = buildCatalogue([
      cred({ id: 1, providerId: "custom", customModels: ["shared"] }),
      cred({ id: 2, providerId: "openrouter", customModels: ["shared"] }),
    ]);
    expect(entries[0]!.providers).toEqual(["custom", "openrouter"]);
  });

  it("drops paid models when asked", () => {
    const c = cred({ providerId: "openrouter", customModels: ["a:free", "b"] });
    expect(buildCatalogue([c]).map((e) => e.id)).toEqual(["a:free", "b"]);
    expect(buildCatalogue([c], { freeOnly: true }).map((e) => e.id)).toEqual(["a:free"]);
  });

  it("omits excluded models", () => {
    const c = cred({ customModels: ["keep", "drop"], excludedModels: ["drop"] });
    expect(buildCatalogue([c]).map((e) => e.id)).toEqual(["keep"]);
  });

  it("puts the virtual entries first, and only when something real exists", () => {
    const entries = buildCatalogue([cred({ customModels: ["m"] })], { includeVirtual: true });
    expect(entries.slice(0, 3).map((e) => e.id)).toEqual(["auto", "fast", "quality"]);
    expect(entries.every((e) => e.virtual || e.id === "m")).toBe(true);

    // Nothing connected means no virtual ids either — they would resolve to
    // nothing and just produce confusing 503s.
    expect(buildCatalogue([], { includeVirtual: true })).toEqual([]);
  });
});

describe("virtual models", () => {
  const candidates = (...pairs: Array<[string, number?]>) =>
    pairs.map(([model, ms], i) => ({
      credential: cred({
        id: i + 1,
        modelStats: ms ? { [model]: { ok: true, latencyMs: ms, ts: 0 } } : {},
      }),
      model,
    }));

  it("recognises only the three policies", () => {
    expect(isVirtualModel("auto")).toBe(true);
    expect(isVirtualModel("fast")).toBe(true);
    expect(isVirtualModel("quality")).toBe(true);
    expect(isVirtualModel("gpt-4o")).toBe(false);
  });

  it("auto takes the first available and does not shop around", () => {
    const list = candidates(["first"], ["second"]);
    expect(resolveVirtual("auto", list)?.model).toBe("first");
  });

  it("fast picks the lowest measured latency", () => {
    const list = candidates(["slow", 4000], ["quick", 300], ["middling", 1200]);
    expect(resolveVirtual("fast", list)?.model).toBe("quick");
  });

  it("fast leans small when nothing has been measured", () => {
    // No measurements is not evidence of speed, so fall back to the cheapest
    // end of the capability ordering rather than guessing.
    const list = candidates(["gemini-3-pro-preview"], ["gemini-3.5-flash-lite"]);
    expect(resolveVirtual("fast", list)?.model).toBe("gemini-3.5-flash-lite");
  });

  it("quality picks the most capable regardless of speed", () => {
    const list = candidates(["gemini-3.5-flash-lite", 100], ["gemini-3-pro-preview", 9000]);
    expect(resolveVirtual("quality", list)?.model).toBe("gemini-3-pro-preview");
  });

  it("auto and fast stay on the model already in use", () => {
    const list = candidates(["a", 5000], ["b", 100]);
    // Switching mid-conversation changes the answer style for no reason.
    expect(resolveVirtual("fast", list, {}, "a")?.model).toBe("a");
    expect(resolveVirtual("auto", list, {}, "b")?.model).toBe("b");
  });

  it("quality ignores stickiness — it always wants the best", () => {
    const list = candidates(["gemini-3.5-flash-lite"], ["gemini-3-pro-preview"]);
    expect(resolveVirtual("quality", list, {}, "gemini-3.5-flash-lite")?.model).toBe(
      "gemini-3-pro-preview",
    );
  });

  it("returns null when there is nothing to choose from", () => {
    expect(resolveVirtual("auto", [])).toBeNull();
  });

  it("orders every candidate so the router can move past a dud", () => {
    // A provider listing a model is not a promise that it serves chat, so the
    // policy has to offer somewhere to go next.
    const list = candidates(["a"], ["b"], ["c"]);
    expect(orderCandidates("auto", list).map((c) => c.model)).toHaveLength(3);
  });

  it("sinks models already known not to work", () => {
    const bad = {
      credential: cred({ id: 1, modelStats: { broken: { ok: false, latencyMs: 0, ts: 0 } } }),
      model: "broken",
    };
    const unknown = { credential: cred({ id: 2 }), model: "untried" };
    for (const policy of ["auto", "fast", "quality"] as const) {
      expect(orderCandidates(policy, [bad, unknown])[0]!.model).toBe("untried");
    }
  });

  it("floats a model proven to work above an untried one", () => {
    const good = {
      credential: cred({ id: 1, modelStats: { proven: { ok: true, latencyMs: 900, ts: 0 } } }),
      model: "proven",
    };
    const unknown = { credential: cred({ id: 2 }), model: "untried" };
    expect(orderCandidates("auto", [unknown, good])[0]!.model).toBe("proven");
  });
});

describe("qualityScore", () => {
  it("ranks pro above lite", () => {
    const pro = qualityScore("gemini-3-pro-preview", capabilitiesFor("gemini-3-pro-preview"));
    const lite = qualityScore("gemini-3.5-flash-lite", capabilitiesFor("gemini-3.5-flash-lite"));
    expect(pro).toBeGreaterThan(lite);
  });

  it("rewards declared reasoning over a promising name", () => {
    const caps = { reasoning: true, vision: false, tools: true, streaming: true, webSearch: false, contextWindow: 200_000 };
    const plain = { ...caps, reasoning: false };
    expect(qualityScore("x", caps)).toBeGreaterThan(qualityScore("x-pro", plain));
  });
});
