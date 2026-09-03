/**
 * Configuration loading.
 *
 * Precedence: environment variables > config.json > built-in defaults.
 * On first run we generate a gateway API key and persist it, so `ai-auther`
 * with no arguments produces a working, authenticated gateway.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { registerSecret, type LogLevel } from "./logging.js";
import { coerceCapabilities, type ModelCapabilities } from "./core/capabilities.js";

export type RotationStrategy = "fill_first" | "round_robin" | "least_used" | "random";

export interface GatewayKey {
  /** Human label used in logs. Never the key itself. */
  name: string;
  key: string;
}

/**
 * Caveman connects to any OpenAI-compatible endpoint to summarise oversized
 * prompts before they are forwarded. It is deliberately a *separate* endpoint
 * from the credential pool: compressing through the pool would spend the very
 * quota compression exists to conserve.
 */
export interface CavemanConfig {
  enabled: boolean;
  /** Base URL of an OpenAI-compatible API, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Leave prompts below this estimated token count untouched. */
  minTokens: number;
  /** Aim to reduce the compressible part to this fraction of its original size. */
  targetRatio: number;
  /** Never rewrite fenced code blocks. Strongly recommended for coding agents. */
  preserveCode: boolean;
  /** Always forward the most recent N messages verbatim. */
  keepRecentMessages: number;
  /** Instruction given to the summarising model. */
  instruction: string;
  /** Measure what output compression *would* have saved, without altering it. */
  measureOutput: boolean;
  requestTimeoutMs: number;
}

export const DEFAULT_CAVEMAN: CavemanConfig = {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "",
  minTokens: 2000,
  targetRatio: 0.5,
  preserveCode: true,
  keepRecentMessages: 4,
  instruction:
    "Compress the following conversation context. Keep every fact, name, number, " +
    "file path, identifier and decision. Drop pleasantries, repetition and filler. " +
    "Write dense prose, not bullet points. Do not answer anything, do not add " +
    "commentary, output only the compressed context. " +
    "Any [[CODE_n]] placeholder stands for a code block that has been removed: " +
    "reproduce every placeholder exactly as written, in its original position. " +
    "Never invent, renumber or omit one.",
  measureOutput: true,
  requestTimeoutMs: 60_000,
};

export interface Config {
  home: string;
  dbPath: string;
  configPath: string;

  host: string;
  port: number;

  gatewayKeys: GatewayKey[];

  rotation: RotationStrategy;
  /** Upper bound on credentials tried for one client request. */
  maxAttempts: number;
  /** Cooldown applied when upstream gives no `resets_at`, in seconds. */
  defaultCooldownSeconds: number;
  /** Refresh the access token this many seconds before it actually expires. */
  refreshSkewSeconds: number;
  /** Upstream request timeout in milliseconds. */
  requestTimeoutMs: number;

  upstreamBaseUrl: string;
  /** Codex endpoint for ChatGPT OAuth credentials. Separate on purpose. */
  codexBaseUrl: string;
  oauthIssuer: string;
  oauthClientId: string;

  /** Model ids advertised on /v1/models and accepted by /v1/chat/completions. */
  models: string[];
  defaultModel: string;

  logLevel: LogLevel;
  logPretty: boolean;
  /** Serve the web UI at / and /omni. */
  ui: boolean;
  /**
   * Hide models that look like a paid tier from /v1/models and routing.
   * Only OpenRouter marks this unambiguously (a `:free` suffix).
   */
  freeModelsOnly: boolean;

  caveman: CavemanConfig;

  /** Per-model capability overrides layered over the built-in table. */
  modelCapabilities: Record<string, Partial<ModelCapabilities>>;

  /**
   * How often to re-ask every provider what it serves, in hours. 0 disables
   * the sweep and leaves discovery manual.
   *
   * Provider catalogues change on their own schedule — models are retired,
   * renamed, and added to an account without notice — and nothing here used to
   * re-read them, so a connection kept routing whatever it discovered on the
   * day it was created.
   */
  modelSyncHours: number;
}

/** Fields the Settings page is allowed to change at runtime. */
export interface MutableSettings {
  rotation: RotationStrategy;
  maxAttempts: number;
  defaultCooldownSeconds: number;
  refreshSkewSeconds: number;
  requestTimeoutMs: number;
  host: string;
  port: number;
  logLevel: LogLevel;
  models: string[];
  defaultModel: string;
  freeModelsOnly: boolean;
  upstreamBaseUrl?: string;
  codexBaseUrl?: string;
}

/**
 * Public Codex CLI OAuth client id. Not a secret: it is shipped in the
 * official client and is meaningless without a user completing the flow.
 */
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  rotation: "fill_first" as RotationStrategy,
  maxAttempts: 4,
  defaultCooldownSeconds: 300,
  refreshSkewSeconds: 120,
  requestTimeoutMs: 600_000,
  /**
   * Where API-key credentials go (platform keys, custom OpenAI-compatible
   * providers). ChatGPT OAuth credentials do NOT use this — see
   * `codexBaseUrl`. The two were briefly merged into one setting, which sent
   * OAuth tokens to api.openai.com and produced billing errors that had
   * nothing to do with the real problem.
   */
  upstreamBaseUrl: "https://api.openai.com/v1",
  /** Subscription-backed endpoint, only ever used with ChatGPT OAuth tokens. */
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  oauthIssuer: "https://auth.openai.com",
  oauthClientId: DEFAULT_CLIENT_ID,
  /*
   * Verified against the live APIs on 2026-08-02, not guessed.
   *
   * Every name below returned a real completion during probing. Deliberately
   * absent:
   *   - gemini-2.5-flash / 2.5-pro / 2.5-flash-lite — listed by the models
   *     endpoint but answer 404 "no longer available to new users".
   *   - gemini-2.0-flash, gemini-pro-latest, gemini-3-pro-preview — 429 quota
   *     exhausted on the free tier, so advertising them only produces errors.
   *   - gpt-4o / o1 / o3-mini / GPT-5.6-* — these are OpenAI *platform* models.
   *     They need an api.openai.com key with credits, not a ChatGPT OAuth
   *     credential, and the Codex backend rejects all of them on a free plan.
   *     Add them back once a funded platform key or a paid ChatGPT plan is in
   *     the pool.
   */
  models: [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
  ],
  defaultModel: "gemini-flash-lite-latest",
  logLevel: "info" as LogLevel,
  ui: true,
  freeModelsOnly: true,
  /*
   * Six hours. Provider catalogues move on the order of days, so this is
   * comfortably ahead of them while costing one cheap request per connection
   * per sweep. The static model lists above are only ever the bootstrap for a
   * connection that has not synced yet.
   */
  modelSyncHours: 6,
};

export function defaultHome(): string {
  return process.env.AI_AUTHER_HOME
    ? resolve(process.env.AI_AUTHER_HOME)
    : join(homedir(), ".ai-auther");
}

/** Create the data directory with owner-only permissions where the OS supports it. */
function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    // Windows ignores POSIX modes; ACLs are the user profile's default there.
  }
}

export function generateGatewayKey(): string {
  return `aia-${randomBytes(24).toString("base64url")}`;
}

interface FileConfig extends Partial<Omit<Config, "home" | "dbPath" | "configPath">> {}

function readFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    throw new Error(
      `Config file at ${path} is not valid JSON. Fix or delete it. (${(err as Error).message})`,
    );
  }
}

function writeFileConfig(path: string, cfg: FileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* see ensureHome */
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

const VALID_ROTATIONS: RotationStrategy[] = ["fill_first", "round_robin", "least_used", "random"];

export function loadConfig(): Config {
  const home = defaultHome();
  ensureHome(home);

  const configPath = process.env.AI_AUTHER_CONFIG
    ? resolve(process.env.AI_AUTHER_CONFIG)
    : join(home, "config.json");
  const file = readFileConfig(configPath);

  // Gateway keys: env wins, then file, then generate-and-persist on first run.
  let gatewayKeys: GatewayKey[] = [];
  if (process.env.AI_AUTHER_API_KEY) {
    gatewayKeys = [{ name: "env", key: process.env.AI_AUTHER_API_KEY }];
  } else if (file.gatewayKeys?.length) {
    gatewayKeys = file.gatewayKeys;
  } else {
    gatewayKeys = [{ name: "default", key: generateGatewayKey() }];
    writeFileConfig(configPath, { ...file, gatewayKeys });
  }

  const rotationRaw = (process.env.AI_AUTHER_ROTATION ?? file.rotation ?? DEFAULTS.rotation) as RotationStrategy;
  if (!VALID_ROTATIONS.includes(rotationRaw)) {
    throw new Error(
      `Unknown rotation strategy "${rotationRaw}". Valid: ${VALID_ROTATIONS.join(", ")}`,
    );
  }

  const cfg: Config = {
    home,
    configPath,
    dbPath: process.env.AI_AUTHER_DB ? resolve(process.env.AI_AUTHER_DB) : join(home, "ai-auther.db"),

    host: process.env.AI_AUTHER_HOST ?? file.host ?? DEFAULTS.host,
    port: envInt("AI_AUTHER_PORT", file.port ?? DEFAULTS.port),

    gatewayKeys,

    rotation: rotationRaw,
    maxAttempts: envInt("AI_AUTHER_MAX_ATTEMPTS", file.maxAttempts ?? DEFAULTS.maxAttempts),
    defaultCooldownSeconds: envInt(
      "AI_AUTHER_DEFAULT_COOLDOWN",
      file.defaultCooldownSeconds ?? DEFAULTS.defaultCooldownSeconds,
    ),
    refreshSkewSeconds: envInt(
      "AI_AUTHER_REFRESH_SKEW",
      file.refreshSkewSeconds ?? DEFAULTS.refreshSkewSeconds,
    ),
    requestTimeoutMs: envInt(
      "AI_AUTHER_TIMEOUT_MS",
      file.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    ),

    upstreamBaseUrl: process.env.AI_AUTHER_UPSTREAM ?? file.upstreamBaseUrl ?? DEFAULTS.upstreamBaseUrl,
    codexBaseUrl:
      process.env.AI_AUTHER_CODEX_UPSTREAM ?? file.codexBaseUrl ?? DEFAULTS.codexBaseUrl,
    oauthIssuer: process.env.AI_AUTHER_ISSUER ?? file.oauthIssuer ?? DEFAULTS.oauthIssuer,
    oauthClientId: process.env.AI_AUTHER_CLIENT_ID ?? file.oauthClientId ?? DEFAULTS.oauthClientId,

    models: file.models?.length ? file.models : DEFAULTS.models,
    defaultModel: file.defaultModel ?? DEFAULTS.defaultModel,

    logLevel: (process.env.AI_AUTHER_LOG_LEVEL ?? file.logLevel ?? DEFAULTS.logLevel) as LogLevel,
    logPretty: envBool("AI_AUTHER_LOG_PRETTY", file.logPretty ?? process.stdout.isTTY === true),
    ui: envBool("AI_AUTHER_UI", file.ui ?? DEFAULTS.ui),
    freeModelsOnly: envBool("AI_AUTHER_FREE_ONLY", file.freeModelsOnly ?? DEFAULTS.freeModelsOnly),

    caveman: { ...DEFAULT_CAVEMAN, ...(file.caveman ?? {}) },
    modelCapabilities: file.modelCapabilities ?? {},
    modelSyncHours: envInt(
      "AI_AUTHER_MODEL_SYNC_HOURS",
      file.modelSyncHours ?? DEFAULTS.modelSyncHours,
    ),
  };

  if (cfg.maxAttempts < 1) throw new Error("maxAttempts must be at least 1");
  if (cfg.modelSyncHours < 0) throw new Error("modelSyncHours must be 0 or more");

  // Register every gateway key so it can never appear in a log line.
  for (const k of cfg.gatewayKeys) registerSecret(k.key);
  registerSecret(cfg.caveman.apiKey);

  return cfg;
}

// ---------------------------------------------------------------- mutation

/**
 * Persist a partial config change and apply it to the in-memory config.
 *
 * Only the file is rewritten; env-var overrides still win on the next start,
 * which is intentional — an env var is a deliberate override and the UI should
 * not silently defeat it.
 */
export function persistConfig(cfg: Config, patch: FileConfig): void {
  const file = readFileConfig(cfg.configPath);
  writeFileConfig(cfg.configPath, { ...file, ...patch });
  Object.assign(cfg, patch);
}

export function updateSettings(cfg: Config, patch: Partial<MutableSettings>): void {
  const clean: Partial<MutableSettings> = {};

  if (patch.rotation !== undefined) {
    if (!VALID_ROTATIONS.includes(patch.rotation)) {
      throw new Error(`Unknown rotation strategy "${patch.rotation}".`);
    }
    clean.rotation = patch.rotation;
  }
  if (patch.maxAttempts !== undefined) {
    if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1) {
      throw new Error("maxAttempts must be an integer of at least 1.");
    }
    clean.maxAttempts = patch.maxAttempts;
  }
  if (patch.defaultCooldownSeconds !== undefined) {
    if (!Number.isInteger(patch.defaultCooldownSeconds) || patch.defaultCooldownSeconds < 0) {
      throw new Error("defaultCooldownSeconds must be a non-negative integer.");
    }
    clean.defaultCooldownSeconds = patch.defaultCooldownSeconds;
  }
  if (patch.refreshSkewSeconds !== undefined) {
    if (!Number.isInteger(patch.refreshSkewSeconds) || patch.refreshSkewSeconds < 0) {
      throw new Error("refreshSkewSeconds must be a non-negative integer.");
    }
    clean.refreshSkewSeconds = patch.refreshSkewSeconds;
  }
  if (patch.requestTimeoutMs !== undefined) {
    if (!Number.isInteger(patch.requestTimeoutMs) || patch.requestTimeoutMs < 1000) {
      throw new Error("requestTimeoutMs must be at least 1000.");
    }
    clean.requestTimeoutMs = patch.requestTimeoutMs;
  }
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
      throw new Error("port must be between 1 and 65535.");
    }
    clean.port = patch.port;
  }
  if (patch.host !== undefined) clean.host = String(patch.host);
  if (patch.logLevel !== undefined) clean.logLevel = patch.logLevel;
  if (patch.models !== undefined) {
    const models = patch.models.map((m) => String(m).trim()).filter(Boolean);
    if (models.length === 0) throw new Error("At least one model must be configured.");
    clean.models = models;
  }
  if (patch.defaultModel !== undefined) clean.defaultModel = String(patch.defaultModel);
  if (patch.freeModelsOnly !== undefined) clean.freeModelsOnly = Boolean(patch.freeModelsOnly);
  if (patch.upstreamBaseUrl !== undefined) {
    const url = String(patch.upstreamBaseUrl).trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("upstreamBaseUrl must be a valid http or https URL.");
    }
    clean.upstreamBaseUrl = url;
  }

  persistConfig(cfg, clean);
}

export function updateCaveman(cfg: Config, patch: Partial<CavemanConfig>): void {
  const next: CavemanConfig = { ...cfg.caveman, ...patch };

  if (next.enabled) {
    if (!next.baseUrl) throw new Error("A base URL is required to enable Caveman.");
    if (!next.model) throw new Error("A model is required to enable Caveman.");
    try {
      new URL(next.baseUrl);
    } catch {
      throw new Error(`"${next.baseUrl}" is not a valid URL.`);
    }
  }
  if (next.targetRatio <= 0 || next.targetRatio >= 1) {
    throw new Error("targetRatio must be between 0 and 1, exclusive.");
  }
  if (next.minTokens < 0) throw new Error("minTokens cannot be negative.");
  if (next.keepRecentMessages < 0) throw new Error("keepRecentMessages cannot be negative.");

  registerSecret(next.apiKey);
  persistConfig(cfg, { caveman: next });
}

/**
 * Store capability overrides for one model. Passing an empty object clears the
 * override and falls back to the built-in table.
 */
export function updateModelCapabilities(cfg: Config, model: string, raw: unknown): void {
  const name = String(model).trim();
  if (!name) throw new Error("A model name is required.");

  const clean = coerceCapabilities(raw);
  const next = { ...cfg.modelCapabilities };
  if (Object.keys(clean).length === 0) delete next[name];
  else next[name] = clean;

  persistConfig(cfg, { modelCapabilities: next });
}

export function addGatewayKey(cfg: Config, name: string): GatewayKey {
  const label = name.trim() || `key-${cfg.gatewayKeys.length + 1}`;
  if (cfg.gatewayKeys.some((k) => k.name === label)) {
    throw new Error(`A key named "${label}" already exists.`);
  }
  const key: GatewayKey = { name: label, key: generateGatewayKey() };
  registerSecret(key.key);
  persistConfig(cfg, { gatewayKeys: [...cfg.gatewayKeys, key] });
  return key;
}

export function removeGatewayKey(cfg: Config, name: string): boolean {
  const remaining = cfg.gatewayKeys.filter((k) => k.name !== name);
  if (remaining.length === cfg.gatewayKeys.length) return false;
  if (remaining.length === 0) {
    throw new Error("Refusing to remove the last gateway key — you would lock yourself out.");
  }
  persistConfig(cfg, { gatewayKeys: remaining });
  return true;
}
