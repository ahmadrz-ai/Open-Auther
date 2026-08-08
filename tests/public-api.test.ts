import { describe, expect, it } from "vitest";
import * as OpenAuther from "../src/index.js";

describe("public library entrypoint", () => {
  it("exports the provider extension surface", () => {
    expect(OpenAuther.ProviderRegistry).toBeTypeOf("function");
    expect(OpenAuther.BUILTIN_PROVIDER_REGISTRY.has("codex")).toBe(true);
    expect(OpenAuther.providerDef("gemini")?.id).toBe("gemini");
  });
});
