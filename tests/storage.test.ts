import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { DatabaseSync } from "../src/sqlite.js";
import { inspectStorage, SCHEMA_VERSION } from "../src/storage.js";

describe("local-first storage", () => {
  it("opens an idempotent database with healthy migration state", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-auther-storage-"));
    const path = join(dir, "gateway.sqlite");
    try {
      const first = openDatabase(path);
      const status = inspectStorage(first, path);
      first.close();

      const second = openDatabase(path);
      const again = inspectStorage(second, path);
      second.close();

      expect(status.schemaVersion).toBe(SCHEMA_VERSION);
      expect(status.integrity).toBe("ok");
      expect(status.foreignKeys).toBe(true);
      expect(status.schemaVersion).toBe(again.schemaVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the model metadata columns and leaves existing rows routable", () => {
    /*
     * The upgrade path that matters: a database created before discovery kept
     * per-model facts must gain the columns without disturbing what it already
     * routes on. NULL metadata is the correct "nothing discovered yet" state,
     * and a NULL sync timestamp is what makes the first sweep pick the row up.
     */
    const dir = mkdtempSync(join(tmpdir(), "open-auther-migrate-"));
    const path = join(dir, "existing.sqlite");
    try {
      const db = openDatabase(path);
      db.prepare(
        `INSERT INTO credentials
           (account_id, custom_models, access_token, state, created_at, updated_at)
         VALUES ('legacy', '["gemini-3.5-flash"]', 'tok', 'active', 1, 1)`,
      ).run();

      const columns = (db.prepare("PRAGMA table_info(credentials)").all() as Array<{
        name: string;
      }>).map((row) => row.name);
      expect(columns).toContain("model_metadata");
      expect(columns).toContain("models_synced_at");

      const row = db
        .prepare("SELECT custom_models, model_metadata, models_synced_at FROM credentials")
        .get() as Record<string, unknown>;
      expect(row.custom_models).toBe('["gemini-3.5-flash"]');
      expect(row.model_metadata).toBeNull();
      expect(row.models_synced_at).toBeNull();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a future schema version before using the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-auther-storage-"));
    const path = join(dir, "future.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL);");
      raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION + 1);
      raw.close();

      expect(() => openDatabase(path)).toThrow(/newer than this build supports/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed schema-version rows with a direct error", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-auther-storage-"));
    const path = join(dir, "corrupt.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL);");
      raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(-1);
      raw.close();

      expect(() => openDatabase(path)).toThrow(/invalid schema version/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
