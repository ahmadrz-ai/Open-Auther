/**
 * Routes for the built-in chat playground.
 *
 * These sit under /admin rather than /v1 because they are not part of the
 * OpenAI-compatible surface: they persist conversations, allow pinning to a
 * specific Auth, and stream in their own shape. External clients keep using
 * /v1/chat/completions, which is unchanged.
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatStore } from "../chat/store.js";
import type { Config } from "../config.js";
import { now } from "../db.js";
import { createLogger } from "../logging.js";
import {
  BUILTIN_CAPABILITIES,
  capabilitiesFor,
  DEFAULT_REASONING,
  isReasoningLevel,
  REASONING_LEVELS,
} from "../core/capabilities.js";
import { mergeDiscovered } from "../core/model-metadata.js";
import { providerDef } from "../core/providers.js";
import { virtualChatModels } from "./chatui-meta.js";
import { canServe } from "../pool/selector.js";
import { displayName, toPublic, type CredentialStore } from "../pool/store.js";
import type { Router } from "../router.js";
import type { OpenAIMessage } from "../upstream/translate.js";
import { errorResponse } from "./errors.js";

const log = createLogger({ mod: "chatui" });

/** Conversation history sent upstream. Bounded so an old chat cannot balloon. */
const MAX_HISTORY_MESSAGES = 60;

export function chatUiRoutes(
  cfg: Config,
  store: CredentialStore,
  chat: ChatStore,
  router: Router,
): Hono {
  const app = new Hono();

  const idOf = (c: Context, param = "id"): number | null => {
    const n = Number.parseInt(c.req.param(param) ?? "", 10);
    return Number.isFinite(n) ? n : null;
  };

  // ---------------------------------------------------------- metadata

  /**
   * Everything the composer needs to render.
   *
   * Each model carries the provider ids that can actually serve it, worked out
   * from the credentials in the pool rather than guessed from the model name.
   * The UI previously filtered by string prefix and, when a provider matched
   * nothing, silently fell back to showing every model — which is how you
   * ended up with "Custom Providers" selected and a Gemini model listed under
   * it.
   */
  app.get("/meta", (c) => {
    const at = now();
    const creds = store.all();

    // Union of configured models and anything a custom provider declares, so a
    // custom endpoint's own models are selectable too.
    const declared = new Set(cfg.models);
    for (const cred of creds) {
      for (const m of cred.customModels ?? []) declared.add(m);
      // A connected provider must offer something, or it appears in the picker
      // with an empty model list and nothing can be sent.
      for (const m of providerDef(cred.providerId)?.defaultModels ?? []) declared.add(m);
    }

    /*
     * Attribution has to be tighter than routing.
     *
     * `canServe` only separates provider families, so every non-Google model
     * looks servable by every non-Google credential — which would list gpt-4o
     * under OpenRouter, Codex and a custom endpoint alike. A provider offers a
     * model when its credential declares it, or the catalogue lists it, and
     * only a provider with no declared models at all falls back to the loose
     * family test.
     */
    const offers = (cred: (typeof creds)[number], model: string): boolean => {
      if (!canServe(cred, model)) return false;
      // A discovered or hand-entered list is authoritative.
      if (cred.customModels?.length) return cred.customModels.includes(model);
      // Otherwise only what the catalogue claims for that provider. A custom
      // endpoint declares nothing, so it claims nothing — inheriting every
      // other provider's models would have listed gpt-5-codex under a
      // self-hosted proxy that has never heard of it.
      return (providerDef(cred.providerId)?.defaultModels ?? []).includes(model);
    };

    const realModels = [...declared]
      .map((id) => {
        const servers = creds.filter((cred) => offers(cred, id));
        return {
          id,
          capabilities: capabilitiesFor(
            id,
            cfg.modelCapabilities,
            mergeDiscovered(servers.map((s) => s.modelMetadata), id),
          ),
          // Providers holding at least one credential that offers this model.
          providers: [...new Set(servers.map((s) => s.providerId))],
          available: servers.some((s) => s.state === "active"),
        };
      })
      // Config can contain historical/default ids that no connected credential
      // actually serves. They must not leak into the picker: provider filtering
      // is based on real offers, not merely on the global config list.
      .filter((model) => model.providers.length > 0);

    // Keep the built-in Chat picker aligned with the Settings catalogue.
    // `auto`, `fast`, and `quality` are routing policies, not provider models,
    // so they need explicit metadata rather than provider catalogue matching.
    const virtualModels = virtualChatModels(
      creds.map((cred) => cred.providerId),
      realModels.length > 0,
      realModels.some((model) => model.available),
    ).map((model) => ({
      ...model,
      capabilities: capabilitiesFor(model.id, cfg.modelCapabilities),
    }));
    const models = [...virtualModels, ...realModels];

    const providers = [...new Set(creds.map((x) => x.providerId))].map((id) => ({
      id,
      label: providerDef(id)?.label ?? id,
      credentials: creds.filter((x) => x.providerId === id).length,
      models: models.filter((m) => m.providers.includes(id)).map((m) => m.id),
    }));

    return c.json({
      models,
      providers,
      defaultModel: cfg.defaultModel,
      reasoningLevels: REASONING_LEVELS,
      defaultReasoning: DEFAULT_REASONING,
      auths: creds.map((x) => {
        const pub = toPublic(x, at);
        return {
          id: pub.id,
          name: pub.name,
          state: pub.effectiveState,
          providerId: pub.providerId,
        };
      }),
    });
  });

  // ----------------------------------------------------- conversations

  app.get("/conversations", (c) => c.json({ conversations: chat.listConversations() }));

  app.post("/conversations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const model = typeof body.model === "string" && body.model ? body.model : cfg.defaultModel;
    const providerId = typeof body.providerId === "string" && body.providerId && body.providerId !== "all"
      ? body.providerId
      : null;
    const effort = isReasoningLevel(body.reasoningEffort) ? body.reasoningEffort : DEFAULT_REASONING;
    const pinned =
      typeof body.pinnedCredentialId === "number" ? body.pinnedCredentialId : null;

    return c.json({
      conversation: chat.createConversation({
        model,
        providerId,
        reasoningEffort: effort,
        pinnedCredentialId: pinned,
      }),
    });
  });

  app.get("/conversations/:id", (c) => {
    const id = idOf(c);
    if (id === null) return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    const conversation = chat.getConversation(id);
    if (!conversation) {
      return errorResponse(c, 404, "No such conversation.", "invalid_request_error", "not_found");
    }
    return c.json({ conversation, messages: chat.messages(id) });
  });

  app.post("/conversations/:id", async (c) => {
    const id = idOf(c);
    if (id === null) return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: Parameters<ChatStore["updateConversation"]>[1] = {};
    if (typeof body.title === "string") patch.title = body.title.slice(0, 120);
    if (typeof body.model === "string") patch.model = body.model;
    if (body.providerId === null || typeof body.providerId === "string") {
      patch.providerId = body.providerId === "all" ? null : body.providerId as string | null;
    }
    if (isReasoningLevel(body.reasoningEffort)) patch.reasoningEffort = body.reasoningEffort;
    if (body.pinnedCredentialId === null || typeof body.pinnedCredentialId === "number") {
      patch.pinnedCredentialId = body.pinnedCredentialId as number | null;
    }

    const conversation = chat.updateConversation(id, patch);
    if (!conversation) {
      return errorResponse(c, 404, "No such conversation.", "invalid_request_error", "not_found");
    }
    return c.json({ conversation });
  });

  app.delete("/conversations/:id", (c) => {
    const id = idOf(c);
    if (id === null) return errorResponse(c, 400, "Invalid id.", "invalid_request_error");
    if (!chat.deleteConversation(id)) {
      return errorResponse(c, 404, "No such conversation.", "invalid_request_error", "not_found");
    }
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------- send

  /**
   * Stream a reply. Emits `delta`, then exactly one of `done` or `error`, so
   * the client always has a definite terminal event to close on.
   */
  app.post("/conversations/:id/send", async (c) => {
    const id = idOf(c);
    if (id === null) return errorResponse(c, 400, "Invalid id.", "invalid_request_error");

    const conversation = chat.getConversation(id);
    if (!conversation) {
      return errorResponse(c, 404, "No such conversation.", "invalid_request_error", "not_found");
    }

    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return errorResponse(c, 400, "Message is empty.", "invalid_request_error", "empty_message");
    }

    // The browser guards this too, but the server is the real boundary: an
    // empty model is forwarded verbatim and comes back as an opaque upstream
    // error rather than something the user can act on.
    const model = (conversation.model || cfg.defaultModel || "").trim();
    if (!model) {
      return errorResponse(
        c,
        400,
        "No model selected for this conversation. Pick one, or type a model id if the provider has no list.",
        "invalid_request_error",
        "no_model",
      );
    }

    chat.addMessage({ conversationId: id, role: "user", content });
    chat.autoTitle(id, content);

    const history: OpenAIMessage[] = chat
      .messages(id)
      .filter((m) => !m.error)
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    c.req.raw.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const started = Date.now();

    return streamSSE(c, async (stream) => {
      const fail = async (message: string, code: string, detail?: unknown) => {
        chat.addMessage({
          conversationId: id,
          role: "assistant",
          content: "",
          error: message,
          latencyMs: Date.now() - started,
        });
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message, code, detail }) });
      };

      let outcome;
      try {
        outcome = await router.chat(
          {
            model,
            messages: history,
            stream: true,
            reasoning_effort: capabilitiesFor(
              model,
              cfg.modelCapabilities,
              mergeDiscovered(store.all().map((cred) => cred.modelMetadata), model),
            ).reasoning
              ? (conversation.reasoningEffort as never)
              : undefined,
          },
          controller.signal,
          { pinnedCredentialId: conversation.pinnedCredentialId, providerId: conversation.providerId },
        );
      } catch (err) {
        return void (await fail((err as Error).message, "router_failed"));
      }

      if (!outcome.ok) {
        return void (await fail(outcome.message, outcome.code, { retryAt: outcome.retryAt }));
      }

      const servedBy = displayName(outcome.credential);
      await stream.writeSSE({
        event: "start",
        data: JSON.stringify({
          credentialId: outcome.credential.id,
          credentialName: servedBy,
          attempts: outcome.attempts,
          model: outcome.model,
        }),
      });

      let text = "";
      let reasoning = "";
      let tokens = 0;
      let broke = false;

      try {
        for await (const ev of outcome.events) {
          if (ev.kind === "text") {
            text += ev.delta;
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.delta }) });
          } else if (ev.kind === "reasoning") {
            reasoning += ev.delta;
            await stream.writeSSE({
              event: "reasoning",
              data: JSON.stringify({ text: ev.delta }),
            });
          } else if (ev.kind === "usage") {
            tokens = ev.usage.total_tokens;
          } else if (ev.kind === "error") {
            broke = true;
            break;
          }
        }
      } catch (err) {
        log.warn("chat_stream_failed", { err });
        broke = true;
      }

      const latencyMs = Date.now() - started;

      // Persist whatever arrived. A half-answer is still worth keeping — it is
      // often the most informative thing when you are testing a flaky Auth.
      chat.addMessage({
        conversationId: id,
        role: "assistant",
        content: text,
        credentialId: outcome.credential.id,
        credentialName: servedBy,
        tokens,
        latencyMs,
        error: broke ? "Stream ended early" : null,
      });
      store.markSuccess(outcome.credential.id, tokens);

      await stream.writeSSE({
        event: broke ? "error" : "done",
        data: JSON.stringify({
          message: broke
            ? "The stream ended before the model finished. Output already sent is kept above."
            : undefined,
          code: broke ? "stream_interrupted" : undefined,
          tokens,
          latencyMs,
          credentialName: servedBy,
          reasoningLength: reasoning.length,
        }),
      });
    });
  });

  // ----------------------------------------------------- capabilities

  app.get("/capabilities", (c) => {
    const metadata = store.all().map((cred) => cred.modelMetadata);

    /*
     * Report on every model the pool can actually serve, not just the ids in
     * config. `cfg.models` is the static bootstrap list, so a connection whose
     * catalogue was discovered — which is most of them — had none of its
     * models represented here at all.
     */
    const ids = new Set(cfg.models);
    for (const cred of store.all()) for (const m of cred.customModels ?? []) ids.add(m);

    return c.json({
      builtin: BUILTIN_CAPABILITIES,
      overrides: cfg.modelCapabilities,
      resolved: Object.fromEntries(
        [...ids]
          .sort()
          .map((m) => [m, capabilitiesFor(m, cfg.modelCapabilities, mergeDiscovered(metadata, m))]),
      ),
    });
  });

  return app;
}
