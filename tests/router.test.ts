/**
 * Failover behaviour, exercised against a stubbed upstream.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { now } from "../src/db.js";
import { Router } from "../src/router.js";
import { ensureFreshToken } from "../src/core/refresh.js";
import type { CodexEvent } from "../src/upstream/translate.js";
import { discoveredModel } from "../src/core/model-metadata.js";
import { credentialInput, makeStore, testConfig } from "./fixtures.js";

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: "hello" }],
};

/** A multimodal turn, which is what trips the vision requirement. */
const IMAGE_MESSAGE = {
  role: "user" as const,
  content: [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,test" } },
  ],
};

/** Build an SSE Response carrying the given upstream frames. */
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

const OK_FRAMES = [
  { type: "response.created", response: {} },
  { type: "response.output_text.delta", delta: "hi there" },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } } },
];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(events: AsyncGenerator<CodexEvent>): Promise<CodexEvent[]> {
  const out: CodexEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("router failover", () => {
  it("rotates past an exhausted credential without the client noticing", async () => {
    const store = makeStore();
    const first = store.add(credentialInput());
    const second = store.add(credentialInput());
    const resetsAt = now() + 86_400;

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${first.accessToken}`) {
        return jsonResponse(
          { type: "usage_limit_reached", plan_type: "free", resets_at: resetsAt },
          429,
        );
      }
      return sseResponse(OK_FRAMES);
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.credential.id).toBe(second.id);
    expect(outcome.attempts).toBe(2);

    const events = await collect(outcome.events);
    expect(events).toContainEqual({ kind: "text", delta: "hi there" });

    // The exhausted credential sleeps until upstream's own timestamp, not a guess.
    const cooled = store.get(first.id)!;
    expect(cooled.state).toBe("cooling");
    expect(cooled.cooldownUntil).toBe(resetsAt);
    expect(cooled.resetsAt).toBe(resetsAt);
    expect(cooled.lastError).toBe("usage_limit_reached");
  });

  it("drops a credential permanently on a terminal code", async () => {
    const store = makeStore();
    const first = store.add(credentialInput());
    store.add(credentialInput());

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1 ? jsonResponse({ type: "token_revoked" }, 401) : sseResponse(OK_FRAMES);
      }),
    );

    const outcome = await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(store.get(first.id)!.state).toBe("dead");
    expect(store.get(first.id)!.lastError).toBe("token_revoked");
  });

  it("returns 429 with the soonest reset once every credential is cooling", async () => {
    const store = makeStore();
    store.add(credentialInput());
    store.add(credentialInput());
    const resetsAt = now() + 3600;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ type: "usage_limit_reached", plan_type: "free", resets_at: resetsAt }, 429),
      ),
    );

    const outcome = await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(429);
    expect(outcome.code).toBe("pool_exhausted");
    expect(outcome.retryAt).toBe(resetsAt);
  });

  it("tries every credential when one says it does not have the model", async () => {
    /*
     * "Unknown model" means unknown *to that credential*. Aggregators disagree
     * about which ids they carry, so stopping at the first refusal failed
     * requests for models the pool could serve — a qwen model was refused by a
     * ChatGPT credential while three custom providers carrying it went untried.
     */
    const store = makeStore();
    store.add(credentialInput());
    store.add(credentialInput());

    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "unknown model", type: "invalid_request_error" } }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    // Both were tried, and neither was penalised: the account is not at fault.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.available()).toHaveLength(2);
  });

  it("succeeds on a later credential that does serve the model", async () => {
    const store = makeStore();
    const first = store.add(credentialInput());
    const second = store.add(credentialInput());

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${first.accessToken}`) {
        return jsonResponse(
          { error: { message: "The model is not supported when using Codex with a ChatGPT account" } },
          400,
        );
      }
      return sseResponse([{ choices: [{ delta: { content: "OK" } }] }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.credential.id).toBe(second.id);

    // The refusal is remembered, so the next request skips that pairing rather
    // than rediscovering it.
    expect(store.get(first.id)!.modelStats[REQUEST.model]?.ok).toBe(false);
    // And the refusing credential is still alive for its own models.
    expect(store.get(first.id)!.state).toBe("active");
  });

  it("rejects a direct model before upstream when it lacks requested vision", async () => {
    const store = makeStore();
    store.add(credentialInput({ customModels: ["o3-mini"] }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      {
        model: "o3-mini",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,test" } }],
          },
        ],
      },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("model_capability_mismatch");
    expect(outcome.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an image to a model the provider says takes images", async () => {
    const store = makeStore();
    const credential = store.add(credentialInput());
    store.setDiscoveredModels(credential.id, [
      discoveredModel("gemini-3.7-flash", { vision: true, contextWindow: 1_000_000 }),
    ]);

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      { model: "gemini-3.7-flash", messages: [IMAGE_MESSAGE] },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("lets an image through for a model nothing has described", async () => {
    /*
     * The reported bug. An id in no built-in table and with no published
     * manifest used to resolve to `unknown`, whose vision flag is false, and
     * the gate refused before the request left the machine. Nothing here knows
     * whether this model takes images — so the upstream gets to decide.
     */
    const store = makeStore();
    store.add(credentialInput({ customModels: ["house-model-v2"] }));

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      { model: "house-model-v2", messages: [IMAGE_MESSAGE] },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("follows a retired model id to the replacement the provider named", async () => {
    const store = makeStore();
    const credential = store.add(credentialInput());
    store.setDiscoveredModels(credential.id, [
      discoveredModel("gemini-3.7-flash", { vision: true }),
      discoveredModel("gemini-3.5-flash", { replacedBy: "gemini-3.7-flash", chat: false }),
    ]);

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      { model: "gemini-3.5-flash", messages: [{ role: "user", content: "hello" }] },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe("gemini-3.7-flash");
  });

  it("does not redirect to a replacement the pool cannot serve", async () => {
    const store = makeStore();
    const credential = store.add(credentialInput({ customModels: ["only-this"] }));
    store.setDiscoveredModels(credential.id, [
      discoveredModel("only-this"),
      discoveredModel("retired", { replacedBy: "not-in-the-pool", chat: false }),
    ]);

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      { model: "retired", messages: [{ role: "user", content: "hello" }] },
      new AbortController().signal,
    );

    // Trading one dead end for another helps nobody; the original id stands
    // and fails on its own terms.
    expect(outcome.ok).toBe(false);
  });

  it("filters incapable candidates before ranking a virtual model", async () => {
    const store = makeStore();
    store.add(credentialInput({ customModels: ["o3-mini"] }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      {
        model: "fast",
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,test" } }] },
        ],
      },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_model_available");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says no provider can serve the model, rather than blaming rate limits", async () => {
    const store = makeStore();
    store.add(
      credentialInput({ providerType: "gemini", accessToken: "AIza-fake-key", accountId: "gemini_x" }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_provider_for_model");
    expect(outcome.status).toBe(400);
    // And it must not have spent a request finding that out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an empty pool distinctly from an exhausted one", async () => {
    const outcome = await new Router(testConfig(), makeStore()).chat(
      REQUEST,
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
    expect(outcome.code).toBe("no_credentials");
  });

  it("stops after maxAttempts rather than sweeping the whole pool", async () => {
    const store = makeStore();
    for (let i = 0; i < 6; i++) store.add(credentialInput());

    const fetchMock = vi.fn(async () => jsonResponse({ type: "server_error" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig({ maxAttempts: 2 }), store).chat(
      REQUEST,
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never puts credentials in the URL", async () => {
    const store = makeStore();
    const c = store.add(credentialInput());

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    await new Router(testConfig(), store).chat(REQUEST, new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(url).not.toContain(c.accessToken!);
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${c.accessToken}`,
    );
    expect((init.headers as Record<string, string>)["chatgpt-account-id"]).toBe(c.accountId);
  });
});

describe("stream continuity after priming", () => {
  it("delivers every chunk, not just the one that triggered commit", async () => {
    const store = makeStore();
    store.add(credentialInput());

    // Three separate text frames. Priming commits on the first, so the other
    // two only survive if the stream is resumed rather than reopened.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "one " },
          { type: "response.output_text.delta", delta: "two " },
          { type: "response.output_text.delta", delta: "three" },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } },
          },
        ]),
      ),
    );

    const outcome = await new Router(testConfig(), store).chat(
      REQUEST,
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const events = await collect(outcome.events);
    const text = events.filter((e) => e.kind === "text").map((e) => e.delta).join("");

    // Breaking out of a `for await` closes the generator; that truncated every
    // reply to its first chunk and dropped usage entirely.
    expect(text).toBe("one two three");
    expect(events).toContainEqual({
      kind: "usage",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop" });
  });

  it("keeps usage that arrives in the same frame as the first content", async () => {
    const store = makeStore();
    store.add(credentialInput());

    // OpenAI-compatible providers (Gemini among them) attach usage to every
    // chunk, including the one priming commits on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "ROUTER" } }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          },
          {
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: " OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          },
        ]),
      ),
    );

    const outcome = await new Router(testConfig(), store).chat(
      REQUEST,
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const events = await collect(outcome.events);
    expect(events.filter((e) => e.kind === "text").map((e) => e.delta).join("")).toBe("ROUTER OK");
    expect(events.filter((e) => e.kind === "usage").at(-1)).toEqual({
      kind: "usage",
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
  });
});

describe("pinned routing", () => {
  it("uses only the pinned Auth and never fails over", async () => {
    const store = makeStore();
    const first = store.add(credentialInput());
    const second = store.add(credentialInput());

    const fetchMock = vi.fn(async () => sseResponse(OK_FRAMES));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      REQUEST,
      new AbortController().signal,
      { pinnedCredentialId: second.id },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // fill_first would otherwise have picked `first`.
    expect(outcome.credential.id).toBe(second.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> })
      .headers.authorization).toBe(`Bearer ${second.accessToken}`);
    expect(store.get(first.id)!.requestCount).toBe(0);
  });

  it("reports the real failure instead of claiming the pool is exhausted", async () => {
    const store = makeStore();
    const pinned = store.add(credentialInput());
    store.add(credentialInput());
    const resetsAt = now() + 3600;

    const fetchMock = vi.fn(async () =>
      jsonResponse({ type: "usage_limit_reached", resets_at: resetsAt }, 429),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new Router(testConfig(), store).chat(
      REQUEST,
      new AbortController().signal,
      { pinnedCredentialId: pinned.id },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("usage_limit_reached");
    expect(outcome.retryAt).toBe(resetsAt);
    // One attempt only: no other credential was touched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can test an Auth that is currently cooling", async () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    store.markCooling(c.id, now() + 7200, "usage_limit_reached");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(OK_FRAMES)));

    // Normal routing skips a cooling credential; pinning deliberately does not,
    // because "has this recovered yet?" is a legitimate question to ask.
    const outcome = await new Router(testConfig(), store).chat(
      REQUEST,
      new AbortController().signal,
      { pinnedCredentialId: c.id },
    );

    expect(outcome.ok).toBe(true);
  });

  it("404s on an unknown Auth", async () => {
    const outcome = await new Router(testConfig(), makeStore()).chat(
      REQUEST,
      new AbortController().signal,
      { pinnedCredentialId: 999 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(404);
    expect(outcome.code).toBe("credential_not_found");
  });
});

describe("token refresh", () => {
  it("refreshes only once when many requests race the same credential", async () => {
    const store = makeStore();
    const cfg = testConfig();
    // Already expired, so every caller wants a refresh.
    const c = store.add(credentialInput({ accessExpiresAt: now() - 10 }));

    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 15));
        return jsonResponse(
          { access_token: `fresh-access-${refreshes}`, refresh_token: "next-rt", expires_in: 3600 },
          200,
        );
      }),
    );

    await Promise.all(
      Array.from({ length: 5 }, () => ensureFreshToken(store, cfg, c.id)),
    );

    // Single-use refresh tokens: a second concurrent refresh would kill the
    // credential outright.
    expect(refreshes).toBe(1);
    expect(store.get(c.id)!.accessToken).toBe("fresh-access-1");
  });

  it("kills the credential when the issuer reports invalid_grant", async () => {
    const store = makeStore();
    const cfg = testConfig();
    const c = store.add(credentialInput({ accessExpiresAt: now() - 10 }));

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));

    await expect(ensureFreshToken(store, cfg, c.id)).rejects.toThrow();
    expect(store.get(c.id)!.state).toBe("dead");
  });

  it("does not kill the credential on a network blip", async () => {
    const store = makeStore();
    const cfg = testConfig();
    const c = store.add(credentialInput({ accessExpiresAt: now() - 10 }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }),
    );

    await expect(ensureFreshToken(store, cfg, c.id)).rejects.toThrow();
    expect(store.get(c.id)!.state).not.toBe("dead");
  });
});
