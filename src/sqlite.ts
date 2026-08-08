/**
 * `node:sqlite` access.
 *
 * Loaded through `createRequire` rather than a static import because bundlers
 * (Vite/Rollup, which vitest runs on) strip the `node:` prefix and then look
 * for a bare `sqlite` builtin. That builtin does not exist — `node:sqlite` is
 * only addressable with the prefix — so a static import fails to resolve at
 * transform time even though Node itself handles it fine.
 *
 * A runtime `require` is opaque to static analysis, so it passes straight
 * through to Node. The type import below is erased at compile time and never
 * reaches a bundler.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

const sqlite = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = DatabaseSyncType;
