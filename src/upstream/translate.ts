/**
 * OpenAI Chat Completions <-> Codex backend translation.
 *
 * The subscription-backed endpoint is `https://chatgpt.com/backend-api/codex`,
 * which speaks a Responses-API-shaped protocol, not `/v1/chat/completions`.
 * Two consequences drive this file:
 *
 *   1. Requests must be reshaped: `messages[]` becomes `input[]` items with
 *      typed content parts, and the system prompt becomes `instructions`.
 *   2. The backend only streams. Even a non-streaming client request is served
 *      by consuming the upstream SSE and aggregating it here.
 *
 * Every backend-shape assumption is isolated in this file so that a change
 * upstream is a one-file fix.
 */

import { randomUUID } from "node:crypto";

// --------------------------------------------------------------- OpenAI types

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown; strict?: boolean };
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  user?: string;
  [k: string]: unknown;
}

// ------------------------------------------------------------ request mapping

function textOf(content: OpenAIMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" || part.type === "input_text" ? (part.text ?? "") : ""))
    .join("");
}

/** Content parts that survive the trip, keeping images intact where present. */
function contentParts(
  msg: OpenAIMessage,
  kind: "input_text" | "output_text",
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof msg.content === "string") {
    if (msg.content) parts.push({ type: kind, text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
        if (p.text) parts.push({ type: kind, text: p.text });
      } else if (p.type === "image_url" && p.image_url?.url && kind === "input_text") {
        parts.push({ type: "input_image", image_url: p.image_url.url });
      }
    }
  }
  if (parts.length === 0) parts.push({ type: kind, text: "" });
  return parts;
}

export interface CodexRequest {
  model: string;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  store: boolean;
  stream: true;
  include: string[];
  reasoning?: { effort: string; summary: string };
  // Retained for non-Codex provider adapters that share this internal type.
  // toCodexRequest intentionally does not emit these fields to chatgpt.com.
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  [CLIENT_PARAMS]?: ClientParams;
}

/** Client-only controls used by non-Codex adapters; never serialized upstream. */
export interface ClientParams {
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
}

export const CLIENT_PARAMS: unique symbol = Symbol("clientParams");

/*
 * There is deliberately no model alias table here.
 *
 * One previously existed, mapping every GPT-5.x name onto `gpt-4o` to dodge
 * the Codex backend's "model is not supported" error. It did not work — that
 * error is a plan gate, and the backend rejects `gpt-4o` on a free account
 * just as readily. What it did do was silently serve a different model than
 * the caller asked for, which is a worse failure than an error: the client
 * gets a plausible answer from the wrong model with nothing to indicate it.
 *
 * The model string is forwarded verbatim. If upstream will not serve it, the
 * caller sees upstream's own error and can act on it.
 */

/**
 * Build the upstream request body.
 *
 * `store: false` is not optional for us: we do not want conversation state
 * persisted server-side against the user's account.
 */
export function toCodexRequest(req: ChatCompletionRequest): CodexRequest {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of req.messages ?? []) {
    switch (msg.role) {
      case "system":
      case "developer": {
        const t = textOf(msg.content);
        if (t) instructions.push(t);
        break;
      }

      case "user":
        input.push({ type: "message", role: "user", content: contentParts(msg, "input_text") });
        break;

      case "assistant": {
        const t = textOf(msg.content);
        if (t) {
          input.push({
            type: "message",
            role: "assistant",
            content: contentParts(msg, "output_text"),
          });
        }
        // Tool calls are separate top-level items upstream, not message fields.
        for (const call of msg.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }

      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id ?? "",
          output: textOf(msg.content),
        });
        break;
    }
  }

  const tools = (req.tools ?? [])
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
      strict: t.function.strict ?? false,
    }));

  const body: CodexRequest = {
    model: req.model,
    input: input.length ? input : [{ type: "message", role: "user", content: [{ type: "input_text", text: "" }] }],
    store: false,
    stream: true,
    include: [],
  };

  // The subscription Codex endpoint is stricter than the public Platform
  // Chat Completions API. Match Hermes' native request shape: do not send an
  // empty tools envelope or unsupported sampling/token controls.
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = req.tool_choice ?? "auto";
    body.parallel_tool_calls = req.parallel_tool_calls ?? false;
  }

  if (instructions.length) body.instructions = instructions.join("\n\n");
  if (req.reasoning_effort) {
    body.reasoning = { effort: req.reasoning_effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  const clientParams: ClientParams = {};
  if (typeof req.temperature === "number") clientParams.temperature = req.temperature;
  if (typeof req.top_p === "number") clientParams.top_p = req.top_p;
  const maxOutput = req.max_completion_tokens ?? req.max_tokens;
  if (typeof maxOutput === "number") clientParams.max_output_tokens = maxOutput;
  if (Object.keys(clientParams).length) {
    Object.defineProperty(body, CLIENT_PARAMS, { value: clientParams, enumerable: false });
  }

  return body;
}

// ----------------------------------------------------------- response mapping

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A normalised event, decoupled from whatever the backend calls things. */
export type CodexEvent =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool_call"; index: number; id: string; name: string; arguments: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "done"; finishReason: FinishReason }
  | { kind: "error"; status: number; body: unknown };

interface RawEvent {
  type?: string;
  delta?: unknown;
  item?: Record<string, unknown>;
  response?: Record<string, unknown>;
  output_index?: number;
  error?: unknown;
  [k: string]: unknown;
}

function readUsage(response: Record<string, unknown> | undefined): Usage | null {
  const u = response?.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  const prompt = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const completion = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(u.total_tokens ?? prompt + completion),
  };
}

/**
 * Map one decoded upstream SSE payload onto zero or more normalised events.
 * Unknown event types are ignored rather than erroring: the backend adds new
 * ones without notice and an unrecognised event is not a failure.
 */
export function mapCodexEvent(raw: RawEvent, toolIndex: { next: number }): CodexEvent[] {
  // Support standard OpenAI API SSE payload chunks: {"choices":[{"delta":{"content":"..."}}]}
  if (Array.isArray(raw.choices)) {
    const out: CodexEvent[] = [];
    for (const choice of raw.choices as Array<Record<string, unknown>>) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string" && delta.content) {
        out.push({ kind: "text", delta: delta.content });
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          out.push({
            kind: "tool_call",
            index: Number(tc.index ?? toolIndex.next++),
            id: String(tc.id ?? ""),
            name: String(fn?.name ?? ""),
            arguments: String(fn?.arguments ?? ""),
          });
        }
      }
      if (choice.finish_reason) {
        out.push({ kind: "done", finishReason: choice.finish_reason as FinishReason });
      }
    }
    if (raw.usage) {
      const usage = readUsage(raw);
      if (usage) out.push({ kind: "usage", usage });
    }
    return out;
  }

  const type = typeof raw.type === "string" ? raw.type : "";

  switch (type) {
    case "response.output_text.delta":
    case "response.text.delta":
      return typeof raw.delta === "string" && raw.delta
        ? [{ kind: "text", delta: raw.delta }]
        : [];

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return typeof raw.delta === "string" && raw.delta
        ? [{ kind: "reasoning", delta: raw.delta }]
        : [];

    case "response.output_item.done": {
      const item = raw.item ?? {};
      if (item.type !== "function_call") return [];
      return [
        {
          kind: "tool_call",
          index: toolIndex.next++,
          id: String(item.call_id ?? item.id ?? randomUUID()),
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? ""),
        },
      ];
    }

    case "response.completed": {
      const out: CodexEvent[] = [];
      const usage = readUsage(raw.response);
      if (usage) out.push({ kind: "usage", usage });
      const status = raw.response?.status;
      out.push({
        kind: "done",
        finishReason: status === "incomplete" ? "length" : "stop",
      });
      return out;
    }

    case "response.failed":
    case "response.incomplete":
      return [{ kind: "error", status: 502, body: raw.response ?? raw }];

    case "error":
      return [{ kind: "error", status: 502, body: raw.error ?? raw }];

    default:
      return [];
  }
}

// ------------------------------------------------------- OpenAI wire envelopes

export function chunkEnvelope(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: FinishReason = null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function completionEnvelope(
  id: string,
  model: string,
  created: number,
  content: string,
  toolCalls: OpenAIToolCall[],
  finishReason: FinishReason,
  usage: Usage,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : (finishReason ?? "stop"),
      },
    ],
    usage,
  };
}

export function newCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}
