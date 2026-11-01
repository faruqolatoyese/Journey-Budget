/**
 * Milestone 1 measurement prototype.
 *
 *   npx tsx src/prototype.ts            (headless)
 *
 * Runs the search journey against the local fixture server in a cold-cache
 * context, then twice more in the same (warm) context, and prints per-request
 * measurements next to the server's ground truth.
 */
import { runCacheExperiment } from "./prototype/experiment.js";
import { printExperiment } from "./prototype/report.js";

try {
  const result = await runCacheExperiment({ headless: !process.argv.includes("--headed") });
  printExperiment(result);
} catch (error) {
  console.error("Prototype failed:", error);
  process.exitCode = 1;
}