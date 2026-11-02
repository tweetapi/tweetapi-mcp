import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCS_SOURCES, TweetApiDocsService } from "./docs.js";
import {
  createFixedWindowRateLimiter,
  createHostedMcpHttpServer,
  GLAMA_OWNERSHIP_PATH,
  parseAllowedHosts,
} from "./hosted.js";
import { LIVE_TOOL_ENDPOINTS } from "./live.js";
import {
  DEFAULT_MCP_AUTH_ISSUER,
  DEFAULT_MCP_RESOURCE,
  DEFAULT_PROTECTED_RESOURCE_METADATA_PATH,
  REQUIRED_MCP_SCOPE,
  signMcpAccessTokenForTesting,
} from "./mcp-auth.js";
import { MAX_TOOL_INPUT_ELEMENTS } from "./server.js";

const TEST_JWT_SECRET = "test-mcp-oauth-secret";
const TEST_INTERNAL_TOKEN = "test-dashboard-internal-token";
const TEST_RESOLVED_API_KEY = "sk_RESOLVED_TEST_KEY";

function response(body: string): Response {
  return new Response(body);
}

async function listen(options: Parameters<typeof createHostedMcpHttpServer>[0] = {}) {
  const server = createHostedMcpHttpServer({
    allowedHosts: ["127.0.0.1", "localhost"],
    ...options,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectClient(url: URL, headers?: Record<string, string>) {
  const client = new Client({ name: "tweetapi-hosted-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined,
  });

  await client.connect(transport);

  return client;
}

async function postMcp(
  url: URL,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }
) {
  const result = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: result.status,
    headers: result.headers,
    text: await result.text(),
  };
}

function makeAccessToken(
  overrides: Record<string, unknown> = {},
  secret: string = TEST_JWT_SECRET
) {
  const now = Math.floor(Date.now() / 1000);

  return signMcpAccessTokenForTesting(
    {
      iss: DEFAULT_MCP_AUTH_ISSUER,
      sub: "user_1",
      aud: DEFAULT_MCP_RESOURCE,
      scope: `${REQUIRED_MCP_SCOPE} offline_access`,
      grant_id: "grant_1",
      iat: now,
      exp: now + 900,
      ...overrides,
    },
    secret
  );
}

function authHeaders(token = makeAccessToken()) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function createGrantResolver(apiKey = TEST_RESOLVED_API_KEY) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://tweetapi.com/api/internal/mcp/resolve");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
      "Content-Type": "application/json",
    });

    return new Response(
      JSON.stringify({
        apiKey,
        grantId: "grant_1",
        userId: "user_1",
        scopes: [REQUIRED_MCP_SCOPE],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  });
}

function protectedOptions(options: Parameters<typeof createHostedMcpHttpServer>[0] = {}) {
  return {
    oauthJwtSecret: TEST_JWT_SECRET,
    dashboardInternalToken: TEST_INTERNAL_TOKEN,
    authFetch: createGrantResolver(),
    ...options,
  };
}

function parseMcpResponseText(text: string) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text) as {
      result?: { content?: Array<{ type: "text"; text: string }>; isError?: boolean };
    };
  }

  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  return JSON.parse(dataLine ?? "{}") as {
    result?: { content?: Array<{ type: "text"; text: string }>; isError?: boolean };
  };
}

describe("hosted MCP HTTP server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses allowed hosts with production-safe defaults", () => {
    expect(parseAllowedHosts(undefined)).toContain("mcp.tweetapi.com");
    expect(parseAllowedHosts("mcp.tweetapi.com,localhost")).toEqual([
      "mcp.tweetapi.com",
      "localhost",
    ]);
  });

  it("serves health checks", async () => {
    const app = await listen();

    try {
      const healthUrl = new URL("/healthz", app.url);
      const result = await fetch(healthUrl);

      expect(result.status).toBe(200);
      expect(result.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains"
      );
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
      expect(result.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      await expect(result.json()).resolves.toMatchObject({
        ok: true,
        service: "tweetapi-mcp",
      });
    } finally {
      await app.close();
    }
  });

  it("serves OAuth protected resource metadata", async () => {
    const app = await listen();

    try {
      const metadataUrl = new URL(DEFAULT_PROTECTED_RESOURCE_METADATA_PATH, app.url);
      const result = await fetch(metadataUrl);
      const body = await result.json();

      expect(result.status).toBe(200);
      expect(result.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains"
      );
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
      expect(result.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(body).toMatchObject({
        resource: DEFAULT_MCP_RESOURCE,
        authorization_servers: [DEFAULT_MCP_AUTH_ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: [REQUIRED_MCP_SCOPE, "offline_access"],
      });
    } finally {
      await app.close();
    }
  });

  it("serves Glama connector ownership metadata", async () => {
    const app = await listen();

    try {
      const ownershipUrl = new URL(GLAMA_OWNERSHIP_PATH, app.url);
      const result = await fetch(ownershipUrl);

      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toContain("application/json");
      expect(result.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains"
      );
      await expect(result.json()).resolves.toEqual({
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        maintainers: [{ email: "support@tweetapi.com" }],
      });
    } finally {
      await app.close();
    }
  });

  it("returns an OAuth challenge without Authorization", async () => {
    const app = await listen();

    try {
      const result = await postMcp(app.url);

      expect(result.status).toBe(401);
      expect(result.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains"
      );
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
      expect(result.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(result.headers.get("www-authenticate")).toContain("Bearer");
      expect(result.headers.get("www-authenticate")).toContain(
        `resource_metadata="https://mcp.tweetapi.com${DEFAULT_PROTECTED_RESOURCE_METADATA_PATH}"`
      );
    } finally {
      await app.close();
    }
  });

  it("lists docs and live tools with a dashboard-backed MCP access token", async () => {
    const authFetch = createGrantResolver();
    const app = await listen(protectedOptions({ authFetch }));
    const client = await connectClient(app.url, authHeaders());

    try {
      const tools = await client.listTools();
      const resources = await client.listResources();

      expect(tools.tools.map((tool) => tool.name)).toContain("tweetapi_docs_search");
      expect(tools.tools.map((tool) => tool.name)).toContain("tweetapi_search");
      expect(resources.resources.map((resource) => resource.uri)).toContain("tweetapi://docs/llms");
      expect(authFetch).toHaveBeenCalled();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("applies the all-request MCP limiter even with valid MCP token auth", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 1,
        invalidAuthRateLimit: 10,
      })
    );

    try {
      const first = await postMcp(app.url, authHeaders());
      const second = await postMcp(app.url, authHeaders());

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("applies a stricter limiter to missing and invalid-looking auth", async () => {
    const app = await listen({
      rateLimit: 10,
      invalidAuthRateLimit: 1,
    });

    try {
      const first = await postMcp(app.url);
      const second = await postMcp(app.url, { Authorization: "Bearer bad" });

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("does not trust X-Forwarded-For for app-level rate limiting", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 1,
        invalidAuthRateLimit: 10,
      })
    );

    try {
      const first = await postMcp(app.url, {
        ...authHeaders(),
        "X-Forwarded-For": "198.51.100.1",
      });
      const second = await postMcp(app.url, {
        ...authHeaders(),
        "X-Forwarded-For": "198.51.100.2",
      });

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("keys request limits on CF-Connecting-IP so one client cannot block others", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 1,
        invalidAuthRateLimit: 10,
      })
    );

    try {
      const first = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.1",
      });
      const otherClient = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.2",
      });
      const repeat = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.1",
      });

      expect(first.status).not.toBe(429);
      expect(otherClient.status).not.toBe(429);
      expect(repeat.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("falls back to the socket address when the client IP header is not an IP", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 1,
        invalidAuthRateLimit: 10,
      })
    );

    try {
      const first = await postMcp(app.url, { ...authHeaders(), "CF-Connecting-IP": "not-an-ip" });
      const second = await postMcp(app.url, { ...authHeaders(), "CF-Connecting-IP": "also-bad" });

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("ignores CF-Connecting-IP when the client IP header is turned off", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 1,
        invalidAuthRateLimit: 10,
        clientIpHeader: null,
      })
    );

    try {
      const first = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.1",
      });
      const second = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.2",
      });

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("caps total MCP traffic with the global limiter", async () => {
    const app = await listen(
      protectedOptions({
        rateLimit: 10,
        invalidAuthRateLimit: 10,
        globalRateLimit: 1,
      })
    );

    try {
      const first = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.1",
      });
      const second = await postMcp(app.url, {
        ...authHeaders(),
        "CF-Connecting-IP": "198.51.100.2",
      });

      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("bounds the number of tracked rate-limit keys and reclaims expired ones", async () => {
    const limiter = createFixedWindowRateLimiter(5, 20, 2);

    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(false);
    expect(limiter.allow("a")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(limiter.allow("c")).toBe(true);
  });

  it("calls docs tools with a dashboard-backed MCP access token", async () => {
    const docsService = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(
          String(url) === DOCS_SOURCES.aiDocsV2
            ? "# Search\n\nGET /tw-v2/search accepts query and type."
            : "# TweetAPI\n\nTweetAPI public summary."
        )
      ),
      () => 1_000
    );
    const app = await listen(protectedOptions({ docsService }));
    const client = await connectClient(app.url, authHeaders());

    try {
      const result = await client.callTool({
        name: "tweetapi_docs_search",
        arguments: { query: "search", limit: 1 },
      });
      const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");

      expect(result.isError).toBeUndefined();
      expect(body.matches[0]).toMatchObject({
        sourceUrl: DOCS_SOURCES.aiDocsV2,
      });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("rejects MCP access tokens without the read scope", async () => {
    const app = await listen(protectedOptions());

    try {
      const result = await postMcp(
        app.url,
        authHeaders(makeAccessToken({ scope: "offline_access" }))
      );
      const body = JSON.parse(result.text);

      expect(result.status).toBe(403);
      expect(result.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(body.error.message).toContain(REQUIRED_MCP_SCOPE);
    } finally {
      await app.close();
    }
  });

  it("rejects raw TweetAPI API keys instead of forwarding them to the upstream API", async () => {
    const authFetch = createGrantResolver();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    const app = await listen(
      protectedOptions({
        apiBaseUrl: "https://api.example.test",
        authFetch,
        fetch: fetchMock,
      })
    );

    try {
      const result = await postMcp(
        app.url,
        {
          Authorization: "Bearer sk_YOUR_TEST_KEY",
        },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "tweetapi_search",
            arguments: { query: "tweetapi", type: "Latest" },
          },
        }
      );

      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(authFetch).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("forwards hosted live tools with a resolved dashboard-backed API key", async () => {
    const authFetch = createGrantResolver(TEST_RESOLVED_API_KEY);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "1" }] })));
    const app = await listen(
      protectedOptions({
        apiBaseUrl: "https://api.example.test",
        authFetch,
        fetch: fetchMock,
      })
    );
    const client = await connectClient(app.url, authHeaders());

    try {
      const result = await client.callTool({
        name: "tweetapi_search",
        arguments: { query: "tweetapi", type: "Latest" },
      });
      const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");

      expect(result.isError).toBeUndefined();
      expect(body).toMatchObject({
        tool: "tweetapi_search",
        statusCode: 200,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(
        "https://api.example.test/tw-v2/search?query=tweetapi&type=Latest"
      );
      expect(init.headers).toMatchObject({
        "X-API-Key": TEST_RESOLVED_API_KEY,
        "X-TweetAPI-Client": "hosted-mcp",
      });
      expect(authFetch).toHaveBeenCalled();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("rejects tool arguments over the element limit before schema validation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { tweets: [] } })));
    const app = await listen(
      protectedOptions({ apiBaseUrl: "https://api.example.test", fetch: fetchMock })
    );
    const client = await connectClient(app.url, authHeaders());
    // The `ids` key counts as one element, so 999 IDs is exactly at the limit.
    const atLimit = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS - 1 }, () => "1");
    const overLimit = [...atLimit, "1"];
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      result.content[0]?.type === "text" ? result.content[0].text : "";

    try {
      const rejected = await client.callTool({
        name: "tweetapi_tweet_details_by_ids",
        arguments: { ids: overLimit },
      });
      const validated = await client.callTool({
        name: "tweetapi_tweet_details_by_ids",
        arguments: { ids: atLimit },
      });

      expect(rejected.isError).toBe(true);
      expect(text(rejected)).toContain(
        `arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`
      );
      expect(text(rejected)).not.toContain("Input validation error");
      // At the limit the input reaches schema validation, which caps the batch at 200.
      expect(validated.isError).toBe(true);
      expect(text(validated)).toContain("Input validation error");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("keeps the largest real input, 200 post IDs, within the element limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { tweets: [] } })));
    const app = await listen(
      protectedOptions({ apiBaseUrl: "https://api.example.test", fetch: fetchMock })
    );
    const client = await connectClient(app.url, authHeaders());

    try {
      const result = await client.callTool({
        name: "tweetapi_tweet_details_by_ids",
        arguments: {
          ids: Array.from({ length: 200 }, (_, index) => String(1_000 + index)),
          responseFormat: "compact",
        },
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("logs who was rejected, with the grant of an expired token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = await listen(protectedOptions());

    try {
      const expired = makeAccessToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
      await postMcp(app.url, { "User-Agent": "health-check/1.0" });
      await postMcp(app.url, { ...authHeaders(expired), "User-Agent": 'odd"agent\u00e9' });

      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines[0]).toContain("status=missing");
      expect(lines[0]).toContain('ua="health-check/1.0"');
      expect(lines[0]).not.toContain("grant=");
      expect(lines[1]).toContain("grant=grant_1");
      expect(lines[1]).toContain(`ua="odd'agent?"`);
      expect(lines[1]).toContain("reason=MCP access token is expired.");
    } finally {
      await app.close();
    }
  });

  it("does not trust the grant of a token with a bad signature", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = await listen(protectedOptions());

    try {
      await postMcp(app.url, authHeaders(makeAccessToken({}, "wrong-secret")));

      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("reason=MCP access token is invalid.");
      expect(line).not.toContain("grant=");
    } finally {
      await app.close();
    }
  });

  it("logs the grant when the dashboard reports it inactive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = await listen(
      protectedOptions({ authFetch: vi.fn(async () => new Response("{}", { status: 404 })) })
    );

    try {
      expect((await postMcp(app.url, authHeaders())).status).toBe(401);
      expect(String(warn.mock.calls[0]?.[0])).toContain("grant=grant_1");
    } finally {
      await app.close();
    }
  });

  it("logs each authenticated initialize with its grant and client", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = await listen(protectedOptions());
    const client = await connectClient(app.url, authHeaders());

    try {
      expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringContaining(
          '[mcp] initialize grant=grant_1 client="tweetapi-hosted-test/0.1.0"'
        )
      );
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("serves protocol discovery: initialize, server instructions, and live output schemas", async () => {
    const app = await listen(protectedOptions());
    const client = await connectClient(app.url, authHeaders());

    try {
      expect(client.getServerVersion()).toMatchObject({ name: "tweetapi-mcp" });
      expect(client.getInstructions()).toContain("tweetapi_account_usage");
      const tools = await client.listTools();
      const usage = tools.tools.find((tool) => tool.name === "tweetapi_account_usage");

      expect(usage?.annotations?.readOnlyHint).toBe(true);
      expect(usage?.outputSchema?.properties).toHaveProperty("cost");
      const liveNames = new Set(LIVE_TOOL_ENDPOINTS.map((tool) => tool.name));
      const liveTools = tools.tools.filter((tool) => liveNames.has(tool.name));
      expect(liveTools).toHaveLength(LIVE_TOOL_ENDPOINTS.length);
      expect(liveTools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
    } finally {
      await client.close();
      await app.close();
    }
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }, undefined, "expired"],
    ["wrong audience", { aud: "https://other.example/mcp" }, undefined, "audience"],
    ["wrong issuer", { iss: "https://evil.example" }, undefined, "issuer"],
    ["bad signature", {}, "a-different-secret", "invalid"],
    ["missing grant", { grant_id: undefined }, undefined, "grant"],
  ])(
    "rejects a %s token with an OAuth challenge before resolving a key",
    async (_label, overrides, secret, reason) => {
      const authFetch = createGrantResolver();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
      const app = await listen(
        protectedOptions({ authFetch, fetch: fetchMock, apiBaseUrl: "https://api.example.test" })
      );

      try {
        const result = await postMcp(app.url, authHeaders(makeAccessToken(overrides, secret)));
        const body = JSON.parse(result.text);

        expect(result.status).toBe(401);
        expect(result.headers.get("www-authenticate")).toContain('error="invalid_token"');
        expect(result.headers.get("www-authenticate")).toContain("resource_metadata=");
        expect(body.error.message.toLowerCase()).toContain(reason);
        expect(authFetch).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("re-checks the grant on every request, so a revoked grant fails on the next call", async () => {
    let revoked = false;
    const authFetch = vi.fn(async () =>
      revoked
        ? new Response(JSON.stringify({ message: "MCP grant not found" }), { status: 404 })
        : new Response(JSON.stringify({ apiKey: TEST_RESOLVED_API_KEY }), { status: 200 })
    );
    const app = await listen(protectedOptions({ authFetch }));

    try {
      const before = await postMcp(app.url, authHeaders());
      // A refreshed access token for the same grant works the same way.
      const refreshed = await postMcp(
        app.url,
        authHeaders(makeAccessToken({ iat: Math.floor(Date.now() / 1000) + 1 }))
      );
      revoked = true;
      const after = await postMcp(app.url, authHeaders());

      expect(before.status).toBe(200);
      expect(refreshed.status).toBe(200);
      expect(after.status).toBe(401);
      expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(JSON.parse(after.text).error.message).toBe("MCP grant is not active.");
      expect(authFetch).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["is down", async () => Promise.reject(new TypeError("fetch failed")), "unavailable"],
    ["returns 500", async () => new Response("{}", { status: 500 }), "returned an error"],
    [
      "returns a malformed key",
      async () => new Response(JSON.stringify({ apiKey: "YOUR_MALFORMED_KEY" })),
      "valid backing API key",
    ],
  ])(
    "returns 503 without an OAuth challenge when the grant resolver %s",
    async (_label, resolver, reason) => {
      const app = await listen(protectedOptions({ authFetch: vi.fn(resolver) }));

      try {
        const result = await postMcp(app.url, authHeaders());

        expect(result.status).toBe(503);
        expect(result.headers.get("www-authenticate")).toBeNull();
        expect(JSON.parse(result.text).error.message).toContain(reason);
      } finally {
        await app.close();
      }
    }
  );

  it("reports a rejected TweetAPI key as a tool error, not as an MCP sign-in failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ statusCode: 401, message: "Invalid API key or no limit configured" }),
          { status: 401 }
        )
    );
    const app = await listen(
      protectedOptions({ apiBaseUrl: "https://api.example.test", fetch: fetchMock })
    );

    try {
      const result = await postMcp(app.url, authHeaders(), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tweetapi_account_usage", arguments: {} },
      });
      const payload = parseMcpResponseText(result.text);
      const body = JSON.parse(payload.result?.content?.[0]?.text ?? "{}");

      expect(result.status).toBe(200);
      expect(result.headers.get("www-authenticate")).toBeNull();
      expect(payload.result?.isError).toBe(true);
      expect(body.error).toMatchObject({
        code: "TWEETAPI_AUTH_FAILED",
        details: { layer: "tweetapi_api_key" },
      });
      expect(JSON.stringify(body)).not.toContain(TEST_RESOLVED_API_KEY);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("serves the usage tool and compact results over hosted HTTP with structured content", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/account/usage")
        ? new Response(
            JSON.stringify({ data: { availableUnits: 5, rateLimit: { requestsPerMinute: 10 } } })
          )
        : new Response(
            JSON.stringify({
              data: { id: "12", username: "jack", name: "jack", banner: "b.jpg" },
            })
          )
    );
    const app = await listen(
      protectedOptions({ apiBaseUrl: "https://api.example.test", fetch: fetchMock })
    );
    const client = await connectClient(app.url, authHeaders());

    try {
      const usage = await client.callTool({ name: "tweetapi_account_usage", arguments: {} });
      const profile = await client.callTool({
        name: "tweetapi_user_by_username",
        arguments: { username: "https://x.com/jack", responseFormat: "compact" },
      });

      expect(usage.structuredContent).toMatchObject({
        cost: { estimatedUnits: 0 },
        result: { data: { availableUnits: 5 } },
      });
      expect(profile.structuredContent).toMatchObject({
        resolvedInput: { username: { value: "jack", source: "link" } },
        result: { user: { username: "jack", url: "https://x.com/jack" } },
        output: { format: "compact" },
      });
      expect(JSON.stringify(profile.structuredContent)).not.toContain("b.jpg");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "https://api.example.test/tw-v2/user/by-username?username=jack"
      );
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("rejects non-production API base URLs when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() =>
      createHostedMcpHttpServer({
        apiBaseUrl: "https://api.example.test",
      })
    ).toThrow("Invalid TWEETAPI_API_BASE_URL");
  });
});
