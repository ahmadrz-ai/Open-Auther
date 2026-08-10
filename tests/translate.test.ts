import { describe, expect, it } from "vitest";
import { mapCodexEvent, toCodexRequest } from "../src/upstream/translate.js";

describe("toCodexRequest", () => {
  it("lifts system and developer messages into instructions", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "developer", content: "Prefer TypeScript." },
        { role: "user", content: "hi" },
      ],
    });

    expect(body.instructions).toBe("Be terse.\n\nPrefer TypeScript.");
    // Instructions must not also appear as input items, or they get repeated.
    expect(body.input).toHaveLength(1);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
  });

  it("maps user and assistant turns to typed content parts", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });

    expect(body.input).toHaveLength(3);
    expect(body.input[0]!.content).toEqual([{ type: "input_text", text: "one" }]);
    expect(body.input[1]!.content).toEqual([{ type: "output_text", text: "two" }]);
  });

  it("flattens multipart content and preserves images", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });

    expect(body.input[0]!.content).toEqual([
      { type: "input_text", text: "look at this" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("emits tool calls and their results as separate items", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "12C" },
      ],
    });

    expect(body.input[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Oslo"}',
    });
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "12C",
    });
  });

  it("converts tool definitions to the flat upstream shape", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "search the web",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    });

    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "search",
      description: "search the web",
      strict: false,
    });
  });

  it("always streams upstream and never stores conversation state", () => {
    const body = toCodexRequest({
      model: "gpt-5-codex",
      messages: [{ role: "user", content: "x" }],
      stream: false,
    });

    // The backend only streams; non-streaming client requests are aggregated
    // on our side. `store: false` keeps history off the user's account.
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  it("matches the native Hermes Codex request shape when no tools are present", () => {
    const body = toCodexRequest({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "x" }],
      temperature: 0.2,
      max_completion_tokens: 256,
    });

    // Hermes omits unsupported sampling/token fields and does not send an
    // empty tool envelope. The subscription Codex endpoint is stricter than
    // api.openai.com's Chat Completions endpoint.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("only emits tool controls when actual tools are present", () => {
    const body = toCodexRequest({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
      parallel_tool_calls: true,
    });

    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("maps reasoning to the Codex Responses fields", () => {
    const body = toCodexRequest({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "high",
    });

    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("uses Hermes' Codex defaults when the OpenAI-compatible client omits reasoning controls", () => {
    const body = toCodexRequest({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "x" }],
    });

    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("forwards the model verbatim and never substitutes one", () => {
    // Silently swapping the model means the caller gets a plausible answer
    // from a model they did not ask for, with nothing to indicate it.
    for (const model of ["gpt-5-codex", "GPT-5.6-luna", "gpt-4o", "gemini-3.5-flash"]) {
      expect(
        toCodexRequest({ model, messages: [{ role: "user", content: "x" }] }).model,
      ).toBe(model);
    }
  });
});

describe("mapCodexEvent", () => {
  const idx = () => ({ next: 0 });

  it("maps text deltas", () => {
    expect(mapCodexEvent({ type: "response.output_text.delta", delta: "hel" }, idx())).toEqual([
      { kind: "text", delta: "hel" },
    ]);
  });

  it("maps reasoning deltas separately from text", () => {
    expect(
      mapCodexEvent({ type: "response.reasoning_summary_text.delta", delta: "thinking" }, idx()),
    ).toEqual([{ kind: "reasoning", delta: "thinking" }]);
  });

  it("maps a completed function call", () => {
    const events = mapCodexEvent(
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_9", name: "run", arguments: "{}" },
      },
      idx(),
    );
    expect(events).toEqual([
      { kind: "tool_call", index: 0, id: "call_9", name: "run", arguments: "{}" },
    ]);
  });

  it("emits usage and a finish reason on completion", () => {
    const events = mapCodexEvent(
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      },
      idx(),
    );
    expect(events).toEqual([
      { kind: "usage", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { kind: "done", finishReason: "stop" },
    ]);
  });

  it("reports truncation as finish_reason length", () => {
    const events = mapCodexEvent(
      { type: "response.completed", response: { status: "incomplete" } },
      idx(),
    );
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "length" });
  });

  it("surfaces failures as error events", () => {
    expect(mapCodexEvent({ type: "response.failed", response: { x: 1 } }, idx())[0]!.kind).toBe(
      "error",
    );
  });

  it("ignores unknown event types instead of failing", () => {
    expect(mapCodexEvent({ type: "response.some.future.event" }, idx())).toEqual([]);
    expect(mapCodexEvent({}, idx())).toEqual([]);
  });
});
