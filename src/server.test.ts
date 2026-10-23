import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
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
