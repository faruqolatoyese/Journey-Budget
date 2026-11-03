import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sumByteTotals } from "../src/collector.js";
import { calculateCostEstimate, runJourney } from "../src/runner.js";
import type { ProjectConfig } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./fixtures/server.js";

describe("Journey Runner & Step Attribution (Phase 3)", () => {
    let server: FixtureServer;

    beforeAll(async () => {
        server = await startFixtureServer();
    });

    afterAll(async () => {
        await server.close();
    });

    it("sums byte totals and tracks unavailable (null) values", () => {
        expect(sumByteTotals([100, 250, 50])).toEqual({
            bytes: 400,
            complete: true,
            unavailableCount: 0,
        });

        expect(sumByteTotals([100, null, 250])).toEqual({
            bytes: 350, complete: false, unavailableCount: 1
        })
    });

    it("calculates estimated data cost using 1 GB = 1,000,000,000 bytes", () => {
        expect(calculateCostEstimate(500_000_000, { currency: "NGN", pricePerGB: 1000 })).toEqual({
            currency: "NGN",
            pricePerGB: 1000,
            transferBytes: 500_000_000,
            estimatedCost: 500,
        });
    });

    it("executes a multi-step journey in cold and warm cache modes and attributes requests to steps without double-counting", async () => {
        const baseConfig: ProjectConfig = {
            baseUrl: server.url,
            journeys: [
                {
                    name: "search",
                    steps: [
                        { name: "open-search", action: "navigate", url: "/search" },
                        { name: "wait-config", action: "wait-for", selector: "body[data-config-loaded]" },
                        { name: "enter-query", action: "fill", selector: "#search-input", value: "laptop" },
                        { name: "submit-search", action: "click", selector: "#search-button" },
                        { name: "wait-for-results", action: "wait-for", selector: "[data-testid=search-results]" },
                    ],
                },
            ],
            pricing: {
                currency: "NGN",
                pricePerGB: 500,
            },
            measurement: {
                browser: "chromium",
                cacheMode: "cold",
            },
        };

        // 1. Cold Run
        const coldReport = await runJourney(baseConfig, "search");
        expect(coldReport.outcome).toBe("passed");
        expect(coldReport.totals.requestCount).toBe(6);
        expect(coldReport.totals.cachedRequestCount).toBe(0);
        expect(coldReport.totals.transfer.complete).toBe(true);

        // Sum of all step transfer bytes must equal the journey total (no double-counting!)
        const sumOfSteps = coldReport.byStep.reduce((sum, s) => sum + s.transfer.bytes, 0);
        expect(sumOfSteps).toBe(coldReport.totals.transfer.bytes);

        // Sum of all resource-type transfer bytes must also equal the journey total
        const sumOfResourceTypes = Object.values(coldReport.byResourceType).reduce(
            (sum, r) => sum + r.bytes,
            0,
        );
        expect(sumOfResourceTypes).toBe(coldReport.totals.transfer.bytes);

        // 2. Warm Run
        const warmReport = await runJourney(
            {
                ...baseConfig,
                measurement: { browser: "chromium", cacheMode: "warm" },
            },
            "search",
        );
        expect(warmReport.outcome).toBe("passed");
        expect(warmReport.totals.cachedRequestCount).toBe(4);
        expect(warmReport.totals.transfer.bytes).toBeLessThan(coldReport.totals.transfer.bytes);
    }, 60_000);
});