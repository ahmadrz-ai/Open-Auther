import { describe, expect, it } from "vitest";
import * as OpenAuther from "../src/index.js";

describe("public library entrypoint", () => {
  it("exports the provider extension surface", () => {
    expect(OpenAuther.ProviderRegistry).toBeTypeOf("function");
    expect(OpenAuther.BUILTIN_PROVIDER_REGISTRY.has("codex")).toBe(true);
    expect(OpenAuther.providerDef("gemini")?.id).toBe("gemini");
    expect(OpenAuther.buildProviderStatus).toBeTypeOf("function");
    expect(OpenAuther.buildDoctorReport).toBeTypeOf("function");
    expect(OpenAuther.AuthAdapterRegistry).toBeTypeOf("function");
    expect(OpenAuther.BUILTIN_AUTH_ADAPTERS.get("codex")?.id).toBe("codex");
  });

  it("exports the model discovery surface", () => {
    expect(OpenAuther.syncPool).toBeTypeOf("function");
    expect(OpenAuther.startModelSync).toBeTypeOf("function");
    expect(OpenAuther.parseModelList([{ id: "a" }])[0]?.id).toBe("a");
    expect(OpenAuther.inferCapabilities("gemini-3.7-flash")?.vision).toBe(true);
  });
});
