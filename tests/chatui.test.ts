import { describe, expect, it } from "vitest";
import { virtualChatModels } from "../src/api/chatui-meta.js";

describe("chat virtual model metadata", () => {
  it("advertises auto, fast, and quality when real models exist", () => {
    expect(virtualChatModels(["gemini", "codex_oauth"], true).map((m) => m.id)).toEqual([
      "auto",
      "fast",
      "quality",
    ]);
  });

  it("does not advertise virtual models when no real model is available", () => {
    expect(virtualChatModels(["gemini"], false)).toEqual([]);
  });
});
