import { Buffer } from "node:buffer";
import type { BrowserContext, CDPSession, Page } from "playwright";
import {
  deriveMeasurement,
  headerBytes,
  type ObservedRequest,
} from "./prototype/network-collector.js";
import type {
  ByteTotal,
  NetworkObservation,
  StepConfig,
  StepSummary,
} from "./types.js";

/**
 * Sums an array of nullable byte counts into a ByteTotal.
 * If any value is null, `complete` is false and `unavailableCount` tracks how many were null.
 */
export function sumByteTotals(values: (number | null)[]): ByteTotal {
  let bytes = 0;
    let unavailableCount = 0;
  for (const value of values) {
    if (value === null) {
      unavailableCount++;
    } else {
      bytes += value;
    }
  }
  return { bytes, complete: unavailableCount === 0, unavailableCount };
}

/**
 * Groups observations by `resourceType` (e.g. "Document", "Script", "Stylesheet", "Fetch")
 * and computes the total `transferBytes` for each resource type.
 */
export function aggregateByResourceType(
  observations: NetworkObservation[],
): Record<string, ByteTotal> {
  const grouped = new Map<string, (number | null)[]>();
  for (const obs of observations) {
    const key = obs.resourceType;
    const values = grouped.get(key) ?? [];
    values.push(obs.bytes.transferBytes);
    grouped.set(key, values);
  }
  const result: Record<string, ByteTotal> = {};
  for (const [key, values] of grouped) {
    result[key] = sumByteTotals(values);
  }
  return result;
}

export interface StepTimingRecord {
  step: StepConfig;
  durationMs: number;
}

/**
 * Builds a StepSummary for each configured step in the journey.
 * Each request is attributed to the step in which it STARTED (`obs.startedAtStep === step.name`).
 */
export function aggregateByStep(
  stepTimings: StepTimingRecord[],
  observations: NetworkObservation[],
): StepSummary[] {
  return stepTimings.map(({ step, durationMs }) => {
    const stepObs = observations.filter((obs) => obs.startedAtStep === step.name);
    const cachedRequestCount = stepObs.filter((obs) => obs.status === "cache-hit").length;
    const crossBoundaryRequestCount = stepObs.filter((obs) => obs.completedAtStep !== null && obs.completedAtStep !== obs.startedAtStep).length;
    const received = sumByteTotals(stepObs.map((o) => o.bytes.receivedBytes));
    const transfer = sumByteTotals(stepObs.map((o) => o.bytes.transferBytes));

    return {
      stepName: step.name,
      action: step.action,
      durationMs,
      requestCount: stepObs.length,
      cachedRequestCount,
      crossBoundaryRequestCount,
      received,
      transfer
    };

  });
}

interface AttributedHop extends ObservedRequest {
  startedAtStep: string;
  completedAtStep: string | null;
}

/**
 * Step-aware CDP Network Collector.
 * Tracks which journey step is active when each request starts and finishes.
 */
export class StepNetworkCollector {
  private readonly hops = new Map<string, AttributedHop[]>();
  private readonly requestExtra = new Map<string, Record<string, string>[]>();
  private readonly responseExtra = new Map<
    string,
    { status: number; headersTextBytes: number | null }[]
  >();
  private readonly servedFromCache = new Set<string>();
  private sequence = 0;
  private currentStep = "before-journey";
  private detached = false;

  private constructor(private readonly session: CDPSession) {}

  static async attach(
    context: BrowserContext,
    page: Page,
  ): Promise<StepNetworkCollector> {
    const session = await context.newCDPSession(page);
    const collector = new StepNetworkCollector(session);
    collector.listen();
    await session.send("Network.enable");
    return collector;
  }

  setCurrentStep(stepName: string): void {
    this.currentStep = stepName;
  }

  private current(requestId: string): AttributedHop | undefined {
    const list = this.hops.get(requestId);
    return list?.[list.length - 1];
  }

  private listen(): void {
    const s = this.session;

    s.on("Network.requestWillBeSent", (e) => {
      if (e.request.url.startsWith("data:") || e.request.url.startsWith("blob:")) return;
      const list = this.hops.get(e.requestId) ?? [];
      const previous = list[list.length - 1];
      if (previous && e.redirectResponse) {
        previous.completion = "redirected";
        previous.completedAtStep = this.currentStep;
        previous.pageStatus = e.redirectResponse.status;
        previous.protocol = e.redirectResponse.protocol ?? null;
      }
      list.push({
        requestId: e.requestId,
        hop: list.length,
        sequence: this.sequence++,
        startedAt: e.timestamp,
        url: e.request.url,
        method: e.request.method,
        resourceType: e.type ?? "Other",
        completion: "in-flight",
        failureText: null,
        canceled: false,
        pageStatus: null,
        protocol: null,
        startedAtStep: this.currentStep,
        completedAtStep: null,
        flags: {
          servedFromCacheEvent: false,
          fromDiskCache: false,
          fromPrefetchCache: false,
          fromServiceWorker: false,
          fromEarlyHints: false,
          serviceWorkerResponseSource: null,
        },
        raw: {
          loadingFinishedEncodedDataLength: null,
          responseHeadersTextBytes: null,
          wireStatus: null,
          sentRequestHeaders: null,
          decodedBodyBytes: null,
          hasPostData: e.request.hasPostData === true,
          postDataBytes:
            e.request.postDataEntries?.every((entry) => entry.bytes !== undefined)
              ? e.request.postDataEntries.reduce((sum, entry) => sum + Buffer.from(entry.bytes ?? "", "base64").length, 0)
              : e.request.postData !== undefined
                ? Buffer.byteLength(e.request.postData)
                : null,
        },
      });
      this.hops.set(e.requestId, list);
    });

    s.on("Network.requestWillBeSentExtraInfo", (e) => {
      const list = this.requestExtra.get(e.requestId) ?? [];
      list.push(e.headers as Record<string, string>);
      this.requestExtra.set(e.requestId, list);
    });

    s.on("Network.requestServedFromCache", (e) => {
      this.servedFromCache.add(e.requestId);
    });

    s.on("Network.responseReceived", (e) => {
      const entry = this.current(e.requestId);
      if (!entry) return;
      const r = e.response;
      entry.pageStatus = r.status;
      entry.protocol = r.protocol ?? null;
      entry.flags.fromDiskCache = r.fromDiskCache === true;
      entry.flags.fromPrefetchCache = r.fromPrefetchCache === true;
      entry.flags.fromServiceWorker = r.fromServiceWorker === true;
      entry.flags.fromEarlyHints = r.fromEarlyHints === true;
      entry.flags.serviceWorkerResponseSource =
        r.serviceWorkerResponseSource ?? null;
    });

    s.on("Network.responseReceivedExtraInfo", (e) => {
      const list = this.responseExtra.get(e.requestId) ?? [];
      list.push({
        status: e.statusCode,
        headersTextBytes:
          e.headersText !== undefined ? headerBytes(e.headersText) : null,
      });
      this.responseExtra.set(e.requestId, list);
    });

    s.on("Network.dataReceived", (e) => {
      const entry = this.current(e.requestId);
      if (!entry) return;
      entry.raw.decodedBodyBytes =
        (entry.raw.decodedBodyBytes ?? 0) + e.dataLength;
      entry.raw.streamedEncodedBytes =
        (entry.raw.streamedEncodedBytes ?? 0) + e.encodedDataLength;
    });

    s.on("Network.loadingFinished", (e) => {
      const entry = this.current(e.requestId);
      if (!entry) return;
      entry.completion = "finished";
      entry.completedAtStep = this.currentStep;
      entry.raw.loadingFinishedEncodedDataLength = e.encodedDataLength;
    });

    s.on("Network.loadingFailed", (e) => {
      const entry = this.current(e.requestId);
      if (!entry) return;
      entry.completion = "failed";
      entry.completedAtStep = this.currentStep;
      entry.failureText = e.errorText || e.blockedReason || null;
      entry.canceled = e.canceled === true;
    });
  }

  inFlightCount(): number {
    let count = 0;
    for (const list of this.hops.values()) {
      if (list[list.length - 1]?.completion === "in-flight") count++;
    }
    return count;
  }

  async waitForIdle({ quietMs = 200, timeoutMs = 5_000 } = {}): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let quietSince = this.inFlightCount() === 0 ? Date.now() : null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.inFlightCount() === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= quietMs) return true;
      } else {
        quietSince = null;
      }
    }
    return false;
  }

  snapshot(): NetworkObservation[] {
    const ordered: AttributedHop[] = [];
    for (const [requestId, list] of this.hops) {
      const reqExtras = this.requestExtra.get(requestId) ?? [];
      const resExtras = this.responseExtra.get(requestId) ?? [];
      for (const hop of list) {
        const copy: AttributedHop = structuredClone(hop);
        copy.raw.sentRequestHeaders = reqExtras[hop.hop] ?? null;
        const resExtra = resExtras[hop.hop];
        copy.raw.wireStatus = resExtra?.status ?? null;
        copy.raw.responseHeadersTextBytes = resExtra?.headersTextBytes ?? null;
        copy.flags.servedFromCacheEvent =
          this.servedFromCache.has(requestId) && hop.hop === list.length - 1;
        ordered.push(copy);
      }
    }

    ordered.sort((a, b) => a.startedAt - b.startedAt || a.sequence - b.sequence);

    return ordered.map((hop) => {
      const m = deriveMeasurement(hop);
      return {
        url: hop.url,
        method: hop.method,
        resourceType: hop.resourceType,
        pageStatus: hop.pageStatus,
        wireStatus: hop.raw.wireStatus,
        protocol: hop.protocol,
        source: m.source,
        status: m.status,
        notes: m.notes,
        startedAtStep: hop.startedAtStep,
        completedAtStep: hop.completedAtStep,
        bytes: {
          receivedBytes: m.receivedBytes,
          responseHeaderBytes: m.responseHeaderBytes,
          encodedBodyBytes: m.encodedBodyBytes,
          decodedBodyBytes: m.decodedBodyBytes,
          requestHeaderBytes: m.requestHeaderBytes,
          requestBodyBytes: m.requestBodyBytes,
          transferBytes: m.transferBytes,
        },
      };
    });
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    await this.session.detach();
  }
}