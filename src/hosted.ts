import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import { TweetApiDocsService } from "./docs.js";
import { readPositiveIntegerEnv } from "./fetch-timeout.js";
import { resolveTweetApiBaseUrl } from "./live.js";
import {
  authenticateMcpAuthorization,
  buildMcpAuthConfig,
  DEFAULT_PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
  type McpAuthConfig,
  type McpAuthFailure,
} from "./mcp-auth.js";
import { createTweetApiMcpServer } from "./server.js";

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT = 300;
const DEFAULT_INVALID_AUTH_RATE_LIMIT = 30;
const DEFAULT_GLOBAL_RATE_LIMIT = 3000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";
const MAX_RATE_LIMIT_KEYS = 10_000;
const GLOBAL_RATE_LIMIT_KEY = "global";
const DEFAULT_ALLOWED_HOSTS = ["mcp.tweetapi.com", "localhost", "127.0.0.1", "[::1]", "::1"];
export const GLAMA_OWNERSHIP_PATH = "/.well-known/glama.json";
const GLAMA_OWNERSHIP_DOCUMENT = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  maintainers: [{ email: "support@tweetapi.com" }],
};
const JSON_SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type FetchLike = typeof fetch;

export type HostedMcpServerOptions = {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  maxBodyBytes?: number;
  rateLimit?: number;
  invalidAuthRateLimit?: number;
  globalRateLimit?: number;
  rateLimitWindowMs?: number;
  clientIpHeader?: string | null;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  authFetch?: FetchLike;
  docsService?: TweetApiDocsService;
  authIssuer?: string;
  mcpResource?: string;
  protectedResourceMetadataUrl?: string;
  dashboardResolveUrl?: string;
  dashboardInternalToken?: string;
  oauthJwtSecret?: string;
  authResolveTimeoutMs?: number;
};

export function createHostedMcpHttpServer(options: HostedMcpServerOptions = {}): Server {
  const handler = createHostedMcpRequestHandler(options);

  return createServer((req, res) => {
    void handler(req, res);
  });
}

export function startHostedMcpHttpServer(options: HostedMcpServerOptions = {}): Server {
  const port = options.port ?? readPositiveIntegerEnv("PORT", DEFAULT_PORT);
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const server = createHostedMcpHttpServer(options);

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`TweetAPI hosted MCP listening on ${host}:${port}`);
  });

  return server;
}

export function createHostedMcpRequestHandler(options: HostedMcpServerOptions = {}) {
  const allowedHosts = options.allowedHosts ?? parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
  const maxBodyBytes =
    options.maxBodyBytes ?? readPositiveIntegerEnv("MCP_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);
  const rateLimit =
    options.rateLimit ?? readPositiveIntegerEnv("MCP_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT);
  const invalidAuthRateLimit =
    options.invalidAuthRateLimit ??
    readPositiveIntegerEnv(
      "MCP_INVALID_AUTH_RATE_LIMIT_PER_MINUTE",
      DEFAULT_INVALID_AUTH_RATE_LIMIT
    );
  const globalRateLimit =
    options.globalRateLimit ??
    readPositiveIntegerEnv("MCP_GLOBAL_RATE_LIMIT_PER_MINUTE", DEFAULT_GLOBAL_RATE_LIMIT);
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const clientIpHeader =
    options.clientIpHeader !== undefined
      ? normalizeClientIpHeader(options.clientIpHeader)
      : normalizeClientIpHeader(process.env.MCP_CLIENT_IP_HEADER ?? DEFAULT_CLIENT_IP_HEADER);
  const requestLimiter = createFixedWindowRateLimiter(rateLimit, rateLimitWindowMs);
  const invalidAuthLimiter = createFixedWindowRateLimiter(invalidAuthRateLimit, rateLimitWindowMs);
  const globalLimiter = createFixedWindowRateLimiter(globalRateLimit, rateLimitWindowMs);
  const apiBaseUrl = resolveTweetApiBaseUrl(
    options.apiBaseUrl ?? process.env.TWEETAPI_API_BASE_URL
  );
  const docsService = options.docsService ?? new TweetApiDocsService();
  const authConfig = buildMcpAuthConfig({
    issuer: options.authIssuer,
    resource: options.mcpResource,
    protectedResourceMetadataUrl: options.protectedResourceMetadataUrl,
    dashboardResolveUrl: options.dashboardResolveUrl,
    dashboardInternalToken: options.dashboardInternalToken,
    jwtSecret: options.oauthJwtSecret,
    fetch: options.authFetch,
    resolveTimeoutMs: options.authResolveTimeoutMs,
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = getRequestPath(req);

    if (path === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "tweetapi-mcp" });
      return;
    }

    if (path === DEFAULT_PROTECTED_RESOURCE_METADATA_PATH && req.method === "GET") {
      const hostError = validateHost(req.headers.host, allowedHosts);
      if (hostError) {
        sendJsonRpcError(res, 403, -32000, hostError);
        return;
      }

      sendJson(res, 200, protectedResourceMetadata(authConfig));
      return;
    }

    if (path === GLAMA_OWNERSHIP_PATH && req.method === "GET") {
      const hostError = validateHost(req.headers.host, allowedHosts);
      if (hostError) {
        sendJsonRpcError(res, 403, -32000, hostError);
        return;
      }

      sendJson(res, 200, GLAMA_OWNERSHIP_DOCUMENT);
      return;
    }

    if (path !== "/mcp") {
      sendJsonRpcError(res, 404, -32000, "Not found");
      return;
    }

    const hostError = validateHost(req.headers.host, allowedHosts);
    if (hostError) {
      sendJsonRpcError(res, 403, -32000, hostError);
      return;
    }

    const clientIp = getClientIp(req, clientIpHeader);
    if (!requestLimiter.allow(clientIp)) {
      sendJsonRpcError(res, 429, -32000, "Too many MCP requests.");
      return;
    }

    if (!globalLimiter.allow(GLOBAL_RATE_LIMIT_KEY)) {
      sendJsonRpcError(res, 429, -32000, "The MCP service is busy. Try again shortly.");
      return;
    }

    const auth = await authenticateMcpAuthorization(req.headers.authorization, authConfig);
    if (auth.status !== "valid" && !invalidAuthLimiter.allow(clientIp)) {
      sendJsonRpcError(res, 429, -32000, "Too many MCP requests with missing or invalid auth.");
      return;
    }

    if (auth.status !== "valid") {
      sendMcpAuthFailure(res, auth, authConfig);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.");
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.");
      return;
    }

    let mcpServer: ReturnType<typeof createTweetApiMcpServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      const parsedBody = await readJsonBody(req, maxBodyBytes);
      mcpServer = createTweetApiMcpServer({
        live: true,
        docsService,
        liveTools: {
          apiKey: auth.apiKey,
          apiBaseUrl,
          fetch: options.fetch,
          missingApiKeyCode: "MCP_GRANT_API_KEY_MISSING",
          missingApiKeyMessage:
            "Hosted TweetAPI MCP live tools require a valid dashboard-backed MCP grant.",
        },
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const closeOnce = once(() => {
        void transport?.close();
        void mcpServer?.close();
      });

      res.on("finish", closeOnce);
      res.on("close", closeOnce);

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJsonRpcError(res, 413, -32000, error.message);
        return;
      }

      if (error instanceof InvalidJsonError) {
        sendJsonRpcError(res, 400, -32700, error.message);
        return;
      }

      // eslint-disable-next-line no-console
      console.error(
        "Hosted MCP request failed:",
        error instanceof Error ? error.message : "Unknown error"
      );

      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  };
}

export function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) {
    return DEFAULT_ALLOWED_HOSTS;
  }

  const hosts = value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

function validateHost(hostHeader: string | undefined, allowedHosts: string[]) {
  if (!hostHeader) {
    return "Missing Host header";
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return "Invalid Host header";
  }

  return allowedHosts.includes(hostname) ? undefined : `Invalid Host: ${hostname}`;
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number) {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > maxBodyBytes) {
    throw new BodyTooLargeError(maxBodyBytes);
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new BodyTooLargeError(maxBodyBytes);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`MCP request body exceeds ${limit} bytes.`);
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super("Invalid JSON-RPC request body.");
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, {
    ...JSON_SECURITY_HEADERS,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

function sendMcpAuthFailure(
  res: ServerResponse,
  failure: McpAuthFailure,
  authConfig: McpAuthConfig
) {
  console.warn(
    [
      "[mcp-auth] rejected",
      `status=${failure.status}`,
      `http_status=${failure.httpStatus}`,
      failure.error ? `error=${failure.error}` : undefined,
      `reason=${failure.reason}`,
    ]
      .filter(Boolean)
      .join(" ")
  );

  const headers: Record<string, string> = {};

  if (failure.httpStatus === 401 || failure.httpStatus === 403) {
    headers["WWW-Authenticate"] = buildAuthenticateHeader(failure, authConfig);
  }

  sendJsonWithHeaders(
    res,
    failure.httpStatus,
    {
      jsonrpc: "2.0",
      error: {
        code: failure.httpStatus === 403 ? -32003 : -32001,
        message: failure.reason,
      },
      id: null,
    },
    headers
  );
}

function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string) {
  sendJson(res, httpStatus, {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: null,
  });
}

function sendJsonWithHeaders(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string>
) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, {
    ...JSON_SECURITY_HEADERS,
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function buildAuthenticateHeader(failure: McpAuthFailure, authConfig: McpAuthConfig) {
  const params = [
    `resource_metadata="${escapeHeaderValue(authConfig.protectedResourceMetadataUrl)}"`,
  ];

  if (failure.error) {
    params.push(`error="${failure.error}"`);
  }

  if (failure.error === "insufficient_scope") {
    params.push(`scope="${escapeHeaderValue(REQUIRED_SCOPE_HEADER_VALUE)}"`);
  }

  return `Bearer ${params.join(", ")}`;
}

const REQUIRED_SCOPE_HEADER_VALUE = "tweetapi:read";

function escapeHeaderValue(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function getRequestPath(req: IncomingMessage) {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function normalizeClientIpHeader(value: string | null): string | null {
  const header = value?.trim().toLowerCase();
  if (!header || header === "none") {
    return null;
  }

  return header;
}

// The client IP header is only used to bucket rate limits, never for auth. Behind Cloudflare,
// `CF-Connecting-IP` is set by the edge; a request that bypasses the edge can spoof it, which only
// spreads its traffic across buckets, and the global limiter still caps the total.
export function getClientIp(req: IncomingMessage, clientIpHeader: string | null): string {
  if (clientIpHeader) {
    const raw = req.headers[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    if (value && isIP(value)) {
      return value;
    }
  }

  return req.socket.remoteAddress ?? "unknown";
}

export function createFixedWindowRateLimiter(
  limit: number,
  windowMs: number,
  maxKeys = MAX_RATE_LIMIT_KEYS
) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    allow(key: string) {
      if (limit <= 0) {
        return false;
      }

      const now = Date.now();
      const current = buckets.get(key);

      if (!current || current.resetAt <= now) {
        if (!current && buckets.size >= maxKeys) {
          for (const [bucketKey, bucket] of buckets) {
            if (bucket.resetAt <= now) {
              buckets.delete(bucketKey);
            }
          }

          if (buckets.size >= maxKeys) {
            return false;
          }
        }

        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      current.count += 1;
      return current.count <= limit;
    },
  };
}

function once(callback: () => void) {
  let called = false;

  return () => {
    if (called) {
      return;
    }

    called = true;
    callback();
  };
}
