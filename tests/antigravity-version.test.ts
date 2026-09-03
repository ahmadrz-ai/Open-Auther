/**
 * The client version used to be a constant, which meant it was guaranteed to
 * break every user the next time the IDE shipped — and to break them silently,
 * because the backend refuses a stale build with HTTP 200 and an upgrade notice
 * where the model's reply should be.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FALLBACK_VERSION,
  describeVersionSource,
  detectInstalledVersion,
  isExhausted,
  isVersionShape,
  markRejected,
  resetVersionCache,
  resolveAntigravityVersion,
} from "../src/core/antigravity-version.js";
import { ideNodeUserAgent, ideUserAgent } from "../src/core/antigravity.js";
import { mapAntigravityEvent } from "../src/upstream/antigravity.js";

const ENV_KEYS = ["AI_AUTHER_ANTIGRAVITY_VERSION", "AI_AUTHER_ANTIGRAVITY_APP"] as const;
const saved: Record<string, string | undefined> = {};

/** Write a product.json the way an Electron-packaged VS Code fork ships one. */
function fakeInstall(version: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "antigravity-app-"));
  const appDir = join(dir, "resources", "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "product.json"), JSON.stringify({ nameShort: "Antigravity", version }));
  return dir;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetVersionCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetVersionCache();
});

describe("resolving the client version", () => {
  it("prefers an explicit setting over everything else", () => {
    const dir = fakeInstall("9.9.9");
    try {
      process.env.AI_AUTHER_ANTIGRAVITY_APP = dir;
      process.env.AI_AUTHER_ANTIGRAVITY_VERSION = "3.2.1";

      const resolved = resolveAntigravityVersion();
      expect(resolved).toMatchObject({ version: "3.2.1", source: "env", guessed: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the version from an Antigravity installed on this machine", () => {
    const dir = fakeInstall("2.7.4");
    try {
      process.env.AI_AUTHER_ANTIGRAVITY_APP = dir;

      expect(detectInstalledVersion()).toBe("2.7.4");
      const resolved = resolveAntigravityVersion();
      expect(resolved).toMatchObject({ version: "2.7.4", source: "installed", guessed: false });
      // A version read off the machine is fact, so nothing warns about it.
      expect(describeVersionSource(resolved)).toContain("installed on this machine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a manifest whose version field is junk", () => {
    const dir = fakeInstall({ not: "a version" });
    try {
      process.env.AI_AUTHER_ANTIGRAVITY_APP = dir;
      expect(detectInstalledVersion()).toBeNull();
      expect(resolveAntigravityVersion().source).toBe("fallback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back when no IDE is installed, and says the value is a guess", () => {
    process.env.AI_AUTHER_ANTIGRAVITY_APP = join(tmpdir(), "definitely-not-installed");

    const resolved = resolveAntigravityVersion();
    expect(resolved.version).toBe(FALLBACK_VERSION);
    expect(resolved.guessed).toBe(true);
  });

  it("validates version shape without being strict about depth", () => {
    expect(isVersionShape("2.0.1")).toBe(true);
    expect(isVersionShape("1.105")).toBe(true);
    expect(isVersionShape("2.0.1.4321")).toBe(true);
    expect(isVersionShape("nightly")).toBe(false);
    expect(isVersionShape(undefined)).toBe(false);
  });
});

describe("reacting to a refusal", () => {
  it("stops offering a version the backend has rejected", () => {
    process.env.AI_AUTHER_ANTIGRAVITY_APP = join(tmpdir(), "definitely-not-installed");

    expect(resolveAntigravityVersion().version).toBe(FALLBACK_VERSION);
    markRejected(FALLBACK_VERSION);

    // Nothing better is available here, so this is now a known dead end — which
    // is what turns the silent upgrade-notice loop into a reportable error.
    expect(isExhausted()).toBe(true);
  });

  it("picks up a newly installed IDE after the old version was refused", () => {
    const dir = fakeInstall("2.0.1");
    try {
      process.env.AI_AUTHER_ANTIGRAVITY_APP = dir;
      expect(resolveAntigravityVersion().version).toBe("2.0.1");

      markRejected("2.0.1");
      // The user updates the IDE; no restart involved.
      const updated = fakeInstall("2.9.0");
      try {
        process.env.AI_AUTHER_ANTIGRAVITY_APP = updated;
        expect(resolveAntigravityVersion()).toMatchObject({
          version: "2.9.0",
          source: "installed",
        });
      } finally {
        rmSync(updated, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns the backend's upgrade notice into an error naming the version", () => {
    process.env.AI_AUTHER_ANTIGRAVITY_VERSION = "1.0.0";

    const events = mapAntigravityEvent({
      candidates: [
        {
          content: {
            parts: [{ text: "This version of Antigravity is no longer supported." }],
          },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", status: 426 });
    const body = (events[0] as { body: { code: string; message: string } }).body;
    expect(body.code).toBe("antigravity_client_outdated");
    expect(body.message).toContain("1.0.0");
  });
});

describe("user agents", () => {
  it("carry the resolved version rather than a compiled-in constant", () => {
    process.env.AI_AUTHER_ANTIGRAVITY_VERSION = "4.5.6";

    expect(ideUserAgent()).toBe("antigravity/ide/4.5.6 darwin/arm64");
    expect(ideNodeUserAgent()).toContain("antigravity/4.5.6 darwin/arm64");
  });

  it("follow a version change without a restart", () => {
    process.env.AI_AUTHER_ANTIGRAVITY_VERSION = "1.1.1";
    expect(ideUserAgent()).toContain("1.1.1");

    process.env.AI_AUTHER_ANTIGRAVITY_VERSION = "2.2.2";
    expect(ideUserAgent()).toContain("2.2.2");
  });
});
