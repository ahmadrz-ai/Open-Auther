/**
 * Browser-driven account onboarding.
 *
 * The dashboard cannot run the OAuth flow itself — the loopback callback lands
 * on the gateway process, not on the page. So the page starts a session here,
 * gets an authorize URL to open, and polls until the callback completes.
 *
 * Sessions are in-memory and short-lived by design: they hold an authorization
 * code exchange in flight, which is not something to persist.
 */

import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { beginAntigravityLogin } from "../core/antigravity.js";
import { beginLogin } from "../core/login.js";
import { fetchAntigravityModels } from "../upstream/antigravity.js";
import { DuplicateAccountError, type CredentialStore } from "../pool/store.js";

const log = createLogger({ mod: "oauth-session" });

export type SessionState = "pending" | "complete" | "error" | "cancelled";

interface Session {
  id: string;
  state: SessionState;
  authorizeUrl: string;
  createdAt: number;
  name: string | null;
  credentialId: number | null;
  error: string | null;
  /** Set when the failure is a duplicate, so the UI can explain it properly. */
  duplicate: boolean;
  controller: AbortController;
}

const SESSION_TTL_MS = 10 * 60_000;

export class LoginSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly cfg: Config,
    private readonly store: CredentialStore,
  ) {}

  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (s.createdAt < cutoff) this.sessions.delete(id);
    }
  }

  /**
   * Begin an Antigravity (Google) sign-in. Same session contract as the Codex
   * flow so the dashboard polls both identically.
   */
  startAntigravity(name: string | null): { id: string; authorizeUrl: string } {
    this.sweep();

    const controller = new AbortController();
    const { authorizeUrl, completed } = beginAntigravityLogin({
      signal: controller.signal,
      timeoutMs: SESSION_TTL_MS,
    });

    const session: Session = {
      id: randomUUID(),
      state: "pending",
      authorizeUrl,
      createdAt: Date.now(),
      name,
      credentialId: null,
      error: null,
      duplicate: false,
      controller,
    };
    this.sessions.set(session.id, session);

    completed
      .then(async (result) => {
        if (session.state === "cancelled") return;
        const credential = this.store.addAntigravity({
          accountId: result.accountId,
          email: result.email,
          label: session.name,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          accessExpiresAt: result.accessExpiresAt,
          projectId: result.projectId,
          tierId: result.tierId,
        });

        // Discover the real model list now rather than leaving the account on
        // static defaults it may not be entitled to.
        try {
          const models = await fetchAntigravityModels(this.store.get(credential.id)!);
          if (models.length) this.store.setCustomModels(credential.id, models);
        } catch {
          /* defaults stand */
        }

        session.state = "complete";
        session.credentialId = credential.id;
        log.info("antigravity_session_complete", { credential: credential.id });
      })
      .catch((err: unknown) => {
        if (session.state === "cancelled") return;
        session.state = "error";
        session.error = (err as Error).message;
        log.warn("antigravity_session_failed", {});
      });

    return { id: session.id, authorizeUrl };
  }

  start(name: string | null): { id: string; authorizeUrl: string } {
    this.sweep();

    const controller = new AbortController();
    const { authorizeUrl, completed } = beginLogin(this.cfg, {
      signal: controller.signal,
      timeoutMs: SESSION_TTL_MS,
    });

    const session: Session = {
      id: randomUUID(),
      state: "pending",
      authorizeUrl,
      createdAt: Date.now(),
      name,
      credentialId: null,
      error: null,
      duplicate: false,
      controller,
    };
    this.sessions.set(session.id, session);

    completed
      .then((result) => {
        if (session.state === "cancelled") return;
        const credential = this.store.add({
          accountId: result.accountId,
          email: result.email,
          planType: result.planType,
          label: session.name,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          idToken: result.idToken,
          accessExpiresAt: result.accessExpiresAt,
        });
        session.state = "complete";
        session.credentialId = credential.id;
        log.info("session_complete", { credential: credential.id });
      })
      .catch((err: unknown) => {
        if (session.state === "cancelled") return;
        session.state = "error";
        if (err instanceof DuplicateAccountError) {
          session.duplicate = true;
          session.error =
            "That ChatGPT account is already in the pool. The browser signed in with " +
            "an existing session instead of prompting. Open the link in a fresh private " +
            "window and sign in with a different account.";
        } else {
          session.error = (err as Error).message;
        }
        log.warn("session_failed", { duplicate: session.duplicate });
      });

    return { id: session.id, authorizeUrl };
  }

  status(id: string): {
    state: SessionState;
    error: string | null;
    duplicate: boolean;
    credentialId: number | null;
    authorizeUrl: string;
  } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      state: s.state,
      error: s.error,
      duplicate: s.duplicate,
      credentialId: s.credentialId,
      authorizeUrl: s.authorizeUrl,
    };
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.state = "cancelled";
    s.controller.abort();
    this.sessions.delete(id);
    return true;
  }
}
