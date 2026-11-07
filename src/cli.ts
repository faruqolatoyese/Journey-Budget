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
import type { ProjectConfig, JourneyConfig, JourneyRunReport } from "./types.js";
import type { BudgetEvaluationResult } from "./analysis.js";
import { formatMarkdownSummary } from "./formatter.js";

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

const STARTER_CI_WORKFLOW = `name: Journey Budget CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  journey-budget:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium

      - name: Start app and run Journey Budget Check
        run: |
          npm run build
          npm start &
          npx wait-on http://localhost:3000 -t 30000
          npx journey-budget check
`;

function ensureGitignoreEntry(projectDir: string): void {
    const gitignorePath = path.join(projectDir, ".gitignore");
    const entry = ".journey-budget/runs/";
    if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        if (!content.includes(entry) && !content.includes(".journey-budget/")) {
            const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
            fs.appendFileSync(
                gitignorePath,
                `${prefix}\n# Journey Budget temporary run reports\n${entry}\n`,
                "utf-8",
            );
            console.log(`Added "${entry}" to: ${gitignorePath}`);
        }
    } else {
        fs.writeFileSync(
            gitignorePath,
            `# Journey Budget temporary run reports\n${entry}\n`,
            "utf-8",
        );
        console.log(`Created .gitignore with "${entry}" at: ${gitignorePath}`);
    }
}

export function createCli(): Command {
    const program = new Command();

    program
        .name("journey-budget")
        .description("Measure web journey data transfer, duration, and estimated cost.")
        .version("0.1.0");

    // 1. journey-budget init
    program
        .command("init")
        .description("Create a starter journey-budget.config.json file (and optional GitHub Actions workflow)")
        .option("-c, --config <path>", "Path to config file", DEFAULT_CONFIG_FILE)
        .option("--ci", "Also generate a starter .github/workflows/journey-budget.yml file")
        .action((options: { config: string; ci?: boolean }) => {
            const targetPath = path.resolve(options.config);
            const projectDir = path.dirname(targetPath);

            if (!fs.existsSync(targetPath)) {
                fs.writeFileSync(targetPath, JSON.stringify(STARTER_CONFIG, null, 2), "utf-8");
                console.log(`Created starter configuration at: ${targetPath}`);
            } else if (!options.ci) {
                console.error(`Configuration file already exists at: ${targetPath}`);
                process.exitCode = 2;
                return;
            } else {
                console.log(`Configuration file already exists at: ${targetPath} (skipped)`);
            }

            ensureGitignoreEntry(projectDir);

            if (options.ci) {
                const workflowDir = path.join(projectDir, ".github", "workflows");
                const workflowPath = path.join(workflowDir, "journey-budget.yml");
                if (fs.existsSync(workflowPath)) {
                    console.error(`GitHub Actions workflow already exists at: ${workflowPath}`);
                    process.exitCode = 2;
                    return;
                }
                fs.mkdirSync(workflowDir, { recursive: true });
                fs.writeFileSync(workflowPath, STARTER_CI_WORKFLOW, "utf-8");
                console.log(`Created GitHub Actions workflow at: ${workflowPath}`);
            }
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

                const summaryItems: { report: JourneyRunReport; evaluation?: BudgetEvaluationResult }[] = [];

                for (const journey of journeysToRun) {
                    const report = await runJourney(config, journey.name);
                    saveRunReport(report);
                    console.log(formatRunReport(report));
                    console.log("");
                    if (report.outcome === "failed") {
                        anyInfraFailed = true;
                    }
                    const budget = config.budgets?.[journey.name];
                    let evaluation: BudgetEvaluationResult | undefined;
                    if (budget) {
                        evaluation = evaluateBudget(report, budget);
                        console.log(formatBudgetResult(evaluation));
                        if (!evaluation.passed) {
                            anyBudgetFailed = true;
                        }
                    } else {
                        console.log(`[INFO] No budget configured for journey "${journey.name}".`);
                    }
                    summaryItems.push({ report, evaluation });
                }

                if (process.env.GITHUB_STEP_SUMMARY) {
                    fs.appendFileSync(
                        process.env.GITHUB_STEP_SUMMARY,
                        formatMarkdownSummary(summaryItems),
                        "utf-8",
                    );
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
