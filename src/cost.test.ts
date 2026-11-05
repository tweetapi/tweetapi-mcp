import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  catalogCostSummary,
  estimateCallCost,
  noRequestSentCost,
  PRICING_RULES,
  PRICING_SOURCE_URL,
  unitsPerBilledCall,
  unknownOutcomeCost,
} from "./cost.js";
import { LIVE_TOOL_ENDPOINTS } from "./live.js";

const DASHBOARD_PRICING_PATH = join(
  process.env.TWEETAPI_DASHBOARD_REPO ?? resolve(process.cwd(), "../tweetapi-dashboard"),
  "public/pricing.json"
);

describe("unit cost estimates", () => {
  it("labels every estimate as an estimate with its published source", () => {
    for (const estimate of [
      estimateCallCost("GET", "/tw-v2/search", 200),
      noRequestSentCost(),
      unknownOutcomeCost(),
    ]) {
      expect(estimate.basis).toBe("estimate");
      expect(estimate.source).toBe(PRICING_SOURCE_URL);
    }
  });

  it("follows the published billing rules by status code", () => {
    expect(estimateCallCost("GET", "/tw-v2/search", 200).estimatedUnits).toBe(1);
    expect(estimateCallCost("GET", "/tw-v2/tweet/details", 404).estimatedUnits).toBe(1);
    for (const status of [400, 401, 403, 409, 422, 429, 500, 502, 503, 504]) {
      expect(estimateCallCost("GET", "/tw-v2/search", status).estimatedUnits).toBe(0);
    }
    expect(unknownOutcomeCost().estimatedUnits).toBeNull();
  });

  it("treats account usage as free", () => {
    expect(unitsPerBilledCall("GET", "/tw-v2/account/usage")).toBe(0);
    expect(estimateCallCost("GET", "/tw-v2/account/usage", 200)).toMatchObject({
      estimatedUnits: 0,
    });
    expect(catalogCostSummary("GET", "/tw-v2/account/usage").unitsPerSuccessfulCall).toBe(0);
  });

  it("prices every live tool as 1 unit except the free usage check", () => {
    for (const endpoint of LIVE_TOOL_ENDPOINTS) {
      expect(unitsPerBilledCall(endpoint.method, endpoint.path)).toBe(
        endpoint.path === "/tw-v2/account/usage" ? 0 : 1
      );
    }
  });

  it.skipIf(!existsSync(DASHBOARD_PRICING_PATH))(
    "matches the dashboard's generated pricing.json for every live tool",
    () => {
      const pricing = JSON.parse(readFileSync(DASHBOARD_PRICING_PATH, "utf8")) as {
        billing: { billedStatusRange: string; nonBillableStatusCodes: number[] };
        endpointCosts: {
          defaultUnits: number;
          unitsByEndpoint: Array<{ method: string; path: string; units: number }>;
        };
      };

      expect(pricing.endpointCosts.defaultUnits).toBe(PRICING_RULES.defaultUnits);
      expect(pricing.billing.billedStatusRange).toBe(
        `${PRICING_RULES.billedStatusMin}-${PRICING_RULES.billedStatusMax}`
      );
      expect([...pricing.billing.nonBillableStatusCodes].sort()).toEqual(
        [...PRICING_RULES.nonBillableStatusCodes].sort()
      );

      for (const endpoint of LIVE_TOOL_ENDPOINTS) {
        const published =
          pricing.endpointCosts.unitsByEndpoint.find(
            (entry) => entry.method === endpoint.method && entry.path === endpoint.path
          )?.units ?? pricing.endpointCosts.defaultUnits;

        expect(unitsPerBilledCall(endpoint.method, endpoint.path), endpoint.name).toBe(published);
      }
    }
  );
});
