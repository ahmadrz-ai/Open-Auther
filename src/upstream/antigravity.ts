/**
 * Antigravity transport.
 *
 * The Cloud Code backend speaks Gemini's `generateContent` schema wrapped in
 * an envelope that carries the account's project id:
 *
 *   { project, model, requestId, userAgent, requestType, request: { … } }
 *
 * Only the streaming endpoint is used. The non-streaming `generateContent`
 * route 400s for several models because the backend converts internally to the
 * OpenAI format and injects `stream_options` without setting `stream`. We
 * aggregate non-streaming client requests ourselves anyway.
 */

import { randomUUID } from "node:crypto";
import { ANTIGRAVITY, contentHeaders, streamUrls } from "../core/antigravity.js";
import { createLogger } from "../logging.js";
import { classifyHttp, classifyTransport, type UpstreamFailure } from "../pool/errors.js";
import type { Credential } from "../pool/types.js";
import { CLIENT_PARAMS, type CodexEvent, type CodexRequest } from "./translate.js";

const log = createLogger({ mod: "antigravity" });

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Map our internal Responses-shaped body onto Gemini `contents`.
 *
 * Two rules the backend enforces: roles alternate strictly user/model, and no
 * content may have an empty parts array. Both produce a 400 otherwise, so we
 * merge consecutive same-role turns and drop empties rather than passing them
 * through and hoping.
 */
export function toGeminiRequest(body: CodexRequest): Record<string, unknown> {
  const contents: GeminiContent[] = [];

  const push = (role: "user" | "model", part: GeminiPart) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };

  for (const item of body.input) {
    if (item.type === "message") {
      const parts = (item.content as Array<Record<string, unknown>> | undefined) ?? [];
      const text = parts.map((p) => String(p.text ?? "")).join("");
      if (!text) continue;
      push(item.role === "assistant" ? "model" : "user", { text });
    } else if (item.type === "function_call") {
      let args: unknown = {};
      try {
        args = JSON.parse(String(item.arguments ?? "{}"));
      } catch {
        args = {};
      }
      push("model", { functionCall: { name: String(item.name ?? ""), args } });
    } else if (item.type === "function_call_output") {
      // Tool results are a *user* turn in Gemini's schema, not their own role.
      push("user", {
        functionResponse: {
          name: String(item.call_id ?? "tool"),
          response: { output: String(item.output ?? "") },
        },
      });
    }
  }

  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });

  const request: Record<string, unknown> = { contents };

  if (body.instructions) {
    request.systemInstruction = { role: "user", parts: [{ text: body.instructions }] };
  }

  const generationConfig: Record<string, unknown> = {};
  const params = body[CLIENT_PARAMS];
  if (typeof params?.temperature === "number") generationConfig.temperature = params.temperature;
  if (typeof params?.top_p === "number") generationConfig.topP = params.top_p;
  if (typeof params?.max_output_tokens === "number") {
    generationConfig.maxOutputTokens = params.max_output_tokens;
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  if (body.tools?.length) {
    request.tools = [
      {
        functionDeclarations: body.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? { type: "object", properties: {} },
        })),
      },
    ];
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  return request;
}

export function buildEnvelope(
  body: CodexRequest,
  projectId: string,
): Record<string, unknown> {
  return {
    project: projectId,
    model: body.model,
    requestId: randomUUID(),
    userAgent: "antigravity",
    requestType: "agent",
    request: toGeminiRequest(body),
  };
}

/** Project id lives in the credential's baseUrl slot for this provider. */
export function projectIdOf(credential: Credential): string {
  return (credential.baseUrl ?? "").trim();
}

export type AntigravityResult =
  | { ok: true; response: Response }
  | { ok: false; failure: UpstreamFailure };

export async function callAntigravity(
  credential: Credential,
  body: CodexRequest,
  signal: AbortSignal,
): Promise<AntigravityResult> {
  const projectId = projectIdOf(credential);
  if (!projectId) {
    return {
      ok: false,
      failure: {
        kind: "terminal",
        status: 422,
        code: "missing_project_id",
        message:
          "This Antigravity connection has no Cloud Code project id. Reconnect it from " +
          "Add Provider so the project can be discovered again.",
        resetsAt: null,
        usageLimited: false,
      },
    };
  }

  const envelope = buildEnvelope(body, projectId);
  const headers = contentHeaders(credential.accessToken ?? "");
  const urls = streamUrls();

  let lastFailure: UpstreamFailure | null = null;

  // Two runtime hosts. The daily host is usually less loaded but goes away
  // occasionally, so fall through to the stable one on transport errors and
  // 5xx only — never on an auth or quota answer, which both hosts would give.
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        return {
          ok: false,
          failure: {
            kind: "client",
            status: 499,
            code: "client_disconnected",
            message: "client aborted the request",
            resetsAt: null,
            usageLimited: false,
          },
        };
      }
      lastFailure = classifyTransport(err);
      continue;
    }

    if (res.ok) return { ok: true, response: res };

    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const failure = classifyHttp(res.status, parsed, text);
    log.debug("antigravity_error", {
      credential: credential.id,
      status: failure.status,
      code: failure.code,
    });

    if (res.status < 500) return { ok: false, failure };
    lastFailure = failure;
  }

  return {
    ok: false,
    failure: lastFailure ?? {
      kind: "transient",
      status: 0,
      code: "no_endpoint",
      message: "no Antigravity endpoint answered",
      resetsAt: null,
      usageLimited: false,
    },
  };
}

/**
 * Map one Cloud Code SSE payload onto our normalised events.
 *
 * The frames are Gemini `GenerateContentResponse` objects, optionally nested
 * under `response` by the Cloud Code envelope.
 */
/** The backend's "upgrade your IDE" notice, delivered as if it were an answer. */
const CLIENT_TOO_OLD = /version of Antigravity is no longer supported/i;

export function mapAntigravityEvent(raw: Record<string, unknown>): CodexEvent[] {
  const payload = (raw.response as Record<string, unknown> | undefined) ?? raw;
  const out: CodexEvent[] = [];

  const candidates = payload.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const candidate = candidates[0] as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Array<Record<string, unknown>> | undefined) ?? [];

    for (const part of parts) {
      /*
       * A rejected client version arrives as an ordinary model reply, not an
       * error, so the connection looks healthy while every answer is the same
       * upgrade notice. Turn it back into the failure it is.
       */
      if (typeof part.text === "string" && CLIENT_TOO_OLD.test(part.text)) {
        return [
          {
            kind: "error",
            status: 426,
            body: {
              code: "antigravity_client_outdated",
              message:
                "Antigravity rejected this client version. Set " +
                "AI_AUTHER_ANTIGRAVITY_VERSION to the version the IDE currently ships.",
            },
          },
        ];
      }

      // `thought: true` marks a reasoning part, which is not assistant text.
      if (typeof part.text === "string" && part.text) {
        out.push(part.thought ? { kind: "reasoning", delta: part.text } : { kind: "text", delta: part.text });
      }
      const call = part.functionCall as Record<string, unknown> | undefined;
      if (call?.name) {
        out.push({
          kind: "tool_call",
          index: out.filter((e) => e.kind === "tool_call").length,
          id: randomUUID(),
          name: String(call.name),
          arguments: JSON.stringify(call.args ?? {}),
        });
      }
    }

    const finish = candidate.finishReason;
    if (typeof finish === "string" && finish) {
      out.push({
        kind: "done",
        finishReason: finish === "MAX_TOKENS" ? "length" : finish === "STOP" ? "stop" : "stop",
      });
    }
  }

  const usage = payload.usageMetadata as Record<string, unknown> | undefined;
  if (usage) {
    const prompt = Number(usage.promptTokenCount ?? 0);
    const completion = Number(usage.candidatesTokenCount ?? 0);
    out.push({
      kind: "usage",
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: Number(usage.totalTokenCount ?? prompt + completion),
      },
    });
  }

  const error = payload.error as Record<string, unknown> | undefined;
  if (error) out.push({ kind: "error", status: Number(error.code ?? 502), body: error });

  return out;
}

/** Ask the backend which models this account may use. */
export async function fetchAntigravityModels(credential: Credential): Promise<string[]> {
  const projectId = projectIdOf(credential);
  if (!projectId || !credential.accessToken) return [];

  for (const base of ANTIGRAVITY.runtimeBaseUrls) {
    try {
      const res = await fetch(`${base}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: { ...contentHeaders(credential.accessToken), accept: "application/json" },
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;

      const data = (await res.json()) as Record<string, unknown>;
      const modelValue = data.models;
      const arraySummary = Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, (value as unknown[]).length]),
      );
      const modelKeys =
        modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
          ? Object.keys(modelValue as Record<string, unknown>)
          : [];
      log.debug("antigravity_models_response", {
        base,
        keys: Object.keys(data),
        arrays: arraySummary,
        modelKeys,
      });

      const modelLists = [
        data.models,
        data.availableModels,
        data.supportedModels,
        data.modelIds,
        data.agentModelSorts,
        data.commandModelIds,
        data.tabModelIds,
      ];
      const modelObjects = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
        ? Object.entries(modelValue as Record<string, unknown>).map(([id, value]) => ({ id, value }))
        : [];
      const candidates = modelLists.filter((value): value is unknown[] => Array.isArray(value)).flat();
      const models = [
        ...modelObjects.map(({ id }) => id),
        ...candidates.map((m) => {
          if (typeof m === "string") return m;
          if (!m || typeof m !== "object") return "";
          const item = m as Record<string, unknown>;
          return String(item.modelId ?? item.model ?? item.name ?? item.id ?? "");
        }),
      ]
        .map((m) => m.replace(/^models\//, "").trim())
        .filter(Boolean);
      if (models.length) return [...new Set(models)].sort();
    } catch {
      // try the next host
    }
  }
  return [];
}
