#!/usr/bin/env python3
"""Validate release-readiness docs and MCP build artifacts without live API calls."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REQUIRED_FILES = (
    Path("Dockerfile"),
    Path(".dockerignore"),
    Path("README.md"),
    Path("LICENSE"),
    Path("SECURITY.md"),
    Path("docs/deployment.md"),
    Path("docs/security.md"),
    Path("docs/roadmap.md"),
    Path("server.json"),
    Path("dist/bin.js"),
    Path("dist/http-bin.js"),
    Path("dist/http-smoke.js"),
)

REQUIRED_DOC_PHRASES = {
    Path("README.md"): (
        "https://mcp.tweetapi.com/mcp",
        "dashboard-issued OAuth tokens with the `tweetapi:read` scope",
        "TWEETAPI_API_KEY",
        "Live tools are read-only",
        "not affiliated with X Corp",
        "docker build -t tweetapi-mcp .",
    ),
    Path("docs/deployment.md"): (
        "https://mcp.tweetapi.com/mcp",
        "node dist/http-bin.js",
        "Build pack: Dockerfile",
        "Dockerfile path: Dockerfile",
        "Health check path: /healthz",
        "MCP_ALLOWED_HOSTS=mcp.tweetapi.com",
        "MCP_INVALID_AUTH_RATE_LIMIT_PER_MINUTE=30",
        "MCP_GLOBAL_RATE_LIMIT_PER_MINUTE=3000",
        "MCP_CLIENT_IP_HEADER=cf-connecting-ip",
        "MCP_OAUTH_JWT_SECRET",
        "does not trust `X-Forwarded-For`",
        "pnpm run check:release",
    ),
    Path("docs/security.md"): (
        "The hosted MCP service is an OAuth protected resource",
        "Authorization: Bearer <token>",
        "The hosted MCP service does not store customer keys",
        "stricter limiter to missing or invalid auth",
        "Raw TweetAPI API keys are rejected",
    ),
    Path("docs/roadmap.md"): (
        "Implemented: Hosted Read-Only MCP",
        "Dashboard Docs Handoff",
        "Future: Scoped Authenticated MCP",
        "separate scopes, revocation, audit logging",
    ),
}

EXPECTED_TOOLS = {
    "tweetapi_docs_search",
    "tweetapi_endpoint_lookup",
    "tweetapi_sdk_guidance",
}
EXPECTED_HTTP_TOOLS = EXPECTED_TOOLS | {
    "tweetapi_search",
    "tweetapi_user_by_username",
}
EXPECTED_RESOURCES = {
    "tweetapi://docs/llms",
    "tweetapi://docs/ai-docs-v2",
}


def fail(message: str) -> None:
    print(f"check-release: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        fail(f"missing required file: {path}")


def check_required_files() -> None:
    for path in REQUIRED_FILES:
        if not path.is_file():
            fail(f"missing required file: {path}")


def check_package_metadata() -> None:
    package = json.loads(read(Path("package.json")))
    if package.get("private") is True:
        fail("package.json must not be private; the MCP server is published as open source")
    if package.get("license") != "MIT":
        fail("package.json license must be MIT")
    if package.get("name") != "@tweetapi/mcp":
        fail("package.json name must be @tweetapi/mcp")
    if (
        package.get("repository", {}).get("url")
        != "git+https://github.com/tweetapi/tweetapi-mcp.git"
    ):
        fail("package.json repository URL must point to github.com/tweetapi/tweetapi-mcp")
    if package.get("engines", {}).get("node") != ">=18":
        fail("package.json engines.node must be >=18")
    if package.get("bin", {}).get("tweetapi-mcp") != "dist/bin.js":
        fail("package.json bin.tweetapi-mcp must point to dist/bin.js")
    if package.get("bin", {}).get("tweetapi-mcp-http") != "dist/http-bin.js":
        fail("package.json bin.tweetapi-mcp-http must point to dist/http-bin.js")


def check_registry_metadata() -> None:
    package = json.loads(read(Path("package.json")))
    metadata = json.loads(read(Path("server.json")))
    expected = {
        "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        "name": "com.tweetapi/mcp",
        "title": "TweetAPI MCP",
        "description": (
            "Read-only public Twitter data and TweetAPI docs for AI agents. "
            "Not affiliated with X Corp."
        ),
        "version": package["version"],
        "websiteUrl": "https://tweetapi.com/mcp",
        "repository": {
            "url": "https://github.com/tweetapi/tweetapi-mcp",
            "source": "github",
        },
        "icons": [
            {
                "src": "https://tweetapi.com/favicon.png",
                "mimeType": "image/png",
                "sizes": ["32x32"],
            }
        ],
        "remotes": [
            {
                "type": "streamable-http",
                "url": "https://mcp.tweetapi.com/mcp",
            }
        ],
    }
    if metadata != expected:
        fail("server.json must match the reviewed remote registry metadata")
    if "packages" in metadata:
        fail("server.json must not list an npm package until @tweetapi/mcp is published")


def check_docs() -> None:
    for path, phrases in REQUIRED_DOC_PHRASES.items():
        text = " ".join(read(path).split())
        missing = [phrase for phrase in phrases if phrase not in text]
        if missing:
            fail(f"{path} is missing required release text: {', '.join(missing)}")


def check_mcp_smoke() -> None:
    script = """
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "tweetapi-release-check", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/bin.js"],
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  console.log(JSON.stringify({
    tools: tools.tools.map((tool) => tool.name),
    resources: resources.resources.map((resource) => resource.uri),
  }));
} finally {
  await client.close();
}
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        fail("MCP stdio smoke check failed")

    output = json.loads(result.stdout)
    tools = set(output.get("tools", []))
    resources = set(output.get("resources", []))
    if not EXPECTED_TOOLS.issubset(tools):
        fail(f"MCP tools missing from stdio smoke check: {sorted(EXPECTED_TOOLS - tools)}")
    if not EXPECTED_RESOURCES.issubset(resources):
        fail(f"MCP resources missing from stdio smoke check: {sorted(EXPECTED_RESOURCES - resources)}")


def check_hosted_mcp_smoke() -> None:
    result = subprocess.run(
        ["node", "dist/http-smoke.js"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        fail("MCP hosted HTTP smoke check failed")

    output = json.loads(result.stdout)
    tools = set(output.get("tools", []))
    resources = set(output.get("resources", []))
    if not EXPECTED_HTTP_TOOLS.issubset(tools):
        fail(f"MCP tools missing from hosted smoke check: {sorted(EXPECTED_HTTP_TOOLS - tools)}")
    if not EXPECTED_RESOURCES.issubset(resources):
        fail(f"MCP resources missing from hosted smoke check: {sorted(EXPECTED_RESOURCES - resources)}")


def main() -> None:
    check_required_files()
    check_package_metadata()
    check_registry_metadata()
    check_docs()
    check_mcp_smoke()
    check_hosted_mcp_smoke()
    print("Release readiness checks passed")


if __name__ == "__main__":
    main()
