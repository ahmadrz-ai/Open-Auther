/**
 * Provider catalogue.
 *
 * Two different notions are deliberately kept apart:
 *
 *   providerId   — which service this is (openai, openrouter, gemini, …).
 *                  Drives grouping in the UI and the preset endpoint.
 *   providerType — which wire protocol to speak (`gemini`, `openai_custom`,
 *                  `codex_oauth`). Several providers share one protocol.
 *
 * Collapsing the two is what previously let a ChatGPT OAuth credential be
 * treated as a Google API key.
 */

import { ANTIGRAVITY_DEFAULT_MODELS } from "./antigravity.js";
import { ProviderRegistry, type ProviderPlugin } from "./provider-registry.js";
import { WEB_COOKIE_BY_ID } from "./webcookie.js";
import type { ProviderType } from "../pool/types.js";

export type AuthKind = "api_key" | "oauth" | "custom";

export interface ProviderDef {
  id: string;
  label: string;
  blurb: string;
  /** Wire protocol used to talk to it. */
  providerType: ProviderType;
  /** Preset endpoint. `custom` is the only one the user supplies. */
  baseUrl: string;
  /** Which onboarding methods this provider offers. */
  auth: AuthKind[];
  /** Accepts several keys at once, rotated like any other credential. */
  multiKey: boolean;
  /** Shown as placeholder so a wrong key is obvious before it is submitted. */
  keyHint: string;
  /** Where to get a key. */
  keyUrl: string | null;
  /** Probe model when the pool has nothing else suitable. */
  probeModel: string | null;
  /** True when `GET {baseUrl}/models` is expected to work. */
  listsModels: boolean;
  /**
   * Models offered as soon as this provider has a credential, before anything
   * has been discovered from its endpoint. Without these a freshly connected
   * provider appears in the chat picker with nothing selectable.
   */
  defaultModels: string[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    blurb:
      "Any endpoint that speaks the OpenAI Chat Completions API — Groq, Together, " +
      "DeepSeek, Ollama, LM Studio, your own proxy.",
    providerType: "openai_custom",
    baseUrl: "",
    auth: ["custom"],
    multiKey: false,
    keyHint: "Optional for local endpoints",
    keyUrl: null,
    probeModel: null,
    listsModels: true,
    // Whatever the endpoint declares; nothing can be assumed up front.
    defaultModels: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb:
      "Google AI Studio keys on the free tier. Add several and ai-auther rotates " +
      "through them as each hits its quota.",
    providerType: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: ["api_key"],
    multiKey: true,
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    probeModel: "gemini-flash-lite-latest",
    listsModels: true,
    // Verified to actually generate on a free-tier key. The 2.5/2.0 names the
    // models endpoint still lists are retired for new keys or quota-locked.
    defaultModels: [
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb:
      "Two separate things: a platform API key (pay-per-token, needs credits), or " +
      "a ChatGPT account via OAuth (subscription-backed Codex). They are not " +
      "interchangeable.",
    providerType: "openai_custom",
    baseUrl: "https://api.openai.com/v1",
    auth: ["api_key", "oauth"],
    multiKey: true,
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    probeModel: "gpt-4o-mini",
    listsModels: true,
    defaultModels: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb:
      "One key for many models, including a set of free ones. Sign in with " +
      "OpenRouter to mint a key automatically, or paste keys you already have.",
    providerType: "openai_custom",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: ["api_key", "oauth"],
    multiKey: true,
    keyHint: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    probeModel: "openrouter/auto",
    listsModels: true,
    // A starting point only — "Fetch models" replaces this with the live list,
    // which on OpenRouter runs to several hundred entries.
    defaultModels: [
      "openrouter/auto",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
      "mistralai/mistral-small",
    ],
  },
];

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Antigravity: Google's AI IDE, via the Cloud Code backend. OAuth only, and
 * its model list is discovered per account after sign-in.
 */
export const ANTIGRAVITY_PROVIDER: ProviderDef = {
  id: "antigravity",
  label: "Antigravity (Google)",
  blurb:
    "Sign in with a Google account to use Antigravity's Cloud Code backend — " +
    "Gemini 3 plus Claude- and GPT-branded models on one connection.",
  providerType: "antigravity",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  auth: ["oauth"],
  multiKey: false,
  keyHint: "",
  keyUrl: null,
  probeModel: "gemini-2.5-flash",
  listsModels: false,
  defaultModels: ANTIGRAVITY_DEFAULT_MODELS,
};

/** The ChatGPT OAuth path is its own thing — no API key, no preset model list. */
export const CODEX_PROVIDER: ProviderDef = {
  id: "codex",
  label: "ChatGPT (Codex OAuth)",
  blurb:
    "Sign in with a ChatGPT account. Requires a paid plan — free accounts are " +
    "refused by the Codex backend for every model.",
  providerType: "codex_oauth",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  auth: ["oauth"],
  multiKey: false,
  keyHint: "",
  keyUrl: null,
  probeModel: "gpt-5-codex",
  listsModels: false,
  defaultModels: [
    // Hermes-aligned Codex routes. These are raw upstream model ids; the UI
    // may add display labels, but routing must forward the id unchanged.
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.6-mini",
    "gpt-5.6-sol",
    "gpt-5.6-sol-pro",
    "gpt-5.6-terra-pro",
    "gpt-5.6-luna-pro",
    // Existing Codex-compatible routes retained for backward compatibility.
    "gpt-5-codex",
    "gpt-5",
    "gpt-5-mini",
    "codex-mini-latest",
  ],
};

export function providerDef(id: string): ProviderDef | null {
  if (id === "codex") return CODEX_PROVIDER;
  if (id === "antigravity") return ANTIGRAVITY_PROVIDER;

  // Web-session providers live in their own catalogue but still need a label
  // and model list here, or reports show a raw id like "kimi-web".
  const web = WEB_COOKIE_BY_ID.get(id);
  if (web) {
    return {
      id: web.id,
      label: web.label,
      blurb: web.blurb,
      providerType: "web_cookie",
      baseUrl: web.website,
      auth: ["custom"],
      multiKey: false,
      keyHint: web.placeholder,
      keyUrl: web.website,
      probeModel: web.defaultModels[0] ?? null,
      listsModels: false,
      defaultModels: web.defaultModels,
    };
  }

  return BUILTIN_PROVIDER_REGISTRY.get(id)?.definition ?? null;
}

/** Everything the Add Provider page renders, in display order. */
export const ALL_PROVIDERS: ProviderDef[] = [
  ...PROVIDERS,
  ANTIGRAVITY_PROVIDER,
  CODEX_PROVIDER,
];

/** Built-in providers exposed through the same contract as external plugins. */
export const BUILTIN_PROVIDER_PLUGINS: ProviderPlugin[] = ALL_PROVIDERS.map((definition) => ({
  id: definition.id,
  definition,
}));

/** Shared registry used by applications that want built-ins plus extensions. */
export const BUILTIN_PROVIDER_REGISTRY = new ProviderRegistry(BUILTIN_PROVIDER_PLUGINS);

/** Provider definitions currently registered, including runtime plugins. */
export function providerDefs(): ProviderDef[] {
  return BUILTIN_PROVIDER_REGISTRY.list().map((plugin) => plugin.definition);
}

/**
 * Best-effort provider id for a credential stored before `provider_id` existed.
 * Used by the backfill migration and as a display fallback.
 */
export function inferProviderId(providerType: string, baseUrl: string | null): string {
  if (providerType === "codex_oauth") return "codex";
  if (providerType === "antigravity") return "antigravity";
  if (providerType === "gemini") return "gemini";
  const url = baseUrl ?? "";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  return "custom";
}
