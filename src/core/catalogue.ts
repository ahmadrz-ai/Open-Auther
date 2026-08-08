/**
 * The model catalogue actually served on `/v1/models`.
 *
 * Previously this returned a hand-maintained list from config, which is why a
 * pool holding several hundred models advertised seven Gemini ids. It now
 * comes from the credentials themselves: whatever each connection has told us
 * it can serve.
 */

import type { Credential } from "../pool/types.js";
import { canServe } from "../pool/selector.js";
import { providerDef } from "./providers.js";
import { VIRTUAL_DESCRIPTIONS, VIRTUAL_MODELS } from "./virtual.js";

export interface CatalogueEntry {
  id: string;
  /** Provider ids that can serve it. */
  providers: string[];
  /** True when at least one healthy credential offers it. */
  available: boolean;
  /** False when the id looks like a paid tier. */
  free: boolean;
  virtual: boolean;
  description?: string;
}

/**
 * Does this model id look like a paid tier?
 *
 * Only OpenRouter marks this unambiguously, with a `:free` suffix on its free
 * catalogue — so for OpenRouter the absence of that suffix means paid, and the
 * signal is reliable. Everywhere else the credential itself is either free or
 * not, so every model it serves is as free as the key is, and there is nothing
 * to filter.
 */
export function looksFree(model: string, providerId: string): boolean {
  if (providerId === "openrouter") return /:free$/i.test(model);
  return true;
}

/**
 * Model families that exist in a provider's catalogue but cannot serve a chat
 * completion: image and video generation, speech, embeddings, rerankers, and
 * the specialised agent surfaces that speak their own API.
 *
 * Without this the list is technically complete and practically broken —
 * `quality` picked `imagen-4.0-ultra-generate-001` and the request came back
 * "not supported for generateContent".
 */
const NON_CHAT =
  /(^|[/-])(imagen|veo|lyria|whisper|tts|dall-?e|stable-?diffusion|flux)|(^|-)(embedding|embed|rerank|moderation)(-|$)|native-audio|-image($|-)|image-preview|live-preview|robotics|computer-use|deep-research|nano-banana|^aqa$/i;

export function isChatModel(model: string): boolean {
  return !NON_CHAT.test(model);
}

/** Models a credential currently offers, honouring exclusions and cooldowns. */
function modelsOf(credential: Credential): string[] {
  const declared = credential.customModels?.length
    ? credential.customModels
    : (providerDef(credential.providerId)?.defaultModels ?? []);
  return declared.filter((m) => isChatModel(m) && canServe(credential, m));
}

export interface BuildOptions {
  /** Drop anything that looks paid. */
  freeOnly?: boolean;
  /** Include the auto/fast/quality entries at the top. */
  includeVirtual?: boolean;
}

export function buildCatalogue(
  credentials: Credential[],
  opts: BuildOptions = {},
): CatalogueEntry[] {
  const byModel = new Map<string, { providers: Set<string>; available: boolean; free: boolean }>();

  for (const credential of credentials) {
    const healthy = credential.state === "active";
    for (const model of modelsOf(credential)) {
      const free = looksFree(model, credential.providerId);
      if (opts.freeOnly && !free) continue;

      const entry = byModel.get(model) ?? {
        providers: new Set<string>(),
        available: false,
        free,
      };
      entry.providers.add(credential.providerId);
      entry.available ||= healthy;
      // A model offered free anywhere counts as free.
      entry.free ||= free;
      byModel.set(model, entry);
    }
  }

  const real: CatalogueEntry[] = [...byModel.entries()]
    .map(([id, v]) => ({
      id,
      providers: [...v.providers].sort(),
      available: v.available,
      free: v.free,
      virtual: false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!opts.includeVirtual) return real;

  // The virtual entries lead the list: they are what most clients should pick.
  const virtual: CatalogueEntry[] = VIRTUAL_MODELS.filter(() => real.length > 0).map((id) => ({
    id,
    providers: [...new Set(real.flatMap((m) => m.providers))].sort(),
    available: real.some((m) => m.available),
    free: true,
    virtual: true,
    description: VIRTUAL_DESCRIPTIONS[id],
  }));

  return [...virtual, ...real];
}
