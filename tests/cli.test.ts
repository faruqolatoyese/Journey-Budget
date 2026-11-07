import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli.js";
import { formatBytes, formatBudgetResult } from "../src/formatter.js";
import type { BudgetEvaluationResult } from "../src/analysis.js";

describe("Formatter & CLI Commands (Phase 5)", () => {
  it("formats bytes into B, KB, and MB cleanly", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(18_280)).toBe("18.28 KB");
    expect(formatBytes(2_500_000)).toBe("2.50 MB");
  });

  it("formats budget evaluation pass and fail results", () => {
    const passResult = {
        journeyName: "search",
        passed: true,
        violations: [],
    };
    expect(formatBudgetResult(passResult)).toContain("[PASS]");
    const failResult: BudgetEvaluationResult = {
        journeyName: "search",
        passed: false,
        violations: [{ metric: "transfer", message: "Too big" }],
    };
    expect(formatBudgetResult(failResult)).toContain("[FAIL]");
    expect(formatBudgetResult(failResult)).toContain("Too big");
  });

  it("creates a valid starter config file when running `journey-budget init`", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-cli-"));
    const configPath = path.join(tmpDir, "journey-budget.config.json");

    try {
      const cli = createCli();
      await cli.parseAsync(["node", "journey-budget", "init", "-c", configPath]);

      expect(fs.existsSync(configPath)).toBe(true);
      const created = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(created.baseUrl).toBe("http://localhost:3000");
      expect(created.journeys[0].name).toBe("search");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates both config and GitHub Actions workflow when running `journey-budget init --ci`", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-cli-ci-"));
    const configPath = path.join(tmpDir, "journey-budget.config.json");
    const workflowPath = path.join(tmpDir, ".github", "workflows", "journey-budget.yml");

    try {
      const cli = createCli();
      await cli.parseAsync(["node", "journey-budget", "init", "--ci", "-c", configPath]);

      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.existsSync(workflowPath)).toBe(true);
      const workflowContent = fs.readFileSync(workflowPath, "utf-8");
      expect(workflowContent).toContain("npx journey-budget check");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
