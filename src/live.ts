import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { jsonError, jsonText } from "./content.js";
import { FetchTimeoutError, fetchWithTimeout, readPositiveIntegerEnv } from "./fetch-timeout.js";

const DEFAULT_API_BASE_URL = "https://api.tweetapi.com";
const NORMALIZED_PRODUCTION_API_BASE_URL = "https://api.tweetapi.com/";
const DEFAULT_LIVE_FETCH_TIMEOUT_MS = 15_000;
const CLIENT_HEADER_VALUE = "hosted-mcp";

export const LIVE_TOOL_NOTICE =
  "Requires a TweetAPI API key and consumes normal TweetAPI quota. Read-only; one upstream request per call. The model must request pagination cursors explicitly.";

const digitId = z.string().regex(/^\d+$/, "ID must contain only numbers");
const optionalCursor = z.string().min(1).optional();
const searchType = z.enum(["Top", "Latest", "People", "Photos", "Videos"]);
const tweetSortBy = z.enum(["Relevance", "Recency", "Likes"]);
const communitySortBy = z.enum(["Relevance", "Recency"]);
const count = z.number().int().min(1).max(500).optional();
const username = z.string().min(1);
const usernameList = z
  .union([z.string().min(1), z.array(username).min(1).max(100)])
  .describe("Comma-separated string or array of usernames.");
const userIdList = z
  .union([z.string().min(1), z.array(digitId).min(1).max(100)])
  .describe("Comma-separated string or array of user IDs.");
const tweetIdList = z
  .union([z.string().min(1), z.array(digitId).min(1).max(200)])
  .describe("Comma-separated string or array of tweet IDs.");

type HttpMethod = "GET" | "POST";
type FetchLike = typeof fetch;

export type LiveToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
};

export type LiveToolsOptions = {
  apiKey?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  fetchTimeoutMs?: number;
  missingApiKeyCode?: string;
  missingApiKeyMessage?: string;
};

export type LiveToolEndpoint = {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  path: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  bodyFields?: readonly string[];
  responseShape?: "tweetMetrics";
};

export const LIVE_TOOL_ENDPOINTS: readonly LiveToolEndpoint[] = [
  {
    name: "tweetapi_user_by_username",
    title: "Get User By Username",
    description:
      "Fetch one public user profile by username. For several users at once, use tweetapi_user_by_usernames.",
    method: "GET",
    path: "/tw-v2/user/by-username",
    inputSchema: { username },
  },
  {
    name: "tweetapi_user_by_usernames",
    title: "Get Users By Usernames",
    description: "Fetch up to 100 public user profiles in one call by username.",
    method: "GET",
    path: "/tw-v2/user/by-usernames",
    inputSchema: { usernames: usernameList },
  },
  {
    name: "tweetapi_user_by_id",
    title: "Get User By ID",
    description:
      "Fetch one public user profile by numeric user ID. For several users at once, use tweetapi_user_by_ids.",
    method: "GET",
    path: "/tw-v2/user/by-id",
    inputSchema: { userId: digitId },
  },
  {
    name: "tweetapi_user_by_ids",
    title: "Get Users By IDs",
    description: "Fetch up to 100 public user profiles in one call by numeric user ID.",
    method: "GET",
    path: "/tw-v2/user/by-ids",
    inputSchema: { userIds: userIdList },
  },
  {
    name: "tweetapi_user_about_account",
    title: "Get User Account Summary",
    description:
      "Fetch the About this account details for a username: location, verification, username history, affiliates and how the account was created. Use tweetapi_user_by_username for the regular profile.",
    method: "GET",
    path: "/tw-v2/user/about-account",
    inputSchema: { username },
  },
  {
    name: "tweetapi_user_followers_v2",
    title: "Get User Followers",
    description:
      "Fetch one page of follower profiles for a user ID, at the default page size. Use tweetapi_user_followers_list to set the page size with count, or tweetapi_user_followers_ids for IDs only.",
    method: "GET",
    path: "/tw-v2/user/followers",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_following_v2",
    title: "Get User Following",
    description:
      "Fetch one page of profiles a user ID follows, at the default page size. Use tweetapi_user_following_list to set the page size with count, or tweetapi_user_following_ids for IDs only.",
    method: "GET",
    path: "/tw-v2/user/following",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_verified_followers",
    title: "Get Verified Followers",
    description: "Fetch one page of follower profiles for a user ID, limited to verified accounts.",
    method: "GET",
    path: "/tw-v2/user/verified-followers",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_subscriptions",
    title: "Get User Subscriptions",
    description:
      "Fetch one page of accounts a user ID pays to subscribe to (Premium creator subscriptions and Super Follows). This is not the following list.",
    method: "GET",
    path: "/tw-v2/user/subscriptions",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_tweets",
    title: "Get User Tweets",
    description:
      "Fetch one page of a user's original tweets, without replies. Use tweetapi_user_tweets_and_replies to include replies.",
    method: "GET",
    path: "/tw-v2/user/tweets",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_tweets_and_replies",
    title: "Get User Tweets And Replies",
    description: "Fetch one page of a user's tweets including their replies.",
    method: "GET",
    path: "/tw-v2/user/tweets-and-replies",
    inputSchema: { userId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_followers_ids",
    title: "Get Follower IDs",
    description:
      "Fetch one page of follower user IDs (strings only, no profiles) for a user ID. Cheapest way to walk a large follower graph.",
    method: "GET",
    path: "/tw-v2/user/followers-ids",
    inputSchema: { userId: digitId, count, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_following_ids",
    title: "Get Following IDs",
    description:
      "Fetch one page of user IDs (strings only, no profiles) that a user ID follows. Cheapest way to walk a large following graph.",
    method: "GET",
    path: "/tw-v2/user/following-ids",
    inputSchema: { userId: digitId, count, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_followers_list",
    title: "Get Followers List",
    description:
      "Fetch one page of follower profiles for a user ID, with an optional count to set the page size. Use tweetapi_user_followers_ids when you only need IDs.",
    method: "GET",
    path: "/tw-v2/user/followers-list",
    inputSchema: { userId: digitId, count, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_following_list",
    title: "Get Following List",
    description:
      "Fetch one page of profiles a user ID follows, with an optional count to set the page size. Use tweetapi_user_following_ids when you only need IDs.",
    method: "GET",
    path: "/tw-v2/user/following-list",
    inputSchema: { userId: digitId, count, cursor: optionalCursor },
  },
  {
    name: "tweetapi_user_check_follow",
    title: "Check Follow Relationship",
    description: "Check whether one user follows another, and whether they follow back.",
    method: "GET",
    path: "/tw-v2/user/friendship",
    inputSchema: { subjectId: digitId, targetId: digitId },
  },
  {
    name: "tweetapi_search",
    title: "Search Tweets And Users",
    description: "Search public tweets, users, photos, or videos.",
    method: "GET",
    path: "/tw-v2/search",
    inputSchema: {
      query: z.string().min(1).max(512),
      type: searchType.default("Latest"),
      cursor: optionalCursor,
    },
  },
  {
    name: "tweetapi_tweet_details",
    title: "Get Tweet Details",
    description:
      "Fetch one tweet with full details, its parent tweets when it is a reply, and a page of replies. Use tweetapi_tweet_metrics for counts only, or tweetapi_tweet_details_by_ids for many tweets.",
    method: "GET",
    path: "/tw-v2/tweet/details",
    inputSchema: {
      tweetId: digitId,
      sortBy: tweetSortBy.default("Relevance"),
      cursor: optionalCursor,
    },
  },
  {
    name: "tweetapi_tweet_metrics",
    title: "Get Tweet Metrics",
    description:
      "Fetch only the engagement counts (likes, retweets, replies, quotes, bookmarks, views) for one tweet, without the conversation. Use tweetapi_tweet_details for the full tweet.",
    method: "GET",
    path: "/tw-v2/tweet/details",
    inputSchema: { tweetId: digitId },
    responseShape: "tweetMetrics",
  },
  {
    name: "tweetapi_tweet_details_by_ids",
    title: "Get Tweet Details By IDs",
    description:
      "Fetch details for up to 200 tweets in one call by tweet ID. No replies are included.",
    method: "GET",
    path: "/tw-v2/tweet/details-by-ids",
    inputSchema: { ids: tweetIdList },
  },
  {
    name: "tweetapi_tweet_quotes",
    title: "Get Tweet Quotes",
    description: "Fetch one page of tweets that quote a given tweet.",
    method: "GET",
    path: "/tw-v2/tweet/quotes",
    inputSchema: { tweetId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_tweet_retweets",
    title: "Get Tweet Retweets",
    description: "Fetch one page of users who retweeted a given tweet.",
    method: "GET",
    path: "/tw-v2/tweet/retweets",
    inputSchema: { tweetId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_tweet_translate",
    title: "Translate Tweet",
    description: "Translate public tweet text without changing the tweet.",
    method: "POST",
    path: "/tw-v2/tweet/translate",
    inputSchema: {
      tweetId: digitId,
      dstLang: z.string().min(2).max(5),
    },
    bodyFields: ["tweetId", "dstLang"],
  },
  {
    name: "tweetapi_list_details",
    title: "Get List Details",
    description: "Fetch public details for a list.",
    method: "GET",
    path: "/tw-v2/list/details",
    inputSchema: { listId: digitId },
  },
  {
    name: "tweetapi_list_tweets",
    title: "Get List Tweets",
    description: "Fetch one page of the tweet timeline for a list.",
    method: "GET",
    path: "/tw-v2/list/tweets",
    inputSchema: { listId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_list_members",
    title: "Get List Members",
    description: "Fetch one page of the accounts that are members of a list.",
    method: "GET",
    path: "/tw-v2/list/members",
    inputSchema: { listId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_list_followers",
    title: "Get List Followers",
    description:
      "Fetch one page of the accounts that follow (subscribe to) a list. Use tweetapi_list_members for the accounts in the list.",
    method: "GET",
    path: "/tw-v2/list/followers",
    inputSchema: { listId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_community_details",
    title: "Get Community Details",
    description: "Fetch public details for a community.",
    method: "GET",
    path: "/tw-v2/community/details",
    inputSchema: { communityId: digitId },
  },
  {
    name: "tweetapi_community_tweets",
    title: "Get Community Tweets",
    description: "Fetch one page of tweets posted in a community.",
    method: "GET",
    path: "/tw-v2/community/tweets",
    inputSchema: {
      communityId: digitId,
      sortBy: communitySortBy.default("Relevance"),
      cursor: optionalCursor,
    },
  },
  {
    name: "tweetapi_community_members",
    title: "Get Community Members",
    description: "Fetch one page of a community's members.",
    method: "GET",
    path: "/tw-v2/community/members",
    inputSchema: { communityId: digitId, cursor: optionalCursor },
  },
  {
    name: "tweetapi_community_search",
    title: "Search Communities",
    description: "Search communities by keyword. Use tweetapi_search for tweets and users.",
    method: "GET",
    path: "/tw-v2/community/search",
    inputSchema: { query: z.string().min(1), cursor: optionalCursor },
  },
  {
    name: "tweetapi_space_by_id",
    title: "Get Space By ID",
    description:
      "Fetch details for a Space by its space ID, including the media key needed for tweetapi_space_stream_url.",
    method: "GET",
    path: "/tw-v2/space/by-id",
    inputSchema: { spaceId: z.string().min(1) },
  },
  {
    name: "tweetapi_space_stream_url",
    title: "Get Space Stream URL",
    description:
      "Fetch the audio stream URL for a Space, using the media key from tweetapi_space_by_id.",
    method: "GET",
    path: "/tw-v2/space/stream-url",
    inputSchema: { mediaKey: z.string().min(1) },
  },
];

export function createLiveToolDefinitions(options: LiveToolsOptions): LiveToolDefinition[] {
  return LIVE_TOOL_ENDPOINTS.map((endpoint) => ({
    name: endpoint.name,
    title: endpoint.title,
    description: `${LIVE_TOOL_NOTICE} ${endpoint.description}`,
    inputSchema: endpoint.inputSchema,
    handler: async (args) => runLiveRequest(endpoint, args, options),
  }));
}

async function runLiveRequest(
  endpoint: LiveToolEndpoint,
  args: Record<string, unknown>,
  options: LiveToolsOptions
): Promise<CallToolResult> {
  if (!options.apiKey) {
    return jsonError(
      options.missingApiKeyCode ?? "MISSING_TWEETAPI_API_KEY",
      options.missingApiKeyMessage ??
        "Live TweetAPI tools require a TweetAPI API key. Hosted MCP clients must use a dashboard-backed MCP grant token, and local stdio live mode must set TWEETAPI_API_KEY."
    );
  }

  const fetchTimeoutMs =
    options.fetchTimeoutMs ??
    readPositiveIntegerEnv("MCP_LIVE_FETCH_TIMEOUT_MS", DEFAULT_LIVE_FETCH_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? fetch;

  try {
    const apiBaseUrl = resolveTweetApiBaseUrl(
      options.apiBaseUrl ?? process.env.TWEETAPI_API_BASE_URL
    );
    const request = buildUpstreamRequest(endpoint, args, apiBaseUrl, options.apiKey);
    const response = await fetchWithTimeout(fetchImpl, request.url, request.init, fetchTimeoutMs);
    const result = await readUpstreamResponse(response);

    if (!response.ok) {
      return mapHttpError(endpoint, response.status, result);
    }

    const payload: Record<string, unknown> = {
      tool: endpoint.name,
      mode: "hosted-read-only",
      notice: LIVE_TOOL_NOTICE,
      endpoint: {
        method: endpoint.method,
        path: endpoint.path,
      },
      statusCode: response.status,
    };

    if (endpoint.responseShape === "tweetMetrics") {
      payload.result = buildTweetMetrics(result);
    } else {
      payload.pagination = extractPagination(result);
      payload.result = result;
    }

    return jsonText(payload);
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return jsonError(
        "TWEETAPI_UPSTREAM_TIMEOUT",
        `TweetAPI upstream request timed out after ${error.timeoutMs}ms.`,
        {
          endpoint: {
            method: endpoint.method,
            path: endpoint.path,
          },
        }
      );
    }

    if (error instanceof ApiBaseUrlConfigError) {
      return jsonError("TWEETAPI_CONFIG_ERROR", error.message, {
        expectedBaseUrl: DEFAULT_API_BASE_URL,
      });
    }

    return jsonError(
      "TWEETAPI_REQUEST_FAILED",
      error instanceof Error ? error.message : "TweetAPI request failed",
      {
        endpoint: {
          method: endpoint.method,
          path: endpoint.path,
        },
      }
    );
  }
}

function buildUpstreamRequest(
  endpoint: LiveToolEndpoint,
  args: Record<string, unknown>,
  apiBaseUrl: string,
  apiKey: string
) {
  const url = new URL(endpoint.path, normalizeBaseUrl(apiBaseUrl));
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-API-Key": apiKey,
    "X-TweetAPI-Client": CLIENT_HEADER_VALUE,
  };
  const init: RequestInit = {
    method: endpoint.method,
    headers,
  };

  if (endpoint.method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      appendQueryParam(url, key, value);
    }
  } else {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(selectBodyFields(args, endpoint.bodyFields ?? Object.keys(args)));
  }

  return {
    url,
    init,
  };
}

export function resolveTweetApiBaseUrl(value?: string): string {
  const normalized = normalizeBaseUrl(value ?? DEFAULT_API_BASE_URL);

  if (process.env.NODE_ENV === "production" && normalized !== NORMALIZED_PRODUCTION_API_BASE_URL) {
    throw new ApiBaseUrlConfigError(normalized);
  }

  return normalized;
}

function appendQueryParam(url: URL, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    url.searchParams.set(key, value.join(","));
    return;
  }

  url.searchParams.set(key, String(value));
}

function selectBodyFields(args: Record<string, unknown>, fields: readonly string[]) {
  const body: Record<string, unknown> = {};

  for (const field of fields) {
    const value = args[field];
    if (value !== undefined && value !== null && value !== "") {
      body[field] = value;
    }
  }

  return body;
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

async function readUpstreamResponse(response: Response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mapHttpError(endpoint: LiveToolEndpoint, statusCode: number, responseBody: unknown) {
  const code =
    statusCode === 401
      ? "TWEETAPI_AUTH_FAILED"
      : statusCode === 403
        ? "TWEETAPI_FORBIDDEN"
        : statusCode === 429
          ? "TWEETAPI_RATE_LIMITED"
          : statusCode >= 500
            ? "TWEETAPI_UPSTREAM_RETRYABLE"
            : `TWEETAPI_HTTP_${statusCode}`;

  return jsonError(code, httpErrorMessage(statusCode), {
    statusCode,
    endpoint: {
      method: endpoint.method,
      path: endpoint.path,
    },
    response: responseBody,
  });
}

function httpErrorMessage(statusCode: number) {
  if (statusCode === 401) {
    return "TweetAPI rejected the API key. Check the MCP Authorization bearer token.";
  }

  if (statusCode === 403) {
    return "TweetAPI refused this request for the current API key or plan.";
  }

  if (statusCode === 429) {
    return "TweetAPI rate limit or quota was exceeded. Retry later or check dashboard usage.";
  }

  if (statusCode >= 500) {
    return "TweetAPI returned a retryable upstream error.";
  }

  return "TweetAPI request failed.";
}

function extractPagination(result: unknown) {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const record = result as Record<string, unknown>;
  return (
    record.pagination ??
    record.pageInfo ??
    pickDefined(record, ["cursor", "nextCursor", "next_cursor", "previousCursor", "prevCursor"])
  );
}

function pickDefined(record: Record<string, unknown>, fields: string[]) {
  const picked: Record<string, unknown> = {};

  for (const field of fields) {
    if (record[field] !== undefined) {
      picked[field] = record[field];
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

function buildTweetMetrics(result: unknown) {
  const tweet = extractTweetRecord(result);

  if (!tweet) {
    return {
      tweet: null,
      engagement: null,
      context: null,
    };
  }

  return {
    tweet: {
      id: pickString(tweet, "id"),
      textPreview: truncateText(pickString(tweet, "text"), 280),
      author: summarizeAuthor(tweet.author),
      createdAt: pickString(tweet, "createdAt"),
      type: pickString(tweet, "type"),
      lang: pickString(tweet, "lang"),
    },
    engagement: {
      likeCount: pickNumberOrNull(tweet, "likeCount"),
      retweetCount: pickNumberOrNull(tweet, "retweetCount"),
      replyCount: pickNumberOrNull(tweet, "replyCount"),
      quoteCount: pickNumberOrNull(tweet, "quoteCount"),
      bookmarkCount: pickNumberOrNull(tweet, "bookmarkCount"),
      viewCount: pickNumberOrNull(tweet, "viewCount"),
    },
    context: {
      isReply: isPresent(tweet.replyTo) || pickString(tweet, "type") === "reply",
      isQuote: isPresent(tweet.quotedTweet) || pickString(tweet, "type") === "quote",
      isRetweet: isPresent(tweet.retweetedTweet) || pickString(tweet, "type") === "retweet",
      hasMedia: Array.isArray(tweet.media) && tweet.media.length > 0,
      hasPoll: isPresent(tweet.poll),
      hasCard: isPresent(tweet.card),
      possiblySensitive: pickBooleanOrNull(tweet, "possiblySensitive"),
      isEdited: pickBooleanOrNull(tweet, "isEdited"),
      isTranslatable: pickBooleanOrNull(tweet, "isTranslatable"),
      hasBirdwatchNotes: pickBooleanOrNull(tweet, "hasBirdwatchNotes"),
      communityId: pickString(tweet, "communityId"),
    },
  };
}

function extractTweetRecord(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) {
    return null;
  }

  const data = result.data;

  if (isRecord(data)) {
    if (isRecord(data.tweet)) {
      return data.tweet;
    }

    if (typeof data.id === "string" || typeof data.text === "string") {
      return data;
    }
  }

  if (isRecord(result.tweet)) {
    return result.tweet;
  }

  return null;
}

function summarizeAuthor(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: pickString(value, "id"),
    username: pickString(value, "username"),
    name: pickString(value, "name"),
    avatar: pickString(value, "avatar"),
    verified: pickBooleanOrNull(value, "verified"),
    isBlueVerified: pickBooleanOrNull(value, "isBlueVerified"),
    verifiedType: pickString(value, "verifiedType"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function pickString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function pickNumberOrNull(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickBooleanOrNull(record: Record<string, unknown>, field: string): boolean | null {
  const value = record[field];
  return typeof value === "boolean" ? value : null;
}

function truncateText(value: string | null, maxLength: number): string | null {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

class ApiBaseUrlConfigError extends Error {
  constructor(baseUrl: string) {
    super(
      `Invalid TWEETAPI_API_BASE_URL for production hosted MCP: ${baseUrl}. Expected ${DEFAULT_API_BASE_URL}.`
    );
    this.name = "ApiBaseUrlConfigError";
  }
}
