import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveToolDefinitions, LIVE_TOOL_ENDPOINTS, resolveTweetApiBaseUrl } from "./live.js";

function parseToolJson(result: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("live TweetAPI tool definitions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("only exposes the public read-only allowlist", () => {
    const names = LIVE_TOOL_ENDPOINTS.map((tool) => tool.name);
    const paths = LIVE_TOOL_ENDPOINTS.map((tool) => tool.path);

    expect(names).toHaveLength(33);
    expect(names).toEqual([
      "tweetapi_user_by_username",
      "tweetapi_user_by_usernames",
      "tweetapi_user_by_id",
      "tweetapi_user_by_ids",
      "tweetapi_user_about_account",
      "tweetapi_user_followers_v2",
      "tweetapi_user_following_v2",
      "tweetapi_user_verified_followers",
      "tweetapi_user_subscriptions",
      "tweetapi_user_tweets",
      "tweetapi_user_tweets_and_replies",
      "tweetapi_user_followers_ids",
      "tweetapi_user_following_ids",
      "tweetapi_user_followers_list",
      "tweetapi_user_following_list",
      "tweetapi_user_check_follow",
      "tweetapi_search",
      "tweetapi_tweet_details",
      "tweetapi_tweet_metrics",
      "tweetapi_tweet_details_by_ids",
      "tweetapi_tweet_quotes",
      "tweetapi_tweet_retweets",
      "tweetapi_tweet_translate",
      "tweetapi_list_details",
      "tweetapi_list_tweets",
      "tweetapi_list_members",
      "tweetapi_list_followers",
      "tweetapi_community_details",
      "tweetapi_community_tweets",
      "tweetapi_community_members",
      "tweetapi_community_search",
      "tweetapi_space_by_id",
      "tweetapi_space_stream_url",
    ]);
    expect(paths.some((path) => path.includes("/internal/"))).toBe(false);
    expect(paths.some((path) => path.includes("/auth/"))).toBe(false);
    expect(paths.some((path) => path.includes("/interaction/"))).toBe(false);
    expect(paths.some((path) => path.includes("/profile/"))).toBe(false);
    expect(paths.some((path) => path.includes("/xchat/"))).toBe(false);
    expect(paths.some((path) => path.includes("/tweet/create"))).toBe(false);
    expect(paths.some((path) => path.includes("/follow-user"))).toBe(false);
  });

  it("accepts batches of up to 100 users, matching the TweetAPI batch limit", () => {
    const ids = (size: number) => Array.from({ length: size }, (_, index) => String(index + 1));
    const names = (size: number) => Array.from({ length: size }, (_, index) => `user${index}`);
    const schemaFor = (name: string, field: string) => {
      const endpoint = LIVE_TOOL_ENDPOINTS.find((candidate) => candidate.name === name);
      if (!endpoint) throw new Error(`Missing live tool ${name}`);
      return endpoint.inputSchema[field];
    };

    for (const [name, field, values] of [
      ["tweetapi_user_by_ids", "userIds", ids],
      ["tweetapi_user_by_usernames", "usernames", names],
    ] as const) {
      const schema = schemaFor(name, field);
      expect(schema.safeParse(values(100)).success).toBe(true);
      expect(schema.safeParse(values(101)).success).toBe(false);
    }
  });

  it("does not expose account-secret input fields", () => {
    const forbidden = new Set(["authToken", "ct0", "proxy", "password", "cookie", "cookies"]);

    for (const endpoint of LIVE_TOOL_ENDPOINTS) {
      for (const field of Object.keys(endpoint.inputSchema)) {
        expect(forbidden.has(field)).toBe(false);
      }
    }
  });

  it("returns a structured error when a live tool lacks an API key", async () => {
    const tool = createLiveToolDefinitions({}).find(
      (candidate) => candidate.name === "tweetapi_search"
    );

    if (!tool) {
      throw new Error("tool not found");
    }

    const result = await tool.handler({ query: "tweetapi", type: "Latest" });
    const body = parseToolJson(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: "MISSING_TWEETAPI_API_KEY",
      },
    });
  });

  it("forwards a GET tool as exactly one REST request with X-API-Key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "1", text: "hello" }],
            pagination: { nextCursor: "next", prevCursor: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const tool = createLiveToolDefinitions({
      apiKey: "YOUR_API_KEY",
      apiBaseUrl: "https://api.example.test",
      fetch: fetchMock,
    }).find((candidate) => candidate.name === "tweetapi_search");

    if (!tool) {
      throw new Error("tool not found");
    }

    const result = await tool.handler({
      query: "tweetapi",
      type: "Latest",
      cursor: "cursor-1",
    });
    const body = parseToolJson(result);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.example.test/tw-v2/search?query=tweetapi&type=Latest&cursor=cursor-1"
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      "X-API-Key": "YOUR_API_KEY",
      "X-TweetAPI-Client": "hosted-mcp",
    });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      tool: "tweetapi_search",
      mode: "hosted-read-only",
      endpoint: {
        method: "GET",
        path: "/tw-v2/search",
      },
      statusCode: 200,
      pagination: { nextCursor: "next", prevCursor: null },
    });
  });

  it("returns compact tweet metrics with exactly one tweet details request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              tweet: {
                id: "123",
                text: "hello from tweetapi",
                author: {
                  id: "456",
                  username: "tweetapi",
                  name: "TweetAPI",
                  verified: true,
                  isBlueVerified: false,
                },
                createdAt: "2026-07-01T00:00:00.000Z",
                type: "tweet",
                lang: "en",
                likeCount: 10,
                retweetCount: 2,
                replyCount: 3,
                quoteCount: 4,
                bookmarkCount: 5,
                viewCount: 100,
                media: [{ type: "photo" }],
              },
              replies: [{ id: "reply-1", text: "bulky reply payload" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const tool = createLiveToolDefinitions({
      apiKey: "YOUR_API_KEY",
      apiBaseUrl: "https://api.example.test",
      fetch: fetchMock,
    }).find((candidate) => candidate.name === "tweetapi_tweet_metrics");

    if (!tool) {
      throw new Error("tool not found");
    }

    const result = await tool.handler({ tweetId: "123" });
    const body = parseToolJson(result);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/tw-v2/tweet/details?tweetId=123");
    expect(init.method).toBe("GET");
    expect(body).toMatchObject({
      tool: "tweetapi_tweet_metrics",
      endpoint: {
        method: "GET",
        path: "/tw-v2/tweet/details",
      },
      statusCode: 200,
      result: {
        tweet: {
          id: "123",
          textPreview: "hello from tweetapi",
          author: {
            id: "456",
            username: "tweetapi",
            name: "TweetAPI",
            verified: true,
            isBlueVerified: false,
          },
          createdAt: "2026-07-01T00:00:00.000Z",
          type: "tweet",
          lang: "en",
        },
        engagement: {
          likeCount: 10,
          retweetCount: 2,
          replyCount: 3,
          quoteCount: 4,
          bookmarkCount: 5,
          viewCount: 100,
        },
        context: {
          isReply: false,
          isQuote: false,
          isRetweet: false,
          hasMedia: true,
        },
      },
    });
    expect(body).not.toHaveProperty("pagination");
    expect(JSON.stringify(body)).not.toContain("reply-1");
    expect(JSON.stringify(body)).not.toContain("bulky reply payload");
  });

  it("forwards a POST read-only tool with a JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "bonjour" })));
    const tool = createLiveToolDefinitions({
      apiKey: "YOUR_API_KEY",
      apiBaseUrl: "https://api.example.test/",
      fetch: fetchMock,
    }).find((candidate) => candidate.name === "tweetapi_tweet_translate");

    if (!tool) {
      throw new Error("tool not found");
    }

    await tool.handler({ tweetId: "123", dstLang: "fr" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/tw-v2/tweet/translate");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-API-Key": "YOUR_API_KEY",
    });
    expect(init.body).toBe(JSON.stringify({ tweetId: "123", dstLang: "fr" }));
  });

  it("maps TweetAPI status errors into MCP tool errors", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 })
    );
    const tool = createLiveToolDefinitions({
      apiKey: "YOUR_API_KEY",
      fetch: fetchMock,
    }).find((candidate) => candidate.name === "tweetapi_user_by_username");

    if (!tool) {
      throw new Error("tool not found");
    }

    const result = await tool.handler({ username: "tweetapi" });
    const body = parseToolJson(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: "TWEETAPI_RATE_LIMITED",
        details: {
          statusCode: 429,
          endpoint: {
            method: "GET",
            path: "/tw-v2/user/by-username",
          },
        },
      },
    });
  });

  it("returns a structured timeout error for slow upstream requests", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const tool = createLiveToolDefinitions({
      apiKey: "YOUR_API_KEY",
      fetch: fetchMock,
      fetchTimeoutMs: 1,
    }).find((candidate) => candidate.name === "tweetapi_user_by_username");

    if (!tool) {
      throw new Error("tool not found");
    }

    const result = await tool.handler({ username: "tweetapi" });
    const body = parseToolJson(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: "TWEETAPI_UPSTREAM_TIMEOUT",
        details: {
          endpoint: {
            method: "GET",
            path: "/tw-v2/user/by-username",
          },
        },
      },
    });
  });

  it("only allows the production API base URL when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(resolveTweetApiBaseUrl("https://api.tweetapi.com")).toBe("https://api.tweetapi.com/");
    expect(() => resolveTweetApiBaseUrl("https://api.example.test")).toThrow(
      "Invalid TWEETAPI_API_BASE_URL"
    );
  });

  it("allows mocked API base URLs outside production", () => {
    vi.stubEnv("NODE_ENV", "test");

    expect(resolveTweetApiBaseUrl("https://api.example.test")).toBe("https://api.example.test/");
  });
});
