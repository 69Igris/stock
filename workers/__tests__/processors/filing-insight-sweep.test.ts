/**
 * THE SWEEP'S TWO READS — MONEY-1324 (P17), I/O half.
 *
 * The pure planner is covered by `filing-insight-sweep-logic.test.ts`. This
 * file exists for the half a pure test cannot reach: the two `findMany` calls,
 * and specifically the ASYMMETRY between them that made one of them unsafe.
 *
 * ## What was wrong
 *
 * The cohort read was `take: SWEEP_SCAN_CAP + 1` with an `orderBy`, a `where`,
 * and a truncation check whose breach is reported. The INSIGHT read one call
 * below it was `take: SWEEP_SCAN_CAP + 1` and NOTHING ELSE — no `where`, no
 * `orderBy`, and no check.
 *
 * Past 20,000 insight rows that returns an ARBITRARY 20,000 of them. Every
 * READY row outside the slice reads as never-analysed, so the planner publishes
 * its document, a leaf re-reads it, and a PAID model call is spent — every ten
 * minutes, forever, while `owed` climbs and looks like honest backlog. Nothing
 * in the outcome could say it was happening.
 *
 * ## What it is now
 *
 * The rows the planner can possibly look up are exactly those keyed to a
 * document it SCANNED, so the read is narrowed to those accessions and issued
 * in chunks — proportional to the scan, which is already capped, instead of to
 * the table. The ceiling that remains is CHECKED, and a breach SUPPRESSES the
 * fan-out rather than merely being reported: an incomplete insight index does
 * not make the fan-out smaller, it makes it wrong in the direction that spends
 * money.
 *
 * ## And the tripwire nobody could trip
 *
 * `scanTruncated` had exactly one reporting surface: the ELSE branch of a
 * ternary whose first arm is `owed > 0 && published === 0`. That condition is
 * the SHIPPING STATE — `US_FILING_INSIGHT_APPLY` ships "false", so a disarmed
 * tick with a non-empty queue always took the first arm and the truncation was
 * never reported. No log line printed it either. Both are asserted below.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import prisma from "@usemoney/database";

import {
  processFilingInsightSweep,
  composeSkippedReason,
} from "../../src/processors/filing-insight-sweep";
import {
  SWEEP_SCAN_CAP,
  INSIGHT_READ_CHUNK,
  planInsightReadChunks,
  US_FILING_INSIGHT_APPLY_ENV,
} from "../../src/processors/filing-insight-sweep-logic";

type Row = Record<string, unknown>;

/** A cohort document as prod stores one — `textPath` a real string. */
function doc(i: number): Row {
  return {
    id: `oid-${i}`,
    accession: `0001000000-26-${String(i).padStart(6, "0")}`,
    sequence: 1,
    cik10: "0000866829",
    symbol: "HOS",
    form: "8-K",
    documentType: "EX-99.1",
    filedAt: new Date(2026, 7, 1 + (i % 27)),
    textPath: `edgar/text/x/${i}.txt`,
    textHash: `h-${i}`,
  };
}

/** A READY insight for that document — the row a re-publish would waste. */
function ready(d: Row): Row {
  return {
    accession: d.accession,
    sequence: d.sequence,
    insightStatus: "READY",
    sourceTextHash: d.textHash,
    promptVersion: "v1",
    analysedAt: new Date(2026, 7, 28),
  };
}

let documents: Row[];
let insightRows: Row[];
/** Every `where` the insight read was issued with, in order. */
let insightWheres: Row[];
/** Set to force the insight read to answer with more rows than it was asked. */
let insightOverflow: number;

type DocFindMany = typeof prisma.usFilingDocument.findMany;
type InsightFindMany = typeof prisma.usFilingInsight.findMany;
let realDocFindMany: DocFindMany;
let realInsightFindMany: InsightFindMany;

const ARMED = { [US_FILING_INSIGHT_APPLY_ENV]: "true" } as NodeJS.ProcessEnv;
const DISARMED = {
  [US_FILING_INSIGHT_APPLY_ENV]: "false",
} as NodeJS.ProcessEnv;

before(() => {
  realDocFindMany = prisma.usFilingDocument.findMany;
  realInsightFindMany = prisma.usFilingInsight.findMany;

  prisma.usFilingDocument.findMany = (async (args: { take: number }) =>
    documents.slice(0, args.take)) as unknown as DocFindMany;

  prisma.usFilingInsight.findMany = (async (args: {
    where?: { accession?: { in?: string[] } };
    take: number;
  }) => {
    insightWheres.push((args.where ?? {}) as Row);
    if (insightOverflow > 0) {
      // A page LARGER than the cap, which is what a real overflowing read
      // looks like from the caller's side.
      const n = Math.min(args.take, insightOverflow);
      insightOverflow -= n;
      return Array.from({ length: n }, (_, i) => ready(doc(1_000_000 + i)));
    }
    const wanted = args.where?.accession?.in;
    const rows =
      wanted === undefined
        ? insightRows
        : insightRows.filter((r) => wanted.includes(r.accession as string));
    return rows.slice(0, args.take);
  }) as unknown as InsightFindMany;
});

after(() => {
  prisma.usFilingDocument.findMany = realDocFindMany;
  prisma.usFilingInsight.findMany = realInsightFindMany;
});

beforeEach(() => {
  documents = [];
  insightRows = [];
  insightWheres = [];
  insightOverflow = 0;
});

describe("MONEY-1324 — the sweep's insight read is BOUNDED and checked", () => {
  it("reads insights NARROWED to the scanned accessions, never the whole table", async () => {
    documents = [doc(1), doc(2), doc(3)];
    const published: string[] = [];

    const outcome = await processFilingInsightSweep(
      { mode: "sweep" },
      { env: ARMED, publish: async (id) => void published.push(id) },
    );

    assert.equal(outcome.ok, true);
    assert.equal(insightWheres.length, 1, "expected one chunked read");
    const where = insightWheres[0] as { accession?: { in?: string[] } };
    assert.ok(
      Array.isArray(where.accession?.in),
      "the insight read carries NO `where` — it is reading the whole table " +
        "again, which is the unbounded read this file exists for. " +
        `Got ${JSON.stringify(where)}`,
    );
    assert.deepEqual(
      [...(where.accession?.in ?? [])].sort(),
      documents.map((d) => d.accession as string).sort(),
      "the read names accessions the scan did not produce, or misses some",
    );
    assert.equal(published.length, 3);
  });

  it("does NOT narrow by insightStatus — that would re-buy every READY row", async () => {
    // The one narrowing that must never be added. Dropping the READY rows makes
    // every document the sweep has already read look owed.
    documents = [doc(1), doc(2)];
    insightRows = [ready(doc(1)), ready(doc(2))];
    const published: string[] = [];

    const outcome = await processFilingInsightSweep(
      { mode: "sweep" },
      { env: ARMED, publish: async (id) => void published.push(id) },
    );

    assert.equal(
      JSON.stringify(insightWheres[0]).includes("insightStatus"),
      false,
      "the insight read narrows by status — the READY rows it drops make " +
        "their documents look never-analysed and get re-bought",
    );
    assert.equal(outcome.owed, 0, "a READY document was re-selected");
    assert.equal(published.length, 0);
    assert.equal(outcome.insightsRead, 2);
  });

  it("chunks the accession list rather than sending one unbounded $in", async () => {
    // Pure-side agreement: the I/O loop issues exactly the chunks the planner
    // computed, so the query size is bounded by a constant and not by the scan.
    const n = INSIGHT_READ_CHUNK + 7;
    documents = Array.from({ length: n }, (_, i) => doc(i));

    await processFilingInsightSweep({ mode: "sweep" }, { env: DISARMED });

    const expected = planInsightReadChunks(documents as never);
    assert.equal(expected.length, 2, "[control] the fixture spans two chunks");
    assert.equal(insightWheres.length, expected.length);
    for (const w of insightWheres) {
      const list = (w as { accession: { in: string[] } }).accession.in;
      assert.ok(
        list.length <= INSIGHT_READ_CHUNK,
        `a chunk carried ${list.length} accessions, over INSIGHT_READ_CHUNK`,
      );
    }
  });

  it("DETECTS a truncated insight read and SUPPRESSES the fan-out", async () => {
    // M6. The failure this whole read was re-shaped for. An unread READY row is
    // indistinguishable from a never-analysed document, so publishing on an
    // incomplete index buys a paid re-reading of documents already read.
    documents = [doc(1), doc(2), doc(3)];
    insightOverflow = SWEEP_SCAN_CAP + 1;
    const published: string[] = [];

    const outcome = await processFilingInsightSweep(
      { mode: "sweep" },
      { env: ARMED, publish: async (id) => void published.push(id) },
    );

    assert.equal(
      outcome.insightScanTruncated,
      true,
      "a truncated insight read was NOT detected — the sweep cannot tell an " +
        "unread READY row from a never-analysed document, and every one of " +
        "them costs a paid model call on every tick",
    );
    assert.equal(
      published.length,
      0,
      "the sweep published on an INCOMPLETE insight index. The fan-out is not " +
        "merely smaller here, it is wrong in the direction that spends money.",
    );
    assert.equal(outcome.ok, false, "a suppressed fan-out reported healthy");
    assert.match(outcome.reason, /NOT PUBLISHING/);
    assert.match(outcome.reason, /SWEEP_SCAN_CAP/);
  });

  it("[control] the SAME run publishes normally when the read is complete", async () => {
    // Without this the suppression case above could pass for any reason at all
    // — a broken fixture, a disarmed flag, an empty cohort.
    documents = [doc(1), doc(2), doc(3)];
    insightOverflow = 0;
    const published: string[] = [];

    const outcome = await processFilingInsightSweep(
      { mode: "sweep" },
      { env: ARMED, publish: async (id) => void published.push(id) },
    );

    assert.equal(outcome.insightScanTruncated, false);
    assert.equal(published.length, 3);
    assert.equal(outcome.ok, true);
  });
});

describe("MONEY-1324 — the truncation tripwire is reachable when DISARMED", () => {
  it("reports a cohort-scan truncation in the shipping (disarmed) state", async () => {
    // M7. `US_FILING_INSIGHT_APPLY` ships "false", so `owed > 0 && published
    // === 0` is the NORMAL state — and the truncation used to live in that
    // ternary's ELSE branch, which the shipping state never reaches. A tripwire
    // that cannot fire in production is not a tripwire.
    const reason = composeSkippedReason({
      owed: 12,
      published: 0,
      reason: 'disarmed (US_FILING_INSIGHT_APPLY is not "true")',
      scanTruncated: true,
      insightScanTruncated: false,
    });
    assert.ok(reason !== undefined);
    assert.match(reason, /disarmed/, "the disarmed reason was dropped");
    assert.match(
      reason,
      /cohort scan hit SWEEP_SCAN_CAP/,
      "the cohort-scan truncation is INVISIBLE while the lane is disarmed — " +
        "which is every tick that has ever run",
    );
  });

  it("reports BOTH truncations at once — composed, never chosen", async () => {
    const reason = composeSkippedReason({
      owed: 12,
      published: 0,
      reason: "disarmed",
      scanTruncated: true,
      insightScanTruncated: true,
    });
    assert.ok(reason !== undefined);
    assert.match(reason, /disarmed/);
    assert.match(reason, /cohort scan hit/);
    assert.match(reason, /insight read hit/);
  });

  it("reports a truncation on a HEALTHY armed tick too", async () => {
    // The other configuration the old ternary got right, kept so the fix is
    // not a swap of which branch is unreachable.
    const reason = composeSkippedReason({
      owed: 12,
      published: 12,
      reason: "published 12 of 12 owed",
      scanTruncated: true,
      insightScanTruncated: false,
    });
    assert.ok(reason !== undefined);
    assert.match(reason, /cohort scan hit SWEEP_SCAN_CAP/);
  });

  it("[control] says NOTHING when there is nothing to say", async () => {
    // A reason string on every healthy tick would be noise, and
    // `skippedReason` is REQUIRED reading precisely because it is rare.
    assert.equal(
      composeSkippedReason({
        owed: 3,
        published: 3,
        reason: "published 3 of 3 owed",
        scanTruncated: false,
        insightScanTruncated: false,
      }),
      undefined,
    );
    assert.equal(
      composeSkippedReason({
        owed: 0,
        published: 0,
        reason: "queue-empty",
        scanTruncated: false,
        insightScanTruncated: false,
      }),
      undefined,
    );
  });

  it("the truncation reaches the LOG, not only the metric", async () => {
    // The tripwire had no log line at all. An operator reading Cloud Logging
    // during an incident sees the log, not the Datadog tag.
    documents = [doc(1), doc(2)];
    insightOverflow = SWEEP_SCAN_CAP + 1;
    const lines: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await processFilingInsightSweep({ mode: "sweep" }, { env: ARMED });
    } finally {
      console.warn = realWarn;
    }
    assert.ok(
      lines.some((l) => /INSIGHT READ TRUNCATED|NOT PUBLISHING/.test(l)),
      `no log line named the truncation. Got: ${JSON.stringify(lines)}`,
    );
  });
});

describe("MONEY-1324 — planInsightReadChunks", () => {
  it("is DISTINCT and ORDERED, so one submission's exhibits cost one lookup", () => {
    const rows = [
      { accession: "B", sequence: 1 },
      { accession: "A", sequence: 1 },
      { accession: "B", sequence: 2 },
      { accession: "A", sequence: 9 },
    ];
    assert.deepEqual(planInsightReadChunks(rows as never, 10), [["A", "B"]]);
  });

  it("yields NO chunk for an empty scan, never one empty chunk", () => {
    // `accession: { in: [] }` matches nothing, so issuing it spends a round
    // trip to learn what the caller already knew.
    assert.deepEqual(planInsightReadChunks([], 10), []);
  });

  it("splits at the chunk size", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      accession: `a${String(i).padStart(3, "0")}`,
      sequence: 1,
    }));
    const chunks = planInsightReadChunks(rows as never, 10);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [10, 10, 5],
    );
    // Every accession appears exactly once — a chunker that drops or repeats
    // one silently loses an insight row, which is the bug one layer down.
    assert.deepEqual(
      chunks.flatMap((c) => [...c]).sort(),
      rows.map((r) => r.accession).sort(),
    );
  });

  it("falls back to the default on a nonsense chunk size", () => {
    const rows = [{ accession: "A", sequence: 1 }];
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(planInsightReadChunks(rows as never, bad), [["A"]]);
    }
  });

  it("skips a row with no accession rather than sending an empty key", () => {
    const rows = [
      { accession: "", sequence: 1 },
      { accession: "A", sequence: 1 },
    ];
    assert.deepEqual(planInsightReadChunks(rows as never, 10), [["A"]]);
  });
});
