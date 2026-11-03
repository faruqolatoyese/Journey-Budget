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
export declare const CACHE_POLICY: {
    readonly "/search": "no-cache";
    readonly "/styles.css": "public, max-age=3600";
    readonly "/logo.svg": "public, max-age=3600";
    readonly "/app.js": "public, max-age=3600";
    readonly "/api/config": "public, max-age=3600";
    readonly "/api/search": "no-store";
};
export declare function startFixtureServer(port?: number): Promise<FixtureServer>;
