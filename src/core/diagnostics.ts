import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import { providerDef, type ProviderDef } from "./providers.js";
import { ProviderRegistry } from "./provider-registry.js";
import { effectiveState, isAvailable } from "../pool/store.js";
import type { Credential } from "../pool/types.js";
import type { StorageHealth } from "../storage.js";

export type ProviderHealth = "unconfigured" | "ready" | "degraded" | "offline";
export type DiagnosticLevel = "pass" | "warn" | "fail";

export interface ProviderStatus {
  id: string;
  label: string;
  auth: string[];
  providerType: string | null;
  configured: number;
  available: number;
  cooling: number;
  dead: number;
  health: ProviderHealth;
  discoverable: boolean;
  models: string[];
}

export interface DoctorCheck {
  id: string;
  level: DiagnosticLevel;
  label: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  providers: ProviderStatus[];
  storage: StorageHealth | null;
}

const fallbackDefinition = (id: string): ProviderDef => ({
  id,
  label: id,
  blurb: "Provider registered by a stored connection.",
  providerType: "openai_custom",
  baseUrl: "",
  auth: ["custom"],
  multiKey: true,
  keyHint: "",
  keyUrl: null,
  probeModel: null,
  listsModels: false,
  defaultModels: [],
});

function definitions(registry: ProviderRegistry, credentials: readonly Credential[]): ProviderDef[] {
  const out = new Map<string, ProviderDef>();
  for (const plugin of registry.list()) out.set(plugin.id, plugin.definition);
  for (const credential of credentials) {
    if (!out.has(credential.providerId)) out.set(credential.providerId, providerDef(credential.providerId) ?? fallbackDefinition(credential.providerId));
  }
  return [...out.values()];
}

/** Build a safe provider inventory from registry metadata and stored public state. */
export function buildProviderStatus(
  registry: ProviderRegistry,
  credentials: readonly Credential[],
  at = Math.floor(Date.now() / 1000),
): ProviderStatus[] {
  const grouped = new Map<string, Credential[]>();
  for (const credential of credentials) {
    const list = grouped.get(credential.providerId) ?? [];
    list.push(credential);
    grouped.set(credential.providerId, list);
  }

  return definitions(registry, credentials).map((definition) => {
    const items = grouped.get(definition.id) ?? [];
    const available = items.filter((credential) => isAvailable(credential, at)).length;
    const cooling = items.filter((credential) => effectiveState(credential, at) === "cooling").length;
    const dead = items.filter((credential) => effectiveState(credential, at) === "dead").length;
    const models = [...new Set(items.flatMap((credential) => credential.customModels ?? definition.defaultModels))];
    const health: ProviderHealth =
      items.length === 0 ? "unconfigured" : available > 0 ? (cooling || dead ? "degraded" : "ready") : "offline";

    return {
      id: definition.id,
      label: definition.label,
      auth: [...definition.auth],
      providerType: definition.providerType,
      configured: items.length,
      available,
      cooling,
      dead,
      health,
      discoverable: definition.listsModels,
      models,
    };
  });
}

/** Local, deterministic checks suitable for CI, support bundles, and operators. */
export function buildDoctorReport(
  cfg: Config,
  registry: ProviderRegistry,
  credentials: readonly Credential[],
  at = Math.floor(Date.now() / 1000),
  storage: StorageHealth | null = null,
): DoctorReport {
  const statuses = buildProviderStatus(registry, credentials, at);
  const available = credentials.filter((credential) => isAvailable(credential, at)).length;
  const checks: DoctorCheck[] = [
    {
      id: "data-home",
      level: existsSync(cfg.home) ? "pass" : "fail",
      label: "Data directory",
      message: existsSync(cfg.home) ? cfg.home : `Missing directory: ${cfg.home}`,
    },
    {
      id: "database",
      level: existsSync(cfg.dbPath) ? "pass" : "fail",
      label: "Credential database",
      message: existsSync(cfg.dbPath) ? "SQLite database is present." : `Missing database: ${cfg.dbPath}`,
    },
    {
      id: "gateway-key",
      level: cfg.gatewayKeys.length > 0 ? "pass" : "fail",
      label: "Gateway authentication",
      message: cfg.gatewayKeys.length > 0 ? `${cfg.gatewayKeys.length} gateway key(s) configured.` : "No gateway API key configured.",
    },
    {
      id: "provider-registry",
      level: registry.list().length > 0 ? "pass" : "fail",
      label: "Provider registry",
      message: `${registry.list().length} provider definition(s) registered.`,
    },
    {
      id: "model-catalogue",
      level: cfg.models.length > 0 ? "pass" : "warn",
      label: "Model catalogue",
      message: cfg.models.length > 0 ? `${cfg.models.length} configured model(s).` : "No configured models; discovery or custom models are required.",
    },
    {
      id: "routing-pool",
      level: available > 0 ? "pass" : credentials.length > 0 ? "warn" : "warn",
      label: "Routing pool",
      message:
        available > 0
          ? `${available}/${credentials.length} credential(s) available for routing.`
          : credentials.length > 0
            ? "Credentials exist, but none are currently available."
            : "No provider credentials configured yet.",
    },
  ];

  if (storage) {
    checks.splice(2, 0, {
      id: "storage-integrity",
      level: storage.healthy ? "pass" : "fail",
      label: "Storage integrity",
      message:
        `schema ${storage.schemaVersion}/${storage.expectedSchemaVersion}, ` +
        `integrity ${storage.integrity}, foreign keys ${storage.foreignKeys ? "on" : "off"}, ` +
        `journal ${storage.journalMode}`,
    });
  }

  return {
    ok: checks.every((check) => check.level !== "fail"),
    checks,
    providers: statuses,
    storage,
  };
}
