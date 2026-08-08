/**
 * Interactive account onboarding.
 *
 * A note on terminology: this is the PKCE authorization-code flow with a
 * loopback redirect, which is what the Codex client actually performs. It is
 * often loosely called "the device-code flow"; it is not RFC 8628. The
 * practical consequence is the same and it is the one that bites people:
 *
 *   If the browser already holds a ChatGPT session, the flow completes
 *   silently against THAT account and hands back a credential for an account
 *   already in the pool. The duplicate then dies instantly with the same
 *   reset timestamp as its twin. Always use a fresh private window.
 *
 * We defend against it structurally by deduplicating on chatgpt_account_id.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger, registerSecret } from "../logging.js";
import { now } from "../db.js";
import type { Config } from "../config.js";
import { decodeIdToken } from "./jwt.js";
import type { TokenResponse } from "./refresh.js";

const log = createLogger({ mod: "login" });

/** The Codex client registers this exact loopback URI; it cannot be changed. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

export interface LoginResult {
  accountId: string;
  email: string | null;
  planType: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: number | null;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(cfg: Config, challenge: string, state: string): string {
  const url = new URL(`${cfg.oauthIssuer.replace(/\/+$/, "")}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.oauthClientId);
  url.searchParams.set("redirect_uri", `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

const DONE_PAGE = (title: string, message: string, ok: boolean) => `<!doctype html>
<meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1117;
       color:#e6e8ef;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
  .card{max-width:26rem;padding:2.5rem;border-radius:20px;text-align:center;
        background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);
        backdrop-filter:blur(18px)}
  h1{margin:0 0 .6rem;font-size:1.15rem;font-weight:600;color:${ok ? "#7ee2b8" : "#ff8b8b"}}
  p{margin:0;color:#9aa2b6}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p></div>`;

/** Wait for the loopback redirect and return the authorization code. */
function awaitCallback(
  expectedState: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? "";
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Sign-in failed", "You can close this tab.", false));
        finish(() => reject(new Error(`authorization failed: ${error} ${desc}`.trim())));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Sign-in failed", "No authorization code was returned.", false));
        finish(() => reject(new Error("callback did not include an authorization code")));
        return;
      }
      if (state !== expectedState) {
        // CSRF guard. A mismatched state means this response is not ours.
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Sign-in failed", "State mismatch. Please try again.", false));
        finish(() => reject(new Error("state mismatch on OAuth callback")));
        return;
      }

      registerSecret(code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        DONE_PAGE(
          "Account connected",
          "ai-auther has the credential. You can close this tab.",
          true,
        ),
      );
      finish(() => resolve(code));
    };

    const server = createServer(handler);
    server.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `Port ${CALLBACK_PORT} is already in use. Close any running Codex CLI login ` +
                  `or other ai-auther login and try again.`,
              )
            : err,
        ),
      );
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for the browser callback"))),
      timeoutMs,
    );

    signal?.addEventListener("abort", () => finish(() => reject(new Error("login cancelled"))));

    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

async function exchangeCode(cfg: Config, code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(`${cfg.oauthIssuer.replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "ai-auther",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: cfg.oauthClientId,
      code,
      redirect_uri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // `text` can contain the code; redaction covers logs, but this message may
    // reach a terminal, so only the status and a short prefix are surfaced.
    throw new Error(`token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export interface LoginHandle {
  /** URL the user must open. Printed by the CLI and opened in the browser. */
  authorizeUrl: string;
  /** Resolves once the browser has redirected back and tokens are exchanged. */
  completed: Promise<LoginResult>;
}

/**
 * Begin an interactive login. Returns immediately with the URL to visit and a
 * promise that settles when the flow completes.
 */
export function beginLogin(cfg: Config, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): LoginHandle {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl(cfg, challenge, state);

  const completed = (async () => {
    const code = await awaitCallback(state, opts.timeoutMs ?? 5 * 60_000, opts.signal);
    const tokens = await exchangeCode(cfg, code, verifier);

    if (!tokens.access_token) throw new Error("token exchange returned no access_token");
    registerSecret(tokens.access_token);
    registerSecret(tokens.refresh_token);
    registerSecret(tokens.id_token);

    const claims = decodeIdToken(tokens.id_token ?? tokens.access_token);
    if (!claims?.accountId) {
      throw new Error(
        "could not read chatgpt_account_id from the returned id_token; " +
          "refusing to add a credential that cannot be deduplicated",
      );
    }

    log.info("login_complete", { plan: claims.planType });

    return {
      accountId: claims.accountId,
      email: claims.email,
      planType: claims.planType,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
      accessExpiresAt:
        typeof tokens.expires_in === "number" ? now() + tokens.expires_in : (claims.exp ?? null),
    } satisfies LoginResult;
  })();

  return { authorizeUrl, completed };
}

/** Best-effort browser launch. Never fatal: the CLI always prints the URL too. */
export function openBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    try {
      const [cmd, args] =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    } catch {
      /* user opens it manually */
    }
  });
}
