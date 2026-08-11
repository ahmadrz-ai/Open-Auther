import { describe, expect, it } from "vitest";
import { orderCandidates } from "../src/core/virtual.js";
import { credentialInput, makeStore } from "./fixtures.js";

describe("virtual model policies", () => {
  it("fast prefers the lowest measured first-token latency", () => {
    const store = makeStore();
    const fast = store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["gpt-4o-mini"],
      }),
    );
    const slow = store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["gpt-5.6-luna"],
      }),
    );
    store.setModelStat(fast.id, "gpt-4o-mini", { ok: true, latencyMs: 120, ts: 1 });
    store.setModelStat(slow.id, "gpt-5.6-luna", { ok: true, latencyMs: 900, ts: 1 });

    const ordered = orderCandidates("fast", [
      { credential: slow, model: "gpt-5.6-luna" },
      { credential: fast, model: "gpt-4o-mini" },
    ]);

    expect(ordered.map((candidate) => candidate.model)).toEqual(["gpt-4o-mini", "gpt-5.6-luna"]);
  });

  it("quality prefers the strongest model even when a weaker model succeeded before it", () => {
    const store = makeStore();
    const weak = store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["gpt-4o-mini"],
      }),
    );
    const strong = store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["gpt-5.6-luna"],
      }),
    );
    store.setModelStat(weak.id, "gpt-4o-mini", { ok: true, latencyMs: 30, ts: 1 });

    const ordered = orderCandidates("quality", [
      { credential: weak, model: "gpt-4o-mini" },
      { credential: strong, model: "gpt-5.6-luna" },
    ]);

    expect(ordered[0]?.model).toBe("gpt-5.6-luna");
  });

  it("auto keeps every available candidate in the normal rotation", () => {
    const store = makeStore();
    const first = store.add(credentialInput({ customModels: ["gpt-4o-mini"] }));
    const second = store.add(credentialInput({ customModels: ["gpt-5.6-luna"] }));

    const ordered = orderCandidates("auto", [
      { credential: first, model: "gpt-4o-mini" },
      { credential: second, model: "gpt-5.6-luna" },
    ]);

    expect(new Set(ordered.map((candidate) => candidate.model))).toEqual(
      new Set(["gpt-4o-mini", "gpt-5.6-luna"]),
    );
  });
});
