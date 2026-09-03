/** Hermes-compatible transport helpers for the ChatGPT Codex OAuth backend. */

import { discoveredModel, type DiscoveredModel } from "../core/model-metadata.js";
import type { Credential } from "../pool/types.js";

export const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_MODELS_URL = `${CODEX_DEFAULT_BASE_URL}/models?client_version=1.0.0`;

/** Extract the account id the Codex backend expects from an OAuth access JWT. */
export function extractChatGptAccountId(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"];
    const accountId =
      auth && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : payload.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Headers used by Codex CLI/Hermes for the Cloudflare-protected Codex route.
 * The account id is derived from the current JWT every time so a refreshed
 * token cannot accidentally inherit stale metadata from the credential row.
 */
export function codexHeaders(credential: Credential, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.accessToken ?? ""}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: sessionId,
    "x-client-request-id": sessionId,
    "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
  };

  const accountId = extractChatGptAccountId(credential.accessToken) ?? credential.accountId;
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

interface CodexCatalogEntry {
  slug?: unknown;
  priority?: unknown;
  visibility?: unknown;
  display_name?: unknown;
  supported_features?: unknown;
  capabilities?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  supports_images?: unknown;
  supports_vision?: unknown;
  supports_reasoning?: unknown;
}

async function fetchCodexCatalog(
  accessToken: string,
  signal?: AbortSignal,
): Promise<CodexCatalogEntry[]> {
  const accountId = extractChatGptAccountId(accessToken);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const response = await fetch(CODEX_MODELS_URL, {
    method: "GET",
    headers,
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];

  const payload = (await response.json().catch(() => null)) as {
    models?: CodexCatalogEntry[];
  } | null;
  const entries = Array.isArray(payload?.models) ? payload.models : [];

  // `priority` is the order the ChatGPT client shows them in, which is a
  // better default ordering than alphabetical: the account's headline model
  // comes first, so probes and `auto` start from the right place.
  return entries
    .filter((entry) => {
      const visibility = typeof entry.visibility === "string" ? entry.visibility.toLowerCase() : "";
      return visibility !== "hide" && visibility !== "hidden";
    })
    .filter((entry) => typeof entry.slug === "string" && entry.slug.trim())
    .sort((a, b) => {
      const pa = typeof a.priority === "number" ? a.priority : 10_000;
      const pb = typeof b.priority === "number" ? b.priority : 10_000;
      return pa - pb || String(a.slug).localeCompare(String(b.slug));
    });
}

/** Fetch the account-specific Codex catalog, preserving Codex-only slugs. */
export async function fetchCodexModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await fetchCodexCatalog(accessToken, signal);
  return entries.map((entry) => String(entry.slug).trim());
}

/**
 * The same catalogue, keeping whatever the backend says about each model.
 *
 * The Codex `/models` route is undocumented and its payload has changed shape
 * more than once, so every field is read defensively and an absent one stays
 * null rather than being guessed at here — `inferCapabilities` is the right
 * place for a guess, and unlike this it is not allowed to refuse a request.
 */
export async function fetchCodexDiscovery(
  accessToken: string,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const entries = await fetchCodexCatalog(accessToken, signal);

  return entries.map((entry) => {
    const caps =
      entry.capabilities && typeof entry.capabilities === "object"
        ? (entry.capabilities as Record<string, unknown>)
        : {};
    const features = Array.isArray(entry.supported_features)
      ? entry.supported_features.filter((f): f is string => typeof f === "string")
      : [];
    const has = (name: string) => features.some((f) => f.toLowerCase() === name);

    const bool = (...values: unknown[]): boolean | null => {
      for (const value of values) if (typeof value === "boolean") return value;
      return null;
    };
    const num = (...values: unknown[]): number | null => {
      for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
      }
      return null;
    };

    let vision = bool(entry.supports_images, entry.supports_vision, caps.vision, caps.images);
    if (vision === null && features.length) vision = has("vision") || has("images");

    let reasoning = bool(entry.supports_reasoning, caps.reasoning);
    if (reasoning === null && features.length) reasoning = has("reasoning");

    return discoveredModel(String(entry.slug).trim(), {
      displayName: typeof entry.display_name === "string" ? entry.display_name : null,
      vision,
      reasoning,
      tools: features.length ? has("tools") || has("function_calling") : null,
      contextWindow: num(entry.context_window, entry.max_context_window, caps.context_window),
    });
  });
}
