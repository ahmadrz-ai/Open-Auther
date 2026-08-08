/**
 * id_token claim extraction.
 *
 * We decode without verifying the signature, and that is deliberate: the token
 * was just handed to us over TLS by the issuer, and we use the claims only to
 * label and deduplicate credentials locally. Nothing security-relevant is
 * granted on the basis of these claims — the access token is what upstream
 * actually validates. Do not repurpose this for authorisation decisions.
 */

export interface IdTokenClaims {
  email: string | null;
  accountId: string | null;
  planType: string | null;
  /** Epoch seconds, if present. */
  exp: number | null;
  raw: Record<string, unknown>;
}

/** OpenAI namespaces its custom claims under this key. */
const AUTH_NS = "https://api.openai.com/auth";

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Decode a JWT payload and pull out the claims the pool cares about.
 * Returns null if the input is not a well-formed three-segment JWT.
 */
export function decodeIdToken(token: string | null | undefined): IdTokenClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;

  const payload = decodeSegment(parts[1]);
  if (!payload) return null;

  const ns = (payload[AUTH_NS] ?? {}) as Record<string, unknown>;

  return {
    email: pickString(payload.email, ns.email, payload.preferred_username),
    accountId: pickString(
      ns.chatgpt_account_id,
      payload.chatgpt_account_id,
      ns.account_id,
      payload.account_id,
      // Fall back to the subject so a token without the namespaced claim still
      // dedupes against itself rather than being added twice.
      payload.sub,
    ),
    planType: pickString(
      ns.chatgpt_plan_type,
      payload.chatgpt_plan_type,
      ns.plan_type,
      payload.plan_type,
    ),
    exp: typeof payload.exp === "number" ? payload.exp : null,
    raw: payload,
  };
}

/** Read `exp` from an access token when the token endpoint omits `expires_in`. */
export function accessTokenExpiry(token: string | null | undefined): number | null {
  const claims = decodeIdToken(token);
  return claims?.exp ?? null;
}
