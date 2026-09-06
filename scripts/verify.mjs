#!/usr/bin/env node
/**
 * End-to-end check against a really running gateway. `npm run verify`.
 *
 * The unit suite asserts this project's own bookkeeping. This asserts what
 * actually crosses the wire, which is where the bugs have been: images that
 * were accepted and then dropped during translation, tool calls that never
 * reached the provider, a Claude client 404ing on a path that existed.
 *
 * It boots the built CLI against a throwaway data directory and a mock
 * upstream, so it needs no credentials and touches nothing real. Run it before
 * publishing.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli.js");
const MOCK = 8891;
const GW = 8892;
const KEY = "aia-verify-key";
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

if (!existsSync(CLI)) {
  console.error(`No build at ${CLI}. Run "npm run build" first.`);
  process.exit(1);
}

const received = [];
const failures = [];
let checks = 0;

const check = (name, ok, detail = "") => {
  checks += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const sse = (frames) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";

const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [
            {
              id: "mock-vision",
              architecture: { input_modalities: ["text", "image"] },
              supported_parameters: ["tools"],
              context_length: 128000,
            },
          ],
        }),
      );
    }
    received.push(raw ? JSON.parse(raw) : null);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse([
        { choices: [{ delta: { content: "ok from upstream" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      ]),
    );
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {}
    await wait(500);
  }
  return false;
}
const parseSse = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const HOME = mkdtempSync(join(tmpdir(), "open-auther-verify-"));
let gw;

try {
  await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));

  gw = spawn(process.execPath, [CLI], {
    env: {
      ...process.env,
      AI_AUTHER_HOME: HOME,
      AI_AUTHER_DB: join(HOME, "verify.db"),
      AI_AUTHER_PORT: String(GW),
      AI_AUTHER_API_KEY: KEY,
      AI_AUTHER_UI: "false",
      AI_AUTHER_MODEL_SYNC_HOURS: "0",
      AI_AUTHER_LOG_LEVEL: "error",
      AI_AUTHER_FREE_ONLY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout.on("data", () => {});
  gw.stderr.on("data", () => {});

  const up = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${GW}/health`);
    return r.status > 0;
  });
  if (!up) throw new Error("gateway never started");

  const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const add = await (
    await fetch(`http://127.0.0.1:${GW}/admin/providers/custom`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "verify-mock",
        baseUrl: `http://127.0.0.1:${MOCK}/v1`,
        apiKey: "sk-mock",
      }),
    })
  ).json();
  if (!add.ok) throw new Error(`could not register mock provider: ${JSON.stringify(add).slice(0, 200)}`);

  // ---------------------------------------------------------- discovery
  console.log("\nmodel discovery");
  const caps = await (
    await fetch(`http://127.0.0.1:${GW}/admin/chat/capabilities`, { headers: H })
  ).json();
  const mv = caps.resolved?.["mock-vision"];
  check("capabilities come from the endpoint, not a guess", mv?.source === "discovered", `source=${mv?.source}`);
  check("vision read from input modalities", mv?.vision === true);
  check("context window read from the listing", mv?.contextWindow === 128000);

  // ------------------------------------------------------ OpenAI surface
  console.log("\nOpenAI surface");
  received.length = 0;
  const chat = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: "mock-vision",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this screenshot?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
          ],
        },
      ],
    }),
  });
  check("chat/completions answers", chat.status === 200, `HTTP ${chat.status}`);
  const sentContent = received[0]?.messages?.find((m) => m.role === "user")?.content;
  check(
    "the image reaches the upstream",
    Array.isArray(sentContent) &&
      sentContent.some((p) => p.type === "image_url" && String(p.image_url?.url).includes(PNG)),
  );

  received.length = 0;
  await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "mock-vision", stream: false, messages: [{ role: "user", content: "plain" }] }),
  });
  check(
    "a text-only turn stays a plain string",
    typeof received[0]?.messages?.find((m) => m.role === "user")?.content === "string",
  );

  // --------------------------------------------------- Anthropic surface
  console.log("\nAnthropic surface (Claude Code / desktop)");
  const hello = await fetch(`http://127.0.0.1:${GW}/api/hello`, { method: "HEAD" });
  check("HEAD /api/hello warm-up probe", hello.status === 200, `HTTP ${hello.status}`);

  const noAuth = await fetch(`http://127.0.0.1:${GW}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  check("unauthenticated request is refused", noAuth.status === 401, `HTTP ${noAuth.status}`);

  // Both the correct base and the doubled prefix a `/v1` base produces.
  for (const path of ["/v1/messages", "/v1/v1/messages"]) {
    received.length = 0;
    const res = await fetch(`http://127.0.0.1:${GW}${path}?beta=true`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        stream: true,
        system: [{ type: "text", text: "Be terse." }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    });
    const kinds = parseSse(await res.text()).map((f) => f.type);
    const need = [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ];
    check(`${path} streams the full frame sequence`, need.every((k) => kinds.includes(k)), kinds.join(" "));
    check(`${path} maps the Claude model name`, received[0]?.model === "mock-vision", `served ${received[0]?.model}`);
  }

  for (const path of ["/v1/models", "/v1/v1/models"]) {
    const r = await fetch(`http://127.0.0.1:${GW}${path}?limit=1000`, { headers: { "x-api-key": KEY } });
    const body = await r.json().catch(() => null);
    check(`${path} serves the discovery shape`, r.status === 200 && Array.isArray(body?.data) && Boolean(body.data[0]?.id));
  }

  received.length = 0;
  const ns = await fetch(`http://127.0.0.1:${GW}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
      ],
    }),
  });
  const nsBody = await ns.json();
  check("non-streaming returns an Anthropic message", nsBody?.type === "message" && nsBody?.role === "assistant");
  const imgSent = received[0]?.messages?.find((m) => m.role === "user")?.content;
  check(
    "an Anthropic image block reaches the upstream",
    Array.isArray(imgSent) && imgSent.some((p) => p.type === "image_url" && String(p.image_url?.url).includes(PNG)),
  );

  received.length = 0;
  await fetch(`http://127.0.0.1:${GW}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      stream: false,
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "read foo" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "foo" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "contents" }] },
      ],
    }),
  });
  const body = received[0];
  check("tool schema reaches the upstream", body?.tools?.[0]?.function?.name === "read_file");
  check(
    "a tool call survives the round trip",
    body?.messages?.some((m) => m.tool_calls?.[0]?.function?.name === "read_file"),
  );
  check(
    "a tool result survives the round trip",
    body?.messages?.some((m) => m.role === "tool" && m.content === "contents"),
  );

  const ct = await (
    await fetch(`http://127.0.0.1:${GW}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello world" }] }),
    })
  ).json();
  check("count_tokens answers", typeof ct?.input_tokens === "number" && ct.input_tokens > 0);
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error("\n" + err.stack);
} finally {
  gw?.kill();
  mock.close();
  await wait(300);
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {}
}

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${checks}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${checks} live checks passed.`);
