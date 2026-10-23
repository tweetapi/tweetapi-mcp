import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonText(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}

export function jsonError(code: string, message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            details,
          },
        }),
      },
    ],
  };
}
