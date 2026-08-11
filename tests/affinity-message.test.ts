import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { testConfig, credentialInput, makeStore } from "./fixtures.js";

describe("provider pin diagnostics", () => {
  it("names the pin when it is what excluded every capable credential", async () => {
    const store = makeStore();
    store.add(
      credentialInput({
        providerId: "antigravity",
        providerType: "antigravity",
        customModels: ["gemini-3.6-flash-high"],
        baseUrl: "proj-1",
      }),
    );
    store.add(credentialInput({ providerId: "codex", providerType: "codex_oauth" }));

    const router = new Router(testConfig(), store);
    const outcome = await router.chat(
      {
        model: "gemini-3.6-flash-high",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
      new AbortController().signal,
      { providerId: "codex" },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("provider_pin_excludes_model");
    expect(outcome.message).toContain("codex");
    expect(outcome.message).toContain("antigravity");
  });
});
