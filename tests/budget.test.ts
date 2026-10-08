import { describe, expect, it } from "vitest";
import { capOutputTokens, dailyUsageEpoch } from "../src/api/budget.js";
import { makeStore } from "./fixtures.js";

describe("gateway usage budgets", () => {
  it("keeps usage durable independently of the bounded request log", () => {
    const store = makeStore();
    const day = dailyUsageEpoch(1_700_000_123);
    expect(store.consumeGatewayRequest("client", day, 2)).toMatchObject({ allowed: true, requests: 1 });
    store.addGatewayTokens("client", day, 42);
    expect(store.gatewayUsage("client", day)).toEqual({ requests: 1, tokens: 42 });
    expect(store.consumeGatewayRequest("client", day, 2)).toMatchObject({ allowed: true, requests: 2 });
    expect(store.consumeGatewayRequest("client", day, 2)).toMatchObject({ allowed: false, requests: 2, tokens: 42 });
  });

  it("separates UTC days and clients", () => {
    const store = makeStore();
    const day = dailyUsageEpoch(1_700_000_123);
    store.consumeGatewayRequest("a", day, null);
    store.addGatewayTokens("a", day, 9);
    expect(store.gatewayUsage("a", day)).toEqual({ requests: 1, tokens: 9 });
    expect(store.gatewayUsage("b", day)).toEqual({ requests: 0, tokens: 0 });
    expect(store.gatewayUsage("a", day + 86_400)).toEqual({ requests: 0, tokens: 0 });
  });

  it("blocks token admission before reserving another request", () => {
    const store = makeStore();
    const day = dailyUsageEpoch(1_700_000_123);
    store.consumeGatewayRequest("a", day, null, 10);
    store.addGatewayTokens("a", day, 10);
    expect(store.consumeGatewayRequest("a", day, null, 10)).toMatchObject({
      allowed: false,
      reason: "tokens",
      requests: 1,
    });
  });

  it("caps supported output fields without accepting malformed limits", () => {
    const body: Record<string, unknown> = { max_tokens: 999 };
    capOutputTokens(body, ["max_tokens"], 128);
    expect(body.max_tokens).toBe(128);
    expect(() => capOutputTokens({ max_tokens: 0 }, ["max_tokens"], 128)).toThrow();
  });
});
