import { FetchTimeoutError, fetchWithTimeout, readPositiveIntegerEnv } from "./fetch-timeout.js";

export const DOCS_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_DOCS_FETCH_TIMEOUT_MS = 8_000;

export const DOCS_SOURCES = {
  llms: "https://tweetapi.com/llms.txt",
  aiDocsV2: "https://tweetapi.com/ai-docs-v2.txt",
} as const;

export type DocsSourceKey = keyof typeof DOCS_SOURCES;

export type DocsSource = {
  key: DocsSourceKey;
  url: string;
  text: string;
  fetchedAt: string;
};

export type DocsCache = {
  sources: Record<DocsSourceKey, DocsSource>;
};

export type DocsSearchMatch = {
  source: DocsSourceKey;
  sourceUrl: string;
  title: string;
  snippet: string;
  score: number;
};

export type EndpointDocsPage = {
  source: "aiDocsV2";
  sourceUrl: string;
  title: string;
  method: string;
  path: string;
  content: string;
};

export class DocsFetchError extends Error {
  constructor(
    public readonly source: DocsSourceKey,
    public readonly url: string,
    message: string
  ) {
    super(message);
    this.name = "DocsFetchError";
  }
}

type FetchLike = typeof fetch;

type CachedDocs = {
  expiresAt: number;
  docs: DocsCache;
};

export class TweetApiDocsService {
  private cache: CachedDocs | null = null;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = readPositiveIntegerEnv(
      "MCP_DOCS_FETCH_TIMEOUT_MS",
      DEFAULT_DOCS_FETCH_TIMEOUT_MS
    )
  ) {}

  async getDocs(forceRefresh = false): Promise<DocsCache> {
    if (!forceRefresh && this.cache && this.cache.expiresAt > this.now()) {
      return this.cache.docs;
    }

    const fetchedAt = new Date(this.now()).toISOString();
    const entries = await Promise.all(
      Object.entries(DOCS_SOURCES).map(async ([key, url]) => {
        const sourceKey = key as DocsSourceKey;
        const text = await this.fetchSource(sourceKey, url);

        return [
          sourceKey,
          {
            key: sourceKey,
            url,
            text,
            fetchedAt,
          },
        ] as const;
      })
    );

    const docs = {
      sources: Object.fromEntries(entries) as Record<DocsSourceKey, DocsSource>,
    };
    this.cache = {
      docs,
      expiresAt: this.now() + DOCS_TTL_MS,
    };

    return docs;
  }

  async readSource(source: DocsSourceKey): Promise<DocsSource> {
    const docs = await this.getDocs();
    return docs.sources[source];
  }

  async search(query: string, limit = 5): Promise<DocsSearchMatch[]> {
    const normalizedQuery = normalizeSearchText(query);
    const tokens = tokenize(normalizedQuery);

    if (tokens.length === 0) {
      return [];
    }

    const docs = await this.getDocs();
    const matches = Object.values(docs.sources).flatMap((source) =>
      splitSections(source.text).flatMap((section) => {
        const normalizedSection = normalizeSearchText(`${section.title} ${section.body}`);
        const score = tokens.reduce(
          (sum, token) => sum + countOccurrences(normalizedSection, token),
          0
        );

        if (score === 0) {
          return [];
        }

        return [
          {
            source: source.key,
            sourceUrl: source.url,
            title: section.title,
            snippet: buildSnippet(section.body, tokens),
            score,
          },
        ];
      })
    );

    return matches.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 10)));
  }

  async lookupEndpoint(pathOrKeyword: string): Promise<DocsSearchMatch[]> {
    const query = pathOrKeyword.trim();

    if (!query) {
      return [];
    }

    const normalizedPath = query.startsWith("/") ? query : `/${query}`;
    const pathMatches = await this.search(normalizedPath, 10);

    if (pathMatches.length > 0) {
      return pathMatches;
    }

    return this.search(query, 10);
  }

  async getPage(pathOrKeyword: string): Promise<EndpointDocsPage | null> {
    const query = pathOrKeyword.trim();

    if (!query) {
      return null;
    }

    const docs = await this.getDocs();
    const source = docs.sources.aiDocsV2;
    const sections = splitEndpointSections(source.text);
    const pathQuery = normalizeEndpointPath(query);
    const exactMatch = pathQuery
      ? sections.find((section) => normalizeEndpointPath(section.path) === pathQuery)
      : undefined;

    if (exactMatch) {
      return endpointSectionToPage(exactMatch, source.url);
    }

    const tokens = tokenize(normalizeSearchText(query));

    if (tokens.length === 0) {
      return null;
    }

    const ranked = sections
      .map((section) => {
        const text = normalizeSearchText(
          `${section.method} ${section.path} ${section.title} ${section.content}`
        );
        const score = tokens.reduce((sum, token) => sum + countOccurrences(text, token), 0);

        return { section, score };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0] ? endpointSectionToPage(ranked[0].section, source.url) : null;
  }

  sdkGuidance(
    language: string,
    task: string
  ): {
    language: string;
    task: string;
    packageName: string | null;
    install: string | null;
    importExample: string;
    notes: string[];
  } {
    const normalizedLanguage = normalizeSearchText(language);
    const isPython = normalizedLanguage.includes("python");
    const isNode =
      normalizedLanguage.includes("node") ||
      normalizedLanguage.includes("typescript") ||
      normalizedLanguage.includes("javascript") ||
      normalizedLanguage.includes("next");

    if (isPython) {
      return {
        language,
        task,
        packageName: "tweetapi",
        install: "pip install tweetapi",
        importExample:
          'import os\nfrom tweetapi import TweetAPI\n\nclient = TweetAPI(api_key=os.environ["TWEETAPI_API_KEY"])',
        notes: [
          "Use Python SDK keyword-only parameters and snake_case method names.",
          "Keep TWEETAPI_API_KEY in the server/runtime environment.",
          "Use cursor parameters for explicit next-page requests; do not auto-paginate unless asked.",
        ],
      };
    }

    if (isNode) {
      return {
        language,
        task,
        packageName: "tweetapi-node",
        install: "npm install tweetapi-node",
        importExample:
          'import TweetAPI from "tweetapi-node";\n\nconst client = new TweetAPI({ apiKey: process.env.TWEETAPI_API_KEY! });',
        notes: [
          "Use Node SDK camelCase methods and object parameters.",
          "Keep TWEETAPI_API_KEY in the server/runtime environment.",
          "The SDK defaults to https://api.tweetapi.com and adds /tw-v2 paths internally.",
        ],
      };
    }

    return {
      language,
      task,
      packageName: null,
      install: null,
      importExample:
        "Use raw HTTPS requests against https://api.tweetapi.com/tw-v2/... with the X-API-Key header.",
      notes: [
        "Prefer the official SDKs for Node.js/TypeScript or Python projects.",
        "For other languages, use raw REST calls with X-API-Key.",
        "Do not expose TWEETAPI_API_KEY in frontend or mobile client code.",
      ],
    };
  }

  private async fetchSource(source: DocsSourceKey, url: string): Promise<string> {
    let response: Response;

    try {
      response = await fetchWithTimeout(this.fetcher, url, undefined, this.timeoutMs);
    } catch (error) {
      if (error instanceof FetchTimeoutError) {
        throw new DocsFetchError(
          source,
          url,
          `Timed out after ${error.timeoutMs}ms while fetching ${url}`
        );
      }

      throw new DocsFetchError(source, url, error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      throw new DocsFetchError(source, url, `HTTP ${response.status} while fetching ${url}`);
    }

    return response.text();
  }
}

type Section = {
  title: string;
  body: string;
};

type EndpointSection = {
  title: string;
  method: string;
  path: string;
  content: string;
};

export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let title = "Document";
  let body: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
      if (body.join("\n").trim()) {
        sections.push({ title, body: body.join("\n").trim() });
      }
      title = heading[2].trim();
      body = [];
      continue;
    }

    body.push(line);
  }

  if (body.join("\n").trim()) {
    sections.push({ title, body: body.join("\n").trim() });
  }

  if (sections.length === 0 && text.trim()) {
    sections.push({ title: "Document", body: text.trim() });
  }

  return sections;
}

export function splitEndpointSections(text: string): EndpointSection[] {
  const headingPattern = /^###\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/tw-v2\/\S+)\s*$/gim;
  const matches = [...text.matchAll(headingPattern)];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const method = match[1].toUpperCase();
    const path = match[2];
    const content = text.slice(start, end).trim();

    return {
      title: `${method} ${path}`,
      method,
      path,
      content,
    };
  });
}

function endpointSectionToPage(section: EndpointSection, sourceUrl: string): EndpointDocsPage {
  return {
    source: "aiDocsV2",
    sourceUrl,
    title: section.title,
    method: section.method,
    path: section.path,
    content: section.content,
  };
}

function normalizeEndpointPath(value: string): string | null {
  const trimmed = value.trim();
  const withoutMethod = trimmed.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, "");
  const pathLike = withoutMethod.startsWith("/") ? withoutMethod : `/${withoutMethod}`;

  if (!pathLike.startsWith("/tw-v2/")) {
    return null;
  }

  return pathLike.replace(/[?#].*$/, "").toLowerCase();
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return [...new Set(value.split(/[^a-z0-9/_-]+/).filter(Boolean))];
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let index = text.indexOf(token);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }

  return count;
}

function buildSnippet(body: string, tokens: string[]): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const firstMatch = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = Math.max(0, (firstMatch ?? 0) - 90);
  const snippet = compact.slice(start, start + 360);

  return `${start > 0 ? "..." : ""}${snippet}${start + 360 < compact.length ? "..." : ""}`;
}
