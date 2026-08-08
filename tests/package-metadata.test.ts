import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI package metadata", () => {
  it("exposes both the canonical and compatibility gateway commands", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(packageJson.bin).toEqual({
      "open-auther": "dist/cli.js",
      openauther: "dist/cli.js",
    });
  });
});
