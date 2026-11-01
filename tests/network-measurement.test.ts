import { describe, expect, it } from "vitest";
import {
  classifySource,
  deriveMeasurement,
  estimateHttp1RequestHeadBytes,
  type ObservedRequest,
  type SourceFlags,
} from "../src/prototype/network-collector.js";

const noFlags: SourceFlags = {
  servedFromCacheEvent: false,
  fromDiskCache: false,
  fromPrefetchCache: false,
  fromServiceWorker: false,
  fromEarlyHints: false,
  serviceWorkerResponseSource: null,
};

/** A finished HTTP/1.1 network request; override what each test cares about. */
function observed(overrides: {
  flags?: Partial<SourceFlags>;
  raw?: Partial<ObservedRequest["raw"]>;
  [key: string]: unknown;
}): ObservedRequest {
  const { flags, raw, ...rest } = overrides;
  return {
    requestId: "1",
    hop: 0,
    sequence: 0,
    startedAt: 0,
    url: "http://127.0.0.1:1234/app.js",
    method: "GET",
    resourceType: "Script",
    completion: "finished",
    failureText: null,
    canceled: false,
    pageStatus: 200,
    protocol: "http/1.1",
    ...rest,
    flags: { ...noFlags, ...flags },
    raw: {
      loadingFinishedEncodedDataLength: 10_873,
      responseHeadersTextBytes: 242,
      wireStatus: 200,
      sentRequestHeaders: { Host: "127.0.0.1:1234", Accept: "*/*" },
      decodedBodyBytes: 10_631,
      hasPostData: false,
      postDataBytes: null,
      ...raw,
    },
  };
}

describe("classifySource", () => {
  it("uses explicit Chromium flags, with service worker taking precedence", () => {
    expect(classifySource({ ...noFlags, fromServiceWorker: true, fromDiskCache: true }, true, 200)).toBe("service-worker");
    expect(classifySource({ ...noFlags, servedFromCacheEvent: true }, true, null)).toBe("memory-cache");
    expect(classifySource({ ...noFlags, fromDiskCache: true }, true, null)).toBe("disk-cache");
    expect(classifySource({ ...noFlags, fromPrefetchCache: true }, true, null)).toBe("prefetch-cache");
  });

  it("treats a wire 304 as a network revalidation, not a cache hit", () => {
    expect(classifySource(noFlags, true, 304)).toBe("network-revalidated");
  });

  it("returns unknown when there was no response at all", () => {
    expect(classifySource(noFlags, false, null)).toBe("unknown");
  });
});

describe("estimateHttp1RequestHeadBytes", () => {
  it("counts request line, each header line and the terminating CRLF", () => {
    const bytes = estimateHttp1RequestHeadBytes("GET", "http://h/a?b=1", { Host: "h", Accept: "*/*" });
    const expected = "GET /a?b=1 HTTP/1.1\r\n" + "Host: h\r\n" + "Accept: */*\r\n" + "\r\n";
    expect(bytes).toBe(expected.length);
  });

  it("counts headers that CDP joined with newlines as separate lines", () => {
    const bytes = estimateHttp1RequestHeadBytes("GET", "http://h/", { "X-A": "1\n2" });
    expect(bytes).toBe("GET / HTTP/1.1\r\nX-A: 1\r\nX-A: 2\r\n\r\n".length);
  });
});

describe("deriveMeasurement", () => {
  it("measures a network response and derives the encoded body", () => {
    const m = deriveMeasurement(observed({}));
    expect(m.source).toBe("network");
    expect(m.status).toBe("measured");
    expect(m.receivedBytes).toBe(10_873);
    expect(m.encodedBodyBytes).toBe(10_873 - 242);
    expect(m.requestBodyBytes).toBe(0);
    expect(m.transferBytes).toBe(10_873 + m.requestHeaderBytes!);
  });

  it("reports a disk-cache hit as a genuine zero transfer", () => {
    const m = deriveMeasurement(
      observed({
        flags: { fromDiskCache: true },
        raw: { loadingFinishedEncodedDataLength: 0, responseHeadersTextBytes: null, wireStatus: null, sentRequestHeaders: null },
      }),
    );
    expect(m).toMatchObject({ source: "disk-cache", status: "cache-hit", transferBytes: 0, decodedBodyBytes: 10_631 });
  });

  it("does not call something a cache hit just because sizes look empty", () => {
    // No cache flag: zero bytes alone must not be interpreted as a cache hit.
    const m = deriveMeasurement(observed({ raw: { loadingFinishedEncodedDataLength: 0, responseHeadersTextBytes: null } }));
    expect(m.source).toBe("network");
    expect(m.status).not.toBe("cache-hit");
    expect(m.encodedBodyBytes).toBeNull();
  });

  it("never clamps inconsistent sizes to zero", () => {
    const m = deriveMeasurement(observed({ raw: { loadingFinishedEncodedDataLength: 100, responseHeadersTextBytes: 316 } }));
    expect(m.encodedBodyBytes).toBeNull();
    expect(m.notes.join(" ")).toMatch(/inconsistent/);
  });

  it("refuses to invent a zero when a cache flag disagrees with the byte counters", () => {
    const m = deriveMeasurement(observed({ flags: { fromDiskCache: true }, raw: { loadingFinishedEncodedDataLength: 500 } }));
    expect(m.status).toBe("unavailable");
    expect(m.transferBytes).toBeNull();
  });

  it("marks a 304 revalidation as a measured network transfer of headers only", () => {
    const m = deriveMeasurement(
      observed({ raw: { wireStatus: 304, loadingFinishedEncodedDataLength: 204, responseHeadersTextBytes: 204 } }),
    );
    expect(m.source).toBe("network-revalidated");
    expect(m.encodedBodyBytes).toBe(0);
    expect(m.status).toBe("measured");
  });

  it("leaves service-worker responses unavailable instead of guessing", () => {
    const m = deriveMeasurement(observed({ flags: { fromServiceWorker: true, serviceWorkerResponseSource: "cache-storage" } }));
    expect(m.status).toBe("unavailable");
    expect(m.transferBytes).toBeNull();
    expect(m.notes.join(" ")).toMatch(/cache-storage/);
  });

  it("does not estimate request headers for HTTP/2 (partial measurement)", () => {
    const m = deriveMeasurement(observed({ protocol: "h2" }));
    expect(m.requestHeaderBytes).toBeNull();
    expect(m.transferBytes).toBeNull();
    expect(m.receivedBytes).toBe(10_873);
    expect(m.status).toBe("partial");
  });

  it("keeps an unknown request body size as null", () => {
    const m = deriveMeasurement(observed({ method: "POST", raw: { hasPostData: true, postDataBytes: null } }));
    expect(m.requestBodyBytes).toBeNull();
    expect(m.transferBytes).toBeNull();
  });

  it("reports failed and in-flight requests separately with no byte values", () => {
    const failed = deriveMeasurement(observed({ completion: "failed", failureText: "net::ERR_ABORTED", canceled: true }));
    expect(failed).toMatchObject({ status: "failed", transferBytes: null, receivedBytes: null });
    const inFlight = deriveMeasurement(observed({ completion: "in-flight" }));
    expect(inFlight).toMatchObject({ status: "in-flight", transferBytes: null });
  });
});