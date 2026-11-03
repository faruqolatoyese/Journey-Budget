import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig, loadConfigFile } from "../src/config.js";

describe("Config Validation (validateConfig & loadConfigFile)", () => {
  const validConfig = {
    baseUrl: "http://localhost:3000",
    journeys: [
      {
        name: "search",
        steps: [
          { name: "open-search", action: "navigate", url: "/search" },
          { name: "enter-query", action: "fill", selector: "#search-input", value: "laptop" },
          { name: "submit-search", action: "click", selector: "#search-button" },
          { name: "wait-for-results", action: "wait-for", selector: "[data-testid=search-results]", timeoutMs: 5000 },
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

  it("accepts a valid full project configuration", () => {
    const parsed = validateConfig(validConfig);
    expect(parsed.baseUrl).toBe("http://localhost:3000");
    expect(parsed.journeys).toHaveLength(1);
    expect(parsed.journeys[0]?.steps).toHaveLength(4);
    expect(parsed.pricing?.currency).toBe("NGN");
  });

  it("rejects an invalid baseUrl with a clear error message", () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        baseUrl: "not-a-valid-url",
      }),
    ).toThrow(/baseUrl/);
  });

  it("rejects a journey with no steps", () => {
    expect(() =>
    validateConfig({
        ...validConfig,
        journeys: [
          {
            ...validConfig.journeys[0],
            steps: [],
          },
        ],
      }),
    ).toThrow(/steps/);
  });

  it("rejects negative pricePerGB", () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        pricing: {
          ...validConfig.pricing,
          pricePerGB: -50,
        },
      }),
    ).toThrow(/pricePerGB/);
  });

  it("throws a clear error when config file does not exist", () => {
    expect(() => loadConfigFile("non-existent-config.json")).toThrow(
      /Configuration file not found/,
    );
  });

  it("throws a clear error when config file contains invalid JSON", () => {
    const tmpFile = path.join(os.tmpdir(), `bad-config-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "{ bad json ", "utf-8");
    try {
      expect(() => loadConfigFile(tmpFile)).toThrow(
        /Invalid JSON in configuration file/,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});