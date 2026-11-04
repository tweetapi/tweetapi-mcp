import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { jsonError, jsonStructured } from "./content.js";
import {
  estimateCallCost,
  noRequestSentCost,
  unknownOutcomeCost,
  USAGE_DOCS_URL,
  type CostEstimate,
} from "./cost.js";
import { FetchTimeoutError, fetchWithTimeout, readPositiveIntegerEnv } from "./fetch-timeout.js";
import {
  IdentifierInputError,
  parseCommunityIdentifier,
  parseIdentifierList,
  parseListIdentifier,
  parseSpaceIdentifier,
  parseTweetIdentifier,
  parseUsernameIdentifier,
  type IdentifierKind,
  type ResolvedIdentifier,
} from "./identifiers.js";
import {
  buildCompleteness,
  compactResult,
  extractPagination,
  isRecord,
  metricsOutputInfo,
  outputInfo,
  tweetUrl,
  type BatchKind,
  type CompactKind,
  type ResponseFormat,
} from "./results.js";

const DEFAULT_API_BASE_URL = "https://api.tweetapi.com";
const NORMALIZED_PRODUCTION_API_BASE_URL = "https://api.tweetapi.com/";
const DEFAULT_LIVE_FETCH_TIMEOUT_MS = 15_000;
const CLIENT_HEADER_VALUE = "hosted-mcp";
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export const LIVE_TOOL_NOTICE =
  "Requires a TweetAPI API key and consumes normal TweetAPI quota (usually 1 unit per call; each result includes a cost estimate). Read-only; one upstream request per call. The model must request pagination cursors explicitly.";

const ACCOUNT_USAGE_NOTICE =
  "Free (0 units) read-only check of the TweetAPI API key behind this connection. It counts toward the per-minute request limit. It cannot read other keys or change anything.";

// Fields the MCP server reads itself and never forwards to TweetAPI.
const MCP_ONLY_FIELDS = new Set(["responseFormat"]);

const digitId = z.string().regex(/^\d+$/, "ID must contain only numbers");
const userId = digitId.describe(
  "Numeric user ID. This tool does not look up usernames; call tweetapi_user_by_username first if you only have a username or profile link."
);
const optionalCursor = z.string().min(1).optional();
const searchType = z.enum(["Top", "Latest", "People", "Photos", "Videos"]);
const tweetSortBy = z.enum(["Relevance", "Recency", "Likes"]);
const communitySortBy = z.enum(["Relevance", "Recency"]);
const count = z.number().int().min(1).max(500).optional();
const identifierText = z.string().min(1).max(512);
const username = identifierText.describe(
  "Username, @handle, or profile link such as https://x.com/jack."
);
const tweetId = identifierText.describe(
  "Numeric post ID, or a post link such as https://x.com/jack/status/20."
);
const listId = identifierText.describe(
  "Numeric list ID, or a list link such as https://x.com/i/lists/1234567890."
);
const communityId = identifierText.describe(
  "Numeric community ID, or a community link such as https://x.com/i/communities/1234567890."
);
const spaceId = identifierText.describe(
  "Space ID, or a Space link such as https://x.com/i/spaces/1ABCdefGHIjkl."
);
const usernameList = z
  .union([z.string().min(1), z.array(identifierText).min(1).max(100)])
  .describe(
    "Up to 100 usernames, @handles, or profile links, as a comma-separated string or an array."
  );
const userIdList = z
  .union([z.string().min(1), z.array(digitId).min(1).max(100)])
  .describe("Comma-separated string or array of up to 100 numeric user IDs.");
const tweetIdList = z
  .union([z.string().min(1), z.array(identifierText).min(1).max(200)])
  .describe("Up to 200 numeric post IDs or post links, as a comma-separated string or an array.");
const trendCountry = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "country must be a two-letter country code")
  .optional()
  .describe(
    "Two-letter country code such as US or IT (case-insensitive). Cannot be combined with woeid."
  );
const trendWoeid = z
  .union([
    z.string().regex(/^[1-9]\d{0,9}$/, "woeid must be a positive whole number"),
    z.number().int().min(1).max(9_999_999_999),
  ])
  .optional()
  .describe(
    "Where On Earth ID of a location from tweetapi_trend_locations, or 1 for worldwide. Cannot be combined with country."
  );
const responseFormat = z
  .enum(["full", "compact"])
  .optional()
  .describe(
    "full (default) returns TweetAPI's JSON unchanged. compact keeps full post text, IDs, links, original dates, counts, and cursors but drops bulky fields; output.fieldsOmitted lists what was dropped."
  );

type HttpMethod = "GET" | "POST";
type FetchLike = typeof fetch;

export type LiveToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
};

export type LiveToolsOptions = {
  apiKey?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  fetchTimeoutMs?: number;
  missingApiKeyCode?: string;
  missingApiKeyMessage?: string;
  now?: () => Date;
};

export type LiveToolEndpoint = {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  path: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  bodyFields?: readonly string[];
  responseShape?: "tweetMetrics" | "accountUsage";
  compactKind?: CompactKind;
  identifiers?: Record<string, IdentifierKind>;
  batch?: { field: string; kind: BatchKind };
  // X v1.1 follower/following routes: a next cursor of exactly "0" means the last page.
  zeroCursorEnds?: true;
  // Inputs that cannot be sent together. TweetAPI rejects the pair; checking locally saves a
  // round trip.
  exclusiveInputs?: readonly string[];
};

export const LIVE_TOOL_ENDPOINTS: readonly LiveToolEndpoint[] = [
  {
    name: "tweetapi_user_by_username",
    title: "Get User By Username",
    description:
      "Fetch one public user profile by username, @handle, or profile link. For several users at once, use tweetapi_user_by_usernames.",
    method: "GET",
    path: "/tw-v2/user/by-username",
    inputSchema: { username, responseFormat },
    compactKind: "user",
    identifiers: { username: "username" },
  },
  {
    name: "tweetapi_user_by_usernames",
    title: "Get Users By Usernames",
    description:
      "Fetch up to 100 public user profiles in one call by username, @handle, or profile link. Missing accounts are listed in completeness.notReturned.",
    method: "GET",
    path: "/tw-v2/user/by-usernames",
    inputSchema: { usernames: usernameList, responseFormat },
    compactKind: "users",
    identifiers: { usernames: "usernameList" },
    batch: { field: "usernames", kind: "usernames" },
  },
  {
    name: "tweetapi_user_by_id",
    title: "Get User By ID",
    description:
      "Fetch one public user profile by numeric user ID. For several users at once, use tweetapi_user_by_ids.",
    method: "GET",
    path: "/tw-v2/user/by-id",
    inputSchema: { userId, responseFormat },
    compactKind: "user",
  },
  {
    name: "tweetapi_user_by_ids",
    title: "Get Users By IDs",
    description:
      "Fetch up to 100 public user profiles in one call by numeric user ID. Missing accounts are listed in completeness.notReturned.",
    method: "GET",
    path: "/tw-v2/user/by-ids",
    inputSchema: { userIds: userIdList, responseFormat },
    compactKind: "users",
    batch: { field: "userIds", kind: "userIds" },
  },
  {
    name: "tweetapi_user_about_account",
    title: "Get User Account Summary",
    description:
      "Fetch the About this account details for a username, @handle, or profile link: location, verification, username history, affiliates and how the account was created. Use tweetapi_user_by_username for the regular profile.",
    method: "GET",
    path: "/tw-v2/user/about-account",
    inputSchema: { username },
    identifiers: { username: "username" },
  },
  {
    name: "tweetapi_user_followers_v2",
    title: "Get User Followers",
    description:
      "Fetch one page of follower profiles for a user ID, at the default page size. Use tweetapi_user_followers_list to set the page size with count, or tweetapi_user_followers_ids for IDs only.",
    method: "GET",
    path: "/tw-v2/user/followers",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_following_v2",
    title: "Get User Following",
    description:
      "Fetch one page of profiles a user ID follows, at the default page size. Use tweetapi_user_following_list to set the page size with count, or tweetapi_user_following_ids for IDs only.",
    method: "GET",
    path: "/tw-v2/user/following",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_verified_followers",
    title: "Get Verified Followers",
    description: "Fetch one page of follower profiles for a user ID, limited to verified accounts.",
    method: "GET",
    path: "/tw-v2/user/verified-followers",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_subscriptions",
    title: "Get User Subscriptions",
    description:
      "Fetch one page of accounts a user ID pays to subscribe to (Premium creator subscriptions and Super Follows). This is not the following list.",
    method: "GET",
    path: "/tw-v2/user/subscriptions",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_tweets",
    title: "Get User Tweets",
    description:
      "Fetch one page of a user's original tweets, without replies. Use tweetapi_user_tweets_and_replies to include replies.",
    method: "GET",
    path: "/tw-v2/user/tweets",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_tweets_and_replies",
    title: "Get User Tweets And Replies",
    description: "Fetch one page of a user's tweets including their replies.",
    method: "GET",
    path: "/tw-v2/user/tweets-and-replies",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_followers_ids",
    title: "Get Follower IDs",
    description:
      "Fetch one page of follower user IDs (strings only, no profiles) for a user ID. Cheapest way to walk a large follower graph.",
    method: "GET",
    path: "/tw-v2/user/followers-ids",
    inputSchema: { userId, count, cursor: optionalCursor },
    zeroCursorEnds: true,
  },
  {
    name: "tweetapi_user_following_ids",
    title: "Get Following IDs",
    description:
      "Fetch one page of user IDs (strings only, no profiles) that a user ID follows. Cheapest way to walk a large following graph.",
    method: "GET",
    path: "/tw-v2/user/following-ids",
    inputSchema: { userId, count, cursor: optionalCursor },
    zeroCursorEnds: true,
  },
  {
    name: "tweetapi_user_followers_list",
    title: "Get Followers List",
    description:
      "Fetch one page of follower profiles for a user ID, with an optional count to set the page size. Use tweetapi_user_followers_ids when you only need IDs.",
    method: "GET",
    path: "/tw-v2/user/followers-list",
    inputSchema: { userId, count, cursor: optionalCursor, responseFormat },
    compactKind: "users",
    zeroCursorEnds: true,
  },
  {
    name: "tweetapi_user_following_list",
    title: "Get Following List",
    description:
      "Fetch one page of profiles a user ID follows, with an optional count to set the page size. Use tweetapi_user_following_ids when you only need IDs.",
    method: "GET",
    path: "/tw-v2/user/following-list",
    inputSchema: { userId, count, cursor: optionalCursor, responseFormat },
    compactKind: "users",
    zeroCursorEnds: true,
  },
  {
    name: "tweetapi_user_check_follow",
    title: "Check Follow Relationship",
    description: "Check whether one user follows another, and whether they follow back.",
    method: "GET",
    path: "/tw-v2/user/friendship",
    inputSchema: { subjectId: userId, targetId: userId },
  },
  {
    name: "tweetapi_user_photos",
    title: "Get User Photos",
    description:
      "Fetch one page of a user's posts that contain photos, as on the Photos tab of their profile. Videos are a separate feed: use tweetapi_user_videos.",
    method: "GET",
    path: "/tw-v2/user/photos",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_videos",
    title: "Get User Videos",
    description:
      "Fetch one page of a user's posts that contain videos, as on the Videos tab of their profile. Photos are a separate feed: use tweetapi_user_photos.",
    method: "GET",
    path: "/tw-v2/user/videos",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_highlights",
    title: "Get User Highlights",
    description:
      "Fetch one page of the posts a user has added to the Highlights tab of their profile. Highlights are an X Premium feature, so most accounts return an empty page.",
    method: "GET",
    path: "/tw-v2/user/highlights",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_articles",
    title: "Get User Articles",
    description:
      "Fetch one page of the posts that published a user's X Articles, with each Article's title and preview text. The full Article text is not included: pass the post ID to tweetapi_tweet_details to read it.",
    method: "GET",
    path: "/tw-v2/user/articles",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
  },
  {
    name: "tweetapi_user_affiliates",
    title: "Get User Affiliates",
    description:
      "Fetch one page of the accounts affiliated with a business profile, as on its Affiliates tab. Returns X's default affiliate group only; a profile with no affiliates returns an empty list.",
    method: "GET",
    path: "/tw-v2/user/affiliates",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_similar_accounts",
    title: "Get Similar Accounts",
    description:
      "Fetch the accounts X lists as similar to a user. Returns a single page with no cursor. X often lists none, and an empty result is still billed.",
    method: "GET",
    path: "/tw-v2/user/similar-accounts",
    inputSchema: { userId, responseFormat },
    compactKind: "users",
  },
  {
    name: "tweetapi_user_lists",
    title: "Get User Lists",
    description:
      "Fetch one page of the Lists shown on a user's Lists tab. X can include Lists owned by other accounts, so check owner on each List; Private Lists are included and mode says which. For Lists other accounts added this user to, use tweetapi_user_list_memberships.",
    method: "GET",
    path: "/tw-v2/user/lists",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "lists",
  },
  {
    name: "tweetapi_user_list_memberships",
    title: "Get User List Memberships",
    description:
      "Fetch one page of the Lists a user has been added to as a member (the Member of view on x.com). They can be owned by any account, so check owner on each List; Private Lists are included and mode says which. For the user's own Lists tab, use tweetapi_user_lists.",
    method: "GET",
    path: "/tw-v2/user/list-memberships",
    inputSchema: { userId, cursor: optionalCursor, responseFormat },
    compactKind: "lists",
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
      responseFormat,
    },
    compactKind: "search",
  },
  {
    name: "tweetapi_tweet_details",
    title: "Get Tweet Details",
    description:
      "Fetch one tweet with full details, its parent tweets when it is a reply, and a page of replies. Accepts a post ID or post link. Use tweetapi_tweet_metrics for counts only, or tweetapi_tweet_details_by_ids for many tweets.",
    method: "GET",
    path: "/tw-v2/tweet/details",
    inputSchema: {
      tweetId,
      sortBy: tweetSortBy.default("Relevance"),
      cursor: optionalCursor,
      responseFormat,
    },
    compactKind: "tweetDetails",
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_tweet_metrics",
    title: "Get Tweet Metrics",
    description:
      "Fetch only the engagement counts (likes, retweets, replies, quotes, bookmarks, views) for one tweet, without the conversation. Accepts a post ID or post link. Use tweetapi_tweet_details for the full tweet.",
    method: "GET",
    path: "/tw-v2/tweet/details",
    inputSchema: { tweetId },
    responseShape: "tweetMetrics",
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_tweet_details_by_ids",
    title: "Get Tweet Details By IDs",
    description:
      "Fetch details for up to 200 tweets in one call by post ID or post link. No replies are included. Missing posts are listed in completeness.notReturned.",
    method: "GET",
    path: "/tw-v2/tweet/details-by-ids",
    inputSchema: { ids: tweetIdList, responseFormat },
    compactKind: "tweetLookup",
    identifiers: { ids: "tweetList" },
    batch: { field: "ids", kind: "tweetIds" },
  },
  {
    name: "tweetapi_tweet_quotes",
    title: "Get Tweet Quotes",
    description: "Fetch one page of tweets that quote a given tweet, by post ID or post link.",
    method: "GET",
    path: "/tw-v2/tweet/quotes",
    inputSchema: { tweetId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_tweet_retweets",
    title: "Get Tweet Retweets",
    description: "Fetch one page of users who retweeted a given tweet, by post ID or post link.",
    method: "GET",
    path: "/tw-v2/tweet/retweets",
    inputSchema: { tweetId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_tweet_hidden_replies",
    title: "Get Hidden Replies",
    description:
      "Fetch one page of the replies that a post's author has hidden, by post ID or post link. Hidden replies are public on X. A post without hidden replies returns an empty page.",
    method: "GET",
    path: "/tw-v2/tweet/hidden-replies",
    inputSchema: { tweetId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_tweet_translate",
    title: "Translate Tweet",
    description: "Translate public tweet text without changing the tweet.",
    method: "POST",
    path: "/tw-v2/tweet/translate",
    inputSchema: {
      tweetId,
      dstLang: z.string().min(2).max(5),
    },
    bodyFields: ["tweetId", "dstLang"],
    identifiers: { tweetId: "tweet" },
  },
  {
    name: "tweetapi_list_details",
    title: "Get List Details",
    description: "Fetch public details for a list.",
    method: "GET",
    path: "/tw-v2/list/details",
    inputSchema: { listId },
    identifiers: { listId: "list" },
  },
  {
    name: "tweetapi_list_tweets",
    title: "Get List Tweets",
    description: "Fetch one page of the tweet timeline for a list.",
    method: "GET",
    path: "/tw-v2/list/tweets",
    inputSchema: { listId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
    identifiers: { listId: "list" },
  },
  {
    name: "tweetapi_list_members",
    title: "Get List Members",
    description: "Fetch one page of the accounts that are members of a list.",
    method: "GET",
    path: "/tw-v2/list/members",
    inputSchema: { listId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
    identifiers: { listId: "list" },
  },
  {
    name: "tweetapi_list_followers",
    title: "Get List Followers",
    description:
      "Fetch one page of the accounts that follow (subscribe to) a list. Use tweetapi_list_members for the accounts in the list.",
    method: "GET",
    path: "/tw-v2/list/followers",
    inputSchema: { listId, cursor: optionalCursor, responseFormat },
    compactKind: "users",
    identifiers: { listId: "list" },
  },
  {
    name: "tweetapi_list_search",
    title: "Search Lists",
    description:
      "Search X Lists by keyword and fetch one page of matching Lists. A page can be short without being the last one. Use the List IDs with tweetapi_list_tweets or tweetapi_list_members.",
    method: "GET",
    path: "/tw-v2/list/search",
    inputSchema: { query: z.string().min(1).max(512), cursor: optionalCursor, responseFormat },
    compactKind: "lists",
  },
  {
    name: "tweetapi_community_details",
    title: "Get Community Details",
    description: "Fetch public details for a community.",
    method: "GET",
    path: "/tw-v2/community/details",
    inputSchema: { communityId },
    identifiers: { communityId: "community" },
  },
  {
    name: "tweetapi_community_tweets",
    title: "Get Community Tweets",
    description: "Fetch one page of tweets posted in a community.",
    method: "GET",
    path: "/tw-v2/community/tweets",
    inputSchema: {
      communityId,
      sortBy: communitySortBy.default("Relevance"),
      cursor: optionalCursor,
      responseFormat,
    },
    compactKind: "tweets",
    identifiers: { communityId: "community" },
  },
  {
    name: "tweetapi_community_media",
    title: "Get Community Media",
    description:
      "Fetch one page of posts with photos or videos from a community, as on its Media tab, by community ID or community link.",
    method: "GET",
    path: "/tw-v2/community/media",
    inputSchema: { communityId, cursor: optionalCursor, responseFormat },
    compactKind: "tweets",
    identifiers: { communityId: "community" },
  },
  {
    name: "tweetapi_community_members",
    title: "Get Community Members",
    description: "Fetch one page of a community's members.",
    method: "GET",
    path: "/tw-v2/community/members",
    inputSchema: { communityId, cursor: optionalCursor, responseFormat },
    compactKind: "communityMembers",
    identifiers: { communityId: "community" },
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
      "Fetch details for a Space by its space ID or Space link, including the media key needed for tweetapi_space_stream_url.",
    method: "GET",
    path: "/tw-v2/space/by-id",
    inputSchema: { spaceId },
    identifiers: { spaceId: "space" },
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
  {
    name: "tweetapi_trends",
    title: "Get Trends",
    description:
      "Fetch the trending topics X shows worldwide, in a country, or at a location. Pass country (a two-letter code such as US) or woeid (from tweetapi_trend_locations), not both; omit both for worldwide. Not every country is supported, and an unsupported one returns not found instead of worldwide trends.",
    method: "GET",
    path: "/tw-v2/trends",
    inputSchema: { country: trendCountry, woeid: trendWoeid },
    exclusiveInputs: ["country", "woeid"],
  },
  {
    name: "tweetapi_trend_locations",
    title: "Get Trend Locations",
    description:
      "List the locations X serves trends for: worldwide, a set of countries and many cities, each with the woeid and countryCode to pass to tweetapi_trends. Not paginated.",
    method: "GET",
    path: "/tw-v2/trends/locations",
    inputSchema: {},
  },
  {
    name: "tweetapi_account_usage",
    title: "Get Account Usage",
    description:
      "Check the units left on the TweetAPI API key behind this connection: available units, plan allowance, PAYG balance, and the per-minute rate limit. Costs 0 units and counts toward the per-minute limit. Shows only this key; it cannot change anything.",
    method: "GET",
    path: "/tw-v2/account/usage",
    inputSchema: {},
    responseShape: "accountUsage",
  },
];

const costOutputSchema = z.object({
  basis: z.literal("estimate"),
  estimatedUnits: z.number().int().min(0).nullable(),
  reason: z.string(),
  source: z.string(),
});

export const LIVE_TOOL_OUTPUT_SCHEMA = {
  tool: z.string(),
  mode: z.literal("hosted-read-only"),
  notice: z.string(),
  endpoint: z.object({ method: z.enum(["GET", "POST"]), path: z.string() }),
  statusCode: z.number().int(),
  retrievedAt: z
    .string()
    .describe(
      "When the MCP server received this response (ISO 8601). Not the post or profile date, and not a promise that X's data was fresh at that moment."
    ),
  resolvedInput: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Identifiers the MCP server parsed from links or @handles before calling TweetAPI."),
  pagination: z.unknown().optional().describe("Pagination exactly as TweetAPI returned it."),
  completeness: z.object({
    scope: z.enum(["page", "batch", "single"]),
    nextCursor: z.string().nullable(),
    moreAvailable: z.boolean().nullable(),
    itemCount: z.number().int().nullable(),
    requestedCount: z.number().int().optional(),
    notReturned: z.array(z.string()).optional(),
    note: z.string(),
  }),
  output: z.object({
    format: z
      .enum(["full", "compact", "metrics"])
      .describe("metrics is tweetapi_tweet_metrics' own projection, not TweetAPI's JSON."),
    fieldsOmitted: z.array(z.string()),
    itemsOmitted: z.literal(0),
    textTruncated: z.boolean(),
  }),
  cost: costOutputSchema,
  usageDocs: z.string().optional(),
  result: z.unknown(),
};

export function createLiveToolDefinitions(options: LiveToolsOptions): LiveToolDefinition[] {
  return LIVE_TOOL_ENDPOINTS.map((endpoint) => ({
    name: endpoint.name,
    title: endpoint.title,
    description:
      endpoint.responseShape === "accountUsage"
        ? endpoint.description
        : `${LIVE_TOOL_NOTICE} ${endpoint.description}`,
    inputSchema: endpoint.inputSchema,
    outputSchema: LIVE_TOOL_OUTPUT_SCHEMA,
    handler: async (args) => runLiveRequest(endpoint, args, options),
  }));
}

type NormalizedArgs = {
  forwarded: Record<string, unknown>;
  resolved: Record<string, ResolvedIdentifier | ResolvedIdentifier[]>;
  converted: boolean;
};

function normalizeArgs(endpoint: LiveToolEndpoint, args: Record<string, unknown>): NormalizedArgs {
  const forwarded: Record<string, unknown> = {};
  const resolved: Record<string, ResolvedIdentifier | ResolvedIdentifier[]> = {};
  let converted = false;

  const supplied = (endpoint.exclusiveInputs ?? []).filter(
    (field) => args[field] !== undefined && args[field] !== null && args[field] !== ""
  );
  if (supplied.length > 1) {
    throw new IdentifierInputError(
      supplied[1],
      `Use only one of ${supplied.join(" and ")}. They cannot be combined.`
    );
  }

  for (const [field, value] of Object.entries(args)) {
    // Forward only declared inputs. The MCP SDK already strips unknown keys; this keeps direct
    // handler calls equally strict.
    if (MCP_ONLY_FIELDS.has(field) || !(field in endpoint.inputSchema)) continue;

    const kind = endpoint.identifiers?.[field];
    if (!kind || value === undefined) {
      forwarded[field] = value;
      continue;
    }

    const parsed = parseIdentifierField(field, kind, value);
    const parts = Array.isArray(parsed) ? parsed : [parsed];
    if (parts.some((part) => part.source === "link" || part.source === "handle")) {
      converted = true;
    }

    resolved[field] = parsed;
    forwarded[field] = Array.isArray(parsed) ? parsed.map((part) => part.value) : parsed.value;
  }

  return { forwarded, resolved, converted };
}

function parseIdentifierField(
  field: string,
  kind: IdentifierKind,
  value: unknown
): ResolvedIdentifier | ResolvedIdentifier[] {
  if (kind === "tweetList") {
    return parseIdentifierList(field, value, 200, parseTweetIdentifier);
  }

  if (kind === "usernameList") {
    return parseIdentifierList(field, value, 100, parseUsernameIdentifier);
  }

  if (typeof value !== "string") {
    throw new IdentifierInputError(field, `${field} must be a string.`);
  }

  switch (kind) {
    case "tweet":
      return parseTweetIdentifier(field, value);
    case "username":
      return parseUsernameIdentifier(field, value);
    case "list":
      return parseListIdentifier(field, value);
    case "community":
      return parseCommunityIdentifier(field, value);
    case "space":
      return parseSpaceIdentifier(field, value);
  }
}

function requestedBatchValues(value: unknown): string[] {
  const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function endpointRef(endpoint: LiveToolEndpoint) {
  return { method: endpoint.method, path: endpoint.path };
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
        "Live TweetAPI tools require a TweetAPI API key. Hosted MCP clients must use a dashboard-backed MCP grant token, and local stdio live mode must set TWEETAPI_API_KEY.",
      { layer: "mcp_connection", cost: noRequestSentCost() }
    );
  }

  let normalized: NormalizedArgs;
  try {
    normalized = normalizeArgs(endpoint, args);
  } catch (error) {
    if (error instanceof IdentifierInputError) {
      return jsonError("TWEETAPI_INVALID_INPUT", error.message, {
        layer: "mcp_input",
        field: error.field,
        endpoint: endpointRef(endpoint),
        cost: noRequestSentCost(),
      });
    }

    throw error;
  }

  const fetchTimeoutMs =
    options.fetchTimeoutMs ??
    readPositiveIntegerEnv("MCP_LIVE_FETCH_TIMEOUT_MS", DEFAULT_LIVE_FETCH_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  try {
    const apiBaseUrl = resolveTweetApiBaseUrl(
      options.apiBaseUrl ?? process.env.TWEETAPI_API_BASE_URL
    );
    const request = buildUpstreamRequest(
      endpoint,
      normalized.forwarded,
      apiBaseUrl,
      options.apiKey
    );
    const response = await fetchWithTimeout(fetchImpl, request.url, request.init, fetchTimeoutMs);
    const result = await readUpstreamResponse(response);
    const retrievedAt = now().toISOString();

    if (!response.ok) {
      return mapHttpError(endpoint, response, result);
    }

    const format: ResponseFormat =
      endpoint.compactKind && args.responseFormat === "compact" ? "compact" : "full";
    const pagination = extractPagination(result, { zeroCursorEnds: endpoint.zeroCursorEnds });
    const payload: Record<string, unknown> = {
      tool: endpoint.name,
      mode: "hosted-read-only",
      notice: endpoint.responseShape === "accountUsage" ? ACCOUNT_USAGE_NOTICE : LIVE_TOOL_NOTICE,
      endpoint: endpointRef(endpoint),
      statusCode: response.status,
      retrievedAt,
    };

    if (normalized.converted) {
      payload.resolvedInput = normalized.resolved;
    }

    if (endpoint.responseShape === "tweetMetrics") {
      payload.completeness = buildCompleteness({ paginated: false, result, nextCursor: null });
      const metrics = buildTweetMetrics(result);
      payload.output = metricsOutputInfo(metrics.tweet?.textTruncated ?? false);
      payload.cost = estimateCallCost(endpoint.method, endpoint.path, response.status);
      payload.result = metrics;
      return jsonStructured(payload);
    }

    payload.pagination = pagination.raw;
    payload.completeness = buildCompleteness({
      paginated: "cursor" in endpoint.inputSchema,
      kind: endpoint.compactKind,
      batch: endpoint.batch
        ? {
            kind: endpoint.batch.kind,
            requested: requestedBatchValues(normalized.forwarded[endpoint.batch.field]),
          }
        : undefined,
      result,
      nextCursor: pagination.nextCursor,
      endCursor: pagination.endCursor,
    });
    payload.output = outputInfo(format, endpoint.compactKind);
    payload.cost = estimateCallCost(endpoint.method, endpoint.path, response.status);
    payload.result =
      format === "compact" && endpoint.compactKind
        ? compactResult(endpoint.compactKind, result, stringArg(normalized.forwarded.type))
        : result;

    if (endpoint.responseShape === "accountUsage") {
      payload.usageDocs = USAGE_DOCS_URL;
    }

    return jsonStructured(payload);
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return jsonError(
        "TWEETAPI_UPSTREAM_TIMEOUT",
        `TweetAPI upstream request timed out after ${error.timeoutMs}ms. The MCP server did not retry.`,
        {
          layer: "network",
          retryable: true,
          endpoint: endpointRef(endpoint),
          cost: unknownOutcomeCost(),
        }
      );
    }

    if (error instanceof ApiBaseUrlConfigError) {
      return jsonError("TWEETAPI_CONFIG_ERROR", error.message, {
        layer: "mcp_server",
        expectedBaseUrl: DEFAULT_API_BASE_URL,
        cost: noRequestSentCost(),
      });
    }

    return jsonError(
      "TWEETAPI_REQUEST_FAILED",
      error instanceof Error ? error.message : "TweetAPI request failed",
      {
        layer: "network",
        retryable: true,
        endpoint: endpointRef(endpoint),
        cost: unknownOutcomeCost(),
      }
    );
  }
}

function stringArg(value: unknown) {
  return typeof value === "string" ? value : undefined;
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

// Retry-After is either delay-seconds or an HTTP date. Returns whole seconds, or undefined.
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, Math.ceil((date - nowMs) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

type LimitReason = "rate_limited" | "quota_exhausted" | "subscription_inactive" | "unknown";

function limitReason(upstreamCode: string | undefined): LimitReason {
  if (upstreamCode === "RATE_LIMITED") return "rate_limited";
  if (upstreamCode === "QUOTA_EXHAUSTED") return "quota_exhausted";
  if (upstreamCode === "SUBSCRIPTION_INACTIVE") return "subscription_inactive";
  return "unknown";
}

function mapHttpError(endpoint: LiveToolEndpoint, response: Response, responseBody: unknown) {
  const statusCode = response.status;
  const upstreamCode =
    isRecord(responseBody) && typeof responseBody.code === "string" ? responseBody.code : undefined;
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
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
  const reason = statusCode === 429 ? limitReason(upstreamCode) : undefined;
  const retryable =
    statusCode >= 500 || reason === "rate_limited" || (statusCode === 429 && reason === "unknown");

  const details: Record<string, unknown> = {
    layer: statusCode === 401 || statusCode === 403 ? "tweetapi_api_key" : "tweetapi_api",
    statusCode,
    retryable,
    endpoint: endpointRef(endpoint),
    cost: estimateCallCost(endpoint.method, endpoint.path, statusCode),
    response: responseBody,
  };

  if (reason) details.reason = reason;
  if (upstreamCode) details.upstreamCode = upstreamCode;
  if (retryAfterSeconds !== undefined) details.retryAfterSeconds = retryAfterSeconds;

  return jsonError(code, httpErrorMessage(statusCode, reason, retryAfterSeconds), details);
}

function httpErrorMessage(statusCode: number, reason?: LimitReason, retryAfterSeconds?: number) {
  const usageHint = "tweetapi_account_usage shows the units left (free to call).";
  const wait =
    retryAfterSeconds !== undefined ? ` TweetAPI asked to wait ${retryAfterSeconds}s.` : "";

  if (statusCode === 401) {
    return "MCP sign-in worked, but TweetAPI did not accept the API key behind this connection. The key may be inactive or have no plan or PAYG balance. Check it in the TweetAPI dashboard, or reconnect and choose another key.";
  }

  if (statusCode === 403) {
    return "TweetAPI refused this request for the current API key or plan.";
  }

  if (statusCode === 429) {
    if (reason === "rate_limited") {
      return `TweetAPI per-minute rate limit reached. Wait before calling again; the MCP server does not retry.${wait}`;
    }
    if (reason === "quota_exhausted") {
      return `TweetAPI units are used up for this API key. Waiting will not help: top up PAYG or change plan. ${usageHint}`;
    }
    if (reason === "subscription_inactive") {
      return `The TweetAPI plan for this API key is not active. Renew the plan or add PAYG units. ${usageHint}`;
    }
    return `TweetAPI rate limit or quota was exceeded. Retry later or check usage.${wait} ${usageHint}`;
  }

  if (statusCode === 404) {
    return "TweetAPI found nothing for this request. The item may be deleted, suspended, protected, or may never have existed; TweetAPI cannot tell which.";
  }

  if (statusCode >= 500) {
    return `TweetAPI returned a temporary upstream error (HTTP ${statusCode}). The MCP server did not retry; you can try again.${wait}`;
  }

  return "TweetAPI request failed.";
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

  const text = pickString(tweet, "text");
  const textPreview = truncateText(text, 280);
  const id = pickString(tweet, "id");
  const author = summarizeAuthor(tweet.author);

  return {
    tweet: {
      id,
      url: tweetUrl(id, author?.username ?? null),
      textPreview,
      textTruncated: text !== null && textPreview !== text,
      textLength: text?.length ?? null,
      author,
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
