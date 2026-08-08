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
