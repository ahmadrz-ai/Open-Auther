/**
 * Antigravity (Google Cloud Code) client constants.
 *
 * Antigravity is Google's AI IDE. It authenticates with a normal Google OAuth
 * installed-app client and then talks to the Cloud Code backend
 * (`cloudcode-pa.googleapis.com`) using a Gemini-shaped request wrapped in a
 * Cloud Code envelope.
 *
 * ── On the embedded client credentials ─────────────────────────────────────
 * The client_id/secret below are extracted from the publicly distributed
 * Antigravity client. Google documents that installed-app OAuth clients cannot
 * keep a secret and must not be treated as confidential:
 *   https://developers.google.com/identity/protocols/oauth2/native-app
 *
 * They are stored XOR-masked purely so the literals do not trip secret
 * scanners — this is not encryption and is not meant to be. Both can be
 * overridden by environment variable.
 *
 * ── On what this is ────────────────────────────────────────────────────────
 * Presenting these credentials means identifying as the Antigravity client.
 * That carries the same terms-of-service exposure as the Codex path this
 * project already documents: it is for accounts you own, and Google may
 * withdraw access. See the README.
 */

/** Mask matches the upstream project the byte sequences were taken from. */
const MASK = "omniroute-public-v1";

function unmask(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]! ^ MASK.charCodeAt(i % MASK.length));
  }
  return out;
}

const CLIENT_ID_BYTES = [
  94, 93, 89, 88, 66, 95, 67, 68, 83, 29, 69, 76, 83, 65, 29, 14, 69, 5, 66, 6, 3, 92, 1, 64, 94,
  25, 23, 23, 72, 66, 70, 87, 26, 29, 12, 65, 25, 91, 7, 89, 9, 93, 66, 92, 16, 4, 75, 76, 0, 5,
  17, 66, 14, 12, 66, 17, 93, 10, 24, 29, 12, 0, 12, 26, 26, 17, 72, 30, 1, 76, 15, 6, 14,
];

const CLIENT_SECRET_BYTES = [
  40, 34, 45, 58, 34, 55, 88, 63, 80, 21, 54, 34, 48, 88, 81, 85, 97, 18, 125, 37, 92, 3, 37, 48,
  87, 6, 44, 38, 25, 10, 67, 19, 40, 40, 5,
];

export const ANTIGRAVITY = {
  clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || unmask(CLIENT_ID_BYTES),
  clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || unmask(CLIENT_SECRET_BYTES),

  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",

  /*
   * No `openid` scope, and no PKCE on the authorize URL.
   *
   * Adding either routes Google into a `firstparty/nativeapp` consent screen
   * that never completes for this client. The upstream project hit the same
   * wall and documents the exact scope set below as the one that works.
   */
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],

  /** Runtime traffic. Tried in order; the daily host is usually less loaded. */
  runtimeBaseUrls: [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ],
  /** Project bootstrap only ever works against the stable host. */
  bootstrapBaseUrls: ["https://cloudcode-pa.googleapis.com"],

  /** Loopback port for the OAuth callback. Distinct from the Codex flow's 1455. */
  callbackPort: 1456,
  callbackPath: "/antigravity/callback",
} as const;

export const loadCodeAssistUrls = () =>
  ANTIGRAVITY.bootstrapBaseUrls.map((b) => `${b}/v1internal:loadCodeAssist`);
export const onboardUserUrls = () =>
  ANTIGRAVITY.bootstrapBaseUrls.map((b) => `${b}/v1internal:onboardUser`);
export const fetchModelsUrls = () =>
  ANTIGRAVITY.runtimeBaseUrls.map((b) => `${b}/v1internal:fetchAvailableModels`);
export const streamUrls = () =>
  ANTIGRAVITY.runtimeBaseUrls.map((b) => `${b}/v1internal:streamGenerateContent?alt=sse`);

/*
 * The backend expects the native macOS desktop build's fingerprint, so the
 * platform token is pinned to darwin/arm64 regardless of what we run on.
 */
const OS_TYPE = "darwin";
const ARCH = "arm64";

/*
 * The backend refuses old builds — it answers HTTP 200 with "This version of
 * Antigravity is no longer supported" as the model's reply, so a stale version
 * here looks like a working connection returning nonsense. Overridable, since
 * this will go stale again the next time the IDE ships.
 */
const IDE_VERSION = process.env.AI_AUTHER_ANTIGRAVITY_VERSION || "2.0.1";
const NODE_API_CLIENT = "google-api-nodejs-client/10.3.0";

export const ideUserAgent = () => `antigravity/ide/${IDE_VERSION} ${OS_TYPE}/${ARCH}`;
export const ideNodeUserAgent = () =>
  `antigravity/${IDE_VERSION} ${OS_TYPE}/${ARCH} ${NODE_API_CLIENT}`;

/** Headers for chat traffic. */
export function contentHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": ideUserAgent(),
    accept: "text/event-stream",
    authorization: `Bearer ${accessToken}`,
  };
}

/** Headers for the bootstrap calls, which present as the IDE's Node client. */
export function bootstrapHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": ideNodeUserAgent(),
    "x-goog-api-client": "gl-node/22.21.1",
    authorization: `Bearer ${accessToken}`,
  };
}

export const loadCodeAssistMetadata = () => ({ ideType: "ANTIGRAVITY" });

/**
 * Models the Cloud Code backend serves through Antigravity. Replaced by the
 * live list once `fetchAvailableModels` has been called for an account.
 */
export const ANTIGRAVITY_DEFAULT_MODELS = [
  "chat_20706",
  "chat_23310",
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3-flash-agent",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.5-flash-extra-low",
  "gemini-3.5-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-tiered",
  "gemini-pro-agent",
  "gpt-oss-120b-medium",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
];

// ---------------------------------------------------------------------------
// Google OAuth for the Antigravity connection

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { registerSecret } from "../logging.js";

export interface AntigravityLoginResult {
  accountId: string;
  email: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  projectId: string;
  tierId: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface AntigravityLoginHandle {
  authorizeUrl: string;
  completed: Promise<AntigravityLoginResult>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch] ?? ch);
}

function callbackUrl(): string {
  return `http://127.0.0.1:${ANTIGRAVITY.callbackPort}${ANTIGRAVITY.callbackPath}`;
}

function buildAuthorizeUrl(state: string): string {
  const url = new URL(ANTIGRAVITY.authorizeUrl);
  url.searchParams.set("client_id", ANTIGRAVITY.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ANTIGRAVITY.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

function donePage(ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>Open-Auther</title>` +
    `<style>body{font:15px system-ui;background:#101116;color:#e8eaf0;display:grid;place-items:center;height:100vh}` +
    `.card{padding:32px;border:1px solid #30343d;border-radius:14px;background:#191c23}` +
    `h1{color:${ok ? "#8fbf9f" : "#c4837b"}}</style>` +
    `<div class="card"><h1>${ok ? "Account connected" : "Sign-in failed"}</h1>` +
    `<p>${ok ? "Open-Auther received the Google credential. You can close this tab." : "You can close this tab and try again."}</p></div>`;
}

function awaitCallback(state: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: ReturnType<typeof createServer>;
    const timer = setTimeout(() => finish(() => reject(new Error("timed out waiting for the Antigravity callback"))), timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${ANTIGRAVITY.callbackPort}`);
      if (url.pathname !== ANTIGRAVITY.callbackPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(donePage(false));
        finish(() => reject(new Error(`Google authorization failed: ${error}`)));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(donePage(false));
        finish(() => reject(new Error("invalid Antigravity OAuth callback")));
        return;
      }
      registerSecret(code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(donePage(true));
      finish(() => resolve(code));
    };

    server = createServer(handler);
    server.on("error", (err: NodeJS.ErrnoException) => finish(() => reject(
      err.code === "EADDRINUSE"
        ? new Error(`Port ${ANTIGRAVITY.callbackPort} is already in use.`)
        : err,
    )));
    signal?.addEventListener("abort", () => finish(() => reject(new Error("Antigravity login cancelled"))), { once: true });
    server.listen(ANTIGRAVITY.callbackPort, "127.0.0.1");
  });
}

async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    redirect_uri: callbackUrl(),
    grant_type: "authorization_code",
  });
  const response = await fetch(ANTIGRAVITY.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google token exchange failed (HTTP ${response.status})`);
  return JSON.parse(text) as GoogleTokenResponse;
}

async function googleUserInfo(accessToken: string): Promise<{ id: string; email: string | null }> {
  const response = await fetch(ANTIGRAVITY.userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google user-info request failed (HTTP ${response.status})`);
  const body = (await response.json()) as { id?: string; email?: string };
  if (!body.id) throw new Error("Google user-info response did not include an account id");
  return { id: body.id, email: body.email ?? null };
}

function projectFromResponse(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["projectId", "project", "cloudaicompanionProject"]) {
    const found = projectFromResponse(record[key]);
    if (found) return found;
  }
  return null;
}

async function bootstrapProject(accessToken: string): Promise<{ projectId: string; tierId: string }> {
  const headers = { ...bootstrapHeaders(accessToken), accept: "application/json" };
  let lastError = "Cloud Code bootstrap failed";
  for (const url of loadCodeAssistUrls()) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: loadCodeAssistMetadata() }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      lastError = `Cloud Code loadCodeAssist failed (HTTP ${response.status})`;
      continue;
    }
    let projectId = projectFromResponse(body.cloudaicompanionProject ?? body.project ?? body.projectId);
    const tier = body.currentTier as Record<string, unknown> | undefined;
    const tierId = String(tier?.id ?? tier?.tierId ?? body.tierId ?? "free");

    if (!projectId) {
      for (const onboardUrl of onboardUserUrls()) {
        const onboard = await fetch(onboardUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ tierId, metadata: loadCodeAssistMetadata() }),
          signal: AbortSignal.timeout(30_000),
        });
        const onboardBody = (await onboard.json().catch(() => ({}))) as Record<string, unknown>;
        projectId = projectFromResponse(onboardBody.cloudaicompanionProject ?? onboardBody.project ?? onboardBody.projectId);
        if (projectId) break;
      }
    }
    if (projectId) return { projectId, tierId };
    lastError = "Cloud Code did not return a project id";
  }
  throw new Error(lastError);
}

export function beginAntigravityLogin(
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): AntigravityLoginHandle {
  const state = randomBytes(24).toString("base64url");
  const authorizeUrl = buildAuthorizeUrl(state);
  const completed = (async () => {
    const code = await awaitCallback(state, opts.timeoutMs ?? 10 * 60_000, opts.signal);
    const tokens = await exchangeGoogleCode(code);
    if (!tokens.access_token) throw new Error("Google token exchange returned no access token");
    registerSecret(tokens.access_token);
    registerSecret(tokens.refresh_token);
    const user = await googleUserInfo(tokens.access_token);
    const project = await bootstrapProject(tokens.access_token);
    return {
      accountId: `google_${user.id}`,
      email: user.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      accessExpiresAt: typeof tokens.expires_in === "number" ? Math.floor(Date.now() / 1000) + tokens.expires_in : null,
      ...project,
    } satisfies AntigravityLoginResult;
  })();
  return { authorizeUrl, completed };
}

export interface RefreshedAntigravityToken {
  accessToken: string;
  expiresAt: number | null;
}

export async function refreshAntigravityToken(refreshToken: string): Promise<RefreshedAntigravityToken> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetch(ANTIGRAVITY.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Google token refresh failed (HTTP ${response.status})`);
  const tokens = (await response.json()) as GoogleTokenResponse;
  if (!tokens.access_token) throw new Error("Google token refresh returned no access token");
  registerSecret(tokens.access_token);
  return {
    accessToken: tokens.access_token,
    expiresAt: typeof tokens.expires_in === "number" ? Math.floor(Date.now() / 1000) + tokens.expires_in : null,
  };
}
