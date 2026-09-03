/**
 * The two failures this layer exists to prevent:
 *
 *  1. An image request refused locally for a model that accepts images,
 *     because the model was not in the curated built-in table.
 *  2. A request sent to a model id the provider retired weeks ago, because
 *     nothing re-read the catalogue or honoured the announced replacement.
 */

import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  meetsRequirements,
  requirementsForRequest,
} from "../src/core/capabilities.js";
import {
  discoveredModel,
  inferCapabilities,
  mergeDiscovered,
  parseMetadata,
  toMetadata,
} from "../src/core/model-metadata.js";
import { parseModelList } from "../src/upstream/discovery.js";
import { credentialInput, makeStore } from "./fixtures.js";

const VISION_REQUEST = requirementsForRequest({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this screenshot?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
      ],
    },
  ],
});

describe("capability resolution", () => {
  it("believes a provider that says the model takes images", () => {
    const live = discoveredModel("gemini-3.7-flash", { vision: true, reasoning: true });
    const caps = capabilitiesFor("gemini-3.7-flash", {}, live);

    expect(caps.vision).toBe(true);
    expect(caps.source).toBe("discovered");
    expect(meetsRequirements(caps, VISION_REQUEST)).toBe(true);
  });

  it("does not refuse an image for a model nothing has described", () => {
    // The regression itself. `some-private-model` is in no table, publishes no
    // manifest and matches no family, so the gate has no basis to refuse — and
    // refusing meant the image never reached an upstream that would take it.
    const caps = capabilitiesFor("some-private-model");

    expect(caps.source).toBe("unknown");
    expect(meetsRequirements(caps, VISION_REQUEST)).toBe(true);
  });

  it("still refuses when the provider says the model is text-only", () => {
    const live = discoveredModel("text-only-v1", { vision: false });
    const caps = capabilitiesFor("text-only-v1", {}, live);

    expect(caps.source).toBe("discovered");
    expect(meetsRequirements(caps, VISION_REQUEST)).toBe(false);
  });

  it("lets a user override outrank the provider in both directions", () => {
    const live = discoveredModel("odd-model", { vision: false });

    expect(meetsRequirements(capabilitiesFor("odd-model", { "odd-model": { vision: true } }, live), VISION_REQUEST)).toBe(true);
    expect(meetsRequirements(capabilitiesFor("odd-model", { "odd-model": { vision: false } }), VISION_REQUEST)).toBe(false);
  });

  it("layers discovery over the built-in table instead of replacing it", () => {
    // The backend published only a context window; the rest must survive.
    const live = discoveredModel("gpt-4o", { contextWindow: 999_000 });
    const caps = capabilitiesFor("gpt-4o", {}, live);

    expect(caps.contextWindow).toBe(999_000);
    expect(caps.vision).toBe(true);
    expect(caps.tools).toBe(true);
  });

  it("guesses by family, but never lets the guess refuse a request", () => {
    expect(inferCapabilities("gemini-4.0-flash")?.vision).toBe(true);
    expect(inferCapabilities("deepseek-chat")?.vision).toBe(false);

    // Inferred text-only is still only a guess, so the request goes through.
    const caps = capabilitiesFor("deepseek-chat");
    expect(caps.source).toBe("inferred");
    expect(meetsRequirements(caps, VISION_REQUEST)).toBe(true);
  });
});

describe("merging what several accounts know", () => {
  it("takes the optimistic side, because one account being able to serve is enough", () => {
    const a = toMetadata([discoveredModel("shared", { vision: false })]);
    const b = toMetadata([discoveredModel("shared", { vision: true })]);

    expect(mergeDiscovered([a, b], "shared")?.vision).toBe(true);
  });

  it("only redirects a retired id when every account that knows it agrees", () => {
    const agrees = toMetadata([discoveredModel("old", { replacedBy: "new" })]);
    const disagrees = toMetadata([discoveredModel("old", { replacedBy: null })]);

    expect(mergeDiscovered([agrees, agrees], "old")?.replacedBy).toBe("new");
    expect(mergeDiscovered([agrees, disagrees], "old")?.replacedBy).toBeNull();
  });

  it("survives a credential that has never been synced", () => {
    expect(mergeDiscovered([null, undefined, {}], "anything")).toBeNull();
  });
});

describe("parsing a /models listing", () => {
  it("reads OpenRouter modalities and parameters as facts", () => {
    const [model] = parseModelList({
      data: [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          context_length: 200_000,
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    });

    expect(model).toMatchObject({
      id: "anthropic/claude-sonnet-4",
      vision: true,
      reasoning: true,
      tools: true,
      contextWindow: 200_000,
    });
  });

  it("treats stated modalities without an image entry as a real no", () => {
    const [model] = parseModelList({
      data: [{ id: "text-model", architecture: { input_modalities: ["text"] } }],
    });
    expect(model?.vision).toBe(false);
  });

  it("leaves everything unknown when a plain endpoint lists only ids", () => {
    const [model] = parseModelList({ data: [{ id: "llama-3.3-70b" }] });

    expect(model?.id).toBe("llama-3.3-70b");
    expect(model?.vision).toBeNull();
    expect(model?.contextWindow).toBeNull();
  });

  it("accepts a bare array and Ollama's envelope", () => {
    expect(parseModelList([{ id: "a" }])).toHaveLength(1);
    expect(parseModelList({ models: [{ name: "b" }] })[0]?.id).toBe("b");
  });
});

describe("persistence", () => {
  it("stores ids and facts together, keeping retired ids out of routing", () => {
    const store = makeStore();
    const credential = store.add(credentialInput());

    store.setDiscoveredModels(credential.id, [
      discoveredModel("gemini-3.7-flash", { vision: true, contextWindow: 1_000_000 }),
      discoveredModel("gemini-3.5-flash", { replacedBy: "gemini-3.7-flash", chat: false }),
      discoveredModel("tab-completion-surface", { chat: false }),
    ]);

    const saved = store.get(credential.id)!;

    // Only servable ids route.
    expect(saved.customModels).toEqual(["gemini-3.7-flash"]);
    // But the retired id keeps its record, so the redirect can be looked up.
    expect(saved.modelMetadata["gemini-3.5-flash"]?.replacedBy).toBe("gemini-3.7-flash");
    expect(saved.modelMetadata["gemini-3.7-flash"]?.vision).toBe(true);
    expect(saved.modelsSyncedAt).toBeGreaterThan(0);
  });

  it("round-trips through the stored JSON without inventing flags", () => {
    const raw = JSON.stringify(toMetadata([discoveredModel("m", { vision: true })]));
    const parsed = parseMetadata(raw);

    expect(parsed.m?.vision).toBe(true);
    expect(parsed.m?.reasoning).toBeNull();
  });

  it("ignores a malformed blob rather than failing the read", () => {
    expect(parseMetadata("{not json")).toEqual({});
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata("[1,2]")).toEqual({});
  });
});
