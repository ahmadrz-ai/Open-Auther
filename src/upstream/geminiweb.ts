/**
 * Gemini Web session checking.
 *
 * There is no chat transport here yet — see the note at the bottom — but the
 * session check is worth having on its own, because the obvious way to write
 * it is wrong.
 *
 * The tempting check is "GET gemini.google.com/app and see if it 401s". It
 * never does: that URL answers HTTP 200 to a signed-out browser, to a
 * fabricated cookie, and to no cookie at all. Probed directly:
 *
 *   __Secure-1PSID=totally-made-up-value  -> 200
 *   no cookie at all                      -> 200
 *
 * So a status-based check reports every value as valid. The real signal is in
 * the page body: a signed-in session embeds an `SNlM0e` token (the XSRF value
 * the web app needs to talk to its own backend) and an anonymous page does
 * not. Presence of that token is what distinguishes a live session.
 */

import { request as httpsRequest } from "node:https";
import { createLogger } from "../logging.js";

const log = createLogger({ mod: "gemini-web" });

const APP_URL = "https://gemini.google.com/app";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** The XSRF token the signed-in app embeds. Absent when signed out. */
const SESSION_TOKEN = /"SNlM0e":"([^"]+)"/;

export interface GeminiSessionCheck {
  ok: boolean;
  message: string;
  latencyMs: number;
  /** Present when the session is live; also what a chat transport would need. */
  xsrfToken?: string;
}

/**
 * Normalise whatever the user pasted into a Cookie header.
 * A bare value is assumed to be the `__Secure-1PSID`.
 */
function cookieHeader(raw: string): string {
  const value = raw.trim().replace(/^cookie:\s*/i, "");
  if (!value) return "";
  return value.includes("=") ? value : `__Secure-1PSID=${value}`;
}

/**
 * GET the app page with a raised header limit.
 *
 * `fetch` cannot do this: Google answers with well over Node's default 16 KB
 * of response headers and undici aborts with HeadersOverflowError, which
 * surfaces as a bare "fetch failed" and looks like a network fault rather
 * than a limit we control.
 */
function getAppPage(
  cookie: string,
): Promise<{ status: number; location: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      APP_URL,
      {
        method: "GET",
        maxHeaderSize: 256 * 1024,
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie,
          origin: "https://gemini.google.com",
          referer: "https://gemini.google.com/",
          "user-agent": USER_AGENT,
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          // The token lives near the top; no need to buffer megabytes of app.
          if (bytes < 2_000_000) {
            chunks.push(chunk);
            bytes += chunk.length;
          }
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers.location ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );

    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function checkGeminiSession(raw: string): Promise<GeminiSessionCheck> {
  const cookie = cookieHeader(raw);
  const started = Date.now();

  if (!cookie) {
    return { ok: false, message: "No cookie supplied.", latencyMs: 0 };
  }

  try {
    const res = await getAppPage(cookie);
    const latencyMs = Date.now() - started;

    // A redirect to accounts.google.com means signed out, whatever the status.
    if (res.location.includes("accounts.google.com")) {
      return {
        ok: false,
        message: "Google redirected to sign-in — the cookie is not a live session.",
        latencyMs,
      };
    }

    const match = res.body.match(SESSION_TOKEN);

    if (match?.[1]) {
      return { ok: true, message: "Signed-in session confirmed.", latencyMs, xsrfToken: match[1] };
    }

    return {
      ok: false,
      message:
        `Reached Gemini (HTTP ${res.status}) but the page came back signed out. ` +
        `Copy __Secure-1PSID again from a tab where you are logged in — and include ` +
        `__Secure-1PSIDTS if it is present.`,
      latencyMs,
    };
  } catch (err) {
    log.debug("gemini_check_failed", { err });
    return {
      ok: false,
      message: `Could not reach gemini.google.com — ${(err as Error).message}`,
      latencyMs: Date.now() - started,
    };
  }
}

/*
 * Why there is no chat transport here yet.
 *
 * The reference implementation drives a headless Chromium for the actual
 * conversation, which is the weight this gateway exists to avoid. A pure-HTTP
 * path does look reachable — the `SNlM0e` token recovered above is exactly
 * what the web app posts to its own `StreamGenerate` endpoint — but that
 * endpoint returns a nested, positional JSON envelope with no published
 * schema, so it needs to be worked out against a live session rather than
 * guessed at. Not started, deliberately, rather than half-built.
 */
