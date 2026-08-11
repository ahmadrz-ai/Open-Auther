/**
 * The Anthropic Messages protocol adapter.
 *
 * Custom providers were assumed OpenAI-compatible unconditionally, so an
 * Anthropic endpoint 404'd on /chat/completions with nothing to explain it.
 */

import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_VERSION,
  anthropicHeaders,
  mapAnthropicEvent,
  toAnthropicRequest,
} from "../src/upstream/anthropic.js";
import { toCodexRequest } from "../src/upstream/translate.js";
import { credentialInput } from "./fixtures.js";

const body = (messages: Parameters<typeof toCodexRequest>[0]["messages"], extra = {}) =>
  toCodexRequest({ model: "claude-sonnet-4-6", messages, ...extra });

describe("anthropicHeaders", () => {
  it("uses x-api-key and the mandatory version header", () => {
    // Bearer auth and a missing version header both 400 here, unlike OpenAI.
    const h = anthropicHeaders({ ...credentialInput(), accessToken: "sk-ant-xyz" } as never);
    expect(h["x-api-key"]).toBe("sk-ant-xyz");
    expect(h["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(h.authorization).toBeUndefined();
  });
});

describe("toAnthropicRequest", () => {
  it("lifts the system prompt out of the turn list", () => {
    const r = toAnthropicRequest(
      body([
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ]),
    );
    expect(r.system).toBe("Be terse.");
    expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("always sends max_tokens, which Anthropic requires", () => {
    const r = toAnthropicRequest(body([{ role: "user", content: "hi" }]));
    expect(typeof r.max_tokens).toBe("number");
    expect(r.max_tokens as number).toBeGreaterThan(0);
  });

  it("honours a caller-supplied token ceiling", () => {
    const r = toAnthropicRequest(body([{ role: "user", content: "hi" }], { max_tokens: 32 }));
    expect(r.max_tokens).toBe(32);
  });

  it("merges adjacent same-role turns", () => {
    // Anthropic rejects two consecutive user turns.
    const r = toAnthropicRequest(
      body([
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ]),
    );
    expect(r.messages).toEqual([{ role: "user", content: "one\n\ntwo" }]);
  });

  it("always begins with a user turn", () => {
    const r = toAnthropicRequest(body([{ role: "assistant", content: "I spoke first" }]));
    expect((r.messages as Array<{ role: string }>)[0]!.role).toBe("user");
  });
});

describe("mapAnthropicEvent", () => {
  const seen = () => ({ inputTokens: 0, outputTokens: 0 });

  it("maps text deltas", () => {
    const s = seen();
    const events = mapAnthropicEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      s,
    );
    expect(events).toContainEqual({ kind: "text", delta: "hello" });
  });

  it("separates thinking from answer text", () => {
    const s = seen();
    const events = mapAnthropicEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      s,
    );
    expect(events).toContainEqual({ kind: "reasoning", delta: "hmm" });
    expect(events.some((e) => e.kind === "text")).toBe(false);
  });

  it("assembles usage from the two frames that carry it", () => {
    // input_tokens arrives on message_start, output_tokens on message_delta.
    const s = seen();
    mapAnthropicEvent({ type: "message_start", message: { usage: { input_tokens: 11 } } }, s);
    const events = mapAnthropicEvent(
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      s,
    );
    expect(events).toContainEqual({
      kind: "usage",
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    });
    expect(events).toContainEqual({ kind: "done", finishReason: "stop" });
  });

  it("translates stop reasons into OpenAI's vocabulary", () => {
    const s = seen();
    const events = mapAnthropicEvent(
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} },
      s,
    );
    expect(events).toContainEqual({ kind: "done", finishReason: "length" });
  });

  it("surfaces an error frame as an error event", () => {
    const s = seen();
    const events = mapAnthropicEvent({ type: "error", error: { message: "overloaded" } }, s);
    expect(events[0]!.kind).toBe("error");
  });
});
