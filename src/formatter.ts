import type { BudgetEvaluationResult, RunComparisonResult } from "./analysis.js";
import type { ByteTotal, JourneyRunReport } from "./types.js";

/**
 * Formats a byte count into a human-readable string using decimal units
 * (1 KB = 1,000 B, 1 MB = 1,000,000 B).
 */
export function formatBytes(bytes: number): string {
    if (Math.abs(bytes) >= 1_000_000) {
        return `${(bytes / 1_000_000).toFixed(2)} MB`;
    }
    if (Math.abs(bytes) >= 1_000) {
        return `${(bytes / 1_000).toFixed(2)} KB`;
    }
    return `${bytes} B`;
}

function formatByteTotal(total: ByteTotal): string {
    const base = `${formatBytes(total.bytes)} (${total.bytes} B)`;
    return total.complete
        ? base
        : `INCOMPLETE >= ${base} [${total.unavailableCount} unavailable]`;
}

/**
 * Formats a JourneyRunReport into a clean terminal summary.
 */
export function formatRunReport(report: JourneyRunReport): string {
    const lines: string[] = [];
    lines.push(`=== Journey Report: ${report.journeyName} ===`);
    lines.push(`Status:       ${report.outcome.toUpperCase()}`);
    if (report.error) {
        lines.push(`Error:        ${report.error}`);
    }
    lines.push(`Base URL:     ${report.baseUrl}`);
    lines.push(`Cache Mode:   ${report.cacheMode}`);
    lines.push(`Duration:     ${report.durationMs} ms`);
    lines.push(
        `Requests:     ${report.totals.requestCount} total (${report.totals.cachedRequestCount} from cache)`,
    );
    lines.push(`Received:     ${formatByteTotal(report.totals.received)}`);
    lines.push(`Transfer:     ${formatByteTotal(report.totals.transfer)}`);

    if (report.cost) {
        lines.push(
            `Est. Cost:    ${report.cost.estimatedCost.toFixed(4)} ${report.cost.currency} (@ ${report.cost.pricePerGB} ${report.cost.currency}/GB)`,
        );
    }

    lines.push(`\n--- Breakdown by Step ---`);
    for (const step of report.byStep) {
        lines.push(
            `  [${step.stepName}] (${step.action}) -> ${formatBytes(step.transfer.bytes)} | ${step.durationMs} ms | ${step.requestCount} req (${step.cachedRequestCount} cached)`,
        );
    }

    lines.push(`\n--- Breakdown by Resource Type ---`);
    for (const [type, total] of Object.entries(report.byResourceType)) {
        lines.push(`  ${type.padEnd(12)}: ${formatBytes(total.bytes)} (${total.bytes} B)`);
    }

    return lines.join("\n");
}

/**
 * Formats a BudgetEvaluationResult into a readable pass/fail block.
 */
export function formatBudgetResult(result: BudgetEvaluationResult): string {
    if (result.passed) {
        return `[PASS] Journey "${result.journeyName}" is within all configured budgets.`
    }
    return `[FAIL] Journey "${result.journeyName}" exceeded budget limits:\n` +
        result.violations.map((v) => `  - ${v.message}`).join("\n")
}

/**
 * Formats a RunComparisonResult comparing a current run with a baseline.
 */
export function formatComparison(comp: RunComparisonResult): string {
    const lines: string[] = [];
    lines.push(`=== Comparison: ${comp.journeyName} (Baseline vs. Current) ===`);

    if (!comp.compatible) {
        lines.push(`[WARNING] Incompatible runs: ${comp.incompatibilityReason}`);
    }

    const byteSign = comp.transfer.deltaBytes > 0 ? "+" : "";
    const bytePct =
        comp.transfer.deltaPercent !== null
            ? ` (${byteSign}${comp.transfer.deltaPercent.toFixed(1)}%)`
            : "";
    lines.push(
        `Transfer:  ${formatBytes(comp.transfer.baselineBytes)} -> ${formatBytes(comp.transfer.currentBytes)} [Delta: ${byteSign}${formatBytes(comp.transfer.deltaBytes)}${bytePct}]`,
    );

    const timeSign = comp.duration.deltaMs > 0 ? "+" : "";
    const timePct =
        comp.duration.deltaPercent !== null
            ? ` (${timeSign}${comp.duration.deltaPercent.toFixed(1)}%)`
            : "";
    lines.push(
        `Duration:  ${comp.duration.baselineMs} ms -> ${comp.duration.currentMs} ms [Delta: ${timeSign}${comp.duration.deltaMs} ms${timePct}]`,
    );

    return lines.join("\n");
}

/**
 * Formats one or more journey reports and budget evaluations as a GitHub-Flavored Markdown table
 * for GitHub Actions Job Summaries ($GITHUB_STEP_SUMMARY).
 */
export function formatMarkdownSummary(
  items: { report: JourneyRunReport; evaluation?: BudgetEvaluationResult }[],
): string {
  const lines: string[] = [];
  lines.push("## 📊 Journey Budget Report\n");
  lines.push(
    "| Journey | Cache Mode | Transfer | Duration | Est. Cost | Budget Status |",
  );
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- |");

  for (const { report, evaluation } of items) {
    const transferStr = report.totals.transfer.complete
      ? formatBytes(report.totals.transfer.bytes)
      : `>= ${formatBytes(report.totals.transfer.bytes)} (incomplete)`;

    const costStr = report.cost
      ? `${report.cost.estimatedCost.toFixed(4)} ${report.cost.currency}`
      : "N/A";
    let statusStr = "ℹ️ No Budget";
    if (report.outcome === "failed") {
      statusStr = "❌ Run Failed";
    } else if (evaluation) {
      statusStr = evaluation.passed ? "✅ Passed" : "❌ Exceeded";
    }

    lines.push(
      `| **${report.journeyName}** | \`${report.cacheMode}\` | ${transferStr} | ${report.durationMs} ms | ${costStr} | ${statusStr} |`,
    );
  }

  return lines.join("\n") + "\n";
}