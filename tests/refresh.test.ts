import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFreshToken } from "../src/core/refresh.js";
import { testConfig, credentialInput, makeStore, syntheticJwt } from "./fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex OAuth refresh parity", () => {
  it("uses Hermes form encoding and preserves the single-use refresh token when omitted", async () => {
    const store = makeStore();
    const refreshToken = "refresh-token-fixture";
    const credential = store.add(
      credentialInput({
        providerType: "codex_oauth",
        refreshToken,
        accessExpiresAt: 0,
      }),
    );
    const nextAccessToken = syntheticJwt({ sub: credential.accountId });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: nextAccessToken, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await ensureFreshToken(store, testConfig({ oauthClientId: "codex-client" }), credential.id);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const params = new URLSearchParams(String(init.body));

    expect(init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
    });
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe(refreshToken);
    expect(params.get("client_id")).toBe("codex-client");
    expect(refreshed.accessToken).toBe(nextAccessToken);
    expect(refreshed.refreshToken).toBe(refreshToken);
  });
});
