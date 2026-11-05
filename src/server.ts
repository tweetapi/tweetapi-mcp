import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonError, jsonText } from "./content.js";
import { catalogCostSummary } from "./cost.js";
import { DOCS_SOURCES, DocsFetchError, TweetApiDocsService } from "./docs.js";
import { createLiveToolDefinitions, LIVE_TOOL_ENDPOINTS, type LiveToolsOptions } from "./live.js";

const docsSearchInputSchema = {
  query: z
    .string()
    .min(1)
    .describe("Words to look for in the docs, such as rate limits, pagination or followers."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("How many matching sections to return, 1 to 10. Default 5."),
};

const endpointLookupInputSchema = {
  pathOrKeyword: z
    .string()
    .min(1)
    .describe(
      "An endpoint path such as /tw-v2/user/followers, or a keyword such as followers. A path gives the most precise match."
    ),
};

const sdkGuidanceInputSchema = {
  language: z
    .string()
    .min(1)
    .describe("Programming language: Python, or Node.js, TypeScript or JavaScript."),
  task: z
    .string()
    .min(1)
    .describe("What the code should do, such as fetch a user's latest posts. It is echoed back."),
};

const toolCatalogInputSchema = {
  toolName: z
    .string()
    .min(1)
    .optional()
    .describe("Exact tool name, such as tweetapi_search, to return only that tool."),
  endpointPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "TweetAPI endpoint path, such as /tw-v2/user/followers, to find the tool that calls it."
    ),
  category: z
    .string()
    .min(1)
    .optional()
    .describe("One of docs, user, tweet, search, list, community, space, trends or account."),
};

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const DOCS_TOOL_METADATA = [
  {
    name: "tweetapi_docs_search",
    title: "Search TweetAPI Docs",
    description:
      "Search TweetAPI's public docs by keyword and return the best-matching sections, each with a title, a short snippet, its source URL and a score. Use it for general questions such as pricing, limits, errors or authentication; for one endpoint's full reference, use tweetapi_docs_get_page. Free: reads the public docs and uses no API key or units.",
    inputSchema: docsSearchInputSchema,
  },
  {
    name: "tweetapi_endpoint_lookup",
    title: "Lookup TweetAPI Endpoint",
    description:
      "Find the TweetAPI endpoint docs that match a path or keyword, and return up to 10 matching sections as snippets with their source URLs. Use it when you don't know the exact endpoint yet, then pass its path to tweetapi_docs_get_page for the full reference. Free: uses no API key or units.",
    inputSchema: endpointLookupInputSchema,
  },
  {
    name: "tweetapi_docs_get_page",
    title: "Get TweetAPI Docs Page",
    description:
      "Return the full reference for one TweetAPI endpoint: its method, path, title and whole docs section, with parameters, cost and an example request. An exact path such as /tw-v2/user/followers returns that endpoint; a keyword returns the single best match, and no match returns a TWEETAPI_DOCS_PAGE_NOT_FOUND error. Free: uses no API key or units.",
    inputSchema: endpointLookupInputSchema,
  },
  {
    name: "tweetapi_sdk_guidance",
    title: "TweetAPI SDK Guidance",
    description:
      "Return setup guidance for calling TweetAPI from your own code: the SDK package name, install command, an import example and notes, for Python or Node.js/TypeScript. Use it when writing an app that calls TweetAPI; to fetch data now, use the live tools instead. Free: makes no API calls.",
    inputSchema: sdkGuidanceInputSchema,
  },
  {
    name: "tweetapi_tool_catalog",
    title: "TweetAPI MCP Tool Catalog",
    description:
      "List the tools on this server as JSON: for each, its name, description, category, the TweetAPI endpoint it calls, estimated cost, response formats and input schema. Filter it with toolName, endpointPath or category. Use it to pick the right tool or check costs before calling live tools. Free: uses no API key or units.",
    inputSchema: toolCatalogInputSchema,
  },
] as const;

type ToolCatalogFilters = {
  toolName?: string;
  endpointPath?: string;
  category?: string;
};

type NormalizedToolCatalogFilters = {
  toolName?: string;
  endpointPath?: string;
  category?: string;
};

type ToolCatalogEntry = {
  name: string;
  title: string;
  description: string;
  mode: "docs" | "live";
  category: string;
  readOnly: true;
  requiresApiKey: boolean;
  endpoint: {
    method: string;
    path: string;
  } | null;
  cost: ReturnType<typeof catalogCostSummary> | null;
  responseFormats: string[];
  linkInputs: string[];
  inputSchema: Record<string, unknown>;
};

export type TweetApiMcpServerOptions = {
  live?: boolean;
  docsService?: TweetApiDocsService;
  liveTools?: LiveToolsOptions;
};

// Most array elements plus object keys one tool call's arguments may contain. The SDK counts them
// before schema validation, so an oversized input cannot use up memory while it is validated
// (CVE-2026-111768). The largest real input, 200 post IDs, is about 205.
export const MAX_TOOL_INPUT_ELEMENTS = 1_000;

export function createTweetApiMcpServer(options: TweetApiMcpServerOptions = {}): McpServer {
  const docsService = options.docsService ?? new TweetApiDocsService();
  const server = new McpServer(
    {
      name: "tweetapi-mcp",
      version: "0.3.3",
    },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions:
        "Use this server to inspect TweetAPI docs and, when live tools are enabled, make bounded read-only TweetAPI requests through a dashboard-backed MCP grant. Hosted HTTP clients use MCP OAuth bearer tokens; local stdio live mode reads TWEETAPI_API_KEY. Live data tools usually cost 1 API unit per call; tweetapi_account_usage is free and shows the units left. Pass responseFormat compact for smaller results, and post or profile links where a tool accepts them. Users inside posts and account lists can show listedCount 0, isIdentityVerified false and verifiedSince null because X leaves those details out there; use tweetapi_user_by_id or tweetapi_user_by_username when they matter.",
    }
  );

  registerDocsResources(server, docsService);
  registerDocsTools(server, docsService);
  registerPrompts(server);

  if (options.live) {
    registerLiveTools(server, {
      apiKey: options.liveTools?.apiKey ?? process.env.TWEETAPI_API_KEY,
      apiBaseUrl: options.liveTools?.apiBaseUrl,
      now: options.liveTools?.now,
      fetch: options.liveTools?.fetch,
      fetchTimeoutMs: options.liveTools?.fetchTimeoutMs,
      missingApiKeyCode: options.liveTools?.missingApiKeyCode,
      missingApiKeyMessage: options.liveTools?.missingApiKeyMessage,
    });
  }

  return server;
}

function registerDocsResources(server: McpServer, docsService: TweetApiDocsService) {
  server.registerResource(
    "tweetapi_llms",
    "tweetapi://docs/llms",
    {
      title: "TweetAPI LLM Summary",
      description: "Current TweetAPI public LLM summary from tweetapi.com.",
      mimeType: "text/plain",
    },
    async (uri) => {
      try {
        const source = await docsService.readSource("llms");

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: source.text,
            },
          ],
        };
      } catch (error) {
        return docsResourceError(uri.href, error);
      }
    }
  );

  server.registerResource(
    "tweetapi_ai_docs_v2",
    "tweetapi://docs/ai-docs-v2",
    {
      title: "TweetAPI AI Docs v2",
      description: "Current AI-ready TweetAPI endpoint documentation from tweetapi.com.",
      mimeType: "text/plain",
    },
    async (uri) => {
      try {
        const source = await docsService.readSource("aiDocsV2");

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: source.text,
            },
          ],
        };
      } catch (error) {
        return docsResourceError(uri.href, error);
      }
    }
  );
}

function registerDocsTools(server: McpServer, docsService: TweetApiDocsService) {
  server.registerTool(
    "tweetapi_docs_search",
    {
      title: DOCS_TOOL_METADATA[0].title,
      description: DOCS_TOOL_METADATA[0].description,
      inputSchema: DOCS_TOOL_METADATA[0].inputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query, limit }) => {
      try {
        const matches = await docsService.search(query, limit);

        return jsonText({
          query,
          sources: DOCS_SOURCES,
          matches,
        });
      } catch (error) {
        return docsToolError(error);
      }
    }
  );

  server.registerTool(
    "tweetapi_endpoint_lookup",
    {
      title: DOCS_TOOL_METADATA[1].title,
      description: DOCS_TOOL_METADATA[1].description,
      inputSchema: DOCS_TOOL_METADATA[1].inputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ pathOrKeyword }) => {
      try {
        const matches = await docsService.lookupEndpoint(pathOrKeyword);

        return jsonText({
          pathOrKeyword,
          sources: DOCS_SOURCES,
          matches,
        });
      } catch (error) {
        return docsToolError(error);
      }
    }
  );

  server.registerTool(
    "tweetapi_docs_get_page",
    {
      title: DOCS_TOOL_METADATA[2].title,
      description: DOCS_TOOL_METADATA[2].description,
      inputSchema: DOCS_TOOL_METADATA[2].inputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ pathOrKeyword }) => {
      try {
        const page = await docsService.getPage(pathOrKeyword);

        if (!page) {
          return jsonError(
            "TWEETAPI_DOCS_PAGE_NOT_FOUND",
            "No TweetAPI endpoint documentation page matched the requested path or keyword.",
            {
              pathOrKeyword,
              sourceUrl: DOCS_SOURCES.aiDocsV2,
            }
          );
        }

        return jsonText({
          pathOrKeyword,
          page,
        });
      } catch (error) {
        return docsToolError(error);
      }
    }
  );

  server.registerTool(
    "tweetapi_sdk_guidance",
    {
      title: DOCS_TOOL_METADATA[3].title,
      description: DOCS_TOOL_METADATA[3].description,
      inputSchema: DOCS_TOOL_METADATA[3].inputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ language, task }) => jsonText(docsService.sdkGuidance(language, task))
  );

  server.registerTool(
    "tweetapi_tool_catalog",
    {
      title: DOCS_TOOL_METADATA[4].title,
      description: DOCS_TOOL_METADATA[4].description,
      inputSchema: DOCS_TOOL_METADATA[4].inputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ toolName, endpointPath, category }) =>
      jsonText(buildToolCatalog({ toolName, endpointPath, category }))
  );
}

function registerLiveTools(server: McpServer, options: LiveToolsOptions) {
  for (const tool of createLiveToolDefinitions(options)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      tool.handler
    );
  }
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "integrate_tweetapi",
    {
      title: "Integrate TweetAPI",
      description: "Guide an agent to integrate TweetAPI safely into a customer project.",
      argsSchema: {
        language: z.string().optional(),
        framework: z.string().optional(),
        useCase: z.string().min(1),
      },
    },
    ({ language, framework, useCase }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Integrate TweetAPI for this use case: ${useCase}.`,
              language ? `Language: ${language}.` : "Infer the project language from the repo.",
              framework ? `Framework: ${framework}.` : "Infer the framework from the repo.",
              "Use server-side code only for TweetAPI calls.",
              "Read TWEETAPI_API_KEY from the target app/server environment.",
              "Prefer the official SDK for Node.js/TypeScript or Python.",
              "Use the TweetAPI docs MCP tools before naming endpoint parameters.",
              "Do not put TweetAPI keys, Twitter/X authToken, ct0, proxy credentials, or DM contents in source code.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}

function docsToolError(error: unknown) {
  if (error instanceof DocsFetchError) {
    return jsonError("TWEETAPI_DOCS_FETCH_FAILED", error.message, {
      source: error.source,
      sourceUrl: error.url,
    });
  }

  return jsonError(
    "TWEETAPI_DOCS_ERROR",
    error instanceof Error ? error.message : "TweetAPI docs lookup failed"
  );
}

function docsResourceError(uri: string, error: unknown) {
  const payload =
    error instanceof DocsFetchError
      ? {
          error: {
            code: "TWEETAPI_DOCS_FETCH_FAILED",
            message: error.message,
            source: error.source,
            sourceUrl: error.url,
          },
        }
      : {
          error: {
            code: "TWEETAPI_DOCS_ERROR",
            message: error instanceof Error ? error.message : "TweetAPI docs lookup failed",
          },
        };

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload),
      },
    ],
  };
}

function buildToolCatalog(filters: ToolCatalogFilters) {
  const normalizedFilters = normalizeCatalogFilters(filters);
  const docsTools: ToolCatalogEntry[] = DOCS_TOOL_METADATA.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    mode: "docs",
    category: "docs",
    readOnly: true,
    requiresApiKey: false,
    endpoint: null,
    cost: null,
    responseFormats: [],
    linkInputs: [],
    inputSchema: describeInputSchema(tool.inputSchema),
  }));
  const liveTools: ToolCatalogEntry[] = LIVE_TOOL_ENDPOINTS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    mode: "live",
    category: categoryFromEndpointPath(tool.path),
    readOnly: true,
    requiresApiKey: true,
    endpoint: {
      method: tool.method,
      path: tool.path,
    },
    cost: catalogCostSummary(tool.method, tool.path),
    responseFormats: catalogResponseFormats(tool),
    linkInputs: Object.keys(tool.identifiers ?? {}),
    inputSchema: describeInputSchema(tool.inputSchema),
  }));
  const tools = [...docsTools, ...liveTools].filter((tool) =>
    matchesCatalogFilters(tool, normalizedFilters)
  );

  return {
    filters: normalizedFilters,
    count: tools.length,
    tools,
  };
}

// The output.format values a tool's results can carry. tweetapi_tweet_metrics has no responseFormat
// input; it always returns its own "metrics" projection.
function catalogResponseFormats(tool: (typeof LIVE_TOOL_ENDPOINTS)[number]): string[] {
  if (tool.responseShape === "tweetMetrics") return ["metrics"];
  return tool.compactKind ? ["full", "compact"] : ["full"];
}

function normalizeCatalogFilters(filters: ToolCatalogFilters): NormalizedToolCatalogFilters {
  return {
    toolName: cleanFilter(filters.toolName),
    endpointPath: normalizeCatalogEndpointPath(filters.endpointPath),
    category: cleanFilter(filters.category)?.toLowerCase(),
  };
}

function matchesCatalogFilters(tool: ToolCatalogEntry, filters: NormalizedToolCatalogFilters) {
  if (filters.toolName && tool.name !== filters.toolName) {
    return false;
  }

  if (filters.category && tool.category.toLowerCase() !== filters.category) {
    return false;
  }

  if (filters.endpointPath && tool.endpoint?.path.toLowerCase() !== filters.endpointPath) {
    return false;
  }

  return true;
}

function cleanFilter(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCatalogEndpointPath(value?: string) {
  const cleaned = cleanFilter(value);

  if (!cleaned) {
    return undefined;
  }

  const path = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return path.replace(/[?#].*$/, "").toLowerCase();
}

function categoryFromEndpointPath(path: string) {
  return path.split("/")[2] ?? "other";
}

function describeInputSchema(inputSchema: Record<string, z.ZodTypeAny>) {
  const schema = z.object(inputSchema).toJSONSchema() as Record<string, unknown>;
  const required = Object.entries(inputSchema)
    .filter(([, fieldSchema]) => !fieldSchema.safeParse(undefined).success)
    .map(([field]) => field);

  delete schema.$schema;

  if (required.length > 0) {
    schema.required = required;
  } else {
    delete schema.required;
  }

  return schema;
}
