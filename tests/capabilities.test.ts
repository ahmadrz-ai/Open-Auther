import { describe, expect, it } from "vitest";
import {
  UNKNOWN_MODEL,
  capabilitiesFor,
  meetsRequirements,
  requirementsForRequest,
} from "../src/core/capabilities.js";

describe("request capability requirements", () => {
  it("detects vision input from multimodal message parts", () => {
    const requirements = requirementsForRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:image/png;base64,test" } }] },
      ],
    });

    expect(requirements).toEqual({ vision: true, tools: false, reasoning: false });
  });

  it("detects tools and reasoning independently", () => {
    expect(
      requirementsForRequest({
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
        reasoning_effort: "high",
      }),
    ).toEqual({ vision: false, tools: true, reasoning: true });
  });

  it("matches built-in capabilities case-insensitively for discovered model ids", () => {
    expect(capabilitiesFor("gpt-5.6-luna").reasoning).toBe(true);
    expect(capabilitiesFor("gpt-5.6-luna").source).toBe("builtin");
  });

  it("uses conservative unknown capabilities for unmet requirements", () => {
    const requirements = { vision: true, tools: false, reasoning: false };
    expect(meetsRequirements(UNKNOWN_MODEL, requirements)).toBe(false);
    expect(meetsRequirements(capabilitiesFor("gpt-4o"), requirements)).toBe(true);
  });
});
