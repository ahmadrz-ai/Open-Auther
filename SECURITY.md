# Security

## What this project holds

ai-auther stores **live ChatGPT OAuth access and refresh tokens**. These are
full account credentials, not scoped API keys. Anyone who can read
`~/.ai-auther/ai-auther.db` can act as every account in the pool.

Treat that file with the same care as an SSH private key: do not commit it, do
not sync it to shared cloud storage, do not include it in a bug report.

## Reporting a problem

If you find a way to make ai-auther leak a credential — through logs, an HTTP
response, an error message, the dashboard, or anything else — report it
privately rather than opening a public issue. A public issue containing a
reproduction is itself a disclosure.

Include: what you did, what leaked, and where it surfaced. Do not include real
tokens; a redacted excerpt showing the shape is enough.

## Threat model

The default deployment is a single user on `127.0.0.1`. Within that model:

**Defended against**

- Secrets reaching log output, including through exception messages and stack
  traces. Redaction runs at serialisation, so it catches values no call site
  marked as sensitive.
- Credentials appearing in URLs. Everything upstream travels in headers, and a
  test asserts the upstream URL carries no query string.
- Unauthenticated local processes reaching the pool. All `/v1` and `/admin`
  routes require a gateway key; `/health` is the only open route and exposes
  counts only.
- Concurrent refreshes destroying a credential. Refreshes are serialised per
  credential because refresh tokens are single-use.
- Token material leaving the process. Only masked, state-only shapes are
  serialised to HTTP or the dashboard.

**Not defended against**

- A local attacker who can read your home directory. The database is `0600` on
  POSIX systems; it is not encrypted at rest.
- Anyone with the gateway key. There is no per-key rate limiting or quota, so a
  leaked key can drain every account in the pool.
- Network exposure. There is no TLS and no protection against a hostile
  network. Binding to anything other than loopback needs a reverse proxy and a
  reconsidered key policy.
- OpenAI-side account actions. Nothing here prevents accounts being suspended
  for violating terms — see the README.

## If a credential leaks

1. Revoke the affected ChatGPT session from the account's own settings. Rotating
   the ai-auther key is not enough; the leaked token authenticates directly.
2. `ai-auther auth remove <id>` to drop it from the pool.
3. Rotate the gateway key: `ai-auther key new`, then update `config.json` and
   every client.
