/**
 * Antigravity request/response translation.
 *
 * The OAuth flow itself needs a real Google sign-in, so these cover the parts
 * that can be verified offline: the Gemini request shape the Cloud Code
 * backend enforces, and the frame mapping coming back.
 */

import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_DEFAULT_MODELS } from "../src/core/antigravity.js";
import {
  buildEnvelope,
  mapAntigravityEvent,
  toGeminiRequest,
} from "../src/upstream/antigravity.js";
import { toCodexRequest } from "../src/upstream/translate.js";
import { blamesModel } from "../src/router.js";

const body = (messages: Parameters<typeof toCodexRequest>[0]["messages"], extra = {}) =>
  toCodexRequest({ model: "gemini-2.5-flash", messages, ...extra });

describe("Antigravity model catalogue", () => {
  /*
   * Asserting the exact array froze a list that included tab-completion,
   * image-generation and deprecated ids while claiming they were "proven live".
   * These assert the properties that actually decide whether routing works.
   */
  it("carries the current generation the account is entitled to", () => {
    // Verified serving live on 2026-08-11 against a real Antigravity account.
    for (const model of [
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-low",
      "gemini-3.1-flash-lite",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "gpt-oss-120b-medium",
    ]) {
      expect(ANTIGRAVITY_DEFAULT_MODELS).toContain(model);
    }
  });

  it("excludes surfaces that cannot serve a chat turn", () => {
    // Tab completion and image generation are in the backend catalogue but
    // answer "invalid argument" for a chat request.
    for (const model of [
      "chat_20706",
      "chat_23310",
      "tab_flash_lite_preview",
      "tab_jump_flash_lite_preview",
      "gemini-3.1-flash-image",
    ]) {
      expect(ANTIGRAVITY_DEFAULT_MODELS).not.toContain(model);
    }
  });

  it("excludes ids the backend has deprecated or renamed", () => {
    // gemini-3.1-pro-high 400s; the backend names gemini-pro-agent instead.
    expect(ANTIGRAVITY_DEFAULT_MODELS).not.toContain("gemini-3.1-pro-high");
    expect(ANTIGRAVITY_DEFAULT_MODELS).toContain("gemini-pro-agent");

    // Names from an older client generation that no longer resolve.
    expect(ANTIGRAVITY_DEFAULT_MODELS).not.toContain("gemini-3-flash-preview");
    expect(ANTIGRAVITY_DEFAULT_MODELS).not.toContain("gemini-3-pro-preview");
    expect(ANTIGRAVITY_DEFAULT_MODELS).not.toContain("claude-sonnet-4.5");
  });

  it("has no duplicates and is sorted, so diffs stay readable", () => {
    expect(new Set(ANTIGRAVITY_DEFAULT_MODELS).size).toBe(ANTIGRAVITY_DEFAULT_MODELS.length);
    expect([...ANTIGRAVITY_DEFAULT_MODELS].sort()).toEqual(ANTIGRAVITY_DEFAULT_MODELS);
  });
});

describe("toGeminiRequest", () => {
  it("maps assistant turns to the model role", () => {
    const r = toGeminiRequest(
      body([
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ]),
    );
    const contents = r.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[0]!.parts[0]!.text).toBe("one");
  });

  it("merges consecutive same-role turns", () => {
    // Cloud Code 400s on two adjacent turns with the same role.
    const r = toGeminiRequest(
      body([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]),
    );
    const contents = r.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.parts).toHaveLength(2);
  });

  it("never emits an empty parts array", () => {
    const r = toGeminiRequest(
      body([
        { role: "user", content: "" },
        { role: "assistant", content: "" },
      ]),
    );
    const contents = r.contents as Array<{ parts: unknown[] }>;
    for (const c of contents) expect(c.parts.length).toBeGreaterThan(0);
  });

  it("puts the system prompt in systemInstruction, not contents", () => {
    const r = toGeminiRequest(
      body([
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ]),
    );
    expect(r.systemInstruction).toEqual({ role: "user", parts: [{ text: "Be terse." }] });
    expect((r.contents as unknown[]).length).toBe(1);
  });

  it("sends a tool result as a user turn", () => {
    const r = toGeminiRequest(
      body([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "12C" },
      ]),
    );
    const contents = r.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;

    // functionCall belongs to the model turn; its response is a user turn.
    expect(contents[1]!.role).toBe("model");
    expect(contents[1]!.parts[0]!.functionCall).toMatchObject({ name: "get_weather" });
    expect(contents[2]!.role).toBe("user");
    expect(contents[2]!.parts[0]!.functionResponse).toBeDefined();
  });

  it("converts tool definitions to functionDeclarations", () => {
    const r = toGeminiRequest(
      body([{ role: "user", content: "x" }], {
        tools: [
          {
            type: "function",
            function: { name: "search", description: "find", parameters: { type: "object" } },
          },
        ],
      }),
    );
    const tools = r.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0]!.functionDeclarations[0]!.name).toBe("search");
    expect(r.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });

  it("maps generation settings to Gemini names", () => {
    const r = toGeminiRequest(
      body([{ role: "user", content: "x" }], { temperature: 0.3, top_p: 0.9, max_tokens: 512 }),
    );
    expect(r.generationConfig).toEqual({ temperature: 0.3, topP: 0.9, maxOutputTokens: 512 });
  });
});

describe("buildEnvelope", () => {
  it("wraps the request with the project id", () => {
    const e = buildEnvelope(body([{ role: "user", content: "hi" }]), "proj-123");
    expect(e.project).toBe("proj-123");
    expect(e.model).toBe("gemini-2.5-flash");
    expect(e.userAgent).toBe("antigravity");
    expect(e.requestType).toBe("agent");
    expect(e.requestId).toEqual(expect.any(String));
    expect((e.request as Record<string, unknown>).contents).toBeDefined();
  });
});

describe("mapAntigravityEvent", () => {
  const frame = (candidate: unknown, extra: Record<string, unknown> = {}) => ({
    response: { candidates: [candidate], ...extra },
  });

  it("maps text parts", () => {
    const events = mapAntigravityEvent(frame({ content: { parts: [{ text: "hello" }] } }));
    expect(events).toContainEqual({ kind: "text", delta: "hello" });
  });

  it("separates thought parts from answer text", () => {
    const events = mapAntigravityEvent(
      frame({ content: { parts: [{ text: "pondering", thought: true }, { text: "answer" }] } }),
    );
    expect(events).toContainEqual({ kind: "reasoning", delta: "pondering" });
    expect(events).toContainEqual({ kind: "text", delta: "answer" });
  });

  it("maps a function call", () => {
    const events = mapAntigravityEvent(
      frame({ content: { parts: [{ functionCall: { name: "run", args: { a: 1 } } }] } }),
    );
    const call = events.find((e) => e.kind === "tool_call");
    expect(call).toMatchObject({ name: "run", arguments: '{"a":1}' });
  });

  it("maps finish reason and usage", () => {
    const events = mapAntigravityEvent(
      frame(
        { content: { parts: [] }, finishReason: "STOP" },
        { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } },
      ),
    );
    expect(events).toContainEqual({ kind: "done", finishReason: "stop" });
    expect(events).toContainEqual({
      kind: "usage",
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
  });

  it("reports truncation as length", () => {
    const events = mapAntigravityEvent(frame({ content: { parts: [] }, finishReason: "MAX_TOKENS" }));
    expect(events).toContainEqual({ kind: "done", finishReason: "length" });
  });

  it("handles frames that are not wrapped in `response`", () => {
    // Some Cloud Code frames arrive unwrapped.
    const events = mapAntigravityEvent({
      candidates: [{ content: { parts: [{ text: "bare" }] } }],
    });
    expect(events).toContainEqual({ kind: "text", delta: "bare" });
  });

  it("surfaces an error payload", () => {
    const events = mapAntigravityEvent({ error: { code: 429, message: "quota" } });
    expect(events[0]).toMatchObject({ kind: "error", status: 429 });
  });

  it("ignores frames it does not recognise", () => {
    expect(mapAntigravityEvent({})).toEqual([]);
    expect(mapAntigravityEvent({ response: {} })).toEqual([]);
  });
});

describe("blamesModel", () => {
  /*
   * The rule that broke Antigravity: every failure was recorded as the model's
   * fault, so a busy model was benched permanently. An account serving
   * seventeen models advertised two.
   */
  it("blames the model only when the request itself was rejected", () => {
    expect(blamesModel(400)).toBe(true); // invalid/unknown model
    expect(blamesModel(404)).toBe(true); // no such model for this account
    expect(blamesModel(501)).toBe(true);
    expect(blamesModel(505)).toBe(true);
  });

  it("does not blame the model for capacity, quota or outages", () => {
    // "No capacity available for model gemini-2.5-pro" is a 503 — try later.
    expect(blamesModel(503)).toBe(false);
    expect(blamesModel(429)).toBe(false);
    expect(blamesModel(500)).toBe(false);
    expect(blamesModel(502)).toBe(false);
    expect(blamesModel(504)).toBe(false);
  });

  it("does not blame the model when there is no status at all", () => {
    // A transport error says nothing about the model.
    expect(blamesModel(null)).toBe(false);
  });
});
