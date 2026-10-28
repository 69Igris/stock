/**
 * MONEY-1325 — the outcome metric fires on EVERY exit, proved by RUNNING them.
 *
 * ## Why a behavioural test when a source scan exists
 *
 * `packages/datadog/__tests__/job-outcome-reachability.test.ts` reads
 * `workers/src/processors/*.ts` and works out where a `reportJobOutcome` can
 * execute. It covers all 44 reporting processors, which no behavioural suite
 * will, and it is the ratchet a NEW processor trips.
 *
 * It is still a source scan, and a source scan reasons about text. It cannot
 * see a reporter handed a value the metric then drops, a `finally` that throws
 * before reaching the call, or a dep seam that swaps the reporter for a no-op.
 * So the two layers answer different halves and neither is redundant:
 *
 *     scan         EVERY processor, structurally, cheaply
 *     behaviour    ONE processor, actually, including what it reports
 *
 * MONEY-1324 established the shape on `us-filing-insight` (analysed / skip /
 * failed / refused, three of which go red when the call leaves its `finally`).
 * This generalises it to the OTHER reachable shape in this tree — a processor
 * that does NOT use a `finally`, and instead emits inside each early-exit
 * branch — because that is the shape 32 of the 44 rely on and the one where a
 * missed branch is invisible.
 *
 * ## Why `corporate-actions-sync`
 *
 * It is the only processor whose REPORTER is itself injectable
 * (`deps.reportOutcome ?? reportJobOutcome`), so the emission can be observed
 * directly rather than inferred from a log line — and it has all three exits
 * worth driving:
 *
 *     the ordinary path      rows fetched, rows written
 *     the skip path          nothing from ANY source; the report is inside the
 *                            `if` block, immediately above its own `return`
 *     the throw path         every symbol's upsert failed, so the job throws to
 *                            force a 500 and a Pub/Sub redelivery — AFTER
 *                            reporting, which is the property that a
 *                            block-scoped reading of the source gets wrong
 *
 * That injectable reporter is also why this file is worth having at all: it is
 * exactly the refactor that made the literal `reportJobOutcome(` disappear from
 * the file and silently dropped the job out of the MONEY-1238 scan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  processCorporateActionsSync,
  type CorporateActionsSyncDeps,
} from "../../src/processors/corporate-actions-sync";
import type { InstrumentIsinRow } from "../../src/processors/corporate-actions-sync-logic";

interface Emitted {
  job: string;
  selected: number;
  written: number;
  failed?: number;
  skippedReason?: string;
}

const MAPPINGS: InstrumentIsinRow[] = [
  { symbol: "RELIANCE", exchange: "NSE", isin: "INE002A01018" },
];

/** A minimal bulk-feed row — the shape both `fetchNSE` and `fetchBSE` return. */
function action(symbol: string, exDate: string): Record<string, unknown> {
  return {
    symbol,
    actionType: "DIVIDEND - RS 10 PER SHARE",
    type: "DIVIDEND",
    exDate: new Date(exDate),
    recordDate: null,
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 10,
    details: "DIVIDEND - RS 10 PER SHARE",
    rawData: {},
  };
}

/**
 * Drive the REAL processor, replacing only the network and the database.
 *
 * `upsert` is a parameter rather than a constant so the same harness reaches
 * the throw path: the job's total-failure branch is defined by every symbol's
 * write failing, and there is no other way in.
 */
async function drive(options: {
  nseRows?: Array<Record<string, unknown>>;
  bseRows?: Array<Record<string, unknown>>;
  upsertThrows?: boolean;
}): Promise<{ emitted: Emitted[]; threw: Error | null }> {
  const emitted: Emitted[] = [];
  const deps: CorporateActionsSyncDeps = {
    findInstrumentMappings: async () => MAPPINGS,
    findHeldSymbols: async () => [],
    fetchNSE: (async () => ({
      rows: options.nseRows ?? [],
      failedWindows: [],
    })) as unknown as CorporateActionsSyncDeps["fetchNSE"],
    fetchBSE: (async () => ({
      rows: options.bseRows ?? [],
      failedWindows: [],
    })) as unknown as CorporateActionsSyncDeps["fetchBSE"],
    scrapeScreener: (async () =>
      null) as unknown as CorporateActionsSyncDeps["scrapeScreener"],
    archive: async () => null,
    upsert: (async (rows: unknown[]) => {
      if (options.upsertThrows) throw new Error("mongo unreachable");
      return { created: rows.length, updated: 0, skipped: 0 };
    }) as unknown as CorporateActionsSyncDeps["upsert"],
    reportOutcome: ((o: Emitted) => {
      emitted.push(o);
    }) as unknown as CorporateActionsSyncDeps["reportOutcome"],
    delayBetweenSymbolsMs: 0,
  };

  let threw: Error | null = null;
  try {
    await processCorporateActionsSync({}, deps);
  } catch (err) {
    threw = err instanceof Error ? err : new Error(String(err));
  }
  return { emitted, threw };
}

describe("MONEY-1325 — corp-actions-sync emits on every exit it can take", () => {
  it("emits on the ORDINARY path", async () => {
    const { emitted, threw } = await drive({
      nseRows: [action("RELIANCE", "2026-08-10")],
    });
    assert.equal(threw, null);
    assert.equal(emitted.length, 1, "the ordinary path emitted no metric");
    assert.equal(emitted[0]!.job, "corp-actions-sync");
    assert.equal(emitted[0]!.selected, 1);
    assert.equal(emitted[0]!.written, 1);
  });

  it("emits on the SKIP path — the exit an early `return` is easiest to lose", async () => {
    // MUTATION: move the `report({…})` in the `bulkRows.length === 0` branch
    // BELOW its own `return` -> RED here, and RED in the reachability scan,
    // while `job-outcome-coverage.test.ts` stays green at 16/16 because the
    // call is still present in the file.
    //
    // This is not a rare branch. Three dead upstreams and a genuinely actionless
    // window are indistinguishable from inside this job — the processor's own
    // `skippedReason` says so — and the ONLY thing that separates them from
    // "the job did not run" is that this exit emits.
    const { emitted, threw } = await drive({});
    assert.equal(threw, null);
    assert.equal(
      emitted.length,
      1,
      "a run that fetched nothing from any source emitted NO metric. A " +
        "`notify_no_data` monitor over a series with a hole in it cannot tell " +
        "that from a quiet market.",
    );
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.written, 0);
    assert.match(
      emitted[0]!.skippedReason ?? "",
      /no rows from ANY source/,
      "0 written with no reason is exactly the silence this metric replaces",
    );
  });

  it("emits BEFORE the total-failure THROW, not after it", async () => {
    // The job deliberately throws when every symbol's write failed, so the
    // route 500s and Pub/Sub redelivers. That is the right design AND it is an
    // exit: if the report sat below the throw, the one run that most needs a
    // metric would be the one run that emits none.
    //
    // A source scan reading "is there a call inside this `if` block" gets this
    // backwards and calls the correct code silent. The check is DOMINANCE — a
    // call at function level has already run — and this is the case that pins
    // it against a real processor rather than a fixture.
    const { emitted, threw } = await drive({
      nseRows: [action("RELIANCE", "2026-08-10")],
      upsertThrows: true,
    });
    assert.ok(threw, "every symbol failing must still throw");
    assert.match(threw!.message, /persisted NOTHING/);
    assert.equal(
      emitted.length,
      1,
      "the run threw having emitted nothing — the metric is below the throw",
    );
    assert.equal(emitted[0]!.selected, 1);
    assert.equal(emitted[0]!.written, 0, "nothing was persisted");
    assert.equal(emitted[0]!.failed, 1);
  });

  it("[meta] the three exits are genuinely DIFFERENT paths", async () => {
    // Without this the three cases above could all be driving the same branch
    // through different fixtures — a shape this repo has shipped before, where
    // three assertions passed against one code path.
    const ordinary = await drive({
      nseRows: [action("RELIANCE", "2026-08-10")],
    });
    const skip = await drive({});
    const failed = await drive({
      nseRows: [action("RELIANCE", "2026-08-10")],
      upsertThrows: true,
    });

    assert.equal(ordinary.threw, null);
    assert.equal(skip.threw, null);
    assert.ok(failed.threw, "only the failure path throws");

    const shape = (e: Emitted): string =>
      `${e.selected}/${e.written}/${e.failed ?? 0}/${e.skippedReason ? "reason" : "none"}`;
    const shapes = [
      shape(ordinary.emitted[0]!),
      shape(skip.emitted[0]!),
      shape(failed.emitted[0]!),
    ];
    assert.equal(
      new Set(shapes).size,
      3,
      `the three exits reported indistinguishable outcomes (${shapes.join(", ")}) ` +
        `— a metric that cannot separate an idle run from a total write ` +
        `failure is the silence this ticket is about, one layer in`,
    );
  });
});

/* ==========================================================================
 * MONEY-1328 — the four processors MONEY-1325 baselined, driven down the
 * exits that used to emit nothing.
 *
 * Each block below drives the REAL processor through an injected reporter and
 * asserts what reaches the metric. The mutation for every one of them is the
 * same and is worth stating once: put the emission back BELOW the early return
 * it now precedes (or, for the two whose return was DELETED, put the return
 * back) and the "emits on the ..." case goes RED here — while
 * `job-outcome-coverage.test.ts` stays green, because the call is still in the
 * file. That gap is the entire reason this layer exists.
 *
 * Where a processor's ordinary path needs Prisma or GCS the seams stop short of
 * it deliberately, and the block says which exits it therefore reaches. A seam
 * wide enough to fake the write would be testing the fake.
 * ========================================================================== */

import { processCircularsSync } from "../../src/processors/circulars-sync";
import { processInstitutionalFlowSync } from "../../src/processors/institutional-flow-sync";
import { processNseAnnouncementsSync } from "../../src/processors/nse-announcements-sync";
import { processStockDocumentEmbed } from "../../src/processors/stock-document-embed";

/** Collect emissions without asserting on the console. */
function collector(): { emitted: Emitted[]; report: (o: Emitted) => void } {
  const emitted: Emitted[] = [];
  return {
    emitted,
    report: (o: Emitted) => {
      emitted.push(o);
    },
  };
}

/** Silence a processor's own logging for the duration of one call. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

/** `selected/written/failed/transport/reason?` — one string per exit shape. */
const shapeOf = (e: Emitted): string =>
  `${e.selected}/${e.written}/${e.failed ?? 0}/` +
  `${(e as { transportFailures?: number }).transportFailures ?? 0}/` +
  `${e.skippedReason ? "reason" : "none"}`;

/* -------------------------------------------------------------------------- */

describe("MONEY-1328 — circulars-sync emits on both refusal exits", () => {
  const window = { from: new Date("2026-08-01"), to: new Date("2026-08-15") };
  const good = (n: string) => ({
    circNumber: n,
    cirDate: "20260810",
    sub: `Subject ${n}`,
    circDepartment: "Listing",
    circCategory: "Compliance",
  });

  it("emits when the FETCH returns null", async () => {
    // The exit MONEY-1325 baselined. `fetchNseApiJson` maps a throttle, an NSE
    // challenge page and a transport error all to null, so before this the
    // fortnight NSE blocked us produced the same (absent) Datadog series as a
    // fortnight the scheduler never fired.
    const { emitted, report } = collector();
    const r = await quietly(() =>
      processCircularsSync(window, {
        fetchJson: async () => null,
        write: async () => {
          throw new Error("must not write on a null fetch");
        },
        reportOutcome: report as never,
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(emitted.length, 1, "a blocked fetch emitted NO metric");
    assert.equal(emitted[0]!.job, "circulars-sync");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(
      (emitted[0] as { transportFailures?: number }).transportFailures,
      1,
      "a blocked upstream is a TRANSPORT failure, not a row we could not " +
        "persist — that is the whole point of the separate counter",
    );
    assert.match(emitted[0]!.skippedReason ?? "", /transport error/);
  });

  it("emits when the response SHAPE is unrecognised", async () => {
    // The second baselined exit, and a DIFFERENT claim: NSE answered, and we
    // could not read what it said. No transport failure — the call succeeded.
    const { emitted, report } = collector();
    const r = await quietly(() =>
      processCircularsSync(window, {
        fetchJson: async () => ({ circulars: [] }),
        write: async () => {
          throw new Error("must not write on an unrecognised shape");
        },
        reportOutcome: report as never,
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(emitted.length, 1, "an unreadable payload emitted NO metric");
    assert.equal(
      (emitted[0] as { transportFailures?: number }).transportFailures ?? 0,
      0,
      "the fetch SUCCEEDED — counting it as a transport failure would blame " +
        "the network for a payload change",
    );
    assert.match(emitted[0]!.skippedReason ?? "", /UNRECOGNISED/);
  });

  it("[meta] all four exits emit, and no two report the same shape", async () => {
    // Without this the cases above could be three fixtures driving one branch.
    // The two exits that already emitted (EMPTY, TOTAL PARSE FAILURE) are
    // included so the file is judged whole rather than at the two lines that
    // changed.
    const drive = async (payload: unknown) => {
      const { emitted, report } = collector();
      await quietly(() =>
        processCircularsSync(window, {
          fetchJson: async () => payload,
          write: async (rows) => rows.length,
          reportOutcome: report as never,
        }),
      );
      return emitted;
    };
    const runs = {
      fetchNull: await drive(null),
      badShape: await drive({ circulars: [] }),
      empty: await drive({ data: [] }),
      ordinary: await drive({ data: [good("70001"), good("70002")] }),
    };
    for (const [name, emitted] of Object.entries(runs)) {
      assert.equal(emitted.length, 1, `${name} emitted ${emitted.length}`);
    }
    assert.equal(runs.ordinary[0]!.selected, 2);
    assert.equal(runs.ordinary[0]!.written, 2);
    const shapes = Object.values(runs).map((e) => shapeOf(e[0]!));
    assert.equal(
      new Set(shapes).size,
      4,
      `two exits reported indistinguishable outcomes (${shapes.join(", ")})`,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("MONEY-1328 — institutional-flow-sync emits from a `finally`", () => {
  const flowRow = (category: string) => ({
    date: "05-Aug-2026",
    category,
    buyValue: "12000.50",
    sellValue: "9000.25",
    netValue: "3000.25",
  });

  const drive = async (opts: {
    payload?: unknown;
    writeThrows?: boolean;
  }): Promise<{ emitted: Emitted[]; threw: Error | null }> => {
    const { emitted, report } = collector();
    let threw: Error | null = null;
    await quietly(async () => {
      try {
        await processInstitutionalFlowSync({
          fetchJson: async () => opts.payload ?? null,
          write: async (rows) => {
            if (opts.writeThrows) throw new Error("mongo unreachable");
            return rows.length;
          },
          reportOutcome: report as never,
        });
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
      }
    });
    return { emitted, threw };
  };

  it("emits when the FETCH returns null", async () => {
    // THE exit that matters most in this directory. The endpoint takes no date
    // parameter and serves only the current reading, so a day this job goes
    // silent never enters the record and nothing afterwards can recover it.
    const { emitted } = await drive({ payload: null });
    assert.equal(emitted.length, 1, "a blocked fetch emitted NO metric");
    assert.equal(emitted[0]!.job, "institutional-flow-sync");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(
      (emitted[0] as { transportFailures?: number }).transportFailures,
      1,
    );
    assert.match(emitted[0]!.skippedReason ?? "", /transport error/);
  });

  it("emits when a 200 parses to ZERO rows", async () => {
    // A real trading day always carries both categories, and the scheduler
    // already skips weekends — so zero rows from a 200 is a payload change, not
    // a holiday. The metric has to be able to SAY that.
    const { emitted } = await drive({ payload: { data: [] } });
    assert.equal(emitted.length, 1, "a zero-row parse emitted NO metric");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(
      (emitted[0] as { transportFailures?: number }).transportFailures ?? 0,
      0,
      "NSE answered — this is not a transport failure",
    );
    assert.match(emitted[0]!.skippedReason ?? "", /ZERO rows/);
  });

  it("emits BEFORE a write that throws, because the report is in a `finally`", async () => {
    // The property `finally` buys over a per-branch emit, and the reason this
    // job got the stronger shape: an exception on the Mongo upsert is exactly
    // the run whose absence from the series is least recoverable.
    const { emitted, threw } = await drive({
      payload: [flowRow("FII/FPI *"), flowRow("DII **")],
      writeThrows: true,
    });
    assert.ok(threw, "a failing write must still propagate");
    assert.equal(
      emitted.length,
      1,
      "the run threw having emitted nothing — the report is not in a `finally`",
    );
    assert.equal(emitted[0]!.written, 0, "nothing was persisted");
  });

  it("[meta] the three exits are genuinely DIFFERENT paths", async () => {
    const ordinary = await drive({
      payload: [flowRow("FII/FPI *"), flowRow("DII **")],
    });
    const fetchNull = await drive({ payload: null });
    const zeroRows = await drive({ payload: { data: [] } });
    assert.equal(ordinary.threw, null);
    assert.equal(ordinary.emitted[0]!.written, 2, "both categories written");
    const shapes = [ordinary, fetchNull, zeroRows].map((r) =>
      shapeOf(r.emitted[0]!),
    );
    assert.equal(
      new Set(shapes).size,
      3,
      `the three exits reported indistinguishable outcomes (${shapes.join(", ")})`,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("MONEY-1328 — nse-announcements-sync emits on an EMPTY window", () => {
  /**
   * The seam is `fetchJson` alone, and that is enough for three exits: a row
   * that classifies as noise and a row with no attachment both `continue`
   * before the first Prisma call, so the ordinary fall-through is reachable
   * with no database. The STORE path is not driven here — a seam wide enough to
   * fake the upsert, the GCS write and the dedupe read would be testing the
   * fake.
   */
  const drive = async (
    payload: unknown,
  ): Promise<{ emitted: Emitted[]; threw: Error | null }> => {
    const { emitted, report } = collector();
    let threw: Error | null = null;
    await quietly(async () => {
      try {
        await processNseAnnouncementsSync(
          {},
          { fetchJson: async () => payload, reportOutcome: report as never },
        );
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
      }
    });
    return { emitted, threw };
  };

  const row = (over: Record<string, unknown> = {}) => ({
    symbol: "RELIANCE",
    desc: "Annual Report",
    attchmntText: "Annual Report FY2026",
    seq_id: 987654,
    sm_name: "Reliance Industries Limited",
    an_dt: "05-Aug-2026 18:14:59",
    ...over,
  });

  it("emits when the window is EMPTY — the exit that was deleted", async () => {
    // `if (rows.length === 0) return;` used to sit ~215 lines above the only
    // report in the file. MONEY-1328 removed the return rather than adding a
    // second report site, so an empty window now falls through to the one
    // emission that already knows how to describe this run.
    //
    // MUTATION: restore `if (rows.length === 0) return;` after the parse ->
    // RED here, and RED in the reachability scan, while the coverage scan stays
    // green.
    const { emitted, threw } = await drive([]);
    assert.equal(threw, null, "an empty window is not an error");
    assert.equal(
      emitted.length,
      1,
      "an empty NSE window emitted NO metric. 0/0 is the `genuinely idle` row " +
        "of the monitor's truth table; emitting nothing is a hole in the " +
        "series that no query can tell from a quiet market.",
    );
    assert.equal(emitted[0]!.job, "nse-announcements-sync");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.written, 0);
  });

  it("emits on the ordinary path, counting INGESTIBLE rows as selected", async () => {
    // `selected` is what survived noise-dropping and was MEANT to land — not
    // the raw row count. One classifiable row with no attachment plus one row
    // the classifier refuses: selected 1, written 0.
    const { emitted } = await drive([
      row(),
      row({ desc: "Trading Window Closure", attchmntText: "Closure notice" }),
    ]);
    assert.equal(emitted.length, 1);
    assert.equal(
      emitted[0]!.selected,
      1,
      "the noise row must not be counted as selected — it was never a candidate",
    );
    assert.equal(emitted[0]!.written, 0);
  });

  it("a null FETCH still THROWS, and is deliberately NOT given a metric", async () => {
    // Pinned so the posture is a decision rather than an oversight. NSE's
    // announcement archive thins out, so a lost evening is not recoverable by
    // waiting — the job throws, the route 500s, Pub/Sub redelivers, and after
    // five attempts the dead-letter consumer notifies a human. MONEY-1325
    // COUNTS an unguarded throw and never fails it, for exactly this: a throw
    // is loud through four channels, and a silent `return` is loud through
    // none. Do not "fix" this into a `finally` without moving the retry posture
    // with it.
    const { emitted, threw } = await drive(null);
    assert.ok(threw, "a null fetch must throw so the route 500s");
    assert.match(threw!.message, /returned nothing/);
    assert.equal(emitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */

describe("MONEY-1328 — stock-document-embed emits on an idle night", () => {
  const doc = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "65f0000000000000000000aa",
    symbol: "RELIANCE",
    docType: "annual_report",
    period: "2026",
    title: "Annual Report",
    textContent: "Revenue grew. ".repeat(40),
    gcsPath: "stocks/RELIANCE/annual_report/2026.pdf",
    mimeType: "text/plain",
    sourceUrl: null,
    ...over,
  });

  const drive = async (opts: {
    documents: ReturnType<typeof doc>[];
    embedFails?: boolean;
  }): Promise<{ emitted: Emitted[]; threw: Error | null }> => {
    const { emitted, report } = collector();
    let threw: Error | null = null;
    await quietly(async () => {
      try {
        await processStockDocumentEmbed(
          {},
          {
            findDocuments: async () => opts.documents as never,
            generateEmbeddings: (async (texts: string[]) => ({
              embeddings: [],
              failedIndices: opts.embedFails
                ? texts.map((_, i) => i)
                : ([] as number[]),
            })) as never,
            reportOutcome: report as never,
            delayBetweenDocumentsMs: 0,
          },
        );
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
      }
    });
    return { emitted, threw };
  };

  it("emits when the QUEUE IS EMPTY — the exit that was deleted", async () => {
    // The sibling of the job MONEY-1255 fixed for this exact shape. An idle
    // night is the ORDINARY state of a drained queue, and it used to emit
    // nothing at all — so a `notify_no_data` monitor read healthy precisely
    // when the job was doing nothing.
    //
    // MUTATION: restore `if (documents.length === 0) { return; }` after the
    // query -> RED here, green in `job-outcome-coverage.test.ts`.
    const { emitted, threw } = await drive({ documents: [] });
    assert.equal(threw, null, "an empty queue is not an error");
    assert.equal(emitted.length, 1, "an idle night emitted NO metric");
    assert.equal(emitted[0]!.job, "stock-document-embed");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(
      emitted[0]!.skippedReason,
      undefined,
      "0/0 with no reason IS the healthy idle shape here — the reason field is " +
        "reserved for `selected > 0 && written === 0`",
    );
  });

  it("a batch of TOO-SHORT documents also reports selected 0", async () => {
    // Not the same code path as an empty queue, and it must not report as a
    // failure: a document under the 50-char floor was never a write candidate,
    // so `selected` stays 0 and the zero-write rule cannot alarm.
    const { emitted, threw } = await drive({
      documents: [doc({ textContent: "too short" })],
    });
    assert.equal(threw, null);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(emitted[0]!.failed ?? 0, 0);
  });

  it("emits BEFORE the backend-refused-everything THROW", async () => {
    // The revoked-key / exhausted-quota shape: every document chunked fine and
    // the embedding call stored nothing. It throws so Pub/Sub redelivers — and
    // the run that most needs a metric must not be the one that emits none.
    const { emitted, threw } = await drive({
      documents: [doc()],
      embedFails: true,
    });
    assert.ok(threw, "a total embedding refusal must still throw");
    assert.match(threw!.message, /stored ZERO embeddings/);
    assert.equal(
      emitted.length,
      1,
      "the run threw having emitted nothing — the report is below the throw",
    );
    assert.equal(emitted[0]!.selected, 1, "the document WAS attempted");
    assert.equal(emitted[0]!.written, 0);
    assert.equal(emitted[0]!.failed, 1);
    assert.match(
      emitted[0]!.skippedReason ?? "",
      /chunked-but-stored-nothing/,
      "`selected > 0 && written === 0` without a reason is the silence this " +
        "metric replaces",
    );
  });

  it("[meta] the three exits are genuinely DIFFERENT paths", async () => {
    const idle = await drive({ documents: [] });
    const short = await drive({
      documents: [doc({ textContent: "too short" })],
    });
    const refused = await drive({ documents: [doc()], embedFails: true });
    assert.equal(idle.threw, null);
    assert.equal(short.threw, null);
    assert.ok(refused.threw, "only the backend-refusal path throws");
    // `idle` and `short` deliberately report the SAME 0/0 — both are honestly
    // "nothing was a candidate" — so the discriminator is the throw plus the
    // reason, not the counters alone.
    assert.notEqual(shapeOf(idle.emitted[0]!), shapeOf(refused.emitted[0]!));
    assert.equal(shapeOf(idle.emitted[0]!), shapeOf(short.emitted[0]!));
  });
});
