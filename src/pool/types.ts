import type { ModelMetadata } from "../core/model-metadata.js";

/** Outcome of the last per-model probe. */
export interface ModelStat {
  ok: boolean;
  latencyMs: number;
  ts: number;
  error?: string;
}

export type CredentialState = "active" | "cooling" | "dead";

export type ProviderType =
  | "gemini"
  | "openai_custom"
  | "codex_oauth"
  | "antigravity"
  | "web_cookie";

/**
 * Wire protocols a custom endpoint may speak.
 *
 * Not the same axis as `providerType`: that says which family of service this
 * is, while this says how to frame a request to it. An `openai_custom`
 * credential can speak any of these.
 */
export type CustomProtocol = "openai_chat" | "anthropic_messages";

export interface Credential {
  id: number;
  /** Unique ID or account ID for the credential. */
  accountId: string;
  /** Which service this is (openai, openrouter, gemini, custom, codex). */
  providerId: string;
  /** Which wire protocol to speak. Several services share one. */
  providerType: ProviderType;
  baseUrl: string | null;
  customModels: string[] | null;
  /** Model used by connection tests. Blank means first available. */
  validationModel: string | null;

  /** Lower runs first within whatever rotation strategy is active. */
  priority: number;
  /** Models this connection must never be given, even if it could serve them. */
  excludedModels: string[];
  /** Overrides the User-Agent for web-session providers. */
  /**
   * Wire protocol a custom endpoint speaks. NULL means "assume the OpenAI
   * Chat Completions shape", which is what every custom provider used to get
   * unconditionally.
   */
  protocol: CustomProtocol | null;
  customUserAgent: string | null;
  /** Only serve requests asking for one of these tags. Empty = serve any. */
  routingTags: string[];
  /** When on, a 429/404 locks only the offending model. */
  perModelQuota: boolean;
  /** model -> epoch seconds it becomes usable again. */
  modelCooldowns: Record<string, number>;
  /** model -> last test result, used by Advanced settings and `fast`. */
  modelStats: Record<string, ModelStat>;
  /**
   * model -> what this provider published about it: image support, context
   * window, whether the id has been superseded. Empty until discovery runs.
   */
  modelMetadata: ModelMetadata;
  /** Epoch seconds of the last successful model discovery, or null for never. */
  modelsSyncedAt: number | null;

  email: string | null;
  planType: string | null;
  label: string | null;

  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch seconds. */
  accessExpiresAt: number | null;

  state: CredentialState;
  /** Epoch seconds; while in the future the credential is skipped. */
  cooldownUntil: number | null;
  /** Epoch seconds reported by upstream `usage_limit_reached`. */
  resetsAt: number | null;

  requestCount: number;
  successCount: number;
  errorCount: number;
  tokenCount: number;

  lastUsedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;

  createdAt: number;
  updatedAt: number;
}

/** A credential row as it is safe to expose over HTTP or render in the UI. */
export interface CredentialPublic {
  id: number;
  accountId: string;
  /** Catalogue id: openai, openrouter, gemini, custom, codex. */
  providerId: string;
  providerType: ProviderType;
  baseUrl: string | null;
  customModels: string[] | null;
  validationModel: string | null;
  priority: number;
  excludedModels: string[];
  /**
   * Wire protocol a custom endpoint speaks. NULL means "assume the OpenAI
   * Chat Completions shape", which is what every custom provider used to get
   * unconditionally.
   */
  protocol: CustomProtocol | null;
  customUserAgent: string | null;
  routingTags: string[];
  perModelQuota: boolean;
  modelCooldowns: Record<string, number>;
  modelStats: Record<string, ModelStat>;
  modelMetadata: ModelMetadata;
  modelsSyncedAt: number | null;
  /**
   * Display name. This is what the graph and every list shows — never the
   * email, which is both sensitive and unhelpful when several accounts share
   * a provider.
   */
  name: string;
  emailMasked: string;
  planType: string | null;
  label: string | null;
  state: CredentialState;
  /** `active` credentials whose cooldown has not elapsed report as `cooling`. */
  effectiveState: CredentialState;
  cooldownUntil: number | null;
  resetsAt: number | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  tokenCount: number;
  lastUsedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  createdAt: number;
  /** True when the stored access token is expired or missing. */
  needsRefresh: boolean;
}

export interface RequestLogEntry {
  id?: number;
  ts: number;
  client: string | null;
  credentialId: number | null;
  credentialName: string | null;
  model: string | null;
  streaming: boolean;
  status: number | null;
  outcome: "ok" | "error" | "rotated_ok";
  attempts: number;
  latencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  compressed: boolean;
  inputBefore: number | null;
  inputAfter: number | null;
  outputMeasured: number | null;
  outputWouldSave: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PoolEvent {
  id?: number;
  ts: number;
  kind: string;
  credentialId: number | null;
  detail: Record<string, unknown> | null;
}
