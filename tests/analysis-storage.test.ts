import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { evaluateBudget, compareReports } from "../src/analysis.js";
import {
  redactUrl,
  saveRunReport,
  loadLatestRunReport,
  saveBaselineReport,
  loadBaselineReport,
} from "../src/storage.js";
import type { JourneyRunReport } from "../src/types.js";

function createSampleReport(overrides: Partial<JourneyRunReport> = {}): JourneyRunReport {
  return {
    schemaVersion: "1.0",
    journeyName: "search",
    baseUrl: "http://localhost:3000",
    cacheMode: "cold",
    startedAtIso: "2026-11-03T12:00:00.000Z",
    durationMs: 1200,
    outcome: "passed",
    totals: {
      requestCount: 2,
      cachedRequestCount: 0,
      received: { bytes: 18_000, complete: true, unavailableCount: 0 },
      transfer: { bytes: 20_000, complete: true, unavailableCount: 0 },
    },
    byStep: [],
    byResourceType: {},
    observations: [
      {
        url: "http://localhost:3000/api/search?q=laptop&token=supersecret123",
        method: "GET",
        resourceType: "Fetch",
        pageStatus: 200,
        wireStatus: 200,
        protocol: "http/1.1",
        source: "network",
        status: "measured",
        notes: [],
        startedAtStep: "submit-search",
        completedAtStep: "wait-for-results",
        bytes: {
          receivedBytes: 18_000,
          responseHeaderBytes: 200,
          encodedBodyBytes: 17_800,
          decodedBodyBytes: 17_800,
          requestHeaderBytes: 2_000,
          requestBodyBytes: 0,
          transferBytes: 20_000,
        },
      },
    ],
    ...overrides,
  };
}

describe("Budget Analysis, Baseline Comparison & Privacy Storage (Phase 4)", () => {
  it("passes budget evaluation when transfer and duration are within limits", () => {
    const report = createSampleReport();
    const result = evaluateBudget(report, {
      maxTransferBytes: 25_000,
      maxDurationMs: 2_000,
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails budget evaluation when transfer or duration exceeds limits", () => {
    const report = createSampleReport();
    const result = evaluateBudget(report, { maxTransferBytes: 15_000, maxDurationMs: 1_000 });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("compares baseline and current reports and flags cacheMode incompatibility", () => {
    const baseline = createSampleReport({ durationMs: 1000 });
    const current = createSampleReport({
      durationMs: 1500,
      totals: {
        requestCount: 2,
        cachedRequestCount: 0,
        received: { bytes: 22_000, complete: true, unavailableCount: 0 },
        transfer: { bytes: 25_000, complete: true, unavailableCount: 0 },
      },
    });

    const comparison = compareReports(baseline, current);
    expect(comparison.compatible).toBe(true);
    expect(comparison.transfer.deltaBytes).toBe(5_000);
    expect(comparison.transfer.deltaPercent).toBe(25);
    expect(comparison.duration.deltaMs).toBe(500);
    expect(comparison.duration.deltaPercent).toBe(50);

    // Incompatible cache modes (cold vs warm)
    const warmRun = createSampleReport({ cacheMode: "warm" });
    expect(compareReports(baseline, warmRun).compatible).toBe(false);
  });

  it("redacts sensitive query parameters from URLs without touching normal query params", () => {
    expect(redactUrl("http://localhost:3000/api?q=laptop&api_key=mysecret&token=abc")).toBe("http://localhost:3000/api?q=laptop&api_key=REDACTED&token=REDACTED");
  });

  it("saves and loads redacted run reports and baselines without overwriting baselines on normal runs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-storage-"));
    try {
      const baselineReport = createSampleReport({ durationMs: 1000 });
      saveBaselineReport(baselineReport, tmpDir);

      const newRunReport = createSampleReport({ durationMs: 1800 });
      saveRunReport(newRunReport, tmpDir);

      const loadedRun = loadLatestRunReport("search", tmpDir);
      const loadedBaseline = loadBaselineReport("search", tmpDir);

      // Latest run has 1800ms, while baseline was NOT overwritten and still has 1000ms!
      expect(loadedRun.durationMs).toBe(1800);
      expect(loadedBaseline.durationMs).toBe(1000);

      // Sensitive token in observation URL was redacted on disk!
      expect(loadedRun.observations[0]?.url).toContain("token=REDACTED");
      expect(loadedRun.observations[0]?.url).not.toContain("supersecret123");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});