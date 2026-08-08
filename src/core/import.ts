/**
 * Credential import, shared by the CLI and the dashboard.
 *
 * Accepts a Codex-style `auth.json`, a flat token object, or an array of
 * either, because those are the shapes other tools actually produce.
 */

import { now } from "../db.js";
import { maskEmail, registerSecret } from "../logging.js";
import { DuplicateAccountError, type CredentialStore } from "../pool/store.js";
import { decodeIdToken } from "./jwt.js";

export interface ImportShape {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  expires_at?: number;
  expires_in?: number;
  name?: string;
  label?: string;
}

export interface ImportOutcome {
  added: Array<{ id: number; name: string; email: string; plan: string | null }>;
  skipped: Array<{ reason: string; detail: string }>;
}

export function normaliseImport(raw: unknown): ImportShape[] {
  if (Array.isArray(raw)) return raw.flatMap((r) => normaliseImport(r));
  if (!raw || typeof raw !== "object") return [];
  return [raw as ImportShape];
}

/**
 * Import one or many credentials. Never throws on a bad entry — each is either
 * added or reported in `skipped`, so importing ten accounts does not fail
 * wholesale because one was malformed.
 */
export function importCredentials(
  store: CredentialStore,
  payload: unknown,
  nameHint: string | null = null,
): ImportOutcome {
  const entries = normaliseImport(payload);
  if (entries.length === 0) {
    throw new Error("Could not read any credential objects from that input.");
  }

  const outcome: ImportOutcome = { added: [], skipped: [] };

  entries.forEach((entry, index) => {
    const t = entry.tokens ?? entry;
    const accessToken = t.access_token;

    if (!accessToken) {
      outcome.skipped.push({ reason: "no_access_token", detail: `entry ${index + 1}` });
      return;
    }
    registerSecret(accessToken);
    registerSecret(t.refresh_token);
    registerSecret(t.id_token);

    const claims = decodeIdToken(t.id_token ?? accessToken);
    const accountId = claims?.accountId ?? t.account_id ?? null;
    if (!accountId) {
      outcome.skipped.push({
        reason: "no_account_id",
        detail:
          `entry ${index + 1} has no chatgpt_account_id, so it cannot be deduplicated ` +
          `against the accounts already in the pool`,
      });
      return;
    }

    const expiresAt =
      entry.expires_at ??
      (typeof entry.expires_in === "number" ? now() + entry.expires_in : (claims?.exp ?? null));

    // A per-entry name wins; a single-entry import can take the hint verbatim.
    const name =
      entry.name ??
      entry.label ??
      (nameHint && entries.length === 1 ? nameHint : nameHint ? `${nameHint} ${index + 1}` : null);

    try {
      const credential = store.add({
        accountId,
        email: claims?.email ?? null,
        planType: claims?.planType ?? null,
        label: name,
        accessToken,
        refreshToken: t.refresh_token ?? null,
        idToken: t.id_token ?? null,
        accessExpiresAt: expiresAt,
      });
      outcome.added.push({
        id: credential.id,
        name: credential.label?.trim() || `Auth ${credential.id}`,
        email: maskEmail(credential.email),
        plan: credential.planType,
      });
    } catch (err) {
      if (err instanceof DuplicateAccountError) {
        outcome.skipped.push({
          reason: "duplicate",
          detail: `already in the pool as ${maskEmail(err.existingEmail)}`,
        });
        return;
      }
      throw err;
    }
  });

  return outcome;
}
