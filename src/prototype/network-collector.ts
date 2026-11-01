import { Buffer } from "node:buffer";
import type { BrowserContext, CDPSession, Page } from "playwright";

/**
 * PROTOTYPE network collector (Milestone 1).
 *
 * Collects per-request network facts from Chromium via the Chrome DevTools
 * Protocol (CDP) and derives transfer measurements from them.
 *
 * Why CDP instead of Playwright's `request.sizes()`?
 *  - Playwright (Chromium) computes `responseBodySize = encodedDataLength - responseHeadersSize`.
 *    For HTTP-cache hits Chromium reports `encodedDataLength = 0` but Playwright still
 *    estimates header sizes from the cached headers, producing NEGATIVE body sizes.
 *  - Playwright does not expose WHERE a response came from (disk cache, memory cache, ...).
 *  - CDP gives us both: cache-source flags and the browser's own byte counters.
 *
 * Nothing here disables the HTTP cache. In particular we never call
 * `page.route()` / `context.route()`, because Playwright turns on
 * `Network.setCacheDisabled` whenever request interception is active.
 
 */

// Types

/** Where the response body came from, as reported by Chromium. */
export type ResponseSource =
  | "network" // full response transferred over the network
  | "network-revalidated" // conditional request -> 304 over the network, body reused from HTTP cache
  | "memory-cache" // Blink in-memory cache (Network.requestServedFromCache)
  | "disk-cache" // HTTP cache (response.fromDiskCache)
  | "prefetch-cache" // response.fromPrefetchCache
  | "service-worker" // response.fromServiceWorker (see serviceWorkerResponseSource)
  | "unknown"; // no response information available

export type Completion = "finished" | "failed" | "redirected" | "in-flight";

/** Cache-related flags exactly as Chromium reported them. */
export interface SourceFlags {
  servedFromCacheEvent: boolean;
  fromDiskCache: boolean;
  fromPrefetchCache: boolean;
  fromServiceWorker: boolean;
  fromEarlyHints: boolean;
  serviceWorkerResponseSource: string | null;
}

/** Raw CDP facts for one request hop. `null` always means "not reported", never zero. */
export interface RawCdpFacts {
  /** Network.loadingFinished.encodedDataLength: bytes received from the network (headers + encoded body). */
  loadingFinishedEncodedDataLength: number | null;
  /** Byte length of Network.responseReceivedExtraInfo.headersText (raw response head as received). */
  responseHeadersTextBytes: number | null;
  /** Status code seen on the wire (responseReceivedExtraInfo), e.g. 304 for a revalidation. */
  wireStatus: number | null;
  /** Request headers actually sent (Network.requestWillBeSentExtraInfo). Null if nothing was sent. */
  sentRequestHeaders: Record<string, string> | null;
  /** Sum of Network.dataReceived.dataLength: decoded resource body bytes delivered to the page. */
  decodedBodyBytes: number | null;
  hasPostData: boolean;
  postDataBytes: number | null;
}

export interface ObservedRequest {
  requestId: string;
  hop: number; // 0 for the original request, 1.. for redirect hops sharing the same requestId
  sequence: number; // order in which requests started (deterministic report ordering)
  startedAt: number; // CDP monotonic timestamp (seconds)
  url: string;
  method: string;
  resourceType: string;
  completion: Completion;
  failureText: string | null;
  canceled: boolean;
  /** Status the page sees (Network.responseReceived). A 304 revalidation is reported as 200 here. */
  pageStatus: number | null;
  protocol: string | null;
  flags: SourceFlags;
  raw: RawCdpFacts;
}

export type MeasurementStatus =
  | "measured" // network transfer measured by Chromium (request head reconstructed)
  | "cache-hit" // served by HTTP/memory/prefetch cache: Chromium reports zero network bytes
  | "partial" // some byte fields measured, others unavailable
  | "unavailable" // transfer cannot be determined from this vantage point
  | "failed"
  | "in-flight";

export interface TransferMeasurement {
  source: ResponseSource;
  status: MeasurementStatus;
  /** Bytes received from the network, measured by Chromium (response head + encoded body). */
  receivedBytes: number | null;
  responseHeaderBytes: number | null;
  /** On-the-wire body bytes (after content-encoding such as gzip). */
  encodedBodyBytes: number | null;
  /** Body bytes after decoding: the resource size. Available for cache hits too. */
  decodedBodyBytes: number | null;
  /** Reconstructed HTTP/1.x request head. An estimate: exact only for HTTP/1.x. */
  requestHeaderBytes: number | null;
  requestBodyBytes: number | null;
  /** receivedBytes + requestHeaderBytes + requestBodyBytes; null if any part is unknown. */
  transferBytes: number | null;
  notes: string[];
}

export interface MeasuredRequest extends ObservedRequest {
  measurement: TransferMeasurement;
}

// Pure functions (unit tested in tests/network-measurement.test.ts)

/**
 * Decide where a response came from, using Chromium's explicit flags only.
 * A negative or zero byte count is NEVER used as evidence of a cache hit.
 */
export function classifySource(
  flags: SourceFlags,
  hasResponse: boolean,
  wireStatus: number | null,
): ResponseSource {
  if (flags.fromServiceWorker) return "service-worker";
  if (flags.servedFromCacheEvent) return "memory-cache";
  if (flags.fromDiskCache) return "disk-cache";
  if (flags.fromPrefetchCache) return "prefetch-cache";
  if (!hasResponse) return "unknown";
  if (wireStatus === 304) return "network-revalidated";
  return "network";
}

/** Byte length of an HTTP header block as transmitted (HTTP/1.x headers are octets, i.e. latin1). */
export function headerBytes(text: string): number {
  return Buffer.byteLength(text, "latin1");
}

/**
 * Reconstruct the size of an HTTP/1.1 request head:
 *   "METHOD /path?query HTTP/1.1\r\n" + "Name: value\r\n"... + "\r\n"
 * CDP joins repeated headers with "\n", so each line is counted as its own header.
 * Only meaningful for HTTP/1.x; HTTP/2 and HTTP/3 compress headers (HPACK/QPACK).
 */
export function estimateHttp1RequestHeadBytes(
  method: string,
  url: string,
  headers: Record<string, string>,
): number {
  const target = new URL(url);
  let bytes = headerBytes(`${method} ${target.pathname}${target.search} HTTP/1.1\r\n`);
  for (const [name, value] of Object.entries(headers)) {
    for (const line of String(value).split("\n")) {
      bytes += headerBytes(`${name}: ${line}\r\n`);
    }
  }
  return bytes + 2; // blank line ending the head
}

function isHttp1(protocol: string | null): boolean {
  return protocol !== null && /^http\/1\.[01]$/i.test(protocol);
}

/** Turn raw facts into a measurement. Missing data stays null; negatives are never clamped. */
export function deriveMeasurement(observed: ObservedRequest): TransferMeasurement {
  const { raw, flags } = observed;
  const source = classifySource(flags, observed.pageStatus !== null, raw.wireStatus);
  const notes: string[] = [];
  const empty = {
    receivedBytes: null,
    responseHeaderBytes: null,
    encodedBodyBytes: null,
    requestHeaderBytes: null,
    requestBodyBytes: null,
    transferBytes: null,
  };
  const decodedBodyBytes = raw.decodedBodyBytes;

  if (observed.completion === "in-flight") {
    return { source, status: "in-flight", decodedBodyBytes, ...empty, notes: ["request had not finished when collection ended"] };
  }
  if (observed.completion === "failed") {
    notes.push(`failed: ${observed.failureText ?? "unknown error"}${observed.canceled ? " (canceled)" : ""}`);
    notes.push("bytes received before the failure are not reported by Chromium");
    return { source, status: "failed", decodedBodyBytes, ...empty, notes };
  }
  if (observed.completion === "redirected") {
    notes.push("redirect hop: per-hop byte accounting is not validated by the fixture yet");
    return { source, status: "unavailable", decodedBodyBytes, ...empty, notes };
  }
  if (source === "service-worker") {
    notes.push(
      `served by a service worker (source: ${flags.serviceWorkerResponseSource ?? "not reported"}); ` +
        "any network fetch happens in the worker's own target, not visible from this page session",
    );
    return { source, status: "unavailable", decodedBodyBytes, ...empty, notes };
  }
  if (source === "unknown") {
    notes.push("finished without a response event");
    return { source, status: "unavailable", decodedBodyBytes, ...empty, notes };
  }

  const received = raw.loadingFinishedEncodedDataLength;

  if (source === "memory-cache" || source === "disk-cache" || source === "prefetch-cache") {
    if (received === 0 && raw.sentRequestHeaders === null) {
      // Chromium explicitly reports zero received bytes and no request was sent:
      // this zero is a measurement, not a missing value.
      return {
        source,
        status: "cache-hit",
        receivedBytes: 0,
        responseHeaderBytes: 0,
        encodedBodyBytes: 0,
        decodedBodyBytes,
        requestHeaderBytes: 0,
        requestBodyBytes: 0,
        transferBytes: 0,
        notes,
      };
    }
    notes.push(
      `cache flag set but receivedBytes=${received ?? "null"} and request headers ${raw.sentRequestHeaders ? "were" : "were not"} sent; ` +
        "treating as unavailable instead of guessing",
    );
    return { source, status: "unavailable", decodedBodyBytes, ...empty, receivedBytes: received, notes };
  }

  // source is "network" or "network-revalidated"
  const responseHeaderBytes = raw.responseHeadersTextBytes;
  if (responseHeaderBytes === null) notes.push("raw response headers not reported (no headersText)");

  let encodedBodyBytes: number | null = null;
  if (received !== null && responseHeaderBytes !== null) {
    const diff = received - responseHeaderBytes;
    if (diff >= 0) encodedBodyBytes = diff;
    else notes.push(`inconsistent sizes: received ${received} < response headers ${responseHeaderBytes}`);
  }
  if (received === null) notes.push("Chromium did not report received bytes");

  let requestHeaderBytes: number | null = null;
  if (raw.sentRequestHeaders === null) {
    notes.push("sent request headers not reported");
  } else if (!isHttp1(observed.protocol)) {
    notes.push(`request head size not estimated for protocol ${observed.protocol ?? "unknown"} (header compression)`);
  } else {
    requestHeaderBytes = estimateHttp1RequestHeadBytes(observed.method, observed.url, raw.sentRequestHeaders);
  }

  let requestBodyBytes: number | null;
  if (!raw.hasPostData) requestBodyBytes = 0;
  else if (raw.postDataBytes !== null) requestBodyBytes = raw.postDataBytes;
  else {
    requestBodyBytes = null;
    notes.push("request body present but its size was not reported");
  }

  const transferBytes =
    received !== null && requestHeaderBytes !== null && requestBodyBytes !== null
      ? received + requestHeaderBytes + requestBodyBytes
      : null;

  if (source === "network-revalidated") notes.push("304 revalidation: headers transferred, body reused from HTTP cache");

  return {
    source,
    status: transferBytes !== null ? "measured" : received !== null ? "partial" : "unavailable",
    receivedBytes: received,
    responseHeaderBytes,
    encodedBodyBytes,
    decodedBodyBytes,
    requestHeaderBytes,
    requestBodyBytes,
    transferBytes,
    notes,
  };
}

// The collector

/**
 * Attaches a dedicated CDP session to one page and records Network events.
 * One collector per measured run: events from earlier runs cannot leak in,
 * because they were recorded by a different, already-detached collector.
 */
export class CdpNetworkCollector {
  private readonly hops = new Map<string, ObservedRequest[]>(); // requestId -> hops
  // ExtraInfo events can arrive BEFORE or AFTER their main event, so they are
  // stored separately and merged (by hop index) when a snapshot is taken.
  private readonly requestExtra = new Map<string, Record<string, string>[]>();
  private readonly responseExtra = new Map<string, { status: number; headersTextBytes: number | null }[]>();
  private readonly servedFromCache = new Set<string>();
  private sequence = 0;
  private detached = false;
  readonly errors: string[] = [];

  private constructor(private readonly session: CDPSession) {}

  static async attach(context: BrowserContext, page: Page): Promise<CdpNetworkCollector> {
    const session = await context.newCDPSession(page);
    const collector = new CdpNetworkCollector(session);
    collector.listen();
    await session.send("Network.enable");
    return collector;
  }

  private current(requestId: string): ObservedRequest | undefined {
    const list = this.hops.get(requestId);
    return list?.[list.length - 1];
  }

  private listen(): void {
    const s = this.session;
    const guard =
      <T>(name: string, fn: (event: T) => void) =>
      (event: T) => {
        try {
          fn(event);
        } catch (error) {
          this.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

    s.on(
      "Network.requestWillBeSent",
      guard("requestWillBeSent", (e) => {
        const list = this.hops.get(e.requestId) ?? [];
        const previous = list[list.length - 1];
        if (previous && e.redirectResponse) {
          previous.completion = "redirected";
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
      }),
    );

    s.on(
      "Network.requestWillBeSentExtraInfo",
      guard("requestWillBeSentExtraInfo", (e) => {
        const list = this.requestExtra.get(e.requestId) ?? [];
        list.push(e.headers as Record<string, string>);
        this.requestExtra.set(e.requestId, list);
      }),
    );

    s.on(
      "Network.requestServedFromCache",
      guard("requestServedFromCache", (e) => {
        this.servedFromCache.add(e.requestId);
      }),
    );

    s.on(
      "Network.responseReceived",
      guard("responseReceived", (e) => {
        const entry = this.current(e.requestId);
        if (!entry) return;
        const r = e.response;
        entry.pageStatus = r.status;
        entry.protocol = r.protocol ?? null;
        entry.flags.fromDiskCache = r.fromDiskCache === true;
        entry.flags.fromPrefetchCache = r.fromPrefetchCache === true;
        entry.flags.fromServiceWorker = r.fromServiceWorker === true;
        entry.flags.fromEarlyHints = r.fromEarlyHints === true;
        entry.flags.serviceWorkerResponseSource = r.serviceWorkerResponseSource ?? null;
      }),
    );

    s.on(
      "Network.responseReceivedExtraInfo",
      guard("responseReceivedExtraInfo", (e) => {
        const list = this.responseExtra.get(e.requestId) ?? [];
        list.push({
          status: e.statusCode,
          headersTextBytes: e.headersText !== undefined ? headerBytes(e.headersText) : null,
        });
        this.responseExtra.set(e.requestId, list);
      }),
    );

    s.on(
      "Network.dataReceived",
      guard("dataReceived", (e) => {
        const entry = this.current(e.requestId);
        if (!entry) return;
        entry.raw.decodedBodyBytes = (entry.raw.decodedBodyBytes ?? 0) + e.dataLength;
      }),
    );

    s.on(
      "Network.loadingFinished",
      guard("loadingFinished", (e) => {
        const entry = this.current(e.requestId);
        if (!entry) return;
        entry.completion = "finished";
        entry.raw.loadingFinishedEncodedDataLength = e.encodedDataLength;
      }),
    );

    s.on(
      "Network.loadingFailed",
      guard("loadingFailed", (e) => {
        const entry = this.current(e.requestId);
        if (!entry) return;
        entry.completion = "failed";
        entry.failureText = e.errorText || e.blockedReason || null;
        entry.canceled = e.canceled === true;
      }),
    );
  }

  inFlightCount(): number {
    let count = 0;
    for (const list of this.hops.values()) {
      if (list[list.length - 1]?.completion === "in-flight") count++;
    }
    return count;
  }

  /** Resolve true once no request has been in flight for `quietMs`; false on timeout. */
  async waitForIdle({ quietMs = 300, timeoutMs = 5_000 } = {}): Promise<boolean> {
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

  /** Merge main + ExtraInfo events and derive measurements, ordered by request start. */
  snapshot(): MeasuredRequest[] {
    const result: MeasuredRequest[] = [];
    for (const [requestId, list] of this.hops) {
      const requestExtras = this.requestExtra.get(requestId) ?? [];
      const responseExtras = this.responseExtra.get(requestId) ?? [];
      for (const hop of list) {
        const observed: ObservedRequest = structuredClone(hop);
        // ExtraInfo events are only emitted for requests that actually hit the network,
        // so for a requestId they line up with its network hops in order.
        observed.raw.sentRequestHeaders = requestExtras[hop.hop] ?? null;
        const responseExtra = responseExtras[hop.hop];
        observed.raw.wireStatus = responseExtra?.status ?? null;
        observed.raw.responseHeadersTextBytes = responseExtra?.headersTextBytes ?? null;
        observed.flags.servedFromCacheEvent = this.servedFromCache.has(requestId) && hop.hop === list.length - 1;
        result.push({ ...observed, measurement: deriveMeasurement(observed) });
      }
    }
    return result.sort((a, b) => a.startedAt - b.startedAt || a.sequence - b.sequence);
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    await this.session.detach();
  }
}