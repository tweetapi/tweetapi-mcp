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

The hosted MCP service never forwards MCP bearer tokens to the TweetAPI API. It validates issuer,
audience, expiry, and scope, then calls the dashboard internal grant resolver to obtain the backing
TweetAPI API key. Live tools forward exactly one request to the existing TweetAPI REST API with
`X-API-Key`.

The existing API remains responsible for API-key validation, quota, billing, rate limits, usage
logs, and subscription checks. The hosted MCP service does not store customer keys and does not
implement account linking, billing changes, or usage-management tools. The one account tool,
`tweetapi_account_usage`, is a free read-only `GET /tw-v2/account/usage` for the API key behind the
current grant. It takes no inputs, so it cannot name another key or user.

Hosted MCP rejects missing, expired, wrong-audience, or wrong-scope bearer tokens before any tool is
listed or called. The Node service rate limits `/mcp` requests per client and applies a stricter
limiter to missing or invalid auth. Clients are bucketed by the `CF-Connecting-IP` header that
Cloudflare sets (`MCP_CLIENT_IP_HEADER`), falling back to the socket address. The header is used
only for rate-limit buckets, never for auth. A request that bypasses the edge can spoof it, which
only spreads its traffic across buckets. A global limiter (`MCP_GLOBAL_RATE_LIMIT_PER_MINUTE`) caps
total traffic from requests whose token passes the local signature, expiry, issuer, audience, and
scope checks. It is checked before the dashboard grant lookup, and requests without a valid token do
not count toward it, so they cannot use it up and lock out customers. The number of tracked clients
is bounded. The app does not trust `X-Forwarded-For`, and the fronting proxy or edge provider should
still enforce real per-client IP throttling.

Raw TweetAPI API keys are rejected as hosted MCP bearer tokens. Hosted clients must use
dashboard-issued MCP OAuth tokens.

## Tool Boundary

Hosted MCP live tools are limited to public read-only customer endpoints plus the read-only usage
check above. They do not expose internal routes, hidden endpoints, posting, DMs, follows, profile
edits, Twitter/X `authToken`, `ct0`, proxy credentials, passwords, cookies, billing changes,
account-management tools, or write actions.

Live handlers forward only declared input fields, and they never fetch a URL from tool input. Post,
profile, list, community, and Space links are parsed locally: only `x.com` and `twitter.com` hosts
(with `www.` or `mobile.`) are accepted, links with credentials or a port are rejected, and the path
must name the object type the tool expects. Tools that take a numeric user ID do not look up
usernames, because that would need a second billed request.

Two limits keep one oversized request from using up server memory while it is validated
(CVE-2026-111768):

- One tool call's arguments may contain at most 1,000 array elements and object keys in total
  (`MAX_TOOL_INPUT_ELEMENTS` in `src/server.ts`). The SDK counts them before schema validation and
  returns a tool error over the limit. The largest real input, 200 post IDs, is about 205.
- A whole hosted `/mcp` request may contain at most 2,000 (`MAX_REQUEST_ELEMENTS` in
  `src/hosted.ts`), counted after authentication and before the SDK sees the body. This covers every
  method and batch, such as `prompts/get` arguments and `initialize` client info, which the tool
  limit does not. Requests over it get `413`.

Request bodies are capped separately by `MCP_MAX_BODY_BYTES`.

## Errors Across The Two Auth Layers

- MCP OAuth problems (missing, expired, wrong-audience, wrong-scope, or revoked grants) fail the
  HTTP request with `401` or `403` and a `WWW-Authenticate` challenge, so clients can refresh or
  sign in again. Resolver outages return `503` without a challenge.
- TweetAPI API key problems after a valid grant (`401`/`403` from TweetAPI) come back as tool
  results with `isError: true` and `details.layer: "tweetapi_api_key"`. They must not trigger an
  OAuth challenge, because signing in again with the same key would not fix them.
- Tool error details never include the resolved API key.

Authenticated account tools or write-action tools need a separate scoped auth design with scopes,
revocation, audit logging, quota visibility, redaction behavior, and explicit user confirmations.
