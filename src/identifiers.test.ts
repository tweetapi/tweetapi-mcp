import { describe, expect, it } from "vitest";

import {
  IdentifierInputError,
  parseCommunityIdentifier,
  parseIdentifierList,
  parseListIdentifier,
  parseSpaceIdentifier,
  parseTweetIdentifier,
  parseUsernameIdentifier,
} from "./identifiers.js";

// Larger than Number.MAX_SAFE_INTEGER, so any numeric conversion would corrupt it.
const LONG_ID = "1985432109876543219";

function rejects(parse: () => unknown, message: RegExp) {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(IdentifierInputError);
    expect((error as Error).message).toMatch(message);
    return;
  }

  throw new Error("expected the identifier to be rejected");
}

describe("post identifiers", () => {
  it("keeps numeric IDs as exact strings, including IDs above 2^53", () => {
    expect(parseTweetIdentifier("tweetId", LONG_ID)).toEqual({ value: LONG_ID, source: "id" });
    expect(parseTweetIdentifier("tweetId", ` ${LONG_ID} `).value).toBe(LONG_ID);
    expect(parseTweetIdentifier("tweetId", "12345678901234567890").value).toBe(
      "12345678901234567890"
    );
  });

  it.each([
    [`https://x.com/jack/status/${LONG_ID}`],
    [`https://twitter.com/jack/status/${LONG_ID}`],
    [`http://www.twitter.com/jack/statuses/${LONG_ID}`],
    [`https://mobile.x.com/jack/status/${LONG_ID}?s=20&t=abc#reply`],
    [`x.com/jack/status/${LONG_ID}`],
    [`https://X.COM/Jack/Status/${LONG_ID}`],
    [`https://x.com/jack/status/${LONG_ID}/photo/1`],
    [`https://x.com/jack/status/${LONG_ID}/video/2`],
    [`https://x.com/jack/status/${LONG_ID}/analytics`],
    [`https://x.com/i/status/${LONG_ID}`],
    [`https://x.com/i/web/status/${LONG_ID}`],
  ])("accepts the post link %s", (link) => {
    expect(parseTweetIdentifier("tweetId", link)).toEqual({ value: LONG_ID, source: "link" });
  });

  it.each([
    ["https://x.com/jack", /profile link/],
    ["https://x.com/i/lists/123", /list link/],
    ["https://x.com/jack/status/abc", /unsupported x.com link/],
    [`https://x.com/jack/status/${LONG_ID}/photo/1/extra`, /unsupported/],
    ["https://x.com/jack/status/123456789012345678901", /unsupported/],
    [`https://x.com.evil.example/jack/status/${LONG_ID}`, /only accepts x.com or twitter.com/],
    [`https://evilx.com/jack/status/${LONG_ID}`, /only accepts x.com or twitter.com/],
    [`https://user:pass@x.com/jack/status/${LONG_ID}`, /credentials or a port/],
    [`https://x.com:8443/jack/status/${LONG_ID}`, /credentials or a port/],
    [`javascript:alert(1)//x.com/jack/status/${LONG_ID}`, /http or https/],
    [`ftp://x.com/jack/status/${LONG_ID}`, /http or https/],
    ["@jack", /numeric post ID/],
    ["123abc", /numeric post ID/],
    ["", /must not be empty/],
    ["x".repeat(600), /at most 512/],
  ])("rejects %s", (value, message) => {
    rejects(() => parseTweetIdentifier("tweetId", value), message);
  });
});

describe("username identifiers", () => {
  it.each([
    ["jack", "jack", "username"],
    ["@jack", "jack", "handle"],
    [" @Jack_2 ", "Jack_2", "handle"],
    ["123456", "123456", "username"],
    ["https://x.com/jack", "jack", "link"],
    ["https://twitter.com/jack/", "jack", "link"],
    ["x.com/jack?lang=en", "jack", "link"],
    ["https://x.com/jack/media", "jack", "link"],
    ["https://x.com/jack/with_replies", "jack", "link"],
  ])("accepts %s as %s", (input, value, source) => {
    expect(parseUsernameIdentifier("username", input)).toEqual({ value, source });
  });

  it.each([
    [`https://x.com/jack/status/${LONG_ID}`, /post link/],
    ["https://x.com/home", /unsupported/],
    ["https://x.com/i/communities/123", /community link/],
    ["https://x.com/search?q=jack", /unsupported/],
    ["https://x.com/jack/unknown-tab", /unsupported/],
    ["https://example.com/jack", /only accepts x.com or twitter.com/],
    ["jack dorsey", /must be a username/],
    ["@@jack", /must be a username/],
    ["jack,elon", /must be a username/],
  ])("rejects %s", (value, message) => {
    rejects(() => parseUsernameIdentifier("username", value), message);
  });
});

describe("list, community, and Space identifiers", () => {
  it("accepts IDs and matching app links", () => {
    expect(parseListIdentifier("listId", "1234567890")).toEqual({
      value: "1234567890",
      source: "id",
    });
    expect(parseListIdentifier("listId", "https://x.com/i/lists/1234567890/members").value).toBe(
      "1234567890"
    );
    expect(parseCommunityIdentifier("communityId", "https://x.com/i/communities/987").value).toBe(
      "987"
    );
    expect(parseSpaceIdentifier("spaceId", "https://x.com/i/spaces/1ABCdefGHIjkl/peek").value).toBe(
      "1ABCdefGHIjkl"
    );
    expect(parseSpaceIdentifier("spaceId", "1ABCdefGHIjkl").source).toBe("id");
  });

  it("rejects links to a different kind of object", () => {
    rejects(
      () => parseListIdentifier("listId", "https://x.com/i/communities/987"),
      /community link/
    );
    rejects(() => parseCommunityIdentifier("communityId", "https://x.com/i/lists/1"), /list link/);
    rejects(() => parseSpaceIdentifier("spaceId", "https://x.com/jack"), /profile link/);
    rejects(() => parseListIdentifier("listId", "list-1"), /list ID/);
  });
});

describe("identifier lists", () => {
  it("parses comma-separated strings and arrays and reports the failing position", () => {
    expect(
      parseIdentifierList(
        "ids",
        `${LONG_ID}, https://x.com/jack/status/20`,
        200,
        parseTweetIdentifier
      ).map((item) => item.value)
    ).toEqual([LONG_ID, "20"]);

    expect(
      parseIdentifierList(
        "usernames",
        ["@jack", "https://x.com/elon"],
        100,
        parseUsernameIdentifier
      )
    ).toEqual([
      { value: "jack", source: "handle" },
      { value: "elon", source: "link" },
    ]);

    try {
      parseIdentifierList("ids", ["1", "https://x.com/jack"], 200, parseTweetIdentifier);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IdentifierInputError);
      expect((error as IdentifierInputError).field).toBe("ids[1]");
    }
  });

  it("enforces the batch maximum after splitting strings", () => {
    const tooMany = Array.from({ length: 101 }, (_, index) => `user${index}`).join(",");

    rejects(
      () => parseIdentifierList("usernames", tooMany, 100, parseUsernameIdentifier),
      /at most 100/
    );
    rejects(
      () => parseIdentifierList("usernames", " , ", 100, parseUsernameIdentifier),
      /at least one/
    );
    rejects(
      () => parseIdentifierList("ids", [1, 2], 200, parseTweetIdentifier),
      /array of strings/
    );
  });
});
