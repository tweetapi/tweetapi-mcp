# Client Verification

What local tests prove about client connections, and what still needs a person with a real client
and a real TweetAPI account. Local tests use mocked grant resolvers and a mocked TweetAPI API, so
they say nothing about production OAuth configuration, the dashboard's refresh-token flow, proxy
behavior, or how a given client renders results.

## Covered By Local Tests

| Behavior                                                                                                                                                             | Where                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Protected-resource metadata and the `WWW-Authenticate` challenge on unauthenticated `/mcp`                                                                           | `src/hosted.test.ts`                             |
| `initialize`, server instructions, `tools/list` with output schemas, over Streamable HTTP                                                                            | `src/hosted.test.ts`, `src/http-smoke.ts`        |
| Expired, wrong-audience, wrong-issuer, bad-signature, missing-grant, and missing-scope tokens rejected before any key lookup                                         | `src/hosted.test.ts`                             |
| Grant re-checked on every request: a refreshed token for the same grant works, and a revoked grant fails on the next request with `401`                              | `src/hosted.test.ts`                             |
| Grant resolver down, erroring, or returning a bad key gives `503` without an OAuth challenge                                                                         | `src/hosted.test.ts`                             |
| Raw TweetAPI keys rejected as bearer tokens                                                                                                                          | `src/hosted.test.ts`                             |
| A TweetAPI `401` after a valid grant is a tool error (`layer: tweetapi_api_key`), not an HTTP `401`, and does not leak the key                                       | `src/hosted.test.ts`, `src/live.test.ts`         |
| `429` reasons (`RATE_LIMITED`, `QUOTA_EXHAUSTED`, `SUBSCRIPTION_INACTIVE`), `Retry-After`, `5xx`, `404`, timeouts, and network failures                              | `src/live.test.ts`                               |
| One upstream request per live tool call, no retries                                                                                                                  | `src/live.test.ts`                               |
| Structured output passes the MCP SDK's own output-schema validation for every compact-capable tool and for metrics, whose catalog entry matches its `metrics` output | `src/server.test.ts`                             |
| Local stdio startup                                                                                                                                                  | `src/server.test.ts`, `scripts/check-release.py` |

## Not Verified For This Release

Nobody has run these clients against the hosted server with this release. Do not claim they work
until each row is checked.

| Client                     | Setup source                                        | Status for this release |
| -------------------------- | --------------------------------------------------- | ----------------------- |
| Claude Code                | `claude mcp add` + `claude mcp login` (public docs) | Not re-verified         |
| Codex CLI                  | `codex mcp add` + `codex mcp login` (public docs)   | Not re-verified         |
| Cursor                     | `~/.cursor/mcp.json` (public docs)                  | Not re-verified         |
| Claude.ai / Claude Desktop | Custom connector with the server URL                | Never verified          |
| ChatGPT                    | Connector / developer mode                          | Never verified          |

## Manual Check For Each Client

Use a test TweetAPI account with a small balance. Each live call below costs at most 1 unit, and the
usage check is free.

1. Add the server and sign in. Confirm the browser opens the TweetAPI authorization page, the API
   key picker appears, and the client reports a connected server.
2. Ask the client to list TweetAPI tools. Confirm `tweetapi_account_usage` is present.
3. Ask it to call `tweetapi_account_usage`. Confirm the units match the dashboard and the result
   shows `cost.estimatedUnits: 0`.
4. Ask it to fetch a profile from a link, such as `https://x.com/jack`, with
   `responseFormat: "compact"`. Confirm one call, `resolvedInput.username.source: "link"`, and
   `output.format: "compact"`.
5. Ask it to fetch post details from a post link. Confirm the post text is complete and the `url`,
   `createdAt`, and `retrievedAt` fields are present.
6. Note whether the client shows `structuredContent`, the text block, or both. Both carry the same
   JSON.
7. Refresh: leave the client idle past the access-token lifetime, then call a tool again. It should
   refresh silently or ask to sign in again, not fail permanently.
8. Revoke: remove the connection in the dashboard at `/dashboard/mcp`, then call a tool. Expect an
   OAuth failure and a prompt to sign in again.
9. Key problem: back a connection with a key that has no plan or balance and call a live tool.
   Expect a tool error saying MCP sign-in worked but the key was not accepted, and no sign-in loop.

Record the client version, date, and result in the table above when a row is checked.
