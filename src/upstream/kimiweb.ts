/**
 * Kimi Web transport (Moonshot, www.kimi.com).
 *
 * Kimi's consumer chat speaks Connect-RPC rather than SSE: each message is a
 * JSON body behind a 5-byte envelope (1 flag byte + 4-byte big-endian length),
 * both on the way out and back. The response stream is a sequence of those
 * frames carrying deltas tagged with a `mask`:
 *
 *   block.text.content   → assistant text
 *   block.think.content  → reasoning
 *
 * with `op: "set"` for the first value and `op: "append"` after.
 *
 * Chosen as the first web-session provider because it is plain `fetch`: no
 * headless browser, and no per-request proof-of-work.
 */

import { createLogger } from "../logging.js";
import { classifyHttp, classifyTransport, type UpstreamFailure } from "../pool/errors.js";
import type { Credential } from "../pool/types.js";
import type { CodexEvent, CodexRequest } from "./translate.js";

const log = createLogger({ mod: "kimi-web" });

const BASE_URL = "https://www.kimi.com";
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Wrap a JSON message in the Connect envelope: flags byte + 4-byte length. */
export function frameConnect(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0; // uncompressed
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/**
 * Pull whole Connect frames out of a rolling buffer.
 *
 * Returns the messages that are fully present and the bytes left over, so the
 * caller can carry a partial frame across chunk boundaries.
 */
export function unframeConnect(buffer: Uint8Array<ArrayBufferLike>): {
  messages: unknown[];
  rest: Uint8Array<ArrayBufferLike>;
} {
  const messages: unknown[] = [];
  let offset = 0;

  while (buffer.length - offset >= 5) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
    const length = view.getUint32(1, false);
    if (buffer.length - offset - 5 < length) break; // frame not complete yet

    const body = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;

    const text = new TextDecoder().decode(body);
    if (!text.trim()) continue;
    try {
      messages.push(JSON.parse(text));
    } catch {
      log.debug("kimi_unparseable_frame", { length });
    }
  }

  return { messages, rest: buffer.subarray(offset) };
}

/**
 * Flatten the conversation into one prompt.
 *
 * Kimi's web chat is stateless from our side — we never hold a conversation
 * id — so a follow-up would otherwise lose all prior context. Single-turn
 * requests are passed through as just the user's text; multi-turn requests get
 * a labelled transcript.
 */
export function buildKimiPrompt(body: CodexRequest): { prompt: string; systemPrompt: string } {
  const system: string[] = [];
  const turns: Array<{ role: string; text: string }> = [];

  if (body.instructions) system.push(body.instructions);

  for (const item of body.input) {
    if (item.type !== "message") continue;
    const parts = (item.content as Array<Record<string, unknown>> | undefined) ?? [];
    const text = parts.map((p) => String(p.text ?? "")).join("").trim();
    if (!text) continue;
    turns.push({ role: String(item.role), text });
  }

  const lastUserIdx = turns.map((t) => t.role).lastIndexOf("user");
  const lastUser = lastUserIdx >= 0 ? turns[lastUserIdx]!.text : "";
  const prior = turns.slice(0, Math.max(0, lastUserIdx));

  if (prior.length === 0) {
    return { prompt: lastUser, systemPrompt: system.join("\n\n") };
  }

  const transcript = prior
    .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`)
    .join("\n");

  return {
    prompt: `Previous conversation:\n${transcript}\n\nCurrent user message:\n${lastUser}`,
    systemPrompt: system.join("\n\n"),
  };
}

function requestBody(body: CodexRequest, prompt: string, systemPrompt: string): string {
  return JSON.stringify({
    chat_id: "",
    scenario: "SCENARIO_K2",
    tools: [],
    message: {
      id: "",
      parent_id: "",
      children_message_ids: [],
      role: "user",
      blocks: [{ id: "", message_id: "", text: { content: prompt } }],
      scenario: "SCENARIO_K2",
      labels: [],
      references: [],
      is_goal: false,
    },
    options: {
      thinking: body.model.includes("thinking"),
      // Kimi's built-in audio/ask-user plugins emit event types this transport
      // cannot map onto chat completions.
      enable_plugin: false,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    },
    project_id: "",
  });
}

export type KimiResult =
  | { ok: true; response: Response }
  | { ok: false; failure: UpstreamFailure };

/**
 * Validate a pasted session credential without storing it.
 *
 * A cheap authenticated GET is enough: it distinguishes "this token works"
 * from "this token is stale" without spending a chat turn.
 */
export async function checkKimiSession(
  token: string,
): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now();
  try {
    /*
     * Probe the chat endpoint itself rather than a user-info route.
     *
     * A guessed side endpoint answered 404 regardless of the token, which
     * reports every credential as broken. The chat path is the one we know is
     * correct, and it is also the one that actually has to work.
     */
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/connect+json",
        accept: "*/*",
        "user-agent": USER_AGENT,
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        "connect-protocol-version": "1",
        authorization: `Bearer ${token}`,
      },
      body: frameConnect(
        JSON.stringify({
          chat_id: "",
          scenario: "SCENARIO_K2",
          tools: [],
          message: {
            id: "",
            parent_id: "",
            children_message_ids: [],
            role: "user",
            blocks: [{ id: "", message_id: "", text: { content: "hi" } }],
            scenario: "SCENARIO_K2",
            labels: [],
            references: [],
            is_goal: false,
          },
          options: { thinking: false, enable_plugin: false },
          project_id: "",
        }),
      ),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, message: `Kimi answered HTTP ${res.status}.`, latencyMs };
    }

    /*
     * A rejected token still returns 200 — the failure is the first frame:
     *   {"error":{"code":"unauthenticated","message":"invalid user token"}}
     * so the body has to be read to tell a good session from a bad one.
     */
    const buf = new Uint8Array(await res.arrayBuffer());
    const { messages } = unframeConnect(buf);

    for (const msg of messages) {
      const frame = msg as Record<string, unknown>;
      const error = frame.error as Record<string, unknown> | undefined;
      if (error) {
        return {
          ok: false,
          message:
            error.code === "unauthenticated"
              ? "Kimi rejected the token. Sign in again and copy a fresh access_token."
              : `Kimi returned ${String(error.code ?? "an error")}: ${String(error.message ?? "")}`,
          latencyMs,
        };
      }
    }

    return { ok: true, message: "Kimi accepted the session.", latencyMs };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach Kimi — ${(err as Error).message}`,
      latencyMs: Date.now() - started,
    };
  }
}

export async function callKimiWeb(
  credential: Credential,
  body: CodexRequest,
  signal: AbortSignal,
): Promise<KimiResult> {
  const token = credential.accessToken;
  if (!token) {
    return {
      ok: false,
      failure: {
        kind: "terminal",
        status: 401,
        code: "missing_session",
        message: "This Kimi connection has no session token. Re-paste it from the browser.",
        resetsAt: null,
        usageLimited: false,
      },
    };
  }

  const { prompt, systemPrompt } = buildKimiPrompt(body);

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/connect+json",
        accept: "*/*",
        "user-agent": USER_AGENT,
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        "connect-protocol-version": "1",
        authorization: `Bearer ${token}`,
      },
      body: frameConnect(requestBody(body, prompt, systemPrompt)),
      signal,
    });

    if (res.ok) return { ok: true, response: res };

    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    // An expired web session comes back as 401/403. That is terminal for this
    // credential — no refresh exists, the user has to paste a new one.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        failure: {
          kind: "terminal",
          status: res.status,
          code: "session_expired",
          message:
            "Kimi rejected the session token. Sign in again at www.kimi.com and paste a " +
            "fresh access_token.",
          resetsAt: null,
          usageLimited: false,
        },
      };
    }
    return { ok: false, failure: classifyHttp(res.status, parsed, text) };
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
}

/**
 * Map one decoded Connect frame onto our normalised events.
 *
 * `op: "set"` replaces what has been emitted so far and `op: "append"` adds to
 * it, so the caller passes the running text back in to work out the delta.
 */
export function mapKimiFrame(frame: Record<string, unknown>, seen: KimiSeen): CodexEvent[] {
  const out: CodexEvent[] = [];

  /*
   * An auth failure arrives as a normal 200 with an error frame, so this is
   * the only place a bad token shows up. Checking the HTTP status instead
   * reports every credential as working.
   */
  const error = frame.error as Record<string, unknown> | undefined;
  if (error) {
    const code = String(error.code ?? "");
    out.push({
      kind: "error",
      status: code === "unauthenticated" ? 401 : 502,
      body: error,
    });
    return out;
  }

  const mask = typeof frame.mask === "string" ? frame.mask : "";
  const op = typeof frame.op === "string" ? frame.op : "append";
  const block = frame.block as Record<string, unknown> | undefined;

  /*
   * Content arrives per block: `{mask:"block.text", block:{id, text:{content}}}`.
   * With `op:"set"` the content is the whole value for that block so far, so
   * the delta is whatever is new relative to what we already emitted for it.
   */
  const emit = (kind: "text" | "reasoning", field: "text" | "think") => {
    const holder = block?.[field] as Record<string, unknown> | undefined;
    const value = typeof holder?.content === "string" ? holder.content : "";
    if (!value) return;

    const key = `${field}:${String(block?.id ?? "0")}`;
    const already = seen.blocks[key] ?? "";

    let delta: string;
    if (op === "set") {
      delta = value.startsWith(already) ? value.slice(already.length) : value;
      seen.blocks[key] = value;
    } else {
      delta = value;
      seen.blocks[key] = already + value;
    }
    if (delta) out.push({ kind, delta } as CodexEvent);
  };

  /*
   * Two masks carry the same field. A reply opens with
   * `{mask:"block.text", op:"set"}` and continues with
   * `{mask:"block.text.content", op:"append"}` — the value sits at
   * `block.text.content` either way. Handling only the first mask truncated
   * every reply to its opening chunk.
   */
  if (mask === "block.text" || mask === "block.text.content") emit("text", "text");
  else if (mask === "block.think" || mask === "block.think.content") emit("reasoning", "think");

  // The assistant message flips to COMPLETED when generation finishes.
  const message = frame.message as Record<string, unknown> | undefined;
  if (message?.role === "assistant" && message.status === "MESSAGE_STATUS_COMPLETED") {
    out.push({ kind: "done", finishReason: "stop" });
  }

  return out;
}

/** Running content per block id, so `op:"set"` can be diffed into a delta. */
export interface KimiSeen {
  blocks: Record<string, string>;
}

export const newKimiSeen = (): KimiSeen => ({ blocks: {} });

/** Decode a Kimi Connect stream into normalised events. */
export async function* kimiEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<CodexEvent> {
  if (!response.body) {
    yield { kind: "error", status: 502, body: { message: "Kimi returned no body" } };
    return;
  }

  const reader = response.body.getReader();
  const seen = newKimiSeen();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let sawDone = false;

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);

      const { messages, rest } = unframeConnect(merged);
      buffer = rest;

      for (const msg of messages) {
        for (const ev of mapKimiFrame(msg as Record<string, unknown>, seen)) {
          if (ev.kind === "done") sawDone = true;
          yield ev;
        }
      }
    }
    // The stream can end without an explicit completion frame; the router
    // needs a terminal event either way.
    if (!sawDone) yield { kind: "done", finishReason: "stop" };
  } finally {
    reader.releaseLock();
    void response.body.cancel().catch(() => undefined);
  }
}
