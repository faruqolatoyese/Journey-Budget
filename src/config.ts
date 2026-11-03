import fs from "node:fs";
import { z } from "zod";
import type { ProjectConfig } from "./types.js";

// 1. Step Schemas
const NavigateStepSchema = z.object({
  name: z.string().min(1, "Step name cannot be empty"),
  action: z.literal("navigate"),
  url: z.string().min(1, "Navigate step requires a url"),
});

const FillStepSchema = z.object({
  name: z.string().min(1, "Step name cannot be empty"),
  action: z.literal("fill"),
  selector: z.string().min(1, "Fill step requires a selector"),
  value: z.string(),
});

export const ClickStepSchema = z.object({
    name: z.string().min(1, "Step name cannot be empty"),
    action: z.literal("click"),
    selector: z.string().min(1, "Click step requires a selector"),
})

export const WaitForStepSchema = z.object({
  name: z.string().min(1, "Step name cannot be empty"),
  action: z.literal("wait-for"),
  selector: z.string().min(1, "WaitFor step requires a selector"),
  timeoutMs: z.number().int().positive().optional(),
});

export const StepConfigSchema = z.discriminatedUnion("action", [
  NavigateStepSchema,
  FillStepSchema,
  ClickStepSchema,
  WaitForStepSchema,
]);

// 2. Journey Schema
export const JourneyConfigSchema = z.object({
  name: z.string().min(1, "Journey name cannot be empty"),
  steps: z.array(StepConfigSchema).min(1, "A journey must have at least one step"),
});

// 3. Budget, Pricing & Measurement Schemas
export const BudgetLimitSchema = z.object({
  maxTransferMB: z.number().positive().optional(),
  maxTransferBytes: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
});

export const PricingConfigSchema = z.object({
  currency: z.string().min(1, "Currency is required"),
  pricePerGB: z.number().nonnegative("pricePerGB must be 0 or greater"),
});

export const MeasurementConfigSchema = z.object({
  browser: z.literal("chromium").default("chromium"),
  cacheMode: z.enum(["cold", "warm"]).default("cold"),
  headless: z.boolean().optional(),
  defaultTimeoutMs: z.number().int().positive().optional(),
});

// 4. Top-Level Project Config Schema
export const ProjectConfigSchema = z.object({
  baseUrl: z.string().url("baseUrl must be a valid URL (e.g. http://localhost:3000)"),
  journeys: z.array(JourneyConfigSchema).min(1, "At least one journey must be defined"),
  budgets: z.record(z.string(), BudgetLimitSchema).optional(),
  pricing: PricingConfigSchema.optional(),
  measurement: MeasurementConfigSchema.optional(),
});

/**
 * Validates a raw object against ProjectConfigSchema.
 * Throws a descriptive Error if validation fails.
 */
export function validateConfig(raw: unknown): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Reads a JSON configuration file from disk, parses it, and validates it.
 */
export function loadConfigFile(filePath: string): ProjectConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  try {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(rawContent);
    return validateConfig(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in configuration file: ${filePath}`);
    }
    throw error;
  }
}