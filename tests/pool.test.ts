import { describe, expect, it } from "vitest";
import { now } from "../src/db.js";
import { classifyHttp, classifyTransport } from "../src/pool/errors.js";
import { selectCredential } from "../src/pool/selector.js";
import { DuplicateAccountError, isAvailable, toPublic } from "../src/pool/store.js";
import { credentialInput, makeStore } from "./fixtures.js";

describe("error classification", () => {
  it("treats the documented terminal codes as permanent", () => {
    for (const code of [
      "token_invalidated",
      "token_revoked",
      "invalid_grant",
      "unauthorized_client",
      "refresh_token_reused",
    ]) {
      expect(classifyHttp(400, { type: code }).kind, code).toBe("terminal");
    }
  });

  it("reads resets_at from a usage_limit_reached payload", () => {
    const resetsAt = now() + 86_400;
    const f = classifyHttp(429, {
      type: "usage_limit_reached",
      plan_type: "free",
      resets_at: resetsAt,
    });
    expect(f.kind).toBe("transient");
    expect(f.usageLimited).toBe(true);
    expect(f.resetsAt).toBe(resetsAt);
  });

  it("interprets a small resets_at as a relative duration", () => {
    const f = classifyHttp(429, { type: "usage_limit_reached", resets_at: 600 });
    expect(f.resetsAt).toBeGreaterThan(now() + 500);
    expect(f.resetsAt).toBeLessThan(now() + 700);
  });

  it("cools on 429, 402 and 5xx", () => {
    expect(classifyHttp(429, {}).kind).toBe("transient");
    expect(classifyHttp(402, {}).kind).toBe("transient");
    expect(classifyHttp(500, {}).kind).toBe("transient");
    expect(classifyHttp(503, {}).kind).toBe("transient");
  });

  it("does not rotate on a caller error", () => {
    expect(classifyHttp(400, { error: { message: "bad model" } }).kind).toBe("client");
    expect(classifyHttp(404, {}).kind).toBe("client");
  });

  it("classifies transport failures as transient", () => {
    const f = classifyTransport(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(f.kind).toBe("transient");
    expect(f.code).toBe("ECONNRESET");
    expect(f.status).toBe(0);
  });
});

describe("store", () => {
  it("rejects a second credential with the same chatgpt_account_id", () => {
    const store = makeStore();
    store.add(credentialInput({ accountId: "same-account", email: "one@example.com" }));
    expect(() =>
      store.add(credentialInput({ accountId: "same-account", email: "two@example.com" })),
    ).toThrow(DuplicateAccountError);
    expect(store.all()).toHaveLength(1);
  });

  it("hides token material from the public shape", () => {
    const store = makeStore();
    const c = store.add(credentialInput({ email: "secret.person@example.com" }));
    const pub = toPublic(store.get(c.id)!);
    const serialised = JSON.stringify(pub);

    expect(serialised).not.toContain(c.accessToken!);
    expect(serialised).not.toContain(c.refreshToken!);
    expect(serialised).not.toContain(c.idToken!);
    expect(serialised).not.toContain("secret.person@example.com");
    expect(pub.emailMasked).toBe("se***n@example.com");
  });

  it("updates custom model lists through advanced settings", () => {
    const store = makeStore();
    const c = store.add(
      credentialInput({
        providerType: "antigravity",
        customModels: ["gemini-3-pro-preview", "gemini-2.5-flash"],
      }),
    );

    const updated = store.updateAdvanced(c.id, { customModels: ["gemini-2.5-flash"] });

    expect(updated?.customModels).toEqual(["gemini-2.5-flash"]);
    expect(store.get(c.id)?.customModels).toEqual(["gemini-2.5-flash"]);
  });

  it("skips a cooling credential until its cooldown elapses", () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    const until = now() + 100;
    store.markCooling(c.id, until, "usage_limit_reached", until);

    expect(isAvailable(store.get(c.id)!)).toBe(false);
    expect(isAvailable(store.get(c.id)!, until + 1)).toBe(true);
  });

  it("wakes credentials whose cooldown has passed", () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    store.markCooling(c.id, now() - 5, "usage_limit_reached");
    expect(store.wakeExpired()).toBe(1);
    expect(store.get(c.id)!.state).toBe("active");
  });

  it("keeps a dead credential out of rotation until revived", () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    store.markDead(c.id, "token_invalidated");

    expect(store.available()).toHaveLength(0);
    expect(selectCredential(store, "fill_first")).toBeNull();

    store.revive(c.id);
    expect(selectCredential(store, "fill_first")?.id).toBe(c.id);
  });

  it("reports the earliest recovery time across the pool", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    const b = store.add(credentialInput());
    store.markCooling(a.id, now() + 900, "usage_limit_reached");
    store.markCooling(b.id, now() + 300, "usage_limit_reached");

    const recovery = store.earliestRecovery()!;
    expect(recovery).toBeGreaterThan(now() + 250);
    expect(recovery).toBeLessThan(now() + 350);
  });

  it("serialises work per credential", async () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    const order: string[] = [];

    const task = (name: string, ms: number) =>
      store.withCredentialLock(c.id, async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
      });

    await Promise.all([task("a", 30), task("b", 1), task("c", 1)]);

    // No interleaving: this is what stops a single-use refresh token from
    // being spent twice concurrently.
    expect(order).toEqual([
      "a:start", "a:end",
      "b:start", "b:end",
      "c:start", "c:end",
    ]);
  });

  it("keeps the lock queue alive after a failure", async () => {
    const store = makeStore();
    const c = store.add(credentialInput());

    const failing = store.withCredentialLock(c.id, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    await expect(store.withCredentialLock(c.id, async () => "ok")).resolves.toBe("ok");
  });
});

describe("provider affinity", () => {
  const gemini = () => credentialInput({ providerType: "gemini", accessToken: "AIza-fake-key" });
  const chatgpt = () => credentialInput({ providerType: "codex_oauth" });

  it("keeps Google models on Google keys", () => {
    const store = makeStore();
    const oauth = store.add(chatgpt());
    const key = store.add(gemini());

    // fill_first would pick the lower id, so this only passes on real filtering.
    expect(selectCredential(store, "fill_first", { model: "gemini-3.5-flash" })?.id).toBe(key.id);
    expect(selectCredential(store, "fill_first", { model: "gemma-4-31b-it" })?.id).toBe(key.id);
    expect(selectCredential(store, "fill_first", { model: "gpt-4o" })?.id).toBe(oauth.id);
  });

  it("fails closed rather than routing to a provider that cannot serve the model", () => {
    const store = makeStore();
    store.add(chatgpt());

    // No Google key in the pool. Handing this to the ChatGPT credential would
    // spend an attempt to learn what we already know.
    expect(selectCredential(store, "fill_first", { model: "gemini-3.5-flash" })).toBeNull();
  });

  it("honours an explicit model list on a custom provider", () => {
    const store = makeStore();
    const custom = store.add(
      credentialInput({
        providerType: "openai_custom",
        accessToken: "sk-custom-key-value",
        customModels: ["llama-3.1-70b"],
      }),
    );

    expect(selectCredential(store, "fill_first", { model: "llama-3.1-70b" })?.id).toBe(custom.id);
    expect(selectCredential(store, "fill_first", { model: "gpt-4o" })).toBeNull();
  });

  it("treats an unlabelled credential as OpenAI-family", () => {
    const store = makeStore();
    const c = store.add(credentialInput());
    expect(selectCredential(store, "fill_first", { model: "gpt-4o" })?.id).toBe(c.id);
    expect(selectCredential(store, "fill_first", { model: "gemini-3.5-flash" })).toBeNull();
  });
});

describe("selector", () => {
  it("fill_first drains one credential before moving on", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    store.add(credentialInput());

    for (let i = 0; i < 5; i++) {
      expect(selectCredential(store, "fill_first")?.id).toBe(a.id);
    }
  });

  it("fill_first advances only once the current credential is cooling", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    const b = store.add(credentialInput());

    store.markCooling(a.id, now() + 3600, "usage_limit_reached");
    expect(selectCredential(store, "fill_first")?.id).toBe(b.id);
  });

  it("round_robin cycles through the pool", () => {
    const store = makeStore();
    const ids = [
      store.add(credentialInput()).id,
      store.add(credentialInput()).id,
      store.add(credentialInput()).id,
    ];

    const picked = Array.from({ length: 6 }, () => selectCredential(store, "round_robin")!.id);
    expect(new Set(picked)).toEqual(new Set(ids));
    expect(picked.slice(0, 3)).toEqual(picked.slice(3, 6));
  });

  it("least_used prefers the credential with the fewest requests", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    const b = store.add(credentialInput());
    store.markUsed(a.id);
    store.markUsed(a.id);

    expect(selectCredential(store, "least_used")?.id).toBe(b.id);
  });

  it("random stays inside the available pool", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    const b = store.add(credentialInput());
    store.markDead(b.id, "token_revoked");

    for (const r of [0, 0.5, 0.999999]) {
      expect(selectCredential(store, "random", { random: () => r })?.id).toBe(a.id);
    }
  });

  it("honours the per-request exclusion set", () => {
    const store = makeStore();
    const a = store.add(credentialInput());
    const b = store.add(credentialInput());

    expect(selectCredential(store, "fill_first", { exclude: new Set([a.id]) })?.id).toBe(b.id);
    expect(selectCredential(store, "fill_first", { exclude: new Set([a.id, b.id]) })).toBeNull();
  });

  it("returns null on an empty pool", () => {
    expect(selectCredential(makeStore(), "fill_first")).toBeNull();
  });
});
