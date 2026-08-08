import type { Database } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";

export { SCHEMA_VERSION } from "./db.js";

export interface StorageHealth {
  path: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  integrity: string;
  foreignKeys: boolean;
  journalMode: string;
  healthy: boolean;
}

function pragmaValue(db: Database, pragma: string): unknown {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/** Read-only storage diagnostics. Never selects credential or token columns. */
export function inspectStorage(db: Database, path: string): StorageHealth {
  const row = db.prepare("SELECT version FROM schema_version ORDER BY rowid LIMIT 1").get() as
    | { version: number }
    | undefined;
  const schemaVersion = row?.version ?? 0;
  const integrity = String(pragmaValue(db, "integrity_check") ?? "unknown");
  const foreignKeys = Number(pragmaValue(db, "foreign_keys") ?? 0) === 1;
  const journalMode = String(pragmaValue(db, "journal_mode") ?? "unknown");

  return {
    path,
    schemaVersion,
    expectedSchemaVersion: SCHEMA_VERSION,
    integrity,
    foreignKeys,
    journalMode,
    healthy:
      schemaVersion === SCHEMA_VERSION && integrity.toLowerCase() === "ok" && foreignKeys,
  };
}
