#!/usr/bin/env node
/**
 * open-auther CLI.
 *
 * `open-auther` with no arguments starts the gateway, which is the common case.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { loadConfig, generateGatewayKey, type Config } from "./config.js";
import { now, openDatabase, type Database } from "./db.js";
import { configureLogging, createLogger, maskEmail } from "./logging.js";
import { beginLogin, openBrowser } from "./core/login.js";
import { importCredentials } from "./core/import.js";
import { CredentialStore, DuplicateAccountError, toPublic } from "./pool/store.js";

const VERSION = "1.0.0";

const C = {
  reset: "[0m",
  dim: "[90m",
  bold: "[1m",
  cyan: "[36m",
  green: "[32m",
  yellow: "[33m",
  red: "[31m",
  magenta: "[35m",
};

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

function bootstrap(): { cfg: Config; store: CredentialStore; db: Database } {
  const cfg = loadConfig();
  configureLogging({ level: cfg.logLevel, pretty: cfg.logPretty });
  const db = openDatabase(cfg.dbPath);
  return { cfg, store: new CredentialStore(db), db };
}

// --------------------------------------------------------------------- serve

async function cmdServe(): Promise<void> {
  const { cfg, store, db } = bootstrap();
  const app = createApp(cfg, store, db);

  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    const base = `http://${cfg.host}:${info.port}`;
    const key = cfg.gatewayKeys[0]?.key ?? "";
    const creds = store.all();
    const active = creds.filter((c) => c.state === "active").length;

    out();
    out(`  ${C.bold}${C.magenta}open-auther${C.reset} ${C.dim}v${VERSION}${C.reset}`);
    out(`  ${C.dim}${"─".repeat(58)}${C.reset}`);
    out(`  ${C.dim}base_url${C.reset}   ${C.cyan}${base}/v1${C.reset}`);
    out(`  ${C.dim}api_key${C.reset}    ${C.green}${key}${C.reset}`);
    out(`  ${C.dim}dashboard${C.reset}  ${C.cyan}${base}/omni#key=${key}${C.reset}`);
    out(`  ${C.dim}${"─".repeat(58)}${C.reset}`);
    out(
      `  ${C.dim}pool${C.reset}       ${creds.length} credential(s), ${active} active` +
        `   ${C.dim}rotation:${C.reset} ${cfg.rotation}`,
    );
    if (creds.length === 0) {
      out(`  ${C.yellow}No credentials yet. Run:${C.reset} open-auther auth login`);
    }
    out();
    out(
      `  ${C.dim}The api_key above is stored in ${cfg.configPath}. Treat the data${C.reset}`,
    );
    out(`  ${C.dim}directory as sensitive: it holds live OAuth tokens.${C.reset}`);
    out();
  });

  // Without this, a bind failure surfaces as an unhandled 'error' event and a
  // raw Node stack trace, which reads like a crash rather than a busy port.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      out();
      out(`  ${C.red}Port ${cfg.port} is already in use.${C.reset}`);
      out(`  ${C.dim}Another open-auther may already be running. Stop it, or pick${C.reset}`);
      out(`  ${C.dim}another port with AI_AUTHER_PORT=<port>.${C.reset}`);
      out();
    } else if (err.code === "EACCES") {
      out();
      out(`  ${C.red}Not permitted to bind ${cfg.host}:${cfg.port}.${C.reset}`);
      out(`  ${C.dim}Ports below 1024 usually need elevated privileges.${C.reset}`);
      out();
    } else {
      createLogger({ mod: "cli" }).error("server_error", { err });
    }
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    out(`\n${C.dim}${signal} received, shutting down.${C.reset}`);
    server.close(() => process.exit(0));
    // Do not wait forever on open SSE streams.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------- auth login

async function cmdAuthLogin(args: string[]): Promise<void> {
  const { cfg, store } = bootstrap();
  const labelIdx = args.indexOf("--label");
  const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? null) : null;

  out();
  out(`  ${C.bold}${C.yellow}Before you continue${C.reset}`);
  out(`  ${C.dim}${"─".repeat(58)}${C.reset}`);
  out(`  Open the link in a ${C.bold}fresh private/incognito window${C.reset}.`);
  out(`  ${C.dim}If the browser already has a ChatGPT session, this flow signs in${C.reset}`);
  out(`  ${C.dim}silently as THAT account and hands back a credential you already${C.reset}`);
  out(`  ${C.dim}have. open-auther will reject the duplicate, but you will have${C.reset}`);
  out(`  ${C.dim}wasted the round trip.${C.reset}`);
  out();

  const { authorizeUrl, completed } = beginLogin(cfg);
  out(`  ${C.dim}Opening:${C.reset}`);
  out(`  ${C.cyan}${authorizeUrl}${C.reset}`);
  out();
  out(`  ${C.dim}Waiting for the callback...${C.reset}`);
  openBrowser(authorizeUrl);

  try {
    const result = await completed;
    const credential = store.add({
      accountId: result.accountId,
      email: result.email,
      planType: result.planType,
      label,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken,
      accessExpiresAt: result.accessExpiresAt,
    });
    out();
    out(
      `  ${C.green}Added${C.reset} #${credential.id}  ${maskEmail(credential.email)}` +
        `  ${C.dim}plan:${C.reset} ${credential.planType ?? "unknown"}`,
    );
    out();
    process.exit(0);
  } catch (err) {
    out();
    if (err instanceof DuplicateAccountError) {
      out(`  ${C.yellow}Duplicate account.${C.reset} ${err.message}`);
      process.exit(2);
    }
    out(`  ${C.red}Login failed.${C.reset} ${(err as Error).message}`);
    process.exit(1);
  }
}

// --------------------------------------------------------------- auth import

function cmdAuthImport(args: string[]): void {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    out(`${C.red}Usage:${C.reset} open-auther auth import <path-to-credentials.json> [--name X]`);
    process.exit(1);
  }
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? (args[nameIdx + 1] ?? null) : null;

  const { store } = bootstrap();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (err) {
    out(`${C.red}Could not read ${file}:${C.reset} ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const result = importCredentials(store, parsed, name);
    for (const a of result.added) {
      out(
        `  ${C.green}Added${C.reset} #${a.id}  ${a.name}  ${C.dim}${a.email}  plan:${C.reset} ` +
          `${a.plan ?? "unknown"}`,
      );
    }
    for (const s of result.skipped) {
      out(`  ${C.yellow}Skipped${C.reset} ${s.detail}`);
    }
    out();
    out(`  ${result.added.length} added, ${result.skipped.length} skipped.`);
  } catch (err) {
    out(`${C.red}Import failed:${C.reset} ${(err as Error).message}`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------- auth list

function stateColor(state: string): string {
  return state === "active" ? C.green : state === "cooling" ? C.yellow : C.red;
}

function relative(ts: number | null): string {
  if (!ts) return "-";
  const delta = ts - now();
  const abs = Math.abs(delta);
  const unit =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86400)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

function cmdAuthList(): void {
  const { store } = bootstrap();
  const creds = store.all().map((c) => toPublic(c));
  if (creds.length === 0) {
    out();
    out(`  ${C.dim}No credentials. Add one with:${C.reset} open-auther auth login`);
    out();
    return;
  }

  out();
  out(
    `  ${C.dim}${"ID".padEnd(4)}${"ACCOUNT".padEnd(26)}${"PLAN".padEnd(10)}` +
      `${"STATE".padEnd(10)}${"REQS".padEnd(8)}RESETS${C.reset}`,
  );
  for (const c of creds) {
    const state = c.effectiveState;
    out(
      `  ${String(c.id).padEnd(4)}${c.emailMasked.padEnd(26)}` +
        `${(c.planType ?? "-").padEnd(10)}` +
        `${stateColor(state)}${state.padEnd(10)}${C.reset}` +
        `${String(c.requestCount).padEnd(8)}` +
        `${relative(c.resetsAt ?? c.cooldownUntil)}`,
    );
    if (c.lastError) out(`  ${C.dim}    last error: ${c.lastError}${C.reset}`);
  }
  out();
}

// -------------------------------------------------------------------- status

function cmdStatus(): void {
  const { cfg, store } = bootstrap();
  const creds = store.all();
  const active = creds.filter((c) => c.state === "active" && (c.cooldownUntil ?? 0) <= now());
  out();
  out(`  ${C.bold}open-auther${C.reset} ${C.dim}v${VERSION}${C.reset}`);
  out(`  ${C.dim}data${C.reset}      ${cfg.home}`);
  out(`  ${C.dim}rotation${C.reset}  ${cfg.rotation}`);
  out(`  ${C.dim}pool${C.reset}      ${creds.length} total, ${active.length} available`);
  const recovery = store.earliestRecovery();
  if (active.length === 0 && recovery) {
    out(`  ${C.yellow}Pool is dry.${C.reset} First recovery ${relative(recovery)}.`);
  }
  out();
  cmdAuthList();
}

// ----------------------------------------------------------------- key mgmt

function cmdKey(args: string[]): void {
  const { cfg } = bootstrap();
  const sub = args[0] ?? "show";

  if (sub === "show") {
    out();
    for (const k of cfg.gatewayKeys) out(`  ${k.name.padEnd(14)} ${C.green}${k.key}${C.reset}`);
    out();
    out(`  ${C.dim}Stored in ${cfg.configPath}${C.reset}`);
    out();
    return;
  }

  if (sub === "new") {
    out();
    out(`  ${C.green}${generateGatewayKey()}${C.reset}`);
    out();
    out(`  ${C.dim}Add it to the gatewayKeys array in ${cfg.configPath}${C.reset}`);
    out(`  ${C.dim}as {"name": "<label>", "key": "<the key above>"}, then restart.${C.reset}`);
    out();
    return;
  }

  out(`${C.red}Unknown:${C.reset} open-auther key ${sub}`);
  process.exit(1);
}

// --------------------------------------------------------------------- misc

function cmdRevive(args: string[]): void {
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) {
    out(`${C.red}Usage:${C.reset} open-auther auth revive <id>`);
    process.exit(1);
  }
  const { store } = bootstrap();
  out(store.revive(id) ? `  ${C.green}Revived${C.reset} #${id}` : `  ${C.red}No credential #${id}${C.reset}`);
}

function cmdRemove(args: string[]): void {
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) {
    out(`${C.red}Usage:${C.reset} open-auther auth remove <id>`);
    process.exit(1);
  }
  const { store } = bootstrap();
  out(store.remove(id) ? `  ${C.green}Removed${C.reset} #${id}` : `  ${C.red}No credential #${id}${C.reset}`);
}

function usage(): void {
  out(`
  ${C.bold}${C.magenta}open-auther${C.reset} ${C.dim}v${VERSION}${C.reset}
  OpenAI-compatible gateway over a pool of ChatGPT/Codex OAuth credentials.

  ${C.bold}Usage${C.reset}
    open-auther [serve]                 Start the gateway and dashboard
    open-auther status                  Pool summary
    open-auther auth login [--label X]  Add an account (use a private window)
    open-auther auth import <file>      Import credentials from JSON
    open-auther auth list               List accounts
    open-auther auth revive <id>        Return a dead credential to rotation
    open-auther auth remove <id>        Delete a credential
    open-auther key show|new            Gateway API keys

  ${C.bold}Environment${C.reset}
    AI_AUTHER_HOME        Data directory (default ~/.open-auther)
    AI_AUTHER_PORT        Listen port (default 8787)
    AI_AUTHER_HOST        Bind address (default 127.0.0.1)
    AI_AUTHER_API_KEY     Override the gateway key
    AI_AUTHER_ROTATION    fill_first | round_robin | least_used | random
    AI_AUTHER_LOG_LEVEL   debug | info | warn | error
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") return void out(VERSION);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return usage();

  if (!cmd || cmd === "serve") return cmdServe();
  if (cmd === "status") return cmdStatus();
  if (cmd === "key") return cmdKey(argv.slice(1));

  if (cmd === "auth") {
    const sub = argv[1];
    const rest = argv.slice(2);
    if (sub === "login") return cmdAuthLogin(rest);
    if (sub === "import") return cmdAuthImport(rest);
    if (sub === "list" || sub === "ls") return cmdAuthList();
    if (sub === "revive") return cmdRevive(rest);
    if (sub === "remove" || sub === "rm") return cmdRemove(rest);
    out(`${C.red}Unknown:${C.reset} open-auther auth ${sub ?? ""}`);
    process.exit(1);
  }

  out(`${C.red}Unknown command:${C.reset} ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((err: unknown) => {
  const log = createLogger({ mod: "cli" });
  log.error("fatal", { err });
  process.exit(1);
});
