/**
 * Virtual models: `auto`, `fast`, `quality`.
 *
 * These are not models. They are selection policies that resolve to a real
 * model on a real credential at request time, so a client can point at one id
 * forever and let the gateway decide what actually serves it.
 *
 *   auto     — whatever the normal rotation offers. Stays on one model until
 *              its quota runs out, then moves on. Cheapest possible policy.
 *   fast     — the model with the lowest measured latency. Sticks with it, and
 *              re-evaluates when it becomes unavailable or something measurably
 *              quicker appears.
 *   quality  — the most capable model available, regardless of how slow it is.
 *
 * `fast` ranks on measurements the gateway has actually taken (per-model probe
 * results and served requests). With no measurements it falls back to the
 * quality order rather than guessing, because an unmeasured model is not
 * evidence of speed.
 */

import type { Credential } from "../pool/types.js";
import { capabilitiesFor, type ModelCapabilities } from "./capabilities.js";
import { lookupModel } from "./model-metadata.js";

export const VIRTUAL_MODELS = ["auto", "fast", "quality"] as const;
export type VirtualModel = (typeof VIRTUAL_MODELS)[number];

export const VIRTUAL_DESCRIPTIONS: Record<VirtualModel, string> = {
  auto: "Any available model. Stays on one until its quota runs out, then rotates.",
  fast: "Lowest measured latency. Re-evaluates when it stalls or something quicker appears.",
  quality: "Most capable model available, however slow it is.",
};

export function isVirtualModel(model: string): model is VirtualModel {
  return (VIRTUAL_MODELS as readonly string[]).includes(model);
}

export interface Candidate {
  credential: Credential;
  model: string;
}

/**
 * Rough capability score. Deliberately coarse: it only has to order models
 * sensibly, and a precise number would imply knowledge we do not have.
 */
export function qualityScore(model: string, caps: ModelCapabilities): number {
  let score = 0;
  if (caps.reasoning) score += 40;
  if (caps.vision) score += 10;
  if (caps.tools) score += 10;
  score += Math.min(30, Math.round((caps.contextWindow ?? 0) / 32_000) * 3);

  // Vendor naming carries real signal about tier, so use it — but weakly, so
  // it never outranks a declared capability.
  const id = model.toLowerCase();
  if (/\bpro\b|-pro|opus|ultra/.test(id)) score += 25;
  if (/thinking|reason|\bo[13]\b/.test(id)) score += 15;
  if (/flash-lite|mini|tiny|small|8b|nano/.test(id)) score -= 20;
  if (/lite/.test(id)) score -= 10;
  if (/preview|exp\b/.test(id)) score -= 5;

  return score;
}

/** Best measured latency for a model across the credentials that serve it. */
function measuredLatency(candidates: Candidate[], model: string): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (c.model !== model) continue;
    const stat = c.credential.modelStats[model];
    if (!stat?.ok || !stat.latencyMs) continue;
    if (best === null || stat.latencyMs < best) best = stat.latencyMs;
  }
  return best;
}

/**
 * Resolve a virtual id to a concrete candidate.
 *
 * `candidates` must already be filtered to things that can actually serve a
 * request right now — this function chooses among them, it does not check
 * availability.
 */
/**
 * Order every candidate by the policy, best first.
 *
 * The router walks this list rather than taking only the top entry: a
 * provider's catalogue lists models it will not actually serve (image models,
 * agent-only surfaces, ids that simply 404), so the first pick can be wrong
 * through no fault of the policy. Having the whole ordering lets the request
 * move on instead of failing.
 */
export function orderCandidates(
  virtual: VirtualModel,
  candidates: Candidate[],
  overrides: Record<string, Partial<ModelCapabilities>> = {},
  sticky?: string | null,
): Candidate[] {
  if (candidates.length === 0) return [];

  /** Known-bad models sink to the bottom; known-good float up. */
  const proven = (c: Candidate): number => {
    const stat = c.credential.modelStats[c.model];
    if (!stat) return 0;
    return stat.ok ? 1 : -1;
  };

  /*
   * Score against what the candidate's own provider published, not just the
   * model id. `quality` was ranking on the built-in table alone, so every
   * model outside it scored as having no reasoning, no vision and an unknown
   * context window — leaving vendor naming as the only real signal and
   * routinely putting a discovered Pro model below a hard-coded mini one.
   */
  const capsOf = (c: Candidate) =>
    capabilitiesFor(c.model, overrides, lookupModel(c.credential.modelMetadata, c.model));

  const byQuality = (a: Candidate, b: Candidate) =>
    qualityScore(b.model, capsOf(b)) - qualityScore(a.model, capsOf(a));

  let ordered: Candidate[];

  if (virtual === "fast") {
    ordered = [...candidates].sort((a, b) => {
      const la = measuredLatency(candidates, a.model);
      const lb = measuredLatency(candidates, b.model);
      // A measured round-trip is stronger evidence than a generic success flag.
      if (la !== null && lb !== null) return la - lb;
      if (la !== null) return -1;
      if (lb !== null) return 1;

      const pa = proven(a);
      const pb = proven(b);
      if (pa !== pb) return pb - pa;
      // No measurements: choose the lighter/faster-looking tier as a prior.
      return -byQuality(a, b);
    });
  } else if (virtual === "quality") {
    ordered = [...candidates].sort((a, b) => {
      // Quality is capability-first. Probe success is only a tie-breaker, never
      // a reason for a weak model to outrank a stronger available model.
      const quality = byQuality(a, b);
      if (quality !== 0) return quality;
      return proven(b) - proven(a);
    });
  } else {
    // auto: whatever is nearest to hand, but never a model already known bad.
    ordered = [...candidates].sort((a, b) => proven(b) - proven(a));
  }

  // Staying put is the whole point of `auto` and `fast`; switching models
  // mid-conversation changes the answer style for no reason. `quality` always
  // wants the best, so it does not stick.
  if (sticky && virtual !== "quality") {
    const held = ordered.filter((c) => c.model === sticky);
    if (held.length) ordered = [...held, ...ordered.filter((c) => c.model !== sticky)];
  }

  return ordered;
}

export function resolveVirtual(
  virtual: VirtualModel,
  candidates: Candidate[],
  overrides: Record<string, Partial<ModelCapabilities>> = {},
  /** Model the caller used last, so `fast` and `auto` can stay put. */
  sticky?: string | null,
): Candidate | null {
  return orderCandidates(virtual, candidates, overrides, sticky)[0] ?? null;
}
