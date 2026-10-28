// Shapes TweetAPI responses for MCP results. Compact mode removes bulky fields but never drops
// items, never shortens post text, and keeps IDs, links, original dates, counts, and cursors.
// Everything here works on the response TweetAPI already returned; nothing is fetched or invented.

export type CompactKind =
  | "user"
  | "users"
  | "tweets"
  | "search"
  | "tweetDetails"
  | "tweetLookup"
  | "communityMembers";

export type BatchKind = "usernames" | "userIds" | "tweetIds";

export type ResponseFormat = "full" | "compact";

export type OutputInfo = {
  format: ResponseFormat | "metrics";
  fieldsOmitted: string[];
  itemsOmitted: 0;
  textTruncated: boolean;
};

export type Completeness = {
  scope: "page" | "batch" | "single";
  nextCursor: string | null;
  moreAvailable: boolean | null;
  itemCount: number | null;
  requestedCount?: number;
  notReturned?: string[];
  note: string;
};

const MAX_NESTED_TWEET_DEPTH = 1;
const USERNAME = /^[A-Za-z0-9_]{1,50}$/;

const TWEET_FIELDS_OMITTED = [
  "author profile details other than identity and verification (use a user tool for bio and counts)",
  "media display URL, dimensions, size variants, other video variants, duration, view stats, features, and processing details (the best video variant URL is kept)",
  "card platform and binding details other than url, title, description, and domain",
  "edit control, conversation control, reaction context, and community result details",
  "promoted-post (ad) metadata (hasAIGeneratedMedia and isPaidPromotion disclosures are kept)",
  "place bounding box and geometry (place name, country, type, and url are kept)",
  "poll alias fields and the vote state of the account TweetAPI fetched with",
  "display text range and Community Notes pivot details (hasBirdwatchNotes is kept)",
  "article cover image URL (article id, title, text, and previewText are kept)",
  "posts nested deeper than one quote or repost level are reduced to id and url",
];

const USER_FIELDS_OMITTED = [
  "banner, profile image shape, and default-profile flags",
  "professional, business, creator, highlights, and affiliate details",
  "profile capability flags such as translation and graduated access",
];

export function outputInfo(format: ResponseFormat, kind: CompactKind | undefined): OutputInfo {
  if (format === "full" || !kind) {
    return { format, fieldsOmitted: [], itemsOmitted: 0, textTruncated: false };
  }

  const fieldsOmitted =
    kind === "user" || kind === "users" || kind === "communityMembers"
      ? USER_FIELDS_OMITTED
      : kind === "search"
        ? [...TWEET_FIELDS_OMITTED, ...USER_FIELDS_OMITTED.map((field) => `users: ${field}`)]
        : TWEET_FIELDS_OMITTED;

  return { format, fieldsOmitted: [...fieldsOmitted], itemsOmitted: 0, textTruncated: false };
}

const METRICS_FIELDS_OMITTED = [
  "post text beyond the 280-character textPreview (result.tweet.textTruncated and textLength say when)",
  "parent posts, replies, and the reply cursor",
  "media, card, poll, article, quoted post, and repost content (only has/is flags are kept)",
  "links, hashtags, mentions, symbols, conversation ID, source, and edit details",
  "author profile details other than identity, avatar, and verification",
];

// tweetapi_tweet_metrics returns its own projection, not TweetAPI's JSON.
export function metricsOutputInfo(textTruncated: boolean): OutputInfo {
  return {
    format: "metrics",
    fieldsOmitted: [...METRICS_FIELDS_OMITTED],
    itemsOmitted: 0,
    textTruncated,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function num(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(record: Record<string, unknown>, field: string): boolean | null {
  const value = record[field];
  return typeof value === "boolean" ? value : null;
}

function strings(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function tweetUrl(id: string | null, username: string | null): string | null {
  if (!id) return null;
  return username && USERNAME.test(username)
    ? `https://x.com/${username}/status/${id}`
    : `https://x.com/i/status/${id}`;
}

export function userUrl(id: string | null, username: string | null): string | null {
  if (username && USERNAME.test(username)) return `https://x.com/${username}`;
  return id ? `https://x.com/i/user/${id}` : null;
}

export function compactUser(value: unknown): unknown {
  if (!isRecord(value)) return value ?? null;

  const id = str(value, "id");
  const username = str(value, "username");

  return {
    id,
    username,
    name: str(value, "name"),
    url: userUrl(id, username),
    bio: str(value, "bio"),
    location: str(value, "location"),
    website: str(value, "website"),
    createdAt: str(value, "createdAt"),
    avatar: str(value, "avatar"),
    followerCount: num(value, "followerCount"),
    followingCount: num(value, "followingCount"),
    tweetCount: num(value, "tweetCount"),
    listedCount: num(value, "listedCount"),
    mediaCount: num(value, "mediaCount"),
    favoritesCount: num(value, "favoritesCount"),
    verified: bool(value, "verified"),
    isBlueVerified: bool(value, "isBlueVerified"),
    verifiedType: str(value, "verifiedType"),
    isProtected: bool(value, "isProtected"),
    verifiedSince: str(value, "verifiedSince"),
    isIdentityVerified: bool(value, "isIdentityVerified"),
    possiblySensitive: bool(value, "possiblySensitive"),
    profileInterstitialType: str(value, "profileInterstitialType"),
    pinnedTweetIds: strings(value, "pinnedTweetIds"),
    withheldInCountries: strings(value, "withheldInCountries"),
  };
}

function compactAuthor(value: unknown) {
  if (!isRecord(value)) return null;

  const id = str(value, "id");
  const username = str(value, "username");

  return {
    id,
    username,
    name: str(value, "name"),
    url: userUrl(id, username),
    verified: bool(value, "verified"),
    isBlueVerified: bool(value, "isBlueVerified"),
    verifiedType: str(value, "verifiedType"),
    isProtected: bool(value, "isProtected"),
    verifiedSince: str(value, "verifiedSince"),
    isIdentityVerified: bool(value, "isIdentityVerified"),
  };
}

function bestVideoUrl(media: Record<string, unknown>): string | null {
  const info = media.videoInfo;
  if (!isRecord(info) || !Array.isArray(info.variants)) return null;

  let best: { url: string; bitrate: number } | null = null;
  for (const variant of info.variants) {
    if (!isRecord(variant)) continue;
    const url = str(variant, "url");
    const contentType = str(variant, "contentType") ?? str(variant, "content_type");
    if (!url || (contentType && contentType !== "video/mp4")) continue;
    const bitrate = num(variant, "bitrate") ?? 0;
    if (!best || bitrate > best.bitrate) best = { url, bitrate };
  }

  return best?.url ?? null;
}

function compactMedia(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((media) => {
    const availability = isRecord(media.mediaAvailability) ? media.mediaAvailability : null;

    return {
      id: str(media, "id"),
      key: str(media, "key"),
      type: str(media, "type"),
      url: str(media, "url"),
      expandedUrl: str(media, "expandedUrl"),
      thumbnailUrl: str(media, "thumbnailUrl"),
      videoUrl: bestVideoUrl(media),
      altText: str(media, "altText"),
      sensitiveMedia: bool(media, "sensitiveMedia"),
      availability: availability
        ? { status: str(availability, "status"), reason: str(availability, "reason") }
        : null,
      sourceStatusId: str(media, "sourceStatusId"),
      sourceUserId: str(media, "sourceUserId"),
    };
  });
}

function compactCard(value: unknown) {
  if (!isRecord(value)) return null;
  const binding = isRecord(value.bindingValues) ? value.bindingValues : {};

  return {
    url: str(value, "url"),
    title: str(binding, "title"),
    description: str(binding, "description"),
    domain: str(binding, "domain"),
  };
}

function compactPoll(value: unknown) {
  if (!isRecord(value)) return null;
  const options = Array.isArray(value.options) ? value.options.filter(isRecord) : [];

  return {
    id: str(value, "id"),
    options: options.map((option) => ({
      position: num(option, "position"),
      label: str(option, "label"),
      voteCount: num(option, "voteCount"),
      percentage: num(option, "percentage"),
    })),
    totalVotes: num(value, "totalVotes"),
    votingStatus: str(value, "votingStatus"),
    endDatetime: str(value, "endDatetime"),
    durationMinutes: num(value, "durationMinutes"),
  };
}

function compactArticle(value: unknown) {
  if (!isRecord(value)) return null;

  return {
    id: str(value, "id"),
    title: str(value, "title"),
    // previewText is X's short snippet. It can be the only body text TweetAPI returns, so it is kept
    // as its own field and never copied into text.
    text: str(value, "text"),
    previewText: str(value, "previewText"),
  };
}

function compactMentions(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((mention) => ({
    id: str(mention, "id"),
    username: str(mention, "username"),
    name: str(mention, "name"),
  }));
}

function compactPlace(value: unknown) {
  if (!isRecord(value)) return null;

  return {
    id: str(value, "id"),
    name: str(value, "name"),
    fullName: str(value, "fullName"),
    country: str(value, "country"),
    countryCode: str(value, "countryCode"),
    placeType: str(value, "placeType"),
    url: str(value, "url"),
  };
}

function tweetReference(value: Record<string, unknown>) {
  const id = str(value, "id");
  const author = isRecord(value.author) ? value.author : {};

  return {
    id,
    url: tweetUrl(id, str(author, "username")),
    omitted: "Nested too deep for compact output. Fetch this post by ID for its content.",
  };
}

export function compactTweet(value: unknown, depth = 0): unknown {
  if (!isRecord(value)) return value ?? null;
  if (depth > MAX_NESTED_TWEET_DEPTH) return tweetReference(value);

  const id = str(value, "id");
  const author = compactAuthor(value.author);
  const replyTo = isRecord(value.replyTo)
    ? {
        tweetId: str(value.replyTo, "tweetId"),
        userId: str(value.replyTo, "userId"),
        username: str(value.replyTo, "username"),
      }
    : null;

  return {
    id,
    url: tweetUrl(id, author?.username ?? null),
    text: str(value, "text"),
    createdAt: str(value, "createdAt"),
    lang: str(value, "lang"),
    type: str(value, "type"),
    conversationId: str(value, "conversationId"),
    author,
    replyTo,
    metrics: {
      likeCount: num(value, "likeCount"),
      retweetCount: num(value, "retweetCount"),
      replyCount: num(value, "replyCount"),
      quoteCount: num(value, "quoteCount"),
      bookmarkCount: num(value, "bookmarkCount"),
      viewCount: num(value, "viewCount"),
    },
    media: compactMedia(value.media),
    urls: strings(value, "urls"),
    hashtags: strings(value, "hashtags"),
    mentions: compactMentions(value.mentions),
    symbols: strings(value, "symbols"),
    card: compactCard(value.card),
    poll: compactPoll(value.poll),
    article: compactArticle(value.article),
    quotedTweet: isRecord(value.quotedTweet) ? compactTweet(value.quotedTweet, depth + 1) : null,
    retweetedTweet: isRecord(value.retweetedTweet)
      ? compactTweet(value.retweetedTweet, depth + 1)
      : null,
    isEdited: bool(value, "isEdited"),
    possiblySensitive: bool(value, "possiblySensitive"),
    limitedActions: str(value, "limitedActions"),
    hasAIGeneratedMedia: bool(value, "hasAIGeneratedMedia"),
    isPaidPromotion: bool(value, "isPaidPromotion"),
    isTranslatable: bool(value, "isTranslatable"),
    translatedText: str(value, "translatedText"),
    hasBirdwatchNotes: bool(value, "hasBirdwatchNotes"),
    place: compactPlace(value.place),
    communityId: str(value, "communityId"),
    source: str(value, "source"),
  };
}

function dataOf(result: unknown): unknown {
  return isRecord(result) && "data" in result ? result.data : undefined;
}

function mapArray(value: unknown, mapper: (item: unknown) => unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => mapper(item)) : [];
}

function compactSearchItem(item: unknown): unknown {
  if (isRecord(item) && (item.type === "tweet" || item.type === "user") && "content" in item) {
    return item.type === "tweet"
      ? { type: "tweet", tweet: compactTweet(item.content) }
      : { type: "user", user: compactUser(item.content) };
  }

  return item;
}

function compactCommunityMember(item: unknown): unknown {
  if (!isRecord(item)) return item;

  return {
    role: str(item, "role"),
    user: compactUser(item.user),
  };
}

export function compactResult(kind: CompactKind, result: unknown, searchType?: string): unknown {
  const data = dataOf(result);

  switch (kind) {
    case "user":
      return { user: compactUser(data) };
    case "users":
      return { users: mapArray(data, compactUser) };
    case "tweets":
      return { tweets: mapArray(data, (item) => compactTweet(item)) };
    case "search":
      if (searchType === "People") return { users: mapArray(data, compactUser) };
      if (searchType === "Top") return { items: mapArray(data, compactSearchItem) };
      return { tweets: mapArray(data, (item) => compactTweet(item)) };
    case "communityMembers":
      return { members: mapArray(data, compactCommunityMember) };
    case "tweetDetails": {
      const details = isRecord(data) ? data : {};
      return {
        tweet: isRecord(details.tweet) ? compactTweet(details.tweet) : null,
        ancestors: mapArray(details.ancestors, (item) => compactTweet(item)),
        replies: mapArray(details.replies, (item) => compactTweet(item)),
      };
    }
    case "tweetLookup": {
      const lookup = isRecord(data) ? data : {};
      return { tweets: mapArray(lookup.tweets, (item) => compactTweet(item)) };
    }
  }
}

function cleanCursor(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Returns the pagination object as TweetAPI sent it (kept for compatibility), plus the next cursor.
// zeroCursorEnds is for the X v1.1 follower and following routes, where a next cursor of exactly
// "0" means there are no more pages. Other families use opaque cursors (some start with "0|").
export function extractPagination(
  result: unknown,
  options: { zeroCursorEnds?: boolean } = {}
): {
  raw: unknown;
  nextCursor: string | null;
  endCursor?: string;
} {
  if (!isRecord(result)) {
    return { raw: undefined, nextCursor: null };
  }

  if (isRecord(result.pagination)) {
    const nextCursor = cleanCursor(result.pagination.nextCursor ?? result.pagination.next_cursor);
    if (options.zeroCursorEnds && nextCursor === "0") {
      return { raw: result.pagination, nextCursor: null, endCursor: nextCursor };
    }
    return { raw: result.pagination, nextCursor };
  }

  if (isRecord(result.pageInfo)) {
    return {
      raw: result.pageInfo,
      nextCursor: cleanCursor(result.pageInfo.nextCursor ?? result.pageInfo.next_cursor),
    };
  }

  const topLevel = pickDefined(result, [
    "cursor",
    "nextCursor",
    "next_cursor",
    "previousCursor",
    "prevCursor",
  ]);

  if (topLevel) {
    return {
      raw: topLevel,
      nextCursor: cleanCursor(result.nextCursor ?? result.next_cursor),
    };
  }

  // Tweet details returns its reply cursor inside data.
  if (isRecord(result.data) && "nextCursor" in result.data) {
    const nextCursor = cleanCursor(result.data.nextCursor);
    return { raw: { nextCursor }, nextCursor };
  }

  return { raw: undefined, nextCursor: null };
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

function countItems(kind: CompactKind | undefined, result: unknown): number | null {
  const data = dataOf(result);

  if (Array.isArray(data)) return data.length;
  if (kind === "tweetDetails" && isRecord(data) && Array.isArray(data.replies)) {
    return data.replies.length;
  }
  if (kind === "tweetLookup" && isRecord(data) && Array.isArray(data.tweets)) {
    return data.tweets.filter((tweet) => tweet !== null).length;
  }

  return null;
}

const PAGE_NOTE =
  "This is one page. A nextCursor means more results may exist: call again with it as cursor. A missing cursor does not prove the list is complete, because X can cap or hide results.";
const BATCH_NOTE =
  "Requested items in notReturned came back missing. X does not say why: they may be deleted, suspended, protected, renamed, or never existed.";
const SINGLE_NOTE = "One object, returned as TweetAPI sent it at retrievedAt.";
const END_CURSOR_NOTE =
  'This is the last page: TweetAPI returned nextCursor "0", which this X endpoint uses to mean there are no more pages. Do not call again with it.';

export function buildCompleteness(options: {
  paginated: boolean;
  kind?: CompactKind;
  batch?: { kind: BatchKind; requested: string[] };
  result: unknown;
  nextCursor: string | null;
  endCursor?: string;
}): Completeness {
  const itemCount = countItems(options.kind, options.result);

  if (options.batch) {
    return {
      scope: "batch",
      nextCursor: null,
      moreAvailable: false,
      itemCount,
      requestedCount: options.batch.requested.length,
      notReturned: findNotReturned(options.batch.kind, options.batch.requested, options.result),
      note: BATCH_NOTE,
    };
  }

  if (options.paginated) {
    return {
      scope: "page",
      nextCursor: options.nextCursor,
      moreAvailable: options.nextCursor !== null,
      itemCount,
      note: options.endCursor !== undefined ? END_CURSOR_NOTE : PAGE_NOTE,
    };
  }

  return {
    scope: "single",
    nextCursor: null,
    moreAvailable: null,
    itemCount,
    note: SINGLE_NOTE,
  };
}

function findNotReturned(kind: BatchKind, requested: string[], result: unknown): string[] {
  const data = dataOf(result);

  if (kind === "tweetIds") {
    const tweets = isRecord(data) && Array.isArray(data.tweets) ? data.tweets : [];
    // TweetAPI keeps request order and returns null for each post it could not load.
    if (tweets.length === requested.length) {
      return requested.filter((_, index) => !isRecord(tweets[index]));
    }

    const found = new Set(
      tweets
        .filter(isRecord)
        .map((tweet) => str(tweet, "id"))
        .filter((id): id is string => !!id)
    );
    return requested.filter((id) => !found.has(id));
  }

  const users = Array.isArray(data) ? data.filter(isRecord) : [];

  if (kind === "userIds") {
    const found = new Set(users.map((user) => str(user, "id")).filter((id): id is string => !!id));
    return requested.filter((id) => !found.has(id));
  }

  const found = new Set(
    users
      .map((user) => str(user, "username")?.toLowerCase())
      .filter((username): username is string => !!username)
  );
  return requested.filter((username) => !found.has(username.toLowerCase()));
}
