/**
 * POST /v1/chat/completions
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { compressMessages, measureOutput } from "../compress/caveman.js";
import type { CavemanHistory } from "../compress/history.js";
import type { Config } from "../config.js";
import { now } from "../db.js";
import { createLogger } from "../logging.js";
import type { Router } from "../router.js";
import { displayName, type CredentialStore } from "../pool/store.js";
import type { RequestLogEntry } from "../pool/types.js";
import {
  chunkEnvelope,
  completionEnvelope,
  newCompletionId,
  type ChatCompletionRequest,
  type FinishReason,
  type OpenAIToolCall,
  type Usage,
} from "../upstream/translate.js";
import { errorResponse } from "./errors.js";

const log = createLogger({ mod: "chat" });

const EMPTY_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function validate(body: unknown): { ok: true; req: ChatCompletionRequest } | { ok: false; message: string; param: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object.", param: "" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || !b.model) {
    return { ok: false, message: "`model` is required and must be a string.", param: "model" };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, message: "`messages` is required and must be a non-empty array.", param: "messages" };
  }
  for (const [i, m] of (b.messages as unknown[]).entries()) {
    if (!m || typeof m !== "object" || typeof (m as { role?: unknown }).role !== "string") {
      return { ok: false, message: `messages[${i}] must be an object with a string \`role\`.`, param: "messages" };
    }
  }
  return { ok: true, req: b as unknown as ChatCompletionRequest };
}

export function chatCompletionsHandler(
  cfg: Config,
  router: Router,
  store: CredentialStore,
  history: CavemanHistory,
) {
  return async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Request body is not valid JSON.", "invalid_request_error", "invalid_json");
    }

    const parsed = validate(raw);
    if (!parsed.ok) {
      return errorResponse(c, 400, parsed.message, "invalid_request_error", "invalid_parameter");
    }
    const req = parsed.req;
    const startedAt = Date.now();
    const client = c.get("clientName") ?? null;

    /** One row per client request, written on every exit path below. */
    const writeLog = (entry: Partial<RequestLogEntry>): void => {
      store.logRequest({
        ts: now(),
        client,
        credentialId: null,
        credentialName: null,
        model: req.model,
        streaming: Boolean(req.stream),
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

    // Caveman never blocks a request: on any failure it returns the original
    // messages and reports why, so a misconfigured summariser costs latency
    // rather than correctness.
    const compression = await compressMessages(cfg.caveman, req.messages, history);
    req.messages = compression.messages;
    if (compression.error) {
      log.warn("caveman_skipped", { reason: compression.error });
    }

    // Client disconnects must tear down the upstream call, not leak a socket.
    const controller = new AbortController();
    const clientSignal = c.req.raw.signal;
    if (clientSignal) {
      if (clientSignal.aborted) controller.abort();
      else clientSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    // Clients can steer to a subset of connections with routing tags.
    const tags = (c.req.header("x-ai-auther-tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const outcome = await router.chat(req, controller.signal, tags.length ? { tags } : {});

    if (!outcome.ok) {
      clearTimeout(timeout);
      const headers: Record<string, string> = {};
      if (outcome.retryAt) {
        headers["retry-after"] = String(Math.max(1, outcome.retryAt - Math.floor(Date.now() / 1000)));
        headers["x-ai-auther-resets-at"] = String(outcome.retryAt);
      }
      headers["x-ai-auther-attempts"] = String(outcome.attempts);

      const type =
        outcome.status === 429
          ? "rate_limit_error"
          : outcome.status >= 500
            ? "api_error"
            : "invalid_request_error";

      writeLog({
        outcome: "error",
        status: outcome.status,
        attempts: outcome.attempts,
        errorCode: outcome.code,
        errorMessage: outcome.message,
        compressed: compression.compressed,
        inputBefore: compression.before,
        inputAfter: compression.after,
      });

      return errorResponse(c, outcome.status, outcome.message, type, outcome.code, headers);
    }

    const { credential, events } = outcome;
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = req.model;

    c.header("x-ai-auther-account", String(credential.id));
    c.header("x-ai-auther-attempts", String(outcome.attempts));
    // The envelope echoes whatever the client asked for, so a virtual id like
    // `fast` would otherwise hide which model actually answered.
    c.header("x-ai-auther-model", outcome.model ?? req.model);

    // ------------------------------------------------------------ streaming
    if (req.stream) {
      return streamSSE(c, async (stream) => {
        let usage: Usage = EMPTY_USAGE;
        let finish: FinishReason = "stop";
        let sawToolCall = false;
        let broke = false;
        // Accumulated purely to measure what output compression would save.
        // The client has already received every byte of this verbatim.
        let outputText = "";

        await stream.writeSSE({
          data: JSON.stringify(chunkEnvelope(id, model, created, { role: "assistant", content: "" })),
        });

        try {
          for await (const ev of events) {
            switch (ev.kind) {
              case "text":
                outputText += ev.delta;
                await stream.writeSSE({
                  data: JSON.stringify(chunkEnvelope(id, model, created, { content: ev.delta })),
                });
                break;

              case "tool_call":
                sawToolCall = true;
                await stream.writeSSE({
                  data: JSON.stringify(
                    chunkEnvelope(id, model, created, {
                      tool_calls: [
                        {
                          index: ev.index,
                          id: ev.id,
                          type: "function",
                          function: { name: ev.name, arguments: ev.arguments },
                        },
                      ],
                    }),
                  ),
                });
                break;

              case "usage":
                usage = ev.usage;
                break;

              case "done":
                finish = ev.finishReason;
                break;

              case "error":
                // Past the commit point: the client has already seen output, so
                // failing over would produce a contradictory second answer.
                // Surface it as a terminated stream instead.
                broke = true;
                log.warn("stream_broke_after_commit", {
                  credential: credential.id,
                  status: ev.status,
                });
                break;

              case "reasoning":
                // Not represented in the Chat Completions wire format.
                break;
            }
            if (broke) break;
          }
        } catch (err) {
          broke = true;
          log.warn("stream_aborted", { credential: credential.id, err });
        } finally {
          clearTimeout(timeout);
        }

        const measured = measureOutput(cfg.caveman, outputText);
        writeLog({
          credentialId: credential.id,
          credentialName: displayName(credential),
          status: broke ? 502 : 200,
          outcome: broke ? "error" : outcome.attempts > 1 ? "rotated_ok" : "ok",
          attempts: outcome.attempts,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          compressed: compression.compressed,
          inputBefore: compression.before,
          inputAfter: compression.after,
          outputMeasured: measured?.measured ?? null,
          outputWouldSave: measured?.wouldSave ?? null,
          errorCode: broke ? "stream_interrupted" : null,
        });

        if (!broke) {
          await stream.writeSSE({
            data: JSON.stringify(
              chunkEnvelope(id, model, created, {}, sawToolCall ? "tool_calls" : finish),
            ),
          });
          await stream.writeSSE({ data: "[DONE]" });
          store.markSuccess(credential.id, usage.total_tokens);
        } else {
          await stream.writeSSE({
            data: JSON.stringify({
              error: {
                message:
                  "Upstream stream failed after output had already started, so ai-auther " +
                  "could not fail over to another credential without contradicting itself.",
                type: "api_error",
                code: "stream_interrupted",
              },
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        }
      });
    }

    // -------------------------------------------------------- non-streaming
    let content = "";
    const toolCalls: OpenAIToolCall[] = [];
    let usage: Usage = EMPTY_USAGE;
    let finish: FinishReason = "stop";

    try {
      for await (const ev of events) {
        if (ev.kind === "text") content += ev.delta;
        else if (ev.kind === "tool_call") {
          toolCalls.push({
            id: ev.id,
            type: "function",
            function: { name: ev.name, arguments: ev.arguments },
          });
        } else if (ev.kind === "usage") usage = ev.usage;
        else if (ev.kind === "done") finish = ev.finishReason;
        else if (ev.kind === "error") {
          clearTimeout(timeout);
          writeLog({
            credentialId: credential.id,
            credentialName: displayName(credential),
            status: 502,
            outcome: "error",
            attempts: outcome.attempts,
            errorCode: "upstream_stream_error",
            compressed: compression.compressed,
            inputBefore: compression.before,
            inputAfter: compression.after,
          });
          return errorResponse(
            c,
            502,
            "Upstream failed while generating the response.",
            "api_error",
            "upstream_stream_error",
          );
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      log.warn("aggregate_failed", { credential: credential.id, err });
      writeLog({
        credentialId: credential.id,
        credentialName: displayName(credential),
        status: 502,
        outcome: "error",
        attempts: outcome.attempts,
        errorCode: "stream_read_failed",
        errorMessage: (err as Error).message,
        compressed: compression.compressed,
        inputBefore: compression.before,
        inputAfter: compression.after,
      });
      return errorResponse(c, 502, "Upstream stream failed.", "api_error", "stream_read_failed");
    }
    clearTimeout(timeout);

    const measured = measureOutput(cfg.caveman, content);
    writeLog({
      credentialId: credential.id,
      credentialName: displayName(credential),
      status: 200,
      outcome: outcome.attempts > 1 ? "rotated_ok" : "ok",
      attempts: outcome.attempts,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      compressed: compression.compressed,
      inputBefore: compression.before,
      inputAfter: compression.after,
      outputMeasured: measured?.measured ?? null,
      outputWouldSave: measured?.wouldSave ?? null,
    });

    store.markSuccess(credential.id, usage.total_tokens);
    return c.json(completionEnvelope(id, model, created, content, toolCalls, finish, usage));
  };
}
