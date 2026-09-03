/**
 * Which Antigravity client version to present.
 *
 * The Cloud Code backend refuses builds it considers stale, and it does so in
 * the worst possible way: HTTP 200, with "This version of Antigravity is no
 * longer supported" as the model's reply. So a hard-coded version number does
 * not fail when it goes stale — it starts answering every prompt with an
 * upgrade notice, and the connection looks perfectly healthy while it happens.
 *
 * A constant in this repository is therefore guaranteed to break every user
 * the next time Google ships the IDE, and to break them silently. The version
 * is now resolved at runtime instead, most trustworthy source first:
 *
 *   1. AI_AUTHER_ANTIGRAVITY_VERSION — you said so, so it wins.
 *   2. The Antigravity IDE installed on this machine, read from its own
 *      product.json. If you have the IDE, its version is by definition the one
 *      the backend currently accepts.
 *   3. A version this process previously learned and is not known to be stale.
 *   4. FALLBACK_VERSION, the last version known to work when this was written.
 *
 * Only (1) and (2) are real information. (4) is a guess with a shelf life, and
 * it is treated as one: when the backend rejects a version, `markRejected`
 * records that and the next resolution will not offer it again, so a stale
 * fallback degrades into a clear error rather than an infinite loop of
 * upgrade notices.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logging.js";

const log = createLogger({ mod: "antigravity-version" });

/**
 * Last version confirmed working against the live backend.
 *
 * Update this when it goes stale, but do not rely on it: the resolution chain
 * above exists precisely because this line cannot stay correct on its own.
 */
export const FALLBACK_VERSION = "2.0.1";

/** A plausible IDE version. Guards against a product.json with a junk field. */
const VERSION_SHAPE = /^\d+\.\d+(\.\d+)*$/;

export function isVersionShape(value: unknown): value is string {
  return typeof value === "string" && VERSION_SHAPE.test(value.trim());
}

/**
 * Where the Antigravity IDE keeps its manifest, per platform.
 *
 * Antigravity is a VS Code derivative, so it carries the same
 * `resources/app/product.json` an Electron-packaged VS Code build does. The
 * paths below are the standard install locations for each platform's
 * installer, plus the per-user variants people actually end up with.
 */
function manifestCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];

  // An explicit pointer wins over guessing, for unusual installs.
  const explicit = process.env.AI_AUTHER_ANTIGRAVITY_APP;
  if (explicit) {
    out.push(join(explicit, "resources", "app", "product.json"));
    out.push(join(explicit, "product.json"));
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    for (const base of [
      join(localAppData, "Programs", "Antigravity"),
      join(programFiles, "Antigravity"),
    ]) {
      out.push(join(base, "resources", "app", "product.json"));
    }
  } else if (process.platform === "darwin") {
    for (const base of [
      "/Applications/Antigravity.app",
      join(home, "Applications", "Antigravity.app"),
    ]) {
      out.push(join(base, "Contents", "Resources", "app", "product.json"));
    }
  } else {
    for (const base of [
      "/usr/share/antigravity",
      "/opt/Antigravity",
      "/opt/antigravity",
      join(home, ".local", "share", "antigravity"),
    ]) {
      out.push(join(base, "resources", "app", "product.json"));
    }
  }

  return out;
}

/** Pull a usable version string out of a product.json / package.json body. */
function versionFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // `version` is what VS Code's product.json carries. The others are
    // defensive: a fork may rename it, and a wrong guess here is harmless
    // because the shape check rejects anything that is not a version.
    for (const key of ["version", "antigravityVersion", "ideVersion"]) {
      const value = parsed[key];
      if (isVersionShape(value)) return value.trim();
    }
  } catch {
    // A manifest we cannot parse is a manifest we do not have.
  }
  return null;
}

/**
 * Read the version from an Antigravity installed on this machine.
 *
 * Returns null when the IDE is not installed, which is the normal case for
 * someone using this gateway instead of the IDE.
 */
export function detectInstalledVersion(): string | null {
  for (const path of manifestCandidates()) {
    try {
      if (!existsSync(path)) continue;
      const version = versionFrom(readFileSync(path, "utf8"));
      if (version) {
        log.debug("antigravity_version_detected", { path, version });
        return version;
      }
    } catch {
      // Unreadable path — try the next candidate.
    }
  }
  return null;
}

interface VersionCache {
  version: string;
  /** Epoch ms this was resolved. */
  at: number;
  source: VersionSource;
}

export type VersionSource = "env" | "installed" | "cached" | "fallback";

/**
 * How long a detected version is trusted before the disk is re-read.
 *
 * Short enough that updating the IDE while the gateway runs is picked up
 * without a restart, long enough that this is not a filesystem probe on every
 * request.
 */
const CACHE_TTL_MS = 15 * 60_000;

let cache: VersionCache | null = null;
const rejected = new Set<string>();

export interface ResolvedVersion {
  version: string;
  source: VersionSource;
  /** True when nothing on this machine could confirm the version. */
  guessed: boolean;
}

/** Resolve the client version to present, with its provenance. */
export function resolveAntigravityVersion(at: number = Date.now()): ResolvedVersion {
  const env = process.env.AI_AUTHER_ANTIGRAVITY_VERSION?.trim();
  if (env) {
    // Deliberately not shape-checked and never rejected: an explicit setting is
    // the escape hatch for when everything else here is wrong, including the
    // assumption that a version looks like x.y.z.
    return { version: env, source: "env", guessed: false };
  }

  if (cache && at - cache.at < CACHE_TTL_MS && !rejected.has(cache.version)) {
    return { version: cache.version, source: "cached", guessed: cache.source === "fallback" };
  }

  const installed = detectInstalledVersion();
  if (installed && !rejected.has(installed)) {
    cache = { version: installed, at, source: "installed" };
    return { version: installed, source: "installed", guessed: false };
  }

  cache = { version: FALLBACK_VERSION, at, source: "fallback" };
  return { version: FALLBACK_VERSION, source: "fallback", guessed: true };
}

/** The version string alone, for building a user agent. */
export function antigravityVersion(): string {
  return resolveAntigravityVersion().version;
}

/**
 * Record that the backend refused a version.
 *
 * Called when the "no longer supported" notice comes back, so the next
 * resolution re-reads the disk rather than presenting the same rejected
 * version forever. If the IDE has since been updated this recovers on its own;
 * if there is no IDE to read, the caller gets an error that says so instead of
 * an upgrade notice dressed up as an answer.
 */
export function markRejected(version: string): void {
  if (!version) return;
  rejected.add(version);
  if (cache?.version === version) cache = null;
  log.warn("antigravity_version_rejected", { version });
}

/** True when every version this machine can offer has already been refused. */
export function isExhausted(): boolean {
  const resolved = resolveAntigravityVersion();
  return rejected.has(resolved.version);
}

/** Drop cached state. Used by tests and by an explicit re-detect. */
export function resetVersionCache(): void {
  cache = null;
  rejected.clear();
}

/** Human-readable explanation for diagnostics and error messages. */
export function describeVersionSource(resolved: ResolvedVersion): string {
  switch (resolved.source) {
    case "env":
      return "set by AI_AUTHER_ANTIGRAVITY_VERSION";
    case "installed":
      return "read from the Antigravity IDE installed on this machine";
    case "cached":
      return "previously resolved on this machine";
    case "fallback":
      return "a built-in fallback — no Antigravity install was found to confirm it";
  }
}
