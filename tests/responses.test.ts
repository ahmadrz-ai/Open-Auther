/**
 * POST /v1/responses relays the Codex backend's own Responses stream.
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { responsesHandler } from "../src/api/responses.js";
import { now } from "../src/db.js";
import { Router } from "../src/router.js";
import { credentialInput, makeStore, testConfig } from "./fixtures.js";

const FRAMES = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.custom_tool_call_input.delta", delta: "*** Begin Patch" },
  { type: "response.output_text.delta", delta: "hi there" },
  {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
  },
];

function sse(frames: unknown[]): string {
  return frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
}

function appFor(store: ReturnType<typeof makeStore>) {
  const cfg = testConfig();
  const app = new Hono();
  app.post("/v1/responses", responsesHandler(cfg, new Router(cfg, store), store));
  return app;
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /v1/responses", () => {
  it("relays the upstream stream verbatim and rotates past an exhausted credential", async () => {
    const store = makeStore();
    const first = store.add(credentialInput());
    const second = store.add(credentialInput());
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        if ((init.headers as Record<string, string>).authorization === `Bearer ${first.accessToken}`) {
          return new Response(JSON.stringify({ type: "usage_limit_reached", resets_at: now() + 3600 }), { status: 429 });
        }
        return new Response(sse(FRAMES), { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );

    const res = await appFor(store).request("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", input: [{ role: "user", content: "hello" }], stream: true, store: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ai-auther-account")).toBe(String(second.id));
    // Byte-for-byte: event types the Chat Completions translation drops survive.
    expect(await res.text()).toBe(sse(FRAMES));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toMatch(/\/responses$/);
    expect(sent[1]!.body).toMatchObject({ model: "gpt-4o", stream: true, store: false });
    expect(store.get(first.id)!.state).toBe("cooling");
  });

  it("answers a non-streaming client with the completed response", async () => {
    const store = makeStore();
    store.add(credentialInput());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse(FRAMES), { status: 200 })));

    const res = await appFor(store).request("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "resp_1", status: "completed", usage: { total_tokens: 6 } });
  });

  it("never sends a Responses body to a non-Codex provider", async () => {
    const store = makeStore();
    store.add(credentialInput({ providerType: "gemini", accessToken: "AIza-test-key" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await appFor(store).request("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-2.5-pro", input: "hello", stream: true }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
