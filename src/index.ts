/**
 * Public library entrypoint.
 *
 * The CLI remains available through the `open-auther` executable, while this
 * module exposes the stable extension and catalogue APIs for integrations.
 */

export {
  ALL_PROVIDERS,
  ANTIGRAVITY_PROVIDER,
  BUILTIN_PROVIDER_PLUGINS,
  BUILTIN_PROVIDER_REGISTRY,
  CODEX_PROVIDER,
  PROVIDERS,
  PROVIDER_BY_ID,
  inferProviderId,
  providerDef,
  providerDefs,
} from "./core/providers.js";
export type { AuthKind, ProviderDef } from "./core/providers.js";

export { ProviderRegistry, providerSummaries } from "./core/provider-registry.js";
export type { ProviderPlugin, ProviderSummary } from "./core/provider-registry.js";

export { buildCatalogue, isChatModel, looksFree } from "./core/catalogue.js";
export type { BuildOptions, CatalogueEntry } from "./core/catalogue.js";

export {
  BUILTIN_CAPABILITIES,
  capabilitiesFor,
  coerceCapabilities,
  DEFAULT_REASONING,
  isReasoningLevel,
  REASONING_LEVELS,
  UNKNOWN_MODEL,
} from "./core/capabilities.js";
export type { ModelCapabilities, ReasoningLevel } from "./core/capabilities.js";
