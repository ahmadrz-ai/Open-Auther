/**
 * The routing loop: pick a credential, try it, rotate on failure.
 *
 * The subtle part is streaming. Once a byte of response has reached the
 * client, failing over is no longer transparent — a second credential would
 * restart generation and the client would see two contradictory half-answers.
 * So we *prime* every upstream call: pull events until the first real content
 * arrives, and only then commit. A 429 during priming is invisible to the
 * client. A failure after commit breaks the stream, which is a documented
 * limitation, not something we paper over.
 */

import type { Config } from "./config.js";
import { now } from "./db.js";
import { createLogger, maskEmail } from "./logging.js";
import { RefreshError, ensureFreshToken } from "./core/refresh.js";
import { buildCatalogue } from "./core/catalogue.js";
import { capabilitiesFor, meetsRequirements, requirementsForRequest, type CapabilityRequirements } from "./core/capabilities.js";
import { isVirtualModel, orderCandidates, type Candidate, type VirtualModel } from "./core/virtual.js";
import type { UpstreamFailure } from "./pool/errors.js";
import { canServe, selectCredential } from "./pool/selector.js";
import type { CredentialStore } from "./pool/store.js";
import type { Credential } from "./pool/types.js";
import { callCodex, codexEvents } from "./upstream/client.js";
import { toCodexRequest, type ChatCompletionRequest, type CodexEvent } from "./upstream/translate.js";

const log = createLogger({ mod: "router" });

export interface RouteSuccess {
  ok: true;
  credential: Credential;
  /** Concrete model used. Differs from the request when a virtual id resolved. */
  model: string;
  /** Events already pulled during priming, followed by the live remainder. */
  events: AsyncGenerator<CodexEvent>;
  attempts: number;
}

export interface RouteFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  /** Epoch seconds; set when the whole pool is cooling. */
  retryAt: number | null;
  attempts: number;
}

export type RouteOutcome = RouteSuccess | RouteFailure;

/**
 * Does this status mean "that model is wrong" rather than "try again later"?
 *
 * Only a rejection of the request itself is the model's fault. 400 and 404 mean
 * the id is unknown or not permitted for this account; 501/505 mean the surface
 * does not support the call. Everything else — 429 quota, 5xx capacity and
 * outages, transport errors (status null) — is temporary, and marking a model
 * dead for it silently shrinks the pool.
 */
export function blamesModel(status: number | null): boolean {
  if (status === null) return false;
  return status === 400 || status === 404 || status === 501 || status === 505;
}

/** Events that mean the model has actually started answering. */
function isContent(ev: CodexEvent): boolean {
  return ev.kind === "text" || ev.kind === "tool_call" || ev.kind === "reasoning";
}

function capabilityLabels(requirements: CapabilityRequirements): string[] {
  return [
    requirements.vision ? "vision" : null,
    requirements.tools ? "tools" : null,
    requirements.reasoning ? "reasoning" : null,
  ].filter((value): value is string => value !== null);
}

export class Router {
  constructor(
    private readonly cfg: Config,
    private readonly store: CredentialStore,
  ) {}

  /** Persist first-token latency so `fast` learns from normal chat traffic. */
  private async *recordModelEvents(
    credential: Credential,
    model: string,
    startedAt: number,
    events: AsyncGenerator<CodexEvent>,
  ): AsyncGenerator<CodexEvent> {
    let firstContentAt: number | null = null;
    let ok = true;
    try {
      for await (const event of events) {
        if (firstContentAt === null && isContent(event)) firstContentAt = Date.now();
        if (event.kind === "error") ok = false;
        yield event;
      }
    } finally {
      this.store.setModelStat(credential.id, model, {
        ok,
        latencyMs: Math.max(0, (firstContentAt ?? Date.now()) - startedAt),
        ts: now(),
        ...(ok ? {} : { error: "upstream_stream_error" }),
      });
    }
  }

  /** Apply the consequences of a failure to the credential that produced it. */
  private penalise(credential: Credential, failure: UpstreamFailure, model?: string): void {
    if (failure.kind === "terminal") {
      this.store.markDead(credential.id, failure.code ?? `http_${failure.status}`);
      return;
    }

    /*
     * Per-model quota: bench the model, not the connection.
     *
     * Providers that rate-limit per model would otherwise have a whole key
     * taken out of rotation because one model ran dry, while every other
     * model on it was still perfectly usable.
     */
    if (credential.perModelQuota && model && failure.kind === "transient") {
      const until = failure.resetsAt ?? now() + this.cfg.defaultCooldownSeconds;
      this.store.coolModel(
        credential.id,
        model,
        until,
        failure.usageLimited ? "usage_limit_reached" : (failure.code ?? `http_${failure.status}`),
      );
      return;
    }

    if (failure.kind === "transient") {
      // Honour upstream's own timestamp. Guessing a cooldown when the server
      // told us exactly when the quota refills is how accounts get hammered
      // into the ground.
      const until = failure.resetsAt ?? now() + this.cfg.defaultCooldownSeconds;
      this.store.markCooling(
        credential.id,
        until,
        failure.usageLimited ? "usage_limit_reached" : (failure.code ?? `http_${failure.status}`),
        failure.resetsAt,
      );
    }
    // `client` failures are the caller's fault; the credential is untouched.
  }

  /**
   * Serve a request that asked for `auto` / `fast` / `quality`.
   *
   * Walks the policy's ordering and moves to the next model when one turns out
   * not to work. Providers list models they will not actually serve — image
   * models, agent-only surfaces, ids that plainly 404 — so taking only the top
   * pick meant a single bad catalogue entry failed the whole request.
   * Failures are remembered, so the same dud is not chosen again.
   */
  private async chatVirtual(
    virtual: VirtualModel,
    req: ChatCompletionRequest,
    signal: AbortSignal,
    opts: { tags?: string[]; sticky?: string | null; providerId?: string | null },
  ): Promise<RouteOutcome> {
    const requirements = requirementsForRequest(req);
    const ordered = orderCandidates(
      virtual,
      this.candidatePairs(opts.tags, requirements, opts.providerId ?? null),
      this.cfg.modelCapabilities,
      opts.sticky ?? null,
    );

    // One attempt per distinct model, not per credential — the normal rotation
    // inside `chat` already covers "same model, different key".
    const models: string[] = [];
    for (const c of ordered) if (!models.includes(c.model)) models.push(c.model);

    if (models.length === 0) {
      return {
        ok: false,
        status: 503,
        code: "no_model_available",
        message:
          `No connection can serve a "${virtual}" request right now. ` +
          `Add a provider, or check Connections for what is cooling.`,
        retryAt: this.store.earliestRecovery(),
        attempts: 0,
      };
    }

    let last: RouteFailure | null = null;
    const budget = Math.min(models.length, Math.max(6, this.cfg.maxAttempts));
    let tried = 0;

    for (const model of models) {
      if (signal.aborted || tried >= budget) break;
      tried += 1;

      const outcome = await this.chat({ ...req, model }, signal, { tags: opts.tags });
      if (outcome.ok) {
        log.info("virtual_resolved", { virtual, model, tried });
        return outcome;
      }

      last = outcome;

      // Nothing left to try at all — another model would fail identically.
      if (outcome.code === "no_credentials" || outcome.code === "all_credentials_dead") break;

      /*
       * A drained model is exactly the case these policies exist for: `auto`
       * is specified as "stay on one model until its quota runs out, then move
       * on". So step to the next model, but do not record it as broken — the
       * model is fine, its quota is not.
       */
      if (outcome.code === "pool_exhausted" || outcome.code === "no_provider_for_model") {
        log.info("virtual_model_drained", { virtual, model });
        continue;
      }

      /*
       * Only blame the model when upstream said the model is the problem.
       *
       * Recording every failure permanently was wrong and did real damage: an
       * Antigravity model answering 503 "No capacity available for model X" is
       * busy, not broken, and once marked bad it was excluded from every later
       * ordering. An account offering seventeen working models showed two.
       */
      if (!blamesModel(outcome.status)) {
        log.info("virtual_model_unavailable", { virtual, model, status: outcome.status });
        continue;
      }

      for (const c of ordered) {
        if (c.model !== model) continue;
        this.store.setModelStat(c.credential.id, model, {
          ok: false,
          latencyMs: 0,
          ts: now(),
          error: outcome.code,
        });
      }
      log.info("virtual_model_rejected", { virtual, model, reason: outcome.code });
    }

    return (
      last ?? {
        ok: false,
        status: 503,
        code: "no_model_available",
        message: `Nothing could serve a "${virtual}" request.`,
        retryAt: null,
        attempts: 0,
      }
    );
  }

  /** Every (credential, model) pair that could serve a request right now. */
  private candidatePairs(
    tags?: string[],
    requirements?: CapabilityRequirements,
    providerId?: string | null,
  ): Candidate[] {
    const at = now();
    this.store.wakeExpired(at);

    const out: Candidate[] = [];
    for (const credential of this.store.available(at)) {
      if (providerId && credential.providerId !== providerId) continue;
      if (!credential.accessToken) continue;
      // Tagged connections are reserved; untagged serve anything.
      if (credential.routingTags.length && !tags?.some((t) => credential.routingTags.includes(t))) {
        continue;
      }
      for (const entry of buildCatalogue([credential], { freeOnly: this.cfg.freeModelsOnly })) {
        if (
          requirements &&
          !meetsRequirements(capabilitiesFor(entry.id, this.cfg.modelCapabilities), requirements)
        ) {
          continue;
        }
        out.push({ credential, model: entry.id });
      }
    }
    return out;
  }

  private drained(attempts: number, model?: string, providerId?: string | null): RouteFailure {
    const all = this.store.all();

    /*
     * Name the provider pin when it is the actual reason.
     *
     * Affinity fails closed, which is right — a conversation pinned to one
     * provider must never be answered by another. But the message was computed
     * from the unpinned pool, so pinning a Gemini model to `codex` reported
     * "all 3 credentials that can serve it are currently unavailable" while
     * three healthy Antigravity accounts sat idle, excluded by the pin. That
     * sends you to look at quotas when the answer is the selector.
     */
    if (providerId && model) {
      const capableAnywhere = all.filter((c) => canServe(c, model));
      const capableHere = capableAnywhere.filter((c) => c.providerId === providerId);
      if (capableAnywhere.length > 0 && capableHere.length === 0) {
        const owners = [...new Set(capableAnywhere.map((c) => c.providerId))].join(", ");
        return {
          ok: false,
          status: 400,
          code: "provider_pin_excludes_model",
          message:
            `This conversation is pinned to "${providerId}", which has no credential ` +
            `that serves "${model}". ${capableAnywhere.length} credential(s) can serve it, ` +
            `under: ${owners}. Switch the provider selector to one of those (or to ` +
            `"All providers"), or pick a model "${providerId}" offers.`,
          retryAt: null,
          attempts,
        };
      }
    }

    /*
     * Everything below is scoped to credentials that could serve this model.
     *
     * Counting the whole pool produced messages like "all 7 credentials are
     * rate limited" when four of them were Gemini keys that were never
     * candidates for a GPT model, and the three that were had been dropped for
     * an unrelated reason. That points at quotas when the real answer is
     * elsewhere.
     */
    const capable = model ? all.filter((c) => canServe(c, model)) : all;
    const total = capable.length;
    const dead = capable.filter((c) => c.state === "dead").length;

    if (model && all.length > 0 && total === 0) {
      const families = [...new Set(all.map((c) => c.providerType))].join(", ");
      return {
        ok: false,
        status: 400,
        code: "no_provider_for_model",
        message:
          `No credential in the pool can serve "${model}". The pool holds: ${families}. ` +
          `Add a credential for that provider, or pick a model one of these serves.`,
        retryAt: null,
        attempts,
      };
    }

    const retryAt = capable.reduce<number | null>((soonest, c) => {
      if (c.state === "dead") return soonest;
      const t = c.cooldownUntil ?? 0;
      if (t === 0) return soonest;
      return soonest === null || t < soonest ? t : soonest;
    }, null);

    if (total === 0) {
      return {
        ok: false,
        status: 503,
        code: "no_credentials",
        message:
          "No credentials in the pool. Add one with `ai-auther auth login` or " +
          "`ai-auther auth import <file>`.",
        retryAt: null,
        attempts,
      };
    }
    const scope = model ? ` that can serve "${model}"` : "";

    if (dead === total) {
      const reasons = [...new Set(capable.map((c) => c.lastError).filter(Boolean))];
      return {
        ok: false,
        status: 503,
        code: "all_credentials_dead",
        message:
          `Every credential${scope} has been dropped from rotation` +
          (reasons.length ? ` (${reasons.join("; ")})` : "") +
          `. Re-authenticate with \`ai-auther auth login\`, or add a credential that can serve it.`,
        retryAt: null,
        attempts,
      };
    }
    return {
      ok: false,
      status: 429,
      code: "pool_exhausted",
      message: retryAt
        ? `All ${total} credential(s)${scope} are rate limited. The first resets at ` +
          `${new Date(retryAt * 1000).toISOString()}.`
        : `All ${total} credential(s)${scope} are currently unavailable.`,
      retryAt,
      attempts,
    };
  }

  /**
   * Route one chat request. On success the returned generator is already
   * primed, so the caller can start writing to the client immediately.
   *
   * `pinnedCredentialId` forces a single credential and disables failover.
   * That is only for the built-in playground and connection tests, where the
   * whole point is to prove one specific Auth works — a real client request
   * should never pin, or rotation stops protecting it.
   */
  async chat(
    req: ChatCompletionRequest,
    signal: AbortSignal,
    opts: {
      pinnedCredentialId?: number | null;
      tags?: string[];
      sticky?: string | null;
      providerId?: string | null;
    } = {},
  ): Promise<RouteOutcome> {
    /*
     * Resolve `auto` / `fast` / `quality` to a real model before anything
     * else. They are selection policies, not models — nothing downstream
     * should ever see the virtual id.
     */
    if (isVirtualModel(req.model)) {
      return await this.chatVirtual(req.model, req, signal, opts);
    }

    const requirements = requirementsForRequest(req);
    const capabilities = capabilitiesFor(req.model, this.cfg.modelCapabilities);
    if (!meetsRequirements(capabilities, requirements)) {
      const required = capabilityLabels(requirements).join(", ");
      return {
        ok: false,
        status: 400,
        code: "model_capability_mismatch",
        message:
          `Model "${req.model}" cannot satisfy this request. ` +
          `Required capabilities: ${required || "none"}. ` +
          `Choose a compatible model or configure a capability override.`,
        retryAt: null,
        attempts: 0,
      };
    }

    const body = toCodexRequest(req);
    const tried = new Set<number>();
    const pinned = opts.pinnedCredentialId ?? null;
    const maxAttempts = pinned
      ? 1
      : Math.max(1, Math.min(this.cfg.maxAttempts, this.store.all().length || 1));
    let attempts = 0;
    let lastFailure: UpstreamFailure | null = null;

    if (pinned !== null && !this.store.get(pinned)) {
      return {
        ok: false,
        status: 404,
        code: "credential_not_found",
        message: `No Auth with id ${pinned}.`,
        retryAt: null,
        attempts: 0,
      };
    }

    while (attempts < maxAttempts) {
      if (signal.aborted) {
        return {
          ok: false,
          status: 499,
          code: "client_disconnected",
          message: "client aborted the request",
          retryAt: null,
          attempts,
        };
      }

      // A pinned request bypasses selection entirely, including the cooldown
      // filter: testing an Auth that is currently cooling is a legitimate thing
      // to want, and the caller sees the real upstream answer either way.
      const selected =
        pinned !== null
          ? (tried.has(pinned) ? null : this.store.get(pinned))
          : selectCredential(this.store, this.cfg.rotation, {
              exclude: tried,
              model: body.model,
              tags: opts.tags,
              providerId: opts.providerId ?? null,
            });
      if (!selected) break;

      tried.add(selected.id);
      attempts += 1;

      // --- refresh -------------------------------------------------------
      let credential: Credential;
      try {
        credential = await ensureFreshToken(this.store, this.cfg, selected.id);
      } catch (err) {
        if (err instanceof RefreshError) {
          lastFailure = err.failure;
          // `ensureFreshToken` already marked terminal failures dead.
          if (err.failure.kind === "transient") this.penalise(selected, err.failure, body.model);
          continue;
        }
        throw err;
      }

      // --- upstream call -------------------------------------------------
      const modelStartedAt = Date.now();
      this.store.markUsed(credential.id);
      const result = await callCodex(this.cfg, credential, body, signal);

      if (!result.ok) {
        lastFailure = result.failure;

        /*
         * A rejected *model* is not a rejected request.
         *
         * This used to return immediately, because the failure is classified
         * `client`. So asking for `qwen/qwen3.8-max` — served by three custom
         * providers in the pool — could pick a ChatGPT credential first, get
         * "not supported when using Codex", and fail the whole request after
         * one attempt while the providers that serve it were never tried.
         *
         * Record the pairing and rotate. The stat makes the next request skip
         * this credential for this model, so the pool learns instead of
         * repeating the mistake.
         */
        if (result.failure.kind === "client" && result.failure.modelUnsupported) {
          this.store.setModelStat(credential.id, body.model, {
            ok: false,
            latencyMs: Date.now() - modelStartedAt,
            ts: now(),
            error: result.failure.code ?? "model_unsupported",
          });
          log.info("model_unsupported_here", {
            credential: credential.id,
            model: body.model,
            code: result.failure.code,
          });
          continue;
        }

        if (result.failure.kind === "client") {
          return {
            ok: false,
            status: result.failure.status,
            code: result.failure.code ?? "upstream_client_error",
            message: result.failure.message,
            retryAt: null,
            attempts,
          };
        }
        this.penalise(credential, result.failure, body.model);
        log.info("rotating", {
          credential: credential.id,
          email: maskEmail(credential.email),
          reason: result.failure.code ?? result.failure.status,
          attempt: attempts,
        });
        continue;
      }

      // --- prime ---------------------------------------------------------
      /*
       * Drive the iterator by hand rather than with `for await … break`.
       *
       * Breaking out of a `for await` calls `.return()` on the async
       * generator, which closes it. Priming stops at the first content event
       * by design, so the old loop destroyed the rest of the stream the
       * instant it succeeded: replies were truncated to their first chunk and
       * usage — which arrives later — was always zero. Holding the iterator
       * lets the caller resume exactly where priming stopped.
       */
      const iter = codexEvents(
        result.response,
        signal,
        credential.providerType,
        credential.protocol,
      )[Symbol.asyncIterator]();
      const buffered: CodexEvent[] = [];
      let failedDuringPriming: UpstreamFailure | null = null;
      let committed = false;

      try {
        for (;;) {
          const next = await iter.next();
          if (next.done) break;
          const ev = next.value;

          if (ev.kind === "error") {
            failedDuringPriming = {
              kind: "transient",
              status: ev.status,
              code: "upstream_stream_error",
              message: JSON.stringify(ev.body).slice(0, 300),
              resetsAt: null,
              usageLimited: false,
            };
            break;
          }
          buffered.push(ev);
          if (isContent(ev)) {
            committed = true;
            break;
          }
          // A stream that ends without producing content (immediate `done`) is
          // a valid, if empty, answer. Commit it rather than burning the pool.
          if (ev.kind === "done") {
            committed = true;
            break;
          }
        }
      } catch (err) {
        failedDuringPriming = {
          kind: "transient",
          status: 0,
          code: "stream_read_failed",
          message: (err as Error).message,
          resetsAt: null,
          usageLimited: false,
        };
      }

      if (failedDuringPriming) {
        // We are abandoning this credential, so close the stream rather than
        // leaving the upstream connection open until GC gets to it.
        await iter.return?.(undefined).catch(() => undefined);
        lastFailure = failedDuringPriming;
        this.penalise(credential, failedDuringPriming, body.model);
        log.info("rotating_during_priming", {
          credential: credential.id,
          reason: failedDuringPriming.code,
          attempt: attempts,
        });
        continue;
      }

      if (!committed) {
        await iter.return?.(undefined).catch(() => undefined);
        // Stream closed before yielding anything at all.
        lastFailure = {
          kind: "transient",
          status: 502,
          code: "empty_upstream_stream",
          message: "upstream closed the stream without sending any events",
          resetsAt: null,
          usageLimited: false,
        };
        this.penalise(credential, lastFailure, body.model);
        continue;
      }

      log.info("routed", {
        credential: credential.id,
        email: maskEmail(credential.email),
        attempt: attempts,
        model: req.model,
      });

      return {
        ok: true,
        credential,
        model: req.model,
        attempts,
        events: this.recordModelEvents(
          credential,
          body.model,
          modelStartedAt,
          replay(buffered, iter),
        ),
      };
    }

    // A pinned request has no pool to fall back on, so report what actually
    // happened to that one Auth rather than a misleading "pool exhausted".
    if (pinned !== null) {
      return {
        ok: false,
        status: lastFailure?.status || 502,
        code: lastFailure?.code ?? "upstream_error",
        message: lastFailure?.message ?? "The pinned Auth did not return a usable response.",
        retryAt: lastFailure?.resetsAt ?? null,
        attempts,
      };
    }

    // Nothing left to try.
    if (lastFailure && this.store.available().length > 0 && lastFailure.kind !== "transient") {
      return {
        ok: false,
        status: lastFailure.status || 502,
        code: lastFailure.code ?? "upstream_error",
        message: lastFailure.message,
        retryAt: null,
        attempts,
      };
    }
    return this.drained(attempts, req.model, opts.providerId ?? null);
  }
}

/**
 * Yield the primed events, then resume the live stream exactly where priming
 * stopped. Takes the iterator rather than the generator so the stream is never
 * closed and reopened between the two halves.
 */
async function* replay(
  buffered: CodexEvent[],
  rest: AsyncIterator<CodexEvent>,
): AsyncGenerator<CodexEvent> {
  for (const ev of buffered) yield ev;
  try {
    for (;;) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Covers the consumer abandoning us mid-stream (client disconnect).
    await rest.return?.(undefined).catch(() => undefined);
  }
}
