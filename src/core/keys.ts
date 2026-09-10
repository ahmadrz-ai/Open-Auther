/**
 * Gateway keys, and what each one is allowed to see.
 *
 * A key used to be a name and a secret. It is now also a policy: which models
 * it may reach, and — for a Claude key — what those models are called on the
 * way out.
 *
 * Two kinds exist because two clients want opposite things:
 *
 *   standard  Speaks the OpenAI shape, sees the pool's real model ids, and
 *             works with anything. The behaviour every existing key has.
 *
 *   claude    Serves only the Anthropic surface, and presents the pool under
 *             Claude's own model names. The Claude desktop app keeps only ids
 *             matching `anthropic/claude-*` and refuses the rest, so a pool of
 *             Gemini, GPT and Qwen ids is invisible to it. Renaming is the one
 *             thing that makes them reachable — the app's own warning says as
 *             much: "Name routes to match the underlying model."
 */

import { qualityScore } from "./virtual.js";
import { capabilitiesFor, type ModelCapabilities } from "./capabilities.js";

export type KeyKind = "standard" | "claude";

export interface GatewayKey {
  /** Human label used in logs. Never the key itself. */
  name: string;
  key: string;
  /** Defaults to `standard`, which is what every pre-existing key is. */
  kind?: KeyKind;
  /**
   * Models this key may use. `null` or absent means every model in the pool,
   * which keeps a freshly generated key working with no configuration.
   */
  allowedModels?: string[] | null;
  /**
   * For a Claude key: `claude model name -> real pooled model`.
   *
   * Persisted rather than recomputed so a name keeps pointing at the same
   * model as the pool changes underneath it. A client that pinned
   * `claude-opus-5` yesterday should not silently get a different model today
   * because a provider added something that outranks it.
   */
  claudeAliases?: Record<string, string>;
}

/**
 * Claude model names the desktop app accepts, strongest first.
 *
 * The app filters discovered ids down to things matching `anthropic/claude-*`
 * or `claude-*`, so these are the only labels a pooled model can wear there.
 * Ordered by tier so auto-assignment puts the best model on the best name.
 */
export const CLAUDE_TIERS = [
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
  "claude-fable-5-1",
  "claude-fable-5",
] as const;

/** The id a Claude key advertises for a tier. */
export function tierId(tier: string): string {
  return `anthropic/${tier}`;
}

/**
 * Names the pool's own providers use for genuine Claude models.
 *
 * These are hidden from a Claude key. They are the models an aggregator
 * charges for — the ones answering "this premium model requires an active paid
 * plan" — so surfacing them means every request the client sends by default is
 * one that cannot succeed. Their names are also exactly the names this key
 * hands out, so leaving them in would collide with the aliases.
 */
export function isRealClaudeModel(model: string): boolean {
  return /(^|\/)(anthropic\/)?claude[-.]/i.test(model) || /claude/i.test(model.split("/")[0] ?? "");
}

/** Seed assignments the user asked for by name, applied before ranking. */
const PREFERRED: Record<string, string> = {
  // Codex's headline pair, pinned to the top two Opus names.
  "gpt-5.6-terra": "claude-opus-5",
  "gpt-5.6-luna": "claude-opus-4.8",
};

export interface AliasOptions {
  /** Models the pool can actually serve right now. */
  models: string[];
  /** Existing assignments, kept wherever their target is still servable. */
  existing?: Record<string, string>;
  overrides?: Record<string, Partial<ModelCapabilities>>;
}

/**
 * Decide which real model answers to each Claude name.
 *
 * Deterministic and stable: an assignment that still points at a servable
 * model is never moved, the user's pinned pairs come next, and whatever is
 * left is filled by capability rank. Two runs over the same pool produce the
 * same map, so a client's chosen model does not wander between restarts.
 */
export function assignClaudeAliases(opts: AliasOptions): Record<string, string> {
  const servable = new Set(opts.models.filter((m) => !isRealClaudeModel(m)));
  const out: Record<string, string> = {};
  const taken = new Set<string>();

  // 1. Keep what already works.
  for (const [tier, model] of Object.entries(opts.existing ?? {})) {
    if (servable.has(model) && (CLAUDE_TIERS as readonly string[]).includes(tier)) {
      out[tier] = model;
      taken.add(model);
    }
  }

  // 2. Honour the pinned pairs, matching on the id's tail so a provider
  //    prefix like `openai/` does not stop `gpt-5.6-terra` being recognised.
  for (const [needle, tier] of Object.entries(PREFERRED)) {
    if (out[tier]) continue;
    const hit = [...servable].find(
      (m) => !taken.has(m) && (m === needle || m.toLowerCase().endsWith(`/${needle}`)),
    );
    if (hit) {
      out[tier] = hit;
      taken.add(hit);
    }
  }

  // 3. Fill the rest by capability, best model onto the best remaining name.
  const ranked = [...servable]
    .filter((m) => !taken.has(m))
    .sort((a, b) => {
      const byScore =
        qualityScore(b, capabilitiesFor(b, opts.overrides)) -
        qualityScore(a, capabilitiesFor(a, opts.overrides));
      return byScore || a.localeCompare(b);
    });

  for (const tier of CLAUDE_TIERS) {
    if (out[tier]) continue;
    const next = ranked.shift();
    if (!next) break;
    out[tier] = next;
  }
  return out;
}

/** True when this key may use this model. */
export function keyAllows(key: GatewayKey, model: string): boolean {
  const allowed = key.allowedModels;
  if (!allowed) return true;
  if (allowed.length === 0) return false;
  return allowed.some((m) => m.toLowerCase() === model.toLowerCase());
}

/** Apply a key's allowlist to a catalogue of model ids. */
export function filterForKey(key: GatewayKey, models: string[]): string[] {
  return models.filter((m) => keyAllows(key, m));
}

/**
 * Resolve what a Claude key asked for into a model the pool serves.
 *
 * Returns null when the name is not one this key hands out, which the caller
 * reports rather than guessing — a Claude key's catalogue is entirely
 * synthetic, so an unknown name means the client is out of step with it.
 */
export function resolveClaudeAlias(key: GatewayKey, requested: string): string | null {
  const aliases = key.claudeAliases ?? {};
  const asked = requested.trim();
  const bare = asked.replace(/^anthropic\//i, "");

  for (const [tier, model] of Object.entries(aliases)) {
    if (tier === bare || tier === asked || tierId(tier) === asked) return model;
  }
  return null;
}

/** Normalise a key loaded from disk, so older config files keep working. */
export function normaliseKey(raw: GatewayKey): Required<Pick<GatewayKey, "kind">> & GatewayKey {
  return {
    ...raw,
    kind: raw.kind === "claude" ? "claude" : "standard",
    allowedModels: raw.allowedModels ?? null,
    claudeAliases: raw.claudeAliases ?? {},
  };
}
