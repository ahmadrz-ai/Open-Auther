/**
 * The Anthropic Messages protocol, for custom endpoints that speak it.
 *
 * Every custom provider used to be assumed OpenAI-compatible, so pointing one
 * at an Anthropic-style endpoint produced a bare 404 from `/chat/completions`
 * and no indication why. This module is the second protocol: same credential
 * type, different framing.
 *
 * Three things differ from the OpenAI shape and all three are load-bearing:
 *   - auth is `x-api-key`, not `Authorization: Bearer`, and `anthropic-version`
 *     is mandatory — omit it and every request 400s
 *   - the system prompt is a top-level field, not a message with role "system"
 *   - `max_tokens` is required, not optional
 */

import type { Credential } from "../pool/types.js";
import { CLIENT_PARAMS, type CodexEvent, type CodexRequest } from "./translate.js";

/** The dated API version this adapter is written against. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic rejects a request with no token ceiling, so one is always sent. */
const DEFAULT_MAX_TOKENS = 4096;

export function anthropicHeaders(credential: Credential): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-api-key": credential.accessToken ?? "",
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/** Flatten a normalised content-part array to plain text. */
function textOf(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => String((p as { text?: unknown }).text ?? "")).join("");
}

/**
 * Translate a normalised request into an Anthropic Messages body.
 *
 * Consecutive same-role turns are merged: Anthropic rejects two adjacent user
 * turns, which is easy to produce from a tool-call round trip.
 */
export function toAnthropicRequest(body: CodexRequest): Record<string, unknown> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  const push = (role: "user" | "assistant", text: string) => {
    if (!text) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else messages.push({ role, content: text });
  };

  for (const item of body.input) {
    if (item.type === "message") {
      push(item.role === "assistant" ? "assistant" : "user", textOf(item.content));
    } else if (item.type === "function_call") {
      // Tools are not mapped yet. Keeping the intent visible beats dropping
      // the turn, which would leave the transcript incoherent.
      push("assistant", `[called ${String(item.name ?? "tool")}]`);
    } else if (item.type === "function_call_output") {
      push("user", String(item.output ?? ""));
    }
  }

  // Anthropic requires a non-empty messages array beginning with a user turn.
  if (messages.length === 0) messages.push({ role: "user", content: "" });
  if (messages[0]!.role !== "user") messages.unshift({ role: "user", content: "" });

  const params = body[CLIENT_PARAMS];
  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    // Required by Anthropic, unlike OpenAI where it may be omitted.
    max_tokens: params?.max_output_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  // The system prompt is a top-level field, not a turn.
  if (body.instructions) out.system = body.instructions;

  const temperature = params?.temperature ?? body.temperature;
  const topP = params?.top_p ?? body.top_p;
  if (typeof temperature === "number") out.temperature = temperature;
  if (typeof topP === "number") out.top_p = topP;
  return out;
}

/** Anthropic's stop reasons, in OpenAI's vocabulary. */
function finishReason(raw: unknown): "stop" | "length" | "tool_calls" {
  if (raw === "max_tokens") return "length";
  if (raw === "tool_use") return "tool_calls";
  return "stop";
}

/**
 * Map one Anthropic SSE frame to gateway events.
 *
 * Usage arrives in two halves — input tokens on `message_start`, output tokens
 * on `message_delta` — so both are tracked and re-emitted as a running total.
 */
export function mapAnthropicEvent(
  raw: Record<string, unknown>,
  seen: { inputTokens: number; outputTokens: number },
): CodexEvent[] {
  const out: CodexEvent[] = [];
  const type = raw.type;

  if (type === "message_start") {
    const usage = ((raw.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
    seen.inputTokens = Number(usage.input_tokens ?? 0);
    seen.outputTokens = Number(usage.output_tokens ?? 0);
    return out;
  }

  if (type === "content_block_delta") {
    const delta = (raw.delta ?? {}) as Record<string, unknown>;
    // `thinking_delta` is reasoning, which is not assistant text.
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      out.push({ kind: "reasoning", delta: delta.thinking });
    } else if (typeof delta.text === "string" && delta.text) {
      out.push({ kind: "text", delta: delta.text });
    }
    return out;
  }

  if (type === "message_delta") {
    const usage = (raw.usage ?? {}) as Record<string, unknown>;
    if (typeof usage.output_tokens === "number") seen.outputTokens = usage.output_tokens;
    const stop = (raw.delta as Record<string, unknown> | undefined)?.stop_reason;

    out.push({
      kind: "usage",
      usage: {
        prompt_tokens: seen.inputTokens,
        completion_tokens: seen.outputTokens,
        total_tokens: seen.inputTokens + seen.outputTokens,
      },
    });
    if (stop) out.push({ kind: "done", finishReason: finishReason(stop) });
    return out;
  }

  if (type === "error") {
    const err = (raw.error ?? {}) as Record<string, unknown>;
    out.push({ kind: "error", status: 502, body: err });
  }
  return out;
}
