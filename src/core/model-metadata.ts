/**
 * What a provider told us about each of its models, plus a family heuristic
 * for everything it did not.
 *
 * Two things used to be missing, and each caused its own visible failure:
 *
 *  - The Antigravity backend publishes `supportsImages` per model, and the
 *    OpenRouter catalogue publishes input modalities. All of it was thrown
 *    away at discovery, leaving `capabilitiesFor` with nothing but a curated
 *    table of GPT ids. Every Gemini and Claude model therefore resolved to
 *    `UNKNOWN_MODEL`, whose `vision` is false, and the router refused image
 *    requests for models that accept images perfectly well.
 *
 *  - Nothing recorded that a backend had retired an id. A pinned
 *    `gemini-3.5-flash` kept being sent long after the backend started
 *    answering "no longer available, switch to 3.7", because the replacement
 *    named in that same response was dropped on the floor.
 *
 * So discovery now keeps the facts, not just the ids. A discovered record is
 * authoritative: it came from the account that has to serve the request.
 */

import type { ModelCapabilities } from "./capabilities.js";

/**
 * One model as its provider describes it.
 *
 * `null` on a capability flag means the provider did not say, which is not the
 * same as "no". Only `true` and `false` ever gate a request.
 */
export interface DiscoveredModel {
  id: string;
  /** Human name from the backend, e.g. "Gemini 3.7 Flash (High)". */
  displayName: string | null;
  vision: boolean | null;
  reasoning: boolean | null;
  tools: boolean | null;
  contextWindow: number | null;
  /** Set when the backend says this id is superseded by another. */
  replacedBy: string | null;
  /** Serves chat. False for tab-completion, image and embedding surfaces. */
  chat: boolean;
  /** Epoch seconds this record was written. */
  discoveredAt: number;
}

export type ModelMetadata = Record<string, DiscoveredModel>;

/** A record with every optional field defaulted, so callers can build one field at a time. */
export function discoveredModel(
  id: string,
  patch: Partial<Omit<DiscoveredModel, "id">> = {},
  at: number = Math.floor(Date.now() / 1000),
): DiscoveredModel {
  return {
    id,
    displayName: null,
    vision: null,
    reasoning: null,
    tools: null,
    contextWindow: null,
    replacedBy: null,
    chat: true,
    discoveredAt: at,
    ...patch,
  };
}

/** Build a record from a discovery result, keyed by model id. */
export function toMetadata(models: readonly DiscoveredModel[]): ModelMetadata {
  const out: ModelMetadata = {};
  for (const m of models) {
    const id = m.id.trim();
    if (id) out[id] = { ...m, id };
  }
  return out;
}

/** Parse a stored `model_metadata` blob, tolerating anything malformed. */
export function parseMetadata(raw: string | null | undefined): ModelMetadata {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ModelMetadata = {};
    const tri = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      out[id] = {
        id,
        displayName: typeof v.displayName === "string" ? v.displayName : null,
        vision: tri(v.vision),
        reasoning: tri(v.reasoning),
        tools: tri(v.tools),
        contextWindow: typeof v.contextWindow === "number" ? v.contextWindow : null,
        replacedBy: typeof v.replacedBy === "string" && v.replacedBy ? v.replacedBy : null,
        chat: v.chat !== false,
        discoveredAt: typeof v.discoveredAt === "number" ? v.discoveredAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Case-insensitive lookup, because model ids vary in case across surfaces.
 *
 * Accepts a missing map rather than requiring callers to guard. A credential
 * that predates discovery, or one built by a caller outside the store, simply
 * has nothing on record — which is a normal state, not an error.
 */
export function lookupModel(
  metadata: ModelMetadata | null | undefined,
  model: string,
): DiscoveredModel | null {
  if (!metadata) return null;
  const direct = metadata[model];
  if (direct) return direct;
  const wanted = model.toLowerCase();
  for (const [id, value] of Object.entries(metadata)) {
    if (id.toLowerCase() === wanted) return value;
  }
  return null;
}

/**
 * Merge what several credentials know about one model.
 *
 * A capability counts as true when any credential's provider says it is true:
 * that credential can serve the request, and the router's per-credential
 * filter decides which one actually does. Taking the pessimistic side here
 * would reject a request the pool can plainly satisfy.
 */
export function mergeDiscovered(
  sources: ReadonlyArray<ModelMetadata | null | undefined>,
  model: string,
): DiscoveredModel | null {
  const or = (a: boolean | null, b: boolean | null): boolean | null => {
    if (a === true || b === true) return true;
    if (a === false || b === false) return false;
    return null;
  };

  let out: DiscoveredModel | null = null;
  for (const source of sources) {
    if (!source) continue;
    const found = lookupModel(source, model);
    if (!found) continue;
    if (!out) {
      out = { ...found };
      continue;
    }
    out = {
      ...out,
      displayName: out.displayName ?? found.displayName,
      vision: or(out.vision, found.vision),
      reasoning: or(out.reasoning, found.reasoning),
      tools: or(out.tools, found.tools),
      contextWindow: Math.max(out.contextWindow ?? 0, found.contextWindow ?? 0) || null,
      // A replacement only applies when every source that knows the id agrees
      // it is retired. One stale account must not redirect the whole pool.
      replacedBy:
        out.replacedBy && found.replacedBy && out.replacedBy === found.replacedBy
          ? out.replacedBy
          : null,
      chat: out.chat || found.chat,
      discoveredAt: Math.max(out.discoveredAt, found.discoveredAt),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Family heuristic

/**
 * Model families whose image support is well established.
 *
 * Advisory only. It exists so a freshly connected endpoint shows the right
 * icons and ranks sensibly under `quality`, and it is never allowed to refuse
 * a request: see `capabilitiesFor`, where an inferred result does not gate.
 * Getting an entry wrong therefore costs a wrong icon, not a failed request.
 */
const VISION_FAMILIES: RegExp[] = [
  /(^|[/-])gemini-/i,
  /(^|[/-])claude-(3|4|5|opus|sonnet|haiku)/i,
  /(^|[/-])gpt-4o/i,
  /(^|[/-])gpt-4\.1/i,
  /(^|[/-])gpt-4-turbo/i,
  /(^|[/-])gpt-4-vision/i,
  /(^|[/-])gpt-5/i,
  /(^|[/-])o[134](-|$)/i,
  /(^|[/-])llama-4/i,
  /llama-3\.2-(11b|90b)/i,
  /(^|[-_])(vl|vision)([-_.]|$)/i,
  /(^|[/-])pixtral/i,
  /(^|[/-])llava/i,
  /(^|[/-])internvl/i,
  /minicpm-v/i,
  /(^|[/-])grok-(2-vision|3|4)/i,
  /(^|[/-])mistral-(small-3|medium-3|large-3)/i,
];

/** Families that are text-only despite matching a broader rule above. */
const TEXT_ONLY: RegExp[] = [
  /(^|[/-])o1-mini/i,
  /(^|[/-])o3-mini/i,
  /(^|[/-])codex-mini/i,
  /(^|[/-])gpt-oss/i,
  /(^|[/-])deepseek-(chat|coder|r1|v3|reasoner)/i,
  /(^|[/-])kimi-k[23]/i,
  /(^|[/-])qwq/i,
];

const REASONING_FAMILIES: RegExp[] = [
  /(^|[/-])o[134](-|$)/i,
  /(^|[/-])gpt-5/i,
  /[-_](thinking|think|reasoner|reasoning)([-_.]|$)/i,
  /(^|[/-])deepseek-(r1|reasoner)/i,
  /(^|[/-])qwq/i,
  /(^|[/-])gpt-oss/i,
  /(^|[/-])gemini-(2\.5|3)/i,
  /(^|[/-])claude-(opus|sonnet)-4/i,
];

function matches(patterns: readonly RegExp[], model: string): boolean {
  return patterns.some((p) => p.test(model));
}

/**
 * Best guess at what a model can do, from its id alone.
 *
 * Returns null when the id resembles nothing recognisable, so the caller falls
 * through to the conservative unknown default rather than recording a guess it
 * has no basis for.
 */
export function inferCapabilities(model: string): Partial<ModelCapabilities> | null {
  const id = model.trim();
  if (!id) return null;

  const textOnly = matches(TEXT_ONLY, id);
  const vision = !textOnly && matches(VISION_FAMILIES, id);
  const reasoning = matches(REASONING_FAMILIES, id);

  if (!vision && !reasoning && !textOnly) return null;
  return { vision, reasoning, tools: true, streaming: true };
}
