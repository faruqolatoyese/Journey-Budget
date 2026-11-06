import type { BudgetLimit, JourneyRunReport } from "./types.js";

export interface BudgetViolation {
  metric: "outcome" | "transfer" | "duration";
  message: string;
  limit?: number;
  actual?: number;
}

export interface BudgetEvaluationResult {
  journeyName: string;
  passed: boolean;
  violations: BudgetViolation[];
}

export interface RunComparisonResult {
  journeyName: string;
  compatible: boolean;
  incompatibilityReason?: string;
  baselineCacheMode: string;
  currentCacheMode: string;
  transfer: {
    baselineBytes: number;
    currentBytes: number;
    deltaBytes: number;
    deltaPercent: number | null;
  };
  duration: {
    baselineMs: number;
    currentMs: number;
    deltaMs: number;
    deltaPercent: number | null;
  };
}

/**
 * Evaluates a JourneyRunReport against a configured BudgetLimit.
 * Uses decimal megabytes (1 MB = 1,000,000 bytes).
 */
export function evaluateBudget(
  report: JourneyRunReport,
  budget: BudgetLimit,
): BudgetEvaluationResult {
  const violations: BudgetViolation[] = [];

  // 1. If the journey itself failed, the check fails immediately.
  if (report.outcome === "failed") {
    violations.push({
      metric: "outcome",
      message: `Journey execution failed: ${report.error ?? "unknown error"}`,
    });
  }

  // 2. Check transfer size limits (maxTransferBytes or maxTransferMB)
  const maxAllowedBytes =
    budget.maxTransferBytes ??
    (budget.maxTransferMB !== undefined
      ? Math.round(budget.maxTransferMB * 1_000_000)
      : undefined);

  if (maxAllowedBytes !== undefined) {
    if (!report.totals.transfer.complete) {
      violations.push({
        metric: "transfer",
        message: `Transfer measurement is incomplete (${report.totals.transfer.unavailableCount} request(s) unavailable); cannot verify budget of ${maxAllowedBytes} bytes.`,
        limit: maxAllowedBytes,
        actual: report.totals.transfer.bytes,
      });
    } else if (report.totals.transfer.bytes > maxAllowedBytes) {
      violations.push({
        metric: "transfer",
        message: `Transfer size ${report.totals.transfer.bytes} bytes exceeded budget limit of ${maxAllowedBytes} bytes.`,
        limit: maxAllowedBytes,
        actual: report.totals.transfer.bytes,
      });
    }
  }

  if(budget.maxDurationMs !== undefined && report.durationMs > budget.maxDurationMs){
    violations.push({
        metric: "duration",
        message: `Duration ${report.durationMs} ms exceeded budget limit of ${budget.maxDurationMs} ms.`,
        limit: budget.maxDurationMs,
        actual: report.durationMs,
    })
  }

  return {
    journeyName: report.journeyName,
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Compares a current JourneyRunReport against a baseline JourneyRunReport.
 */
export function compareReports(
  baseline: JourneyRunReport,
  current: JourneyRunReport,
): RunComparisonResult {
  let compatible = true;
  let incompatibilityReason: string | undefined;

  if (baseline.journeyName !== current.journeyName) {
    compatible = false;
    incompatibilityReason = `Journey name mismatch: baseline is "${baseline.journeyName}" but current is "${current.journeyName}".`;
  } else if (baseline.cacheMode !== current.cacheMode) {
    compatible = false;
    incompatibilityReason = `Cache mode mismatch: baseline was "${baseline.cacheMode}" but current was "${current.cacheMode}".`;
  }

  const baselineBytes = baseline.totals.transfer.bytes;
  const currentBytes = current.totals.transfer.bytes;

  const baselineMs = baseline.durationMs;
  const currentMs = current.durationMs;

  const deltaBytes = currentBytes - baselineBytes;
  const transferDeltaPercent = baselineBytes > 0 ? (deltaBytes / baselineBytes) * 100 : null;
  const deltaMs = currentMs - baselineMs;
  const durationDeltaPercent = baselineMs > 0 ? (deltaMs / baselineMs) * 100 : null;

  return {
    journeyName: current.journeyName,
    compatible,
    incompatibilityReason,
    baselineCacheMode: baseline.cacheMode,
    currentCacheMode: current.cacheMode,
    transfer: {
      baselineBytes,
      currentBytes,
      deltaBytes,
      deltaPercent: transferDeltaPercent,
    },
    duration: {
      baselineMs,
      currentMs,
      deltaMs,
      deltaPercent: durationDeltaPercent,
    },
  };
}