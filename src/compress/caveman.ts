/**
 * Caveman — prompt compression via an external summarising model.
 *
 * Design constraints that shape everything here:
 *
 *  - The summariser runs on a **separate** OpenAI-compatible endpoint, not on
 *    the credential pool. Compressing through the pool would spend the exact
 *    quota compression exists to conserve.
 *  - Compression must never be able to break a request. Every failure path
 *    returns the original messages untouched. A slow or dead summariser
 *    degrades throughput, never correctness.
 *  - The newest turns and the system prompt are always forwarded verbatim.
 *    Only the older middle of the conversation is candidate for rewriting.
 *  - Output is **measured only**. The client always receives the model's real
 *    response; we record what compressing it would have saved, and nothing else.
 */

import type { CavemanConfig } from "../config.js";
import type { CavemanHistory } from "./history.js";
import { createLogger } from "../logging.js";
import type { OpenAIMessage } from "../upstream/translate.js";

const log = createLogger({ mod: "caveman" });

/**
 * Cheap token estimate. Deliberately not a real tokeniser: this only gates
 * whether compression is worth attempting, and shipping a BPE table to make a
 * threshold check marginally more accurate is not a good trade.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function messageText(msg: OpenAIMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => p.text ?? "").join("");
  }
  return "";
}

export function estimateMessageTokens(messages: OpenAIMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(messageText(m)) + 4, 0);
}

const FENCE = /```[\s\S]*?```/g;

/**
 * Placeholder swapped in for fenced code before summarising.
 *
 * It must survive a round trip through a language model, so it is ordinary
 * printable text the model can copy verbatim rather than a control character.
 * The double-bracket form is unlikely to collide with real prose.
 */
const marker = (i: number) => `[[CODE_${i}]]`;
const MARKER_RE = /\[\[CODE_(\d+)\]\]/g;


/**
 * Lift fenced code blocks out before summarising and put them back after.
 * A summariser will happily paraphrase code into something that no longer
 * compiles, which for a coding agent is worse than no compression at all.
 */
function protectCode(text: string): { masked: string; blocks: string[] } {
  const blocks: string[] = [];
  const masked = text.replace(FENCE, (block) => {
    blocks.push(block);
    return marker(blocks.length - 1);
  });
  return { masked, blocks };
}

function restoreCode(text: string, blocks: string[]): string {
  return text.replace(MARKER_RE, (whole, idx: string) => {
    const block = blocks[Number(idx)];
    return block ?? whole;
  });
}

/**
 * True when every placeholder the original contained is still present in the
 * summary. A model that drops one has dropped a whole code block, so the
 * caller must fall back to the uncompressed prompt.
 */
function markersIntact(summary: string, blocks: string[]): boolean {
  if (blocks.length === 0) return true;
  const seen = new Set<number>();
  for (const m of summary.matchAll(MARKER_RE)) seen.add(Number(m[1]));
  return blocks.every((_, i) => seen.has(i));
}

export interface CompressionResult {
  messages: OpenAIMessage[];
  /** Estimated tokens before and after. Equal when nothing was compressed. */
  before: number;
  after: number;
  compressed: boolean;
  /** Populated when compression was attempted and failed. */
  error: string | null;
}

export interface OutputMeasurement {
  measured: number;
  wouldSave: number;
}

/**
 * Call the configured summariser. Returns null on any failure — callers treat
 * null as "forward the original".
 */
async function summarise(
  cfg: CavemanConfig,
  text: string,
  budgetTokens: number,
): Promise<string | null> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "ai-auther-caveman",
  };
  // Header only. A key in a query string leaks into every log on the path.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: cfg.instruction },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: Math.max(256, Math.ceil(budgetTokens)),
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("caveman_http_error", { status: res.status, body: body.slice(0, 200) });
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (err) {
    log.warn("caveman_request_failed", { err });
    return null;
  }
}

/**
 * Compress the older middle of a conversation.
 *
 * Never throws. On any failure the original messages come back unchanged and
 * `error` explains why, so the UI can show that compression is misconfigured
 * without the request having suffered for it.
 */
export async function compressMessages(
  cfg: CavemanConfig,
  messages: OpenAIMessage[],
  /** Optional recorder. Compression works exactly the same without one. */
  history?: CavemanHistory,
): Promise<CompressionResult> {
  const startedAt = Date.now();
  const before = estimateMessageTokens(messages);
  const untouched: CompressionResult = {
    messages,
    before,
    after: before,
    compressed: false,
    error: null,
  };

  /*
   * Record the skip reasons too, not just the attempts.
   *
   * "Why did nothing get compressed?" is the most common question about this
   * feature, and it is unanswerable if the paths that decline to compress
   * leave no trace.
   */
  const skip = (reason: string) =>
    history?.record({
      outcome: "skipped",
      model: cfg.model || null,
      beforeTokens: before,
      afterTokens: before,
      latencyMs: Date.now() - startedAt,
      inputText: null,
      outputText: null,
      error: reason,
    });

  if (!cfg.enabled) return untouched;
  if (!cfg.baseUrl || !cfg.model) {
    skip("Enabled but no endpoint or model configured.");
    return { ...untouched, error: "Caveman is enabled but has no endpoint or model configured." };
  }
  if (before < cfg.minTokens) {
    skip(`Prompt is ${before} tokens, below the ${cfg.minTokens} minimum.`);
    return untouched;
  }

  // System/developer messages are instructions, not context. Rewriting them
  // changes behaviour rather than saving space.
  const leading: OpenAIMessage[] = [];
  let i = 0;
  while (i < messages.length && (messages[i]!.role === "system" || messages[i]!.role === "developer")) {
    leading.push(messages[i]!);
    i += 1;
  }

  const body = messages.slice(i);
  const keep = Math.min(cfg.keepRecentMessages, body.length);
  const recent = keep > 0 ? body.slice(body.length - keep) : [];
  const middle = body.slice(0, body.length - keep);

  // Tool call/result pairs must stay adjacent and intact; a summarised
  // function_call_output would break the client's tool loop.
  const compressible = middle.filter((m) => m.role !== "tool" && !m.tool_calls?.length);
  const passthrough = middle.filter((m) => m.role === "tool" || m.tool_calls?.length);

  if (compressible.length < 2) {
    skip(
      `Only ${compressible.length} turn(s) are old enough to compress — ` +
        `"keep recent messages verbatim" is set to ${cfg.keepRecentMessages}.`,
    );
    return untouched;
  }

  const transcript = compressible
    .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
    .join("\n\n");

  const { masked, blocks } = cfg.preserveCode
    ? protectCode(transcript)
    : { masked: transcript, blocks: [] as string[] };

  const budget = Math.ceil(estimateTokens(masked) * cfg.targetRatio);
  const summary = await summarise(cfg, masked, budget);

  /** Every exit below this point is a real attempt, so all of them are logged. */
  const note = (
    outcome: Parameters<CavemanHistory["record"]>[0]["outcome"],
    output: string | null,
    error: string | null,
    after = before,
  ) =>
    history?.record({
      outcome,
      model: cfg.model,
      beforeTokens: before,
      afterTokens: after,
      latencyMs: Date.now() - startedAt,
      inputText: masked,
      outputText: output,
      error,
    });

  if (!summary) {
    note("failed", null, "Summariser returned no usable output.");
    return { ...untouched, error: "Summariser did not return usable output; sent original." };
  }

  // If the model dropped a placeholder it has silently deleted a code block.
  // Sending that on would look like successful compression while having lost
  // the most important part of the context.
  if (cfg.preserveCode && !markersIntact(summary, blocks)) {
    log.warn("caveman_dropped_code", { blocks: blocks.length });
    note("failed", summary, "Summariser dropped a code placeholder.");
    return {
      ...untouched,
      error: "Summariser dropped a code placeholder; sent original to avoid losing code.",
    };
  }

  const restored = cfg.preserveCode ? restoreCode(summary, blocks) : summary;

  const rebuilt: OpenAIMessage[] = [
    ...leading,
    {
      role: "user",
      content: `[Compressed context]\n${restored}`,
    },
    ...passthrough,
    ...recent,
  ];

  const after = estimateMessageTokens(rebuilt);

  // A summariser can produce something longer than its input. Silently keeping
  // that would make Caveman actively harmful.
  if (after >= before) {
    log.info("caveman_no_gain", { before, after });
    note("no_gain", restored, "Summary was no smaller than the original.", after);
    return untouched;
  }

  note("compressed", restored, null, after);
  log.info("caveman_compressed", { before, after, saved: before - after });
  return { messages: rebuilt, before, after, compressed: true, error: null };
}

/**
 * Measure what compressing a response *would* have saved. Measurement only —
 * the caller has already sent this text to the client verbatim.
 */
export function measureOutput(cfg: CavemanConfig, text: string): OutputMeasurement | null {
  if (!cfg.measureOutput || !text) return null;
  const measured = estimateTokens(text);

  // Estimate the compressible share without calling anything: prose compresses,
  // fenced code does not, because Caveman would never rewrite it.
  let codeChars = 0;
  for (const block of text.match(FENCE) ?? []) codeChars += block.length;
  const proseChars = Math.max(0, text.length - codeChars);
  const proseTokens = Math.ceil(proseChars / 4);

  return {
    measured,
    wouldSave: Math.round(proseTokens * (1 - cfg.targetRatio)),
  };
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  model: string | null;
}

/** Powers the "Test connection" button on the Caveman page. */
export async function testConnection(cfg: CavemanConfig): Promise<ConnectionTest> {
  if (!cfg.baseUrl) return { ok: false, message: "No base URL set.", latencyMs: null, model: null };
  if (!cfg.model) return { ok: false, message: "No model selected.", latencyMs: null, model: null };

  const started = Date.now();
  const result = await summarise(
    cfg,
    "USER: hello there, I hope you are having a wonderful day today\n\n" +
      "ASSISTANT: thank you very much, that is very kind of you to say",
    64,
  );
  const latencyMs = Date.now() - started;

  return result
    ? { ok: true, message: "Connected and returned output.", latencyMs, model: cfg.model }
    : {
        ok: false,
        message: "Endpoint reachable check failed. Verify the base URL, key and model name.",
        latencyMs,
        model: cfg.model,
      };
}

/** List models from the endpoint so the UI can offer a picker. */
export async function listModels(cfg: CavemanConfig): Promise<string[]> {
  if (!cfg.baseUrl) return [];
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
