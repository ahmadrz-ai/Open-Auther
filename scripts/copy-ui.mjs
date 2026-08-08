/**
 * Copy the static dashboard into dist/ so the published package ships a
 * ready-to-serve UI. There is no frontend build step on purpose: `npm install`
 * should never need to compile anything.
 */

import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "ui");
const to = join(root, "dist", "ui");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

console.log(`ui: ${from} -> ${to}`);
