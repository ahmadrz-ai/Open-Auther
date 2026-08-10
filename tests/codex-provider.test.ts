import { afterEach, describe, expect, it, vi } from "vitest";
import { codexHeaders, extractChatGptAccountId, fetchCodexModels } from "../src/upstream/codex.js";
import { syntheticJwt } from "./fixtures.js";
import type { Credential } from "../src/pool/types.js";

const credential = (accessToken: string): Credential =>
  ({
    id: 31,
    accountId: "stored-account-id",
    providerId: "codex",
    providerType: "codex_oauth",
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
    email: "tester@example.com",
    planType: "free",
    label: null,
    accessToken,
    refreshToken: "refresh",
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
    createdAt: 0,
    updatedAt: 0,
  }) as Credential;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hermes-compatible Codex provider", () => {
  it("extracts the account id from the access-token claim", () => {
    const token = syntheticJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account-id" },
    });
    expect(extractChatGptAccountId(token)).toBe("jwt-account-id");
  });

  it("builds the first-party Codex headers from the token, not stale row metadata", () => {
    const token = syntheticJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account-id" },
    });
    const headers = codexHeaders(credential(token), "session-31");

    expect(headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: "session-31",
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      "chatgpt-account-id": "jwt-account-id",
    });
  });

  it("fetches the account-specific Codex catalog and keeps visible unsupported_in_api slugs", async () => {
    const token = syntheticJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account-id" },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { slug: "gpt-5.6-luna", priority: 2, supported_in_api: false },
            { slug: "gpt-5.6-terra", priority: 1 },
            { slug: "hidden-model", priority: 0, visibility: "hide" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodexModels(token)).resolves.toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      expect.objectContaining({
        headers: expect.objectContaining({ "chatgpt-account-id": "jwt-account-id" }),
      }),
    );
  });
});
