/**
 * HTTP client for the Codex backend.
 *
 * Credentials travel in headers. Never in a query string: a URL ends up in
 * logs, exception messages, and proxy access logs, and a key placed there
 * leaks everywhere at once.
 */

import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { classifyHttp, classifyTransport, type UpstreamFailure } from "../pool/errors.js";
import type { Credential, ProviderType } from "../pool/types.js";
import { callAntigravity, mapAntigravityEvent } from "./antigravity.js";
import { callKimiWeb, kimiEvents } from "./kimiweb.js";
import { CLIENT_PARAMS, mapCodexEvent, type CodexEvent, type CodexRequest } from "./translate.js";

const log = createLogger({ mod: "upstream" });

export type UpstreamResult =
  | { ok: true; response: Response; sessionId: string }
  | { ok: false; failure: UpstreamFailure };

function isOpenAIPlatform(cfg: Config): boolean {
  return cfg.upstreamBaseUrl.includes("api.openai.com") || (!cfg.upstreamBaseUrl.includes("chatgpt.com") && !cfg.upstreamBaseUrl.includes("codex"));
}

function endpoint(cfg: Config): string {
  const base = cfg.upstreamBaseUrl.replace(/\/+$/, "");
  if (isOpenAIPlatform(cfg)) {
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  return `${base}/responses`;
}

/** Codex endpoint. Only ever reached with a ChatGPT OAuth token. */
function codexEndpoint(cfg: Config): string {
  return `${cfg.codexBaseUrl.replace(/\/+$/, "")}/responses`;
}

/**
 * Convert our internal Responses-shaped body back into a standard Chat
 * Completions payload, for providers that speak the OpenAI wire format
 * (api.openai.com, Gemini's compatibility endpoint, custom providers).
 *
 * Three details here were each getting lost:
 *
 *  - `stream_options.include_usage` is required or these providers send no
 *    usage block at all. Without it every request recorded 0 tokens, which
 *    silently emptied per-Auth accounting and the whole Monitor page.
 *  - `max_tokens` was dropped entirely, so a client's limit was ignored.
 *  - Tools were forwarded in the flat Responses shape. Chat Completions wants
 *    them nested under `function`, so any request with tools was malformed.
 */
function toChatCompletionsBody(body: CodexRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  for (const item of body.input) {
    if (item.type !== "message") continue;
    const parts = item.content as Array<Record<string, unknown>> | undefined;
    const text = parts?.map((p) => p.text ?? "").join("") ?? "";
    messages.push({ role: item.role, content: text });
  }

  const tools = body.tools?.length
    ? body.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }))
    : undefined;

  const params = body[CLIENT_PARAMS];
  return {
    model: body.model,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
    ...(typeof params?.temperature === "number" ? { temperature: params.temperature } : {}),
    ...(typeof params?.top_p === "number" ? { top_p: params.top_p } : {}),
    ...(typeof params?.max_output_tokens === "number"
      ? { max_tokens: params.max_output_tokens }
      : {}),
  };
}

export async function callCodex(
  cfg: Config,
  credential: Credential,
  body: CodexRequest,
  signal: AbortSignal,
): Promise<UpstreamResult> {
  const sessionId = randomUUID();

  // Web-session providers each drive a consumer app's private API, so every
  // one needs its own transport. `providerId` picks which.
  if (credential.providerType === "web_cookie") {
    if (credential.providerId === "kimi-web") {
      const result = await callKimiWeb(credential, body, signal);
      return result.ok ? { ok: true, response: result.response, sessionId } : result;
    }
    return {
      ok: false,
      failure: {
        kind: "terminal",
        status: 501,
        code: "provider_not_implemented",
        message:
          `No transport is implemented for "${credential.providerId}" yet. ` +
          `Remove this connection or use a provider that is supported.`,
        resetsAt: null,
        usageLimited: false,
      },
    };
  }

  // Antigravity speaks Gemini-over-Cloud-Code, which is neither the Codex
  // protocol nor plain Chat Completions, so it gets its own transport.
  if (credential.providerType === "antigravity") {
    const result = await callAntigravity(credential, body, signal);
    return result.ok ? { ok: true, response: result.response, sessionId } : result;
  }

  // If credential is a Gemini API key or Custom OpenAI-compatible Provider
  if (credential.providerType === "gemini" || credential.providerType === "openai_custom") {
    /*
     * Refuse to send an OAuth JWT to an API-key provider.
     *
     * A bad migration once relabelled every ChatGPT OAuth credential as
     * `gemini`, and the gateway happily posted those JWTs to Google, which
     * answered "Please pass a valid API key". The token shape is the ground
     * truth here — a provider label is just a column, and this check means a
     * mislabelled row fails loudly instead of leaking a ChatGPT credential to
     * an unrelated third party.
     */
    if (credential.accessToken?.split(".").length === 3) {
      return {
        ok: false,
        failure: {
          kind: "terminal",
          status: 400,
          code: "provider_type_mismatch",
          message:
            `Credential ${credential.id} is marked "${credential.providerType}" but holds an ` +
            `OAuth token, not an API key. It was almost certainly added through the ChatGPT ` +
            `login flow and mislabelled. Remove and re-add it, or correct its provider type.`,
          resetsAt: null,
          usageLimited: false,
        },
      };
    }
    const targetBase = (
      credential.baseUrl ||
      (credential.providerType === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/openai"
        : cfg.upstreamBaseUrl)
    ).replace(/\/+$/, "");

    const targetUrl = targetBase.endsWith("/chat/completions") ? targetBase : `${targetBase}/chat/completions`;

    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "ai-auther",
    };

    const reqBody = toChatCompletionsBody(body);

    let res: Response;
    try {
      res = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        return {
          ok: false,
          failure: {
            kind: "client",
            status: 499,
            code: "client_disconnected",
            message: "client aborted the request",
            resetsAt: null,
            usageLimited: false,
          },
        };
      }
      return { ok: false, failure: classifyTransport(err) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const failure = classifyHttp(res.status, parsed, text);
      return { ok: false, failure };
    }

    return { ok: true, response: res, sessionId };
  }

  /*
   * Only API-key credentials may use the platform path.
   *
   * A ChatGPT OAuth token is not an API key. Pointing `upstreamBaseUrl` at
   * api.openai.com previously sent OAuth tokens there, where they produced
   * billing errors ("no credits remaining") that looked like an account
   * problem but were really a wrong-destination problem. OAuth credentials
   * always go to the Codex endpoint below.
   */
  if (credential.providerType !== "codex_oauth" && isOpenAIPlatform(cfg)) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "ai-auther",
    };

    const platformBody = toChatCompletionsBody(body);

    let res: Response;
    try {
      res = await fetch(endpoint(cfg), {
        method: "POST",
        headers,
        body: JSON.stringify(platformBody),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        return {
          ok: false,
          failure: {
            kind: "client",
            status: 499,
            code: "client_disconnected",
            message: "client aborted the request",
            resetsAt: null,
            usageLimited: false,
          },
        };
      }
      return { ok: false, failure: classifyTransport(err) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const failure = classifyHttp(res.status, parsed, text);
      return { ok: false, failure };
    }

    return { ok: true, response: res, sessionId };
  }

  // Otherwise: ChatGPT Web Codex Backend (chatgpt.com/backend-api/codex)
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.accessToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: sessionId,
    "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
  };
  if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;

  /*
   * One request, one model. There was previously a loop here that retried up
   * to nine hard-coded model names whenever the backend answered
   * "<model> is not supported when using Codex with a ChatGPT account".
   *
   * That was a misreading of the error. Probing a free ChatGPT account shows
   * the backend rejects *every* model with that same message — gpt-5-codex,
   * gpt-5, gpt-4o, codex-mini-latest and auto all return it. It is a plan gate,
   * not a model-name problem, so the loop could never succeed; all it did was
   * turn one failing request into nine, against an account whose quota is the
   * scarcest thing this project has.
   */
  let res: Response;
  try {
    res = await fetch(codexEndpoint(cfg), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      return {
        ok: false,
        failure: {
          kind: "client",
          status: 499,
          code: "client_disconnected",
          message: "client aborted the request",
          resetsAt: null,
          usageLimited: false,
        },
      };
    }
    return { ok: false, failure: classifyTransport(err) };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const failure = classifyHttp(res.status, parsed, text);

    // `Retry-After` is a usable fallback when the body carries no `resets_at`,
    // but never overrides an explicit upstream timestamp.
    if (failure.resetsAt === null) {
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) {
        const secs = Number.parseInt(retryAfter, 10);
        if (Number.isFinite(secs) && secs > 0) {
          failure.resetsAt = Math.floor(Date.now() / 1000) + secs;
        }
      }
    }

    log.debug("upstream_error", {
      credential: credential.id,
      status: failure.status,
      code: failure.code,
      kind: failure.kind,
    });
    return { ok: false, failure };
  }

  return { ok: true, response: res, sessionId };
}

/**
 * Decode an SSE byte stream into JSON payloads.
 *
 * Deliberately tolerant: comment lines, keep-alives, `event:` lines we do not
 * need, and unparseable `data:` blobs are all skipped rather than fatal.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; tolerate CRLF.
      let sep: number;
      while ((sep = findBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");

        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;

        const data = dataLines.join("\n");
        if (data === "[DONE]") return;

        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
        } catch {
          log.debug("sse_unparseable_frame", { length: data.length });
        }
      }
    }
  } finally {
    reader.releaseLock();
    // Cancelling releases the upstream connection promptly when a client hangs up.
    void stream.cancel().catch(() => undefined);
  }
}

function findBoundary(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Normalised event stream for one upstream response. */
export async function* codexEvents(
  response: Response,
  signal?: AbortSignal,
  /**
   * Which frame dialect the stream speaks. Antigravity returns Gemini
   * `GenerateContentResponse` frames, which share no field names with either
   * the Codex events or OpenAI chunks the default mapper understands.
   */
  providerType: ProviderType = "codex_oauth",
): AsyncGenerator<CodexEvent> {
  if (!response.body) {
    yield { kind: "error", status: 502, body: { message: "upstream returned no body" } };
    return;
  }
  // Kimi is not SSE at all — it frames JSON in a Connect envelope, so it owns
  // the whole read loop rather than plugging a mapper into this one.
  if (providerType === "web_cookie") {
    yield* kimiEvents(response, signal);
    return;
  }

  const toolIndex = { next: 0 };
  for await (const raw of parseSSE(response.body, signal)) {
    const events =
      providerType === "antigravity" ? mapAntigravityEvent(raw) : mapCodexEvent(raw, toolIndex);
    for (const ev of events) yield ev;
  }
}
