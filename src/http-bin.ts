#!/usr/bin/env node
import { startHostedMcpHttpServer } from "./hosted.js";

const server = startHostedMcpHttpServer();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
