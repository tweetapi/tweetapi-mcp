# Roadmap

## Implemented: Hosted Read-Only MCP

- Serve stateless Streamable HTTP MCP at `https://mcp.tweetapi.com/mcp`.
- Protect hosted HTTP MCP with dashboard-issued MCP grant tokens.
- Forward live tools to the existing `/tw-v2` API so quota, billing, and usage logs remain
  authoritative.
- Limit live tools to public customer-facing read-only endpoints.
- Keep each live tool call to one upstream API request with no auto-pagination.
- Require dashboard-issued MCP OAuth tokens for hosted MCP access.

## Dashboard Docs Handoff

- Customer-facing agent setup docs belong in the TweetAPI dashboard/docs repo.
- The dashboard docs should explain when to use the hosted MCP, when to use SDKs, and how to keep
  API keys server-side.
- Standalone skill content lives in dashboard docs and the agent-skill repo as guidance for coding
  agents, not in this service repo.

## Future: Scoped Authenticated MCP

- Add account-secret vaulting and proxy assignment only after the read-only dashboard grant flow is
  stable.
- Define separate scopes, revocation, audit logging, quota visibility, redaction behavior, and
  explicit user confirmations before implementing posting, DMs, follows, profile edits, or other
  write actions.
