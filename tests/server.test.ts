import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFixtureServer, CACHE_POLICY, type FixtureServer } from "./fixtures/server.js";

describe("Fixture Server", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => server.resetRequestLog());

  it("serves every resource with its declared caching policy", async () => {
    const expectations: [string, string][] = [
      ["/search", "text/html"],
      ["/styles.css", "text/css"],
      ["/logo.svg", "image/svg+xml"],
      ["/app.js", "application/javascript"],
      ["/api/config", "application/json"],
      ["/api/search?q=laptop", "application/json"],
    ];
    for (const [path, type] of expectations) {
      const res = await fetch(`${server.url}${path}`);
      await res.arrayBuffer();
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
      const policyKey = new URL(path, "http://x").pathname as keyof typeof CACHE_POLICY;
      expect(res.headers.get("cache-control"), path).toBe(CACHE_POLICY[policyKey]);
    }
  });

  it("returns 304 with no body when the ETag matches", async () => {
    const first = await fetch(`${server.url}/search`);
    await first.text();
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await fetch(`${server.url}/search`, { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("gzips the stylesheet when accepted and logs the encoded body size", async () => {
    const res = await fetch(`${server.url}/styles.css`, { headers: { "Accept-Encoding": "gzip" } });
    const text = await res.text(); // fetch transparently decodes gzip
    expect(text).toContain(".row-399");

    const logged = server.requests.at(-1)!;
    expect(logged.contentEncoding).toBe("gzip");
    expect(logged.bodyBytes).toBeLessThan(Buffer.byteLength(text) / 5);
  });

  it("logs wire-level byte counts for each exchange", async () => {
    const res = await fetch(`${server.url}/api/search?q=laptop`);
    const body = await res.text();
    const logged = server.requests.at(-1)!;
    expect(logged.path).toBe("/api/search?q=laptop");
    expect(logged.bodyBytes).toBe(Buffer.byteLength(body));
    expect(logged.responseWireBytes).toBeGreaterThan(logged.bodyBytes); // + status line and headers
    expect(logged.requestWireBytes).toBeGreaterThan(0);
  });

  it("returns 404 for unknown paths instead of hanging", async () => {
    const res = await fetch(`${server.url}/favicon.ico`);
    expect(res.status).toBe(404);
    await res.text();
  });
});
