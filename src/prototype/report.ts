import type { ExperimentResult, JourneyRun, PlaywrightSizesRecord, Total } from "./experiment.js";
import { validateAgainstServer } from "./experiment.js";
import type { MeasuredRequest } from "./network-collector.js";

/** Render unavailable values visibly instead of as 0. */
const show = (value: number | null | undefined): string | number => (value === null || value === undefined ? "n/a" : value);

function formatTotal(total: Total): string {
  return total.complete
    ? `${total.bytes} bytes`
    : `INCOMPLETE - at least ${total.bytes} bytes (${total.unavailableCount} request(s) unavailable)`;
}

/** Match each CDP request to Playwright's record for the same URL+method, in order. */
function pairPlaywright(requests: MeasuredRequest[], records: PlaywrightSizesRecord[]) {
  const pool = [...records];
  return requests.map((r) => {
    const index = pool.findIndex((p) => p.url === r.url && p.method === r.method);
    return index === -1 ? null : pool.splice(index, 1)[0]!;
  });
}

function printRun(run: JourneyRun, origin: string): void {
  console.log(`\n=== RUN: ${run.label.toUpperCase()} ===`);
  console.log(`Journey duration: ${run.durationMs} ms${run.settled ? "" : "  (WARNING: network did not go idle)"}`);

  const playwright = pairPlaywright(run.requests, run.playwright);
  console.table(
    run.requests.map((r, i) => {
      const m = r.measurement;
      const pw = playwright[i]?.sizes ?? null;
      const status = r.raw.wireStatus !== null && r.raw.wireStatus !== r.pageStatus ? `${r.raw.wireStatus} (page: ${r.pageStatus})` : show(r.pageStatus);
      return {
        url: r.url.replace(origin, ""),
        type: r.resourceType,
        status,
        source: m.source,
        "pw.resBody(raw)": show(pw?.responseBodySize),
        "pw.resHdr(raw)": show(pw?.responseHeadersSize),
        received: show(m.receivedBytes),
        resHdr: show(m.responseHeaderBytes),
        encBody: show(m.encodedBodyBytes),
        decBody: show(m.decodedBodyBytes),
        "reqHdr~": show(m.requestHeaderBytes),
        transfer: show(m.transferBytes),
        measurement: m.status,
      };
    }),
  );

  const notes = run.requests.flatMap((r) => r.measurement.notes.map((n) => `  ${r.url.replace(origin, "")}: ${n}`));
  if (notes.length) console.log("Notes:\n" + notes.join("\n"));
  if (run.errors.length) console.log("Collector errors:\n  " + run.errors.join("\n  "));

  console.log(`Received from network (measured):      ${formatTotal(run.totals.received)}`);
  console.log(`Transfer (received + est. request):    ${formatTotal(run.totals.transfer)}`);

  console.log("Server ground truth (what the fixture actually sent/received):");
  console.table(
    run.server.map((s) => ({ path: s.path, status: s.status, requestWireBytes: s.requestWireBytes, responseWireBytes: s.responseWireBytes, bodyBytes: s.bodyBytes, encoding: s.contentEncoding ?? "" })),
  );

  const checks = validateAgainstServer(run, origin);
  const failures = checks.filter((c) => !c.ok);
  console.log(`Validation vs server: ${checks.length - failures.length}/${checks.length} checks passed`);
  for (const f of failures) console.log(`  MISMATCH ${f.path} ${f.check}: expected ${f.expected}, got ${f.actual}`);
}

export function printExperiment(result: ExperimentResult): void {
  console.log(`Fixture server: ${result.origin}`);
  console.log("Columns: received/resHdr/encBody = measured by Chromium; reqHdr~ = reconstructed HTTP/1.1 request head;");
  console.log("         pw.* = raw Playwright request.sizes() values, shown only for comparison. n/a = not available.");
  for (const run of result.runs) printRun(run, result.origin);

  console.log("\n=== SUMMARY ===");
  console.table(
    result.runs.map((run) => ({
      run: run.label,
      durationMs: run.durationMs,
      requests: run.requests.length,
      fromCache: run.requests.filter((r) => r.measurement.status === "cache-hit").length,
      serverHits: run.server.length,
      transfer: run.totals.transfer.complete ? run.totals.transfer.bytes : `>= ${run.totals.transfer.bytes} (incomplete)`,
    })),
  );
}