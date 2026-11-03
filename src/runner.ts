import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  StepNetworkCollector,
  aggregateByResourceType,
  aggregateByStep,
  sumByteTotals,
  type StepTimingRecord,
} from "./collector.js";
import type {
  CacheMode,
  CostEstimate,
  JourneyConfig,
  JourneyRunReport,
  PricingConfig,
  ProjectConfig,
  StepConfig,
} from "./types.js";

/**
 * Executes a single configured step on a Playwright Page.
 */
export async function executeStep(
  page: Page,
  step: StepConfig,
  baseUrl: string,
  defaultTimeoutMs: number,
): Promise<void> {
  switch (step.action) {
    case "navigate": {
      const targetUrl = new URL(step.url, baseUrl).toString();
      await page.goto(targetUrl, { timeout: defaultTimeoutMs });
      break;
    }
    case "fill": {
        await page.fill(step.selector, step.value, { timeout: defaultTimeoutMs });
        break;
    }
    case "click": {
        await page.click(step.selector, { timeout: defaultTimeoutMs });
        break;
    }
    case "wait-for": {
        await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? defaultTimeoutMs });
        break;
    }
  }
}

/**
 * Calculates estimated data cost using decimal gigabytes (1 GB = 1,000,000,000 bytes).
 */
export function calculateCostEstimate(
  transferBytes: number,
  pricing: PricingConfig,
): CostEstimate {
  const estimatedCost = (transferBytes / 1_000_000_000) * pricing.pricePerGB;
  const currency = pricing.currency;
  const pricePerGB = pricing.pricePerGB;

  return {
    currency,
    pricePerGB,
    transferBytes,
    estimatedCost
  }
}

/**
 * Runs a single journey inside an existing BrowserContext and measures it.
 */
async function measureSingleJourneyInContext(
  context: BrowserContext,
  journey: JourneyConfig,
  config: ProjectConfig,
  cacheMode: CacheMode,
): Promise<JourneyRunReport> {
  const defaultTimeoutMs = config.measurement?.defaultTimeoutMs ?? 30_000;
  const page = await context.newPage();
  const collector = await StepNetworkCollector.attach(context, page);

  const startedAtIso = new Date().toISOString();
  const journeyStart = performance.now();
  const stepTimings: StepTimingRecord[] = [];
  let outcome: "passed" | "failed" = "passed";
  let errorMessage: string | undefined;

  try {
    for (const step of journey.steps) {
      collector.setCurrentStep(step.name);
      const stepStart = performance.now();
      try {
        await executeStep(page, step, config.baseUrl, defaultTimeoutMs);
      } finally {
        stepTimings.push({
          step,
          durationMs: Math.round(performance.now() - stepStart),
        });
      }
    }
  } catch (error) {
    outcome = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const durationMs = Math.round(performance.now() - journeyStart);

  // Wait briefly for in-flight requests to settle before taking snapshot
  await collector.waitForIdle({ quietMs: 200, timeoutMs: 3_000 });
  const observations = collector.snapshot();

  await collector.detach().catch(() => {});
  await page.close().catch(() => {});

  const received = sumByteTotals(observations.map((o) => o.bytes.receivedBytes));
  const transfer = sumByteTotals(observations.map((o) => o.bytes.transferBytes));
  const cachedRequestCount = observations.filter((o) => o.status === "cache-hit").length;

  const cost =
    config.pricing && transfer.complete
      ? calculateCostEstimate(transfer.bytes, config.pricing)
      : undefined;

  return {
    schemaVersion: "1.0",
    journeyName: journey.name,
    baseUrl: config.baseUrl,
    cacheMode,
    startedAtIso,
    durationMs,
    outcome,
    error: errorMessage,
    totals: {
      requestCount: observations.length,
      cachedRequestCount,
      received,
      transfer,
    },
    byStep: aggregateByStep(stepTimings, observations),
    byResourceType: aggregateByResourceType(observations),
    cost,
    observations,
  };
}

/**
 * Runs a configured journey (handling cold vs. warm cache setup) and returns a JourneyRunReport.
 */
export async function runJourney(
  config: ProjectConfig,
  journeyName: string,
): Promise<JourneyRunReport> {
  const journey = config.journeys.find((j) => j.name === journeyName);
  if (!journey) {
    throw new Error(`Journey "${journeyName}" not found in configuration.`);
  }

  const cacheMode: CacheMode = config.measurement?.cacheMode ?? "cold";
  const headless = config.measurement?.headless ?? true;
  const defaultTimeoutMs = config.measurement?.defaultTimeoutMs ?? 30_000;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext();

    // If warm cache mode is requested, execute the steps once to populate the HTTP cache!
    if (cacheMode === "warm") {
      const warmupPage = await context.newPage();
      try {
        for (const step of journey.steps) {
          await executeStep(warmupPage, step, config.baseUrl, defaultTimeoutMs);
        }
      } finally {
        await warmupPage.close().catch(() => {});
      }
    }

    return await measureSingleJourneyInContext(context, journey, config, cacheMode);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}