/**
 * SQLite persistence, using Node's built-in `node:sqlite`.
 *
 * Built-in rather than better-sqlite3 so that `npm install ai-auther` never
 * needs a native toolchain. Requires Node >= 22.5.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite.js";

export type Database = DatabaseSync;

export const SCHEMA_VERSION = 15;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS credentials (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        TEXT    NOT NULL UNIQUE,
    email             TEXT,
    plan_type         TEXT,
    label             TEXT,
    access_token      TEXT,
    refresh_token     TEXT,
    id_token          TEXT,
    access_expires_at INTEGER,
    state             TEXT    NOT NULL DEFAULT 'active',
    cooldown_until    INTEGER,
    resets_at         INTEGER,
    request_count     INTEGER NOT NULL DEFAULT 0,
    success_count     INTEGER NOT NULL DEFAULT 0,
    error_count       INTEGER NOT NULL DEFAULT 0,
    token_count       INTEGER NOT NULL DEFAULT 0,
    last_used_at      INTEGER,
    last_error        TEXT,
    last_error_at     INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_credentials_state ON credentials(state);

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    credential_id INTEGER,
    detail        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `,

  // v2 — request logs and compression accounting
  `
  CREATE TABLE IF NOT EXISTS request_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    client            TEXT,
    credential_id     INTEGER,
    credential_name   TEXT,
    model             TEXT,
    streaming         INTEGER NOT NULL DEFAULT 0,
    status            INTEGER,
    outcome           TEXT    NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 1,
    latency_ms        INTEGER,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    -- Caveman accounting. Input is genuinely compressed; output is measured
    -- only, so output_saved_tokens is always a hypothetical.
    compressed        INTEGER NOT NULL DEFAULT 0,
    input_before      INTEGER,
    input_after       INTEGER,
    output_measured   INTEGER,
    output_would_save INTEGER,
    error_code        TEXT,
    error_message     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts);
  CREATE INDEX IF NOT EXISTS idx_logs_credential ON request_logs(credential_id);
  `,

  // v3 — the built-in chat playground
  `
  CREATE TABLE IF NOT EXISTS conversations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    title                TEXT,
    model                TEXT,
    reasoning_effort     TEXT,
    -- NULL means "use normal rotation"; a value pins every turn to one Auth.
    pinned_credential_id INTEGER,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,
    content         TEXT    NOT NULL,
    credential_id   INTEGER,
    credential_name TEXT,
    tokens          INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER,
    error           TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_conversation
    ON chat_messages(conversation_id, id);
  `,

  // v4 — multi-provider support (Gemini API, Custom Providers, Codex OAuth)
  //
  // The default is `codex_oauth` because every row that predates this column
  // was created by the OAuth flow. It originally read 'gemini', which silently
  // relabelled every existing ChatGPT credential as a Google API key — the
  // gateway then posted OAuth JWTs to Google and got "Please pass a valid API
  // key". Migration v5 repairs databases that ran the original version.
  `
  ALTER TABLE credentials ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'codex_oauth';
  ALTER TABLE credentials ADD COLUMN base_url TEXT;
  ALTER TABLE credentials ADD COLUMN custom_models TEXT;
  `,

  // v5 — repair provider_type on databases that ran the original v4
  //
  // Only the OAuth flow produces an id_token *and* a refresh_token, so that
  // pair identifies a ChatGPT credential unambiguously. API-key providers have
  // neither. Scoped to rows still marked 'gemini' so a deliberate
  // reclassification is never undone.
  `
  UPDATE credentials
     SET provider_type = 'codex_oauth'
   WHERE provider_type = 'gemini'
     AND id_token IS NOT NULL
     AND refresh_token IS NOT NULL;
  `,

  // v6 — normalise a short-lived typo.
  //
  // An interim build of v5 wrote 'chatgpt_oauth', which is not one of the
  // three values the code recognises. Rows left with it would never refresh
  // their access token, because `needsRefresh` tests for 'codex_oauth'.
  `
  UPDATE credentials SET provider_type = 'codex_oauth' WHERE provider_type = 'chatgpt_oauth';
  `,

  // v7 — separate "which service" from "which protocol".
  //
  // provider_type says how to talk to the endpoint; several services share a
  // protocol (OpenAI, OpenRouter and a self-hosted proxy are all
  // `openai_custom`). Grouping the UI by protocol lumped them together, so
  // provider_id records the service itself. Backfilled from the base URL.
  `
  ALTER TABLE credentials ADD COLUMN provider_id TEXT;

  UPDATE credentials SET provider_id = 'codex'      WHERE provider_type = 'codex_oauth';
  UPDATE credentials SET provider_id = 'gemini'     WHERE provider_type = 'gemini';
  UPDATE credentials SET provider_id = 'openrouter'
   WHERE provider_id IS NULL AND base_url LIKE '%openrouter.ai%';
  UPDATE credentials SET provider_id = 'openai'
   WHERE provider_id IS NULL AND base_url LIKE '%api.openai.com%';
  UPDATE credentials SET provider_id = 'custom' WHERE provider_id IS NULL;
  `,

  // v8 — per-credential validation model.
  //
  // Connection tests were probing whatever model came first, which on a
  // provider with a mixed free/paid catalogue picked a premium model and
  // reported a healthy key as broken. Blank means "first available".
  `
  ALTER TABLE credentials ADD COLUMN validation_model TEXT;
  `,

  // v9 — per-connection advanced settings.
  //
  //   priority          lower runs first within a rotation strategy
  //   excluded_models   models this connection must never be given
  //   custom_user_agent overrides the UA for web-session providers
  //   routing_tags      only serve requests asking for one of these tags
  //   per_model_quota   a 429/404 locks just that model, not the connection
  //   model_cooldowns   {model: untilEpoch} used when per_model_quota is on
  `
  ALTER TABLE credentials ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE credentials ADD COLUMN excluded_models TEXT;
  ALTER TABLE credentials ADD COLUMN custom_user_agent TEXT;
  ALTER TABLE credentials ADD COLUMN routing_tags TEXT;
  ALTER TABLE credentials ADD COLUMN per_model_quota INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE credentials ADD COLUMN model_cooldowns TEXT;
  `,

  // v10 — Caveman history.
  //
  // Compression was only observable as an aggregate token count, so there was
  // no way to see what it actually did to a prompt — or why it declined to.
  // Stores what went in, what came out, and the outcome.
  `
  CREATE TABLE IF NOT EXISTS caveman_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    outcome       TEXT    NOT NULL,
    model         TEXT,
    before_tokens INTEGER NOT NULL DEFAULT 0,
    after_tokens  INTEGER NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    input_text    TEXT,
    output_text   TEXT,
    error         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_caveman_ts ON caveman_history(ts);
  `,

  // v11 — per-model test results.
  //
  // {model: {ok, latencyMs, ts, error}} per credential. Drives the model list
  // in Advanced settings: which models actually answer, how fast, and which to
  // hide. Latency here is also what the `fast` virtual model ranks on.
  `
  ALTER TABLE credentials ADD COLUMN model_stats TEXT;
  `,

  // v12 — add Kimi K3 to existing Kimi Web connections.
  //
  // Older rows have a discovered custom model list containing only K2 ids.
  // Keep those rows usable while making the newly available K3 selectable.
  `
  UPDATE credentials
     SET custom_models = CASE
       WHEN custom_models IS NULL OR trim(custom_models) = ''
         THEN '["kimi-k2","kimi-k2-thinking","kimi-k3"]'
       WHEN custom_models LIKE '%"kimi-k3"%'
         THEN custom_models
       ELSE substr(custom_models, 1, length(custom_models) - 1) || ',"kimi-k3"]'
     END
   WHERE provider_id = 'kimi-web';
  `,

  // v13 — persist the dashboard provider selection. NULL preserves normal
  // all-provider rotation for existing conversations.
  `
  ALTER TABLE conversations ADD COLUMN provider_id TEXT;
  `,

  // v14 — which wire protocol a custom endpoint speaks.
  //
  // "OpenAI-compatible" was assumed for every custom provider, so pointing one
  // at an Anthropic-style endpoint produced a 404 on /chat/completions with no
  // explanation. NULL means "not yet determined": detection fills it in, and
  // routing falls back to the OpenAI shape, so existing rows behave as before.
  `
  ALTER TABLE credentials ADD COLUMN protocol TEXT;
  `,

  // v15 — what the provider said about each model, not just its name.
  //
  // Discovery already received per-model facts and discarded them: Antigravity
  // publishes `supportsImages`, `supportsThinking`, `maxTokens` and a
  // `deprecatedModelIds` remap, and OpenRouter publishes input modalities.
  // Flattening that to a list of ids left the capability gate with only a
  // curated table of GPT names, so every other model resolved to "unknown" —
  // whose vision flag is false — and image requests were refused locally for
  // models that accept images. NULL means "nothing discovered yet", which
  // behaves exactly as before.
  //
  // {model: {displayName, vision, reasoning, tools, contextWindow,
  //          replacedBy, chat, discoveredAt}}
  //
  // `models_synced_at` is what the periodic refresh checks against its TTL.
  // NULL means never synced, so the first sweep after an upgrade refreshes
  // every existing connection.
  `
  ALTER TABLE credentials ADD COLUMN model_metadata TEXT;
  ALTER TABLE credentials ADD COLUMN models_synced_at INTEGER;
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Windows and filesystems without POSIX modes may ignore this.
    }
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  if (path !== ":memory:") {
    // The database holds live OAuth tokens. Treat it like an SSH private key.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        // File may not exist yet, or the OS may not implement POSIX modes.
      }
    }
  }
  return db;
}

function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const rows = db.prepare("SELECT version FROM schema_version ORDER BY rowid").all() as Array<{
    version: number;
  }>;
  if (rows.length > 1 || (rows[0] && (!Number.isInteger(rows[0].version) || rows[0].version < 0))) {
    throw new Error("Invalid schema version metadata; refusing to use the database.");
  }
  let current = rows[0]?.version ?? 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}). ` +
        `Upgrade ai-auther.`,
    );
  }

  while (current < SCHEMA_VERSION) {
    const sql = MIGRATIONS[current];
    if (!sql) throw new Error(`Missing migration for version ${current + 1}`);
    db.exec("BEGIN");
    try {
      db.exec(sql);
      current += 1;
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(current);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Epoch seconds. Used everywhere instead of ms because upstream `resets_at` is in seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
