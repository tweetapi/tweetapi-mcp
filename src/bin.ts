#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTweetApiMcpServer } from "./server.js";

async function main() {
  const live = process.argv.includes("--live");
  const server = createTweetApiMcpServer({ live });
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
