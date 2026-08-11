import { spawn } from "node:child_process";
import packageJson from "../../package.json";

export const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/open-auther/latest";
export const PACKAGE_URL = "https://www.npmjs.com/package/open-auther";
export const INSTALL_COMMAND = "npm install -g open-auther@latest";

export type UpdateState = "up_to_date" | "update_available" | "error";

export interface UpdateInfo {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  state: UpdateState;
  message: string;
  checkedAt: number;
  registryUrl: string;
  packageUrl: string;
  installCommand: string;
}

export interface UpdateCheckOptions {
  fetchImpl?: typeof fetch;
  currentVersion?: string;
  now?: () => number;
  timeoutMs?: number;
}

export interface InstallLatestOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallLatestResult {
  ok: boolean;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

/** Compare two valid semantic versions: -1, 0, or 1. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function baseResult(currentVersion: string, checkedAt: number): Omit<UpdateInfo, "latestVersion" | "state" | "message"> {
  return {
    packageName: packageJson.name,
    currentVersion,
    checkedAt,
    registryUrl: UPDATE_REGISTRY_URL,
    packageUrl: PACKAGE_URL,
    installCommand: INSTALL_COMMAND,
  };
}

/** Check the public npm registry without ever sending local credentials. */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateInfo> {
  const currentVersion = options.currentVersion ?? packageJson.version;
  const checkedAt = options.now?.() ?? Date.now();
  const base = baseResult(currentVersion, checkedAt);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(UPDATE_REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);

    const payload = (await response.json()) as { version?: unknown };
    const latestVersion = typeof payload.version === "string" ? payload.version.trim() : "";
    if (!latestVersion) throw new Error("Registry response did not contain a version");

    const newer = compareVersions(latestVersion, currentVersion) > 0;
    return {
      ...base,
      latestVersion,
      state: newer ? "update_available" : "up_to_date",
      message: newer
        ? `New update available: v${latestVersion} (installed: v${currentVersion}).`
        : `You are up to date on v${currentVersion}.`,
    };
  } catch {
    return {
      ...base,
      latestVersion: null,
      state: "error",
      message: "Could not check for updates. Check your network connection and try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Install the latest public npm release into the global npm prefix. */
export function installLatestPackage(options: InstallLatestOptions = {}): Promise<InstallLatestResult> {
  const command = options.command ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = options.args ?? ["install", "-g", "open-auther@latest"];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ ok: exitCode === 0, command, args, exitCode, signal });
    });
  });
}
