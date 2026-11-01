import { beforeAll, describe, expect, it } from "vitest";
import { runCacheExperiment, validateAgainstServer, type ExperimentResult, type JourneyRun } from "../src/prototype/experiment.js";

/**
 * Integration test: drives real headless Chromium against the local fixture.
 * Asserts on behaviour we verified empirically, and cross-checks every number
 * against the fixture server's own wire-level byte counters.
 */

const CACHEABLE = ["/styles.css", "/logo.svg", "/app.js", "/api/config"];

let result: ExperimentResult;
const run = (label: string): JourneyRun => result.runs.find((r) => r.label === label)!;
const byPath = (r: JourneyRun, path: string) => r.requests.find((q) => q.url === `${result.origin}${path}`)!;

describe("cold vs warm cache experiment", () => {
  beforeAll(async () => {
    result = await runCacheExperiment();
  }, 60_000);

  it("observes all six fixture resources in every run, all settled, no collector errors", () => {
    for (const r of result.runs) {
      expect(r.settled).toBe(true);
      expect(r.errors).toEqual([]);
      const paths = r.requests.map((q) => q.url.replace(result.origin, "")).sort();
      expect(paths).toEqual(["/api/config", "/api/search?q=laptop", "/app.js", "/logo.svg", "/search", "/styles.css"]);
      expect(r.durationMs).toBeGreaterThan(0);
    }
  });

  it("matches the server's ground truth byte-for-byte in every run", () => {
    for (const r of result.runs) {
      const failures = validateAgainstServer(r, result.origin).filter((c) => !c.ok);
      expect(failures, r.label).toEqual([]);
    }
  });

  it("cold run: every resource comes from the network and the total is complete", () => {
    const cold = run("cold");
    expect(cold.requests.every((q) => q.measurement.source === "network")).toBe(true);
    expect(cold.server).toHaveLength(6);
    expect(cold.totals.transfer.complete).toBe(true);
    // gzip: on-the-wire CSS body is much smaller than the decoded stylesheet
    const css = byPath(cold, "/styles.css").measurement;
    expect(css.encodedBodyBytes!).toBeLessThan(css.decodedBodyBytes! / 5);
  });

  it("warm run: cacheable resources are HTTP-cache hits, HTML revalidates, no-store API refetches", () => {
    const warm = run("warm");
    for (const path of CACHEABLE) {
      const m = byPath(warm, path).measurement;
      expect(["disk-cache", "memory-cache"], path).toContain(m.source);
      expect(m.status, path).toBe("cache-hit");
      expect(m.transferBytes, path).toBe(0);
      expect(m.decodedBodyBytes!, path).toBeGreaterThan(0); // the page still used the resource
    }
    const html = byPath(warm, "/search");
    expect(html.measurement.source).toBe("network-revalidated");
    expect(html.raw.wireStatus).toBe(304);
    expect(html.pageStatus).toBe(200); // what the page (and Playwright) sees
    expect(byPath(warm, "/api/search?q=laptop").measurement.source).toBe("network");
    expect(warm.server.map((s) => s.path)).toEqual(["/search", "/api/search?q=laptop"]);
  });

  it("warm runs transfer less than the cold run, with complete totals", () => {
    const cold = run("cold").totals.transfer;
    for (const label of ["warm", "warm-same-page"]) {
      const warm = run(label).totals.transfer;
      expect(warm.complete, label).toBe(true);
      expect(warm.bytes, label).toBeLessThan(cold.bytes);
    }
  });

  it("never produces a negative derived byte value", () => {
    for (const r of result.runs) {
      for (const q of r.requests) {
        const m = q.measurement;
        for (const value of [m.receivedBytes, m.responseHeaderBytes, m.encodedBodyBytes, m.decodedBodyBytes, m.requestHeaderBytes, m.requestBodyBytes, m.transferBytes]) {
          if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
