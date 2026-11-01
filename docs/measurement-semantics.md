# Measurement semantics (Milestone 1)

Validated by `npm run prototype` and `tests/cache-experiment.test.ts` against the
local fixture (`tests/fixtures/server.ts`), Chromium, HTTP/1.1 over loopback.

## Source of truth

Chromium DevTools Protocol (CDP) `Network.*` events, from a dedicated CDP session
per measured run. Playwright's `request.sizes()` is only kept for comparison.

| Field | CDP origin | Kind |
|---|---|---|
| `receivedBytes` | `Network.loadingFinished.encodedDataLength` | measured |
| `responseHeaderBytes` | byte length of `responseReceivedExtraInfo.headersText` | measured |
| `encodedBodyBytes` | `receivedBytes - responseHeaderBytes` (null if negative/unknown) | derived |
| `decodedBodyBytes` | sum of `Network.dataReceived.dataLength` | measured (resource size) |
| `requestHeaderBytes` | reconstructed from `requestWillBeSentExtraInfo.headers` | estimate, HTTP/1.x only |
| `requestBodyBytes` | `request.postData` / `postDataEntries` | measured, null if not reported |
| `transferBytes` | received + request head + request body | null if any part is null |

In the fixture, `receivedBytes` and `requestHeaderBytes` matched the server's socket
byte counters exactly for every network response.

## Response source classification (explicit flags only)

1. `response.fromServiceWorker` → `service-worker` (transfer = unavailable)
2. `Network.requestServedFromCache` → `memory-cache`
3. `response.fromDiskCache` → `disk-cache`
4. `response.fromPrefetchCache` → `prefetch-cache`
5. wire status 304 (`responseReceivedExtraInfo.statusCode`) → `network-revalidated`
6. otherwise → `network`

A cache hit counts as a genuine `0` only when a cache flag is set **and** Chromium
reports `encodedDataLength = 0` **and** no request headers were sent. If those
facts disagree, the request is marked `unavailable`. Byte values are never clamped.

## Rules

- `null` means unavailable. It is never turned into 0.
- A run total is reported as **incomplete** if any request's value is null.
- Never use `page.route()`/`context.route()` while measuring: Playwright disables the HTTP cache when interception is active.
- Cold = new `BrowserContext`. Warm = same context, after a cold run.

## Known limitations

- Application-layer bytes only. TCP/IP framing, TLS records and handshakes, retransmissions, DNS and QUIC overhead are **not** included. This is not carrier billing.
- HTTP/2 and HTTP/3 compress headers, so `requestHeaderBytes` is left null (totals become partial). Not exercised by the fixture (loopback HTTP/1.1).
- Service-worker responses: the worker's own network fetches happen in a separate CDP target. They are classified but not measured, and no fixture covers them yet.
- Out-of-process iframes and dedicated/shared workers have their own CDP targets and are not observed by the page session.
- Bytes received before a failed/aborted request are not reported by Chromium.
- Redirect hops are recorded but their per-hop bytes are not validated yet.
- Chromium only. Firefox/WebKit expose different data.
- Cross-origin resources: CDP sees their sizes (unlike `PerformanceResourceTiming`, which needs `Timing-Allow-Origin`), but this hasn't been fixture-tested yet.
