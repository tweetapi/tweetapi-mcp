import { describe, expect, it, vi } from "vitest";

import {
  DOCS_SOURCES,
  DocsFetchError,
  TweetApiDocsService,
  splitEndpointSections,
} from "./docs.js";

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe("TweetApiDocsService", () => {
  it("fetches allowlisted docs and reuses the in-memory cache within the TTL", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      response(`# ${String(url)}\n\nSearch tweets with /tw-v2/search.`)
    );
    const service = new TweetApiDocsService(fetcher, () => now);

    const first = await service.getDocs();
    const second = await service.getDocs();

    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(DOCS_SOURCES.llms, expect.any(Object));
    expect(fetcher).toHaveBeenCalledWith(DOCS_SOURCES.aiDocsV2, expect.any(Object));

    now += 16 * 60 * 1_000;
    await service.getDocs();

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("names the failed source when remote docs cannot be fetched", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === DOCS_SOURCES.llms) {
        return response("not found", { status: 503 });
      }

      return response("# AI docs");
    });
    const service = new TweetApiDocsService(fetcher, () => 1_000);

    await expect(service.getDocs()).rejects.toMatchObject({
      name: "DocsFetchError",
      source: "llms",
      url: DOCS_SOURCES.llms,
    } satisfies Partial<DocsFetchError>);
  });

  it("names the failed source when remote docs fetch times out", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === DOCS_SOURCES.llms) {
        return new Promise<Response>(() => {});
      }

      return response("# AI docs");
    });
    const service = new TweetApiDocsService(fetcher, () => 1_000, 1);

    await expect(service.getDocs()).rejects.toMatchObject({
      name: "DocsFetchError",
      source: "llms",
      url: DOCS_SOURCES.llms,
    } satisfies Partial<DocsFetchError>);
  });

  it("searches docs sections and returns compact sourced matches", async () => {
    const service = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === DOCS_SOURCES.llms) {
          return response("# Overview\n\nTweetAPI exposes Twitter/X data.");
        }

        return response(
          [
            "# Search",
            "",
            "Use /tw-v2/search to search tweets by query and result type.",
            "",
            "# Followers",
            "",
            "Use /tw-v2/user/followers with cursor pagination.",
          ].join("\n")
        );
      }),
      () => 1_000
    );

    const matches = await service.search("search tweets", 2);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      source: "aiDocsV2",
      sourceUrl: DOCS_SOURCES.aiDocsV2,
      title: "Search",
    });
    expect(matches[0].snippet).toContain("/tw-v2/search");
  });

  it("looks up endpoints by path before falling back to keyword search", async () => {
    const service = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(
          String(url) === DOCS_SOURCES.aiDocsV2
            ? "# Search\n\nGET /tw-v2/search accepts query and type."
            : "# Summary\n\nTweetAPI docs."
        )
      ),
      () => 1_000
    );

    const matches = await service.lookupEndpoint("/tw-v2/search");

    expect(matches[0].title).toBe("Search");
    expect(matches[0].snippet).toContain("/tw-v2/search");
  });

  it("parses ai-docs-v2 endpoint sections from method/path headings", () => {
    const sections = splitEndpointSections(
      [
        "# AI docs",
        "",
        "### GET /tw-v2/tweet/details",
        "",
        "Tweet details body.",
        "",
        "### POST /tw-v2/tweet/translate",
        "",
        "Translate body.",
      ].join("\n")
    );

    expect(sections).toEqual([
      {
        title: "GET /tw-v2/tweet/details",
        method: "GET",
        path: "/tw-v2/tweet/details",
        content: "### GET /tw-v2/tweet/details\n\nTweet details body.",
      },
      {
        title: "POST /tw-v2/tweet/translate",
        method: "POST",
        path: "/tw-v2/tweet/translate",
        content: "### POST /tw-v2/tweet/translate\n\nTranslate body.",
      },
    ]);
  });

  it("returns the exact full endpoint docs page from ai-docs-v2", async () => {
    const aiDocs = [
      "# AI docs",
      "",
      "### GET /tw-v2/tweet/details",
      "",
      "Fetch a tweet, engagement counters, and conversation replies.",
      "",
      "Parameters: tweetId, sortBy, cursor.",
      "",
      "### GET /tw-v2/search",
      "",
      "Search tweets and users.",
    ].join("\n");
    const service = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(String(url) === DOCS_SOURCES.aiDocsV2 ? aiDocs : "# Summary")
      ),
      () => 1_000
    );

    const page = await service.getPage("tw-v2/tweet/details");

    expect(page).toMatchObject({
      source: "aiDocsV2",
      sourceUrl: DOCS_SOURCES.aiDocsV2,
      title: "GET /tw-v2/tweet/details",
      method: "GET",
      path: "/tw-v2/tweet/details",
    });
    expect(page?.content).toContain("### GET /tw-v2/tweet/details");
    expect(page?.content).toContain("Parameters: tweetId, sortBy, cursor.");
    expect(page?.content).not.toContain("### GET /tw-v2/search");
  });

  it("falls back to the best endpoint docs page by keyword", async () => {
    const aiDocs = [
      "# AI docs",
      "",
      "### GET /tw-v2/tweet/details",
      "",
      "Fetch a tweet with engagement counters.",
      "",
      "### GET /tw-v2/tweet/quotes",
      "",
      "Fetch quote tweets for a tweet.",
    ].join("\n");
    const service = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(String(url) === DOCS_SOURCES.aiDocsV2 ? aiDocs : "# Summary")
      ),
      () => 1_000
    );

    const page = await service.getPage("quote tweets");

    expect(page).toMatchObject({
      title: "GET /tw-v2/tweet/quotes",
      path: "/tw-v2/tweet/quotes",
    });
  });

  it("returns null when no endpoint docs page matches", async () => {
    const service = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(
          String(url) === DOCS_SOURCES.aiDocsV2
            ? "### GET /tw-v2/tweet/details\n\nTweet details body."
            : "# Summary"
        )
      ),
      () => 1_000
    );

    await expect(service.getPage("definitely-not-a-real-endpoint")).resolves.toBeNull();
  });

  it("returns language-specific SDK guidance", () => {
    const service = new TweetApiDocsService(vi.fn(), () => 1_000);

    expect(service.sdkGuidance("TypeScript", "search tweets")).toMatchObject({
      packageName: "tweetapi-node",
      install: "npm install tweetapi-node",
    });
    expect(service.sdkGuidance("Python", "search tweets")).toMatchObject({
      packageName: "tweetapi",
      install: "pip install tweetapi",
    });
    expect(service.sdkGuidance("Go", "search tweets")).toMatchObject({
      packageName: null,
      install: null,
    });
  });
});
