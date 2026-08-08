/**
 * Credential persistence and the pool state machine.
 *
 * The one invariant that matters most here: **refreshes are serialised per
 * credential**. Refresh tokens are single-use, so two concurrent refreshes of
 * the same credential invalidate it permanently. `withCredentialLock` is the
 * only sanctioned way to touch token material.
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { ANTIGRAVITY_DEFAULT_MODELS } from "../core/antigravity.js";
import { inferProviderId, providerDef } from "../core/providers.js";
import { extractWebCredential, WEB_COOKIE_BY_ID } from "../core/webcookie.js";
import { type Database, now } from "../db.js";
import { maskEmail, registerSecret, createLogger } from "../logging.js";
import type {
  Credential,
  CredentialPublic,
  CredentialState,
  PoolEvent,
  ModelStat,
  ProviderType,
  RequestLogEntry,
} from "./types.js";

const log = createLogger({ mod: "store" });

interface Row {
  id: number;
  account_id: string;
  provider_id?: string | null;
  provider_type?: string;
  base_url?: string | null;
  custom_models?: string | null;
  validation_model?: string | null;
  priority?: number | null;
  excluded_models?: string | null;
  custom_user_agent?: string | null;
  routing_tags?: string | null;
  per_model_quota?: number | null;
  model_cooldowns?: string | null;
  model_stats?: string | null;
  email: string | null;
  plan_type: string | null;
  label: string | null;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_expires_at: number | null;
  state: string;
  cooldown_until: number | null;
  resets_at: number | null;
  request_count: number;
  success_count: number;
  error_count: number;
  token_count: number;
  last_used_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

/** JSON columns are user-editable, so a malformed value must not break reads. */
function parseJsonList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function parseModelStats(raw: string | null | undefined): Record<string, ModelStat> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, ModelStat>;
  } catch {
    return {};
  }
}

function toCredential(row: Row): Credential {
  let customModels: string[] | null = null;
  if (row.custom_models) {
    try {
      customModels = JSON.parse(row.custom_models);
    } catch {
      customModels = null;
    }
  }

  return {
    id: row.id,
    accountId: row.account_id,
    providerType:
      (row.provider_type as ProviderType) ||
      (row.account_id.startsWith("gemini_") ? "gemini" : "codex_oauth"),
    providerId:
      row.provider_id ?? inferProviderId(row.provider_type ?? "codex_oauth", row.base_url ?? null),
    baseUrl: row.base_url ?? null,
    customModels,
    validationModel: row.validation_model ?? null,
    priority: row.priority ?? 1,
    excludedModels: parseJsonList(row.excluded_models),
    customUserAgent: row.custom_user_agent ?? null,
    routingTags: parseJsonList(row.routing_tags),
    perModelQuota: Boolean(row.per_model_quota),
    modelCooldowns: parseJsonMap(row.model_cooldowns),
    modelStats: parseModelStats(row.model_stats),
    email: row.email,
    planType: row.plan_type,
    label: row.label,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    idToken: row.id_token,
    accessExpiresAt: row.access_expires_at,
    state: row.state as CredentialState,
    cooldownUntil: row.cooldown_until,
    resetsAt: row.resets_at,
    requestCount: row.request_count,
    successCount: row.success_count,
    errorCount: row.error_count,
    tokenCount: row.token_count,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A credential is usable when it is active and any cooldown has elapsed. */
export function isAvailable(c: Credential, at: number = now()): boolean {
  if (c.state === "dead") return false;
  if (c.cooldownUntil !== null && c.cooldownUntil > at) return false;
  return true;
}

export function effectiveState(c: Credential, at: number = now()): CredentialState {
  if (c.state === "dead") return "dead";
  if (c.cooldownUntil !== null && c.cooldownUntil > at) return "cooling";
  return "active";
}

/**
 * The name shown everywhere in the UI.
 */
export function displayName(c: Credential): string {
  if (c.label?.trim()) return c.label.trim();
  if (c.providerType === "gemini") return `Gemini Key #${c.id}`;
  if (c.providerType === "openai_custom") return `Custom Provider #${c.id}`;
  return `Connection ${c.id}`;
}

export function toPublic(c: Credential, at: number = now()): CredentialPublic {
  return {
    id: c.id,
    accountId: c.accountId,
    providerId: c.providerId,
    providerType: c.providerType,
    baseUrl: c.baseUrl,
    customModels: c.customModels,
    validationModel: c.validationModel,
    priority: c.priority,
    excludedModels: c.excludedModels,
    customUserAgent: c.customUserAgent,
    routingTags: c.routingTags,
    perModelQuota: c.perModelQuota,
    modelCooldowns: c.modelCooldowns,
    modelStats: c.modelStats,
    name: displayName(c),
    emailMasked: maskEmail(c.email),
    planType: c.planType,
    label: c.label,
    state: c.state,
    effectiveState: effectiveState(c, at),
    cooldownUntil: c.cooldownUntil,
    resetsAt: c.resetsAt,
    requestCount: c.requestCount,
    successCount: c.successCount,
    errorCount: c.errorCount,
    tokenCount: c.tokenCount,
    lastUsedAt: c.lastUsedAt,
    lastError: c.lastError,
    lastErrorAt: c.lastErrorAt,
    createdAt: c.createdAt,
    needsRefresh: c.providerType === "codex_oauth" && (c.accessExpiresAt === null || c.accessExpiresAt <= at),
  };
}

export class DuplicateAccountError extends Error {
  constructor(
    readonly accountId: string,
    readonly existingEmail: string | null,
  ) {
    super(
      `This ChatGPT account is already in the pool (${maskEmail(existingEmail)}). ` +
        `Running the device-code flow in a browser that already has a ChatGPT session ` +
        `returns the SAME account. Use a fresh private window and a different account.`,
    );
    this.name = "DuplicateAccountError";
  }
}

/** Minimal FIFO async mutex. One instance per credential id. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow rejection on the chain so one failure does not poison the queue.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface NewCredentialInput {
  accountId: string;
  email: string | null;
  planType: string | null;
  label?: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: number | null;
  /** Defaults to `codex_oauth`, which is what the OAuth flow produces. */
  providerType?: ProviderType;
  baseUrl?: string | null;
  customModels?: string[] | null;
}

export class CredentialStore extends EventEmitter {
  private readonly locks = new Map<number, Mutex>();
  /** Cursor for round_robin. Not persisted; restarting resets fairness, which is harmless. */
  private cursor = 0;

  constructor(private readonly db: Database) {
    super();
    this.setMaxListeners(0);
    // Any token already on disk must be scrubbed from logs from the first line.
    for (const c of this.all()) {
      registerSecret(c.accessToken);
      registerSecret(c.refreshToken);
      registerSecret(c.idToken);
    }
  }

  // ---------------------------------------------------------------- reads

  all(): Credential[] {
    const rows = this.db
      .prepare("SELECT * FROM credentials ORDER BY id ASC")
      .all() as unknown as Row[];
    return rows.map(toCredential);
  }

  get(id: number): Credential | null {
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toCredential(row) : null;
  }

  getByAccountId(accountId: string): Credential | null {
    const row = this.db.prepare("SELECT * FROM credentials WHERE account_id = ?").get(accountId) as
      | Row
      | undefined;
    return row ? toCredential(row) : null;
  }

  /** Credentials eligible to serve a request right now. */
  available(at: number = now()): Credential[] {
    return this.all().filter((c) => isAvailable(c, at));
  }

  /**
   * Earliest moment any credential becomes usable again, or null if the pool is
   * empty or entirely dead. Drives the `Retry-After` header on a drained pool.
   */
  earliestRecovery(at: number = now()): number | null {
    let earliest: number | null = null;
    for (const c of this.all()) {
      if (c.state === "dead") continue;
      const t = c.cooldownUntil ?? at;
      if (t <= at) return at;
      if (earliest === null || t < earliest) earliest = t;
    }
    return earliest;
  }

  // --------------------------------------------------------------- writes

  add(input: NewCredentialInput): Credential {
    const existing = this.getByAccountId(input.accountId);
    if (existing) throw new DuplicateAccountError(input.accountId, existing.email);

    const ts = now();
    registerSecret(input.accessToken);
    registerSecret(input.refreshToken);
    registerSecret(input.idToken);

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_type, base_url, custom_models, email, plan_type, label, access_token, refresh_token, id_token,
            access_expires_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.accountId,
        // These were previously hard-coded, so a caller supplying a provider
        // type had it silently discarded and the row came back as OAuth.
        input.providerType ?? "codex_oauth",
        input.baseUrl ?? null,
        input.customModels?.length ? JSON.stringify(input.customModels) : null,
        input.email,
        input.planType,
        input.label ?? null,
        input.accessToken,
        input.refreshToken,
        input.idToken,
        input.accessExpiresAt,
        ts,
        ts,
      );

    const created = this.getByAccountId(input.accountId)!;
    this.emit("event", {
      ts,
      kind: "credential_added",
      credentialId: created.id,
      detail: { accountId: input.accountId, email: input.email },
    } satisfies PoolEvent);
    return created;
  }

  /**
   * Add one API key for a catalogued provider.
   *
   * The endpoint comes from the catalogue rather than the caller, so a key can
   * never end up pointed at the wrong service. Duplicate keys are rejected by
   * the account_id uniqueness constraint, which is derived from the key.
   */
  addProviderKey(providerId: string, apiKey: string, label?: string | null): Credential {
    const def = providerDef(providerId);
    if (!def) throw new Error(`Unknown provider "${providerId}".`);
    if (def.auth.includes("oauth") && !def.auth.includes("api_key")) {
      throw new Error(`${def.label} is OAuth-only and cannot take an API key.`);
    }

    const key = apiKey.trim();
    if (!key) throw new Error(`${def.label} API key cannot be empty.`);

    // Deterministic from the key, so pasting the same key twice is caught as a
    // duplicate rather than silently creating a second identical credential.
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const accountId = `${def.id}_${digest}`;

    const existing = this.getByAccountId(accountId);
    if (existing) {
      throw new Error(`That ${def.label} key is already in the pool as "${displayName(existing)}".`);
    }

    const ts = now();
    registerSecret(key);

    const count = this.all().filter((c) => c.providerId === def.id).length;
    const name = label?.trim() || `${def.label} #${count + 1}`;

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_id, provider_type, base_url, custom_models, email,
            plan_type, label, access_token, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'api_key', ?, ?, 'active', ?, ?)`,
      )
      .run(accountId, def.id, def.providerType, def.baseUrl, def.label, name, key, ts, ts);

    const created = this.getByAccountId(accountId)!;
    this.record("credential_added", created.id, { provider: def.id, name });
    return created;
  }

  /**
   * Store an Antigravity connection.
   *
   * The Cloud Code project id goes in `base_url`. That slot already means
   * "where this credential's traffic goes", and for Antigravity the project is
   * exactly that — the host is fixed, the project is what varies per account.
   */
  addAntigravity(input: {
    accountId: string;
    email: string | null;
    label?: string | null;
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: number | null;
    projectId: string;
    tierId: string;
    models?: string[];
  }): Credential {
    const existing = this.getByAccountId(input.accountId);
    if (existing) {
      throw new Error(
        `That Google account is already connected as "${displayName(existing)}". ` +
          `Sign in with a different account, or remove the existing connection first.`,
      );
    }

    const ts = now();
    registerSecret(input.accessToken);
    registerSecret(input.refreshToken);

    const count = this.all().filter((c) => c.providerId === "antigravity").length;
    const models = input.models?.length ? input.models : ANTIGRAVITY_DEFAULT_MODELS;

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_id, provider_type, base_url, custom_models, email,
            plan_type, label, access_token, refresh_token, access_expires_at,
            state, created_at, updated_at)
         VALUES (?, 'antigravity', 'antigravity', ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.accountId,
        input.projectId,
        JSON.stringify(models),
        input.email,
        input.tierId,
        input.label?.trim() || `Antigravity #${count + 1}`,
        input.accessToken,
        input.refreshToken,
        input.accessExpiresAt,
        ts,
        ts,
      );

    const created = this.getByAccountId(input.accountId)!;
    this.record("credential_added", created.id, {
      provider: "antigravity",
      tier: input.tierId,
      models: models.length,
    });
    return created;
  }

  /**
   * Store a web-session credential.
   *
   * The pasted value is reduced to just the credential before it is saved, so
   * a whole Cookie header full of unrelated session data never lands on disk.
   */
  addWebSession(input: {
    providerId: string;
    rawValue: string;
    label?: string | null;
  }): Credential {
    const def = WEB_COOKIE_BY_ID.get(input.providerId);
    if (!def) throw new Error(`Unknown web provider "${input.providerId}".`);
    if (!def.implemented) {
      throw new Error(
        `${def.label} has no transport implemented yet, so a credential for it would never be used.`,
      );
    }

    const value = extractWebCredential(def.id, input.rawValue);
    if (!value) {
      throw new Error(
        `Could not find "${def.credentialName}" in what you pasted. Copy the value itself, ` +
          `or the whole Cookie header — not a screenshot of DevTools.`,
      );
    }

    const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
    const accountId = `${def.id}_${digest}`;
    const existing = this.getByAccountId(accountId);
    if (existing) {
      throw new Error(`That session is already connected as "${displayName(existing)}".`);
    }

    const ts = now();
    registerSecret(value);
    const count = this.all().filter((c) => c.providerId === def.id).length;

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_id, provider_type, base_url, custom_models, email,
            plan_type, label, access_token, state, created_at, updated_at)
         VALUES (?, ?, 'web_cookie', ?, ?, ?, 'web_session', ?, ?, 'active', ?, ?)`,
      )
      .run(
        accountId,
        def.id,
        def.website,
        JSON.stringify(def.defaultModels),
        def.label,
        input.label?.trim() || `${def.label} #${count + 1}`,
        value,
        ts,
        ts,
      );

    const created = this.getByAccountId(accountId)!;
    this.record("credential_added", created.id, { provider: def.id });
    return created;
  }

  addGeminiKey(apiKey: string, label?: string | null): Credential {
    const key = apiKey.trim();
    if (!key) throw new Error("Gemini API key cannot be empty.");

    const accountId = `gemini_${key.slice(-8)}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = now();
    registerSecret(key);

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_type, base_url, custom_models, email, plan_type, label, access_token, state, created_at, updated_at)
         VALUES (?, 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', NULL, 'Gemini Free Tier', 'free', ?, ?, 'active', ?, ?)`,
      )
      .run(accountId, label?.trim() || `Gemini Key (${key.slice(0, 6)}...${key.slice(-4)})`, key, ts, ts);

    const created = this.getByAccountId(accountId)!;
    this.emit("event", {
      ts,
      kind: "credential_added",
      credentialId: created.id,
      detail: { accountId, provider: "gemini" },
    } satisfies PoolEvent);
    return created;
  }

  addCustomProvider(name: string, baseUrl: string, apiKey: string, models?: string[]): Credential {
    const key = apiKey.trim();
    const url = baseUrl.trim().replace(/\/+$/, "");
    const providerName = name.trim() || "Custom Provider";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("Base URL must be a valid http or https URL.");
    }

    const accountId = `custom_${Math.random().toString(36).slice(2, 10)}`;
    const ts = now();
    registerSecret(key);

    const modelsJson = models && models.length ? JSON.stringify(models) : null;

    this.db
      .prepare(
        `INSERT INTO credentials
           (account_id, provider_type, base_url, custom_models, email, plan_type, label, access_token, state, created_at, updated_at)
         VALUES (?, 'openai_custom', ?, ?, ?, 'custom', ?, ?, 'active', ?, ?)`,
      )
      .run(accountId, url, modelsJson, providerName, providerName, key, ts, ts);

    const created = this.getByAccountId(accountId)!;
    this.emit("event", {
      ts,
      kind: "credential_added",
      credentialId: created.id,
      detail: { accountId, provider: "openai_custom", baseUrl: url },
    } satisfies PoolEvent);
    return created;
  }

  /** Replace token material after a successful refresh. */
  updateTokens(
    id: number,
    tokens: {
      accessToken: string;
      refreshToken?: string | null;
      idToken?: string | null;
      accessExpiresAt: number | null;
    },
  ): void {
    registerSecret(tokens.accessToken);
    registerSecret(tokens.refreshToken);
    registerSecret(tokens.idToken);

    const current = this.get(id);
    if (!current) return;

    this.db
      .prepare(
        `UPDATE credentials
            SET access_token = ?, refresh_token = ?, id_token = ?,
                access_expires_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        tokens.accessToken,
        tokens.refreshToken ?? current.refreshToken,
        tokens.idToken ?? current.idToken,
        tokens.accessExpiresAt,
        now(),
        id,
      );
    this.record("token_refreshed", id, {});
  }

  /** Record the start of a request against this credential. */
  markUsed(id: number): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE credentials
            SET request_count = request_count + 1, last_used_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(ts, ts, id);
    this.emit("change");
  }

  markSuccess(id: number, tokensUsed = 0): void {
    const ts = now();
    this.db
      .prepare(
        // A served request proves the credential works, so the cooldown and
        // dead flag go with the stale error — otherwise a connection that
        // recovered on its own keeps showing yesterday's failure.
        `UPDATE credentials
            SET success_count  = success_count + 1,
                token_count    = token_count + ?,
                state          = 'active',
                cooldown_until = NULL,
                last_error     = NULL,
                last_error_at  = NULL,
                updated_at     = ?
          WHERE id = ?`,
      )
      .run(tokensUsed, ts, id);
    this.record("request_ok", id, tokensUsed ? { tokens: tokensUsed } : {});
  }

  /**
   * Put a credential to sleep. `until` is an absolute epoch second — normally
   * upstream's `resets_at`, never a guess when upstream told us the real value.
   */
  markCooling(id: number, until: number, reason: string, resetsAt: number | null = null): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE credentials
            SET state          = 'cooling',
                cooldown_until = ?,
                resets_at      = COALESCE(?, resets_at),
                error_count    = error_count + 1,
                last_error     = ?,
                last_error_at  = ?,
                updated_at     = ?
          WHERE id = ?`,
      )
      .run(until, resetsAt, reason, ts, ts, id);
    this.record("credential_cooling", id, {
      reason,
      until,
      seconds: Math.max(0, until - ts),
    });
  }

  /** Permanently remove a credential from rotation. Only for terminal failures. */
  markDead(id: number, reason: string): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE credentials
            SET state = 'dead', error_count = error_count + 1,
                last_error = ?, last_error_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(reason, ts, ts, id);
    const c = this.get(id);
    log.warn("credential_dead", { credential: id, email: maskEmail(c?.email), reason });
    this.record("credential_dead", id, { reason });
  }

  /** Clear an elapsed cooldown so the credential is selectable again. */
  wake(id: number): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE credentials
            SET state = 'active', cooldown_until = NULL, updated_at = ?
          WHERE id = ? AND state = 'cooling'`,
      )
      .run(ts, id);
    this.record("credential_woke", id, {});
  }

  /** Manual operator action: bring a dead credential back for another attempt. */
  revive(id: number): boolean {
    const c = this.get(id);
    if (!c) return false;
    const ts = now();
    this.db
      .prepare(
        `UPDATE credentials
            SET state = 'active', cooldown_until = NULL, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(ts, id);
    this.record("credential_revived", id, {});
    return true;
  }

  remove(id: number): boolean {
    const c = this.get(id);
    if (!c) return false;
    this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
    this.locks.delete(id);
    this.record("credential_removed", id, { email: maskEmail(c.email) });
    return true;
  }

  /**
   * Sweep credentials whose cooldown has elapsed back into rotation. Called
   * before each selection so state on disk matches what the UI shows.
   */
  wakeExpired(at: number = now()): number {
    const due = this.all().filter(
      (c) => c.state === "cooling" && c.cooldownUntil !== null && c.cooldownUntil <= at,
    );
    for (const c of due) this.wake(c.id);
    return due.length;
  }

  // ------------------------------------------------------- concurrency

  /**
   * Run `fn` holding this credential's exclusive lock. Every token refresh must
   * go through here; see the note at the top of this file.
   */
  withCredentialLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    let m = this.locks.get(id);
    if (!m) {
      m = new Mutex();
      this.locks.set(id, m);
    }
    return m.run(fn);
  }

  // ------------------------------------------------------------ events

  /** Append to the activity feed and notify live UI subscribers. */
  record(kind: string, credentialId: number | null, detail: Record<string, unknown>): void {
    const ts = now();
    const event: PoolEvent = { ts, kind, credentialId, detail };
    try {
      this.db
        .prepare("INSERT INTO events (ts, kind, credential_id, detail) VALUES (?, ?, ?, ?)")
        .run(ts, kind, credentialId, JSON.stringify(detail ?? {}));
      // Keep the feed bounded; this table is a UI convenience, not an audit log.
      this.db.exec(
        "DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)",
      );
    } catch (err) {
      log.debug("event_persist_failed", { err });
    }
    this.emit("event", event);
    this.emit("change");
  }

  recentEvents(limit = 100): PoolEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as {
      id: number;
      ts: number;
      kind: string;
      credential_id: number | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      credentialId: r.credential_id,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    }));
  }

  nextCursor(): number {
    return this.cursor++;
  }

  // ------------------------------------------------------- request logs

  logRequest(entry: RequestLogEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO request_logs
             (ts, client, credential_id, credential_name, model, streaming, status, outcome,
              attempts, latency_ms, prompt_tokens, completion_tokens, total_tokens,
              compressed, input_before, input_after, output_measured, output_would_save,
              error_code, error_message)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          entry.ts,
          entry.client,
          entry.credentialId,
          entry.credentialName,
          entry.model,
          entry.streaming ? 1 : 0,
          entry.status,
          entry.outcome,
          entry.attempts,
          entry.latencyMs,
          entry.promptTokens,
          entry.completionTokens,
          entry.totalTokens,
          entry.compressed ? 1 : 0,
          entry.inputBefore,
          entry.inputAfter,
          entry.outputMeasured,
          entry.outputWouldSave,
          entry.errorCode,
          entry.errorMessage,
        );
      // Bounded: this is an operational feed, not an audit trail.
      this.db.exec("DELETE FROM request_logs WHERE id <= (SELECT MAX(id) - 5000 FROM request_logs)");
    } catch (err) {
      log.debug("log_persist_failed", { err });
    }
    this.emit("log", entry);
    this.emit("change");
  }

  recentLogs(opts: { limit?: number; outcome?: string; credentialId?: number } = {}): RequestLogEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.outcome) {
      clauses.push("outcome = ?");
      params.push(opts.outcome);
    }
    if (opts.credentialId !== undefined) {
      clauses.push("credential_id = ?");
      params.push(opts.credentialId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(opts.limit ?? 200, 1000));

    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ?`)
      .all(...(params as never[])) as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      client: r.client as string | null,
      credentialId: r.credential_id as number | null,
      credentialName: r.credential_name as string | null,
      model: r.model as string | null,
      streaming: Boolean(r.streaming),
      status: r.status as number | null,
      outcome: r.outcome as RequestLogEntry["outcome"],
      attempts: r.attempts as number,
      latencyMs: r.latency_ms as number | null,
      promptTokens: r.prompt_tokens as number,
      completionTokens: r.completion_tokens as number,
      totalTokens: r.total_tokens as number,
      compressed: Boolean(r.compressed),
      inputBefore: r.input_before as number | null,
      inputAfter: r.input_after as number | null,
      outputMeasured: r.output_measured as number | null,
      outputWouldSave: r.output_would_save as number | null,
      errorCode: r.error_code as string | null,
      errorMessage: r.error_message as string | null,
    }));
  }

  /** Aggregates for the Monitor page. `since` is an epoch second. */
  stats(since: number): {
    requests: number;
    errors: number;
    tokens: number;
    avgLatencyMs: number;
    compressedRequests: number;
    inputTokensSaved: number;
    outputTokensMeasured: number;
    outputWouldSave: number;
    byHour: Array<{ hour: number; requests: number; errors: number; tokens: number }>;
    byCredential: Array<{ id: number | null; name: string; requests: number; tokens: number }>;
    byModel: Array<{ model: string; requests: number; tokens: number }>;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                COALESCE(AVG(latency_ms), 0) AS avg_latency,
                SUM(CASE WHEN compressed = 1 THEN 1 ELSE 0 END) AS compressed_requests,
                COALESCE(SUM(CASE WHEN compressed = 1
                                  THEN input_before - input_after ELSE 0 END), 0) AS input_saved,
                COALESCE(SUM(output_measured), 0) AS output_measured,
                COALESCE(SUM(output_would_save), 0) AS output_would_save
           FROM request_logs WHERE ts >= ?`,
      )
      .get(since) as Record<string, number | null>;

    const byHour = this.db
      .prepare(
        `SELECT (ts / 3600) * 3600 AS hour,
                COUNT(*) AS requests,
                SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(total_tokens), 0) AS tokens
           FROM request_logs WHERE ts >= ?
          GROUP BY hour ORDER BY hour ASC`,
      )
      .all(since) as unknown as Array<{ hour: number; requests: number; errors: number; tokens: number }>;

    const byCredential = this.db
      .prepare(
        `SELECT credential_id AS id,
                COALESCE(credential_name, 'unassigned') AS name,
                COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS tokens
           FROM request_logs WHERE ts >= ?
          GROUP BY credential_id ORDER BY requests DESC`,
      )
      .all(since) as unknown as Array<{ id: number | null; name: string; requests: number; tokens: number }>;

    const byModel = this.db
      .prepare(
        `SELECT COALESCE(model, 'unknown') AS model,
                COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS tokens
           FROM request_logs WHERE ts >= ?
          GROUP BY model ORDER BY requests DESC`,
      )
      .all(since) as unknown as Array<{ model: string; requests: number; tokens: number }>;

    return {
      requests: Number(row.requests ?? 0),
      errors: Number(row.errors ?? 0),
      tokens: Number(row.tokens ?? 0),
      avgLatencyMs: Math.round(Number(row.avg_latency ?? 0)),
      compressedRequests: Number(row.compressed_requests ?? 0),
      inputTokensSaved: Number(row.input_saved ?? 0),
      outputTokensMeasured: Number(row.output_measured ?? 0),
      outputWouldSave: Number(row.output_would_save ?? 0),
      byHour,
      byCredential,
      byModel,
    };
  }

  /**
   * Record the models an endpoint actually serves.
   *
   * Once set this is authoritative for routing, so a discovered list both
   * populates the picker and stops requests being sent for models the
   * endpoint has never heard of.
   */
  setCustomModels(id: number, models: string[]): boolean {
    if (!this.get(id)) return false;
    const clean = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    this.db
      .prepare("UPDATE credentials SET custom_models = ?, updated_at = ? WHERE id = ?")
      .run(clean.length ? JSON.stringify(clean) : null, now(), id);
    this.record("models_discovered", id, { count: clean.length });
    return true;
  }

  /**
   * A live request just succeeded on this credential, so clear whatever the
   * pool believed was wrong with it.
   *
   * Without this a connection stayed `dead` with a stale `last_error` even
   * while its test button reported `ok` — the UI said one thing and reality
   * said another. Evidence of success outranks a remembered failure.
   */
  clearFailureState(id: number): boolean {
    const before = this.get(id);
    if (!before) return false;
    if (before.state === "active" && !before.cooldownUntil && !before.lastError) return false;

    this.db
      .prepare(
        `UPDATE credentials
            SET state = 'active', cooldown_until = NULL, resets_at = NULL,
                last_error = NULL, last_error_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now(), id);

    this.record("credential_recovered", id, {
      from: before.state,
      clearedError: before.lastError,
    });
    return true;
  }

  /** Model connection tests should use. Blank clears it back to automatic. */
  setValidationModel(id: number, model: string): boolean {
    if (!this.get(id)) return false;
    const clean = model.trim();
    this.db
      .prepare("UPDATE credentials SET validation_model = ?, updated_at = ? WHERE id = ?")
      .run(clean || null, now(), id);
    this.record("validation_model_set", id, { model: clean || "auto" });
    return true;
  }

  /** Write the advanced per-connection settings. Only supplied fields change. */
  updateAdvanced(
    id: number,
    patch: {
      priority?: number;
      excludedModels?: string[];
      customUserAgent?: string | null;
      routingTags?: string[];
      perModelQuota?: boolean;
    },
  ): Credential | null {
    const current = this.get(id);
    if (!current) return null;

    const priority = patch.priority ?? current.priority;
    if (!Number.isInteger(priority) || priority < 1 || priority > 999) {
      throw new Error("Priority must be a whole number between 1 and 999.");
    }

    const clean = (list: string[] | undefined, fallback: string[]) =>
      list ? [...new Set(list.map((m) => m.trim()).filter(Boolean))] : fallback;

    const excluded = clean(patch.excludedModels, current.excludedModels);
    const tags = clean(patch.routingTags, current.routingTags);
    const ua =
      patch.customUserAgent === undefined
        ? current.customUserAgent
        : (patch.customUserAgent?.trim() || null);
    const perModel = patch.perModelQuota ?? current.perModelQuota;

    this.db
      .prepare(
        `UPDATE credentials
            SET priority = ?, excluded_models = ?, custom_user_agent = ?,
                routing_tags = ?, per_model_quota = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        priority,
        excluded.length ? JSON.stringify(excluded) : null,
        ua,
        tags.length ? JSON.stringify(tags) : null,
        perModel ? 1 : 0,
        now(),
        id,
      );

    this.record("settings_updated", id, {
      priority,
      excluded: excluded.length,
      tags: tags.length,
      perModelQuota: perModel,
    });
    return this.get(id);
  }

  /**
   * Cool one model rather than the whole connection.
   *
   * Used when `perModelQuota` is on: providers that rate-limit per model would
   * otherwise have an entire key benched because one model ran out.
   */
  coolModel(id: number, model: string, until: number, reason: string): void {
    const current = this.get(id);
    if (!current) return;

    const map = { ...current.modelCooldowns, [model]: until };
    // Drop entries that already elapsed so the column cannot grow forever.
    const at = now();
    for (const [k, v] of Object.entries(map)) if (v <= at) delete map[k];

    this.db
      .prepare(
        `UPDATE credentials
            SET model_cooldowns = ?, error_count = error_count + 1,
                last_error = ?, last_error_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(map), `${reason} (${model})`, at, at, id);

    this.record("model_cooling", id, { model, until, reason });
  }

  /** Record what a per-model probe found. */
  setModelStat(id: number, model: string, stat: ModelStat): void {
    const current = this.get(id);
    if (!current) return;
    const stats = { ...current.modelStats, [model]: stat };
    this.db
      .prepare("UPDATE credentials SET model_stats = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(stats), now(), id);
  }

  /** Hide every model whose last probe failed. */
  excludeFailedModels(id: number): string[] {
    const current = this.get(id);
    if (!current) return [];

    const failed = Object.entries(current.modelStats)
      .filter(([, s]) => !s.ok)
      .map(([m]) => m);
    if (!failed.length) return [];

    const excluded = [...new Set([...current.excludedModels, ...failed])];
    this.db
      .prepare("UPDATE credentials SET excluded_models = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(excluded), now(), id);
    this.record("models_excluded", id, { count: failed.length });
    return failed;
  }

  /** Correct a credential's endpoint, e.g. after re-detection. */
  setBaseUrl(id: number, baseUrl: string): boolean {
    if (!this.get(id)) return false;
    const clean = baseUrl.trim().replace(/\/+$/, "");
    this.db
      .prepare("UPDATE credentials SET base_url = ?, updated_at = ? WHERE id = ?")
      .run(clean || null, now(), id);
    this.record("endpoint_updated", id, { baseUrl: clean });
    return true;
  }

  /** Rename a credential. This is the name the graph and every list shows. */
  rename(id: number, name: string): boolean {
    if (!this.get(id)) return false;
    const clean = name.trim().slice(0, 60) || null;
    this.db
      .prepare("UPDATE credentials SET label = ?, updated_at = ? WHERE id = ?")
      .run(clean, now(), id);
    this.record("credential_renamed", id, { name: clean ?? `Auth ${id}` });
    return true;
  }
}
