// Expected unit cost of one live tool call, copied from TweetAPI's published pricing rules. This is
// an estimate for planning: the MCP server never sees what TweetAPI actually charged, and it never
// infers a charge from balance changes. TweetAPI's own usage records stay authoritative.

export const PRICING_SOURCE_URL = "https://tweetapi.com/pricing.json";
export const USAGE_DOCS_URL = "https://tweetapi.com/docs/account/usage";

// Mirrors pricing.json `billing` and `endpointCosts` (checked 2026-10-28). The pricing test
// compares this against the dashboard's generated pricing.json when that checkout is present.
export const PRICING_RULES = {
  defaultUnits: 1,
  unitsByEndpoint: {
    "GET /tw-v2/account/usage": 0,
  } as Record<string, number>,
  billedStatusMin: 200,
  billedStatusMax: 499,
  nonBillableStatusCodes: [400, 401, 403, 409, 422, 429] as readonly number[],
} as const;

export type CostEstimate = {
  basis: "estimate";
  estimatedUnits: number | null;
  reason: string;
  source: string;
};

export function unitsPerBilledCall(method: string, path: string): number {
  return PRICING_RULES.unitsByEndpoint[`${method} ${path}`] ?? PRICING_RULES.defaultUnits;
}

export function estimateCallCost(method: string, path: string, statusCode: number): CostEstimate {
  const units = unitsPerBilledCall(method, path);

  if (units === 0) {
    return {
      basis: "estimate",
      estimatedUnits: 0,
      reason: "This endpoint is free. It still counts toward the per-minute request limit.",
      source: PRICING_SOURCE_URL,
    };
  }

  const billed =
    statusCode >= PRICING_RULES.billedStatusMin &&
    statusCode <= PRICING_RULES.billedStatusMax &&
    !PRICING_RULES.nonBillableStatusCodes.includes(statusCode);

  return {
    basis: "estimate",
    estimatedUnits: billed ? units : 0,
    reason: billed
      ? `TweetAPI bills ${units} unit per request with HTTP ${statusCode}, even when the result is empty.`
      : `TweetAPI does not bill requests that end with HTTP ${statusCode}.`,
    source: PRICING_SOURCE_URL,
  };
}

export function noRequestSentCost(): CostEstimate {
  return {
    basis: "estimate",
    estimatedUnits: 0,
    reason: "No request was sent to TweetAPI.",
    source: PRICING_SOURCE_URL,
  };
}

export function unknownOutcomeCost(): CostEstimate {
  return {
    basis: "estimate",
    estimatedUnits: null,
    reason:
      "The request may have reached TweetAPI before the connection failed, so whether it was billed is unknown. Check usage before retrying if units matter.",
    source: PRICING_SOURCE_URL,
  };
}

export function catalogCostSummary(method: string, path: string) {
  const units = unitsPerBilledCall(method, path);

  return {
    basis: "estimate" as const,
    unitsPerSuccessfulCall: units,
    note:
      units === 0
        ? "Free; counts toward the per-minute request limit."
        : "Billed per request, not per returned item. Empty results and not-found (404) results are billed; 400, 401, 403, 409, 422, 429, and 5xx results are not.",
    source: PRICING_SOURCE_URL,
  };
}
