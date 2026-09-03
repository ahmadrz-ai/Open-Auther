/**
 * Operational endpoints backing the dashboard.
 *
 * Everything here sits behind the gateway key. Nothing here ever emits token
 * material: `toPublic` is the only credential shape that leaves the process,
 * and gateway keys are returned only where the UI genuinely needs to display
 * them (the API Keys page, on the machine that owns them).
 */

import { hostname, platform, totalmem, freemem, cpus } from "node:os";
import { Hono, type Context } from "hono";
import packageJson from "../../package.json";
import { streamSSE } from "hono/streaming";
import {
  addGatewayKey,
  removeGatewayKey,
  updateCaveman,
  updateModelCapabilities,
  updateSettings,
  type CavemanConfig,
  type Config,
} from "../config.js";
import { capabilitiesFor } from "../core/capabilities.js";
import { mergeDiscovered } from "../core/model-metadata.js";
import { buildCatalogue } from "../core/catalogue.js";
import { listModels, testConnection } from "../compress/caveman.js";
import type { CavemanHistory } from "../compress/history.js";
import { now } from "../db.js";
import { toPublic, type CredentialStore } from "../pool/store.js";
import type { PoolEvent } from "../pool/types.js";
import type { Router } from "../router.js";
import { errorResponse } from "./errors.js";
import type { LoginSessions } from "./oauth.js";
import { testAllCredentials, testCredential } from "./testconn.js";

const STARTED_AT = Date.now();
export const VERSION = packageJson.version;

export interface PoolSummary {
  total: number;
  active: number;
  cooling: number;
  dead: number;
  nextRecoveryAt: number | null;
  requestsServed: number;
  tokensServed: number;
}

export function buildStatus(cfg: Config, store: CredentialStore) {
  const at = now();
  store.wakeExpired(at);

  const creds = store.all().map((c) => toPublic(c, at));
  const summary: PoolSummary = {
    total: creds.length,
    active: creds.filter((c) => c.effectiveState === "active").length,
    cooling: creds.filter((c) => c.effectiveState === "cooling").length,
    dead: creds.filter((c) => c.effectiveState === "dead").length,
    nextRecoveryAt: store.earliestRecovery(at),
    requestsServed: creds.reduce((n, c) => n + c.requestCount, 0),
    tokensServed: creds.reduce((n, c) => n + c.tokenCount, 0),
  };

  return {
    now: at,
    gateway: {
      version: VERSION,
      rotation: cfg.rotation,
      maxAttempts: cfg.maxAttempts,
      models: cfg.models,
      defaultModel: cfg.defaultModel,
      clients: cfg.gatewayKeys.map((k) => k.name),
      host: cfg.host,
      port: cfg.port,
      baseUrl: `http://${cfg.host}:${cfg.port}/v1`,
      caveman: { enabled: cfg.caveman.enabled, model: cfg.caveman.model },
    },
    summary,
    credentials: creds,
  };
}

function bad(c: Context, err: unknown) {
  return errorResponse(c, 400, (err as Error).message, "invalid_request_error", "invalid_setting");
}

export function adminRoutes(
  cfg: Config,
  store: CredentialStore,
  sessions: LoginSessions,
  router: Router,
  history: CavemanHistory,
): Hono {
  const app = new Hono();

  const credentialId = (c: Context): number | null => {
    const n = Number.parseInt(c.req.param("id") ?? "", 10);
    return Number.isFinite(n) ? n : null;
  };

  // ------------------------------------------------------------- status

  app.get("/status", (c) => c.json(buildStatus(cfg, store)));
  app.get("/events", (c) => c.json({ events: store.recentEvents(200) }));

  /** Server-sent stream powering the live graph and feed. */
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const send = async (event: string, data: unknown) => {
        if (!open) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          open = false;
        }
      };

      await send("status", buildStatus(cfg, store));

      const onEvent = (ev: PoolEvent) => void send("event", ev);
      const onChange = () => void send("status", buildStatus(cfg, store));

      store.on("event", onEvent);
      store.on("change", onChange);

      const heartbeat = setInterval(() => void send("status", buildStatus(cfg, store)), 5000);

      const cleanup = () => {
        open = false;
        clearInterval(heartbeat);
        store.off("event", onEvent);
        store.off("change", onChange);
      };

      c.req.raw.signal?.addEventListener("abort", cleanup, { once: true });
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!open || c.req.raw.signal?.aborted) {
            clearInterval(check);
            cleanup();
            resolve();
          }
        }, 1000);
      });
    }),
  );

  // -------------------------------------------------------- credentials

  app.get("/credentials", (c) => c.json({ credentials: store.all().map((x) => toPublic(x)) }));

  app.post("/credentials/:id/rename", async (c) => {
    const id = credentialId(c);
    if (id === null) return errorResponse(c, 400, "Invalid credential id.", "invalid_request_error");
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!store.rename(id, String(body.name ?? ""))) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }
    return c.json({ ok: true, credential: toPublic(store.get(id)!) });
  });

  app.post("/credentials/:id/revive", (c) => {
    const id = credentialId(c);
    if (id === null) return errorResponse(c, 400, "Invalid credential id.", "invalid_request_error");
    if (!store.revive(id)) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }
    return c.json({ ok: true, credential: toPublic(store.get(id)!) });
  });

  app.post("/credentials/:id/cool", async (c) => {
    const id = credentialId(c);
    if (id === null) return errorResponse(c, 400, "Invalid credential id.", "invalid_request_error");
    if (!store.get(id)) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }
    const body = (await c.req.json().catch(() => ({}))) as { seconds?: number };
    const seconds = Number.isFinite(body.seconds) ? Number(body.seconds) : 3600;
    store.markCooling(id, now() + seconds, "manual_cooldown");
    return c.json({ ok: true, credential: toPublic(store.get(id)!) });
  });

  app.delete("/credentials/:id", (c) => {
    const id = credentialId(c);
    if (id === null) return errorResponse(c, 400, "Invalid credential id.", "invalid_request_error");
    if (!store.remove(id)) {
      return errorResponse(c, 404, "No such credential.", "invalid_request_error", "not_found");
    }
    return c.json({ ok: true });
  });

  /**
   * Live connection test: sends a real prompt through this one Auth. Costs a
   * request from its quota, which is why it is never run automatically.
   */
  app.post("/credentials/:id/test", async (c) => {
    const id = credentialId(c);
    if (id === null) return errorResponse(c, 400, "Invalid credential id.", "invalid_request_error");
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    return c.json(await testCredential(cfg, store, router, id, body.model));
  });

  app.post("/credentials/test-all", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    return c.json({ results: await testAllCredentials(cfg, store, router, body.model) });
  });

  app.get("/diag-test", async (c) => {
    const results = [];
    for (const cred of store.all()) {
      const item: Record<string, unknown> = {
        id: cred.id,
        email: cred.email,
        planType: cred.planType,
        state: cred.state,
        accountId: cred.accountId,
      };

      // Test 1: api.openai.com
      try {
        const res1 = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${cred.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        const text1 = await res1.text().catch(() => "");
        item.platformApi = { status: res1.status, statusText: res1.statusText, body: text1 };
      } catch (err) {
        item.platformApi = { error: (err as Error).message };
      }

      // Test 2: chatgpt.com codex
      try {
        const h: Record<string, string> = {
          authorization: `Bearer ${cred.accessToken}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          "user-agent": "open-auther",
        };
        if (cred.accountId) h["chatgpt-account-id"] = cred.accountId;

        const res2 = await fetch("https://chatgpt.com/backend-api/codex/responses", {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            model: "gpt-4o",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            stream: true,
            include: [],
          }),
        });
        const text2 = await res2.text().catch(() => "");
        item.codexWeb = { status: res2.status, statusText: res2.statusText, body: text2.slice(0, 500) };
      } catch (err) {
        item.codexWeb = { error: (err as Error).message };
      }

      results.push(item);
    }
    return c.json({ ok: true, diagnostics: results });
  });

  // ------------------------------------------------------ onboarding

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; provider?: string };
    const name = body.name?.trim() || null;
    // Both OAuth flows share this route and the polling contract; only the
    // provider differs.
    const session =
      body.provider === "antigravity" ? sessions.startAntigravity(name) : sessions.start(name);
    return c.json({ ok: true, ...session });
  });

  app.get("/auth/login/:id", (c) => {
    const status = sessions.status(c.req.param("id"));
    if (!status) {
      return errorResponse(c, 404, "No such login session.", "invalid_request_error", "not_found");
    }
    return c.json(status);
  });

  app.post("/auth/login/:id/cancel", (c) =>
    c.json({ ok: sessions.cancel(c.req.param("id")) }),
  );

  /** Import credentials pasted or uploaded through the dashboard. */
  app.post("/auth/import", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { payload?: unknown; name?: string } | null;
    if (!body?.payload) {
      return errorResponse(c, 400, "Nothing to import.", "invalid_request_error", "empty_payload");
    }

    const { importCredentials } = await import("../core/import.js");
    try {
      const result = importCredentials(store, body.payload, body.name ?? null);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return bad(c, err);
    }
  });

  /** Add single or bulk Gemini API Keys. */
  app.post("/auth/gemini", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; keys?: string[]; label?: string };
    const rawKeys = body.keys || (body.apiKey ? [body.apiKey] : []);
    const cleanKeys = rawKeys.map((k) => k.trim()).filter(Boolean);

    if (cleanKeys.length === 0) {
      return errorResponse(c, 400, "At least one Gemini API key is required.", "invalid_request_error", "missing_api_key");
    }

    const added = [];
    for (let i = 0; i < cleanKeys.length; i++) {
      const k = cleanKeys[i]!;
      const lbl = cleanKeys.length === 1 && body.label ? body.label : `Gemini Key #${store.all().length + 1}`;
      const cred = store.addGeminiKey(k, lbl);
      added.push(toPublic(cred));
    }
    return c.json({ ok: true, count: added.length, added });
  });

  /** Add a Custom OpenAI-compatible Provider. */
  app.post("/auth/custom", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: string[];
    };
    if (!body.baseUrl?.trim() || !body.apiKey?.trim()) {
      return errorResponse(c, 400, "Base URL and API Key are required for custom provider.", "invalid_request_error", "missing_fields");
    }

    try {
      const cred = store.addCustomProvider(
        body.name || "Custom Provider",
        body.baseUrl,
        body.apiKey,
        body.models,
      );
      return c.json({ ok: true, credential: toPublic(cred) });
    } catch (err) {
      return bad(c, err);
    }
  });

  // ------------------------------------------------------------- keys

  app.get("/keys", (c) =>
    c.json({ keys: cfg.gatewayKeys.map((k) => ({ name: k.name, key: k.key })) }),
  );

  app.post("/keys", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    try {
      return c.json({ ok: true, key: addGatewayKey(cfg, String(body.name ?? "")) });
    } catch (err) {
      return bad(c, err);
    }
  });

  app.delete("/keys/:name", (c) => {
    try {
      const removed = removeGatewayKey(cfg, c.req.param("name"));
      if (!removed) {
        return errorResponse(c, 404, "No such key.", "invalid_request_error", "not_found");
      }
      return c.json({ ok: true });
    } catch (err) {
      return bad(c, err);
    }
  });

  // ------------------------------------------------------------- logs

  app.get("/logs", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "200", 10);
    const outcome = c.req.query("outcome") ?? undefined;
    const credential = c.req.query("credential");
    return c.json({
      logs: store.recentLogs({
        limit: Number.isFinite(limit) ? limit : 200,
        outcome,
        credentialId: credential ? Number(credential) : undefined,
      }),
    });
  });

  // ---------------------------------------------------------- monitor

  app.get("/stats", (c) => {
    const windowHours = Number.parseInt(c.req.query("hours") ?? "24", 10);
    const hours = Number.isFinite(windowHours) ? Math.min(Math.max(windowHours, 1), 720) : 24;
    return c.json({ windowHours: hours, ...store.stats(now() - hours * 3600) });
  });

  // ----------------------------------------------------------- health

  app.get("/health/detail", (c) => {
    const at = now();
    const creds = store.all().map((x) => toPublic(x, at));
    const recent = store.recentLogs({ limit: 200 });
    const errors = recent.filter((l) => l.outcome === "error").length;

    return c.json({
      now: at,
      gateway: {
        status: creds.some((x) => x.effectiveState === "active")
          ? "ok"
          : creds.length === 0
            ? "no_credentials"
            : "exhausted",
        errorRate: recent.length ? errors / recent.length : 0,
        sampleSize: recent.length,
      },
      caveman: {
        enabled: cfg.caveman.enabled,
        configured: Boolean(cfg.caveman.baseUrl && cfg.caveman.model),
        model: cfg.caveman.model || null,
      },
      credentials: creds.map((x) => ({
        id: x.id,
        name: x.name,
        state: x.effectiveState,
        needsRefresh: x.needsRefresh,
        resetsAt: x.resetsAt,
        cooldownUntil: x.cooldownUntil,
        errorCount: x.errorCount,
        successCount: x.successCount,
        lastError: x.lastError,
        lastUsedAt: x.lastUsedAt,
      })),
    });
  });

  // ---------------------------------------------------------- runtime

  app.get("/runtime", (c) => {
    const mem = process.memoryUsage();
    return c.json({
      version: VERSION,
      node: process.version,
      platform: platform(),
      host: hostname(),
      pid: process.pid,
      cpus: cpus().length,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        systemTotalBytes: totalmem(),
        systemFreeBytes: freemem(),
      },
      paths: { home: cfg.home, database: cfg.dbPath, config: cfg.configPath },
      listening: { host: cfg.host, port: cfg.port },
    });
  });

  // --------------------------------------------------------- settings

  app.get("/settings", (c) =>
    c.json({
      rotation: cfg.rotation,
      maxAttempts: cfg.maxAttempts,
      defaultCooldownSeconds: cfg.defaultCooldownSeconds,
      refreshSkewSeconds: cfg.refreshSkewSeconds,
      requestTimeoutMs: cfg.requestTimeoutMs,
      host: cfg.host,
      port: cfg.port,
      logLevel: cfg.logLevel,
      models: cfg.models,
      defaultModel: cfg.defaultModel,
      freeModelsOnly: cfg.freeModelsOnly,
    }),
  );

  /**
   * The catalogue `/v1/models` actually serves.
   *
   * Settings used to render `cfg.models`, a hand-maintained list, while the
   * gateway had long since started deriving the real one from the connections
   * — which is why a pool of several hundred models showed as a few Gemini
   * ids. This is the same call the client-facing endpoint makes.
   */
  app.get("/models/catalogue", (c) => {
    const freeOnly = c.req.query("all") === "1" ? false : cfg.freeModelsOnly;
    const entries = buildCatalogue(store.all(), { freeOnly, includeVirtual: true });

    const byProvider: Record<string, number> = {};
    for (const e of entries) {
      if (e.virtual) continue;
      for (const p of e.providers) byProvider[p] = (byProvider[p] ?? 0) + 1;
    }

    return c.json({
      freeModelsOnly: cfg.freeModelsOnly,
      total: entries.filter((e) => !e.virtual).length,
      // What the free-only filter is currently hiding, so the count is not a
      // silent truncation.
      hiddenPaid:
        buildCatalogue(store.all(), { freeOnly: false }).length -
        buildCatalogue(store.all(), { freeOnly: cfg.freeModelsOnly }).length,
      byProvider,
      models: entries,
    });
  });

  app.post("/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      updateSettings(cfg, body as never);
      return c.json({ ok: true, restartRequired: "host" in body || "port" in body });
    } catch (err) {
      return bad(c, err);
    }
  });

  /**
   * Override the capability table for one model. The built-in table is a
   * curated guess, so this is how you correct it rather than filing a bug.
   */
  app.post("/settings/capabilities/:model", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const model = c.req.param("model");
      updateModelCapabilities(cfg, model, body);
      return c.json({
        ok: true,
        resolved: capabilitiesFor(
          model,
          cfg.modelCapabilities,
          mergeDiscovered(store.all().map((cred) => cred.modelMetadata), model),
        ),
      });
    } catch (err) {
      return bad(c, err);
    }
  });

  // ---------------------------------------------------------- caveman

  app.get("/caveman", (c) =>
    c.json({
      ...cfg.caveman,
      // Never echo the key back. The UI shows whether one is set, not what it is.
      apiKey: undefined,
      apiKeySet: Boolean(cfg.caveman.apiKey),
    }),
  );

  app.post("/caveman", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // An omitted apiKey means "leave it alone", so saving other fields does not
    // wipe a key the UI never displayed.
    if (body.apiKey === undefined || body.apiKey === "") delete body.apiKey;
    try {
      updateCaveman(cfg, body as never);
      return c.json({ ok: true });
    } catch (err) {
      return bad(c, err);
    }
  });

  /** Every compression attempt: what went in, what came out, what happened. */
  app.get("/caveman/history", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const outcome = c.req.query("outcome") || undefined;
    return c.json({
      entries: history.list(Number.isFinite(limit) ? Math.min(limit, 200) : 50, outcome),
      stats: history.stats(),
    });
  });

  app.delete("/caveman/history", (c) => {
    history.clear();
    return c.json({ ok: true });
  });

  app.post("/caveman/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.apiKey === undefined || body.apiKey === "") delete body.apiKey;
    // Test against the submitted values so the button works before saving.
    return c.json(await testConnection({ ...cfg.caveman, ...(body as Partial<CavemanConfig>) }));
  });

  app.post("/caveman/models", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.apiKey === undefined || body.apiKey === "") delete body.apiKey;
    return c.json({ models: await listModels({ ...cfg.caveman, ...(body as Partial<CavemanConfig>) }) });
  });

  return app;
}
