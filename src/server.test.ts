import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCS_SOURCES, TweetApiDocsService } from "./docs.js";
import { createTweetApiMcpServer } from "./server.js";

function response(body: string): Response {
  return new Response(body);
}

async function connectServer(options: Parameters<typeof createTweetApiMcpServer>[0] = {}) {
  const server = createTweetApiMcpServer(options);
  const client = new Client({ name: "tweetapi-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("TweetAPI MCP server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists docs tools, resources, and prompts in docs-only mode", async () => {
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
    const connection = await connectServer({ docsService });

    try {
      const tools = await connection.client.listTools();
      const resources = await connection.client.listResources();
      const prompts = await connection.client.listPrompts();

      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "tweetapi_docs_search",
        "tweetapi_endpoint_lookup",
        "tweetapi_docs_get_page",
        "tweetapi_sdk_guidance",
        "tweetapi_tool_catalog",
      ]);
      expect(
        tools.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false &&
            tool.annotations.idempotentHint === true &&
            tool.annotations.openWorldHint === true
        )
      ).toBe(true);
      expect(resources.resources.map((resource) => resource.uri)).toEqual([
        "tweetapi://docs/llms",
        "tweetapi://docs/ai-docs-v2",
      ]);
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(["integrate_tweetapi"]);
    } finally {
      await connection.close();
    }
  });

  it("reports the package version as the MCP server version", async () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    const connection = await connectServer();

    try {
      expect(connection.client.getServerVersion()).toMatchObject({
        name: "tweetapi-mcp",
        version: pkg.version,
      });
    } finally {
      await connection.close();
    }
  });

  it("calls docs tools over MCP with compact JSON text content", async () => {
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
    const connection = await connectServer({ docsService });

    try {
      const result = await connection.client.callTool({
        name: "tweetapi_endpoint_lookup",
        arguments: { pathOrKeyword: "/tw-v2/search" },
      });

      expect(result.content[0]?.type).toBe("text");
      const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
      expect(body.matches[0]).toMatchObject({
        sourceUrl: DOCS_SOURCES.aiDocsV2,
        title: "Search",
      });
    } finally {
      await connection.close();
    }
  });

  it("returns full docs pages and structured no-match errors over MCP", async () => {
    const docsService = new TweetApiDocsService(
      vi.fn(async (url: string | URL | Request) =>
        response(
          String(url) === DOCS_SOURCES.aiDocsV2
            ? [
                "# AI docs",
                "",
                "### GET /tw-v2/tweet/details",
                "",
                "Fetch tweet details, engagement counters, and replies.",
                "",
                "### GET /tw-v2/search",
                "",
                "Search tweets and users.",
              ].join("\n")
            : "# TweetAPI\n\nTweetAPI public summary."
        )
      ),
      () => 1_000
    );
    const connection = await connectServer({ docsService });

    try {
      const result = await connection.client.callTool({
        name: "tweetapi_docs_get_page",
        arguments: { pathOrKeyword: "/tw-v2/tweet/details" },
      });

      expect(result.content[0]?.type).toBe("text");
      const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
      expect(body.page).toMatchObject({
        sourceUrl: DOCS_SOURCES.aiDocsV2,
        method: "GET",
        path: "/tw-v2/tweet/details",
      });
      expect(body.page.content).toContain("### GET /tw-v2/tweet/details");
      expect(body.page.content).not.toContain("### GET /tw-v2/search");

      const missing = await connection.client.callTool({
        name: "tweetapi_docs_get_page",
        arguments: { pathOrKeyword: "missing-endpoint-keyword" },
      });
      const missingBody = JSON.parse(
        missing.content[0]?.type === "text" ? missing.content[0].text : "{}"
      );

      expect(missing.isError).toBe(true);
      expect(missingBody).toMatchObject({
        error: {
          code: "TWEETAPI_DOCS_PAGE_NOT_FOUND",
          details: {
            pathOrKeyword: "missing-endpoint-keyword",
            sourceUrl: DOCS_SOURCES.aiDocsV2,
          },
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("returns a machine-readable MCP tool catalog", async () => {
    const connection = await connectServer();

    try {
      const docsCatalogResult = await connection.client.callTool({
        name: "tweetapi_tool_catalog",
        arguments: { category: "docs" },
      });
      const docsCatalog = JSON.parse(
        docsCatalogResult.content[0]?.type === "text" ? docsCatalogResult.content[0].text : "{}"
      ) as {
        count: number;
        tools: Array<{
          name: string;
          mode: string;
          category: string;
          readOnly: boolean;
          requiresApiKey: boolean;
          endpoint: { method: string; path: string } | null;
          inputSchema: { type?: string; properties?: unknown };
        }>;
      };

      expect(docsCatalog.count).toBe(5);
      expect(docsCatalog.tools.map((tool) => tool.name)).toEqual([
        "tweetapi_docs_search",
        "tweetapi_endpoint_lookup",
        "tweetapi_docs_get_page",
        "tweetapi_sdk_guidance",
        "tweetapi_tool_catalog",
      ]);
      expect(docsCatalog.tools.every((tool) => tool.mode === "docs")).toBe(true);
      expect(docsCatalog.tools.every((tool) => tool.readOnly)).toBe(true);
      expect(docsCatalog.tools.every((tool) => !tool.requiresApiKey)).toBe(true);

      const liveCatalogResult = await connection.client.callTool({
        name: "tweetapi_tool_catalog",
        arguments: { endpointPath: "tw-v2/tweet/details" },
      });
      const liveCatalog = JSON.parse(
        liveCatalogResult.content[0]?.type === "text" ? liveCatalogResult.content[0].text : "{}"
      ) as {
        tools: Array<{
          name: string;
          mode: string;
          readOnly: boolean;
          requiresApiKey: boolean;
          endpoint: { method: string; path: string } | null;
          inputSchema: { type?: string; properties?: unknown };
        }>;
      };

      expect(liveCatalog.tools.map((tool) => tool.name)).toEqual([
        "tweetapi_tweet_details",
        "tweetapi_tweet_metrics",
      ]);
      expect(liveCatalog.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "tweetapi_tweet_metrics",
            mode: "live",
            readOnly: true,
            requiresApiKey: true,
            endpoint: {
              method: "GET",
              path: "/tw-v2/tweet/details",
            },
            inputSchema: expect.objectContaining({
              type: "object",
              properties: expect.objectContaining({
                tweetId: expect.any(Object),
              }),
            }),
          }),
        ])
      );
    } finally {
      await connection.close();
    }
  });

  it("adds read-only live tools only when live mode is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    const connection = await connectServer({
      live: true,
      liveTools: {
        apiKey: "YOUR_API_KEY",
        apiBaseUrl: "https://api.example.test",
        fetch: fetchMock,
      },
    });

    try {
      const tools = await connection.client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toContain("tweetapi_search");
      expect(
        tools.tools.find((tool) => tool.name === "tweetapi_search")?.annotations
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      const result = await connection.client.callTool({
        name: "tweetapi_search",
        arguments: { query: "tweetapi", type: "Latest" },
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it("lists cost, response formats, and link inputs in the tool catalog", async () => {
    const connection = await connectServer();

    try {
      const result = await connection.client.callTool({
        name: "tweetapi_tool_catalog",
        arguments: { category: "account" },
      });
      const catalog = JSON.parse(
        result.content[0]?.type === "text" ? result.content[0].text : "{}"
      );

      expect(catalog.tools).toEqual([
        expect.objectContaining({
          name: "tweetapi_account_usage",
          endpoint: { method: "GET", path: "/tw-v2/account/usage" },
          cost: expect.objectContaining({ basis: "estimate", unitsPerSuccessfulCall: 0 }),
          responseFormats: ["full"],
          linkInputs: [],
        }),
      ]);

      const details = await connection.client.callTool({
        name: "tweetapi_tool_catalog",
        arguments: { toolName: "tweetapi_tweet_details" },
      });
      const detailsCatalog = JSON.parse(
        details.content[0]?.type === "text" ? details.content[0].text : "{}"
      );

      expect(detailsCatalog.tools[0]).toMatchObject({
        cost: { unitsPerSuccessfulCall: 1 },
        responseFormats: ["full", "compact"],
        linkInputs: ["tweetId"],
      });
    } finally {
      await connection.close();
    }
  });

  it("passes SDK output-schema validation for compact and full results of every compact tool", async () => {
    const tweet = { id: "1", text: "t", author: { id: "2", username: "jack" } };
    const user = { id: "2", username: "jack", name: "jack" };
    const list = { id: "9", name: "List", memberCount: 1, owner: user };
    const listPage = { data: [list], pagination: { nextCursor: null, prevCursor: null } };
    const bodies: Record<string, unknown> = {
      "/tw-v2/user/by-username": { data: user },
      "/tw-v2/user/by-id": { data: user },
      "/tw-v2/tweet/details": { data: { tweet, ancestors: [], replies: [tweet] } },
      "/tw-v2/tweet/details-by-ids": { data: { tweets: [tweet, null] } },
      "/tw-v2/community/members": { data: [{ user, role: "member" }] },
      "/tw-v2/search": { data: [{ type: "tweet", content: tweet }], pagination: {} },
      "/tw-v2/user/lists": listPage,
      "/tw-v2/user/list-memberships": listPage,
      "/tw-v2/list/search": listPage,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const body =
        bodies[path] ??
        (/(tweets|quotes|replies|photos|videos|highlights|articles|media)$/.test(path)
          ? { data: [tweet], pagination: { nextCursor: "n", prevCursor: null } }
          : { data: [user], pagination: { nextCursor: null, prevCursor: null } });
      return new Response(JSON.stringify(body));
    });
    const connection = await connectServer({
      live: true,
      liveTools: {
        apiKey: "YOUR_API_KEY",
        apiBaseUrl: "https://api.example.test",
        fetch: fetchMock,
      },
    });
    const args: Record<string, unknown> = {
      username: "@jack",
      usernames: ["jack"],
      userId: "2",
      userIds: ["2"],
      query: "q",
      type: "Top",
      tweetId: "https://x.com/jack/status/1",
      ids: ["1", "3"],
      listId: "1",
      communityId: "https://x.com/i/communities/1",
    };

    try {
      const { tools } = await connection.client.listTools();

      for (const tool of tools) {
        const properties = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
        );
        if (!properties.includes("responseFormat")) continue;

        for (const responseFormat of ["full", "compact"]) {
          const toolArgs = Object.fromEntries(
            properties.filter((field) => field in args).map((field) => [field, args[field]])
          );
          const result = await connection.client.callTool({
            name: tool.name,
            arguments: { ...toolArgs, responseFormat },
          });

          expect(result.isError, `${tool.name} ${responseFormat}`).toBeUndefined();
          expect(result.structuredContent, tool.name).toMatchObject({
            output: { format: responseFormat },
          });
        }
      }
    } finally {
      await connection.close();
    }
  });

  it("reports the metrics projection in the catalog and returns that format", async () => {
    const focal = {
      id: "1985432109876543219",
      text: "Launch day",
      createdAt: "Mon Oct 27 12:00:00 +0000 2026",
      author: { id: "44196397", username: "elonmusk", name: "Elon Musk" },
      likeCount: 1200,
      retweetCount: 300,
      replyCount: 80,
      quoteCount: 20,
      bookmarkCount: 45,
      viewCount: 98000,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { tweet: focal, ancestors: [], replies: [] } }))
    );
    const connection = await connectServer({
      live: true,
      liveTools: {
        apiKey: "YOUR_API_KEY",
        apiBaseUrl: "https://api.example.test",
        fetch: fetchMock,
      },
    });

    try {
      const catalogResult = await connection.client.callTool({
        name: "tweetapi_tool_catalog",
        arguments: { toolName: "tweetapi_tweet_metrics" },
      });
      const catalog = JSON.parse(
        catalogResult.content[0]?.type === "text" ? catalogResult.content[0].text : "{}"
      );
      const entry = catalog.tools[0];

      expect(entry.responseFormats).toEqual(["metrics"]);
      expect(entry.inputSchema.properties).not.toHaveProperty("responseFormat");

      // listTools first so the SDK client validates structuredContent against the output schema.
      await connection.client.listTools();
      const result = await connection.client.callTool({
        name: "tweetapi_tweet_metrics",
        arguments: { tweetId: "https://x.com/elonmusk/status/1985432109876543219" },
      });
      const structured = result.structuredContent as { output: { format: string } };

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(entry.responseFormats).toContain(structured.output.format);
      expect(
        JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}")
      ).toEqual(structured);
    } finally {
      await connection.close();
    }
  });

  it("keeps post disclosure flags in compact results and leaves full results unchanged", async () => {
    const focal = {
      id: "1985432109876543219",
      text: "Generated render of the launch site",
      createdAt: "Mon Oct 27 12:00:00 +0000 2026",
      author: { id: "44196397", username: "elonmusk", name: "Elon Musk" },
      mentions: [{ id: "783214", username: "X", name: "X" }],
      media: [
        {
          id: "1985432109876500001",
          key: "3_1985432109876500001",
          type: "photo",
          url: "https://pbs.twimg.com/media/Gabc.jpg",
          thumbnailUrl: "https://pbs.twimg.com/media/Gabc.jpg",
          sizes: { large: { w: 1200, h: 800 } },
        },
      ],
      hasAIGeneratedMedia: true,
      isPaidPromotion: false,
      limitedActions: "non_compliant",
      isTranslatable: true,
      translatedText: null,
    };
    const body = { data: { tweet: focal, ancestors: [], replies: [] } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    const connection = await connectServer({
      live: true,
      liveTools: {
        apiKey: "YOUR_API_KEY",
        apiBaseUrl: "https://api.example.test",
        fetch: fetchMock,
      },
    });

    try {
      await connection.client.listTools();
      const compact = await connection.client.callTool({
        name: "tweetapi_tweet_details",
        arguments: { tweetId: focal.id, responseFormat: "compact" },
      });
      const structured = compact.structuredContent as {
        output: { fieldsOmitted: string[] };
        result: { tweet: Record<string, unknown> };
      };

      expect(compact.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        JSON.parse(compact.content[0]?.type === "text" ? compact.content[0].text : "{}")
      ).toEqual(structured);
      expect(structured.result.tweet).toMatchObject({
        hasAIGeneratedMedia: true,
        isPaidPromotion: false,
        limitedActions: "non_compliant",
        isTranslatable: true,
        translatedText: null,
        mentions: [{ id: "783214", username: "X", name: "X" }],
        media: [
          {
            id: "1985432109876500001",
            key: "3_1985432109876500001",
            thumbnailUrl: "https://pbs.twimg.com/media/Gabc.jpg",
          },
        ],
      });
      expect(structured.output.fieldsOmitted.join(" ")).toContain(
        "hasAIGeneratedMedia and isPaidPromotion disclosures are kept"
      );

      const full = await connection.client.callTool({
        name: "tweetapi_tweet_details",
        arguments: { tweetId: focal.id },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(full.structuredContent).toMatchObject({
        output: { format: "full", fieldsOmitted: [] },
      });
      expect((full.structuredContent as { result: unknown }).result).toEqual(body);
    } finally {
      await connection.close();
    }
  });

  it("returns a missing-key error when live mode is enabled without local env", async () => {
    vi.stubEnv("TWEETAPI_API_KEY", "");
    const connection = await connectServer({ live: true });

    try {
      const result = await connection.client.callTool({
        name: "tweetapi_search",
        arguments: { query: "tweetapi", type: "Latest" },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
      expect(body.error.code).toBe("MISSING_TWEETAPI_API_KEY");
    } finally {
      await connection.close();
    }
  });

  it("returns the reusable integration prompt", async () => {
    const connection = await connectServer();

    try {
      const result = await connection.client.getPrompt({
        name: "integrate_tweetapi",
        arguments: {
          language: "TypeScript",
          framework: "Next.js",
          useCase: "search tweets",
        },
      });

      expect(result.messages[0]?.content.type).toBe("text");
      expect(
        result.messages[0]?.content.type === "text" ? result.messages[0].content.text : ""
      ).toContain("search tweets");
    } finally {
      await connection.close();
    }
  });

  it("starts the built stdio server and lists MCP capabilities", async () => {
    const binPath = join(process.cwd(), "dist/bin.js");

    expect(existsSync(binPath)).toBe(true);

    const client = new Client({ name: "tweetapi-mcp-stdio-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath],
      stderr: "pipe",
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const resources = await client.listResources();
      const prompts = await client.listPrompts();

      expect(tools.tools.map((tool) => tool.name)).toContain("tweetapi_docs_search");
      expect(resources.resources.map((resource) => resource.uri)).toContain("tweetapi://docs/llms");
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("integrate_tweetapi");
    } finally {
      await client.close();
    }
  });
});
