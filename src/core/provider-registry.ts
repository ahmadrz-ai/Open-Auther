/**
 * Extension surface for third-party provider integrations.
 *
 * The registry deliberately owns only provider identity and metadata. Transport,
 * authentication, and routing adapters can be added around this contract without
 * forcing external providers to edit the built-in catalogue.
 */

import type { ProviderDef } from "./providers.js";

export interface ProviderPlugin {
  /** Stable lowercase identifier used in configuration and routing. */
  readonly id: string;
  /** Provider metadata consumed by onboarding, discovery, and the dashboard. */
  readonly definition: ProviderDef;
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
