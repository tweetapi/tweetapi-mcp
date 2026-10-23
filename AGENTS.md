# TweetAPI MCP Server Agent Guide

## Repository Purpose

This public repository owns the TweetAPI MCP server: the local stdio server and the production
runtime for the hosted service at `https://mcp.tweetapi.com/mcp`. It contains the MCP transport,
dashboard-backed OAuth boundary, public read-only live-tool allowlist, documentation tools,
validation, and deployment guidance.

Customer-facing product documentation and public API contract artifacts belong in the TweetAPI
Dashboard repository. Portable skill and plugin guidance belongs in the separate TweetAPI
agent-skill repository. Do not duplicate either surface here.

## Start Every Task

1. Inspect `git status`, the current branch, and unrelated local changes.
2. Read `README.md` for the service contract.
3. Read `docs/security.md` for authentication, secret, and tool-boundary work.
4. Read `docs/deployment.md` before Docker, Coolify, reverse-proxy, environment, health-check, or
   production work.
5. Inspect the current source and tests for the affected subsystem; historical checkpoint documents
   are evidence, not current implementation truth.

## Source-of-Truth Map

- `src/hosted.ts` — stateless Streamable HTTP handler, routes, Host validation, body limits, request
  limiting, and transport lifecycle.
- `src/mcp-auth.ts` — OAuth token validation, required `tweetapi:read` scope, protected-resource
  metadata, and dashboard grant resolution.
- `src/live.ts` — explicit public read-only tool allowlist, input schemas, upstream REST forwarding,
  timeouts, errors, and output shaping.
- `src/docs.ts` — public documentation sources, cache, search, endpoint lookup, and SDK guidance.
- `src/server.ts` — MCP resources, documentation tools, live-tool registration, catalog, and
  prompts.
- `src/http-bin.ts` and `src/bin.ts` — hosted HTTP and local stdio entry points.
- `docs/security.md` and `docs/deployment.md` — canonical security and deployment runbooks.
- `package.json` — supported commands and current runtime/dependency versions.

## Non-Negotiable Boundaries

- Hosted `/mcp` clients authenticate with dashboard-issued MCP OAuth bearer tokens. Raw TweetAPI API
  keys are not accepted as hosted bearer tokens.
- Validate issuer, audience, expiry, and `tweetapi:read` scope before exposing or invoking tools.
  Resolve the backing TweetAPI key only through the dashboard's internal grant resolver.
- Never forward the MCP bearer token upstream and never expose the resolved API key to the client.
- Keep live tools limited to explicitly allowed public, customer-facing, read-only `/tw-v2`
  operations in `src/live.ts`.
- Do not add posting, DMs, follows, profile edits, account-secret inputs, billing, administration,
  hidden endpoints, or internal routes without a separately approved auth, scope, audit, redaction,
  and confirmation design.
- One live tool call performs one upstream TweetAPI request. Do not add automatic pagination or
  silent live retries.
- The core TweetAPI API remains authoritative for API-key validation, quota, billing, rate limits,
  usage logs, and subscriptions.
- In production, the upstream base URL must remain exactly `https://api.tweetapi.com`.
- App-level limiting does not trust `X-Forwarded-For`. It buckets requests by `CF-Connecting-IP`
  (configurable) only for rate limiting, never for auth, and a global limit caps total traffic. Real
  per-client IP controls still belong at the trusted proxy or edge.

## Secrets and Sensitive Data

- Never commit `.env` files or print API keys, OAuth tokens, authorization headers, JWT secrets,
  dashboard internal tokens, Twitter/X cookies, `authToken`, `ct0`, proxy credentials, passwords, or
  message contents.
- `MCP_DASHBOARD_INTERNAL_TOKEN` and `MCP_OAUTH_JWT_SECRET` must match the Dashboard deployment and
  be rotated through deployment secrets, not source control.
- Use placeholders only in documentation and fixtures. Test secrets must be obviously synthetic and
  confined to tests.
- Do not make live TweetAPI calls during setup, unit tests, smoke tests, or release validation
  unless the maintainer explicitly authorizes a bounded live call.

## Commands and Validation

```bash
pnpm run format:check
pnpm run lint:md
pnpm run typecheck
pnpm run test
pnpm run check
pnpm run check:release
```

- `pnpm run check` is the normal complete local gate: formatting, Markdown lint, TypeScript, tests,
  and secret scanning.
- `pnpm run check:release` adds the release documentation and hosted HTTP smoke checks.
- Tests and smoke checks use mocks or local servers and must not call the live TweetAPI API.
- Use focused checks while iterating, then run the complete relevant gate before handoff.
- Report skipped checks. Local success does not prove the deployed service, production OAuth
  configuration, proxy behavior, quota, or billing.

## Documentation and Contract Changes

- Keep `README.md`, `docs/security.md`, `docs/deployment.md`, code, tests, and environment examples
  aligned when a runtime contract changes.
- Public OpenAPI and Postman artifacts are generated and maintained by TweetAPI Dashboard; do not
  copy or hand-edit them here.
- Changes to the live-tool allowlist must include tests that prove the route is public/read-only,
  forbidden inputs remain excluded, and one tool call makes one upstream request.

## Deployment and Git Boundaries

- Do not deploy, change Coolify, update DNS or proxy settings, rotate secrets, call authenticated
  production endpoints, publish registry metadata, or perform production smoke tests without
  explicit approval for that action.
- Before an approved deployment, follow `docs/deployment.md` and run `pnpm run check:release`.
- Do not commit or push unless explicitly authorized. Stage only intended files, verify
  `git diff --cached --name-only`, and preserve unrelated user changes.
