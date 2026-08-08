import { describe, expect, it } from "vitest";
import { buildDoctorReport, buildProviderStatus } from "../src/core/diagnostics.js";
import { ProviderRegistry } from "../src/core/provider-registry.js";
import { providerDef } from "../src/core/providers.js";
import type { Config } from "../src/config.js";
import type { Credential } from "../src/pool/types.js";

const credential = (overrides: Partial<Credential>): Credential => ({
  id: 1,
  accountId: "account-1",
  providerId: "gemini",
  providerType: "gemini",
  baseUrl: null,
  customModels: null,
  validationModel: null,
  priority: 1,
  excludedModels: [],
  customUserAgent: null,
  routingTags: [],
  perModelQuota: false,
  modelCooldowns: {},
  modelStats: {},
  email: null,
  planType: null,
  label: null,
  accessToken: "fixture-token",
  refreshToken: null,
  idToken: null,
  accessExpiresAt: null,
  state: "active",
  cooldownUntil: null,
  resetsAt: null,
  requestCount: 0,
  successCount: 0,
  errorCount: 0,
  tokenCount: 0,
  lastUsedAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const registry = new ProviderRegistry([
  { id: "gemini", definition: providerDef("gemini")! },
]);

describe("provider diagnostics", () => {
  it("groups live credentials and exposes degraded provider state", () => {
    const statuses = buildProviderStatus(
      registry,
      [
        credential({ id: 1 }),
        credential({ id: 2, accountId: "account-2", cooldownUntil: 2000 }),
        credential({ id: 3, accountId: "custom-1", providerId: "local", providerType: "openai_custom", customModels: ["qwen2.5"] }),
      ],
      1000,
    );

    expect(statuses.find((item) => item.id === "gemini")).toMatchObject({
      configured: 2,
      available: 1,
      cooling: 1,
      dead: 0,
      health: "degraded",
    });
    expect(statuses.find((item) => item.id === "local")).toMatchObject({
      configured: 1,
      available: 1,
      health: "ready",
      models: ["qwen2.5"],
    });
  });

  it("builds a deterministic local doctor report without exposing token material", () => {
    const cfg = {
      home: process.cwd(),
      dbPath: __filename,
      gatewayKeys: [{ name: "local", key: "fixture-gateway-secret" }],
      models: ["gemini-flash-lite-latest"],
    } as Config;
    const report = buildDoctorReport(cfg, registry, [credential({})], 1000);

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => !check.message.includes("fixture-gateway-secret"))).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "data-home",
      "database",
      "gateway-key",
      "provider-registry",
      "model-catalogue",
      "routing-pool",
    ]);
  });
});
