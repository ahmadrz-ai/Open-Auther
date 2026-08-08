import { describe, expect, it } from "vitest";
import { BUILTIN_AUTH_ADAPTERS, AuthAdapterRegistry } from "../src/core/auth-adapters.js";

describe("auth adapter registry", () => {
  it("ships a codex OAuth adapter", () => {
    expect(BUILTIN_AUTH_ADAPTERS.get("codex")?.authKind).toBe("oauth");
    expect(BUILTIN_AUTH_ADAPTERS.list().map((adapter) => adapter.id)).toContain("codex");
  });

  it("rejects duplicate adapter ids", () => {
    const registry = new AuthAdapterRegistry();
    registry.register({ id: "custom", label: "Custom", authKind: "api_key", begin: async () => { throw new Error("not interactive"); } });
    expect(() => registry.register({ id: "custom", label: "Again", authKind: "api_key", begin: async () => { throw new Error("not interactive"); } })).toThrow(/already registered/i);
  });

  it("returns immutable adapter snapshots", () => {
    const first = BUILTIN_AUTH_ADAPTERS.list();
    first.pop();
    expect(BUILTIN_AUTH_ADAPTERS.list().length).toBeGreaterThan(first.length);
  });
});
