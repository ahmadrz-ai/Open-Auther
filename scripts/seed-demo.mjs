/**
 * Development helper: fill a pool with SYNTHETIC credentials so the dashboard
 * can be worked on without real accounts.
 *
 * The tokens generated here are fake JWTs signed with nothing. They cannot
 * authenticate against anything. Never point this at a database that holds
 * real credentials — it writes into whatever AI_AUTHER_HOME resolves to.
 *
 *   node scripts/seed-demo.mjs [count]
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.AI_AUTHER_HOME
  ? resolve(process.env.AI_AUTHER_HOME)
  : join(homedir(), ".ai-auther");
const dbPath = process.env.AI_AUTHER_DB ? resolve(process.env.AI_AUTHER_DB) : join(home, "ai-auther.db");

// Hard gate. Seeded rows are indistinguishable from real ones in the UI, so
// this must never be runnable by accident.
if (!process.argv.includes("--i-know-this-is-fake-data")) {
  console.error(
    "\nRefusing to run.\n\n" +
      "This writes SYNTHETIC credentials into a real database and they will look\n" +
      "exactly like connected accounts in the dashboard. Pass the flag if that is\n" +
      "genuinely what you want:\n\n" +
      "  node scripts/seed-demo.mjs 7 --i-know-this-is-fake-data\n\n" +
      "Point AI_AUTHER_HOME at a scratch directory first.\n",
  );
  process.exit(1);
}

const count = Number.parseInt(process.argv[2] ?? "6", 10);
const now = Math.floor(Date.now() / 1000);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function fakeJwt(claims) {
  return [b64({ alg: "none", typ: "JWT" }), b64(claims), "synthetic-not-a-signature"].join(".");
}

const PLANS = ["free", "plus", "free", "pro", "free", "plus"];
const STATES = ["active", "active", "cooling", "active", "dead", "cooling"];

// The gateway normally creates this on first run; seeding may happen first.
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

const insert = db.prepare(`
  INSERT OR IGNORE INTO credentials
    (account_id, email, plan_type, access_token, refresh_token, id_token,
     access_expires_at, state, cooldown_until, resets_at,
     request_count, success_count, error_count, token_count,
     last_used_at, last_error, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

for (let i = 0; i < count; i++) {
  const accountId = `demo-account-${i + 1}`;
  const email = `demo.user${i + 1}@example.com`;
  const plan = PLANS[i % PLANS.length];
  const state = STATES[i % STATES.length];
  const idToken = fakeJwt({
    email,
    exp: now + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
  });

  const cooling = state === "cooling";
  const requests = Math.floor(Math.random() * 400);

  insert.run(
    accountId,
    email,
    plan,
    fakeJwt({ exp: now + 3600, sub: accountId }),
    `synthetic-refresh-${i + 1}`,
    idToken,
    now + 3600,
    state,
    cooling ? now + 900 + i * 600 : null,
    cooling ? now + 900 + i * 600 : null,
    requests,
    Math.floor(requests * 0.94),
    state === "dead" ? 3 : cooling ? 1 : 0,
    requests * 1800,
    now - Math.floor(Math.random() * 3600),
    state === "dead" ? "token_invalidated" : cooling ? "usage_limit_reached" : null,
    now - 86400,
    now,
  );
}

console.log(`seeded ${count} synthetic credentials into ${dbPath}`);
console.log("These are fake tokens for UI development only.");
