/**
 * Core domain types for Journey Budget.
 */

export type CacheMode = "cold" | "warm";

export type ResponseSource =
  | "network"
  | "network-revalidated"
  | "memory-cache"
  | "disk-cache"
  | "prefetch-cache"
  | "service-worker"
  | "unknown";

export type MeasurementStatus =
  | "measured"
  | "cache-hit"
  | "partial"
  | "unavailable"
  | "failed"
  | "in-flight";

// 1. User Configuration Types

export type StepConfig =
  | { name: string; action: "navigate"; url: string }
  | { name: string; action: "fill"; selector: string; value: string }
  | { name: string; action: "click"; selector: string }
  | { name: string; action: "wait-for"; selector: string; timeoutMs?: number };

export interface JourneyConfig {
  name: string;
  steps: StepConfig[];
}

export interface BudgetLimit {
  maxTransferMB?: number;
  maxTransferBytes?: number;
  maxDurationMs?: number;
}

export interface PricingConfig {
  currency: string;
  pricePerGB: number;
}

export interface MeasurementConfig {
  browser: "chromium";
  cacheMode: CacheMode;
  headless?: boolean;
  defaultTimeoutMs?: number;
}

export interface ProjectConfig {
  baseUrl: string;
  journeys: JourneyConfig[];
  budgets?: Record<string, BudgetLimit>;
  pricing?: PricingConfig;
  measurement?: MeasurementConfig;
}

// 2. Network Observation & Attribution Types

export interface NetworkByteBreakdown {
  /** Bytes received from the network (response headers + encoded body). */
  receivedBytes: number | null;
  responseHeaderBytes: number | null;
  encodedBodyBytes: number | null;
  decodedBodyBytes: number | null;
  requestHeaderBytes: number | null;
  requestBodyBytes: number | null;
  /** Total transfer (receivedBytes + requestHeaderBytes + requestBodyBytes). */
  transferBytes: number | null;
}

export interface NetworkObservation {
  url: string;
  method: string;
  resourceType: string;
  pageStatus: number | null;
  wireStatus: number | null;
  protocol: string | null;
  source: ResponseSource;
  status: MeasurementStatus;
  notes: string[];
  startedAtStep: string;
  completedAtStep: string | null;
  bytes: NetworkByteBreakdown;
}

// 3. Aggregation, Cost & Report Types

export interface ByteTotal {
  bytes: number;
  complete: boolean;
  unavailableCount: number;
}

export interface CostEstimate {
  currency: string;
  pricePerGB: number;
  transferBytes: number;
  estimatedCost: number;
}

export interface StepSummary {
  stepName: string;
  action: StepConfig["action"];
  durationMs: number;
  requestCount: number;
  cachedRequestCount: number;
  crossBoundaryRequestCount: number;
  received: ByteTotal;
  transfer: ByteTotal;
}

export interface JourneyRunReport {
  schemaVersion: "1.0";
  journeyName: string;
  baseUrl: string;
  cacheMode: CacheMode;
  startedAtIso: string;
  durationMs: number;
  outcome: "passed" | "failed";
  error?: string;
  totals: {
    requestCount: number;
    cachedRequestCount: number;
    received: ByteTotal;
    transfer: ByteTotal;
  };
  byStep: StepSummary[];
  byResourceType: Record<string, ByteTotal>;
  cost?: CostEstimate;
  observations: NetworkObservation[];
}