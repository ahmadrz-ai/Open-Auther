/**
 * Per-Auth connection test.
 *
 * Sends a minimal prompt through one specific credential — no rotation, no
 * failover — and reports whether the model actually replied. This is the only
 * honest way to answer "is this account working?": a stored token that looks
 * valid tells you nothing about whether upstream will accept it.
 *
 * It costs a real request against that Auth's quota. Small, but not free, which
 * is why the UI does not run it automatically.
 */

import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { isChatModel } from "../core/catalogue.js";
import { orderCandidates } from "../core/virtual.js";
import { canServe } from "../pool/selector.js";
import { displayName, type CredentialStore } from "../pool/store.js";
import type { Credential } from "../pool/types.js";
import type { Router } from "../router.js";

const log = createLogger({ mod: "testconn" });

const PROMPT = "Reply with the single word: ok";
/**
 * Small, but not tiny. Reasoning models spend their budget on thinking tokens
 * before emitting any visible text — at 16 tokens several Gemini models
 * completed successfully and returned an empty string, which the test then
 * reported as a failure. This is enough headroom for a short reply after a
 * brief think, and still costs almost nothing.
 */
const MAX_TOKENS = 256;

/** Last-resort probe model per provider, when the configured list has none. */
const PROVIDER_FALLBACK: Record<string, string> = {
  gemini: "gemini-flash-lite-latest",
  // Keep this aligned with the active Hermes Codex model. Probing gpt-5-codex
  // can return a plan/model gate even when the account works with the model
  // selected by Hermes, which previously marked a valid OAuth account dead.
  codex_oauth: "gpt-5.6-luna",
  // A custom endpoint that declared nothing gets a common id; if it is wrong
  // the endpoint says so, which is still a useful answer.
  openai_custom: "gpt-4o-mini",
};

/**
 * Pick a model that answers the question the test is actually asking.
 *
 * The question is "is this connection working?", so the probe has to use a
 * model the connection can plausibly serve. This used to take
 * `customModels[0]` — the first id in whatever order the provider listed them.
 * For a Gemini key that is `antigravity-preview-05-2026`, which no plain
 * Gemini key may touch, so four perfectly healthy keys all reported
 * `upstream_client_error`. The test was failing, not the credential.
 *
 * Order of preference: an explicit choice, then something already proven to
 * work on this credential, then the cheapest untried chat model, and only then
 * a per-provider guess.
 */
export function probeModels(cfg: Config, credential: Credential): string[] {
  // An explicit validation model always wins. A provider with a mixed
  // free/paid catalogue will otherwise be probed with whatever came first,
  // and a "premium model not allowed" reply looks like a broken key.
  if (credential.validationModel) return [credential.validationModel];

  const declared = (credential.customModels ?? []).filter(
    (m) => isChatModel(m) && !credential.excludedModels.includes(m),
  );

  if (declared.length) {
    // Something this credential has already answered with is the strongest
    // possible probe: it proves the account works without risking a false
    // negative from an id the provider lists but will not serve.
    const proven = declared.filter((m) => credential.modelStats[m]?.ok);
    const untried = declared.filter((m) => !credential.modelStats[m]);
    const pool = proven.length ? proven : untried.length ? untried : declared;

    // Cheapest and quickest first — a probe should not cost a reasoning
    // model's full thinking budget.
    return orderCandidates("fast", pool.map((m) => ({ credential, model: m }))).map((c) => c.model);
  }

  return [
    cfg.models.find((m) => canServe(credential, m)) ??
      // Nothing in the configured list suits this provider — which happens
      // whenever the list is scoped to one family. Falling back to
      // `cfg.defaultModel` would probe a ChatGPT Auth with a Gemini model and
      // report "model does not exist", hiding whatever is actually wrong with it.
      PROVIDER_FALLBACK[credential.providerType] ??
      cfg.defaultModel,
  ];
}

/**
 * How many models one test may try before calling the connection broken.
 *
 * Providers advertise models they will not serve — Antigravity lists six and
 * serves two; the other four 404. Probing exactly one id and reporting the
 * result as the account's health told the user a working connection was dead.
 * A handful of attempts costs a second or two and gives the honest answer.
 */
const PROBE_ATTEMPTS = 4;

export interface ConnectionTestResult {
  credentialId: number;
  name: string;
  ok: boolean;
  /** What the model actually said, trimmed. Proof it round-tripped. */
  reply: string | null;
  latencyMs: number;
  status: number | null;
  code: string | null;
  message: string | null;
  /** Set when the failure means the Auth is finished, not just busy. */
  terminal: boolean;
}

export async function testCredential(
  cfg: Config,
  store: CredentialStore,
  router: Router,
  credentialId: number,
  model?: string,
): Promise<ConnectionTestResult> {
  const credential = store.get(credentialId);
  const name = credential ? displayName(credential) : `Auth ${credentialId}`;

  const base: ConnectionTestResult = {
    credentialId,
    name,
    ok: false,
    reply: null,
    latencyMs: 0,
    status: null,
    code: null,
    message: null,
    terminal: false,
  };

  if (!credential) {
    return { ...base, message: "No such Auth.", code: "not_found", status: 404 };
  }

  /*
   * Walk a few candidates rather than staking the verdict on one id.
   *
   * When the caller names a model we honour it exactly — "does this model
   * work" is a different question from "does this connection work".
   */
  const candidates = model ? [model] : probeModels(cfg, credential).slice(0, PROBE_ATTEMPTS);
  let last: ConnectionTestResult | null = null;

  for (const [attempt, testModel] of candidates.entries()) {
    const result = await probeOnce(cfg, store, router, credential, testModel);
    if (result.ok) {
      if (attempt > 0) {
        log.info("connection_test_recovered", {
          credential: credentialId,
          model: testModel,
          skipped: attempt,
        });
      }
      return result;
    }
    last = result;
    // The account itself is finished, or upstream is telling us to back off.
    // Another model id will not change either answer.
    if (result.terminal || result.status === 429) break;
  }

  /*
   * Every candidate came back "no such model" — so the stored list is wrong,
   * not the account.
   *
   * This is not hypothetical: one custom endpoint had 65 model ids belonging
   * to an entirely different provider, so a perfectly good key reported
   * `model_not_found` and sat in the pool looking broken. Re-asking the
   * endpoint what it serves costs one request and fixes it in place, rather
   * than waiting for someone to notice and press Re-detect.
   */
  if (!model && last && looksLikeStaleCatalogue(last) && (await refreshModels(store, credential))) {
    const fresh = store.get(credentialId);
    const retry = fresh ? probeModels(cfg, fresh).slice(0, PROBE_ATTEMPTS) : [];
    log.info("connection_test_relisted", { credential: credentialId, models: retry.length });

    for (const testModel of retry) {
      const result = await probeOnce(cfg, store, router, fresh!, testModel);
      if (result.ok) return result;
      last = result;
      if (result.terminal || result.status === 429) break;
    }
  }

  return last ?? { ...base, code: "no_probe_model", message: "No model to test this Auth with." };
}

/** Does this failure mean "we asked for a model that isn't there"? */
function looksLikeStaleCatalogue(r: ConnectionTestResult): boolean {
  if (r.status !== null && r.status !== 400 && r.status !== 404) return false;
  return /model_not_found|no_provider_for_model/.test(r.code ?? "") ||
    /model.*(not exist|not found|does not exist|unknown model)/i.test(r.message ?? "");
}

/**
 * Re-ask an endpoint which models it serves, and store the answer.
 *
 * Only for endpoints that publish a list. Returns whether anything changed,
 * so the caller does not retry against the same ids it just failed on.
 */
async function refreshModels(store: CredentialStore, credential: Credential): Promise<boolean> {
  if (credential.providerType !== "openai_custom" || !credential.baseUrl) return false;

  try {
    const res = await fetch(`${credential.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: credential.accessToken ? { authorization: `Bearer ${credential.accessToken}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((m): m is string => Boolean(m));
    if (!ids.length) return false;

    const before = JSON.stringify(credential.customModels ?? []);
    if (before === JSON.stringify(ids)) return false;

    store.setCustomModels(credential.id, ids);
    log.info("model_list_refreshed", { credential: credential.id, models: ids.length });
    return true;
  } catch {
    // A failed refresh just means we report the original error, which is right.
    return false;
  }
}

/** One request through one credential with one model. */
async function probeOnce(
  cfg: Config,
  store: CredentialStore,
  router: Router,
  credential: Credential,
  testModel: string,
): Promise<ConnectionTestResult> {
  const credentialId = credential.id;
  const started = Date.now();
  const base: ConnectionTestResult = {
    credentialId,
    name: displayName(credential),
    ok: false,
    reply: null,
    latencyMs: 0,
    status: null,
    code: null,
    message: null,
    terminal: false,
  };

  /** Remember the verdict so later probes and the router skip a dud id. */
  const remember = (ok: boolean, latencyMs: number, error?: string): void => {
    store.setModelStat(credentialId, testModel, {
      ok,
      latencyMs,
      ts: Math.floor(Date.now() / 1000),
      ...(ok ? {} : { error: error ?? "failed" }),
    });
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const outcome = await router.chat(
      {
        model: testModel,
        messages: [{ role: "user", content: PROMPT }],
        max_completion_tokens: MAX_TOKENS,
        stream: false,
      },
      controller.signal,
      { pinnedCredentialId: credentialId },
    );

    if (!outcome.ok) {
      const latencyMs = Date.now() - started;
      // Pool-level exhaustion says nothing about the model, so it is not
      // recorded against it.
      if (outcome.code !== "pool_exhausted") remember(false, latencyMs, outcome.code);
      return {
        ...base,
        latencyMs,
        status: outcome.status,
        code: outcome.code,
        message: outcome.message,
        // 401/403 with a terminal code kills a credential; the router will have
        // already marked it dead, so reflect that rather than implying a retry.
        terminal: store.get(credentialId)?.state === "dead",
      };
    }

    let reply = "";
    let sawReasoning = false;
    for await (const ev of outcome.events) {
      if (ev.kind === "text") reply += ev.delta;
      else if (ev.kind === "reasoning") sawReasoning = true;
      else if (ev.kind === "error") {
        const latencyMs = Date.now() - started;
        remember(false, latencyMs, "upstream_stream_error");
        return {
          ...base,
          latencyMs,
          status: ev.status,
          code: "upstream_stream_error",
          message: "The model started responding but the stream failed.",
        };
      }
    }

    const trimmed = reply.trim();
    const latencyMs = Date.now() - started;

    if (!trimmed) {
      // The stream completed without an error, so authentication, routing and
      // the upstream round trip all worked — which is exactly what this test
      // exists to prove. A reasoning model that spent its budget thinking is
      // still a healthy connection, so report success and say what happened.
      store.clearFailureState(credentialId);
      remember(true, latencyMs);
      return {
        ...base,
        ok: true,
        latencyMs,
        status: 200,
        code: "empty_reply",
        message: sawReasoning
          ? "Connected. The model completed a reasoning pass but emitted no visible text."
          : "Connected, but the model returned no text.",
      };
    }

    // The credential just answered, so it is demonstrably not dead or cooling.
    store.clearFailureState(credentialId);
    remember(true, latencyMs);

    log.info("connection_test_ok", { credential: credentialId, latencyMs, model: testModel });
    return {
      ...base,
      ok: true,
      reply: trimmed.slice(0, 200),
      latencyMs,
      status: 200,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    remember(false, latencyMs, "test_failed");
    return { ...base, latencyMs, code: "test_failed", message: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Test every Auth, sequentially.
 *
 * Sequential on purpose: firing them in parallel would spike concurrent load
 * against one upstream from one IP, which is exactly the pattern that gets a
 * cluster of accounts flagged.
 */
export async function testAllCredentials(
  cfg: Config,
  store: CredentialStore,
  router: Router,
  model?: string,
): Promise<ConnectionTestResult[]> {
  const results: ConnectionTestResult[] = [];
  for (const credential of store.all()) {
    results.push(await testCredential(cfg, store, router, credential.id, model));
  }
  return results;
}
