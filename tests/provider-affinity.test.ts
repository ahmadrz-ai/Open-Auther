import { describe, expect, it, vi } from "vitest";
import { Router } from "../src/router.js";
import { CredentialStore } from "../src/pool/store.js";
import { testConfig, credentialInput, makeStore } from "./fixtures.js";
import type { CodexEvent } from "../src/upstream/translate.js";

const PROMPT = "Reply with OK";
const MAX_TOKENS = 10;

function sseResponse(frames: unknown[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("antigravity provider affinity", () => {
  it("routes Antigravity models only to Antigravity credentials", async () => {
    const store = makeStore();
    const anti = store.add(
      credentialInput({
        providerId: "antigravity",
        providerType: "antigravity",
        customModels: ["gemini-3-pro-preview", "gemini-3-flash-preview"],
        baseUrl: "test-project-123",
      }),
    );
    const codex = store.add(
      credentialInput({
        providerId: "codex",
        providerType: "codex_oauth",
        customModels: ["gpt-5.6-luna"],
      }),
    );

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${anti.accessToken}`) {
        return sseResponse([
          { candidates: [{ content: { parts: [{ text: "OK" }] } }] },
        ]);
      }
      if (auth === `Bearer ${codex.accessToken}`) {
        return jsonResponse({ error: { message: "Model not found", code: "model_not_found" } }, 404);
      }
      throw new Error("unexpected credential");
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = new Router(testConfig(), store);

    const outcome = await router.chat(
      {
        model: "gemini-3-pro-preview",
        messages: [{ role: "user", content: PROMPT }],
        max_completion_tokens: MAX_TOKENS,
        stream: false,
      },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.credential.id).toBe(anti.id);
    expect(outcome.model).toBe("gemini-3-pro-preview");
  });

  it("dashboard provider selection restricts credential pool", async () => {
    const store = makeStore();
    const anti = store.add(
      credentialInput({
        providerId: "antigravity",
        providerType: "antigravity",
        customModels: ["gemini-3-pro-preview"],
        baseUrl: "test-project-123",
      }),
    );
    const custom = store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["llama-3.1-8b"],
      }),
    );

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${anti.accessToken}`) {
        return sseResponse([
          { candidates: [{ content: { parts: [{ text: "OK" }] } }] },
        ]);
      }
      if (auth === `Bearer ${custom.accessToken}`) {
        return sseResponse([
          { choices: [{ delta: { content: "OK" } }] },
        ]);
      }
      throw new Error("unexpected credential");
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = new Router(testConfig(), store);

    const outcome = await router.chat(
      {
        model: "gemini-3-pro-preview",
        messages: [{ role: "user", content: PROMPT }],
        max_completion_tokens: MAX_TOKENS,
        stream: false,
      },
      new AbortController().signal,
      { providerId: "antigravity" },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.credential.id).toBe(anti.id);
  });

  it("returns no_model_available when provider has no matching credentials", async () => {
    const store = makeStore();
    store.add(
      credentialInput({
        providerId: "custom",
        providerType: "openai_custom",
        customModels: ["llama-3.1-8b"],
      }),
    );

    const router = new Router(testConfig(), store);

    const outcome = await router.chat(
      {
        model: "gemini-3-pro-preview",
        messages: [{ role: "user", content: PROMPT }],
        max_completion_tokens: MAX_TOKENS,
        stream: false,
      },
      new AbortController().signal,
      { providerId: "antigravity" },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("no_provider_for_model");
  });
});