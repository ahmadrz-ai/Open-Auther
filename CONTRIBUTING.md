# Contributing to Open-Auther

## Local setup

1. Install Node.js 22.5.0 or newer.
2. Install dependencies with `npm install`.
3. Run `npm run build`.
4. Run `npm run test`.

## Before opening a pull request

```bash
npm run build
npm run test
npm run pack:check
```

Do not commit credentials, OAuth tokens, database files, generated local configuration, or temporary test artifacts.

## Pull requests

Use a clear description, include the affected commands or routes, and include test output for behavior changes. Keep Open-Auther separate from unrelated projects and branding.
