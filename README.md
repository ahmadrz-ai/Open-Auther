# Open-Auther

Open-Auther is a local OpenAI-compatible gateway that routes chat requests through a pool of OAuth, API-key, and web-session providers. It includes credential rotation, failover, model discovery, request logs, health monitoring, and a browser dashboard.

## Requirements

- Node.js `22.5.0` or newer
- A provider credential for the upstream service you want to use

## Install from npm

```bash
npm install open-auther
```

Run the gateway from a local install:

```bash
npx open-auther
```

The package provides both command spellings:

```text
open-auther   canonical command
openauther    compatibility alias
```

The npm package name is always `open-auther`, hyphenated. `openauther` is only a
command alias, so `npm install openauther` fails with a 404.

A local `npm install open-auther` does not place the command on your global PATH. Use `npx`, or install globally.

Or install the CLI globally:

```bash
npm install --global open-auther
open-auther
# compatibility alias:
openauther
```

Check the installed version:

```bash
npx open-auther --version
```

The CLI prints the local OpenAI-compatible base URL, gateway API key, and dashboard URL when it starts.

## CLI commands

```text
open-auther [serve]                 Start the gateway and dashboard
open-auther status                  Show pool summary
open-auther auth login [--provider codex] [--label X]
open-auther auth adapters             List interactive login adapters
open-auther auth import <file>      Import credentials from JSON
open-auther auth list               List configured accounts
open-auther auth revive <id>        Re-enable a dead credential
open-auther auth remove <id>        Remove a credential
open-auther providers list          List registered providers
open-auther providers status        Show live provider health and pool state
open-auther providers status --json Machine-readable provider status
open-auther providers discover      Probe and persist endpoint/model metadata
open-auther providers discover --json
                                    Machine-readable discovery results
open-auther providers sync [id]     Re-read live model catalogues now
open-auther providers sync --json   Machine-readable sync results
open-auther doctor                  Diagnose local gateway readiness
open-auther doctor --json           Machine-readable diagnostics
open-auther key show|new            Show or create gateway API keys
open-auther uninstall [--yes] [--purge-cache]
                                    Remove the package and all local data
```

## Uninstall

```bash
open-auther uninstall
```

It asks for confirmation, then removes the npm package (global and local) and
every local data path: config, database, and OAuth tokens. `--yes` skips the
prompt.

npm's cache is kept by default. To force the next install to refetch from the
registry rather than serve a cached tarball, add `--purge-cache` (this clears
npm's whole cache, because npm no longer supports evicting a single package):

```bash
open-auther uninstall --yes --purge-cache
```

Stop a running gateway first. On Windows an active process holds the database
open, and the command will report which path it could not delete.

## Model discovery and capabilities

The model catalogue is read from the providers themselves, not from a list in
this repository. Every connection is asked what it currently serves when it is
added, and again on a schedule while the gateway runs:

```bash
open-auther providers sync
```

`providers sync` re-reads every catalogue immediately; the gateway repeats it
every `AI_AUTHER_MODEL_SYNC_HOURS` hours (default 6, `0` disables). The static
model lists in the source are only the bootstrap for a connection that has not
synced yet. A failed or empty sync changes nothing — the previous list keeps
serving, so a network blip cannot empty a working pool.

Discovery keeps what each provider says about a model, not just its name:

```text
Antigravity   supportsImages, supportsThinking, maxTokens, quota,
              and deprecatedModelIds (a retired id -> its replacement)
Codex         the account's visible slugs, in the client's own priority order
OpenRouter    architecture.input_modalities, supported_parameters, context_length
Others        whatever GET /models publishes; anything absent stays unknown
```

Two things follow from that.

**Retired ids are followed, not failed.** When a provider says an id has been
superseded and the replacement is one the pool can serve, requests for the old
id are routed to the new one and the redirect is logged. Previously a client
pinned to a retired model got a hard failure indefinitely, even though the
backend had named its replacement in the same response.

This is handled in two places, because providers announce it in two ways. A
deprecation listed in the catalogue is picked up by discovery. A refusal that
only appears at generation time — Antigravity answers HTTP 200 with *"Gemini
3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash"* where the
reply should be — is detected in the response, recorded, and the request is
retried once against the named replacement. Without that second case the
notice was forwarded to the client as if it were the model's answer.

**The capability gate only refuses on evidence.** Vision, tool, and reasoning
requirements are inferred from the request, and a model is rejected before the
upstream call only when something that actually knows says it cannot comply: a
capability override you set, the provider's own manifest, or the verified
built-in table. A model nothing has described is sent upstream and the upstream
decides. This is the fix for image requests being refused locally for models
that accept images perfectly well — every id outside the built-in table used to
resolve to "unknown", whose vision flag is false, and the gate treated that
absence of information as a "no".

Capabilities resolve highest-precedence-first: your override, then the
provider's manifest, then the built-in table, then a guess from the model
family, then the conservative default. The layers merge, so a provider that
publishes only image support still picks up a context window from the table.
Overrides are editable in Settings and always win.

Virtual models such as `fast` and `quality` rank only candidates that can
satisfy the request's requirements, scored against the discovered facts rather
than the model name alone.

### Image input

Image parts are forwarded to whichever protocol the connection speaks, in that
provider's own encoding:

```text
Gemini / Antigravity   inlineData for a payload, fileData for a URL
OpenAI-compatible      an image_url content part
Anthropic Messages     an image block with a base64 or url source
Codex                  input_image, unchanged
```

Both `data:` URLs and remote `https:` URLs are accepted; nothing is fetched or
re-encoded on the way through. A text-only turn is still sent as a plain
string, because some OpenAI-compatible servers reject the typed-part array.

The dashboard's Chat page can attach images directly — the `+` button, drag and
drop onto the composer, or paste a screenshot from the clipboard. Up to 8
images per message, 8 MB each. Attachments are stored with the conversation, so
they are still there after a reload.

### Antigravity client version

The Cloud Code backend refuses client builds it considers stale, and it does so
in the worst possible way: HTTP 200, with "This version of Antigravity is no
longer supported" where the model's reply should be. A connection that has gone
stale therefore looks perfectly healthy while answering every prompt with an
upgrade notice.

The version is resolved at runtime rather than compiled in, most trustworthy
source first:

```text
1  AI_AUTHER_ANTIGRAVITY_VERSION   an explicit setting always wins
2  the Antigravity IDE installed on this machine, read from its product.json
3  a version already resolved this session
4  a built-in fallback, used only when nothing above is available
```

If you have the IDE installed, its version is by definition the one the backend
accepts, and updating the IDE is picked up without restarting the gateway. Point
at an unusual install with `AI_AUTHER_ANTIGRAVITY_APP`.

When the backend does refuse a version, that version is retired rather than
re-sent, and the request fails with `antigravity_client_outdated` naming the
version and where it came from. `open-auther doctor` reports the version in use
and warns when it is the fallback guess rather than something read off the
machine.

## Use it from Claude Code and the Claude desktop app

The gateway also serves the **Anthropic Messages API** at `/v1/messages`, which
is what Claude Code and the Claude desktop app's third-party inference mode
connect to. Point either at Open-Auther and your pooled models answer instead
of Anthropic's.

In the desktop app: **Developer → Configure Third-Party Inference**, set
Connection to `Gateway`, then:

```text
Gateway base URL   http://127.0.0.1:8787          <- no /v1 on the end
Gateway API key    your open-auther key (open-auther key show)
Gateway auth scheme  either — x-api-key and Bearer are both accepted
```

For Claude Code, the same thing through the environment:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=your-open-auther-key
```

### Which model actually answers

These clients send the Claude model they believe they are talking to, such as
`claude-sonnet-4-6`, which your pool almost certainly does not serve. Rather
than fail, the request is mapped:

```text
1  an explicit entry in `anthropicModelMap`
2  the requested id itself, when a connection really does serve it
3  `anthropicDefaultModel` — `auto` by default, so routing picks what is healthy
```

Set `AI_AUTHER_ANTHROPIC_MODEL` to change the default, or pin specific names in
the config file:

```json
{
  "anthropicDefaultModel": "quality",
  "anthropicModelMap": { "claude-opus-4-6": "gemini-3.7-flash-tiered" }
}
```

### Seeing your non-Claude models in the picker

These clients keep only discovered ids containing `claude` or `anthropic`, and
silently drop the rest — so a pool of Gemini, GPT and Qwen ids shows up in the
model picker as nothing at all. That filter is client-side; the gateway cannot
change it. Three ways round it:

1. **Type them in.** The client's own *Models → Model list* box overrides
   discovery entirely. Enter `gemini-3.8-flash-tiered` and it is sent verbatim.
   Nothing to configure here.
2. **Map them.** Leave the picker on a Claude name and point it elsewhere with
   `anthropicModelMap`, above.
3. **Advertise them under an alias.** Set `AI_AUTHER_ANTHROPIC_EXPOSE_ALL=1` and
   every non-Claude model is additionally listed as
   `anthropic/openauther-<id>`, which passes the filter. The prefix is stripped
   before routing, so it never reaches a provider. Off by default, because it
   shows every model twice to anything speaking the OpenAI shape.

The base URL is the **bare origin**, with no `/v1` — these clients append
`/v1/messages` themselves. The gateway's startup banner prints both, because
the OpenAI base URL does end in `/v1` and pasting the wrong one produces
`/v1/v1/messages`. Both paths are served anyway, so either value works.

### What is implemented

```text
POST /v1/messages               streaming and non-streaming, tools, images
POST /v1/messages/count_tokens  optional; a deliberate overestimate
GET  /v1/models                 discovery shape
HEAD /api/hello                 connection warm-up probe
```

Each is also served under `/v1/v1/...`, for a base URL that already ends in
`/v1`.

## Verifying a build

The unit suite checks this project's own bookkeeping. `npm run verify` checks
what actually crosses the wire, which is where the bugs have been: it boots the
built CLI against a throwaway data directory and a mock upstream, then asserts
the payloads the upstream receives and the frames a Claude client gets back.

```bash
npm run verify
```

It needs no credentials and touches nothing real. `prepublishOnly` runs it, so
a release cannot ship without it passing.

Replies stream as Anthropic content blocks, and `ping` frames are emitted
during silent gaps — the client counts bytes and aborts a stream that goes
quiet for 300 seconds, which a thinking model would otherwise trigger.

## Custom endpoint protocols

A custom provider's wire protocol is detected, not assumed. Detection probes in
order:

```text
GET  <base>/models             OpenAI-compatible, and yields the model list
POST <base>/chat/completions   OpenAI-compatible with no listing route
POST <base>/messages           Anthropic Messages API
```

The result is stored per credential, so later requests are framed correctly:
Anthropic endpoints get `x-api-key` and `anthropic-version` headers, the system
prompt as a top-level field, and a mandatory `max_tokens`. Previously every
custom provider was assumed OpenAI-compatible, so an Anthropic endpoint returned
a bare 404 with nothing to explain it.

Re-run detection on an existing connection with:

```bash
open-auther providers discover
```

## Configuration

Environment variables use the `AI_AUTHER_` prefix for compatibility with existing installations:

```text
AI_AUTHER_HOME        Data directory (default: ~/.ai-auther)
AI_AUTHER_PORT        Listen port (default: 8787)
AI_AUTHER_HOST        Bind address (default: 127.0.0.1)
AI_AUTHER_API_KEY     Override the gateway API key
AI_AUTHER_ROTATION    fill_first | round_robin | least_used | random
AI_AUTHER_LOG_LEVEL   debug | info | warn | error
AI_AUTHER_MODEL_SYNC_HOURS
                      How often to re-read provider model catalogues
                      (default: 6; 0 disables the automatic sweep)
AI_AUTHER_ANTIGRAVITY_VERSION
                      Override the Antigravity client version presented
AI_AUTHER_ANTIGRAVITY_APP
                      Path to an Antigravity install, when it is not in
                      one of the standard locations
```

The default API endpoint is:

```text
http://127.0.0.1:8787/v1
```

Treat the data directory as sensitive. It can contain OAuth tokens and gateway credentials.

## Development

```bash
npm install
npm run build
npm run test
npm run pack:check
```

The build copies the dashboard and the supplied Open-Auther logo into `dist/ui`. The package is tested as both a bundled CLI and an installable npm package.

## Security

Read [SECURITY.md](SECURITY.md) before reporting a security issue. Never commit OAuth tokens, API keys, database files, or local configuration.

## License

MIT. See [LICENSE](LICENSE).
