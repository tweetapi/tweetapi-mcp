import { createHmac, timingSafeEqual } from "node:crypto";

import { fetchWithTimeout, readPositiveIntegerEnv } from "./fetch-timeout.js";

const DEFAULT_RESOLVE_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 30;
const MIN_BACKING_API_KEY_LENGTH = 8;

export const DEFAULT_MCP_RESOURCE = "https://mcp.tweetapi.com/mcp";
export const DEFAULT_MCP_AUTH_ISSUER = "https://tweetapi.com";
export const DEFAULT_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const REQUIRED_MCP_SCOPE = "tweetapi:read";

type FetchLike = typeof fetch;

export type McpAuthConfig = {
  issuer: string;
  resource: string;
  protectedResourceMetadataUrl: string;
  dashboardResolveUrl: string;
  dashboardInternalToken?: string;
  jwtSecret?: string;
  fetch: FetchLike;
  resolveTimeoutMs: number;
};

export type AuthenticatedMcpGrant = {
  status: "valid";
  apiKey: string;
  grantId: string;
  userId: string;
  scopes: string[];
  mode: "mcp-token";
};

export type McpAuthFailure = {
  status: "missing" | "invalid" | "forbidden" | "service_error";
  httpStatus: 401 | 403 | 503;
  reason: string;
  error?: "invalid_token" | "insufficient_scope";
};

export type McpAuthResult = AuthenticatedMcpGrant | McpAuthFailure;

type McpAccessTokenClaims = {
  subject: string;
  grantId: string;
  scopes: string[];
};

export function buildMcpAuthConfig(options: {
  issuer?: string;
  resource?: string;
  protectedResourceMetadataUrl?: string;
  dashboardResolveUrl?: string;
  dashboardInternalToken?: string;
  jwtSecret?: string;
  fetch?: FetchLike;
  resolveTimeoutMs?: number;
}): McpAuthConfig {
  const issuer = trimTrailingSlash(
    options.issuer ?? process.env.MCP_AUTH_ISSUER ?? DEFAULT_MCP_AUTH_ISSUER
  );
  const resource = options.resource ?? process.env.MCP_RESOURCE ?? DEFAULT_MCP_RESOURCE;

  return {
    issuer,
    resource,
    protectedResourceMetadataUrl:
      options.protectedResourceMetadataUrl ??
      process.env.MCP_PROTECTED_RESOURCE_METADATA_URL ??
      new URL(DEFAULT_PROTECTED_RESOURCE_METADATA_PATH, resource).toString(),
    dashboardResolveUrl:
      options.dashboardResolveUrl ??
      process.env.MCP_DASHBOARD_RESOLVE_URL ??
      new URL("/api/internal/mcp/resolve", `${issuer}/`).toString(),
    dashboardInternalToken:
      options.dashboardInternalToken ?? process.env.MCP_DASHBOARD_INTERNAL_TOKEN,
    jwtSecret: options.jwtSecret ?? process.env.MCP_OAUTH_JWT_SECRET,
    fetch: options.fetch ?? fetch,
    resolveTimeoutMs:
      options.resolveTimeoutMs ??
      readPositiveIntegerEnv("MCP_AUTH_RESOLVE_TIMEOUT_MS", DEFAULT_RESOLVE_TIMEOUT_MS),
  };
}

export function protectedResourceMetadata(config: McpAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [REQUIRED_MCP_SCOPE, "offline_access"],
  };
}

export async function authenticateMcpAuthorization(
  header: string | string[] | undefined,
  config: McpAuthConfig
): Promise<McpAuthResult> {
  const parsed = parseBearerToken(header);
  if (parsed.status !== "valid") {
    return {
      status: parsed.status,
      httpStatus: 401,
      reason: parsed.reason,
      error: "invalid_token",
    };
  }

  if (!config.jwtSecret) {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP OAuth JWT verification secret is not configured.",
    };
  }

  if (!config.dashboardInternalToken) {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP dashboard resolver token is not configured.",
    };
  }

  const claims = verifyMcpAccessToken(parsed.token, config);
  if (isMcpAuthFailure(claims)) {
    return claims;
  }

  return resolveMcpGrant(claims, config);
}

type ParsedBearer =
  | { status: "valid"; token: string }
  | { status: "missing" | "invalid"; reason: string };

function isMcpAuthFailure(value: McpAccessTokenClaims | McpAuthFailure): value is McpAuthFailure {
  return "status" in value;
}

export function parseBearerToken(header: string | string[] | undefined): ParsedBearer {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.trim()) {
    return { status: "missing", reason: "Authorization bearer token is required." };
  }

  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { status: "invalid", reason: "Authorization must use the Bearer scheme." };
  }

  const token = match[1]?.trim();
  if (!token) {
    return { status: "invalid", reason: "Bearer token is empty." };
  }

  if (/[\s\x00-\x1F\x7F]/.test(token)) {
    return { status: "invalid", reason: "Bearer token contains invalid characters." };
  }

  return { status: "valid", token };
}

function isValidBackingApiKeyShape(apiKey: string): boolean {
  return (
    apiKey.startsWith("sk_") &&
    apiKey.length >= MIN_BACKING_API_KEY_LENGTH &&
    !/[\s\x00-\x1F\x7F]/.test(apiKey)
  );
}

function verifyMcpAccessToken(
  token: string,
  config: McpAuthConfig
): McpAccessTokenClaims | McpAuthFailure {
  let claims: Record<string, unknown>;
  try {
    claims = verifyJwt(token, config.jwtSecret ?? "");
  } catch {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token is invalid.",
      error: "invalid_token",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= now) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token is expired.",
      error: "invalid_token",
    };
  }

  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token is not active yet.",
      error: "invalid_token",
    };
  }

  if (claims.iss !== config.issuer) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token issuer is invalid.",
      error: "invalid_token",
    };
  }

  if (!audienceMatches(claims.aud, config.resource)) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token audience is invalid.",
      error: "invalid_token",
    };
  }

  const scopes = scopeValues(claims.scope ?? claims.scp);
  if (!scopes.includes(REQUIRED_MCP_SCOPE)) {
    return {
      status: "forbidden",
      httpStatus: 403,
      reason: `MCP access token requires ${REQUIRED_MCP_SCOPE}.`,
      error: "insufficient_scope",
    };
  }

  if (typeof claims.sub !== "string" || !claims.sub) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token subject is missing.",
      error: "invalid_token",
    };
  }

  if (typeof claims.grant_id !== "string" || !claims.grant_id) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP access token grant is missing.",
      error: "invalid_token",
    };
  }

  return {
    subject: claims.sub,
    grantId: claims.grant_id,
    scopes,
  };
}

async function resolveMcpGrant(
  claims: McpAccessTokenClaims,
  config: McpAuthConfig
): Promise<McpAuthResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      config.fetch,
      config.dashboardResolveUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.dashboardInternalToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grantId: claims.grantId,
          userId: claims.subject,
          resource: config.resource,
          scopes: claims.scopes,
        }),
      },
      config.resolveTimeoutMs
    );
  } catch {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP grant resolver is unavailable.",
    };
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return {
      status: "invalid",
      httpStatus: 401,
      reason: "MCP grant is not active.",
      error: "invalid_token",
    };
  }

  if (!response.ok) {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP grant resolver returned an error.",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP grant resolver returned invalid JSON.",
    };
  }

  if (typeof payload !== "object" || payload === null) {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP grant resolver returned an invalid payload.",
    };
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.apiKey !== "string" || !isValidBackingApiKeyShape(record.apiKey)) {
    return {
      status: "service_error",
      httpStatus: 503,
      reason: "MCP grant resolver did not return a valid backing API key.",
    };
  }

  return {
    status: "valid",
    apiKey: record.apiKey,
    grantId: claims.grantId,
    userId: claims.subject,
    scopes: claims.scopes,
    mode: "mcp-token",
  };
}

export function signMcpAccessTokenForTesting(
  payload: Record<string, unknown>,
  secret: string
): string {
  return signJwt(payload, secret);
}

function verifyJwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Malformed JWT");
  }

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(headerPart).toString("utf8")) as Record<
    string,
    unknown
  >;

  if (header.alg !== "HS256") {
    throw new Error("Unsupported JWT algorithm");
  }

  const expected = hmacSha256(`${headerPart}.${payloadPart}`, secret);
  if (!safeEqual(base64UrlDecode(signaturePart), expected)) {
    throw new Error("Invalid JWT signature");
  }

  const payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid JWT payload");
  }

  return payload as Record<string, unknown>;
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signaturePart = base64UrlEncode(hmacSha256(`${headerPart}.${payloadPart}`, secret));

  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

function hmacSha256(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

function safeEqual(actual: Buffer, expected: Buffer): boolean {
  if (actual.byteLength !== expected.byteLength) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function audienceMatches(audience: unknown, resource: string): boolean {
  if (typeof audience === "string") {
    return audience === resource;
  }

  if (Array.isArray(audience)) {
    return audience.includes(resource);
  }

  return false;
}

function scopeValues(scope: unknown): string[] {
  if (typeof scope === "string") {
    return scope.split(/\s+/u).filter(Boolean);
  }

  if (Array.isArray(scope)) {
    return scope.filter((value): value is string => typeof value === "string" && !!value);
  }

  return [];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
