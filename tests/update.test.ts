import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions } from "../src/core/update.js";

describe("update checker", () => {
  it("compares stable semantic versions", () => {
    expect(compareVersions("1.0.4", "1.0.3")).toBe(1);
    expect(compareVersions("1.0.3", "1.0.3")).toBe(0);
    expect(compareVersions("1.0.2", "1.0.3")).toBe(-1);
  });

  it("reports a newer npm release", async () => {
    const result = await checkForUpdate({
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "1.0.4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      currentVersion: "1.0.3",
      now: () => 1_700_000_000_000,
    });

    expect(result.state).toBe("update_available");
    expect(result.currentVersion).toBe("1.0.3");
    expect(result.latestVersion).toBe("1.0.4");
    expect(result.message).toMatch(/new update available/i);
  });

  it("reports when the installed release is current", async () => {
    const result = await checkForUpdate({
      fetchImpl: async () => new Response(JSON.stringify({ version: "1.0.3" }), { status: 200 }),
      currentVersion: "1.0.3",
    });

    expect(result.state).toBe("up_to_date");
    expect(result.message).toMatch(/up to date/i);
  });

  it("returns a visible error state when npm cannot be reached", async () => {
    const result = await checkForUpdate({
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
      currentVersion: "1.0.3",
    });

    expect(result.state).toBe("error");
    expect(result.latestVersion).toBeNull();
    expect(result.message).toMatch(/could not check/i);
  });
});
