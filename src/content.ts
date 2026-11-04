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

// For tools with an output schema: the text block carries the same JSON as structuredContent, so
// clients that only read text see exactly what structured clients see.
export function jsonStructured(value: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
    structuredContent: value,
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
