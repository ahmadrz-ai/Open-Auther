/** Hermes-compatible transport helpers for the ChatGPT Codex OAuth backend. */

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

/** Fetch the account-specific Codex catalog, preserving Codex-only slugs. */
export async function fetchCodexModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<string[]> {
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
    models?: Array<{ slug?: unknown; priority?: unknown; visibility?: unknown }>;
  } | null;
  const entries = Array.isArray(payload?.models) ? payload.models : [];
  return entries
    .filter((entry) => {
      const visibility = typeof entry.visibility === "string" ? entry.visibility.toLowerCase() : "";
      return visibility !== "hide" && visibility !== "hidden";
    })
    .map((entry) => ({
      slug: typeof entry.slug === "string" ? entry.slug.trim() : "",
      priority: typeof entry.priority === "number" ? entry.priority : 10_000,
    }))
    .filter((entry) => Boolean(entry.slug))
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug))
    .map((entry) => entry.slug);
}
