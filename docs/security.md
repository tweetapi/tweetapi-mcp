# Security

TweetAPI MCP must keep customer secrets transient and inside trusted server-side request handling.
Do not put secrets in docs, tests, frontend code, mobile clients, logs, or source control.

## Rules

- Hosted MCP clients pass dashboard-issued MCP access tokens as `Authorization: Bearer <token>`.
- Generated app code should store TweetAPI keys as `TWEETAPI_API_KEY` in the app/server environment.
- Do not commit `.env` files.
- Do not expose TweetAPI keys in browser bundles or mobile app clients.
- Do not log TweetAPI API keys, authorization headers, Twitter/X `authToken`, `ct0`, proxy
  credentials, cookies, passwords, or message contents.
- Route frontend requests through a server-side endpoint when a secret is required.
- Avoid live API calls during agent setup unless the user explicitly asks to run them.

## Hosted MCP Auth Boundary

The hosted MCP service is an OAuth protected resource. Unauthenticated `/mcp` requests return a
`WWW-Authenticate` challenge pointing to protected-resource metadata, and authenticated requests
must use a dashboard-issued MCP access token with the `tweetapi:read` scope and
`https://mcp.tweetapi.com/mcp` audience.

The hosted MCP service never forwards MCP bearer tokens to TwitAPI. It validates issuer, audience,
expiry, and scope, then calls the dashboard internal grant resolver to obtain the backing TweetAPI
API key. Live tools forward exactly one request to the existing TweetAPI REST API with `X-API-Key`.

The existing API remains responsible for API-key validation, quota, billing, rate limits, usage
logs, and subscription checks. The hosted MCP service does not store customer keys and does not
implement account linking, billing, or usage-management tools.

Hosted MCP rejects missing, expired, wrong-audience, or wrong-scope bearer tokens before any tool is
listed or called. The Node service rate limits `/mcp` requests per client and applies a stricter
limiter to missing or invalid auth. Clients are bucketed by the `CF-Connecting-IP` header that
Cloudflare sets (`MCP_CLIENT_IP_HEADER`), falling back to the socket address. The header is used
only for rate-limit buckets, never for auth. A request that bypasses the edge can spoof it, which
only spreads its traffic across buckets; a global limiter (`MCP_GLOBAL_RATE_LIMIT_PER_MINUTE`) caps
total traffic and the number of tracked clients is bounded. The app does not trust
`X-Forwarded-For`, and the fronting proxy or edge provider should still enforce real per-client IP
throttling.

Raw TweetAPI API keys are rejected as hosted MCP bearer tokens. Hosted clients must use
dashboard-issued MCP OAuth tokens.

## Tool Boundary

Hosted MCP live tools are limited to public read-only customer endpoints. They do not expose
internal routes, hidden endpoints, posting, DMs, follows, profile edits, Twitter/X `authToken`,
`ct0`, proxy credentials, passwords, cookies, billing, account-management tools, or write actions.

Authenticated account tools or write-action tools need a separate scoped auth design with scopes,
revocation, audit logging, quota visibility, redaction behavior, and explicit user confirmations.
