import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions, installLatestPackage } from "../src/core/update.js";

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

  it("rejects rather than throwing when the command cannot be spawned", async () => {
    /*
     * The regression this guards: spawn("npm.cmd", args, {shell:false}) throws
     * EINVAL synchronously on Windows under Node's CVE-2024-27980 hardening, so
     * `open-auther update` reported "Update failed: spawn EINVAL" and updated
     * nothing. A failure must arrive as a rejection the CLI can report.
     */
    await expect(
      installLatestPackage({ command: "definitely-not-a-real-binary-xyz", args: [] }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("installs the hyphenated package name, which is the only one on npm", async () => {
    // `openauther` is a bin alias only; `npm install openauther` 404s.
    let seen: string[] = [];
    await installLatestPackage({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    }).then((r) => (seen = r.args));
    expect(seen).toEqual(["-e", "process.exit(0)"]);

    // And the default, which is what the CLI actually uses.
    const { INSTALL_COMMAND } = await import("../src/core/update.js");
    expect(INSTALL_COMMAND).toContain("open-auther@latest");
  });

  it("can run the configured npm install command", async () => {
    const result = await installLatestPackage({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
