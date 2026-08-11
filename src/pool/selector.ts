/**
 * Credential selection strategies.
 *
 * `fill_first` is the default on purpose. Draining one account before touching
 * the next staggers the reset dates across the pool, so there is usually a
 * fresh account coming online. Spreading load evenly (round_robin, least_used)
 * looks fairer but marches every account toward exhaustion together, producing
 * a cliff where the whole pool dies at once and nothing resets for weeks.
 */

import { now } from "../db.js";
import type { CredentialStore } from "./store.js";
import { isAvailable } from "./store.js";
import type { Credential } from "./types.js";
import type { RotationStrategy } from "../config.js";

/** Models a Google API key can serve. */
const GOOGLE_MODEL = /^(gemini|gemma|imagen|veo|lyria|nano-banana|aqa|deep-research|antigravity)/i;

/**
 * Can this credential serve this model?
 *
 * Provider families do not overlap: a Google API key cannot answer for
 * `gpt-4o`, and a ChatGPT OAuth credential cannot answer for
 * `gemini-3.5-flash`. Routing across that boundary always fails, so it is
 * worth refusing up front rather than spending an attempt to find out.
 */
export function canServe(credential: Credential, model: string): boolean {
  // An explicit exclusion wins over everything else the credential could do.
  if (credential.excludedModels.includes(model)) return false;

  // Per-model quota: this one model is benched, the connection is not.
  const until = credential.modelCooldowns[model];
  if (until && until > now()) return false;

  const isGoogle = GOOGLE_MODEL.test(model);

  switch (credential.providerType) {
    case "gemini":
      return isGoogle;

    case "web_cookie":
      // A web session serves exactly the models its own app offers.
      return (credential.customModels ?? []).includes(model);

    case "antigravity":
      // Cloud Code serves Gemini *and* Claude- and GPT-branded models, so the
      // Google-family test alone would wrongly exclude most of its catalogue.
      // The credential's discovered model list is what decides.
      return (credential.customModels ?? []).includes(model);

    case "openai_custom": {
      // An explicit model list is authoritative. Without one we cannot know
      // what the endpoint serves, so allow anything non-Google and let the
      // provider decide.
      const declared = (credential.customModels ?? []).map((m) => m.trim()).filter(Boolean);
      if (declared.length) return declared.includes(model);
      return !isGoogle;
    }

    default:
      // ChatGPT OAuth, and anything unlabelled.
      return !isGoogle;
  }
}

export interface SelectOptions {
  /** Credential ids already attempted for the current client request. */
  exclude?: ReadonlySet<number>;
  model?: string;
  /** Tags the caller asked for, from the `x-ai-auther-tags` header. */
  tags?: string[];
  /** Restrict rotation to one provider id when the dashboard selects it. */
  providerId?: string | null;
  at?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export function selectCredential(
  store: CredentialStore,
  strategy: RotationStrategy,
  opts: SelectOptions = {},
): Credential | null {
  const at = opts.at ?? now();
  const exclude = opts.exclude ?? new Set<number>();

  // Return elapsed cooldowns to the pool before deciding there is nothing left.
  store.wakeExpired(at);

  let pool = store
    .all()
    .filter((c) => isAvailable(c, at) && !exclude.has(c.id) && c.accessToken !== null);

  if (opts.providerId) pool = pool.filter((c) => c.providerId === opts.providerId);

  // Provider affinity, and it fails closed. The previous version only steered
  // `gemini-` models and fell back to the whole pool when no Gemini key was
  // free — so a Gemini request would be handed to a ChatGPT credential, burn
  // an attempt against it, and come back "model does not exist". A credential
  // that cannot serve the model is not a fallback, it is a wasted request.
  if (opts.model) pool = pool.filter((c) => canServe(c, opts.model!));

  /*
   * Routing tags. A tagged connection is reserved: it only serves requests
   * that asked for one of its tags. An untagged connection serves anything,
   * so adding a tag narrows rather than widens.
   */
  if (opts.tags?.length) {
    const wanted = new Set(opts.tags);
    pool = pool.filter((c) => c.routingTags.length === 0 || c.routingTags.some((t) => wanted.has(t)));
  } else {
    pool = pool.filter((c) => c.routingTags.length === 0);
  }

  if (pool.length === 0) return null;

  /*
   * Priority partitions the pool before the strategy runs. Everything at
   * priority 1 is exhausted before anything at 2 is touched, and the chosen
   * strategy then decides within that band.
   */
  const topPriority = Math.min(...pool.map((c) => c.priority));
  pool = pool.filter((c) => c.priority === topPriority);

  switch (strategy) {
    case "fill_first":
      // Lowest id wins: deterministic, and keeps hammering one account until
      // upstream cuts it off.
      return pool.reduce((best, c) => (c.id < best.id ? c : best));

    case "round_robin": {
      const idx = store.nextCursor() % pool.length;
      return pool[idx] ?? pool[0]!;
    }

    case "least_used":
      return pool.reduce((best, c) => {
        if (c.requestCount !== best.requestCount) {
          return c.requestCount < best.requestCount ? c : best;
        }
        // Tie-break on staleness so equal-count credentials still alternate.
        const cLast = c.lastUsedAt ?? 0;
        const bLast = best.lastUsedAt ?? 0;
        if (cLast !== bLast) return cLast < bLast ? c : best;
        return c.id < best.id ? c : best;
      });

    case "random": {
      const rnd = opts.random ?? Math.random;
      const idx = Math.min(pool.length - 1, Math.floor(rnd() * pool.length));
      return pool[idx]!;
    }

    default: {
      const exhaustive: never = strategy;
      throw new Error(`Unhandled rotation strategy: ${String(exhaustive)}`);
    }
  }
}
