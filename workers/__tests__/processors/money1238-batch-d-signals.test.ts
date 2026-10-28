/**
 * MONEY-1238 BATCH D — computed signals that reached nothing that decides.
 *
 * Each block below is one signal that a processor already calculated and then
 * dropped: a counter with no consumer, an `ok` that could not go false, a route
 * that answered 200 whatever happened. The failure mode they share is the one
 * `job-outcome.ts` was written for — the schedule fires, the log looks fine, and
 * the table stops growing.
 *
 * ## Behavioural where a seam exists, structural where it does not
 *
 * `processCircularsSync`, `processPeersSync` and `processIpoSync` now take an
 * optional `deps` whose DEFAULTS ARE THE PRODUCTION PATH, so overriding them
 * drives the real function, the real parser and the real branch table. Nothing
 * in those blocks is a re-declared copy.
 *
 * The remaining processors (`stock-document-embed`, `corporate-actions-sync`,
 * `index-constituent-sync`, `report-archive-sync`) need Prisma, GCS and three
 * scraped upstreams to reach the line in question, so those are asserted
 * STRUCTURALLY against the file on disk — the same technique as
 * `log-boundary.test.ts` and `job-outcome-coverage.test.ts`. Every structural
 * match is BOUNDED (a brace-matched block, or a single statement), never an
 * unbounded `[\s\S]*?` that could span a function boundary and pass by
 * accident.
 *
 * Comments are stripped LINE-BEFORE-BLOCK (MONEY-1143): a `//` comment
 * mentioning an unterminated block comment otherwise opens a phantom block that
 * swallows the code under test, and swallowed code reads as "the guard is
 * absent" — or worse, as "the bug is absent".
 *
 * No sockets, no Prisma handles, no timers. Nothing here can orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { processCircularsSync } from "../../src/processors/circulars-sync";
import { processPeersSync } from "../../src/processors/peers-sync";
import { processIpoSync } from "../../src/processors/ipo-sync";
import { recordsFailedFrom } from "../../src/processors/report-archive-sync-logic";
import type { RunCounts } from "../../src/processors/report-archive-sync-logic";
import type { IpoIssue } from "@usemoney/research/data-sources/issues-logic";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

/** Blank comment BODIES, preserving offsets. LINE first, then BLOCK. */
const spaces = (s: string): string => s.replace(/[^\n]/g, " ");
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

/**
 * The source text of the `{...}` block that opens at `header`, brace-matched.
 *
 * Bounded by construction: it stops at the block's OWN closing brace, so an
 * assertion about "inside this if" cannot silently drift into the next
 * function. Throws when the header is absent, so a rename fails loudly rather
 * than making every assertion about the block vacuously true.
 */
function blockAfter(code: string, header: string): string {
  const start = code.indexOf(header);
  assert.notEqual(start, -1, `header not found: ${header}`);
  let i = code.indexOf("{", start + header.length - 1);
  assert.notEqual(i, -1, `no opening brace after: ${header}`);
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}") {
      depth--;
      if (depth === 0) return code.slice(i + 1, j);
    }
  }
  throw new Error(`unbalanced braces after: ${header}`);
}

/** Capture console output for the duration of `fn`. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const real = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const sink =
    (tag: string) =>
    (...args: unknown[]) => {
      lines.push(`${tag} ${args.map((a) => String(a)).join(" ")}`);
    };
  console.log = sink("LOG");
  console.warn = sink("WARN");
  console.error = sink("ERROR");
  try {
    return { value: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

/* -------------------------------------------------------------------------- */
/* Item 3 — circulars-sync: "rejected" is not "empty"                          */
/* -------------------------------------------------------------------------- */

/** A row the REAL parser accepts. */
const goodRow = (n: string) => ({
  circNumber: n,
  cirDate: "20260810",
  sub: `Subject ${n}`,
  circDepartment: "Listing",
  circCategory: "Compliance",
});

/**
 * A row the REAL parser REJECTS (BAD_DATE) — which is exactly what an NSE date
 * re-spelling produces for every record at once.
 */
const badDateRow = (n: string) => ({
  circNumber: n,
  cirDate: "10-Aug-2026",
  sub: `Subject ${n}`,
  circDepartment: "Listing",
});

describe("MONEY-1238 item 3 · circulars-sync: total parse failure is not an empty window", () => {
  const window = { from: new Date("2026-08-01"), to: new Date("2026-08-15") };

  it("237 records, ALL rejected -> ok:false, empty:false (was ok:true, empty:true)", async () => {
    const payload = {
      data: Array.from({ length: 237 }, (_, i) => badDateRow(`${70000 + i}`)),
      fromDate: "01-08-2026",
      toDate: "15-08-2026",
    };
    const { value, lines } = await capture(() =>
      processCircularsSync(window, {
        fetchJson: async () => payload,
        write: async () => {
          throw new Error("must not write on a total parse failure");
        },
      }),
    );
    const r = value!;
    assert.equal(r.ok, false, "a window where nothing parsed is NOT ok");
    assert.equal(r.empty, false, "it is not an EMPTY window");
    assert.equal(r.rejected, 237);
    assert.equal(r.written, 0);
    assert.ok(
      lines.some((l) => l.includes("TOTAL PARSE FAILURE")),
      `expected a TOTAL PARSE FAILURE line, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("NSE published no circulars")),
      "must NOT claim NSE published nothing",
    );
  });

  it("a genuinely empty window still reports ok:true, empty:true", async () => {
    const { value, lines } = await capture(() =>
      processCircularsSync(window, {
        fetchJson: async () => ({
          data: [],
          fromDate: "01-08-2026",
          toDate: "15-08-2026",
        }),
        write: async () => 0,
      }),
    );
    assert.equal(value!.ok, true);
    assert.equal(value!.empty, true);
    assert.equal(value!.rejected, 0);
    assert.ok(lines.some((l) => l.includes("NSE published no circulars")));
  });

  it("a PARTIAL rejection keeps ok:true but warns instead of logging 'done'", async () => {
    const payload = {
      data: [goodRow("70001"), goodRow("70002"), badDateRow("70003")],
      fromDate: "01-08-2026",
      toDate: "15-08-2026",
    };
    let wrote = 0;
    const { value, lines } = await capture(() =>
      processCircularsSync(window, {
        fetchJson: async () => payload,
        write: async (rows) => {
          wrote = rows.length;
          return rows.length;
        },
      }),
    );
    assert.equal(value!.ok, true);
    assert.equal(value!.parsed, 2);
    assert.equal(value!.rejected, 1);
    assert.equal(wrote, 2);
    assert.ok(
      lines.some((l) => l.startsWith("WARN") && l.includes("REJECTED")),
      `expected a rejection WARN, got:\n${lines.join("\n")}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 4 — peers-sync: skippedNoSector / zero-write                           */
/* -------------------------------------------------------------------------- */

const peersOk =
  (data: {
    scanned: number;
    written: number;
    withPeers: number;
    skippedNoSector: number;
  }) =>
  async () => ({ success: true as const, data });

describe("MONEY-1238 item 4 · peers-sync: the counters decide something", () => {
  it("written !== scanned THROWS (route -> 500 -> retry)", async () => {
    // MONEY-1236 — the assertion used to be `written === 0`, which was
    // UNREACHABLE in production: `rows = candidates.map(...)` makes one row per
    // candidate and `idBySymbolExchange` is filled in the SAME loop that builds
    // them, so the only `return false` path cannot fire and `written` always
    // equals `scanned`. A guard that cannot fire is the appearance of
    // protection, not protection. The real invariant — every candidate produces
    // a row, empties included — IS reachable, and fires the moment a future
    // change filters `rows` or reintroduces an unresolvable id.
    const { error } = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 6992,
            written: 0,
            withPeers: 0,
            skippedNoSector: 100,
          }),
        },
      ),
    );
    assert.ok(error instanceof Error, "a short run must not return quietly");
    assert.match(String(error), /wrote 0 row\(s\) for 6992 scanned/);
  });

  it("a PARTIAL shortfall throws too — not just a total one", async () => {
    // The case the old `written === 0` test could never see: 6,991 of 6,992
    // written is still a broken mapping, and used to pass silently with
    // `failed: 1` in a job outcome nothing blocks on.
    const { error } = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 6992,
            written: 6991,
            withPeers: 5000,
            skippedNoSector: 100,
          }),
        },
      ),
    );
    assert.ok(error instanceof Error, "a short run must not return quietly");
    assert.match(String(error), /wrote 6991 row\(s\) for 6992 scanned/);
  });

  it("written === scanned returns cleanly", async () => {
    // The control. Without it the two assertions above pass for any fixture.
    const { error } = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 6992,
            written: 6992,
            withPeers: 5000,
            skippedNoSector: 100,
          }),
        },
      ),
    );
    assert.equal(error, undefined, "a complete run must not throw");
  });

  it("emits a job-outcome carrying scanned/written/failed and skippedNoSector", async () => {
    const { lines } = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 100,
            written: 90,
            withPeers: 80,
            skippedNoSector: 10,
          }),
        },
      ),
    );
    const outcome = lines.find((l) => l.includes('"msg":"job-outcome"'));
    assert.ok(outcome, `no job-outcome line in:\n${lines.join("\n")}`);
    assert.match(outcome!, /"job":"peers-sync"/);
    assert.match(outcome!, /"selected":100/);
    assert.match(outcome!, /"written":90/);
    assert.match(outcome!, /"failed":10/);
    assert.match(outcome!, /skippedNoSector=10/);
  });

  it("a sectorless-universe COLLAPSE is logged as an error; a normal run is not", async () => {
    const collapsed = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 100,
            written: 100,
            withPeers: 90,
            skippedNoSector: 900,
          }),
        },
      ),
    );
    assert.ok(
      collapsed.lines.some(
        (l) => l.startsWith("ERROR") && l.includes("has NO sector"),
      ),
      `90% sectorless must be an ERROR, got:\n${collapsed.lines.join("\n")}`,
    );

    // ~67% is the MEASURED steady state (14,893 of 22,153 carry the "N/A"
    // sentinel), so it must stay quiet or the alarm fires nightly and is muted.
    const normal = await capture(() =>
      processPeersSync(
        {},
        {
          sync: peersOk({
            scanned: 7260,
            written: 7260,
            withPeers: 7000,
            skippedNoSector: 14893,
          }),
        },
      ),
    );
    assert.ok(
      !normal.lines.some(
        (l) => l.startsWith("ERROR") && l.includes("has NO sector"),
      ),
      "the measured 67% steady state must NOT alarm",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 2 — ipo-sync: skippedNoStartDate reaches the route                     */
/* -------------------------------------------------------------------------- */

const issue = (symbol: string, issueStart: Date | null): IpoIssue => ({
  symbol,
  companyName: `${symbol} Ltd`,
  series: "EQ",
  issueStart,
  issueEnd: null,
  status: "UPCOMING",
  priceMin: null,
  priceMax: null,
  issueSize: null,
  lotSize: null,
  listingDate: null,
  isSme: false,
  source: "upcoming",
  raw: {},
});

const delegateThatWorks = () => ({ upsert: async () => ({}) });
/**
 * Every upsert rejects — a TRANSIENT zero-write, not a key rename.
 *
 * The control for the key-drift carve-out (MONEY-1236): this shape must keep
 * `ok: false` so the route still answers 500 and Pub/Sub still retries.
 */
const delegateThatFailsUpsert = () => ({
  upsert: async () => {
    throw new Error("db unavailable");
  },
});

describe("MONEY-1238 item 2 · ipo-sync: a key rename cannot look like a quiet week", () => {
  it("every merged issue missing issueStart -> keyDrift, and ok:TRUE", async () => {
    // MONEY-1236 — `ok` was false, so the route answered 500 and Pub/Sub
    // retried. But a KEY DRIFT is an upstream FIELD RENAME: it rejects the same
    // way on all five delivery attempts, so a DAILY job burned its whole retry
    // budget and dead-lettered every night for a condition no retry can fix.
    // This is the rule the same processor already applied to `modelMissing`
    // sixty lines above ("a missing model fails identically on every delivery").
    //
    // Nothing is softened: `keyDrift`, `reason` and the no-start examples all
    // still ride the result, the route logs it at error level, and the body
    // says `success: false`. Only the TRANSPORT verdict changed.
    const { value } = await capture(() =>
      processIpoSync(
        { sources: ["upcoming"], delayMs: 0 },
        {
          fetch: async () => [
            issue("AAA", null),
            issue("BBB", null),
            issue("CCC", null),
          ],
          getDelegate: delegateThatWorks,
        },
      ),
    );
    const r = value!;
    assert.equal(
      r.ok,
      true,
      "a DETERMINISTIC failure must ACK — retrying a field rename cannot fix it",
    );
    assert.equal(r.keyDrift, true, "and it must still SAY what happened");
    assert.equal(r.skippedNoStartDate, 3);
    assert.equal(r.upserted, 0);
    assert.match(r.reason ?? "", /KEY DRIFT/);
  });

  it("a zero-write run WITHOUT key drift is still ok:false and retriable", async () => {
    // The control, and the reason `keyDrift` is a carve-out rather than a
    // blanket softening: a run that merged issues carrying real start dates and
    // still wrote nothing is a TRANSIENT failure, and must keep its retry.
    const { value } = await capture(() =>
      processIpoSync(
        { sources: ["upcoming"], delayMs: 0 },
        {
          fetch: async () => [issue("AAA", new Date("2026-09-01"))],
          getDelegate: delegateThatFailsUpsert,
        },
      ),
    );
    const r = value!;
    assert.equal(
      r.keyDrift,
      false,
      "[meta] this fixture must not be key drift",
    );
    assert.equal(r.ok, false, "a transient zero-write run keeps its retry");
  });

  it("a healthy run is ok:true with keyDrift false", async () => {
    const { value } = await capture(() =>
      processIpoSync(
        { sources: ["upcoming"], delayMs: 0 },
        {
          fetch: async () => [
            issue("AAA", new Date("2026-09-01")),
            issue("BBB", new Date("2026-09-02")),
          ],
          getDelegate: delegateThatWorks,
        },
      ),
    );
    assert.equal(value!.ok, true);
    assert.equal(value!.keyDrift, false);
    assert.equal(value!.upserted, 2);
    assert.equal(value!.reason, undefined);
  });

  it("a genuinely empty week is ok:true — merged 0 must not NACK", async () => {
    const { value } = await capture(() =>
      processIpoSync(
        { sources: ["upcoming"], delayMs: 0 },
        { fetch: async () => [], getDelegate: delegateThatWorks },
      ),
    );
    assert.equal(value!.ok, true);
    assert.equal(value!.merged, 0);
  });

  it("a MISSING UpcomingIpo model stays ok:true (a NACK would loop forever) but is named", async () => {
    const { value } = await capture(() =>
      processIpoSync(
        { sources: ["upcoming"], delayMs: 0 },
        {
          fetch: async () => [issue("AAA", new Date("2026-09-01"))],
          getDelegate: () => null,
        },
      ),
    );
    assert.equal(value!.ok, true);
    assert.equal(value!.modelMissing, true);
    assert.match(value!.reason ?? "", /UpcomingIpo model absent/);
  });

  it("the route answers 500 when ok is false", () => {
    const code = stripComments(read("routes/ipo-sync.ts"));
    const body = blockAfter(code, "if (!result.ok)");
    assert.match(
      body,
      /return c\.json\([^;]*500\)/,
      "an ok:false run must NOT be acked with 200",
    );
    // The old shape: an unconditional trailing 200 outside every branch.
    assert.ok(
      !/\}\s*return c\.json\(\{ success: true \}, 200\);\s*\}\);\s*$/.test(
        code,
      ),
      "the unconditional trailing 200 must be gone",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 7 — report-archive-sync: store-failed IS a failure                     */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 7 · recordsFailedFrom counts store-failed", () => {
  const counts = (over: Partial<RunCounts> = {}): RunCounts => ({
    archived: 0,
    fetched: 0,
    "store-failed": 0,
    absent: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
    ...over,
  });

  it("bytes fetched under an ARMED archive that never landed count as failed", () => {
    assert.equal(recordsFailedFrom(counts({ "store-failed": 7 })), 7);
  });

  it("still counts failed and rejected", () => {
    assert.equal(
      recordsFailedFrom(counts({ failed: 2, rejected: 3, "store-failed": 4 })),
      9,
    );
  });

  it("absent (holiday/not-published) and skipped are NOT failures", () => {
    assert.equal(recordsFailedFrom(counts({ absent: 30, skipped: 12 })), 0);
  });

  it("fetched-but-disarmed is not a failure either — a re-fetch would not store it", () => {
    assert.equal(recordsFailedFrom(counts({ fetched: 34 })), 0);
  });

  it("the write site uses the helper, not an inline sum", () => {
    const code = stripComments(read("processors/report-archive-sync.ts"));
    assert.match(code, /recordsFailed: recordsFailedFrom\(counts\)/);
    assert.ok(
      !/recordsFailed:\s*counts\.failed \+ counts\.rejected,/.test(code),
      "the old store-failed-omitting sum must be gone",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 8 — DriftDiff.unregistered has a reader                                */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 8 · the drift guard's unregistered set is persisted", () => {
  it("runDriftGuard returns it and the run metadata stores it", () => {
    const code = stripComments(read("processors/report-archive-sync.ts"));
    assert.match(
      code,
      /runMetadata\.unregisteredFileKeys = sweep\.unregistered;/,
      "the coverage measure must reach the persisted run",
    );
    // Anchored on the RETURN TYPE, not the function name: the parameter list
    // carries an inline `{ metadata: unknown }`, and brace-matching from the
    // name would bound the "block" to that type annotation instead of the body.
    const guard = blockAfter(code, "): Promise<DriftSweep | null>");
    assert.equal(
      (guard.match(/unregistered: diff\.unregistered/g) ?? []).length,
      2,
      "BOTH exits — baseline and steady-state — must carry `unregistered` out",
    );
  });

  it("the metadata type declares the field", () => {
    const logic = stripComments(
      read("processors/report-archive-sync-logic.ts"),
    );
    const meta = blockAfter(logic, "export type ReportArchiveRunMetadata =");
    assert.match(meta, /unregisteredFileKeys\?: string\[\]/);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 1 — stock-document-embed: embedded++ means EMBEDDED                    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 1 · stock-document-embed counts only what it stored", () => {
  const code = stripComments(read("processors/stock-document-embed.ts"));

  it("embedded++ / totalChunks live INSIDE the storedCount > 0 block", () => {
    const stored = blockAfter(code, "if (storedCount > 0)");
    assert.match(stored, /embedded\+\+;/);
    assert.match(stored, /totalChunks \+= storedCount;/);
    assert.match(stored, /touchedSymbols\.add\(doc\.symbol\)/);
  });

  it("a document that stored nothing is counted as such", () => {
    assert.match(code, /zeroStored\+\+;/);
    assert.match(code, /let zeroStored = 0;/);
  });

  it("a batch where EVERY attempted document stored nothing throws", () => {
    // MONEY-1236 — the condition was `embedded === 0`, which also matched a
    // batch the loop is explicitly built to absorb. Near the tail of the queue a
    // batch is one or two documents; if two are skippedShort and the remaining
    // one THROWS on its GCS read then `attempted === 1, embedded === 0`, and the
    // old test fired: 500, five redeliveries, dead-letter and a founder
    // notification, for ONE bad document.
    //
    // `zeroStored === attempted` is the actual revoked-key signature — every
    // attempted document chunked fine and the embedding call stored nothing.
    // The per-document throw path is `failed`, and it is isolated by design.
    const guard = blockAfter(
      code,
      "if (attempted > 0 && zeroStored === attempted)",
    );
    assert.match(guard, /throw new Error\(/);
    assert.match(code, /const attempted = embedded \+ zeroStored \+ failed;/);
  });

  it("the near-miss is LOUD but not retried", () => {
    // Nothing embedded, but at least one document failed for its own reason.
    // Reported at error level and ACKed — retrying a bad document cannot fix it.
    const near = blockAfter(
      code,
      "if (attempted > 0 && embedded === 0 && zeroStored < attempted)",
    );
    assert.match(near, /logger\.error\(/);
    assert.doesNotMatch(near, /throw new Error\(/);
  });

  it("the progress log cannot fire on every document when nothing embedded", () => {
    // `embedded % 20 === 0` is true at 0, and the zeroStored path leaves
    // `embedded` at 0 — so a run where the backend refuses everything logged a
    // progress line per document.
    assert.match(code, /if \(embedded > 0 && embedded % 20 === 0\)/);
  });

  it("the route no longer acks a total embedding outage with 200", () => {
    const route = stripComments(read("routes/stock-document-embed.ts"));
    assert.ok(
      !/return c\.json\(\{ success: true, recovered: true \}, 200\)/.test(
        route,
      ),
      "the blanket recovered-200 must be gone",
    );
    assert.match(route, /500\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 9 — corporate-actions-sync: the write loop counts its failures         */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 9 · corp-actions upsert failures are counted and reported", () => {
  const code = stripComments(read("processors/corporate-actions-sync.ts"));

  it("the per-symbol catch increments a failure counter", () => {
    const loop = blockAfter(code, "for (const [symbol, rows] of bySymbol)");
    assert.match(loop, /upsertFailures\+\+;/);
    assert.match(loop, /failedSymbols\.push\(symbol\)/);
  });

  it("the run emits a job-outcome whose `failed` is those failures", () => {
    // The FINAL emission (2-space statement indent). The early
    // nothing-fetched exit emits at 4 and is a different assertion.
    //
    // MONEY-1301 made the reporter injectable for the ISIN-join tests
    // (`const report = deps?.reportOutcome ?? reportJobOutcome`), so the call
    // site is now `report({` and the literal `reportJobOutcome(` survives only
    // as the import and the fallback. `blockAfter` THREW rather than passing
    // vacuously, which is exactly what its docstring promises and why this is a
    // one-line update instead of a silent hole — the same rot that took out
    // REPOSITORY_WRITES in prod-only-sync-coverage during the same wave.
    const outcome = blockAfter(code, "\n  report({");
    assert.match(outcome, /failed: upsertFailures/);
    assert.match(outcome, /selected: bySymbol\.size/);
    assert.match(outcome, /written: bySymbol\.size - upsertFailures/);
  });

  it("an ALL-symbols-failed run throws instead of returning quietly", () => {
    const guard = blockAfter(
      code,
      "if (bySymbol.size > 0 && upsertFailures === bySymbol.size)",
    );
    assert.match(guard, /throw new Error\(/);
  });

  it("the route no longer acks that with 200", () => {
    const route = stripComments(read("routes/corporate-actions.ts"));
    assert.ok(
      !/return c\.json\(\{ success: true, recovered: true \}, 200\)/.test(
        route,
      ),
      "the blanket recovered-200 must be gone",
    );
    assert.match(route, /500\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 6 — index-constituent-sync: the strategy degradation is visible        */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 6 · index-constituent-sync reports its fallbacks", () => {
  const code = stripComments(read("processors/index-constituent-sync.ts"));

  it("an archive miss is attributed by CAUSE, not collapsed into one null", () => {
    const fn = blockAfter(code, "async function resolveFromArchive(");
    assert.match(fn, /prefix listed ZERO objects/);
    assert.match(fn, /NONE matched a dated constituent/);
    assert.match(fn, /download returned nothing/);
    assert.match(fn, /parsed ZERO rows/);
  });

  it("the miss travels by return value, never module state (concurrency)", () => {
    assert.ok(
      !/^const archiveMisses = new Map/m.test(code),
      "a module-level map would misattribute across concurrent runs",
    );
    assert.match(code, /interface ArchiveAttempt/);
  });

  it("`strategy` and `degraded` reach the processor's declared result", () => {
    // Not brace-matched from the function name — its signature carries an
    // inline `Promise<{ … }>` return type, which would bound the block to the
    // type annotation rather than the body.
    assert.match(code, /return \{ ok, degraded, results \};/);
    assert.match(
      code,
      /degraded: Array<\{ indexId: string; strategy\?: Strategy; why: string \}>/,
    );
    assert.match(code, /strategy\?: Strategy;/);
  });

  it("degradation is reported, NOT folded into ok (QA has no mirror)", () => {
    assert.match(code, /const ok = results\.every\(\(r\) => r\.ok\);/);
    assert.ok(
      !/const ok =[^;]*degraded/.test(code),
      "a degraded run must not 500 forever on an env with no feeds/ mirror",
    );
  });

  it("the route passes `degraded` to the caller on BOTH paths", () => {
    const route = stripComments(read("routes/index-constituent-sync.ts"));
    assert.equal(
      (route.match(/degraded: result\.degraded/g) ?? []).length,
      2,
      "the 200 body must carry it too — that is the only path it is visible on",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 5 — login-briefing: FAILED is no longer a dead end                     */
/* -------------------------------------------------------------------------- */

describe("MONEY-1238 item 5 · login-briefing failures are retryable", () => {
  const code = stripComments(read("processors/login-briefing.ts"));

  it("the outer catch re-throws after stamping FAILED", () => {
    const outer = blockAfter(code, "} catch (error) {");
    assert.match(outer, /status: "FAILED"/);
    assert.match(outer, /throw error;/);
  });

  it("a notification failure cannot un-COMPLETE a finished briefing", () => {
    // The createNotification call must sit inside its OWN try, or its failure
    // falls to the outer catch and stamps FAILED over a COMPLETED row — and,
    // with the re-throw above, would also re-run a briefing that succeeded.
    assert.match(
      code,
      /try \{\s*await createNotification\(/,
      "createNotification must open its OWN try",
    );
    assert.match(
      code,
      /COMPLETED but its notification/,
      "the swallowed notification failure must still be logged",
    );
  });

  it("the route no longer ACKs a failed briefing", () => {
    const route = stripComments(read("routes/login-briefing.ts"));
    assert.ok(
      !/ACK to prevent retries/.test(route),
      "the ACK-always comment and behaviour must be gone",
    );
    assert.match(route, /500\)/);
  });
});
