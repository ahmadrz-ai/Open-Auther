# Open-Auther 1.0.1 Roadmap

This roadmap is local-only until the release is reviewed and approved. Version 1.0.1 must not be published automatically.

## Completed in the current local iteration

- [x] Provider plugin registry with validation, duplicate protection, and unregister support.
- [x] Built-in providers registered through the same plugin contract.
- [x] Runtime provider lookup through the registry.
- [x] Provider catalogue API reads the live registry, allowing registered plugins to appear.
- [x] Public library entrypoint at `open-auther` with CJS, ESM, and TypeScript declarations.
- [x] CLI command: `open-auther providers list`.
- [x] CLI help documents the provider command.
- [x] Strict registry and public API tests.

## Remaining 1.0.1 scope

### Provider extension SDK

- [ ] Add optional plugin adapters for authentication, model discovery, health checks, and request transport.
- [ ] Document the plugin contract with a small external-provider example.
- [ ] Keep plugin registration explicit; never execute arbitrary package code automatically.

### Discovery and capabilities

- [ ] Represent provider discovery state separately from configured models.
- [ ] Expose model capability metadata and last probe status without exposing credentials.
- [ ] Add provider health diagnostics for the CLI and dashboard.

### Local-first storage

- [ ] Introduce a public storage interface around the existing SQLite implementation.
- [ ] Add schema version/status reporting.
- [ ] Add safe backup and restore helpers with restrictive file permissions where supported.
- [ ] Preserve the existing migration chain and test migration behavior.

### Authentication workflow

- [ ] Define a provider-agnostic login adapter contract.
- [ ] Add explicit cancellation and timeout behavior to interactive login.
- [ ] Keep the existing Codex PKCE flow compatible.
- [ ] Ensure login errors and CLI output never expose token material.

### Routing and failover

- [ ] Include plugin providers in model selection and health-aware routing.
- [ ] Apply capability filtering before selecting a provider/model pair.
- [ ] Improve diagnostics when every candidate is unavailable.

### CLI and dashboard

- [ ] Add `open-auther providers status`.
- [ ] Add `open-auther doctor` for configuration, database, port, and runtime checks.
- [ ] Show registered plugins, discovery state, and provider health in the dashboard.
- [ ] Keep secret values masked in all output and API responses.

### Release gate

Before creating or publishing `open-auther@1.0.1`:

1. Build CJS, ESM, declarations, and UI assets.
2. Run the complete test suite.
3. Run CLI smoke tests.
4. Review `npm pack --dry-run` contents.
5. Test a clean local installation from the tarball.
6. Review the diff and audit report.
7. Commit and push only after user approval.
8. Publish only after user approval and valid npm authorization.
9. Verify the public registry and clean `npm install open-auther` installation.
