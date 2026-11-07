import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCli } from "../src/cli.js";
import { startFixtureServer } from "./fixtures/server.js";

async function runCiSmokeCheck() {
  const server = await startFixtureServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-ci-smoke-"));
  const configPath = path.join(tmpDir, "journey-budget.config.json");

  const config = {
    baseUrl: server.url,
    journeys: [
      {
        name: "search",
        steps: [
          { name: "open-search", action: "navigate", url: "/search" },
          { name: "wait-config", action: "wait-for", selector: "body[data-config-loaded]" },
          { name: "enter-query", action: "fill", selector: "#search-input", value: "laptop" },
          { name: "submit-search", action: "click", selector: "#search-button" },
          { name: "wait-for-results", action: "wait-for", selector: "[data-testid=search-results]" },
        ],
      },
    ],
    budgets: {
      search: {
        maxTransferMB: 0.1,
        maxDurationMs: 10000,
      },
    },
    pricing: {
      currency: "NGN",
      pricePerGB: 500,
    },
    measurement: {
      browser: "chromium",
      cacheMode: "cold",
      headless: true,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  try {
    const cli = createCli();
    await cli.parseAsync(["node", "journey-budget", "check", "-c", configPath]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await server.close();
  }
}

runCiSmokeCheck().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});