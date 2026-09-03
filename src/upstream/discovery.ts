/**
 * Reading capability facts out of an OpenAI-shaped `/models` response.
 *
 * `GET /models` was only ever mined for ids, which is all the OpenAI spec
 * promises. But the endpoints this gateway actually talks to say considerably
 * more, and none of it was being read:
 *
 *   OpenRouter  architecture.input_modalities: ["text","image"]
 *               supported_parameters: ["tools","reasoning", …]
 *               context_length
 *   Together,
 *   Groq, vLLM  context_window / max_model_len, and sometimes a `vision` flag
 *   Ollama      details.families including "clip" for multimodal weights
 *
 * Anything absent stays `null` — "the endpoint did not say" — so the family
 * heuristic decides and the capability gate stays out of the way. Only a flag
 * the endpoint states outright becomes a fact that can refuse a request.
 */

import { discoveredModel, type DiscoveredModel } from "../core/model-metadata.js";

/** Read a boolean from any of several spellings a provider might use. */
function flag(source: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function numeric(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Turn one `/models` entry into a record.
 *
 * Returns null when there is no usable id, which keeps a malformed entry from
 * becoming a model the pool believes in.
 */
export function parseModelEntry(raw: unknown, at?: number): DiscoveredModel | null {
  const entry = asRecord(raw);
  const id = String(entry.id ?? entry.name ?? entry.model ?? "")
    .replace(/^models\//, "")
    .trim();
  if (!id) return null;

  const architecture = asRecord(entry.architecture);
  const details = asRecord(entry.details);
  const top = { ...entry, ...asRecord(entry.capabilities) };

  // OpenRouter states modalities explicitly, which makes it the one source
  // here that can prove the *absence* of image support as well as its
  // presence: an entry listing modalities and omitting "image" is a no.
  const modalities = [
    ...stringList(architecture.input_modalities),
    ...stringList(entry.input_modalities),
    ...stringList(top.input_modalities),
  ].map((m) => m.toLowerCase());

  let vision = flag(top, ["vision", "supports_vision", "supports_images", "multimodal"]);
  if (vision === null && modalities.length) {
    vision = modalities.includes("image");
  }
  if (vision === null && stringList(details.families).includes("clip")) {
    // Ollama tags multimodal weights with the CLIP projector family. Its
    // absence proves nothing, so this only ever sets true.
    vision = true;
  }

  const parameters = [
    ...stringList(entry.supported_parameters),
    ...stringList(top.supported_parameters),
  ].map((p) => p.toLowerCase());

  let reasoning = flag(top, ["reasoning", "supports_reasoning", "supports_thinking"]);
  if (reasoning === null && parameters.length) {
    reasoning = parameters.some((p) => p === "reasoning" || p === "reasoning_effort");
  }

  let tools = flag(top, ["tools", "supports_tools", "function_calling", "supports_functions"]);
  if (tools === null && parameters.length) {
    tools = parameters.some((p) => p === "tools" || p === "tool_choice" || p === "functions");
  }

  return discoveredModel(
    id,
    {
      displayName: typeof entry.name === "string" && entry.name !== id ? entry.name : null,
      vision,
      reasoning,
      tools,
      contextWindow: numeric({ ...top, ...details }, [
        "context_length",
        "context_window",
        "max_context_window",
        "max_model_len",
        "max_input_tokens",
      ]),
    },
    at,
  );
}

/**
 * Parse a whole `/models` body.
 *
 * Handles the standard `{data: […]}` envelope, Ollama's `{models: […]}`, and a
 * bare array, because "OpenAI-compatible" is a claim rather than a guarantee.
 */
export function parseModelList(payload: unknown, at?: number): DiscoveredModel[] {
  const body = asRecord(payload);
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.models)
        ? body.models
        : [];

  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const model = parseModelEntry(entry, at);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Fetch and parse `GET {baseUrl}/models` from an OpenAI-compatible endpoint. */
export async function fetchOpenAiDiscovery(
  baseUrl: string,
  accessToken: string | null,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${base}/models`, {
    headers,
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${base}/models returned HTTP ${response.status}`);
  }
  return parseModelList(await response.json().catch(() => null));
}
