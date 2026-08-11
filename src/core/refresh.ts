/**
 * Access-token refresh.
 *
 * Refresh tokens from this issuer are single-use: the moment a refresh
 * succeeds, the old refresh token is void, and presenting it again returns
 * `refresh_token_reused` and kills the credential for good. So every refresh
 * runs inside the credential's exclusive lock, and any waiter that arrives
 * afterwards re-reads state and discovers the work is already done.
 */

import { now } from "../db.js";
import { createLogger, maskEmail, registerSecret } from "../logging.js";
import { classifyHttp, classifyTransport, type UpstreamFailure } from "../pool/errors.js";
import type { CredentialStore } from "../pool/store.js";
import type { Credential } from "../pool/types.js";
import type { Config } from "../config.js";
import { AntigravityRefreshError, refreshAntigravityToken } from "./antigravity.js";
import { accessTokenExpiry, decodeIdToken } from "./jwt.js";

const log = createLogger({ mod: "refresh" });

export class RefreshError extends Error {
  constructor(
    readonly failure: UpstreamFailure,
    readonly credentialId: number,
  ) {
    super(`token refresh failed: ${failure.code ?? failure.status}`);
    this.name = "RefreshError";
  }
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

function tokenEndpoint(cfg: Config): string {
  return `${cfg.oauthIssuer.replace(/\/+$/, "")}/oauth/token`;
}

/** True when the stored access token is missing, expired, or about to expire. */
export function needsRefresh(c: Credential, cfg: Config, at: number = now()): boolean {
  if (!c.accessToken) return true;
  if (c.accessExpiresAt === null) return false; // unknown expiry: let upstream decide
  return c.accessExpiresAt - cfg.refreshSkewSeconds <= at;
}

/**
 * Return a credential with a usable access token, refreshing under lock if
 * needed. Throws `RefreshError` on failure; terminal failures also mark the
 * credential dead before throwing.
 */
export async function ensureFreshToken(
  store: CredentialStore,
  cfg: Config,
  credentialId: number,
): Promise<Credential> {
  return store.withCredentialLock(credentialId, async () => {
    // Re-read inside the lock: a queued waiter may have refreshed already.
    const current = store.get(credentialId);
    if (!current) throw new Error(`credential ${credentialId} no longer exists`);
    if (!needsRefresh(current, cfg)) return current;

    if (!current.refreshToken) {
      store.markDead(credentialId, "no_refresh_token");
      throw new RefreshError(
        {
          kind: "terminal",
          status: 401,
          code: "no_refresh_token",
          message: "credential has no refresh token and its access token has expired",
          resetsAt: null,
          usageLimited: false,
        },
        credentialId,
      );
    }

    log.debug("refresh_start", { credential: credentialId, email: maskEmail(current.email) });

    // Antigravity is a Google OAuth client, not the OpenAI issuer — different
    // token endpoint, and its refresh tokens are reusable rather than single
    // use. Everything else about the locking contract is unchanged.
    if (current.providerType === "antigravity") {
      try {
        const refreshed = await refreshAntigravityToken(current.refreshToken);
        store.updateTokens(credentialId, {
          accessToken: refreshed.accessToken,
          accessExpiresAt: refreshed.expiresAt,
        });
        log.info("refresh_ok", { credential: credentialId, provider: "antigravity" });
        return store.get(credentialId)!;
      } catch (err) {
        /*
         * Only a rejected grant is final.
         *
         * Killing the credential on any failure meant one 503 or dropped
         * connection permanently removed a working Google account: it went
         * `dead` with `antigravity_refresh_failed` and stayed there, even though
         * the very next refresh attempt would have succeeded. Cool it down
         * instead and let it come back.
         */
        const revoked = err instanceof AntigravityRefreshError ? err.revoked : false;
        if (revoked) {
          store.markDead(credentialId, "antigravity_refresh_failed");
        } else {
          store.markCooling(
            credentialId,
            now() + Math.max(60, cfg.defaultCooldownSeconds),
            "antigravity_refresh_unavailable",
          );
        }

        throw new RefreshError(
          {
            kind: revoked ? "terminal" : "transient",
            status: err instanceof AntigravityRefreshError ? err.status : 500,
            code: revoked ? "antigravity_refresh_failed" : "antigravity_refresh_unavailable",
            message: (err as Error).message,
            resetsAt: null,
            usageLimited: false,
          },
          credentialId,
        );
      }
    }

    const codexRefresh = current.providerType === "codex_oauth";
    let res: Response;
    try {
      const refreshPayload = codexRefresh
        ? new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: current.refreshToken,
            client_id: cfg.oauthClientId,
          }).toString()
        : JSON.stringify({
            grant_type: "refresh_token",
            client_id: cfg.oauthClientId,
            refresh_token: current.refreshToken,
            scope: "openid profile email offline_access",
          });
      res = await fetch(tokenEndpoint(cfg), {
        method: "POST",
        headers: {
          "content-type": codexRefresh ? "application/x-www-form-urlencoded" : "application/json",
          accept: "application/json",
          "user-agent": codexRefresh ? "codex_cli_rs/0.0.0 (Hermes Agent)" : "ai-auther",
        },
        body: refreshPayload,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Transport failure. The refresh token was probably not consumed, but we
      // cannot know that, so the caller cools the credential rather than
      // retrying it immediately.
      throw new RefreshError(classifyTransport(err), credentialId);
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const failure = classifyHttp(res.status, body, text);
      if (failure.kind === "terminal") {
        store.markDead(credentialId, failure.code ?? `http_${failure.status}`);
      }
      log.warn("refresh_failed", {
        credential: credentialId,
        status: failure.status,
        code: failure.code,
        kind: failure.kind,
      });
      throw new RefreshError(failure, credentialId);
    }

    const tokens = (body ?? {}) as TokenResponse;
    if (!tokens.access_token) {
      throw new RefreshError(
        {
          kind: "transient",
          status: res.status,
          code: "malformed_token_response",
          message: "token endpoint returned 200 with no access_token",
          resetsAt: null,
          usageLimited: false,
        },
        credentialId,
      );
    }

    registerSecret(tokens.access_token);
    registerSecret(tokens.refresh_token);
    registerSecret(tokens.id_token);

    const expiresAt =
      typeof tokens.expires_in === "number"
        ? now() + tokens.expires_in
        : (accessTokenExpiry(tokens.access_token) ?? now() + 3600);

    store.updateTokens(credentialId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? current.refreshToken,
      idToken: tokens.id_token ?? current.idToken,
      accessExpiresAt: expiresAt,
    });

    // A new id_token may carry an updated plan type (e.g. after an upgrade).
    if (tokens.id_token) {
      const claims = decodeIdToken(tokens.id_token);
      if (claims?.planType && claims.planType !== current.planType) {
        store.record("plan_changed", credentialId, {
          from: current.planType,
          to: claims.planType,
        });
      }
    }

    log.info("refresh_ok", { credential: credentialId, expires_in: expiresAt - now() });
    return store.get(credentialId)!;
  });
}
