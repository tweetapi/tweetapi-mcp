import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveToolDefinitions,
  LIVE_TOOL_ENDPOINTS,
  LIVE_TOOL_OUTPUT_SCHEMA,
  parseRetryAfter,
  resolveTweetApiBaseUrl,
  type LiveToolsOptions,
} from "./live.js";
import { z } from "zod";

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

    expect(names).toHaveLength(47);
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
      "tweetapi_user_photos",
      "tweetapi_user_videos",
      "tweetapi_user_highlights",
      "tweetapi_user_articles",
      "tweetapi_user_affiliates",
      "tweetapi_user_similar_accounts",
      "tweetapi_user_lists",
      "tweetapi_user_list_memberships",
      "tweetapi_search",
      "tweetapi_tweet_details",
      "tweetapi_tweet_metrics",
      "tweetapi_tweet_details_by_ids",
      "tweetapi_tweet_quotes",
      "tweetapi_tweet_retweets",
      "tweetapi_tweet_hidden_replies",
      "tweetapi_tweet_translate",
      "tweetapi_list_details",
      "tweetapi_list_tweets",
      "tweetapi_list_members",
      "tweetapi_list_followers",
      "tweetapi_list_search",
      "tweetapi_community_details",
      "tweetapi_community_tweets",
      "tweetapi_community_media",
      "tweetapi_community_members",
      "tweetapi_community_search",
      "tweetapi_space_by_id",
      "tweetapi_space_stream_url",
      "tweetapi_trends",
      "tweetapi_trend_locations",
      "tweetapi_account_usage",
    ]);
    expect(paths.some((path) => path.includes("/auth/"))).toBe(false);
    expect(paths.some((path) => path.includes("/interaction/"))).toBe(false);
    expect(paths.some((path) => path.includes("/profile/"))).toBe(false);
    expect(paths.some((path) => path.includes("/xchat/"))).toBe(false);
    expect(paths.some((path) => path.includes("/tweet/create"))).toBe(false);
    expect(paths.some((path) => path.includes("/follow-user"))).toBe(false);
    // The only account route is the read-only usage check for the connection's own key.
    expect(paths.filter((path) => path.startsWith("/tw-v2/account"))).toEqual([
      "/tw-v2/account/usage",
    ]);
    expect(
      LIVE_TOOL_ENDPOINTS.every(
        (tool) => tool.method === "GET" || tool.path === "/tw-v2/tweet/translate"
      )
    ).toBe(true);
  });

  it("only uses endpoints the public docs list as read-only without an X login", () => {
    // Every GET or POST in https://tweetapi.com/openapi-v2.json marked x-tweetapi-safety
    // "read-only" with x-tweetapi-requires-twitter-auth false (checked 2026-11-04). A path
    // missing here is not public: it needs docs and review before any tool can use it.
    const documentedPublicReads = new Set([
      "GET /tw-v2/account/usage",
      "GET /tw-v2/community/details",
      "GET /tw-v2/community/media",
      "GET /tw-v2/community/members",
      "GET /tw-v2/community/search",
      "GET /tw-v2/community/tweets",
      "GET /tw-v2/list/details",
      "GET /tw-v2/list/followers",
      "GET /tw-v2/list/members",
      "GET /tw-v2/list/search",
      "GET /tw-v2/list/tweets",
      "GET /tw-v2/search",
      "GET /tw-v2/space/by-id",
      "GET /tw-v2/space/stream-url",
      "GET /tw-v2/trends",
      "GET /tw-v2/trends/locations",
      "GET /tw-v2/tweet/details",
      "GET /tw-v2/tweet/details-by-ids",
      "GET /tw-v2/tweet/hidden-replies",
      "GET /tw-v2/tweet/quotes",
      "GET /tw-v2/tweet/retweets",
      "POST /tw-v2/tweet/translate",
      "GET /tw-v2/user/about-account",
      "GET /tw-v2/user/affiliates",
      "GET /tw-v2/user/articles",
      "GET /tw-v2/user/by-id",
      "GET /tw-v2/user/by-ids",
      "GET /tw-v2/user/by-username",
      "GET /tw-v2/user/by-usernames",
      "GET /tw-v2/user/followers",
      "GET /tw-v2/user/followers-ids",
      "GET /tw-v2/user/followers-list",
      "GET /tw-v2/user/following",
      "GET /tw-v2/user/following-ids",
      "GET /tw-v2/user/following-list",
      "GET /tw-v2/user/friendship",
      "GET /tw-v2/user/highlights",
      "GET /tw-v2/user/list-memberships",
      "GET /tw-v2/user/lists",
      "GET /tw-v2/user/photos",
      "GET /tw-v2/user/similar-accounts",
      "GET /tw-v2/user/subscriptions",
      "GET /tw-v2/user/tweets",
      "GET /tw-v2/user/tweets-and-replies",
      "GET /tw-v2/user/verified-followers",
      "GET /tw-v2/user/videos",
    ]);
    const used = new Set(LIVE_TOOL_ENDPOINTS.map((tool) => `${tool.method} ${tool.path}`));

    expect(documentedPublicReads.size).toBe(46);
    expect([...used].filter((route) => !documentedPublicReads.has(route))).toEqual([]);
    // And each documented public read has a tool.
    expect([...documentedPublicReads].filter((route) => !used.has(route))).toEqual([]);
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

  it("does not expose account-secret or credential input fields", () => {
    const forbidden = new Set([
      "authToken",
      "ct0",
      "proxy",
      "password",
      "cookie",
      "cookies",
      "apiKey",
      "api_key",
      "key",
      "token",
    ]);

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

const LONG_ID = "1985432109876543219";
const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");
const outputSchema = z.object(LIVE_TOOL_OUTPUT_SCHEMA);

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function setup(name: string, response: () => Response, options: Partial<LiveToolsOptions> = {}) {
  const fetchMock = vi.fn(async () => response());
  const tool = createLiveToolDefinitions({
    apiKey: "YOUR_API_KEY",
    apiBaseUrl: "https://api.example.test",
    fetch: fetchMock,
    now: () => FIXED_NOW,
    ...options,
  }).find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }

  return { tool, fetchMock };
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>) {
  return String((fetchMock.mock.calls[0] as [URL, RequestInit])[0]);
}

function sampleTweet(id: string, text = "post text") {
  return {
    id,
    text,
    createdAt: "Mon Oct 27 12:00:00 +0000 2026",
    author: { id: "12", username: "jack", name: "jack", bio: "long bio", banner: "b.jpg" },
    likeCount: 1,
    retweetCount: 0,
    replyCount: 0,
    quoteCount: 0,
    bookmarkCount: 0,
    viewCount: 10,
    editControl: { editTweetIds: [id] },
  };
}

describe("live tool results", () => {
  it("returns identical structured and text content that matches the output schema", async () => {
    const { tool } = setup("tweetapi_search", () =>
      jsonResponse({ data: [sampleTweet("1")], pagination: { nextCursor: "n", prevCursor: null } })
    );

    const result = await tool.handler({ query: "tweetapi", type: "Latest" });

    expect(result.structuredContent).toBeDefined();
    expect(parseToolJson(result as never)).toEqual(
      JSON.parse(JSON.stringify(result.structuredContent))
    );
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(result.structuredContent).toMatchObject({
      retrievedAt: "2026-10-28T12:00:00.000Z",
      pagination: { nextCursor: "n", prevCursor: null },
      completeness: { scope: "page", nextCursor: "n", moreAvailable: true, itemCount: 1 },
      output: { format: "full", fieldsOmitted: [], itemsOmitted: 0, textTruncated: false },
      cost: { basis: "estimate", estimatedUnits: 1 },
    });
  });

  it("keeps full responses unchanged by default and never forwards responseFormat", async () => {
    const upstream = {
      data: [sampleTweet("1")],
      pagination: { nextCursor: null, prevCursor: null },
    };
    const full = setup("tweetapi_user_tweets", () => jsonResponse(upstream));
    const compact = setup("tweetapi_user_tweets", () => jsonResponse(upstream));

    const fullResult = await full.tool.handler({ userId: "12" });
    const compactResult = await compact.tool.handler({ userId: "12", responseFormat: "compact" });

    expect(fullResult.structuredContent?.result).toEqual(upstream);
    expect(requestedUrl(compact.fetchMock)).toBe(
      "https://api.example.test/tw-v2/user/tweets?userId=12"
    );
    expect(compactResult.structuredContent).toMatchObject({
      output: { format: "compact", itemsOmitted: 0, textTruncated: false },
      completeness: { moreAvailable: false, itemCount: 1 },
      result: {
        tweets: [
          {
            id: "1",
            url: "https://x.com/jack/status/1",
            text: "post text",
            createdAt: "Mon Oct 27 12:00:00 +0000 2026",
          },
        ],
      },
    });
    expect(JSON.stringify(compactResult.structuredContent?.result)).not.toContain("long bio");
    expect(outputSchema.safeParse(compactResult.structuredContent).success).toBe(true);
  });

  it("reports the tweet details reply cursor (regression: it used to be dropped)", async () => {
    const { tool } = setup("tweetapi_tweet_details", () =>
      jsonResponse({
        data: { tweet: sampleTweet("1"), ancestors: [], replies: [], nextCursor: "reply-cursor" },
      })
    );

    const result = await tool.handler({ tweetId: "1", sortBy: "Relevance" });

    expect(result.structuredContent).toMatchObject({
      pagination: { nextCursor: "reply-cursor" },
      completeness: { nextCursor: "reply-cursor", moreAvailable: true },
    });
  });

  it("accepts a post link, forwards only the numeric ID, and reports the conversion", async () => {
    const { tool, fetchMock } = setup("tweetapi_tweet_details", () =>
      jsonResponse({ data: { tweet: sampleTweet(LONG_ID), ancestors: [], replies: [] } })
    );

    const result = await tool.handler({
      tweetId: `https://twitter.com/jack/status/${LONG_ID}?s=20`,
      sortBy: "Relevance",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl(fetchMock)).toBe(
      `https://api.example.test/tw-v2/tweet/details?tweetId=${LONG_ID}&sortBy=Relevance`
    );
    expect(result.structuredContent?.resolvedInput).toEqual({
      tweetId: { value: LONG_ID, source: "link" },
    });
  });

  it("accepts @handles and profile links for usernames", async () => {
    const { tool, fetchMock } = setup("tweetapi_user_by_usernames", () =>
      jsonResponse({ data: [{ id: "12", username: "jack" }] })
    );

    const result = await tool.handler({ usernames: ["@jack", "https://x.com/Gone_Account"] });

    expect(requestedUrl(fetchMock)).toBe(
      "https://api.example.test/tw-v2/user/by-usernames?usernames=jack%2CGone_Account"
    );
    expect(result.structuredContent?.completeness).toMatchObject({
      scope: "batch",
      requestedCount: 2,
      itemCount: 1,
      notReturned: ["Gone_Account"],
    });
  });

  it("reports posts a batch lookup could not load", async () => {
    const { tool, fetchMock } = setup("tweetapi_tweet_details_by_ids", () =>
      jsonResponse({ data: { tweets: [sampleTweet("1"), null] } })
    );

    const result = await tool.handler({ ids: `1,https://x.com/i/status/${LONG_ID}` });

    expect(requestedUrl(fetchMock)).toBe(
      `https://api.example.test/tw-v2/tweet/details-by-ids?ids=1%2C${LONG_ID}`
    );
    expect(result.structuredContent?.completeness).toMatchObject({ notReturned: [LONG_ID] });
  });

  it.each([
    ["tweetapi_tweet_details", { tweetId: "https://x.com/jack" }, "tweetId", /profile link/],
    [
      "tweetapi_tweet_metrics",
      { tweetId: "https://evil.example/jack/status/1" },
      "tweetId",
      /x.com/,
    ],
    [
      "tweetapi_user_by_username",
      { username: `https://x.com/jack/status/${LONG_ID}` },
      "username",
      /post link/,
    ],
    [
      "tweetapi_list_details",
      { listId: "https://x.com/i/communities/1" },
      "listId",
      /community link/,
    ],
    ["tweetapi_tweet_details_by_ids", { ids: ["1", "@jack"] }, "ids[1]", /numeric post ID/],
  ])(
    "%s rejects a wrong or unsafe identifier locally without calling TweetAPI",
    async (name, args, field, message) => {
      const { tool, fetchMock } = setup(name, () => jsonResponse({ data: null }));

      const result = await tool.handler(args);
      const body = parseToolJson(result as never) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      };

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(body.error.code).toBe("TWEETAPI_INVALID_INPUT");
      expect(body.error.message).toMatch(message);
      expect(body.error.details).toMatchObject({
        layer: "mcp_input",
        field,
        cost: { estimatedUnits: 0 },
      });
    }
  );

  it("keeps user-ID tools ID-only instead of resolving usernames with a hidden call", () => {
    const endpoint = LIVE_TOOL_ENDPOINTS.find((tool) => tool.name === "tweetapi_user_tweets");

    expect(endpoint?.inputSchema.userId.safeParse("jack").success).toBe(false);
    expect(endpoint?.inputSchema.userId.safeParse(LONG_ID).success).toBe(true);
  });

  it("flags truncated metrics previews instead of cutting text silently", async () => {
    const longText = "a".repeat(400);
    const { tool } = setup("tweetapi_tweet_metrics", () =>
      jsonResponse({ data: { tweet: sampleTweet("1", longText), replies: [] } })
    );

    const result = await tool.handler({ tweetId: "https://x.com/jack/status/1" });

    expect(result.structuredContent).toMatchObject({
      result: {
        tweet: { url: "https://x.com/jack/status/1", textTruncated: true, textLength: 400 },
      },
      cost: { estimatedUnits: 1 },
    });
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("reports metrics output metadata that matches the projection for long, short, and missing text", async () => {
    const cases = [
      { text: "x".repeat(500), truncated: true, length: 500 },
      { text: "short post", truncated: false, length: 10 },
      { text: undefined, truncated: false, length: null },
    ];

    for (const { text, truncated, length } of cases) {
      const tweet: Record<string, unknown> = { id: "123", author: { username: "example" } };
      if (text !== undefined) tweet.text = text;
      const { tool } = setup("tweetapi_tweet_metrics", () =>
        jsonResponse({ data: { tweet, ancestors: [], replies: [], nextCursor: null } })
      );

      const result = await tool.handler({ tweetId: "123" });
      const structured = result.structuredContent as {
        output: Record<string, unknown>;
        result: { tweet: Record<string, unknown> };
      };

      expect(parseToolJson(result as never)).toEqual(JSON.parse(JSON.stringify(structured)));
      expect(outputSchema.safeParse(structured).success).toBe(true);
      expect(structured.output).toMatchObject({
        format: "metrics",
        itemsOmitted: 0,
        textTruncated: truncated,
      });
      expect((structured.output.fieldsOmitted as string[]).length).toBeGreaterThan(0);
      expect(structured.result.tweet).toMatchObject({
        textTruncated: truncated,
        textLength: length,
      });
      if (truncated) expect(String(structured.result.tweet.textPreview)).toHaveLength(280);
    }
  });

  it("keeps metrics output honest when TweetAPI returns no post", async () => {
    const { tool } = setup("tweetapi_tweet_metrics", () => jsonResponse({ data: { tweet: null } }));

    const result = await tool.handler({ tweetId: "123" });

    expect(result.structuredContent).toMatchObject({
      output: { format: "metrics", textTruncated: false },
      result: { tweet: null },
    });
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("keeps a preview-only article snippet in compact tweet details without calling it the body", async () => {
    const upstream = {
      data: {
        tweet: {
          id: "123",
          text: "Read my article",
          article: {
            id: "456",
            title: "Article title",
            text: "",
            previewText: "Only available article body snippet",
          },
        },
        ancestors: [],
        replies: [],
        nextCursor: null,
      },
    };
    const { tool } = setup("tweetapi_tweet_details", () => jsonResponse(upstream));

    const compact = await tool.handler({ tweetId: "123", responseFormat: "compact" });
    const full = await tool.handler({ tweetId: "123" });

    expect(compact.structuredContent).toMatchObject({
      result: {
        tweet: {
          article: {
            id: "456",
            title: "Article title",
            text: "",
            previewText: "Only available article body snippet",
          },
        },
      },
    });
    expect(outputSchema.safeParse(compact.structuredContent).success).toBe(true);
    expect(full.structuredContent?.result).toEqual(upstream);
  });

  it.each([
    "tweetapi_user_followers_ids",
    "tweetapi_user_following_ids",
    "tweetapi_user_followers_list",
    "tweetapi_user_following_list",
  ])('stops %s at the v1.1 end cursor "0" and keeps ordinary cursors', async (name) => {
    const terminal = { data: ["456"], pagination: { nextCursor: "0", prevCursor: "-1" } };
    const { tool } = setup(name, () => jsonResponse(terminal));

    const end = await tool.handler({ userId: "12" });

    expect(end.structuredContent).toMatchObject({
      pagination: { nextCursor: "0", prevCursor: "-1" },
      completeness: { scope: "page", nextCursor: null, moreAvailable: false },
      result: terminal,
    });
    expect(String((end.structuredContent?.completeness as { note: string }).note)).toContain(
      "last page"
    );
    expect(outputSchema.safeParse(end.structuredContent).success).toBe(true);

    const { tool: nextTool } = setup(name, () =>
      jsonResponse({
        data: ["456"],
        pagination: { nextCursor: "1847291658203946210", prevCursor: "0" },
      })
    );
    const next = await nextTool.handler({ userId: "12" });

    expect(next.structuredContent).toMatchObject({
      completeness: { nextCursor: "1847291658203946210", moreAvailable: true },
    });
  });

  it("keeps opaque GraphQL cursors that start with 0 on other follower tools", async () => {
    const { tool } = setup("tweetapi_user_followers_v2", () =>
      jsonResponse({ data: [], pagination: { nextCursor: "0", prevCursor: null } })
    );
    const { tool: opaqueTool } = setup("tweetapi_user_followers_v2", () =>
      jsonResponse({
        data: [],
        pagination: { nextCursor: "0|1971852223063261182", prevCursor: null },
      })
    );

    expect((await tool.handler({ userId: "12" })).structuredContent).toMatchObject({
      completeness: { nextCursor: "0", moreAvailable: true },
    });
    expect((await opaqueTool.handler({ userId: "12" })).structuredContent).toMatchObject({
      completeness: { nextCursor: "0|1971852223063261182", moreAvailable: true },
    });
  });

  it("makes exactly one upstream request per call for every live tool", async () => {
    const minimalArgs: Record<string, unknown> = {
      username: "jack",
      usernames: "jack",
      userId: "12",
      userIds: "12",
      subjectId: "12",
      targetId: "13",
      query: "tweetapi",
      type: "Latest",
      tweetId: "1",
      ids: "1",
      sortBy: "Relevance",
      dstLang: "fr",
      listId: "1",
      communityId: "1",
      spaceId: "1ABC",
      mediaKey: "28_1",
    };

    for (const endpoint of LIVE_TOOL_ENDPOINTS) {
      const { tool, fetchMock } = setup(endpoint.name, () => jsonResponse({ data: [] }));
      const args = Object.fromEntries(
        Object.keys(endpoint.inputSchema)
          .filter((field) => field in minimalArgs)
          .map((field) => [field, minimalArgs[field]])
      );

      const result = await tool.handler(args);

      expect(result.isError, endpoint.name).toBeUndefined();
      expect(fetchMock, endpoint.name).toHaveBeenCalledTimes(1);
      expect(outputSchema.safeParse(result.structuredContent).success, endpoint.name).toBe(true);
    }
  });
});

describe("profile tabs, Lists, hidden replies, community media and trends", () => {
  function sampleList(id: string) {
    return {
      id,
      name: "AI builders",
      description: "People shipping agents",
      mode: "public",
      memberCount: 42,
      subscriberCount: 7,
      createdAt: "2026-01-02T03:04:05.000Z",
      slug: "ai-builders",
      uri: `/i/lists/${id}`,
      bannerUrl: "https://pbs.twimg.com/list_banner_img/1/b.jpg",
      defaultBannerMedia: { url: "https://pbs.twimg.com/media/b.jpg", width: 1, height: 1 },
      facepileUrls: ["https://pbs.twimg.com/profile_images/1/a.jpg"],
      owner: { id: "12", username: "jack", name: "jack", bio: "long bio", followerCount: 9 },
    };
  }

  it.each([
    ["tweetapi_user_photos", "/tw-v2/user/photos", "tweets"],
    ["tweetapi_user_videos", "/tw-v2/user/videos", "tweets"],
    ["tweetapi_user_highlights", "/tw-v2/user/highlights", "tweets"],
    ["tweetapi_user_articles", "/tw-v2/user/articles", "tweets"],
    ["tweetapi_user_affiliates", "/tw-v2/user/affiliates", "users"],
    ["tweetapi_user_lists", "/tw-v2/user/lists", "lists"],
    ["tweetapi_user_list_memberships", "/tw-v2/user/list-memberships", "lists"],
  ])("%s forwards the user ID and cursor to %s", async (name, path, key) => {
    const item =
      key === "tweets"
        ? sampleTweet("1")
        : key === "lists"
          ? sampleList("9")
          : { id: "13", username: "jill" };
    const { tool, fetchMock } = setup(name, () =>
      jsonResponse({ data: [item], pagination: { nextCursor: "next", prevCursor: null } })
    );

    const result = await tool.handler({ userId: "12", cursor: "c1", responseFormat: "compact" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl(fetchMock)).toBe(`https://api.example.test${path}?userId=12&cursor=c1`);
    expect(result.structuredContent).toMatchObject({
      endpoint: { method: "GET", path },
      completeness: { scope: "page", nextCursor: "next", moreAvailable: true, itemCount: 1 },
      output: { format: "compact" },
      result: { [key]: [expect.any(Object)] },
    });
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("returns similar accounts as one unpaginated result", async () => {
    const { tool, fetchMock } = setup("tweetapi_user_similar_accounts", () =>
      jsonResponse({ data: [{ id: "13", username: "jill" }], pagination: { nextCursor: null } })
    );
    const endpoint = LIVE_TOOL_ENDPOINTS.find((item) => item.name === tool.name);

    const result = await tool.handler({ userId: "12", cursor: "ignored" });

    expect(Object.keys(endpoint?.inputSchema ?? {})).toEqual(["userId", "responseFormat"]);
    expect(requestedUrl(fetchMock)).toBe(
      "https://api.example.test/tw-v2/user/similar-accounts?userId=12"
    );
    expect(result.structuredContent).toMatchObject({
      completeness: { scope: "single", nextCursor: null, itemCount: 1 },
      cost: { estimatedUnits: 1 },
    });
  });

  it("compacts Lists without dropping IDs, links, counts or owner identity", async () => {
    const upstream = { data: [sampleList("1234567890")], pagination: { nextCursor: null } };
    const { tool } = setup("tweetapi_list_search", () => jsonResponse(upstream));

    const compact = await tool.handler({ query: "ai", responseFormat: "compact" });
    const full = await tool.handler({ query: "ai" });

    expect(compact.structuredContent).toMatchObject({
      output: { format: "compact", itemsOmitted: 0 },
      result: {
        lists: [
          {
            id: "1234567890",
            name: "AI builders",
            url: "https://x.com/i/lists/1234567890",
            description: "People shipping agents",
            mode: "public",
            memberCount: 42,
            subscriberCount: 7,
            createdAt: "2026-01-02T03:04:05.000Z",
            slug: "ai-builders",
            owner: { id: "12", username: "jack", url: "https://x.com/jack" },
          },
        ],
      },
    });
    const compactText = JSON.stringify(compact.structuredContent?.result);
    expect(compactText).not.toContain("long bio");
    expect(compactText).not.toContain("facepile");
    expect(compactText).not.toContain("list_banner_img");
    expect(
      (compact.structuredContent?.output as { fieldsOmitted: string[] }).fieldsOmitted.length
    ).toBeGreaterThan(0);
    expect(full.structuredContent?.result).toEqual(upstream);
  });

  it("forwards the List search query and cursor", async () => {
    const { tool, fetchMock } = setup("tweetapi_list_search", () =>
      jsonResponse({ data: [], pagination: { nextCursor: null } })
    );

    await tool.handler({ query: "ai agents", cursor: "c2" });

    expect(requestedUrl(fetchMock)).toBe(
      "https://api.example.test/tw-v2/list/search?query=ai+agents&cursor=c2"
    );
  });

  it("accepts a post link for hidden replies and forwards only the numeric ID", async () => {
    const { tool, fetchMock } = setup("tweetapi_tweet_hidden_replies", () =>
      jsonResponse({ data: [sampleTweet("2")], pagination: { nextCursor: null } })
    );

    const result = await tool.handler({ tweetId: `https://x.com/jack/status/${LONG_ID}` });

    expect(requestedUrl(fetchMock)).toBe(
      `https://api.example.test/tw-v2/tweet/hidden-replies?tweetId=${LONG_ID}`
    );
    expect(result.structuredContent?.resolvedInput).toEqual({
      tweetId: { value: LONG_ID, source: "link" },
    });
  });

  it("accepts a community link for community media and rejects other links locally", async () => {
    const { tool, fetchMock } = setup("tweetapi_community_media", () =>
      jsonResponse({ data: [sampleTweet("3")], pagination: { nextCursor: "n" } })
    );

    const result = await tool.handler({
      communityId: "https://x.com/i/communities/1500000000000000000",
      responseFormat: "compact",
    });

    expect(requestedUrl(fetchMock)).toBe(
      "https://api.example.test/tw-v2/community/media?communityId=1500000000000000000"
    );
    expect(result.structuredContent).toMatchObject({
      result: { tweets: [{ id: "3", url: "https://x.com/jack/status/3" }] },
    });

    const wrong = await tool.handler({ communityId: "https://x.com/i/lists/1" });
    expect(wrong.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, "https://api.example.test/tw-v2/trends"],
    [{ country: "it" }, "https://api.example.test/tw-v2/trends?country=it"],
    [{ woeid: 23424977 }, "https://api.example.test/tw-v2/trends?woeid=23424977"],
    [{ woeid: "1" }, "https://api.example.test/tw-v2/trends?woeid=1"],
  ])("fetches trends for %j with one request", async (args, url) => {
    const trends = {
      data: {
        location: { woeid: 1, name: "Worldwide" },
        asOf: "2026-11-04T10:00:00Z",
        createdAt: "2026-11-04T09:55:00Z",
        trends: [{ name: "#AI", query: "#AI", url: null, promoted: false, tweetVolume: null }],
      },
    };
    const { tool, fetchMock } = setup("tweetapi_trends", () => jsonResponse(trends));

    const result = await tool.handler(args);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl(fetchMock)).toBe(url);
    expect(result.structuredContent).toMatchObject({
      completeness: { scope: "single" },
      result: trends,
    });
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("rejects country and woeid together without calling TweetAPI", async () => {
    const { tool, fetchMock } = setup("tweetapi_trends", () => jsonResponse({ data: null }));

    const result = await tool.handler({ country: "US", woeid: "1" });
    const body = parseToolJson(result as never) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("TWEETAPI_INVALID_INPUT");
    expect(body.error.message).toMatch(/country and woeid/);
    expect(body.error.details).toMatchObject({
      layer: "mcp_input",
      field: "woeid",
      cost: { estimatedUnits: 0 },
    });
  });

  it("validates trends inputs before they reach TweetAPI", () => {
    const endpoint = LIVE_TOOL_ENDPOINTS.find((item) => item.name === "tweetapi_trends");

    expect(endpoint?.inputSchema.country.safeParse("USA").success).toBe(false);
    expect(endpoint?.inputSchema.country.safeParse("us").success).toBe(true);
    expect(endpoint?.inputSchema.woeid.safeParse("0").success).toBe(false);
    expect(endpoint?.inputSchema.woeid.safeParse(0).success).toBe(false);
    expect(endpoint?.inputSchema.woeid.safeParse("12abc").success).toBe(false);
    expect(endpoint?.inputSchema.woeid.safeParse(1.5).success).toBe(false);
  });

  it("lists trend locations with no inputs and one request", async () => {
    const locations = {
      data: [
        {
          woeid: 1,
          name: "Worldwide",
          placeType: { code: 19, name: "Supername" },
          country: null,
          countryCode: null,
          parentId: null,
        },
        {
          woeid: 23424853,
          name: "Italy",
          placeType: { code: 12, name: "Country" },
          country: "Italy",
          countryCode: "IT",
          parentId: 1,
        },
      ],
    };
    const { tool, fetchMock } = setup("tweetapi_trend_locations", () => jsonResponse(locations));
    const endpoint = LIVE_TOOL_ENDPOINTS.find((item) => item.name === tool.name);

    const result = await tool.handler({ woeid: "1" });

    expect(Object.keys(endpoint?.inputSchema ?? {})).toEqual([]);
    expect(requestedUrl(fetchMock)).toBe("https://api.example.test/tw-v2/trends/locations");
    expect(result.structuredContent).toMatchObject({
      completeness: { scope: "single", itemCount: 2 },
      result: locations,
    });
  });
});

describe("account usage tool", () => {
  const usage = {
    data: {
      availableUnits: 108766,
      plan: {
        active: true,
        requestLimit: 100000,
        usedUnits: 1234,
        remainingUnits: 98766,
        periodEnd: "2026-11-20T10:00:00.000Z",
      },
      payg: { availableUnits: 10000, expiresAt: "2027-10-21T10:00:00.000Z" },
      rateLimit: { requestsPerMinute: 60 },
    },
  };

  it("reads the connection's own usage with one free GET and no inputs", async () => {
    const { tool, fetchMock } = setup("tweetapi_account_usage", () => jsonResponse(usage));

    const result = await tool.handler({});

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.example.test/tw-v2/account/usage");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      tool: "tweetapi_account_usage",
      retrievedAt: "2026-10-28T12:00:00.000Z",
      cost: { basis: "estimate", estimatedUnits: 0 },
      completeness: { scope: "single" },
      usageDocs: "https://tweetapi.com/docs/account/usage",
      result: usage,
    });
    expect(String(result.structuredContent?.notice)).toContain("0 units");
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("ignores any attempt to pass another key or user", async () => {
    const { tool, fetchMock } = setup("tweetapi_account_usage", () => jsonResponse(usage));
    const endpoint = LIVE_TOOL_ENDPOINTS.find((item) => item.name === "tweetapi_account_usage");

    expect(Object.keys(endpoint?.inputSchema ?? {})).toEqual([]);
    await tool.handler({ apiKey: "sk_YOUR_OTHER_KEY", userId: "someone-else" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.example.test/tw-v2/account/usage");
    expect(init.headers).toMatchObject({ "X-API-Key": "YOUR_API_KEY" });
  });

  it("returns a retryable error with Retry-After when usage is temporarily unavailable", async () => {
    const { tool } = setup("tweetapi_account_usage", () =>
      jsonResponse(
        { statusCode: 503, message: "Request metering is unavailable" },
        { status: 503, headers: { "Retry-After": "5" } }
      )
    );

    const body = parseToolJson((await tool.handler({})) as never) as {
      error: { code: string; details: Record<string, unknown> };
    };

    expect(body.error).toMatchObject({
      code: "TWEETAPI_UPSTREAM_RETRYABLE",
      details: { retryable: true, retryAfterSeconds: 5, cost: { estimatedUnits: 0 } },
    });
  });
});

describe("live tool errors", () => {
  function errorBody(result: unknown) {
    return parseToolJson(result as never) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
  }

  it("separates a rejected TweetAPI key from MCP sign-in", async () => {
    const { tool } = setup("tweetapi_search", () =>
      jsonResponse(
        { statusCode: 401, message: "Invalid API key or no limit configured" },
        { status: 401 }
      )
    );

    const body = errorBody(await tool.handler({ query: "x", type: "Latest" }));

    expect(body.error.code).toBe("TWEETAPI_AUTH_FAILED");
    expect(body.error.message).toContain("MCP sign-in worked");
    expect(body.error.details).toMatchObject({
      layer: "tweetapi_api_key",
      retryable: false,
      cost: { estimatedUnits: 0 },
    });
  });

  it.each([
    ["RATE_LIMITED", "rate_limited", true, /per-minute rate limit/],
    ["QUOTA_EXHAUSTED", "quota_exhausted", false, /units are used up/],
    ["SUBSCRIPTION_INACTIVE", "subscription_inactive", false, /not active/],
    [undefined, "unknown", true, /rate limit or quota/],
  ])("explains a 429 with upstream code %s", async (upstreamCode, reason, retryable, message) => {
    const { tool } = setup("tweetapi_search", () =>
      jsonResponse(
        { statusCode: 429, message: "limit", ...(upstreamCode ? { code: upstreamCode } : {}) },
        { status: 429, headers: { "Retry-After": "17" } }
      )
    );

    const body = errorBody(await tool.handler({ query: "x", type: "Latest" }));

    expect(body.error.code).toBe("TWEETAPI_RATE_LIMITED");
    expect(body.error.message).toMatch(message);
    expect(body.error.details).toMatchObject({
      layer: "tweetapi_api",
      reason,
      retryable,
      retryAfterSeconds: 17,
      cost: { estimatedUnits: 0 },
    });
  });

  it("marks a not-found result as billed and does not guess why it is missing", async () => {
    const { tool } = setup("tweetapi_tweet_details", () =>
      jsonResponse({ statusCode: 404, message: "Tweet not found" }, { status: 404 })
    );

    const body = errorBody(await tool.handler({ tweetId: "1", sortBy: "Relevance" }));

    expect(body.error.code).toBe("TWEETAPI_HTTP_404");
    expect(body.error.message).toContain("cannot tell which");
    expect(body.error.details).toMatchObject({ cost: { estimatedUnits: 1 }, retryable: false });
  });

  it("reports upstream 5xx as retryable without retrying", async () => {
    const { tool, fetchMock } = setup("tweetapi_search", () =>
      jsonResponse(
        { statusCode: 502, message: "Could not reach Twitter. Please retry." },
        { status: 502 }
      )
    );

    const body = errorBody(await tool.handler({ query: "x", type: "Latest" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(body.error).toMatchObject({
      code: "TWEETAPI_UPSTREAM_RETRYABLE",
      details: { retryable: true, cost: { estimatedUnits: 0 } },
    });
  });

  it("reports network failures with an unknown billing outcome", async () => {
    const { tool } = setup("tweetapi_search", () => {
      throw new TypeError("fetch failed");
    });

    const body = errorBody(await tool.handler({ query: "x", type: "Latest" }));

    expect(body.error).toMatchObject({
      code: "TWEETAPI_REQUEST_FAILED",
      details: { layer: "network", cost: { estimatedUnits: null } },
    });
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");

    expect(parseRetryAfter("5", now)).toBe(5);
    expect(parseRetryAfter("Wed, 28 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Wed, 28 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("999999999", now)).toBe(86400);
  });
});
