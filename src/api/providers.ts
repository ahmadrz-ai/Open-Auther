/**
 * Provider onboarding and testing.
 *
 * The testing story is the point of this file: adding a key tells you nothing
 * about whether it works, so every add path can be followed by a real probe,
 * and a bulk probe can sort a pile of pasted keys into working and broken
 * without you checking them one at a time.
 */

import { Hono, type Context } from "hono";
import type { Config } from "../config.js";
import { now } from "../db.js";
import { createLogger } from "../logging.js";
import { isChatModel, looksFree } from "../core/catalogue.js";
import { providerDef, providerDefs, BUILTIN_PROVIDER_REGISTRY } from "../core/providers.js";
import { buildProviderStatus } from "../core/diagnostics.js";
import {
  credentialInstructions,
  extractWebCredential,
  WEB_COOKIE_BY_ID,
  WEB_COOKIE_PROVIDERS,
} from "../core/webcookie.js";
import { canServe } from "../pool/selector.js";
import { displayName, effectiveState, toPublic, type CredentialStore } from "../pool/store.js";
import type { Router } from "../router.js";
import { detectEndpoint, type DetectionResult } from "../upstream/detect.js";
import { checkGeminiSession } from "../upstream/geminiweb.js";
import { checkKimiSession } from "../upstream/kimiweb.js";
import { errorResponse } from "./errors.js";
import { testCredential } from "./testconn.js";

const log = createLogger({ mod: "providers" });

/**
 * Validate a pasted web session before it is stored.
 *
 * Extraction runs first: most failures are "that is not the right cookie",
 * and saying so beats a network round trip that reports a generic 401.
 */
async function checkWebSession(
  providerId: string,
  raw: string,
): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
  const def = WEB_COOKIE_BY_ID.get(providerId);
  if (!def) return { ok: false, message: `Unknown provider "${providerId}".`, latencyMs: null };

  // Gemini can be *checked* even though it cannot yet be routed — worth doing,
  // because the naive status-code check reports every value as valid.
  if (providerId === "gemini-web") return await checkGeminiSession(raw);

  if (!def.implemented) {
    return { ok: false, message: `${def.label} has no transport yet.`, latencyMs: null };
  }

  const value = extractWebCredential(providerId, raw);
  if (!value) {
    return {
      ok: false,
      message: `Could not find "${def.credentialName}" in that value.`,
      latencyMs: null,
    };
  }

  if (providerId === "kimi-web") return await checkKimiSession(value);
  return { ok: false, message: "No checker implemented for this provider.", latencyMs: null };
}

/** Split a textarea of keys: newline or comma separated, blanks dropped. */
function splitKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((k) => k.trim()).filter(Boolean);
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function providerRoutes(
  cfg: Config,
  store: CredentialStore,
  router: Router,
): Hono {
  const app = new Hono();

  app.get("/status", (c) =>
    c.json({ providers: buildProviderStatus(BUILTIN_PROVIDER_REGISTRY, store.all(), now()) }),
  );

  // ------------------------------------------------------------ catalogue

  /** Everything the Add Provider page needs to render itself. */
  app.get("/catalogue", (c) => {
    const creds = store.all();
    const defs = providerDefs();

    return c.json({
      providers: defs.map((def) => {
        const mine = creds.filter((x) => x.providerId === def.id);
        return {
          id: def.id,
          label: def.label,
          blurb: def.blurb,
          baseUrl: def.baseUrl,
          auth: def.auth,
          multiKey: def.multiKey,
          keyHint: def.keyHint,
          keyUrl: def.keyUrl,
          listsModels: def.listsModels,
          defaultModels: def.defaultModels,
          connected: mine.length,
          healthy: mine.filter((x) => x.state === "active").length,
          credentials: mine.map((x) => toPublic(x)),
        };
      }),
    });
  });

  // -------------------------------------------------- web sessions

  /** Catalogue of cookie/session providers, with instructions for each. */
  app.get("/web/catalogue", (c) => {
    const creds = store.all();
    return c.json({
      providers: WEB_COOKIE_PROVIDERS.map((def) => {
        const mine = creds.filter((x) => x.providerId === def.id);
        return {
          id: def.id,
          label: def.label,
          website: def.website,
          blurb: def.blurb,
          kind: def.kind,
          credentialName: def.credentialName,
          placeholder: def.placeholder,
          note: def.note ?? null,
          implemented: def.implemented,
          instructions: credentialInstructions(def),
          connected: mine.length,
          healthy: mine.filter((x) => x.state === "active").length,
          credentials: mine.map((x) => toPublic(x)),
        };
      }),
    });
  });

  app.post("/web/:id/session", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { value?: string; label?: string };
    try {
      const cred = store.addWebSession({
        providerId: id,
        rawValue: String(body.value ?? ""),
        label: body.label ?? null,
      });
      return c.json({ ok: true, added: [{ id: cred.id, name: displayName(cred) }] });
    } catch (err) {
      return errorResponse(c, 400, (err as Error).message, "invalid_request_error", "invalid_session");
    }
  });

  // --------------------------------------------------------------- keys

  /**
   * Add one or many keys for a catalogued provider.
   *
   * Each key is reported individually: one bad paste in a list of ten should
   * not discard the other nine.
   */
  app.post("/:id/keys", async (c) => {
    const id = c.req.param("id");
    const def = providerDef(id);
    if (!def) {
      return errorResponse(c, 404, `Unknown provider "${id}".`, "invalid_request_error", "not_found");
    }

    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown; label?: string };
    const keys = splitKeys(body.keys);
    if (keys.length === 0) {
      return errorResponse(c, 400, "No keys supplied.", "invalid_request_error", "empty");
    }
    if (!def.multiKey && keys.length > 1) {
      return errorResponse(
        c,
        400,
        `${def.label} accepts one key at a time.`,
        "invalid_request_error",
        "single_key_only",
      );
    }

    const added: Array<{ id: number; name: string }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];

    for (const key of keys) {
      try {
        const cred = store.addProviderKey(id, key, keys.length === 1 ? body.label : null);
        added.push({ id: cred.id, name: displayName(cred) });
      } catch (err) {
        // Only ever echo the tail of a key, never the key.
        skipped.push({ key: `…${key.slice(-6)}`, reason: (err as Error).message });
      }
    }

    log.info("provider_keys_added", { provider: id, added: added.length, skipped: skipped.length });
    return c.json({ ok: added.length > 0, added, skipped });
  });

  /**
   * Register a custom OpenAI-compatible endpoint.
   *
   * The URL is auto-detected rather than trusted: people paste the dashboard
   * page they copied the key from, and storing that verbatim produces 405s on
   * every request. Detection also harvests the model list when the endpoint
   * has one.
   */
  app.post("/custom", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: unknown;
      /** Skip detection and store the URL exactly as given. */
      exact?: boolean;
    };

    const given = String(body.baseUrl ?? "").trim();
    const apiKey = String(body.apiKey ?? "");
    let models = splitKeys(body.models);
    let baseUrl = given;
    let detection: DetectionResult | null = null;

    if (!body.exact) {
      detection = await detectEndpoint(given, apiKey, { model: models[0] ?? null });
      if (!detection.ok) {
        return c.json(
          {
            ok: false,
            error: { message: detection.message, type: "invalid_request_error", code: "endpoint_not_found" },
            detection,
          },
          400,
        );
      }
      baseUrl = detection.baseUrl!;
      // Only adopt discovered models when the user did not name any.
      if (models.length === 0) models = detection.models;
    }

    try {
      const cred = store.addCustomProvider(String(body.name ?? ""), baseUrl, apiKey, models);
      return c.json({
        ok: true,
        added: [{ id: cred.id, name: displayName(cred) }],
        skipped: [],
        detection,
        baseUrl,
      });
    } catch (err) {
      return errorResponse(c, 400, (err as Error).message, "invalid_request_error", "invalid_provider");
    }
  });

  /**
   * Re-detect the endpoint for an existing credential and correct it in place.
   * Repairs rows saved before detection existed, without losing the key.
   */
  app.post("/credentials/:credId/redetect", async (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    const cred = Number.isFinite(id) ? store.get(id) : null;
    if (!cred) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }

    const detection = await detectEndpoint(cred.baseUrl ?? "", cred.accessToken ?? "", {
      model: cred.customModels?.[0] ?? null,
    });
    if (!detection.ok) return c.json({ ok: false, detection }, 400);

    store.setBaseUrl(cred.id, detection.baseUrl!);
    if (detection.models.length) store.setCustomModels(cred.id, detection.models);
    // Remember the protocol so every later request is framed correctly.
    if (detection.protocol) store.setProtocol(cred.id, detection.protocol);

    return c.json({
      ok: true,
      from: cred.baseUrl,
      to: detection.baseUrl,
      models: detection.models.length,
      detection,
    });
  });

  /**
   * Set the model used to validate a credential.
   *
   * Mirrors OmniRoute's "Validation Model" field: blank means "use the
   * provider's first available model".
   */
  app.post("/credentials/:credId/validation-model", async (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    if (!Number.isFinite(id)) {
      return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    }
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    if (!store.setValidationModel(id, String(body.model ?? ""))) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }
    return c.json({ ok: true, credential: toPublic(store.get(id)!) });
  });

  /** Every model this credential offers, with its last probe result. */
  app.get("/credentials/:credId/models", (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    const cred = Number.isFinite(id) ? store.get(id) : null;
    if (!cred) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }

    const declared = cred.customModels?.length
      ? cred.customModels
      : (providerDef(cred.providerId)?.defaultModels ?? []);

    return c.json({
      credential: { id: cred.id, name: displayName(cred), provider: cred.providerId },
      models: declared.map((m) => ({
        id: m,
        excluded: cred.excludedModels.includes(m),
        free: looksFree(m, cred.providerId),
        cooldownUntil: cred.modelCooldowns[m] ?? null,
        stat: cred.modelStats[m] ?? null,
      })),
    });
  });

  /**
   * Re-read one credential's quota position, without spending a request.
   *
   * No provider in the pool publishes "you have N requests left" — the only
   * quota signal any of them gives is a 429 carrying a reset timestamp. So
   * this reports what is actually knowable: whether the cooldown has expired,
   * how long until the next one does, and how many of this credential's models
   * are servable right now. Inventing a percentage would be a nicer number and
   * a false one.
   */
  app.post("/credentials/:credId/refresh", (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    if (!Number.isFinite(id) || !store.get(id)) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }

    const at = now();
    // Anything whose reset time has passed comes back into rotation here, so
    // the button genuinely refreshes rather than only re-reading.
    store.wakeExpired(at);

    const cred = store.get(id)!;
    const declared = cred.customModels?.length
      ? cred.customModels
      : (providerDef(cred.providerId)?.defaultModels ?? []);
    const chat = declared.filter((m) => isChatModel(m));

    const cooling = chat
      .filter((m) => (cred.modelCooldowns[m] ?? 0) > at)
      .map((m) => ({ model: m, until: cred.modelCooldowns[m]!, inSeconds: cred.modelCooldowns[m]! - at }));

    const ready = chat.filter((m) => canServe(cred, m));
    // The soonest moment anything about this credential changes on its own.
    const nextRecovery = [
      cred.cooldownUntil && cred.cooldownUntil > at ? cred.cooldownUntil : null,
      ...cooling.map((x) => x.until),
    ].filter((t): t is number => t !== null);

    return c.json({
      credential: {
        id: cred.id,
        name: displayName(cred),
        provider: cred.providerId,
        state: cred.state,
        effectiveState: effectiveState(cred, at),
      },
      now: at,
      // null means "nothing is cooling" — not "unknown".
      cooldownUntil: cred.cooldownUntil,
      resetsAt: cred.resetsAt,
      resetInSeconds: cred.resetsAt && cred.resetsAt > at ? cred.resetsAt - at : null,
      nextRecoveryAt: nextRecovery.length ? Math.min(...nextRecovery) : null,
      models: { total: chat.length, ready: ready.length, cooling: cooling.length },
      coolingModels: cooling.sort((a, b) => a.inSeconds - b.inSeconds).slice(0, 20),
      requestCount: cred.requestCount,
      successCount: cred.successCount,
      errorCount: cred.errorCount,
      lastError: cred.lastError,
      lastErrorAt: cred.lastErrorAt,
      lastUsedAt: cred.lastUsedAt,
    });
  });

  /**
   * Probe every model on one credential, one at a time.
   *
   * This is the "test all models" pass: it tells you which of a provider's
   * few hundred ids your key can actually use, rather than assuming the
   * catalogue is accurate.
   */
  app.post("/credentials/:credId/models/test", async (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    const cred = Number.isFinite(id) ? store.get(id) : null;
    if (!cred) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }

    const body = (await c.req.json().catch(() => ({}))) as { models?: string[]; limit?: number };
    const declared = cred.customModels?.length
      ? cred.customModels
      : (providerDef(cred.providerId)?.defaultModels ?? []);

    // A provider with 337 models would otherwise be one very long request.
    const limit = Math.min(Number(body.limit) || 40, 120);
    // Skip image, audio, embedding and agent-only ids unless explicitly named.
    // Probing them spends quota to prove something already known: they answer
    // "this model only supports the Interactions API", every time.
    const pool = body.models?.length
      ? body.models
      : declared.filter((m) => isChatModel(m));
    const target = pool.filter((m) => !cred.excludedModels.includes(m)).slice(0, limit);

    /*
     * Fan out rather than walking the list.
     *
     * Serially, forty models at a couple of seconds each is a minute and a
     * half of the user staring at a spinner. The cap keeps us from opening
     * forty sockets to one provider and being rate-limited for the trouble —
     * which would fail models that are actually fine.
     */
    const CONCURRENCY = 6;
    const results: Array<{ model: string; ok: boolean; latencyMs: number; ts: number; error?: string }> =
      new Array(target.length);

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= target.length) return;
        const model = target[i]!;
        const r = await testCredential(cfg, store, router, id, model);
        const stat = {
          ok: r.ok,
          latencyMs: r.latencyMs,
          ts: Math.floor(Date.now() / 1000),
          ...(r.ok ? {} : { error: r.message ?? r.code ?? "failed" }),
        };
        store.setModelStat(id, model, stat);
        results[i] = { model, ...stat };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, target.length) }, worker));

    const passed = results.filter((r) => r.ok).length;
    return c.json({
      tested: results.length,
      passed,
      failed: results.length - passed,
      skipped: Math.max(0, declared.length - target.length),
      results,
    });
  });

  /** Hide every model whose last probe failed. */
  app.post("/credentials/:credId/models/prune", (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    if (!Number.isFinite(id)) {
      return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    }
    const removed = store.excludeFailedModels(id);
    return c.json({ ok: true, removed: removed.length, models: removed });
  });

  /** Advanced per-connection settings. */
  app.post("/credentials/:credId/advanced", async (c) => {
    const id = Number.parseInt(c.req.param("credId") ?? "", 10);
    if (!Number.isFinite(id)) {
      return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const list = (v: unknown) =>
      typeof v === "string"
        ? v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)
        : Array.isArray(v)
          ? v.map(String)
          : undefined;

    try {
      const updated = store.updateAdvanced(id, {
        ...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
        ...(body.excludedModels !== undefined ? { excludedModels: list(body.excludedModels) } : {}),
        ...(body.routingTags !== undefined ? { routingTags: list(body.routingTags) } : {}),
        ...(body.customUserAgent !== undefined
          ? { customUserAgent: String(body.customUserAgent) }
          : {}),
        ...(body.perModelQuota !== undefined ? { perModelQuota: Boolean(body.perModelQuota) } : {}),
        ...(body.customModels !== undefined ? { customModels: list(body.customModels) } : {}),
      });
      if (!updated) {
        return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
      }
      return c.json({ ok: true, credential: toPublic(updated) });
    } catch (err) {
      return errorResponse(c, 400, (err as Error).message, "invalid_request_error", "invalid_setting");
    }
  });

  /**
   * Check a session credential without saving it.
   *
   * Mirrors OmniRoute's "Check cookie": paste a value, find out whether the
   * provider accepts it, then decide whether to keep it.
   */
  app.post("/web/:id/check", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    return c.json(await checkWebSession(id, String(body.value ?? "")));
  });

  /** Probe a URL without saving anything, so the form can show a preview. */
  app.post("/detect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string; apiKey?: string };
    return c.json(await detectEndpoint(String(body.baseUrl ?? ""), String(body.apiKey ?? "")));
  });

  // -------------------------------------------------------------- testing

  /**
   * Probe every credential belonging to one provider.
   *
   * Sequential on purpose: firing a pile of keys at one host simultaneously
   * from one IP is the pattern that gets a batch of accounts flagged.
   */
  app.post("/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!providerDef(id)) {
      return errorResponse(c, 404, `Unknown provider "${id}".`, "invalid_request_error", "not_found");
    }

    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    const mine = store.all().filter((x) => x.providerId === id);

    const results = [];
    for (const cred of mine) {
      results.push(await testCredential(cfg, store, router, cred.id, body.model));
    }

    const passed = results.filter((r) => r.ok).length;
    return c.json({
      provider: id,
      tested: results.length,
      passed,
      failed: results.length - passed,
      results,
    });
  });

  /**
   * Probe the whole pool, grouped by provider.
   *
   * This is what turns "I pasted ten keys" into "these seven work". The client
   * gets per-credential detail so it can show which key to remove.
   */
  app.post("/test-all", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    const byProvider = new Map<string, Awaited<ReturnType<typeof testCredential>>[]>();

    for (const cred of store.all()) {
      const result = await testCredential(cfg, store, router, cred.id, body.model);
      const list = byProvider.get(cred.providerId) ?? [];
      list.push(result);
      byProvider.set(cred.providerId, list);
    }

    const providers = [...byProvider.entries()].map(([id, results]) => ({
      id,
      label: providerDef(id)?.label ?? id,
      tested: results.length,
      passed: results.filter((r) => r.ok).length,
      results,
    }));

    const tested = providers.reduce((n, p) => n + p.tested, 0);
    const passed = providers.reduce((n, p) => n + p.passed, 0);
    return c.json({ tested, passed, failed: tested - passed, providers });
  });

  /**
   * Live model list for a provider, straight from its own endpoint, filtered
   * to what the pool can actually route.
   */
  app.get("/:id/models", async (c) => {
    const id = c.req.param("id");
    const def = providerDef(id);
    if (!def) {
      return errorResponse(c, 404, `Unknown provider "${id}".`, "invalid_request_error", "not_found");
    }

    const cred = store.all().find((x) => x.providerId === id && x.accessToken);
    if (!cred || !def.listsModels) return c.json({ models: [], source: "unavailable" });

    const base = (cred.baseUrl || def.baseUrl).replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${cred.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // Say why. A bare "error" sends you guessing between a wrong URL, a
        // rejected key and an endpoint that simply has no /models route.
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        return c.json({
          models: [],
          source: "error",
          status: res.status,
          message: `${base}/models returned HTTP ${res.status}. ${detail}`.trim(),
        });
      }

      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? [])
        .map((m) => String(m.id ?? "").replace(/^models\//, ""))
        .filter(Boolean)
        .filter((m) => canServe(cred, m))
        .sort();

      // Persist against every credential of this provider when asked, so the
      // discovered list drives both the picker and routing from now on.
      if (c.req.query("save") === "1" && models.length) {
        for (const x of store.all().filter((y) => y.providerId === id)) {
          store.setCustomModels(x.id, models);
        }
      }
      return c.json({ models, source: "live", saved: c.req.query("save") === "1" });
    } catch (err) {
      log.debug("provider_models_failed", { provider: id, err });
      return c.json({
        models: [],
        source: "error",
        message: `Could not reach ${base}/models — ${(err as Error).message}`,
      });
    }
  });

  const credentialId = (c: Context): number | null => {
    const n = Number.parseInt(c.req.param("credId") ?? "", 10);
    return Number.isFinite(n) ? n : null;
  };

  /** Drop every credential of a provider that failed its last probe. */
  app.post("/:id/prune", async (c) => {
    const id = c.req.param("id");
    const mine = store.all().filter((x) => x.providerId === id && x.state === "dead");
    for (const cred of mine) store.remove(cred.id);
    return c.json({ ok: true, removed: mine.length });
  });

  app.delete("/:id/credentials/:credId", (c) => {
    const cid = credentialId(c);
    if (cid === null) return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    return c.json({ ok: store.remove(cid) });
  });

  return app;
}
