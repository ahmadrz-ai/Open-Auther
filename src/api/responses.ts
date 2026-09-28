/**
 * POST /v1/responses — the OpenAI Responses API, for clients such as Codex CLI.
 *
 * Relayed to the Codex backend, which speaks this API natively, so the events
 * the Chat Completions translation cannot express (reasoning items, custom
 * tools) reach the client untouched.
 */

import type { Context } from "hono";
import type { Config } from "../config.js";
import { now } from "../db.js";
import { keyAllows } from "../core/keys.js";
import { createLogger } from "../logging.js";
import type { Router } from "../router.js";
import { displayName, type CredentialStore } from "../pool/store.js";
import type { RequestLogEntry } from "../pool/types.js";
import { parseSSE } from "../upstream/client.js";
import { errorResponse } from "./errors.js";

const log = createLogger({ mod: "responses" });

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export function responsesHandler(cfg: Config, router: Router, store: CredentialStore) {
  return async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Request body is not valid JSON.", "invalid_request_error", "invalid_json");
    }
    const model = raw && typeof raw === "object" ? (raw as { model?: unknown }).model : undefined;
    if (typeof model !== "string" || !model) {
      return errorResponse(c, 400, "`model` is required and must be a string.", "invalid_request_error", "invalid_parameter");
    }
    const body = raw as Record<string, unknown> & { model: string };

    const key = c.get("gatewayKey");
    if (key && !keyAllows(key, model)) {
      return errorResponse(c, 403, `"${model}" is turned off for this key in its API settings.`, "invalid_request_error", "model_not_allowed");
    }

    const streaming = body.stream === true;
    const startedAt = Date.now();
    const client = c.get("clientName") ?? null;
    const writeLog = (entry: Partial<RequestLogEntry>): void => {
      store.logRequest({
        ts: now(),
        client,
        credentialId: null,
        credentialName: null,
        model,
        streaming,
        status: null,
        outcome: "ok",
        attempts: 1,
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        compressed: false,
        inputBefore: null,
        inputAfter: null,
        outputMeasured: null,
        outputWouldSave: null,
        errorCode: null,
        errorMessage: null,
        ...entry,
      });
    };

    // Client disconnects must tear down the upstream call, not leak a socket.
    const controller = new AbortController();
    const clientSignal = c.req.raw.signal;
    if (clientSignal) {
      if (clientSignal.aborted) controller.abort();
      else clientSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    const tags = (c.req.header("x-ai-auther-tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const outcome = await router.responses(body, controller.signal, tags.length ? { tags } : {});
    if (!outcome.ok) {
      clearTimeout(timeout);
      const headers: Record<string, string> = { "x-ai-auther-attempts": String(outcome.attempts) };
      if (outcome.retryAt) {
        headers["retry-after"] = String(Math.max(1, outcome.retryAt - Math.floor(Date.now() / 1000)));
        headers["x-ai-auther-resets-at"] = String(outcome.retryAt);
      }
      writeLog({ outcome: "error", status: outcome.status, attempts: outcome.attempts, errorCode: outcome.code, errorMessage: outcome.message });
      const type = outcome.status === 429 ? "rate_limit_error" : outcome.status >= 500 ? "api_error" : "invalid_request_error";
      return errorResponse(c, outcome.status, outcome.message, type, outcome.code, headers);
    }

    const { credential, response, attempts } = outcome;
    const headers = {
      "x-ai-auther-account": String(credential.id),
      "x-ai-auther-attempts": String(attempts),
      "x-ai-auther-model": outcome.model,
    };

    /** Reads the stream to its end, recording usage; resolves to the final response. */
    const settle = async (stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown> | null> => {
      let final: Record<string, unknown> | null = null;
      let failed: string | null = null;
      try {
        for await (const ev of parseSSE(stream, controller.signal)) {
          if (ev.type === "response.completed" && ev.response && typeof ev.response === "object") {
            final = ev.response as Record<string, unknown>;
          } else if (ev.type === "response.failed" || ev.type === "error") {
            failed = typeof ev.type === "string" ? ev.type : "error";
          }
        }
      } catch (err) {
        failed = "stream_read_failed";
        log.warn("responses_stream_failed", { credential: credential.id, err });
      } finally {
        clearTimeout(timeout);
      }

      const usage = (final?.usage ?? {}) as ResponsesUsage;
      const total = usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const ok = final !== null && failed === null;
      writeLog({
        credentialId: credential.id,
        credentialName: displayName(credential),
        status: ok ? 200 : 502,
        outcome: ok ? (attempts > 1 ? "rotated_ok" : "ok") : "error",
        attempts,
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalTokens: total,
        errorCode: ok ? null : (failed ?? "stream_incomplete"),
      });
      if (ok) store.markSuccess(credential.id, total);
      return ok ? final : null;
    };

    if (!response.body) {
      clearTimeout(timeout);
      writeLog({ credentialId: credential.id, credentialName: displayName(credential), status: 502, outcome: "error", attempts, errorCode: "empty_upstream_stream" });
      return errorResponse(c, 502, "Upstream returned no body.", "api_error", "empty_upstream_stream");
    }

    if (streaming) {
      // One branch goes to the client byte-for-byte, the other is only metered.
      const [toClient, toMeter] = response.body.tee();
      void settle(toMeter);
      return new Response(toClient, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers },
      });
    }

    const final = await settle(response.body);
    if (!final) {
      return errorResponse(c, 502, "Upstream failed while generating the response.", "api_error", "upstream_stream_error");
    }
    return c.json(final, 200, headers);
  };
}
