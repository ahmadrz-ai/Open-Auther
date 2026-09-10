/**
 * Gateway key policy: what each key may see, and what it calls it.
 *
 * A Claude key exists because the Claude desktop app keeps only ids matching
 * `anthropic/claude-*` and silently drops everything else, so a pool of
 * Gemini, GPT and Qwen ids is invisible to it. Renaming is the only thing that
 * makes them reachable.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_TIERS,
  assignClaudeAliases,
  filterForKey,
  isRealClaudeModel,
  keyAllows,
  normaliseKey,
  resolveClaudeAlias,
  tierId,
  type GatewayKey,
} from "../src/core/keys.js";

const POOL = [
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-3.8-flash-tiered",
  "qwen/qwen3.8-max:free",
  "anthropic/claude-opus-4.6",
  "claude-sonnet-4-6",
];

describe("recognising a real Claude model", () => {
  it("spots the provider's own Claude ids, prefixed or not", () => {
    expect(isRealClaudeModel("anthropic/claude-opus-4.6")).toBe(true);
    expect(isRealClaudeModel("claude-sonnet-4-6")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isRealClaudeModel("gpt-5.6-terra")).toBe(false);
    expect(isRealClaudeModel("gemini-3.8-flash-tiered")).toBe(false);
    expect(isRealClaudeModel("qwen/qwen3.8-max:free")).toBe(false);
  });
});

describe("assigning Claude names to pooled models", () => {
  it("honours the pinned pairs", () => {
    const aliases = assignClaudeAliases({ models: POOL });
    expect(aliases["claude-opus-5"]).toBe("gpt-5.6-terra");
    expect(aliases["claude-opus-4.8"]).toBe("gpt-5.6-luna");
  });

  it("never hands out a real Claude model", () => {
    const aliases = assignClaudeAliases({ models: POOL });
    for (const model of Object.values(aliases)) {
      expect(isRealClaudeModel(model)).toBe(false);
    }
  });

  it("gives each name a different model", () => {
    const used = Object.values(assignClaudeAliases({ models: POOL }));
    expect(new Set(used).size).toBe(used.length);
  });

  it("is stable: an existing assignment is never moved", () => {
    const existing = { "claude-haiku-4.5": "gpt-5.6-terra" };
    const aliases = assignClaudeAliases({ models: POOL, existing });
    expect(aliases["claude-haiku-4.5"]).toBe("gpt-5.6-terra");
    // And the pinned pair goes elsewhere rather than duplicating it.
    expect(aliases["claude-opus-5"]).not.toBe("gpt-5.6-terra");
  });

  it("drops an assignment whose model the pool no longer serves", () => {
    const aliases = assignClaudeAliases({
      models: ["gpt-5.6-terra"],
      existing: { "claude-opus-4.7": "model-that-went-away" },
    });
    expect(aliases["claude-opus-4.7"]).not.toBe("model-that-went-away");
  });

  it("assigns no more names than it has models", () => {
    const aliases = assignClaudeAliases({ models: ["only-one"] });
    expect(Object.keys(aliases)).toHaveLength(1);
  });
});

describe("resolving what a Claude client asked for", () => {
  const key: GatewayKey = {
    name: "desktop",
    key: "k",
    kind: "claude",
    claudeAliases: { "claude-opus-5": "gpt-5.6-terra" },
  };

  it("accepts the name with or without the anthropic prefix", () => {
    expect(resolveClaudeAlias(key, "claude-opus-5")).toBe("gpt-5.6-terra");
    expect(resolveClaudeAlias(key, tierId("claude-opus-5"))).toBe("gpt-5.6-terra");
  });

  it("returns null for a name this key does not hand out", () => {
    expect(resolveClaudeAlias(key, "claude-haiku-4.5")).toBeNull();
  });
});

describe("the per-key allowlist", () => {
  it("treats null as unrestricted, so a new key just works", () => {
    const key: GatewayKey = { name: "k", key: "x", allowedModels: null };
    expect(keyAllows(key, "anything")).toBe(true);
    expect(filterForKey(key, POOL)).toEqual(POOL);
  });

  it("supports narrowing to a single model", () => {
    const key: GatewayKey = { name: "k", key: "x", allowedModels: ["gpt-5.6-terra"] };
    expect(keyAllows(key, "gpt-5.6-terra")).toBe(true);
    expect(keyAllows(key, "gpt-5.6-luna")).toBe(false);
    expect(filterForKey(key, POOL)).toEqual(["gpt-5.6-terra"]);
  });

  it("supports turning everything off", () => {
    const key: GatewayKey = { name: "k", key: "x", allowedModels: [] };
    expect(keyAllows(key, "gpt-5.6-terra")).toBe(false);
  });
});

describe("older config files", () => {
  it("reads a key with no policy as an unrestricted standard key", () => {
    const key = normaliseKey({ name: "default", key: "x" });
    expect(key.kind).toBe("standard");
    expect(key.allowedModels).toBeNull();
    expect(keyAllows(key, "anything")).toBe(true);
  });
});

describe("the tier ladder", () => {
  it("only contains names the Claude clients accept", () => {
    for (const tier of CLAUDE_TIERS) {
      expect(tierId(tier)).toMatch(/^anthropic\/claude-/);
    }
  });
});
