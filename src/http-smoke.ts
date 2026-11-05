#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

import { createHostedMcpHttpServer } from "./hosted.js";
import {
  DEFAULT_MCP_AUTH_ISSUER,
  DEFAULT_MCP_RESOURCE,
  REQUIRED_MCP_SCOPE,
  signMcpAccessTokenForTesting,
} from "./mcp-auth.js";

const TEST_JWT_SECRET = "smoke-test-mcp-oauth-secret";
const TEST_INTERNAL_TOKEN = "smoke-test-dashboard-internal-token";
const TEST_RESOLVED_API_KEY = ["sk", "SMOKE_TEST_RESOLVED_KEY"].join("_");

async function main() {
  const accessToken = createSmokeAccessToken();
  const server = createHostedMcpHttpServer({
    allowedHosts: ["127.0.0.1", "localhost"],
    oauthJwtSecret: TEST_JWT_SECRET,
    dashboardInternalToken: TEST_INTERNAL_TOKEN,
    authFetch: async () =>
      new Response(
        JSON.stringify({
          apiKey: TEST_RESOLVED_API_KEY,
          grantId: "smoke-grant",
          userId: "smoke-user",
          scopes: [REQUIRED_MCP_SCOPE],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      ),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "tweetapi-http-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const resources = await client.listResources();

    console.log(
      JSON.stringify({
        tools: tools.tools.map((tool) => tool.name),
        resources: resources.resources.map((resource) => resource.uri),
      })
    );
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createSmokeAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  return signMcpAccessTokenForTesting(
    {
      iss: DEFAULT_MCP_AUTH_ISSUER,
      sub: "smoke-user",
      aud: DEFAULT_MCP_RESOURCE,
      scope: `${REQUIRED_MCP_SCOPE} offline_access`,
      grant_id: "smoke-grant",
      iat: now,
      exp: now + 900,
    },
    TEST_JWT_SECRET
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
