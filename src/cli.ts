#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { compareReports, evaluateBudget } from "./analysis.js";
import { loadConfigFile } from "./config.js";
import {
  formatBudgetResult,
  formatComparison,
  formatRunReport,
} from "./formatter.js";
import { runJourney } from "./runner.js";
import {
  loadBaselineReport,
  loadLatestRunReport,
  saveBaselineReport,
  saveRunReport,
} from "./storage.js";
import type { ProjectConfig } from "./types.js";

const DEFAULT_CONFIG_FILE = "journey-budget.config.json";

const STARTER_CONFIG: ProjectConfig = {
  baseUrl: "http://localhost:3000",
  journeys: [
    {
      name: "search",
      steps: [
        { name: "open-search", action: "navigate", url: "/search" },
        { name: "enter-query", action: "fill", selector: "#search-input", value: "laptop" },
        { name: "submit-search", action: "click", selector: "#search-button" },
        { name: "wait-for-results", action: "wait-for", selector: "[data-testid=search-results]" },
      ],
    },
  ],
  budgets: {
    search: {
      maxTransferMB: 1.5,
      maxDurationMs: 3000,
    },
  },
  pricing: {
    currency: "NGN",
    pricePerGB: 500,
  },
  measurement: {
    browser: "chromium",
    cacheMode: "cold",
  },
};

export function createCli(): Command {
  const program = new Command();

  program
    .name("journey-budget")
    .description("Measure web journey data transfer, duration, and estimated cost.")
    .version("0.1.0");

  // 1. journey-budget init
  program
    .command("init")
    .description("Create a starter journey-budget.config.json file")
    .option("-c, --config <path>", "Path to config file", DEFAULT_CONFIG_FILE)
    .action((options: { config: string }) => {
      const targetPath = path.resolve(options.config);
      if (fs.existsSync(targetPath)) {
        console.error(`Configuration file already exists at: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      fs.writeFileSync(targetPath, JSON.stringify(STARTER_CONFIG, null, 2), "utf-8");
      console.log(`Created starter configuration at: ${targetPath}`);
    });

  // 2. journey-budget run
  program
    .command("run")
    .description("Execute configured journeys and collect network measurements")
    .option("-c, --config <path>", "Path to config file", DEFAULT_CONFIG_FILE)
    .option("-j, --journey <name>", "Run only a specific journey by name")
    .option("--save-baseline", "Save the run result as the approved baseline")
    .action(
      async (options: {
        config: string;
        journey?: string;
        saveBaseline?: boolean;
      }) => {
        try {
          const config = loadConfigFile(options.config);
          const journeysToRun = options.journey
            ? config.journeys.filter((j) => j.name === options.journey)
            : config.journeys;

          if (journeysToRun.length === 0) {
            throw new Error(`Journey "${options.journey}" not found in configuration.`);
          }

          for (const journey of journeysToRun) {
            const report = await runJourney(config, journey.name);
            const savedPath = saveRunReport(report);
            console.log(formatRunReport(report));
            console.log(`\nSaved run report to: ${savedPath}`);

            if (options.saveBaseline) {
              const baselinePath = saveBaselineReport(report);
              console.log(`Saved baseline report to: ${baselinePath}`);
            }

            if (report.outcome === "failed") {
              process.exitCode = 2;
            }
          }
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 2;
        }
      },
    );

  // 3. journey-budget report
  program
    .command("report <journey>")
    .description("Display the latest saved run report for a journey")
    .action((journeyName: string) => {
      try {
        const report = loadLatestRunReport(journeyName);
        console.log(formatRunReport(report));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });

  // 4. journey-budget compare
  program
    .command("compare <journey>")
    .description("Compare the latest run of a journey with its saved baseline")
    .action((journeyName: string) => {
      try {
        const baseline = loadBaselineReport(journeyName);
        const current = loadLatestRunReport(journeyName);
        const comparison = compareReports(baseline, current);
        console.log(formatComparison(comparison));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });

  // 5. journey-budget check
  program
    .command("check")
    .description("Run journeys and evaluate configured budgets (exits with 1 on violation)")
    .option("-c, --config <path>", "Path to config file", DEFAULT_CONFIG_FILE)
    .option("-j, --journey <name>", "Check only a specific journey by name")
    .action(async (options: { config: string; journey?: string }) => {
      try {
        const config = loadConfigFile(options.config);
        const journeysToRun = options.journey
          ? config.journeys.filter((j) => j.name === options.journey)
          : config.journeys;

        if (journeysToRun.length === 0) {
          throw new Error(`Journey "${options.journey}" not found in configuration.`);
        }

        let anyBudgetFailed = false;
        let anyInfraFailed = false;

        for (const journey of journeysToRun) {
          const report = await runJourney(config, journey.name);
          saveRunReport(report);
          console.log(formatRunReport(report));
          console.log("");

          if (report.outcome === "failed") {
            anyInfraFailed = true;
          }

          const budget = config.budgets?.[journey.name];
          if (budget) {
            const evaluation = evaluateBudget(report, budget);
            console.log(formatBudgetResult(evaluation));
            if (!evaluation.passed) {
              anyBudgetFailed = true;
            }
          } else {
            console.log(`[INFO] No budget configured for journey "${journey.name}".`);
          }
        }

        if (anyInfraFailed) {
          process.exitCode = 2;
        } else if (anyBudgetFailed) {
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });

  return program;
}

// Only parse process.argv when run directly from the command line
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isDirectRun) {
  const program = createCli();
  program.parseAsync(process.argv).catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
}