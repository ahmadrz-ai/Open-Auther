/**
 * What each model can do.
 *
 * The Codex backend publishes no capability manifest, so none of this can be
 * detected at runtime. This is a curated table, and it is editable in Settings
 * precisely because a curated table goes stale. Two rules kept it honest:
 *
 *  - Anything not actually verified through this gateway defaults to `false`.
 *    A greyed-out icon that turns out to work is a much smaller problem than a
 *    lit icon that does not.
 *  - `streaming` and `reasoning` are the only things marked true by default,
 *    because the gateway exercises both on every request.
 */

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
 * Resolve capabilities for a model: user overrides win over the built-in
 * table, which wins over the conservative unknown default.
 */
export function capabilitiesFor(
  model: string,
  overrides: Record<string, Partial<ModelCapabilities>> = {},
): ModelCapabilities & { source: "override" | "builtin" | "unknown" } {
  const builtin = BUILTIN_CAPABILITIES[model];
  const override = overrides[model];

  if (override) {
    return { ...(builtin ?? UNKNOWN_MODEL), ...override, source: "override" };
  }
  if (builtin) return { ...builtin, source: "builtin" };
  return { ...UNKNOWN_MODEL, source: "unknown" };
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
