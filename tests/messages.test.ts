/**
 * The inbound Anthropic Messages surface, and the tool round trip it depends on.
 *
 * Claude Code is a tool-driven client, so a conversation whose tool calls and
 * results are dropped stops making sense after the first turn — which is what
 * `toChatCompletionsBody` did to every OpenAI-compatible provider until these
 * tests existed.
 */

import { describe, expect, it } from "vitest";
import {
  ALIAS_PREFIX,
  fromAnthropicRequest,
  resolveRequestedModel,
} from "../src/api/messages.js";
import { classifyHttp } from "../src/pool/errors.js";
import { toCodexRequest } from "../src/upstream/translate.js";
import { testConfig } from "./fixtures.js";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

describe("translating an Anthropic request", () => {
  it("lifts the system block array into a system message", () => {
    const { messages } = fromAnthropicRequest(
      {
        system: [{ type: "text", text: "You are terse." }],
        messages: [{ role: "user", content: "hi" }],
      },
      "m",
    );
    expect(messages[0]).toEqual({ role: "system", content: "You are terse." });
  });

  it("keeps a plain text turn a string, not a part array", () => {
    const { messages } = fromAnthropicRequest(
      { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
      "m",
    );
    expect(messages[0]!.content).toBe("hello");
  });

  it("converts a base64 image block into an image_url part", () => {
    const { messages } = fromAnthropicRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
        ],
      },
      "m",
    );
    const parts = messages[0]!.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("maps tool_use and tool_result rather than flattening them to text", () => {
    const { messages, tools } = fromAnthropicRequest(
      {
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "read foo" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "foo" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "contents" }],
          },
        ],
      },
      "m",
    );

    expect(tools?.[0]?.function.name).toBe("read_file");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      id: "tu_1",
      function: { name: "read_file", arguments: JSON.stringify({ path: "foo" }) },
    });
    expect(messages.find((m) => m.role === "tool")).toMatchObject({
      tool_call_id: "tu_1",
      content: "contents",
    });
  });

  it("drops the model's own thinking blocks instead of replaying them as answers", () => {
    const { messages } = fromAnthropicRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm" },
              { type: "text", text: "the answer" },
            ],
          },
        ],
      },
      "m",
    );
    expect(messages[0]!.content).toBe("the answer");
  });
});

describe("mapping the requested model", () => {
  const cfg = testConfig({ anthropicDefaultModel: "auto", anthropicModelMap: {} });
  const servable = new Set(["auto", "gemini-3.7-flash-tiered", "gpt-4o"]);

  it("sends an unknown Claude model name to the configured default", () => {
    expect(resolveRequestedModel("claude-sonnet-4-6", cfg, servable)).toEqual({
      model: "auto",
      mapped: true,
    });
  });

  it("serves a model the pool really has under its own name", () => {
    expect(resolveRequestedModel("gpt-4o", cfg, servable)).toEqual({
      model: "gpt-4o",
      mapped: false,
    });
  });

  it("honours an explicit override above everything else", () => {
    const pinned = testConfig({
      anthropicDefaultModel: "auto",
      anthropicModelMap: { "claude-opus-4-6": "gemini-3.7-flash-tiered" },
    });
    expect(resolveRequestedModel("claude-opus-4-6", pinned, servable).model).toBe(
      "gemini-3.7-flash-tiered",
    );
  });
});

describe("a model's entitlement is not the credential's fault", () => {
  it("benches the model when a 403 says the model needs a paid plan", () => {
    const failure = classifyHttp(
      403,
      {
        error: {
          type: "invalid_request_error",
          message:
            "This premium model requires an active paid plan or real deposited balance. " +
            "Subscribe to a plan or top up your wallet to use it — promotional/bonus credits do not apply.",
        },
      },
      undefined,
    );

    // `terminal` would send this to markDead and kill a working account.
    expect(failure.kind).toBe("client");
    expect(failure.modelUnsupported).toBe(true);
  });

  it("cools rather than kills on a 403 it cannot interpret", () => {
    /*
     * Wording cannot be enumerated for every provider, so an unrecognised 403
     * must not be fatal. A needless cooldown costs minutes; a needless death
     * costs the account until a human revives it.
     */
    const failure = classifyHttp(403, { error: { message: "Forbidden" } }, undefined);
    expect(failure.kind).toBe("transient");
  });

  it("still kills a credential a provider says is revoked", () => {
    expect(classifyHttp(403, { error: { code: "token_revoked", message: "revoked" } }).kind).toBe(
      "terminal",
    );
    expect(classifyHttp(401, { error: { message: "invalid api key" } }).kind).toBe("terminal");
  });
});

describe("the discovery alias", () => {
  const cfg = testConfig({ anthropicDefaultModel: "auto", anthropicModelMap: {} });
  const servable = new Set(["auto", "gemini-3.8-flash-tiered"]);

  it("routes an aliased id to the real model", () => {
    expect(
      resolveRequestedModel(`${ALIAS_PREFIX}gemini-3.8-flash-tiered`, cfg, servable),
    ).toEqual({ model: "gemini-3.8-flash-tiered", mapped: false });
  });

  it("leaves an ordinary id alone", () => {
    expect(resolveRequestedModel("gemini-3.8-flash-tiered", cfg, servable).model).toBe(
      "gemini-3.8-flash-tiered",
    );
  });
});

describe("tool calls survive the round trip to an OpenAI-compatible provider", () => {
  it("keeps function_call and function_call_output as items, not messages", () => {
    // The normalised form the router builds from an Anthropic request.
    const { messages, tools } = fromAnthropicRequest(
      {
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "read foo" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "foo" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "contents" }],
          },
        ],
      },
      "m",
    );

    const body = toCodexRequest({ model: "m", messages, ...(tools ? { tools } : {}) });
    const kinds = body.input.map((i) => i.type);

    expect(kinds).toContain("function_call");
    expect(kinds).toContain("function_call_output");
    expect(body.tools?.[0]).toMatchObject({ name: "read_file" });
  });
});
