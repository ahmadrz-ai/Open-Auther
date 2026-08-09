/** Provider plugin registry contract tests. */

import { describe, expect, it } from "vitest";
import { ProviderRegistry, providerSummaries, type ProviderPlugin } from "../src/core/provider-registry.js";
import {
  ALL_PROVIDERS,
  BUILTIN_PROVIDER_REGISTRY,
  providerDef,
  providerDefs,
  CODEX_PROVIDER,
  type ProviderDef,
} from "../src/core/providers.js";

const definition = (id: string): ProviderDef => ({
  id,
  label: `${id} provider`,
  blurb: "Test provider",
  providerType: "openai_custom",
  baseUrl: `https://${id}.example/v1`,
  auth: ["api_key"],
  multiKey: true,
  keyHint: "test-key",
  keyUrl: null,
  probeModel: "test-model",
  listsModels: true,
  defaultModels: ["test-model"],
});

const plugin = (id: string): ProviderPlugin => ({
  id,
  definition: definition(id),
});

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider plugin by id", () => {
    const registry = new ProviderRegistry();
    const entry = plugin("example");

    registry.register(entry);

    expect(registry.get("example")).toBe(entry);
    expect(registry.has("example")).toBe(true);
    expect(registry.list()).toEqual([entry]);
  });

  it("rejects duplicate provider ids", () => {
    const registry = new ProviderRegistry();
    registry.register(plugin("example"));

    expect(() => registry.register(plugin("example"))).toThrow(/already registered/i);
  });

  it("rejects a plugin whose id does not match its definition", () => {
    const registry = new ProviderRegistry();

    expect(() =>
      registry.register({ id: "plugin-id", definition: definition("definition-id") }),
    ).toThrow(/must match/i);
  });

  it("rejects invalid ids before they can enter routing", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(plugin(""))).toThrow(/id/i);
    expect(() => registry.register(plugin("not a provider"))).toThrow(/id/i);
  });

  it("unregisters a provider and reports whether it existed", () => {
    const registry = new ProviderRegistry();
    registry.register(plugin("example"));

    expect(registry.unregister("example")).toBe(true);
    expect(registry.unregister("example")).toBe(false);
    expect(registry.has("example")).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("returns a snapshot so callers cannot mutate registry state", () => {
    const registry = new ProviderRegistry();
    registry.register(plugin("example"));

    const listed = registry.list();
    listed.length = 0;

    expect(registry.has("example")).toBe(true);
  });

  it("registers every built-in provider through the same extension contract", () => {
    expect(BUILTIN_PROVIDER_REGISTRY.list().map((entry) => entry.id)).toEqual(
      ALL_PROVIDERS.map((provider) => provider.id),
    );
  });

  it("makes a registered plugin available to provider lookup", () => {
    const entry = plugin("runtime-example");
    BUILTIN_PROVIDER_REGISTRY.register(entry);
    try {
      expect(providerDef("runtime-example")).toBe(entry.definition);
      expect(providerDefs().some((definition) => definition.id === "runtime-example")).toBe(true);
    } finally {
      BUILTIN_PROVIDER_REGISTRY.unregister("runtime-example");
    }
  });

  it("includes Hermes-aligned GPT 5.6 Codex routes", () => {
    expect(CODEX_PROVIDER.defaultModels).toEqual(
      expect.arrayContaining([
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna-pro",
      ]),
    );
  });

  it("produces stable summaries for CLI and dashboard consumers", () => {
    const registry = new ProviderRegistry([plugin("example")]);

    expect(providerSummaries(registry)).toEqual([
      {
        id: "example",
        label: "example provider",
        auth: ["api_key"],
        models: ["test-model"],
        listsModels: true,
      },
    ]);
  });
});
