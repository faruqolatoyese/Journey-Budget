import fs from "node:fs";
import path from "node:path";
import type { JourneyRunReport } from "./types.js";

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "passwd",
  "auth",
  "code",
  "session",
  "sig",
  "signature",
]);

/**
 * Redacts sensitive query parameter values in a URL (e.g. ?token=abc -> ?token=[REDACTED]).
 */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    let changed = false;

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "REDACTED");
        changed = true;
      }
    }

    return changed ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Returns a sanitized copy of a JourneyRunReport with all observation URLs redacted.
 */
export function redactReport(report: JourneyRunReport): JourneyRunReport {
  return {
    ...report,
    observations: report.observations.map((obs) => ({
      ...obs,
      url: redactUrl(obs.url),
    })),
  };
}

/**
 * Saves a JourneyRunReport as the latest run in `<storageDir>/runs/<journeyName>-latest.json`.
 */
export function saveRunReport(
  report: JourneyRunReport,
  storageDir = ".journey-budget",
): string {
  const runsDir = path.join(storageDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  const sanitized = redactReport(report);
  const filePath = path.join(runsDir, `${report.journeyName}-latest.json`);
  fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), "utf-8");
  return filePath;
}

/**
 * Loads the latest saved JourneyRunReport for a journey.
 */
export function loadLatestRunReport(
  journeyName: string,
  storageDir = ".journey-budget",
): JourneyRunReport {
  const filePath = path.join(storageDir, "runs", `${journeyName}-latest.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No saved run found for journey "${journeyName}" at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JourneyRunReport;
}

/**
 * Explicitly saves a JourneyRunReport as the approved baseline in `<storageDir>/baselines/<journeyName>.json`.
 */
export function saveBaselineReport(
  report: JourneyRunReport,
  storageDir = ".journey-budget",
): string {
  const baselinesDir = path.join(storageDir, "baselines");
  fs.mkdirSync(baselinesDir, { recursive: true });

  const sanitized = redactReport(report);
  const filePath = path.join(baselinesDir, `${report.journeyName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), "utf-8");
  return filePath;
}

/**
 * Loads the saved baseline JourneyRunReport for a journey.
 */
export function loadBaselineReport(
  journeyName: string,
  storageDir = ".journey-budget",
): JourneyRunReport {
  const filePath = path.join(storageDir, "baselines", `${journeyName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No baseline found for journey "${journeyName}" at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JourneyRunReport;
}