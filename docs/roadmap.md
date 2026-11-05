# Roadmap

## Implemented: Hosted Read-Only MCP

- Serve stateless Streamable HTTP MCP at `https://mcp.tweetapi.com/mcp`.
- Protect hosted HTTP MCP with dashboard-issued MCP grant tokens.
- Forward live tools to the existing `/tw-v2` API so quota, billing, and usage logs remain
  authoritative.
- Limit live tools to public customer-facing read-only endpoints.
- Keep each live tool call to one upstream API request with no auto-pagination.
- Require dashboard-issued MCP OAuth tokens for hosted MCP access.

## Implemented: Results, Usage, Links, And Errors (First Release)

- Optional compact results with an output schema, `retrievedAt`, completeness, omitted-field lists,
  and unit cost estimates on every live result.
- Free `tweetapi_account_usage` tool for the API key behind the current grant.
- Post, profile, list, community, and Space links and `@handles` parsed locally, without extra
  requests.
- Clearer errors that separate MCP OAuth failures from TweetAPI API key, quota, rate-limit, and
  upstream failures, with `Retry-After` when available.
- Remaining real-client checks are tracked in `docs/client-verification.md`.

## Dashboard Docs Handoff

- Customer-facing agent setup docs belong in the TweetAPI dashboard/docs repo.
- The dashboard docs should explain when to use the hosted MCP, when to use SDKs, and how to keep
  API keys server-side.
- Standalone skill content lives in dashboard docs and the agent-skill repo as guidance for coding
  agents, not in this service repo.
