/**
 * Keeping the model catalogue current, without being asked.
 *
 * Discovery already existed and worked. What did not exist was anything that
 * ran it again. It fired once at sign-in and then only when someone typed
 * `open-auther providers discover`, so a connection made in March was still
 * routing March's model ids in September — which is exactly how a request ends
 * up answered with "Gemini 3.5 Flash is no longer available, switch to 3.7".
 * The backend had been saying so for weeks; nothing here was listening.
 *
 * So every provider that can be asked what it serves is asked on a schedule,
 * and the answer replaces the static defaults for both routing and
 * capabilities. The static lists in `providers.ts` remain, but only as the
 * bootstrap for a connection that has not synced yet.
 *
 * Three properties this deliberately has:
 *
 *  - A failed sync changes nothing. The previous list keeps serving, because
 *    a network blip must not empty a working pool.
 *  - Nothing is written when the answer is identical, so a stable account
 *    produces no event churn in the dashboard.
 *  - Tokens are refreshed first. Discovery used to run on whatever was on
 *    disk, so an expired token looked like an account with no entitlements.
 */

import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { CredentialStore } from "../pool/store.js";
import type { Credential } from "../pool/types.js";
import { fetchAntigravityDiscovery } from "../upstream/antigravity.js";
import { fetchCodexDiscovery } from "../upstream/codex.js";
import { fetchOpenAiDiscovery } from "../upstream/discovery.js";
import { ensureFreshToken } from "./refresh.js";
import { providerDef } from "./providers.js";
import type { DiscoveredModel } from "./model-metadata.js";

const log = createLogger({ mod: "model-sync" });

export interface SyncResult {
  credentialId: number;
  providerId: string;
  ok: boolean;
  /** True when the provider cannot be asked, so nothing was attempted. */
  skipped: boolean;
  /** Chat model ids now on record for this credential. */
  models: string[];
  /** Ids that appeared since the previous sync. */
  added: string[];
  /** Ids the provider has stopped offering. */
  removed: string[];
  /** Retired id -> the replacement the provider named. */
  replaced: Record<string, string>;
  /** False when the answer matched what was already stored. */
  changed: boolean;
  message: string;
}

/**
 * Ask one provider what it currently serves.
 *
 * Returns null for providers with nothing to ask — a web-session connection
 * has no catalogue endpoint, and its model list is a property of the site
 * rather than the account.
 */
export async function discoverModels(
  store: CredentialStore,
  cfg: Config,
  credential: Credential,
): Promise<DiscoveredModel[] | null> {
  // Refresh first. An hour-old Antigravity token 401s, and a 401 here is
  // indistinguishable from an account that may use nothing.
  const fresh = credential.refreshToken
    ? await ensureFreshToken(store, cfg, credential.id).catch(() => credential)
    : credential;

  switch (fresh.providerType) {
    case "codex_oauth":
      if (!fresh.accessToken) return null;
      return await fetchCodexDiscovery(fresh.accessToken);

    case "antigravity":
      if (!fresh.accessToken || !fresh.baseUrl) return null;
      return await fetchAntigravityDiscovery(fresh);

    case "gemini":
    case "openai_custom": {
      const def = providerDef(fresh.providerId);
      const base = fresh.baseUrl || def?.baseUrl;
      // `listsModels` is false for endpoints known not to have the route.
      // Probing them anyway just logs a 404 every sweep.
      if (!base || (def && !def.listsModels)) return null;
      // An Anthropic-shaped endpoint has no `/models`; detection recorded that.
      if (fresh.protocol === "anthropic_messages") return null;
      return await fetchOpenAiDiscovery(base, fresh.accessToken);
    }

    case "web_cookie":
      return null;

    default:
      return null;
  }
}

/** Ids a credential is currently routing on. */
function currentIds(credential: Credential): string[] {
  return [...(credential.customModels ?? [])].sort();
}

/**
 * Refresh one credential's catalogue and persist the result.
 *
 * Never throws: a sync failure is reported, not propagated, because this runs
 * unattended on a timer and one unreachable endpoint must not stop the sweep.
 */
export async function syncCredential(
  store: CredentialStore,
  cfg: Config,
  credential: Credential,
): Promise<SyncResult> {
  const base: SyncResult = {
    credentialId: credential.id,
    providerId: credential.providerId,
    ok: false,
    skipped: false,
    models: currentIds(credential),
    added: [],
    removed: [],
    replaced: {},
    changed: false,
    message: "",
  };

  let discovered: DiscoveredModel[] | null;
  try {
    discovered = await discoverModels(store, cfg, credential);
  } catch (err) {
    return {
      ...base,
      message: `Model discovery failed: ${(err as Error).message}`,
    };
  }

  if (discovered === null) {
    return {
      ...base,
      ok: true,
      skipped: true,
      message: `${credential.providerId} publishes no model catalogue; static defaults stand.`,
    };
  }

  if (!discovered.length) {
    /*
     * An empty answer is treated as a failure, not as "this account may use
     * nothing". A 200 with no models is what a revoked or quota-locked token
     * produces, and adopting it would blank the routing list and take a
     * recoverable account out of the pool until someone noticed.
     */
    return {
      ...base,
      message:
        `${credential.providerId} returned an empty catalogue; keeping the ` +
        `${base.models.length} model(s) already on record.`,
    };
  }

  const before = new Set(base.models);
  const chat = discovered.filter((m) => m.chat).map((m) => m.id);
  const after = new Set(chat);

  const replaced: Record<string, string> = {};
  for (const model of discovered) {
    if (model.replacedBy) replaced[model.id] = model.replacedBy;
  }

  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  const changed = added.length > 0 || removed.length > 0;

  store.setDiscoveredModels(credential.id, discovered);

  /*
   * Recorded failures were measured against the previous catalogue — often
   * against a client version the backend has since stopped accepting — so a
   * changed list invalidates them. Successes are kept; they are still
   * evidence, and `fast` ranks on their latency.
   */
  if (changed) store.clearModelStats(credential.id, true);

  const summary = changed
    ? `${chat.length} model(s): +${added.length} / -${removed.length}`
    : `${chat.length} model(s), unchanged`;

  return {
    credentialId: credential.id,
    providerId: credential.providerId,
    ok: true,
    skipped: false,
    models: [...after].sort(),
    added,
    removed,
    replaced,
    changed,
    message: `${credential.providerId}: ${summary}.`,
  };
}

export interface SweepOptions {
  /** Sync every credential, ignoring how recently each was last synced. */
  force?: boolean;
  /** Only this credential. */
  credentialId?: number;
}

/** True when this credential is due a sync under the configured TTL. */
function isDue(credential: Credential, ttlSeconds: number, at: number): boolean {
  if (credential.state === "dead") return false;
  if (credential.modelsSyncedAt === null) return true;
  return at - credential.modelsSyncedAt >= ttlSeconds;
}

/**
 * Sync every credential that is due.
 *
 * Sequential on purpose. A sweep is not latency-sensitive, and several
 * providers here are the same upstream behind different credentials — firing
 * them together is a good way to earn a rate limit on the catalogue endpoint.
 */
export async function syncPool(
  store: CredentialStore,
  cfg: Config,
  opts: SweepOptions = {},
): Promise<SyncResult[]> {
  const at = Math.floor(Date.now() / 1000);
  const ttl = Math.max(0, cfg.modelSyncHours) * 3600;

  const candidates = store
    .all()
    .filter((c) => opts.credentialId === undefined || c.id === opts.credentialId)
    .filter((c) => opts.force || opts.credentialId !== undefined || isDue(c, ttl, at));

  const results: SyncResult[] = [];
  for (const credential of candidates) {
    const result = await syncCredential(store, cfg, credential);
    results.push(result);

    if (result.changed) {
      log.info("models_synced", {
        credential: result.credentialId,
        provider: result.providerId,
        added: result.added,
        removed: result.removed,
      });
    } else if (!result.ok) {
      log.debug("model_sync_failed", {
        credential: result.credentialId,
        message: result.message,
      });
    }
  }
  return results;
}

export interface ModelSyncHandle {
  stop(): void;
  /** Resolves once the initial sweep has finished. Useful in tests. */
  ready: Promise<void>;
}

/**
 * Start the periodic sweep.
 *
 * The first sweep is delayed rather than run at boot: a gateway that has just
 * started is usually about to serve a request, and several catalogue calls in
 * front of it only add latency to the thing the user is waiting for.
 *
 * Returns a handle whose timers are `unref`'d, so the process still exits on
 * its own when nothing else is holding it open.
 */
export function startModelSync(
  store: CredentialStore,
  cfg: Config,
  opts: { initialDelayMs?: number } = {},
): ModelSyncHandle {
  if (cfg.modelSyncHours <= 0) {
    log.debug("model_sync_disabled", {});
    return { stop: () => {}, ready: Promise.resolve() };
  }

  const periodMs = cfg.modelSyncHours * 3600 * 1000;
  let stopped = false;
  let delayTimer: NodeJS.Timeout | null = null;
  let repeatTimer: NodeJS.Timeout | null = null;

  const sweep = async (): Promise<void> => {
    if (stopped) return;
    try {
      const results = await syncPool(store, cfg);
      const changed = results.filter((r) => r.changed).length;
      if (changed) log.info("model_sync_sweep", { synced: results.length, changed });
    } catch (err) {
      log.warn("model_sync_sweep_failed", { err: (err as Error).message });
    }
  };

  const ready = new Promise<void>((resolve) => {
    delayTimer = setTimeout(() => {
      void sweep().finally(() => {
        resolve();
        if (stopped) return;
        repeatTimer = setInterval(() => void sweep(), periodMs);
        repeatTimer.unref?.();
      });
    }, opts.initialDelayMs ?? 20_000);
    delayTimer.unref?.();
  });

  return {
    stop: () => {
      stopped = true;
      if (delayTimer) clearTimeout(delayTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      delayTimer = null;
      repeatTimer = null;
    },
    ready,
  };
}
