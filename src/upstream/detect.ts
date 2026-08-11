/**
 * Endpoint auto-detection for custom providers.
 *
 * People paste whatever URL they were looking at — the dashboard page where
 * they copied the key, the docs page, the bare domain. One real example:
 * `https://xkiro.com/dashboard/api/keys` was saved as a base URL, so every
 * request went to `…/dashboard/api/keys/chat/completions` and came back 405,
 * while the actual endpoint was `https://api.xkiro.com/v1`.
 *
 * Rather than demand the exact base URL, probe a handful of plausible
 * candidates and keep the first that behaves like an OpenAI-compatible API.
 */

import { createLogger } from "../logging.js";
import type { CustomProtocol } from "../pool/types.js";
import { ANTHROPIC_VERSION } from "./anthropic.js";

const log = createLogger({ mod: "detect" });

export interface DetectionResult {
  ok: boolean;
  /** Normalised base URL that actually answered. */
  baseUrl: string | null;
  /** Models the endpoint reported, when it has a listing route. */
  models: string[];
  /** How we established it: model listing, or a live completion. */
  via: "models" | "chat" | "messages" | null;
  /**
   * Wire protocol the endpoint speaks. NULL when detection could not tell, in
   * which case routing assumes the OpenAI shape as it always did.
   */
  protocol: CustomProtocol | null;
  /** Every candidate tried, with what it did. Shown to the user on failure. */
  attempts: Array<{ url: string; status: number | string; note: string }>;
  message: string;
}

/** Path suffixes an OpenAI-compatible API commonly lives under. */
const PATH_CANDIDATES = ["", "/v1", "/api/v1", "/openai/v1", "/v1/openai"];

/**
 * Build the list of base URLs worth trying, most-likely first.
 *
 * Two axes: the origin (as given, plus an `api.` sibling, since dashboards
 * and APIs are usually split that way) and the path prefix.
 */
export function candidates(raw: string): string[] {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return [];

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return [];
  }

  const origins = new Set<string>([url.origin]);
  const host = url.hostname;
  if (!host.startsWith("api.")) {
    // dashboard.example.com -> api.example.com, example.com -> api.example.com
    const parts = host.split(".");
    const registrable = parts.length > 2 ? parts.slice(-2).join(".") : host;
    origins.add(`${url.protocol}//api.${registrable}`);
  }

  // The supplied path, progressively shortened. A key page like
  // /dashboard/api/keys is worth trying at /dashboard/api and /dashboard too.
  const givenPaths = new Set<string>();
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = segments.length; i >= 0; i--) {
    givenPaths.add("/" + segments.slice(0, i).join("/"));
  }

  const out: string[] = [];
  const push = (base: string, path: string) => {
    const full = `${base}${path === "/" ? "" : path}`.replace(/\/+$/, "");
    if (full && !out.includes(full)) out.push(full);
  };

  // Exact input first — if the user got it right, use it and stop.
  push(url.origin, url.pathname);

  for (const origin of origins) {
    for (const path of PATH_CANDIDATES) push(origin, path);
    for (const path of givenPaths) push(origin, path);
  }
  return out.slice(0, 24);
}

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

const isJson = (res: Response) =>
  (res.headers.get("content-type") ?? "").includes("json");

/** Does `GET {base}/models` look like an OpenAI model listing? */
async function tryModels(
  base: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; models: string[]; status: number | string; note: string }> {
  try {
    const res = await fetch(`${base}/models`, { headers: authHeaders(apiKey), signal });
    if (!res.ok) return { ok: false, models: [], status: res.status, note: res.statusText };

    // A dashboard route happily returns 200 with an HTML page — that is not an
    // API, and accepting it is exactly how the broken URL got saved.
    if (!isJson(res)) return { ok: false, models: [], status: res.status, note: "returned HTML, not JSON" };

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) {
      return { ok: false, models: [], status: res.status, note: "JSON without a data[] array" };
    }
    const models = body.data
      .map((m) => String(m.id ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { ok: true, models, status: res.status, note: `${models.length} models` };
  } catch (err) {
    return { ok: false, models: [], status: "ERR", note: (err as Error).message };
  }
}

/**
 * Does this endpoint speak the Anthropic Messages protocol?
 *
 * Worth a separate probe because the two protocols disagree on everything that
 * matters: route, auth header, and body. An endpoint that 404s
 * `/chat/completions` is not necessarily broken — it may simply be Anthropic
 * shaped, which the OpenAI-only probe reported as "no chat route here".
 */
async function tryMessages(
  base: string,
  apiKey: string,
  model: string | null,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number | string; note: string }> {
  try {
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model ?? "probe-nonexistent-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal,
    });

    if (res.status === 404 || res.status === 405) {
      return { ok: false, status: res.status, note: "no messages route here" };
    }
    if (!isJson(res)) return { ok: false, status: res.status, note: "returned HTML, not JSON" };
    if (res.ok) return { ok: true, status: res.status, note: "Anthropic Messages endpoint" };

    /*
     * A 4xx still identifies the protocol, but only if the error looks
     * Anthropic's. An OpenAI-compatible gateway that happens to 400 on an
     * unknown route would otherwise be misclassified, and every later request
     * would be framed wrongly.
     */
    const body = (await res.json().catch(() => null)) as
      | { type?: string; error?: { type?: string } }
      | null;
    if (body?.type === "error" || body?.error?.type) {
      return { ok: true, status: res.status, note: "spoke Anthropic and returned an error" };
    }
    return { ok: false, status: res.status, note: "not an Anthropic error shape" };
  } catch (err) {
    return { ok: false, status: "ERR", note: (err as Error).message };
  }
}

/**
 * Some endpoints have no `/models` route but serve chat perfectly well.
 *
 * A JSON error is as good a signal as success here: it means something spoke
 * the protocol and rejected our arguments, which is enough to identify the
 * endpoint. HTML or a 405 means we are pointed at the wrong thing.
 */
async function tryChat(
  base: string,
  apiKey: string,
  model: string | null,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number | string; note: string }> {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model: model ?? "probe-nonexistent-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    });

    if (res.status === 405 || res.status === 404) {
      return { ok: false, status: res.status, note: "no chat route here" };
    }
    if (!isJson(res)) return { ok: false, status: res.status, note: "returned HTML, not JSON" };

    // 2xx obviously works. A 4xx with a JSON error body still identifies an
    // OpenAI-compatible endpoint (bad model, bad key, no credit …).
    if (res.ok) return { ok: true, status: res.status, note: "completion succeeded" };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body && "error" in body) {
      return { ok: true, status: res.status, note: "spoke the protocol and returned an error" };
    }
    return { ok: false, status: res.status, note: "unrecognised JSON response" };
  } catch (err) {
    return { ok: false, status: "ERR", note: (err as Error).message };
  }
}

/**
 * Find the real API base URL behind whatever the user pasted.
 *
 * Never throws. On failure the attempt log explains what was tried, which is
 * far more actionable than "invalid URL".
 */
export async function detectEndpoint(
  rawUrl: string,
  apiKey: string,
  opts: { model?: string | null; timeoutMs?: number } = {},
): Promise<DetectionResult> {
  const list = candidates(rawUrl);
  const attempts: DetectionResult["attempts"] = [];

  if (list.length === 0) {
    return {
      ok: false,
      baseUrl: null,
      models: [],
      via: null,
      protocol: null,
      attempts,
      message: `"${rawUrl}" is not a URL.`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);

  try {
    // Pass one: model listings. Cheap, and gives us the model list for free.
    for (const base of list) {
      const r = await tryModels(base, apiKey, controller.signal);
      attempts.push({ url: `${base}/models`, status: r.status, note: r.note });
      if (r.ok) {
        log.info("endpoint_detected", { via: "models", models: r.models.length });
        return {
          ok: true,
          baseUrl: base,
          models: r.models,
          via: "models",
          // A /models listing is an OpenAI convention; Anthropic has none.
          protocol: "openai_chat",
          attempts,
          message: `Detected ${base} — ${r.models.length} models listed.`,
        };
      }
      if (controller.signal.aborted) break;
    }

    // Pass two: a real chat call, for endpoints with no listing route.
    for (const base of list) {
      const r = await tryChat(base, apiKey, opts.model ?? null, controller.signal);
      attempts.push({ url: `${base}/chat/completions`, status: r.status, note: r.note });
      if (r.ok) {
        log.info("endpoint_detected", { via: "chat" });
        return {
          ok: true,
          baseUrl: base,
          models: [],
          via: "chat",
          protocol: "openai_chat",
          attempts,
          message: `Detected ${base} — no model listing, but chat works.`,
        };
      }
      if (controller.signal.aborted) break;
    }

    /*
     * Pass three: the Anthropic Messages protocol.
     *
     * Last because it is the rarer shape, but it has to be tried: an Anthropic
     * endpoint fails both passes above and used to be reported as "not an
     * OpenAI-compatible API", which is true and useless.
     */
    for (const base of list) {
      const r = await tryMessages(base, apiKey, opts.model ?? null, controller.signal);
      attempts.push({ url: `${base}/messages`, status: r.status, note: r.note });
      if (r.ok) {
        log.info("endpoint_detected", { via: "messages", protocol: "anthropic_messages" });
        return {
          ok: true,
          baseUrl: base,
          models: [],
          via: "messages",
          protocol: "anthropic_messages",
          attempts,
          message: `Detected ${base} — Anthropic Messages API.`,
        };
      }
      if (controller.signal.aborted) break;
    }

    return {
      ok: false,
      baseUrl: null,
      models: [],
      via: null,
      protocol: null,
      attempts,
      message:
        `Could not find an OpenAI-compatible or Anthropic API under "${rawUrl}". ` +
        `Tried ${attempts.length} candidates — check the base URL in the provider's own docs ` +
        `(it usually ends in /v1).`,
    };
  } finally {
    clearTimeout(timer);
  }
}
