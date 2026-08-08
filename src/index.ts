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

export { BUILTIN_AUTH_ADAPTERS, AuthAdapterRegistry } from "./core/auth-adapters.js";
export type { AuthAdapter, AuthAdapterContext, AuthAdapterKind } from "./core/auth-adapters.js";

export { inspectStorage, SCHEMA_VERSION } from "./storage.js";
export type { StorageHealth } from "./storage.js";

export { buildDoctorReport, buildProviderStatus } from "./core/diagnostics.js";
export type { DoctorCheck, DoctorReport, DiagnosticLevel, ProviderHealth, ProviderStatus } from "./core/diagnostics.js";

export {
  BUILTIN_CAPABILITIES,
  capabilitiesFor,
  coerceCapabilities,
  meetsRequirements,
  requirementsForRequest,
  DEFAULT_REASONING,
  isReasoningLevel,
  REASONING_LEVELS,
  UNKNOWN_MODEL,
} from "./core/capabilities.js";
export type { CapabilityRequirements, CapabilityRequest, ModelCapabilities, ReasoningLevel } from "./core/capabilities.js";
