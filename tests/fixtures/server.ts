// our fake website
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * Deterministic local fixture server for the measurement prototype.
 *
 * Every resource has a known body size and an explicit caching policy, and the
 * server records what it ACTUALLY put on the wire. That server-side log is our
 * ground truth: if a resource does not appear in the log for a run, the browser
 * did not fetch it over the network during that run.
 */

/** One HTTP exchange as seen by the server (ground truth for a loopback HTTP/1.1 run). */
export interface ServedRequest {
  method: string;
  /** pathname + search, e.g. "/api/search?q=laptop" */
  path: string;
  status: number;
  /** Bytes read from the socket for this request (request line + headers + body). */
  requestWireBytes: number;
  /** Bytes written to the socket for this response (status line + headers + body). */
  responseWireBytes: number;
  /** Bytes of the response body as sent (after any content-encoding). */
  bodyBytes: number;
  contentEncoding: string | null;
}

export interface FixtureServer {
  url: string;
  /** Requests the server has handled since the last reset, in completion order. */
  readonly requests: readonly ServedRequest[];
  resetRequestLog: () => void;
  close: () => Promise<void>;
}

/** Caching policy of each fixture resource, exported so tests and reports can refer to it. */
export const CACHE_POLICY = {
  "/search": "no-cache", // cacheable, but must revalidate (ETag -> 304) on every use
  "/styles.css": "public, max-age=3600",
  "/logo.svg": "public, max-age=3600",
  "/app.js": "public, max-age=3600",
  "/api/config": "public, max-age=3600",
  "/api/search": "no-store", // never stored, always fetched over the network
} as const;

// ---------------------------------------------------------------------------
// Static bodies, computed once so they are byte-for-byte identical every run.
// ---------------------------------------------------------------------------

const SEARCH_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Fixture Search</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <img id="logo" src="/logo.svg" alt="logo" width="64" height="64" />
    <input id="search-input" type="text" />
    <button id="search-button">Search</button>
    <div id="results-container"></div>
    <script src="/app.js"></script>
  </body>
</html>
`;

// Highly repetitive CSS so gzip makes encoded bytes much smaller than decoded bytes.
const STYLES_CSS =
  "body { font-family: sans-serif; }\n" +
  Array.from({ length: 400 }, (_, i) => `.row-${i} { margin: ${i % 8}px; padding: 4px; }`).join("\n") +
  "\n";
const STYLES_CSS_GZIP = gzipSync(Buffer.from(STYLES_CSS)); // deterministic: gzip mtime is 0

const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="#3366ff"/>` +
  `<!-- ${"p".repeat(8_000)} -->` +
  `</svg>`;

const APP_JS = `
(async () => { 
  const configResponse = await fetch("/api/config");
  const config = await configResponse.json();
  document.body.setAttribute("data-config-loaded", config.version);
})();

document.getElementById("search-button").addEventListener("click", async () => {
  const input = document.getElementById("search-input");
  const response = await fetch("/api/search?q=" + encodeURIComponent(input.value));
  const data = await response.json();
  const container = document.getElementById("results-container");
  container.innerHTML = '<div data-testid="search-results">Found ' + data.items.length + ' results</div>';
});
// ${"x".repeat(10_000)}
`;

const CONFIG_JSON = JSON.stringify({
  version: "1",
  features: ["search"],
  padding: "c".repeat(2_000),
});

function etagOf(body: string | Buffer): string {
  return `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
}

const ETAGS = {
  "/search": etagOf(SEARCH_HTML),
  "/styles.css": etagOf(STYLES_CSS),
  "/logo.svg": etagOf(LOGO_SVG),
  "/app.js": etagOf(APP_JS),
  "/api/config": etagOf(CONFIG_JSON),
} as const;

// Response helpers

interface SendOptions {
  body: string | Buffer;
  contentType: string;
  cacheControl: string;
  etag?: string;
  contentEncoding?: string;
  vary?: string;
}

/**
 * Body bytes and encoding of each response, recorded when it is sent.
 * (res.getHeader() cannot see headers passed directly to writeHead(), so we track them here.)
 */
const sentBodies = new WeakMap<ServerResponse, { bodyBytes: number; contentEncoding: string | null }>();

function send(req: IncomingMessage, res: ServerResponse, options: SendOptions): void {
  const headers: Record<string, string | number> = {
    "Content-Type": options.contentType,
    "Cache-Control": options.cacheControl,
  };
  if (options.etag) headers["ETag"] = options.etag;
  if (options.vary) headers["Vary"] = options.vary;

  // Conditional request: the browser already has this exact representation.
  if (options.etag && req.headers["if-none-match"] === options.etag) {
    sentBodies.set(res, { bodyBytes: 0, contentEncoding: null });
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const bodyBytes = Buffer.byteLength(options.body);
  if (options.contentEncoding) headers["Content-Encoding"] = options.contentEncoding;
  headers["Content-Length"] = bodyBytes;
  sentBodies.set(res, { bodyBytes, contentEncoding: options.contentEncoding ?? null });
  res.writeHead(200, headers);
  res.end(options.body);
}

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"];
  return typeof header === "string" && /\bgzip\b/.test(header);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");

  switch (url.pathname) {
    case "/search":
      return send(req, res, {
        body: SEARCH_HTML,
        contentType: "text/html; charset=utf-8",
        cacheControl: CACHE_POLICY["/search"],
        etag: ETAGS["/search"],
      });

    case "/styles.css": {
      const gzip = acceptsGzip(req);
      return send(req, res, {
        body: gzip ? STYLES_CSS_GZIP : STYLES_CSS,
        contentType: "text/css; charset=utf-8",
        cacheControl: CACHE_POLICY["/styles.css"],
        etag: ETAGS["/styles.css"],
        contentEncoding: gzip ? "gzip" : undefined,
        vary: "Accept-Encoding",
      });
    }

    case "/logo.svg":
      return send(req, res, {
        body: LOGO_SVG,
        contentType: "image/svg+xml",
        cacheControl: CACHE_POLICY["/logo.svg"],
        etag: ETAGS["/logo.svg"],
      });

    case "/app.js":
      return send(req, res, {
        body: APP_JS,
        contentType: "application/javascript; charset=utf-8",
        cacheControl: CACHE_POLICY["/app.js"],
        etag: ETAGS["/app.js"],
      });

    case "/api/config":
      return send(req, res, {
        body: CONFIG_JSON,
        contentType: "application/json; charset=utf-8",
        cacheControl: CACHE_POLICY["/api/config"],
        etag: ETAGS["/api/config"],
      });

    case "/api/search": {
      const json = JSON.stringify({
        query: url.searchParams.get("q") ?? "",
        items: ["Laptop Pro 15", "Laptop Air 13", "Gaming Laptop"],
        padding: "y".repeat(5_000),
      });
      return send(req, res, {
        body: json,
        contentType: "application/json; charset=utf-8",
        cacheControl: CACHE_POLICY["/api/search"],
      });
    }

    default: {
      const body = "Not Found";
      sentBodies.set(res, { bodyBytes: Buffer.byteLength(body), contentEncoding: null });
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
    }
  }
}

// Server lifecycle

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const requests: ServedRequest[] = [];

  // HTTP/1.1 keep-alive reuses one socket for several sequential requests, so we
  // remember each socket's byte counters and log the delta per exchange.
  // (Browsers do not pipeline HTTP/1.1, so exchanges on one socket never overlap.)
  const socketCounters = new WeakMap<Socket, { read: number; written: number }>();

  const server = http.createServer((req, res) => {
    res.on("finish", () => {
      const socket = req.socket;
      const previous = socketCounters.get(socket) ?? { read: 0, written: 0 };
      const current = { read: socket.bytesRead, written: socket.bytesWritten };
      socketCounters.set(socket, current);

      const body = sentBodies.get(res);
      requests.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        status: res.statusCode,
        requestWireBytes: current.read - previous.read,
        responseWireBytes: current.written - previous.written,
        bodyBytes: body?.bodyBytes ?? 0,
        contentEncoding: body?.contentEncoding ?? null,
      });
    });

    try {
      handle(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Port 0 lets the OS pick a free port, avoiding EADDRINUSE in tests/CI.
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind server address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        resetRequestLog: () => {
          requests.length = 0;
        },
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
            // Drop idle keep-alive sockets so close() does not wait for them.
            server.closeAllConnections();
          }),
      });
    });
  });
}