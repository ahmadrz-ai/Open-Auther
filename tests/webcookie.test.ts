/**
 * Web-session providers: credential extraction and the Kimi Connect protocol.
 *
 * A live session is needed to exercise the real endpoint, so these cover the
 * parts that are deterministic — the framing, the delta accounting, and what
 * we accept as a pasted credential.
 */

import { describe, expect, it } from "vitest";
import { extractWebCredential, WEB_COOKIE_BY_ID } from "../src/core/webcookie.js";
import {
  buildKimiPrompt,
  frameConnect,
  mapKimiFrame,
  newKimiSeen,
  unframeConnect,
} from "../src/upstream/kimiweb.js";
import { toCodexRequest } from "../src/upstream/translate.js";

describe("extractWebCredential", () => {
  it("takes the value out of a full Cookie header", () => {
    expect(
      extractWebCredential("kimi-web", "Cookie: foo=bar; access_token=abc123; other=x"),
    ).toBe("abc123");
  });

  it("accepts a bare value", () => {
    expect(extractWebCredential("kimi-web", "  abc123  ")).toBe("abc123");
  });

  it("accepts a bearer header", () => {
    expect(extractWebCredential("kimi-web", "Authorization: Bearer abc123")).toBe("abc123");
    expect(extractWebCredential("kimi-web", "bearer abc123")).toBe("abc123");
  });

  it("picks the right cookie per provider", () => {
    const header = "__Secure-1PSID=google-value; __Secure-next-auth.session-token=openai-value";
    expect(extractWebCredential("gemini-web", header)).toBe("google-value");
    expect(extractWebCredential("chatgpt-web", header)).toBe("openai-value");
  });

  it("returns empty when the named credential is absent", () => {
    // Better to reject than to store an unrelated cookie that fails later.
    expect(extractWebCredential("kimi-web", "unrelated=1; other=2")).toBe("");
    expect(extractWebCredential("kimi-web", "")).toBe("");
  });
});

describe("provider catalogue", () => {
  it("marks unimplemented providers so they cannot be connected", () => {
    expect(WEB_COOKIE_BY_ID.get("kimi-web")?.implemented).toBe(true);
    // Playwright-only and proof-of-work providers are listed but inert.
    expect(WEB_COOKIE_BY_ID.get("gemini-web")?.implemented).toBe(false);
    expect(WEB_COOKIE_BY_ID.get("deepseek-web")?.implemented).toBe(false);
  });

  it("includes the current Kimi K3 model in the web catalogue", () => {
    expect(WEB_COOKIE_BY_ID.get("kimi-web")?.defaultModels).toContain("kimi-k3");
  });
});

describe("Connect framing", () => {
  it("round-trips a message", () => {
    const framed = frameConnect(JSON.stringify({ hello: "world" }));
    expect(framed[0]).toBe(0);
    const { messages, rest } = unframeConnect(framed);
    expect(messages).toEqual([{ hello: "world" }]);
    expect(rest.length).toBe(0);
  });

  it("reads several frames from one buffer", () => {
    const a = frameConnect(JSON.stringify({ n: 1 }));
    const b = frameConnect(JSON.stringify({ n: 2 }));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);

    expect(unframeConnect(joined).messages).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("holds a partial frame back until the rest arrives", () => {
    // Frames straddle chunk boundaries constantly; dropping the tail here
    // would silently lose whatever the model said next.
    const full = frameConnect(JSON.stringify({ text: "hello world" }));
    const split = Math.floor(full.length / 2);

    const first = unframeConnect(full.subarray(0, split));
    expect(first.messages).toEqual([]);
    expect(first.rest.length).toBe(split);

    const merged = new Uint8Array(full.length);
    merged.set(first.rest);
    merged.set(full.subarray(split), first.rest.length);
    expect(unframeConnect(merged).messages).toEqual([{ text: "hello world" }]);
  });

  it("skips an unparseable frame rather than throwing", () => {
    const bad = frameConnect("{not json");
    const good = frameConnect(JSON.stringify({ ok: true }));
    const joined = new Uint8Array(bad.length + good.length);
    joined.set(bad);
    joined.set(good, bad.length);

    expect(unframeConnect(joined).messages).toEqual([{ ok: true }]);
  });
});

describe("mapKimiFrame", () => {
  // Shapes below are copied from a real www.kimi.com stream.
  const textFrame = (content: string, op = "set", id = "1") => ({
    op,
    mask: "block.text",
    block: { id, parentId: "", text: { content } },
  });

  it("emits only the new tail on a set, and the whole value on append", () => {
    const seen = newKimiSeen();

    expect(mapKimiFrame(textFrame("Hello"), seen)).toEqual([{ kind: "text", delta: "Hello" }]);
    // A second `set` restates the prefix — only the tail is new.
    expect(mapKimiFrame(textFrame("Hello there"), seen)).toEqual([
      { kind: "text", delta: " there" },
    ]);
    expect(mapKimiFrame(textFrame("!", "append"), seen)).toEqual([{ kind: "text", delta: "!" }]);
  });

  it("handles both masks the stream uses for one reply", () => {
    // Real sequence: opens with `block.text`/set, continues with
    // `block.text.content`/append. Handling only the first truncated every
    // reply to its opening chunk — "KIMI OK" arrived as "K".
    const seen = newKimiSeen();
    const out: string[] = [];
    const push = (f: Record<string, unknown>) => {
      for (const e of mapKimiFrame(f, seen)) if (e.kind === "text") out.push(e.delta);
    };

    push({ op: "set", mask: "block.text", block: { id: "1", text: { content: "K" } } });
    push({ op: "append", mask: "block.text.content", block: { id: "1", text: { content: "IM" } } });
    push({ op: "append", mask: "block.text.content", block: { id: "1", text: { content: "I" } } });
    push({ op: "append", mask: "block.text.content", block: { id: "1", text: { content: " OK" } } });

    expect(out.join("")).toBe("KIMI OK");
  });

  it("tracks blocks independently", () => {
    const seen = newKimiSeen();
    expect(mapKimiFrame(textFrame("one", "set", "1"), seen)).toEqual([
      { kind: "text", delta: "one" },
    ]);
    // A different block starts from nothing, not from block 1's content.
    expect(mapKimiFrame(textFrame("two", "set", "2"), seen)).toEqual([
      { kind: "text", delta: "two" },
    ]);
  });

  it("keeps reasoning separate from answer text", () => {
    const seen = newKimiSeen();
    expect(
      mapKimiFrame({ op: "set", mask: "block.think", block: { id: "t", think: { content: "hmm" } } }, seen),
    ).toEqual([{ kind: "reasoning", delta: "hmm" }]);
  });

  it("emits done when the assistant message completes", () => {
    expect(
      mapKimiFrame(
        { op: "set", mask: "message", message: { role: "assistant", status: "MESSAGE_STATUS_COMPLETED" } },
        newKimiSeen(),
      ),
    ).toContainEqual({ kind: "done", finishReason: "stop" });
  });

  it("surfaces an auth failure as 401, even though it arrives on a 200", () => {
    // Kimi answers a rejected token with HTTP 200 and this frame, so the body
    // is the only place the failure appears.
    const events = mapKimiFrame(
      { error: { code: "unauthenticated", message: "invalid user token" } },
      newKimiSeen(),
    );
    expect(events[0]).toMatchObject({ kind: "error", status: 401 });
  });

  it("ignores heartbeats and chat metadata", () => {
    const seen = newKimiSeen();
    expect(mapKimiFrame({ heartbeat: {} }, seen)).toEqual([]);
    expect(mapKimiFrame({ op: "set", mask: "chat.lastRequest", chat: { id: "x" } }, seen)).toEqual([]);
  });
});

describe("buildKimiPrompt", () => {
  const body = (messages: Parameters<typeof toCodexRequest>[0]["messages"]) =>
    toCodexRequest({ model: "kimi-k2", messages });

  it("passes a single turn through unchanged", () => {
    const { prompt } = buildKimiPrompt(body([{ role: "user", content: "hello" }]));
    expect(prompt).toBe("hello");
  });

  it("flattens history, because the web chat keeps no conversation for us", () => {
    const { prompt } = buildKimiPrompt(
      body([
        { role: "user", content: "I am in Berlin" },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "What should I wear?" },
      ]),
    );
    // Without this the follow-up loses Berlin entirely.
    expect(prompt).toContain("I am in Berlin");
    expect(prompt).toContain("Assistant: Noted.");
    expect(prompt).toContain("Current user message:\nWhat should I wear?");
  });

  it("keeps the system prompt out of the transcript", () => {
    const { prompt, systemPrompt } = buildKimiPrompt(
      body([
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ]),
    );
    expect(systemPrompt).toBe("Be terse.");
    expect(prompt).toBe("hi");
  });
});
