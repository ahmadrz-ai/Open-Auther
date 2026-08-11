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

The router rejects known capability mismatches before sending an upstream request. Vision, tool, and reasoning requirements are inferred from the request; virtual models such as `fast` and `quality` only rank candidates that can satisfy those requirements. Unknown models remain usable for ordinary text requests and can be made explicit through capability overrides.

## Configuration

Environment variables use the `AI_AUTHER_` prefix for compatibility with existing installations:

```text
AI_AUTHER_HOME        Data directory (default: ~/.ai-auther)
AI_AUTHER_PORT        Listen port (default: 8787)
AI_AUTHER_HOST        Bind address (default: 127.0.0.1)
AI_AUTHER_API_KEY     Override the gateway API key
AI_AUTHER_ROTATION    fill_first | round_robin | least_used | random
AI_AUTHER_LOG_LEVEL   debug | info | warn | error
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
