/**
 * What actually reaches the upstream when a request carries an image.
 *
 * The gateway accepted image requests, and 1.1.0 stopped the capability gate
 * refusing them — but every transport except Codex still flattened content
 * with `parts.map(p => p.text).join("")`. An image part has no `text`, so it
 * became an empty string and vanished; an image-only turn flattened to "" and
 * the Gemini builder skipped it as an empty turn.
 *
 * No existing test caught it, because every test asserted the gateway's own
 * bookkeeping and none asserted the outgoing payload. These do.
 */

import { describe, expect, it } from "vitest";
import { toAnthropicRequest } from "../src/upstream/anthropic.js";
import { parseRetiredNotice, toGeminiRequest } from "../src/upstream/antigravity.js";
import { imagesOf, parseImagePart, textOfParts } from "../src/upstream/media.js";
import { toCodexRequest } from "../src/upstream/translate.js";

const PNG_BODY = "iVBORw0KGgoAAAANSUhEUg==";
const PNG = `data:image/png;base64,${PNG_BODY}`;
const REMOTE = "https://example.com/shot.jpg";

function requestWith(url: string, text = "what is in this screenshot?") {
  return toCodexRequest({
    model: "probe",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  });
}

/** An image with no accompanying text — the case that used to vanish whole. */
function imageOnlyRequest() {
  return toCodexRequest({
    model: "probe",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "image_url", image_url: { url: PNG } }],
      },
    ],
  });
}

describe("parsing image parts", () => {
  it("splits a data URL into media type and payload", () => {
    expect(parseImagePart(PNG)).toEqual({
      kind: "base64",
      mimeType: "image/png",
      data: PNG_BODY,
    });
  });

  it("keeps a remote URL and guesses its media type from the extension", () => {
    expect(parseImagePart(REMOTE)).toEqual({
      kind: "url",
      mimeType: "image/jpeg",
      url: REMOTE,
    });
  });

  it("rejects anything unusable rather than forwarding it", () => {
    expect(parseImagePart("data:text/plain,hello")).toBeNull();
    expect(parseImagePart("not-a-url")).toBeNull();
    expect(parseImagePart("")).toBeNull();
    expect(parseImagePart(undefined)).toBeNull();
  });

  it("separates text from images without losing either", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "input_image", image_url: PNG },
      { type: "text", text: "world" },
    ];
    expect(textOfParts(content)).toBe("hello world");
    expect(imagesOf(content)).toHaveLength(1);
  });
});

describe("Gemini / Antigravity", () => {
  it("sends the image as inlineData alongside the prompt", () => {
    const request = toGeminiRequest(requestWith(PNG));
    const contents = request.contents as Array<{ role: string; parts: unknown[] }>;
    const parts = contents[0]!.parts as Array<Record<string, unknown>>;

    expect(contents[0]!.role).toBe("user");
    expect(parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_BODY } });
    // Image before the text that refers to it.
    expect(parts[1]).toEqual({ text: "what is in this screenshot?" });
  });

  it("sends a remote image as fileData", () => {
    const request = toGeminiRequest(requestWith(REMOTE));
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]!.parts[0]).toEqual({
      fileData: { mimeType: "image/jpeg", fileUri: REMOTE },
    });
  });

  it("keeps an image-only turn, which used to be dropped entirely", () => {
    const request = toGeminiRequest(imageOnlyRequest());
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;

    expect(contents).toHaveLength(1);
    expect(contents[0]!.parts).toHaveLength(1);
    expect(contents[0]!.parts[0]).toHaveProperty("inlineData");
  });

  it("still drops a genuinely empty turn, which the backend 400s on", () => {
    const request = toGeminiRequest(
      toCodexRequest({ model: "probe", messages: [{ role: "user", content: "" }] }),
    );
    const contents = request.contents as Array<{ parts: unknown[] }>;
    // Falls back to a single empty user turn rather than an empty parts array.
    expect(contents).toHaveLength(1);
    expect(contents[0]!.parts).toHaveLength(1);
  });
});

describe("Anthropic Messages", () => {
  it("sends the image as a base64 source block", () => {
    const request = toAnthropicRequest(requestWith(PNG));
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;

    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BODY },
    });
    expect(blocks[1]).toEqual({ type: "text", text: "what is in this screenshot?" });
  });

  it("sends a remote image as a url source", () => {
    const request = toAnthropicRequest(requestWith(REMOTE));
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]!.content[0]).toEqual({
      type: "image",
      source: { type: "url", url: REMOTE },
    });
  });

  it("leaves a plain text turn as a string, which every version accepts", () => {
    const request = toAnthropicRequest(
      toCodexRequest({ model: "probe", messages: [{ role: "user", content: "hello" }] }),
    );
    const messages = request.messages as Array<{ content: unknown }>;
    expect(messages[0]!.content).toBe("hello");
  });
});

describe("retirement notices delivered as an answer", () => {
  it("reads the retired model and its replacement out of the sentence", () => {
    expect(
      parseRetiredNotice(
        "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.",
      ),
    ).toEqual({ retired: "Gemini 3.5 Flash", replacement: "Gemini 3.7 Flash" });
  });

  it("handles the notice without the trailing clause", () => {
    expect(parseRetiredNotice("Foo Model is no longer available. Switch to Bar Model.")).toEqual({
      retired: "Foo Model",
      replacement: "Bar Model",
    });
  });

  it("does not fire on ordinary prose that merely resembles it", () => {
    expect(parseRetiredNotice("The API is no longer available in your region.")).toBeNull();
    expect(parseRetiredNotice("Here is a summary of the screenshot.")).toBeNull();
    expect(parseRetiredNotice("")).toBeNull();
  });
});
