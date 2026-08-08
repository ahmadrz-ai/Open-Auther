import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/api/admin.js";

describe("runtime version identity", () => {
  it("keeps the dashboard API version aligned with package metadata", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
