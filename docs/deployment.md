# Deployment

TweetAPI MCP runs as a separate hosted service. Do not deploy it inside the dashboard app or the
core TweetAPI REST API app.

## Production Shape

- Public URL: `https://mcp.tweetapi.com/mcp`
- Transport: stateless Streamable HTTP
- Service command: `node dist/http-bin.js`
- Container port: `3100`
- Health check: `GET /healthz`
- MCP endpoint: `POST /mcp`
- Protected-resource metadata: `GET /.well-known/oauth-protected-resource/mcp`

Unauthenticated `/mcp` requests return an OAuth bearer challenge. Authenticated `GET /mcp` and
`DELETE /mcp` return method-not-allowed responses because v1 does not keep server sessions.

## Environment

```env
PORT=3100
TWEETAPI_API_BASE_URL=https://api.tweetapi.com
MCP_ALLOWED_HOSTS=mcp.tweetapi.com
MCP_MAX_BODY_BYTES=1048576
MCP_RATE_LIMIT_PER_MINUTE=300
MCP_INVALID_AUTH_RATE_LIMIT_PER_MINUTE=30
MCP_GLOBAL_RATE_LIMIT_PER_MINUTE=3000
MCP_CLIENT_IP_HEADER=cf-connecting-ip
MCP_AUTH_ISSUER=https://tweetapi.com
MCP_RESOURCE=https://mcp.tweetapi.com/mcp
MCP_DASHBOARD_RESOLVE_URL=https://tweetapi.com/api/internal/mcp/resolve
MCP_DASHBOARD_INTERNAL_TOKEN=change_me
MCP_OAUTH_JWT_SECRET=change_me
MCP_AUTH_RESOLVE_TIMEOUT_MS=5000
MCP_AUTH_RESOLVER_FALLBACK_MS=300000
MCP_LIVE_FETCH_TIMEOUT_MS=15000
MCP_DOCS_FETCH_TIMEOUT_MS=8000
```

Every authenticated request asks the dashboard whether its grant is still active. If the dashboard
can't answer (a network error or a 5xx, as during a dashboard deploy), the service reuses that
grant's last successful check when it is newer than `MCP_AUTH_RESOLVER_FALLBACK_MS` (5 minutes by
default). A grant the dashboard reported as inactive is never reused.

Use placeholder values only in docs and examples. Do not put production API keys in this repo.

## Coolify Docker Deployment

Use Dockerfile mode in Coolify:

```text
Build pack: Dockerfile
Dockerfile path: Dockerfile
Port exposes: 3100
Health check path: /healthz
```

Coolify should provide production environment variables. Do not bake TweetAPI keys or customer API
keys into the image.

`MCP_DASHBOARD_INTERNAL_TOKEN` and `MCP_OAUTH_JWT_SECRET` must match the dashboard deployment.
Rotate both through the dashboard and MCP service deploy environments, not source control.

## Reverse Proxy

Configure `mcp.tweetapi.com` to proxy HTTPS traffic to the MCP service port. Keep normal short HTTP
timeouts; tool calls forward one REST request and do not hold long server-side sessions.

Force plain HTTP requests for `mcp.tweetapi.com` to HTTPS at the Coolify/fronting proxy or edge
provider with a permanent redirect (`301` or `308`). The Node MCP service is normally reached only
after TLS termination, so the redirect belongs at the proxy/edge layer.

The MCP service validates Host headers against `MCP_ALLOWED_HOSTS`, so include the public hostname
used by the reverse proxy.

The Node service does not trust `X-Forwarded-For` for app-level rate limiting. The per-client limits
(`MCP_RATE_LIMIT_PER_MINUTE` and `MCP_INVALID_AUTH_RATE_LIMIT_PER_MINUTE`) are bucketed by
`MCP_CLIENT_IP_HEADER`, which defaults to `cf-connecting-ip` because production sits behind
Cloudflare. Without that header every request would share the proxy's socket address and one busy
client could block everyone. Set it to `none` when the service is not behind Cloudflare.
`MCP_GLOBAL_RATE_LIMIT_PER_MINUTE` caps total traffic across all clients.

Also add a per-IP rate-limiting rule for `mcp.tweetapi.com` at the edge (for example a Cloudflare
rate-limiting rule on `/mcp`), and make sure the proxy overwrites or strips any incoming
`X-Forwarded-For` header before proxying to this service. The in-process limiter is a last-resort
protection layer for `/mcp`.

In production, `TWEETAPI_API_BASE_URL` must be exactly `https://api.tweetapi.com`. Staging and local
tests may override it only outside `NODE_ENV=production`.

## Validation Before Deploy

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check:release
```

The release check runs a local hosted HTTP smoke test and does not call live TweetAPI APIs.

## Local Docker Test

```bash
docker build -t tweetapi-mcp .
docker run --rm -p 3100:3100 -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 tweetapi-mcp
curl http://localhost:3100/healthz
```
