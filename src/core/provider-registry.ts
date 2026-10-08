/**
 * Extension surface for third-party provider integrations.
 *
 * The registry deliberately owns only provider identity and metadata. Transport,
 * authentication, and routing adapters can be added around this contract without
 * forcing external providers to edit the built-in catalogue.
 */

import type { ProviderDef } from "./providers.js";
import type { Config } from "../config.js";
import type { Credential } from "../pool/types.js";
import type { DiscoveredModel } from "./model-metadata.js";

export interface ProviderPlugin {
  /** Stable lowercase identifier used in configuration and routing. */
  readonly id: string;
  /** Provider metadata consumed by onboarding, discovery, and the dashboard. */
  readonly definition: ProviderDef;
  /** Explicit adapters for external providers. Legacy built-ins may migrate
   * incrementally while the central transports remain supported. */
  readonly auth?: readonly ProviderAuthAdapter[];
  readonly refresh?: ProviderRefreshAdapter;
  readonly discovery?: ProviderDiscoveryAdapter;
  readonly health?: ProviderHealthAdapter;
  readonly transport?: ProviderTransportAdapter;
  readonly classifyError?: ProviderErrorClassifier;
}

export interface ProviderAuthAdapter {
  readonly id: string;
  readonly kind: "oauth" | "api_key" | "custom" | "web_cookie";
  readonly begin?: (context: { cfg: Config; signal?: AbortSignal }) => unknown;
}

export interface ProviderRefreshAdapter {
  refresh(context: {
    cfg: Config;
    credential: Credential;
    signal?: AbortSignal;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number | null }>;
}

export interface ProviderDiscoveryAdapter {
  discover(context: {
    cfg: Config;
    credential: Credential;
    signal?: AbortSignal;
  }): Promise<readonly DiscoveredModel[]>;
}

export interface ProviderHealthAdapter {
  check(context: {
    cfg: Config;
    credential: Credential;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; latencyMs?: number; message?: string }>;
}

export interface ProviderTransportAdapter {
  call(context: {
    cfg: Config;
    credential: Credential;
    request: unknown;
    signal: AbortSignal;
  }): Promise<
    | { ok: true; response: Response }
    | { ok: false; status: number; message: string; code?: string }
  >;
}

export interface ProviderErrorClassifier {
  classify(input: {
    status: number | null;
    body?: unknown;
    message?: string;
  }): { kind: "terminal" | "transient" | "client"; code?: string; message: string };
}

const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function validatePlugin(plugin: ProviderPlugin): void {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError("Provider plugin must be an object.");
  }
  if (!PROVIDER_ID.test(plugin.id)) {
    throw new Error(
      `Provider plugin id "${plugin.id}" is invalid. Use lowercase letters, numbers, '-' or '_'.`,
    );
  }
  if (!plugin.definition || plugin.definition.id !== plugin.id) {
    throw new Error(`Provider plugin id "${plugin.id}" must match its definition id.`);
  }
  for (const auth of plugin.auth ?? []) {
    if (!auth.id.trim()) throw new Error(`Provider "${plugin.id}" has an auth adapter without an id.`);
    if (!auth.kind) throw new Error(`Provider "${plugin.id}" has an auth adapter without a kind.`);
  }
}

export interface ProviderSummary {
  id: string;
  label: string;
  auth: string[];
  models: string[];
  listsModels: boolean;
}

export function providerSummaries(registry: ProviderRegistry): ProviderSummary[] {
  return registry.list().map(({ definition }) => ({
    id: definition.id,
    label: definition.label,
    auth: [...definition.auth],
    models: [...definition.defaultModels],
    listsModels: definition.listsModels,
  }));
}

export class ProviderRegistry {
  private readonly plugins = new Map<string, ProviderPlugin>();

  constructor(initial: readonly ProviderPlugin[] = []) {
    for (const plugin of initial) this.register(plugin);
  }

  register(plugin: ProviderPlugin): void {
    validatePlugin(plugin);
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Provider "${plugin.id}" is already registered.`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): ProviderPlugin | undefined {
    return this.plugins.get(id);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  list(): ProviderPlugin[] {
    return [...this.plugins.values()];
  }
}
