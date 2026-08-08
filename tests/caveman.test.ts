/**
 * Caveman must never be able to break a request. Most of these tests assert
 * the *fallback* behaviour rather than the compression itself, because that is
 * the property that matters: a bad summariser should cost latency, never
 * correctness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CAVEMAN, type CavemanConfig } from "../src/config.js";
import { compressMessages, estimateTokens, measureOutput } from "../src/compress/caveman.js";
import type { OpenAIMessage } from "../src/upstream/translate.js";

function cfg(overrides: Partial<CavemanConfig> = {}): CavemanConfig {
  return {
    ...DEFAULT_CAVEMAN,
    enabled: true,
    baseUrl: "https://summariser.example/v1",
    apiKey: \"fixture-api-key\",
    model: "tiny",
    minTokens: 50,
    ...overrides,
  };
}

/** Build a conversation big enough to cross the compression threshold. */
function bigConversation(turns = 10): OpenAIMessage[] {
  const msgs: OpenAIMessage[] = [{ role: "system", content: "You are a helpful assistant." }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `Question number ${i} with quite a lot of padding text. `.repeat(6) });
    msgs.push({ role: "assistant", content: `Answer number ${i} with quite a lot of padding too. `.repeat(6) });
  }
  return msgs;
}

function summariserReturning(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("estimateTokens", () => {
  it("scales with length and handles empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("compressMessages", () => {
  it("does nothing when disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const messages = bigConversation();

    const r = await compressMessages(cfg({ enabled: false }), messages);

    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves short prompts alone", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await compressMessages(cfg({ minTokens: 100000 }), bigConversation());

    expect(r.compressed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a configuration problem without touching the messages", async () => {
    const messages = bigConversation();
    const r = await compressMessages(cfg({ baseUrl: "" }), messages);

    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
    expect(r.error).toMatch(/no endpoint or model/i);
  });

  it("compresses the older middle and reports the saving", async () => {
    vi.stubGlobal("fetch", summariserReturning("Dense summary of everything earlier."));

    const messages = bigConversation();
    const r = await compressMessages(cfg(), messages);

    expect(r.compressed).toBe(true);
    expect(r.after).toBeLessThan(r.before);
    expect(r.messages.length).toBeLessThan(messages.length);
  });

  it("keeps the system prompt verbatim", async () => {
    vi.stubGlobal("fetch", summariserReturning("summary"));

    const r = await compressMessages(cfg(), bigConversation());

    // Rewriting instructions changes behaviour rather than saving space.
    expect(r.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
  });

  it("forwards the newest turns untouched", async () => {
    vi.stubGlobal("fetch", summariserReturning("summary"));

    const messages = bigConversation();
    const last = messages.at(-1)!;
    const r = await compressMessages(cfg({ keepRecentMessages: 2 }), messages);

    expect(r.messages.at(-1)).toEqual(last);
  });

  it("falls back to the original when the summariser fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const messages = bigConversation();
    const r = await compressMessages(cfg(), messages);

    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
    expect(r.error).toBeTruthy();
  });

  it("falls back when the summariser throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));

    const messages = bigConversation();
    const r = await compressMessages(cfg(), messages);

    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
  });

  it("refuses a summary that is longer than the original", async () => {
    vi.stubGlobal("fetch", summariserReturning("padding ".repeat(5000)));

    const messages = bigConversation();
    const r = await compressMessages(cfg(), messages);

    // Keeping this would make compression actively harmful.
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
  });

  it("restores fenced code blocks verbatim", async () => {
    // The summariser echoes back the placeholder, as a well-behaved one would.
    vi.stubGlobal("fetch", summariserReturning("Earlier we discussed this snippet: [[CODE_0]] and moved on."));

    const code = "```ts\nconst answer: number = 42;\n```";
    const messages: OpenAIMessage[] = [
      { role: "user", content: `Here is some code ${code} ${"padding ".repeat(60)}` },
      { role: "assistant", content: "Noted. ".repeat(60) },
      { role: "user", content: "More context. ".repeat(60) },
      { role: "assistant", content: "Understood. ".repeat(60) },
      { role: "user", content: "Now what?" },
    ];

    const r = await compressMessages(cfg({ keepRecentMessages: 1, preserveCode: true }), messages);

    expect(r.compressed).toBe(true);
    expect(JSON.stringify(r.messages)).toContain("const answer: number = 42;");
  });

  it("sends the original when the summariser drops a code placeholder", async () => {
    // A model that paraphrases away the marker has deleted a whole code block.
    vi.stubGlobal("fetch", summariserReturning("We talked about some code and moved on."));

    const messages: OpenAIMessage[] = [
      { role: "user", content: "```js\nrunEverything();\n```" + " context ".repeat(80) },
      { role: "assistant", content: "Fine. ".repeat(80) },
      { role: "user", content: "More. ".repeat(80) },
      { role: "assistant", content: "Sure. ".repeat(80) },
      { role: "user", content: "Now?" },
    ];

    const r = await compressMessages(cfg({ keepRecentMessages: 1, preserveCode: true }), messages);

    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
    expect(r.error).toMatch(/placeholder/i);
  });

  it("sends the key as a header, never in the URL", async () => {
    const fetchMock = summariserReturning("summary");
    vi.stubGlobal("fetch", fetchMock);

    const config = cfg();
    await compressMessages(config, bigConversation());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(url).not.toContain(config.apiKey);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${config.apiKey}`);
  });

  it("does not rewrite tool call results", async () => {
    vi.stubGlobal("fetch", summariserReturning("summary"));

    const messages: OpenAIMessage[] = [
      { role: "user", content: "Do the thing. ".repeat(60) },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "exit code 0" },
      { role: "assistant", content: "Done. ".repeat(60) },
      { role: "user", content: "Thanks" },
    ];

    const r = await compressMessages(cfg({ keepRecentMessages: 1 }), messages);
    const serialised = JSON.stringify(r.messages);

    // A summarised function_call_output would break the client's tool loop.
    expect(serialised).toContain("exit code 0");
    expect(serialised).toContain("call_1");
  });
});

describe("measureOutput", () => {
  it("returns nothing when measurement is off", () => {
    expect(measureOutput(cfg({ measureOutput: false }), "some text")).toBeNull();
  });

  it("measures prose but never claims savings on code", () => {
    const prose = measureOutput(cfg(), "word ".repeat(200))!;
    const code = measureOutput(cfg(), "```\n" + "code();\n".repeat(120) + "```")!;

    expect(prose.measured).toBeGreaterThan(0);
    expect(prose.wouldSave).toBeGreaterThan(0);
    // Caveman would never rewrite fenced code, so it cannot claim a saving.
    expect(code.wouldSave).toBe(0);
  });
});
