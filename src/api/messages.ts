/**
 * The Anthropic Messages API, served *inbound*.
 *
 * Everything else in this gateway speaks the OpenAI shape to its clients. This
 * route is the other direction: it accepts requests in Anthropic's format so
 * that Claude Code and the Claude desktop app — whose third-party inference
 * mode connects to "any gateway that implements /v1/messages" — can route
 * through the pool. Whatever model those clients ask for is mapped onto a
 * model the pool actually serves, so a Claude client ends up answered by
 * Gemini, GPT, or anything else connected here.
 *
 * Note this is the mirror of `upstream/anthropic.ts`, which speaks Anthropic
 * *outbound* to a provider. Same protocol, opposite ends of the gateway.
 *
 * Three details from the client's compatibility contract are load-bearing and
 * easy to miss:
 *
 *  - Inference posts to `/v1/messages?beta=true`, so the route must match on
 *    path and ignore the query string.
 *  - The response must stream. A gateway that buffers a complete reply before
 *    relaying it makes the client stall.
 *  - The client counts every byte and aborts a stream that goes silent for
 *    300 seconds. Upstreams that pause while thinking send nothing during the
 *    pause, so this emits its own `ping` frames to keep the connection alive.
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { buildCatalogue } from "../core/catalogue.js";
import { createLogger } from "../logging.js";
import type { CredentialStore } from "../pool/store.js";
import type { Router } from "../router.js";
import type {
  ChatCompletionRequest,
  CodexEvent,
  OpenAIMessage,
} from "../upstream/translate.js";
import { errorResponse } from "./errors.js";

const log = createLogger({ mod: "messages" });

/** Idle gap after which a keep-alive frame is sent. Client aborts at 300s. */
const PING_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Request shape

interface AnthropicSource {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}

interface AnthropicBlock {
  type?: string;
  text?: string;
  source?: AnthropicSource;
  /** tool_use */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicBlock[];
}

interface AnthropicRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>;
  thinking?: { type?: string; budget_tokens?: number };
}

/** Flatten Anthropic's `system`, which may be a string or an array of blocks. */
function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b) => b?.type === "text" || typeof b?.text === "string")
    .map((b) => String(b.text ?? ""))
    .join("\n\n");
}

/** Anthropic image block -> the `image_url` part the rest of the gateway uses. */
function imageUrlOf(source: AnthropicSource | undefined): string | null {
  if (!source) return null;
  if (source.type === "base64" && source.data) {
    return `data:${source.media_type || "image/png"};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return null;
}

/** Text of a `tool_result` block, whose content may itself be blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((b) => {
      const block = (b ?? {}) as AnthropicBlock;
      if (typeof block.text === "string") return block.text;
      // An image inside a tool result cannot be represented on the OpenAI
      // `tool` role, so name it rather than dropping it silently.
      if (block.type === "image") return "[image]";
      return JSON.stringify(block);
    })
    .join("\n");
}

/**
 * Translate an Anthropic request into the OpenAI-shaped request the router
 * already understands.
 *
 * Tool calls and results are mapped rather than flattened to text: Claude Code
 * is a tool-driven client, and a conversation whose tool history has been
 * stringified stops making sense to the model after the first round trip.
 */
export function fromAnthropicRequest(
  body: AnthropicRequest,
  model: string,
): { messages: OpenAIMessage[]; tools: ChatCompletionRequest["tools"] } {
  const messages: OpenAIMessage[] = [];

  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const raw of body.messages ?? []) {
    const role = raw.role === "assistant" ? "assistant" : "user";
    const content = raw.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    /** Emitted after this turn: each becomes its own `tool` message. */
    const toolResults: OpenAIMessage[] = [];

    for (const block of content) {
      switch (block?.type) {
        case "text":
          if (block.text) parts.push({ type: "text", text: block.text });
          break;

        case "image": {
          const url = imageUrlOf(block.source);
          if (url) parts.push({ type: "image_url", image_url: { url } });
          break;
        }

        case "thinking":
        case "redacted_thinking":
          // The model's own scratchpad. Replaying it as assistant text would
          // present reasoning as an answer.
          break;

        case "tool_use":
          toolCalls.push({
            id: String(block.id ?? randomUUID()),
            type: "function",
            function: {
              name: String(block.name ?? "tool"),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;

        case "tool_result":
          toolResults.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id ?? ""),
            content: toolResultText(block.content),
          });
          break;

        default:
          if (typeof block?.text === "string" && block.text) {
            parts.push({ type: "text", text: block.text });
          }
      }
    }

    if (parts.length || toolCalls.length) {
      const onlyText = parts.length > 0 && parts.every((p) => p.type === "text");
      messages.push({
        role,
        // Keep a pure-text turn as a plain string: several OpenAI-compatible
        // servers reject the typed-part array.
        content: parts.length ? (onlyText ? parts.map((p) => p.text ?? "").join("") : parts) : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
    // Tool results are their own messages and must follow the call.
    for (const result of toolResults) messages.push(result);
  }

  if (!messages.some((m) => m.role !== "system")) {
    messages.push({ role: "user", content: "" });
  }

  const tools = body.tools?.length
    ? body.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: String(t.name ?? "tool"),
          description: t.description ?? "",
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }))
    : undefined;

  void model;
  return { messages, tools };
}

/** Anthropic's thinking control mapped onto a reasoning effort. */
function reasoningEffort(
  thinking: AnthropicRequest["thinking"],
): "low" | "medium" | "high" | undefined {
  if (!thinking?.type) return undefined;
  if (thinking.type === "disabled") return undefined;
  const budget = thinking.budget_tokens;
  if (typeof budget === "number" && budget > 0) {
    if (budget >= 16_000) return "high";
    if (budget <= 2_000) return "low";
  }
  // `adaptive` and `enabled` both just mean "think", with no level attached.
  return "medium";
}

// ---------------------------------------------------------------------------
// Model mapping

/**
 * Decide which pooled model answers a request naming a Claude model.
 *
 * Claude Code sends the model it believes it is talking to — `claude-sonnet-4-6`
 * and friends — which the pool usually cannot serve. Rather than fail, the
 * request is mapped: an explicit override first, then the id itself when
 * something in the pool really does serve it, then the configured default,
 * which is a virtual id (`auto`) so routing picks whatever is healthy.
 */
export function resolveRequestedModel(
  requested: string,
  cfg: Config,
  servable: ReadonlySet<string>,
): { model: string; mapped: boolean } {
  const asked = requested.trim();

  const override =
    cfg.anthropicModelMap[asked] ??
    Object.entries(cfg.anthropicModelMap).find(
      ([k]) => k.toLowerCase() === asked.toLowerCase(),
    )?.[1];
  if (override) return { model: override, mapped: override !== asked };

  if (asked && servable.has(asked)) return { model: asked, mapped: false };
  for (const id of servable) {
    if (id.toLowerCase() === asked.toLowerCase()) return { model: id, mapped: id !== asked };
  }

  return { model: cfg.anthropicDefaultModel, mapped: true };
}

// ---------------------------------------------------------------------------
// Response shape

type StopReason = "end_turn" | "max_tokens" | "tool_use";

function stopReasonOf(finish: string | null | undefined): StopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls") return "tool_use";
  return "end_turn";
}

/**
 * Accumulates gateway events into Anthropic's block-structured stream.
 *
 * Anthropic frames a reply as a sequence of indexed content blocks that must
 * be opened and closed in order, while the gateway emits a flat event stream.
 * This holds the block bookkeeping so both the streaming and non-streaming
 * paths agree on the result.
 */
class BlockWriter {
  private index = -1;
  private open: "text" | "thinking" | "tool" | null = null;
  private readonly toolIndex = new Map<number, number>();

  constructor(private readonly emit: (event: string, data: unknown) => void) {}

  private close(): void {
    if (this.open === null) return;
    this.emit("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
  }

  text(delta: string): void {
    if (this.open !== "text") {
      this.close();
      this.index += 1;
      this.open = "text";
      this.emit("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block: { type: "text", text: "" },
      });
    }
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.index,
      delta: { type: "text_delta", text: delta },
    });
  }

  thinking(delta: string): void {
    if (this.open !== "thinking") {
      this.close();
      this.index += 1;
      this.open = "thinking";
      this.emit("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block: { type: "thinking", thinking: "" },
      });
    }
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.index,
      delta: { type: "thinking_delta", thinking: delta },
    });
  }

  tool(call: { index: number; id: string; name: string; arguments: string }): void {
    let at = this.toolIndex.get(call.index);
    if (at === undefined) {
      this.close();
      this.index += 1;
      at = this.index;
      this.toolIndex.set(call.index, at);
      this.open = "tool";
      this.emit("content_block_start", {
        type: "content_block_start",
        index: at,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      });
    }
    if (call.arguments) {
      this.emit("content_block_delta", {
        type: "content_block_delta",
        index: at,
        delta: { type: "input_json_delta", partial_json: call.arguments },
      });
    }
  }

  finish(): void {
    this.close();
  }
}

/** Collected non-streaming result, assembled from the same event stream. */
interface Collected {
  content: Array<Record<string, unknown>>;
  stopReason: StopReason;
  inputTokens: number;
  outputTokens: number;
  error: { status: number; message: string } | null;
}

async function collect(events: AsyncGenerator<CodexEvent>): Promise<Collected> {
  const out: Collected = {
    content: [],
    stopReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
    error: null,
  };
  let text = "";
  let thinking = "";
  const tools = new Map<number, { id: string; name: string; args: string }>();

  for await (const ev of events) {
    if (ev.kind === "text") text += ev.delta;
    else if (ev.kind === "reasoning") thinking += ev.delta;
    else if (ev.kind === "tool_call") {
      const existing = tools.get(ev.index);
      if (existing) existing.args += ev.arguments;
      else tools.set(ev.index, { id: ev.id, name: ev.name, args: ev.arguments });
    } else if (ev.kind === "usage") {
      out.inputTokens = ev.usage.prompt_tokens;
      out.outputTokens = ev.usage.completion_tokens;
    } else if (ev.kind === "done") {
      out.stopReason = stopReasonOf(ev.finishReason);
    } else if (ev.kind === "error") {
      const body = (ev.body ?? {}) as Record<string, unknown>;
      out.error = {
        status: ev.status || 502,
        message: typeof body.message === "string" ? body.message : JSON.stringify(ev.body),
      };
    }
  }

  if (thinking) out.content.push({ type: "thinking", thinking, signature: "" });
  if (text) out.content.push({ type: "text", text });
  for (const t of tools.values()) {
    let input: unknown = {};
    try {
      input = t.args ? JSON.parse(t.args) : {};
    } catch {
      input = { _raw: t.args };
    }
    out.content.push({ type: "tool_use", id: t.id, name: t.name, input });
    out.stopReason = "tool_use";
  }
  // Anthropic requires at least one content block.
  if (out.content.length === 0) out.content.push({ type: "text", text: "" });
  return out;
}

// ---------------------------------------------------------------------------
// Routes

/** Anthropic-shaped error body. Clients match on the wording, so keep it plain. */
function anthropicError(c: Context, status: number, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status as never);
}

export function messagesRoutes(cfg: Config, store: CredentialStore, router: Router): Hono {
  const app = new Hono();

  /**
   * Rough token estimate for the optional counting endpoint.
   *
   * Deliberately an overestimate: the client uses this to decide when to
   * compact a conversation, and guessing high makes it compact early, while
   * guessing low lets it overflow the real context window and fail the turn.
   */
  const estimateTokens = (body: AnthropicRequest): number => {
    const { messages } = fromAnthropicRequest(body, "estimate");
    let chars = 0;
    for (const m of messages) {
      if (typeof m.content === "string") chars += m.content.length;
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          chars += (p.text ?? "").length;
          // An image costs far more than its URL's length suggests.
          if (p.image_url) chars += 4000;
        }
      }
      for (const call of m.tool_calls ?? []) chars += call.function.arguments.length;
    }
    return Math.max(1, Math.ceil(chars / 3.2));
  };

  app.post("/v1/messages/count_tokens", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AnthropicRequest;
    return c.json({ input_tokens: estimateTokens(body) });
  });

  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json().catch(() => null)) as AnthropicRequest | null;
    if (!body || typeof body !== "object") {
      return anthropicError(c, 400, "invalid_request_error", "Request body must be a JSON object.");
    }
    if (!Array.isArray(body.messages)) {
      return anthropicError(c, 400, "invalid_request_error", "`messages` is required.");
    }

    const servable = new Set(
      buildCatalogue(store.all(), { freeOnly: cfg.freeModelsOnly, includeVirtual: true }).map(
        (m) => m.id,
      ),
    );
    const requested = String(body.model ?? "").trim();
    const { model, mapped } = resolveRequestedModel(requested, cfg, servable);

    if (mapped) {
      log.info("anthropic_model_mapped", { requested, served: model });
    }

    const { messages, tools } = fromAnthropicRequest(body, model);
    const effort = reasoningEffort(body.thinking);

    const request = {
      model,
      messages,
      stream: body.stream !== false,
      ...(tools ? { tools } : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
      ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
      ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };

    const controller = new AbortController();
    c.req.raw.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    const outcome = await router.chat(request, controller.signal);
    const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (!outcome.ok) {
      // The client matches on error wording to decide whether to retry with a
      // capability disabled, so the upstream's own message is passed through.
      const type =
        outcome.status === 429
          ? "rate_limit_error"
          : outcome.status === 401
            ? "authentication_error"
            : outcome.status >= 500
              ? "api_error"
              : "invalid_request_error";
      return anthropicError(c, outcome.status || 502, type, outcome.message);
    }

    // ----------------------------------------------------------- streaming
    if (body.stream !== false) {
      return streamSSE(c, async (stream) => {
        let lastWrite = Date.now();
        /*
         * Writes are chained rather than fired and forgotten.
         *
         * `writeSSE` is async, and not awaiting it let the handler return
         * while frames were still queued — the response closed after the
         * first text delta, so the client never saw `content_block_stop`,
         * `message_delta` or `message_stop` and treated every reply as a
         * truncated stream. Chaining also guarantees frame order, which the
         * block protocol depends on.
         */
        let writes: Promise<void> = Promise.resolve();
        const send = (event: string, data: unknown) => {
          lastWrite = Date.now();
          writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        };

        /*
         * Keep-alive. The client aborts a stream that produces no bytes for
         * 300 seconds, and an upstream that pauses to think sends nothing
         * during the pause, so the silence has to be filled from here.
         */
        const ping = setInterval(() => {
          if (Date.now() - lastWrite >= PING_INTERVAL_MS) send("ping", { type: "ping" });
        }, PING_INTERVAL_MS);

        const writer = new BlockWriter(send);
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: StopReason = "end_turn";
        let failed: { status: number; message: string } | null = null;

        send("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: outcome.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        try {
          for await (const ev of outcome.events) {
            if (ev.kind === "text") writer.text(ev.delta);
            else if (ev.kind === "reasoning") writer.thinking(ev.delta);
            else if (ev.kind === "tool_call") {
              writer.tool(ev);
              stopReason = "tool_use";
            } else if (ev.kind === "usage") {
              inputTokens = ev.usage.prompt_tokens;
              outputTokens = ev.usage.completion_tokens;
            } else if (ev.kind === "done") {
              if (stopReason !== "tool_use") stopReason = stopReasonOf(ev.finishReason);
            } else if (ev.kind === "error") {
              const b = (ev.body ?? {}) as Record<string, unknown>;
              failed = {
                status: ev.status || 502,
                message: typeof b.message === "string" ? b.message : JSON.stringify(ev.body),
              };
              break;
            }
          }
        } catch (err) {
          failed = { status: 502, message: (err as Error).message };
        } finally {
          clearInterval(ping);
        }

        if (failed) {
          // Mid-stream failures are reported as an Anthropic error frame
          // rather than a truncated success.
          send("error", {
            type: "error",
            error: { type: "api_error", message: failed.message },
          });
          await writes;
          return;
        }

        writer.finish();
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
        void inputTokens;
        // Flush every queued frame before the handler returns, or the
        // response closes with frames still pending.
        await writes;
      });
    }

    // ------------------------------------------------------- non-streaming
    const result = await collect(outcome.events);
    if (result.error) {
      return anthropicError(c, result.error.status, "api_error", result.error.message);
    }

    return c.json({
      id: messageId,
      type: "message",
      role: "assistant",
      model: outcome.model,
      content: result.content,
      stop_reason: result.stopReason,
      stop_sequence: null,
      usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
    });
  });

  return app;
}

/** Unauthenticated warm-up probe the Claude clients send before connecting. */
export function registerHelloProbe(app: Hono): void {
  const ok = (c: Context) => c.body(null, 200);
  app.on("HEAD", "/api/hello", ok);
  app.get("/api/hello", ok);
}

export { anthropicError, errorResponse };
