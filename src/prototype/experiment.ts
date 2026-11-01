import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { startFixtureServer, type FixtureServer, type ServedRequest } from "../../tests/fixtures/server.js";
import { CdpNetworkCollector, type MeasuredRequest } from "./network-collector.js";

/**
 * PROTOTYPE cold/warm cache experiment (Milestone 1).
 *
 * Scenarios, all against the deterministic local fixture server:
 *  1. cold            - brand-new BrowserContext (empty HTTP cache), new page.
 *  2. warm            - SAME context (its HTTP cache was populated by run 1), new page.
 *  3. warm-same-page  - same context AND same page as run 2, navigated again.
 *                       This reproduces the original prototype and exercises the
 *                       renderer's in-memory cache.
 *
 * Each run gets its own CDP collector and its own Playwright listeners, and the
 * server log is reset per run, so no measurement can leak between runs.
 */

/** Raw Playwright `request.sizes()` result, kept only as a cross-check against CDP. */
export interface PlaywrightSizesRecord {
  url: string;
  method: string;
  outcome: "finished" | "failed";
  sizes: Awaited<ReturnType<Request["sizes"]>> | null;
  error: string | null;
}

export interface Total {
  bytes: number; // sum of the KNOWN values
  complete: boolean; // false if any contributing value was unavailable
  unavailableCount: number;
}

export interface JourneyRun {
  label: string;
  durationMs: number;
  settled: boolean; // network went idle before the settle timeout
  requests: MeasuredRequest[];
  playwright: PlaywrightSizesRecord[];
  server: ServedRequest[];
  totals: { received: Total; transfer: Total };
  errors: string[];
}

export interface ExperimentResult {
  origin: string;
  runs: JourneyRun[];
}

/** The journey under test. */
async function performSearchJourney(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/search`);
  await page.waitForSelector("body[data-config-loaded]"); // app.js fetched /api/config
  await page.fill("#search-input", "laptop");
  await page.click("#search-button");
  await page.waitForSelector('[data-testid="search-results"]');
}

/** Records Playwright's own size numbers so we can show where they disagree with CDP. */
function recordPlaywrightSizes(page: Page) {
  const tasks: Promise<PlaywrightSizesRecord>[] = [];

  const measure = (request: Request, outcome: "finished" | "failed") =>
    request.sizes().then(
      (sizes): PlaywrightSizesRecord => ({ url: request.url(), method: request.method(), outcome, sizes, error: null }),
      (error: unknown): PlaywrightSizesRecord => ({
        url: request.url(),
        method: request.method(),
        outcome,
        sizes: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  const onFinished = (request: Request) => tasks.push(measure(request, "finished"));
  const onFailed = (request: Request) =>
    tasks.push(
      Promise.resolve({ url: request.url(), method: request.method(), outcome: "failed", sizes: null, error: request.failure()?.errorText ?? null }),
    );

  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);

  return {
    /** Await every measurement task (each task converts its own errors into data). */
    async collect(): Promise<PlaywrightSizesRecord[]> {
      const settled = await Promise.allSettled(tasks);
      return settled.map((s) =>
        s.status === "fulfilled"
          ? s.value
          : { url: "?", method: "?", outcome: "failed" as const, sizes: null, error: String(s.reason) },
      );
    },
    dispose(): void {
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

function sumTotal(values: (number | null)[]): Total {
  let bytes = 0;
  let unavailableCount = 0;
  for (const value of values) {
    if (value === null) unavailableCount++;
    else bytes += value;
  }
  return { bytes, complete: unavailableCount === 0, unavailableCount };
}

export async function runJourney(
  context: BrowserContext,
  page: Page,
  server: FixtureServer,
  label: string,
): Promise<JourneyRun> {
  server.resetRequestLog();
  const collector = await CdpNetworkCollector.attach(context, page);
  const playwright = recordPlaywrightSizes(page);

  try {
    const start = performance.now();
    await performSearchJourney(page, server.url);
    const durationMs = Math.round(performance.now() - start);

    // Let trailing requests finish so they are measured in THIS run, not lost or leaked.
    const settled = await collector.waitForIdle();
    const playwrightRecords = await playwright.collect();
    const requests = collector.snapshot();

    return {
      label,
      durationMs,
      settled,
      requests,
      playwright: playwrightRecords,
      server: [...server.requests],
      totals: {
        received: sumTotal(requests.map((r) => r.measurement.receivedBytes)),
        transfer: sumTotal(requests.map((r) => r.measurement.transferBytes)),
      },
      errors: [...collector.errors],
    };
  } finally {
    playwright.dispose();
    await collector.detach().catch(() => {
      /* page may already be gone; nothing left to collect */
    });
  }
}

/** Run every cleanup step even if earlier ones fail; return the failures. */
async function cleanup(steps: [string, (() => Promise<void>) | undefined][]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const [name, step] of steps) {
    if (!step) continue;
    try {
      await step();
    } catch (error) {
      failures.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return failures;
}

export async function runCacheExperiment({ headless = true } = {}): Promise<ExperimentResult> {
  const server = await startFixtureServer();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failed = false;

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext(); // fresh context == empty HTTP cache

    const coldPage = await context.newPage();
    const cold = await runJourney(context, coldPage, server, "cold");
    await coldPage.close(); // closing a page does not clear the context's HTTP cache

    const warmPage = await context.newPage();
    const warm = await runJourney(context, warmPage, server, "warm");
    const warmSamePage = await runJourney(context, warmPage, server, "warm-same-page");

    return { origin: server.url, runs: [cold, warm, warmSamePage] };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const failures = await cleanup([
      ["close context", context && (() => context!.close())],
      ["close browser", browser && (() => browser!.close())],
      ["close fixture server", () => server.close()],
    ]);
    // Never let a cleanup error hide the original failure.
    if (failures.length > 0 && !failed) throw new AggregateError(failures, "cleanup failed");
  }
}

// ---------------------------------------------------------------------------
// Validation against the fixture server's ground truth
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  path: string;
  check: string;
  expected: number | string | null;
  actual: number | string | null;
  ok: boolean;
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/**
 * Compare what the browser reported with what the server actually sent/received.
 * Valid for this loopback HTTP/1.1 fixture, where the server's socket byte
 * counters are exact application-layer ground truth.
 */
export function validateAgainstServer(run: JourneyRun, origin: string): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const unmatched = [...run.server];
  const sameOrigin = run.requests.filter((r) => r.url.startsWith(origin));

  for (const r of sameOrigin) {
    const path = pathOf(r.url);
    const m = r.measurement;
    const isNetwork = m.source === "network" || m.source === "network-revalidated";
    const index = unmatched.findIndex((s) => s.path === path && s.method === r.method);

    if (isNetwork) {
      if (index === -1) {
        checks.push({ path, check: "server saw request", expected: "yes", actual: "no", ok: false });
        continue;
      }
      const served = unmatched.splice(index, 1)[0]!;
      checks.push({ path, check: "wire status", expected: served.status, actual: r.raw.wireStatus, ok: served.status === r.raw.wireStatus });
      checks.push({
        path,
        check: "received bytes",
        expected: served.responseWireBytes,
        actual: m.receivedBytes,
        ok: served.responseWireBytes === m.receivedBytes,
      });
      checks.push({
        path,
        check: "encoded body bytes",
        expected: served.bodyBytes,
        actual: m.encodedBodyBytes,
        ok: served.bodyBytes === m.encodedBodyBytes,
      });
      const sent = m.requestHeaderBytes !== null && m.requestBodyBytes !== null ? m.requestHeaderBytes + m.requestBodyBytes : null;
      checks.push({ path, check: "sent bytes", expected: served.requestWireBytes, actual: sent, ok: served.requestWireBytes === sent });
    } else if (m.status === "cache-hit") {
      checks.push({ path, check: "server NOT contacted", expected: "no request", actual: index === -1 ? "no request" : "request seen", ok: index === -1 });
    }
  }

  for (const served of unmatched) {
    checks.push({ path: served.path, check: "browser reported server request", expected: "yes", actual: "no", ok: false });
  }
  return checks;
}