# TweetAPI MCP

MCP server for [TweetAPI](https://tweetapi.com), a third-party Twitter data API. It lets AI agents
read public Twitter data (search, profiles, followers, timelines, lists, communities and Spaces) and
look up TweetAPI's own docs.

TweetAPI is an independent service and is not affiliated with X Corp.

## Hosted server

The easiest way to use it is the hosted server. You sign in with your TweetAPI account and pick
which API key backs the connection. New accounts get 100 free API units and no card is needed.

```text
https://mcp.tweetapi.com/mcp
```

Codex:

```bash
codex mcp add tweetapi --url https://mcp.tweetapi.com/mcp
codex mcp login tweetapi
```

Claude Code:

```bash
claude mcp add --transport http --scope user tweetapi https://mcp.tweetapi.com/mcp
claude mcp login tweetapi
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tweetapi": {
      "url": "https://mcp.tweetapi.com/mcp"
    }
  }
}
```

The hosted server uses Streamable HTTP and OAuth. More setup notes are in the
[agents guide](https://tweetapi.com/docs/getting-started/agents).

## Run it locally

You can also run the server yourself over stdio with an API key from the
[TweetAPI dashboard](https://tweetapi.com/dashboard). Node 18 or newer and pnpm are required.

```bash
git clone https://github.com/tweetapi/tweetapi-mcp.git
cd tweetapi-mcp
pnpm install
pnpm run build
```

Then point your MCP client at it:

```json
{
  "mcpServers": {
    "tweetapi": {
      "command": "node",
      "args": ["/path/to/tweetapi-mcp/dist/bin.js", "--live"],
      "env": {
        "TWEETAPI_API_KEY": "your_tweetapi_key_here"
      }
    }
  }
}
```

Without `--live`, only the docs tools are available and no API key is needed.

## Tools

**Docs** (free, no API calls): `tweetapi_docs_search`, `tweetapi_endpoint_lookup`,
`tweetapi_docs_get_page`, `tweetapi_sdk_guidance`, `tweetapi_tool_catalog`.

**Live data** (33 read-only tools):

- Users: profile by username or ID, batches of up to 100, About this account, tweets, tweets and
  replies, followers and following (profiles or IDs), verified followers, subscriptions, follow
  check.
- Tweets: search, details with replies, metrics only, batches of up to 200 by ID, quotes, retweets,
  translation.
- Lists: details, tweets, members, followers.
- Communities: details, tweets, members, search.
- Spaces: details and audio stream URL.

Each live tool call makes exactly one TweetAPI request and is billed like any other API call. Tools
never paginate on their own; the agent passes the cursor when it wants the next page.

Live tools are read-only. There are no tools for posting, DMs, follows, profile edits, account
cookies or billing.

## Hosted service

This repo is also the source for the service at `mcp.tweetapi.com`. In HTTP mode it accepts
dashboard-issued OAuth tokens with the `tweetapi:read` scope, resolves the backing API key on the
server, and never sends the bearer token upstream. It depends on TweetAPI's OAuth server, so it is
not meant to be self-hosted as is. See [docs/security.md](docs/security.md) and
[docs/deployment.md](docs/deployment.md) for how it works.

```bash
docker build -t tweetapi-mcp .
docker run --rm -p 3100:3100 -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 tweetapi-mcp
curl http://localhost:3100/healthz
```

## Development

```bash
pnpm install
pnpm run check
pnpm run check:release
```

The checks cover formatting, Markdown lint, TypeScript, unit tests, stdio and HTTP smoke tests, and
a secret scan. Tests mock the docs and the API; they never call the live TweetAPI API.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
