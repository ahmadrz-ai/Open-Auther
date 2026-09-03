/**
 * What each model can do.
 *
 * The Codex backend publishes no capability manifest, so this began as a
 * curated table of the ids the gateway shipped with, editable in Settings
 * precisely because a curated table goes stale. Two rules kept it honest:
 *
 *  - Anything not actually verified through this gateway defaults to `false`.
 *    A greyed-out icon that turns out to work is a much smaller problem than a
 *    lit icon that does not.
 *  - `streaming` and `reasoning` are the only things marked true by default,
 *    because the gateway exercises both on every request.
 *
 * That table is now the third source consulted, not the first. Providers that
 * do publish a manifest — Antigravity names `supportsImages` per model, and
 * OpenRouter lists input modalities — are believed over it, and an id from
 * neither is guessed at by family. See `resolveOrder` below for the precedence
 * and, more importantly, for which sources are allowed to refuse a request.
 */

import { inferCapabilities, type DiscoveredModel } from "./model-metadata.js";

export interface ModelCapabilities {
  /** Accepts a reasoning/thinking effort level. */
  reasoning: boolean;
  /** Accepts image input. */
  vision: boolean;
  /** Accepts tool/function definitions. */
  tools: boolean;
  /** Server-sent streaming. */
  streaming: boolean;
  /** Can reach the internet during generation. */
  webSearch: boolean;
  /** Advertised context window in tokens, or null when unknown. */
  contextWindow: number | null;
}

export const UNKNOWN_MODEL: ModelCapabilities = {
  reasoning: false,
  vision: false,
  tools: true,
  streaming: true,
  webSearch: false,
  contextWindow: null,
};

/**
 * Defaults for the models this gateway ships with.
 *
 * `webSearch` is false across the board: web access is a ChatGPT product
 * feature, and nothing confirms the Codex backend exposes it through this
 * endpoint. Flip it in Settings if you find otherwise.
 */
export const BUILTIN_CAPABILITIES: Record<string, ModelCapabilities> = {
  "GPT-5.6-terra": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.6-luna": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.5": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.4-mini": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 200_000,
  },
  "GPT-5.6-sol": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.6-sol-pro": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.6-terra-pro": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "GPT-5.6-luna-pro": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "gpt-4o": {
    reasoning: false,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 128_000,
  },
  "gpt-4o-mini": {
    reasoning: false,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 128_000,
  },
  "o1": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 200_000,
  },
  "o3-mini": {
    reasoning: true,
    vision: false,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 200_000,
  },
  "gpt-4.5-preview": {
    reasoning: false,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 128_000,
  },
  "auto": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 128_000,
  },
  "gpt-5-codex": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "gpt-5": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "gpt-5-mini": {
    reasoning: true,
    vision: true,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 272_000,
  },
  "codex-mini-latest": {
    reasoning: true,
    vision: false,
    tools: true,
    streaming: true,
    webSearch: false,
    contextWindow: 200_000,
  },
};

/** Reasoning levels the Responses-shaped backend accepts. */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DEFAULT_REASONING: ReasoningLevel = "medium";

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Where a resolved capability set came from, in precedence order.
 *
 * The distinction that matters is not the ranking but which of these count as
 * evidence. `override`, `discovered` and `builtin` are statements of fact —
 * the user said so, the provider said so, or the id is one this gateway
 * verified — so they may refuse a request. `inferred` and `unknown` are
 * guesses, and a guess must never refuse: see `meetsRequirements`.
 */
export type CapabilitySource = "override" | "discovered" | "builtin" | "inferred" | "unknown";

/** Sources whose `false` is a fact rather than an absence of information. */
const AUTHORITATIVE: ReadonlySet<CapabilitySource> = new Set<CapabilitySource>([
  "override",
  "discovered",
  "builtin",
]);

export type ResolvedCapabilities = ModelCapabilities & { source: CapabilitySource };

/** Drop the `null`s a provider record uses for "did not say". */
function fromDiscovered(model: DiscoveredModel): Partial<ModelCapabilities> {
  const out: Partial<ModelCapabilities> = {};
  if (typeof model.vision === "boolean") out.vision = model.vision;
  if (typeof model.reasoning === "boolean") out.reasoning = model.reasoning;
  if (typeof model.tools === "boolean") out.tools = model.tools;
  if (typeof model.contextWindow === "number") out.contextWindow = model.contextWindow;
  return out;
}

/**
 * Resolve capabilities for a model.
 *
 * Precedence, highest first: a user override, then whatever the provider
 * published for this model, then the built-in table, then a guess from the
 * model family, then the conservative unknown default.
 *
 * The layers merge rather than replace, so a provider that publishes only
 * `supportsImages` still picks up a context window from the built-in table,
 * and an override naming one flag does not blank the rest.
 */
export function capabilitiesFor(
  model: string,
  overrides: Record<string, Partial<ModelCapabilities>> = {},
  discovered: DiscoveredModel | null = null,
): ResolvedCapabilities {
  const builtin = Object.entries(BUILTIN_CAPABILITIES).find(
    ([id]) => id.toLowerCase() === model.toLowerCase(),
  )?.[1];
  const override =
    overrides[model] ??
    Object.entries(overrides).find(([id]) => id.toLowerCase() === model.toLowerCase())?.[1];

  const live = discovered ? fromDiscovered(discovered) : {};
  const inferred = builtin ? null : inferCapabilities(model);

  // Highest-precedence source that actually said anything names the result.
  const source: CapabilitySource = override
    ? "override"
    : Object.keys(live).length
      ? "discovered"
      : builtin
        ? "builtin"
        : inferred
          ? "inferred"
          : "unknown";

  return {
    ...UNKNOWN_MODEL,
    ...(inferred ?? {}),
    ...(builtin ?? {}),
    ...live,
    ...(override ?? {}),
    source,
  };
}

/** Sanitise a capability object arriving from the Settings page. */
export function coerceCapabilities(raw: unknown): Partial<ModelCapabilities> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<ModelCapabilities> = {};

  for (const flag of ["reasoning", "vision", "tools", "streaming", "webSearch"] as const) {
    if (typeof r[flag] === "boolean") out[flag] = r[flag];
  }
  if (r.contextWindow === null) out.contextWindow = null;
  else if (typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)) {
    out.contextWindow = Math.max(0, Math.floor(r.contextWindow));
  }
  return out;
}

export interface CapabilityRequirements {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

/** Minimal request shape used by the capability gate. */
export interface CapabilityRequest {
  messages?: Array<{ content?: unknown }>;
  tools?: unknown[];
  reasoning_effort?: unknown;
}

function containsVisionPart(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "image_url" || p.type === "input_image" || p.image_url !== undefined;
  });
}

/** Infer the minimum model capabilities required by an incoming request. */
export function requirementsForRequest(request: CapabilityRequest): CapabilityRequirements {
  return {
    vision: (request.messages ?? []).some((message) => containsVisionPart(message.content)),
    tools: Array.isArray(request.tools) && request.tools.length > 0,
    reasoning: typeof request.reasoning_effort === "string" && request.reasoning_effort.length > 0,
  };
}

/**
 * Return false only when a model is *known* not to satisfy a requirement.
 *
 * The distinction is the whole point. This used to refuse on `vision: false`
 * whatever the reason for that false, and `UNKNOWN_MODEL.vision` is false — so
 * every model the built-in table had never heard of, which is every Gemini,
 * Claude, DeepSeek and OpenRouter id in the pool, rejected image requests
 * outright with `model_capability_mismatch`. The image never reached an
 * upstream that would have accepted it.
 *
 * A `false` now has to come from somewhere that actually knows: the user's own
 * override, the provider's published manifest, or the verified built-in table.
 * A guess by family, or no information at all, lets the request through and
 * lets the upstream be the one to decide. Upstream refusing an image is a
 * clear error the caller can act on; this gate refusing it is a dead end.
 */
export function meetsRequirements(
  capabilities: ModelCapabilities & { source?: CapabilitySource },
  requirements: CapabilityRequirements,
): boolean {
  // Absent a source this is a bare capability object, which by construction is
  // something a caller asserted. Treat it as fact, as before.
  const trusted = capabilities.source === undefined || AUTHORITATIVE.has(capabilities.source);
  if (!trusted) return true;

  if (requirements.vision && !capabilities.vision) return false;
  if (requirements.tools && !capabilities.tools) return false;
  if (requirements.reasoning && !capabilities.reasoning) return false;
  return true;
}
