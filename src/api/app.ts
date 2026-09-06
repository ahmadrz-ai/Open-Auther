/**
 * HTTP surface assembly.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import { ChatStore } from "../chat/store.js";
import { buildCatalogue } from "../core/catalogue.js";
import { CavemanHistory } from "../compress/history.js";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { createLogger } from "../logging.js";
import type { CredentialStore } from "../pool/store.js";
import { Router } from "../router.js";
import { chatUiRoutes } from "./chatui.js";
import { providerRoutes } from "./providers.js";
import { adminRoutes, buildStatus } from "./admin.js";
import { gatewayAuth } from "./auth.js";
import { chatCompletionsHandler } from "./chat.js";
import { messagesRoutes, registerHelloProbe } from "./messages.js";
import { errorResponse } from "./errors.js";
import { LoginSessions } from "./oauth.js";
import { checkForUpdate } from "../core/update.js";

const log = createLogger({ mod: "http" });

/**
 * Paths that exist in the OpenAI API but cannot be served by the Codex
 * backend. They are registered deliberately: a client probing for capabilities
 * gets a clear, well-formed answer instead of a bare 404 that reads like a
 * gateway misconfiguration.
 */
const UNSUPPORTED: Array<{ path: string; method: "get" | "post" | "delete" }> = [
  { path: "/v1/completions", method: "post" },
  { path: "/v1/responses", method: "post" },
  { path: "/v1/embeddings", method: "post" },
  { path: "/v1/moderations", method: "post" },
  { path: "/v1/images/generations", method: "post" },
  { path: "/v1/images/edits", method: "post" },
  { path: "/v1/images/variations", method: "post" },
  { path: "/v1/audio/speech", method: "post" },
  { path: "/v1/audio/transcriptions", method: "post" },
  { path: "/v1/audio/translations", method: "post" },
  { path: "/v1/files", method: "post" },
  { path: "/v1/files", method: "get" },
  { path: "/v1/fine_tuning/jobs", method: "post" },
  { path: "/v1/assistants", method: "post" },
  { path: "/v1/batches", method: "post" },
];

const UNSUPPORTED_MESSAGE =
  "This endpoint is not supported. ai-auther routes to the ChatGPT/Codex backend, " +
  "which serves chat-style completions only. Use /v1/chat/completions.";

function uiRoot(): string {
  // dist/api/app.js -> dist/ui
  const entry = typeof __filename === "string" ? __filename : process.argv[1] ?? process.cwd();
  const here = dirname(entry);
  const candidates = [
    join(here, "ui"),
    join(here, "..", "ui"),
    join(here, "..", "src", "ui"),
    join(here, "..", "..", "src", "ui"),
    join(process.cwd(), "dist", "ui"),
    join(process.cwd(), "src", "ui"),
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? candidates[0]!;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function createApp(cfg: Config, store: CredentialStore, db: Database): Hono {
  const app = new Hono();
  const router = new Router(cfg, store);

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    // Path only, never the query string.
    log.debug("request", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - started,
      client: c.get("clientName") ?? null,
    });
  });

  // Local-first tools get opened from browser pages; allow it, but never
  // reflect credentials into CORS-exposed headers.
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "authorization, content-type, x-api-key");
    c.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  // ------------------------------------------------------------- unauthed
  /*
   * Connection-warming probe from the Claude clients, sent before any
   * credential is presented. Answering it costs nothing and its absence shows
   * up as a confusing failure during setup.
   */
  registerHelloProbe(app);

  app.get("/health", (c) => {
    const s = buildStatus(cfg, store).summary;
    return c.json({
      status: s.active > 0 ? "ok" : s.total === 0 ? "no_credentials" : "exhausted",
      credentials: { total: s.total, active: s.active, cooling: s.cooling, dead: s.dead },
      nextRecoveryAt: s.nextRecoveryAt,
    });
  });

  // --------------------------------------------------------------- authed
  app.use("/v1/*", gatewayAuth(cfg));
  app.use("/admin/*", gatewayAuth(cfg));

  app.get("/admin/update", async (c) => c.json(await checkForUpdate()));

  const cavemanHistory = new CavemanHistory(db);
  app.post("/v1/chat/completions", chatCompletionsHandler(cfg, router, store, cavemanHistory));

  /*
   * The Anthropic Messages surface, for Claude Code and the Claude desktop
   * app's third-party inference mode. Mounted at the root because those
   * clients post to `/v1/messages?beta=true` and the path is what matters.
   */
  app.route("/", messagesRoutes(cfg, store, router));

  /*
   * Every model the pool can actually serve, not a hand-maintained list.
   *
   * The old version returned `cfg.models`, which is why a pool holding several
   * hundred models across five providers advertised seven Gemini ids.
   * `auto`, `fast` and `quality` lead the list.
   */
  const listModels = (c: Context) => {
    const created = Math.floor(Date.now() / 1000);
    const entries = buildCatalogue(store.all(), {
      freeOnly: cfg.freeModelsOnly,
      includeVirtual: true,
    });

    return c.json({
      object: "list",
      data: entries.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: m.virtual ? "open-auther" : m.providers.join(","),
        // Non-standard, but harmless to clients and useful in a browser.
        ...(m.description ? { description: m.description } : {}),
      })),
    });
  };

  app.get("/v1/models", listModels);
  /*
   * Served at the doubled prefix too: a client given `http://host:port/v1` as
   * its base appends `/v1/models` and asks for `/v1/v1/models`. The banner
   * advertises that base for OpenAI clients, so the mistake is easy to make
   * and its only symptom is a 404 during model discovery.
   */
  app.get("/v1/v1/models", listModels);

  app.get("/v1/models/:model", (c) => {
    const id = c.req.param("model");
    const known = buildCatalogue(store.all(), {
      freeOnly: cfg.freeModelsOnly,
      includeVirtual: true,
    }).map((m) => m.id);
    if (!known.includes(id)) {
      return errorResponse(
        c,
        404,
        `Model "${id}" is not available. ${known.length} models are; see GET /v1/models.`,
        "invalid_request_error",
        "model_not_found",
      );
    }
    return c.json({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "openai" });
  });

  for (const { path, method } of UNSUPPORTED) {
    app[method](path, (c) =>
      errorResponse(c, 501, UNSUPPORTED_MESSAGE, "invalid_request_error", "unsupported_endpoint"),
    );
  }

  app.route(
    "/admin",
    adminRoutes(cfg, store, new LoginSessions(cfg, store), router, cavemanHistory),
  );
  app.route("/admin/chat", chatUiRoutes(cfg, store, new ChatStore(db), router));
  app.route("/admin/providers", providerRoutes(cfg, store, router));

  // ------------------------------------------------------------------- UI
  if (cfg.ui) {
    const root = uiRoot();

    const serve = (file: string) => {
      const full = normalize(join(root, file));
      // Defence in depth against traversal, even though `file` is a fixed set.
      if (!full.startsWith(normalize(root))) return null;
      if (!existsSync(full)) return null;
      const ext = full.slice(full.lastIndexOf("."));
      return { body: readFileSync(full), type: MIME[ext] ?? "application/octet-stream" };
    };

    const page = (c: import("hono").Context) => {
      const asset = serve("index.html");
      if (!asset) return c.text("UI assets missing. Run `npm run build`.", 500);
      c.header("cache-control", "no-store, must-revalidate");
      return c.html(asset.body.toString("utf8"));
    };

    app.get("/", page);
    app.get("/omni", page);

    app.get("/assets/:file", (c) => {
      const file = c.req.param("file");
      const asset = serve(file) ?? serve(`assets/${file}`);
      if (!asset) return c.notFound();
      c.header("content-type", asset.type);
      // `no-store`, not `no-cache`: these are a handful of small local files,
      // and `no-cache` without a validator left browsers serving a stale
      // module after an upgrade — which looks exactly like a broken feature.
      c.header("cache-control", "no-store, must-revalidate");
      return c.body(asset.body);
    });
  }

  app.notFound((c) =>
    errorResponse(
      c,
      404,
      `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
      "invalid_request_error",
      "not_found",
    ),
  );

  app.onError((err, c) => {
    log.error("unhandled", { err });
    return errorResponse(
      c,
      500,
      "Internal gateway error.",
      "api_error",
      "internal_error",
    );
  });

  return app;
}
