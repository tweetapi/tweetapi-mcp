import { describe, expect, it } from "vitest";

import {
  buildCompleteness,
  compactResult,
  compactTweet,
  compactUser,
  extractPagination,
  metricsOutputInfo,
  outputInfo,
} from "./results.js";

const LONG_ID = "1985432109876543219";
// Long-form posts can run to thousands of characters; compact output must keep every one.
const LONG_TEXT = `Start ${"evidence ".repeat(600)}end`;

// Field names follow TwitAPI's v3 User and Tweet transformer types.
function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "44196397",
    username: "elonmusk",
    name: "Elon Musk",
    bio: "bio text",
    location: "Earth",
    website: "https://example.com",
    pinnedTweetIds: [LONG_ID],
    avatar: "https://pbs.twimg.com/profile_images/1/a.jpg",
    banner: "https://pbs.twimg.com/profile_banners/1/b.jpg",
    profileImageShape: "Circle",
    verified: false,
    isBlueVerified: true,
    verifiedType: null,
    verifiedSince: null,
    isIdentityVerified: false,
    isProtected: false,
    possiblySensitive: false,
    profileInterstitialType: null,
    withheldInCountries: [],
    professional: { type: "Creator", category: [], restId: "1" },
    businessAccount: null,
    creatorSubscriptionsCount: 0,
    hasHiddenSubscriptions: false,
    highlightsInfo: null,
    hasGraduatedAccess: true,
    isProfileTranslatable: false,
    hasCustomTimelines: true,
    isTranslator: false,
    affiliatesHighlightedLabel: null,
    defaultProfile: false,
    defaultProfileImage: false,
    followerCount: 200000000,
    followingCount: 1000,
    tweetCount: 50000,
    listedCount: 150000,
    mediaCount: 3000,
    favoritesCount: 100000,
    createdAt: "Tue Jun 02 20:12:29 +0000 2009",
    ...overrides,
  };
}

function tweet(overrides: Record<string, unknown> = {}) {
  return {
    id: LONG_ID,
    conversationId: LONG_ID,
    text: LONG_TEXT,
    displayTextRange: [0, LONG_TEXT.length],
    author: user(),
    source: "Twitter for iPhone",
    type: "tweet",
    replyTo: null,
    quotedTweet: null,
    reactionContext: null,
    retweetedTweet: null,
    likeCount: 10,
    retweetCount: 2,
    replyCount: 3,
    quoteCount: 4,
    bookmarkCount: 5,
    viewCount: null,
    media: [
      {
        id: "9",
        key: "7_9",
        type: "video",
        url: "https://pbs.twimg.com/ext_tw_video_thumb/9.jpg",
        displayUrl: "pic.x.com/abc",
        expandedUrl: `https://x.com/elonmusk/status/${LONG_ID}/video/1`,
        thumbnailUrl: null,
        sizes: { thumb: {}, small: {}, medium: {}, large: {}, original: {} },
        videoInfo: {
          durationMillis: 1000,
          variants: [
            { contentType: "application/x-mpegURL", url: "https://video.twimg.com/pl.m3u8" },
            { bitrate: 256000, contentType: "video/mp4", url: "https://video.twimg.com/low.mp4" },
            { bitrate: 2176000, contentType: "video/mp4", url: "https://video.twimg.com/hi.mp4" },
          ],
        },
        altText: "a rocket",
        processingInfo: null,
      },
    ],
    poll: null,
    card: {
      name: "summary",
      url: "https://t.co/abc",
      cardType: "summary",
      bindingValues: { title: "Title", description: "Desc", domain: "example.com" },
      cardPlatform: { platform: { device: { name: "iPhone", version: "1" } } },
    },
    article: null,
    hashtags: ["space"],
    mentions: [{ id: "1", username: "jack", name: "jack" }],
    urls: ["https://example.com/a"],
    symbols: ["TSLA"],
    possiblySensitive: false,
    limitedActions: null,
    hasAIGeneratedMedia: false,
    isPaidPromotion: false,
    isEdited: false,
    editControl: { editTweetIds: [LONG_ID], editableUntil: "x", isEditEligible: true },
    isTranslatable: false,
    lang: "en",
    translatedText: null,
    hasBirdwatchNotes: false,
    birdwatchPivot: null,
    conversationControl: null,
    isPromoted: false,
    promotedMetadata: null,
    communityId: null,
    communityResults: null,
    createdAt: "Mon Oct 27 12:00:00 +0000 2026",
    place: null,
    ...overrides,
  };
}

describe("compact tweets", () => {
  it("keeps full text, exact IDs, links, original dates, counts, and evidence fields", () => {
    const compact = compactTweet(tweet()) as Record<string, unknown>;

    expect(compact).toMatchObject({
      id: LONG_ID,
      url: `https://x.com/elonmusk/status/${LONG_ID}`,
      text: LONG_TEXT,
      createdAt: "Mon Oct 27 12:00:00 +0000 2026",
      lang: "en",
      conversationId: LONG_ID,
      author: {
        id: "44196397",
        username: "elonmusk",
        url: "https://x.com/elonmusk",
        isBlueVerified: true,
      },
      metrics: {
        likeCount: 10,
        retweetCount: 2,
        replyCount: 3,
        quoteCount: 4,
        bookmarkCount: 5,
        viewCount: null,
      },
      media: [
        {
          id: "9",
          key: "7_9",
          type: "video",
          expandedUrl: `https://x.com/elonmusk/status/${LONG_ID}/video/1`,
          thumbnailUrl: null,
          videoUrl: "https://video.twimg.com/hi.mp4",
          altText: "a rocket",
        },
      ],
      urls: ["https://example.com/a"],
      hashtags: ["space"],
      mentions: [{ id: "1", username: "jack", name: "jack" }],
      symbols: ["TSLA"],
      card: { url: "https://t.co/abc", title: "Title", domain: "example.com" },
    });
    expect((compact.text as string).length).toBe(LONG_TEXT.length);
    expect(JSON.stringify(compact)).not.toContain("profile_banners");
    expect(JSON.stringify(compact)).not.toContain("editableUntil");
    expect(JSON.stringify(compact)).not.toContain("cardPlatform");
  });

  it("keeps one level of quoted and reposted posts in full, then references deeper ones", () => {
    const deepest = tweet({ id: "3", text: "deepest", author: user({ username: "c" }) });
    const quoted = tweet({
      id: "2",
      text: "quoted text kept",
      author: user({ username: "b" }),
      quotedTweet: deepest,
    });
    const compact = compactTweet(tweet({ type: "quote", quotedTweet: quoted })) as {
      quotedTweet: { text: string; quotedTweet: unknown };
    };

    expect(compact.quotedTweet.text).toBe("quoted text kept");
    expect(compact.quotedTweet.quotedTweet).toEqual({
      id: "3",
      url: "https://x.com/c/status/3",
      omitted: expect.stringContaining("Fetch this post by ID"),
    });
    expect(JSON.stringify(compact)).not.toContain("deepest");
  });

  it("returns null for missing fields instead of inventing values", () => {
    const compact = compactTweet({ id: "5" }) as Record<string, unknown>;

    expect(compact).toMatchObject({
      id: "5",
      url: "https://x.com/i/status/5",
      text: null,
      createdAt: null,
      author: null,
      metrics: { likeCount: null, viewCount: null },
      media: [],
      quotedTweet: null,
    });
  });

  it("keeps AI-generated media, paid promotion, limited action, and translation fields", () => {
    const flagged = compactTweet(
      tweet({
        hasAIGeneratedMedia: true,
        isPaidPromotion: true,
        limitedActions: "non_compliant",
        isTranslatable: true,
        lang: "es",
        translatedText: "Launch window opens tomorrow",
      })
    );
    expect(flagged).toMatchObject({
      hasAIGeneratedMedia: true,
      isPaidPromotion: true,
      limitedActions: "non_compliant",
      isTranslatable: true,
      lang: "es",
      translatedText: "Launch window opens tomorrow",
    });

    // TwitAPI sends false and null when a post has no disclosure or translation.
    expect(compactTweet(tweet())).toMatchObject({
      hasAIGeneratedMedia: false,
      isPaidPromotion: false,
      limitedActions: null,
      isTranslatable: false,
      translatedText: null,
    });

    // Missing fields stay null rather than defaulting to false.
    expect(compactTweet({ id: "5" })).toMatchObject({
      hasAIGeneratedMedia: null,
      isPaidPromotion: null,
      limitedActions: null,
      isTranslatable: null,
      translatedText: null,
      place: null,
    });
  });

  it("keeps mention names, media identity and thumbnails, place, and poll details", () => {
    const compact = compactTweet(
      tweet({
        mentions: [{ id: "783214", username: "X", name: "X" }],
        media: [
          {
            id: "1985432109876500001",
            key: "3_1985432109876500001",
            type: "photo",
            url: "https://pbs.twimg.com/media/Gabc.jpg",
            displayUrl: "pic.x.com/abc",
            expandedUrl: `https://x.com/elonmusk/status/${LONG_ID}/photo/1`,
            thumbnailUrl: "https://pbs.twimg.com/media/Gabc.jpg",
            width: 1200,
            height: 800,
            aspectRatio: [3, 2],
            sizes: { large: { w: 1200, h: 800 } },
            altText: null,
            sensitiveMedia: false,
            mediaAvailability: { status: "available", reason: null },
            sourceStatusId: "1985432109876500000",
            sourceUserId: "783214",
          },
        ],
        place: {
          id: "5a110d312052166f",
          name: "San Francisco",
          fullName: "San Francisco, CA",
          country: "United States",
          countryCode: "US",
          placeType: "city",
          url: "https://api.twitter.com/1.1/geo/id/5a110d312052166f.json",
          boundingBox: { coordinates: [[[-122.5, 37.7]]], type: "Polygon" },
        },
        card: null,
        poll: {
          id: "1985432109876500002",
          options: [
            { position: 1, label: "Yes", voteCount: 30, percentage: 75 },
            { position: 2, label: "No", voteCount: 10, percentage: 25 },
          ],
          endDatetime: "2026-10-28T12:00:00.000Z",
          durationMinutes: 1440,
          votingStatus: "closed",
          totalVotes: 40,
          userVoted: false,
          userVotedOption: null,
          lastUpdated: null,
        },
      })
    ) as Record<string, unknown>;

    expect(compact.mentions).toEqual([{ id: "783214", username: "X", name: "X" }]);
    expect(compact.media).toEqual([
      {
        id: "1985432109876500001",
        key: "3_1985432109876500001",
        type: "photo",
        url: "https://pbs.twimg.com/media/Gabc.jpg",
        expandedUrl: `https://x.com/elonmusk/status/${LONG_ID}/photo/1`,
        thumbnailUrl: "https://pbs.twimg.com/media/Gabc.jpg",
        videoUrl: null,
        altText: null,
        sensitiveMedia: false,
        availability: { status: "available", reason: null },
        sourceStatusId: "1985432109876500000",
        sourceUserId: "783214",
      },
    ]);
    expect(compact.place).toEqual({
      id: "5a110d312052166f",
      name: "San Francisco",
      fullName: "San Francisco, CA",
      country: "United States",
      countryCode: "US",
      placeType: "city",
      url: "https://api.twitter.com/1.1/geo/id/5a110d312052166f.json",
    });
    expect(compact.poll).toEqual({
      id: "1985432109876500002",
      options: [
        { position: 1, label: "Yes", voteCount: 30, percentage: 75 },
        { position: 2, label: "No", voteCount: 10, percentage: 25 },
      ],
      totalVotes: 40,
      votingStatus: "closed",
      endDatetime: "2026-10-28T12:00:00.000Z",
      durationMinutes: 1440,
    });
    expect(JSON.stringify(compact)).not.toContain("boundingBox");
    expect(JSON.stringify(compact)).not.toContain("aspectRatio");

    const omitted = outputInfo("compact", "tweets").fieldsOmitted.join(" ");
    expect(omitted).toContain("hasAIGeneratedMedia and isPaidPromotion disclosures are kept");
    expect(omitted).toContain("place bounding box");
    expect(omitted).toContain("media display URL, dimensions");
  });

  // Shape of TwitAPI's ArticleTransformer output for an article that X sent with only
  // preview_text (no plain_text or content_state), as in the saved list-tweets response sample.
  const PREVIEW_ONLY_ARTICLE = {
    id: "1985000000000000001",
    title: "Article title",
    text: "",
    previewText: `${"Only available article body snippet. ".repeat(5)}`.slice(0, 189),
    coverImageUrl: "https://pbs.twimg.com/media/cover.jpg",
  };

  it("keeps the article preview as its own field when it is the only body text", () => {
    const compact = compactTweet(tweet({ article: PREVIEW_ONLY_ARTICLE })) as {
      article: Record<string, unknown>;
    };

    expect(compact.article).toEqual({
      id: PREVIEW_ONLY_ARTICLE.id,
      title: "Article title",
      text: "",
      previewText: PREVIEW_ONLY_ARTICLE.previewText,
    });
    expect(outputInfo("compact", "tweets").fieldsOmitted.join(" ")).toContain(
      "article cover image URL"
    );
  });

  it("keeps full article text alongside its preview", () => {
    const article = { ...PREVIEW_ONLY_ARTICLE, text: LONG_TEXT };
    const compact = compactTweet(tweet({ article })) as { article: Record<string, unknown> };

    expect(compact.article).toMatchObject({
      text: LONG_TEXT,
      previewText: PREVIEW_ONLY_ARTICLE.previewText,
    });
  });
});

describe("compact users", () => {
  it("keeps identity, profile text, counts, and creation date but drops bulky details", () => {
    const compact = compactUser(user()) as Record<string, unknown>;

    expect(compact).toMatchObject({
      id: "44196397",
      username: "elonmusk",
      url: "https://x.com/elonmusk",
      bio: "bio text",
      followerCount: 200000000,
      createdAt: "Tue Jun 02 20:12:29 +0000 2009",
      pinnedTweetIds: [LONG_ID],
    });
    expect(compact).not.toHaveProperty("banner");
    expect(compact).not.toHaveProperty("professional");
  });

  it("keeps identity verification and profile sensitivity flags for users and post authors", () => {
    const flagged = user({
      verifiedSince: "1700000000000",
      isIdentityVerified: true,
      possiblySensitive: true,
      profileInterstitialType: "sensitive_media",
    });

    expect(compactUser(flagged)).toMatchObject({
      verifiedSince: "1700000000000",
      isIdentityVerified: true,
      possiblySensitive: true,
      profileInterstitialType: "sensitive_media",
    });
    expect(compactUser(user())).toMatchObject({
      verifiedSince: null,
      isIdentityVerified: false,
      possiblySensitive: false,
      profileInterstitialType: null,
    });
    expect(compactUser({ id: "1" })).toMatchObject({
      isIdentityVerified: null,
      possiblySensitive: null,
    });
    expect(compactTweet(tweet({ author: flagged }))).toMatchObject({
      author: { verifiedSince: "1700000000000", isIdentityVerified: true },
    });
  });
});

describe("compactResult", () => {
  it("never drops items from a page", () => {
    const page = { data: [tweet({ id: "1" }), tweet({ id: "2" }), tweet({ id: "3" })] };
    const compact = compactResult("tweets", page) as { tweets: Array<{ id: string }> };

    expect(compact.tweets.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("shapes tweet details, keeping the focal post, parents, and replies", () => {
    const compact = compactResult("tweetDetails", {
      data: {
        tweet: tweet(),
        ancestors: [tweet({ id: "100" })],
        replies: [tweet({ id: "200" }), tweet({ id: "201" })],
        nextCursor: "cursor-2",
      },
    }) as { tweet: { id: string }; ancestors: Array<{ id: string }>; replies: unknown[] };

    expect(compact.tweet.id).toBe(LONG_ID);
    expect(compact.ancestors[0]?.id).toBe("100");
    expect(compact.replies).toHaveLength(2);
  });

  it("keeps null positions for posts that batch lookup could not load", () => {
    const compact = compactResult("tweetLookup", {
      data: { tweets: [tweet({ id: "1" }), null] },
    }) as { tweets: unknown[] };

    expect(compact.tweets).toHaveLength(2);
    expect(compact.tweets[1]).toBeNull();
  });

  it("shapes each search type from its real response form", () => {
    const top = compactResult(
      "search",
      {
        data: [
          { type: "tweet", content: tweet({ id: "1" }) },
          { type: "user", content: user() },
        ],
      },
      "Top"
    ) as { items: Array<{ type: string }> };
    const people = compactResult("search", { data: [user()] }, "People") as { users: unknown[] };
    const latest = compactResult("search", { data: [tweet()] }, "Latest") as { tweets: unknown[] };

    expect(top.items.map((item) => item.type)).toEqual(["tweet", "user"]);
    expect(people.users).toHaveLength(1);
    expect(latest.tweets).toHaveLength(1);
  });

  it("shapes community members with their role", () => {
    const compact = compactResult("communityMembers", {
      data: [{ user: user(), role: "moderator" }],
    }) as { members: Array<{ role: string; user: { username: string } }> };

    expect(compact.members[0]).toMatchObject({ role: "moderator", user: { username: "elonmusk" } });
  });

  it("returns empty lists for an empty page", () => {
    expect(compactResult("users", { data: [], pagination: { nextCursor: null } })).toEqual({
      users: [],
    });
  });
});

describe("pagination and completeness", () => {
  it("reads the standard pagination object as TweetAPI returned it", () => {
    expect(
      extractPagination({ data: [], pagination: { nextCursor: "n", prevCursor: null } })
    ).toEqual({ raw: { nextCursor: "n", prevCursor: null }, nextCursor: "n" });
  });

  it('treats a v1.1 follower/following next cursor of "0" as the end, keeping raw pagination', () => {
    const terminal = { data: ["456"], pagination: { nextCursor: "0", prevCursor: "-1" } };
    const pagination = extractPagination(terminal, { zeroCursorEnds: true });

    expect(pagination).toEqual({
      raw: { nextCursor: "0", prevCursor: "-1" },
      nextCursor: null,
      endCursor: "0",
    });

    const completeness = buildCompleteness({
      paginated: true,
      result: terminal,
      nextCursor: pagination.nextCursor,
      endCursor: pagination.endCursor,
    });
    expect(completeness).toMatchObject({ nextCursor: null, moreAvailable: false, itemCount: 1 });
    expect(completeness.note).toContain("last page");
  });

  it("keeps ordinary and opaque cursors that only start with 0", () => {
    for (const cursor of ["1847291658203946210", "0|1971852223063261182", "00"]) {
      expect(
        extractPagination(
          { data: [], pagination: { nextCursor: cursor, prevCursor: null } },
          { zeroCursorEnds: true }
        )
      ).toEqual({ raw: { nextCursor: cursor, prevCursor: null }, nextCursor: cursor });
    }

    // Other endpoint families keep "0" as an opaque cursor.
    expect(extractPagination({ data: [], pagination: { nextCursor: "0" } }).nextCursor).toBe("0");
  });

  it("reads the community search top-level cursor", () => {
    expect(extractPagination({ data: [], nextCursor: null })).toEqual({
      raw: { nextCursor: null },
      nextCursor: null,
    });
  });

  it("reads the tweet details reply cursor nested in data (regression)", () => {
    expect(
      extractPagination({
        data: { tweet: null, ancestors: [], replies: [], nextCursor: "reply-cursor" },
      })
    ).toEqual({ raw: { nextCursor: "reply-cursor" }, nextCursor: "reply-cursor" });
  });

  it("says a page has more only when a cursor came back, and never claims completeness", () => {
    const withCursor = buildCompleteness({
      paginated: true,
      kind: "tweets",
      result: { data: [tweet()] },
      nextCursor: "n",
    });
    const withoutCursor = buildCompleteness({
      paginated: true,
      kind: "tweets",
      result: { data: [] },
      nextCursor: null,
    });

    expect(withCursor).toMatchObject({
      scope: "page",
      nextCursor: "n",
      moreAvailable: true,
      itemCount: 1,
    });
    expect(withoutCursor).toMatchObject({ moreAvailable: false, itemCount: 0 });
    expect(withoutCursor.note).toContain("does not prove the list is complete");
  });

  it("lists requested posts that came back null, by position", () => {
    const completeness = buildCompleteness({
      paginated: false,
      kind: "tweetLookup",
      batch: { kind: "tweetIds", requested: ["1", LONG_ID, "3"] },
      result: { data: { tweets: [tweet({ id: "1" }), null, tweet({ id: "3" })] } },
      nextCursor: null,
    });

    expect(completeness).toMatchObject({
      scope: "batch",
      requestedCount: 3,
      itemCount: 2,
      notReturned: [LONG_ID],
    });
  });

  it("lists requested usernames that were not returned, ignoring case", () => {
    const completeness = buildCompleteness({
      paginated: false,
      kind: "users",
      batch: { kind: "usernames", requested: ["ElonMusk", "gone_account"] },
      result: { data: [user()] },
      nextCursor: null,
    });

    expect(completeness.notReturned).toEqual(["gone_account"]);
  });

  it("describes what compact output omitted and guarantees no items or text were cut", () => {
    expect(outputInfo("full", "tweets")).toEqual({
      format: "full",
      fieldsOmitted: [],
      itemsOmitted: 0,
      textTruncated: false,
    });
    const compact = outputInfo("compact", "tweets");
    expect(compact.fieldsOmitted.length).toBeGreaterThan(0);
    expect(compact).toMatchObject({ itemsOmitted: 0, textTruncated: false });
  });

  it("describes the metrics projection as its own format with what it left out", () => {
    expect(metricsOutputInfo(true)).toMatchObject({
      format: "metrics",
      itemsOmitted: 0,
      textTruncated: true,
    });
    expect(metricsOutputInfo(false).textTruncated).toBe(false);
    expect(metricsOutputInfo(false).fieldsOmitted.join(" ")).toContain("replies");
  });
});
