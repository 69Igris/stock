/**
 * FUNCTIONAL TEST — the `xbrl-sync` WRITE path (MONEY-1114).
 *
 * ## What only a functional test can prove here
 *
 * The highest-consequence decision in `xbrl-sync.ts` is an ABSENCE: the index's
 * `period` word must NOT reach the stored row. That cannot be expressed as a
 * pure function — a function that takes an argument and ignores it reads as
 * dead code and gets deleted. So Prisma is injected and the actual upsert
 * payload is asserted.
 *
 * ## The bug this exists to stop
 *
 * NSE lists the SAME March-quarter document under BOTH `period=Quarterly` and
 * `period=Annual` — 1,379 of 1,491 annual URLs in May-2019 are also quarterly
 * URLs. So an index entry arriving from the Annual page carries
 * `periodType: "ANNUAL"` and `cumulative: true`, while the document it points
 * at has the January-March QUARTER as its primary period.
 *
 * Before MONEY-1114 `storeFiling` read `entry.periodType ?? inferPeriodType(…)`.
 * That was harmless only while the job never asked for `period=Annual`. The
 * moment it does — which is the whole point of this ticket — three months of
 * revenue gets written as the financial year, under a unique key
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)` that makes it
 * the incumbent for FY2019. Nothing errors. Every counter reads normally.
 *
 * The XML is the REAL RELIANCE Q4-FY19 consolidated filing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FilingIndexEntry } from "@usemoney/core/market-data";
import {
  storeFiling,
  storeAnnualCompanion,
  reparseStoredFiling,
  entryFromStoredFiling,
  emptyXbrlSyncResult,
  downloadOrder,
  type XbrlStoreDeps,
  type StoredFilingRef,
} from "../../src/processors/xbrl-sync";
import {
  parseXbrlDocument,
  parseFilingIndexPage,
} from "@usemoney/core/market-data";
import { orderFilingsForWrite } from "../../src/processors/xbrl-sync-logic";

const XML = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "core",
    "__tests__",
    "fixtures",
    "xbrl",
    "reliance-q4fy19-consolidated-indas-2018-03-31.xml",
  ),
  "utf-8",
);

interface Upsert {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function fakeDb(): { deps: XbrlStoreDeps; upserts: Upsert[] } {
  const upserts: Upsert[] = [];
  return {
    upserts,
    deps: {
      instrumentMapping: { findFirst: async () => null },
      xbrlFiling: {
        upsert: async (args: unknown) => {
          upserts.push(args as Upsert);
          return {};
        },
      },
    },
  };
}

/** An index entry as the ANNUAL page serves it — the dangerous one. */
function annualPageEntry(): FilingIndexEntry {
  return {
    era: "legacy",
    symbol: "RELIANCE",
    isin: "INE002A01018",
    xbrlUrl:
      "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_43586_97155_19042019114014_WEB.xml",
    ixbrlUrl: null,
    // NSE's own words for this listing of the document.
    basis: "CONSOLIDATED",
    audited: true,
    cumulative: true,
    periodType: "ANNUAL",
    filerKind: "GENERIC",
    quarterEnd: new Date(Date.UTC(2019, 2, 31)),
    broadcastAt: new Date(Date.UTC(2019, 3, 19, 11, 40)),
    companyName: "Reliance Industries Limited",
    // MONEY-1235 — a LEGACY listing states none of the revision metadata. See
    // `parseRevisionKind`: the legacy index's `reInd` lookalike is a 1:1
    // restatement of `indAs` (the accounting regime) across all 92 legacy
    // fixture records, so it is deliberately not read as one.
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: 1_059_015,
  };
}

function financials() {
  const outcome = parseXbrlDocument(XML);
  assert.equal(outcome.kind, "financials");
  if (outcome.kind !== "financials") throw new Error("unreachable");
  return outcome.financials;
}

describe("storeFiling — the DOCUMENT decides the period, not the index", () => {
  it("stores a Q4 document as QUARTERLY even when the index says ANNUAL", async () => {
    const db = fakeDb();
    const result = await storeFiling(annualPageEntry(), financials(), db.deps);
    assert.equal(result, "written");
    assert.equal(db.upserts.length, 1);

    const { create, where } = db.upserts[0]!;
    assert.equal(
      create.periodType,
      "QUARTERLY",
      "the document's primary period is the Jan-Mar quarter",
    );
    assert.equal(
      create.periodStart instanceof Date &&
        (create.periodStart as Date).toISOString().slice(0, 10),
      "2019-01-01",
    );
    assert.equal(
      (create.periodEnd as Date).toISOString().slice(0, 10),
      "2019-03-31",
    );
    // NSE flagged this listing "Cumulative". The stored row must not be.
    assert.equal(create.cumulative, false);

    // …and the KEY must agree with the payload, or the upsert writes one row
    // and matches another.
    const key = where.symbol_exchange_periodEnd_periodType_basis_cumulative as
      | Record<string, unknown>
      | undefined;
    assert.ok(key, "the composite key must be present");
    assert.equal(key.periodType, "QUARTERLY");
    assert.equal(key.cumulative, false);
  });

  it("stores the quarter's revenue, not the year's", async () => {
    const db = fakeDb();
    await storeFiling(annualPageEntry(), financials(), db.deps);
    const facts = db.upserts[0]!.create.facts as {
      values: Record<string, number>;
    };
    // ₹1,41,634 Cr for the quarter — NOT the ₹5,81,020 Cr financial year.
    assert.equal(facts.values.revenueFromOperations, 1_416_340_000_000);
  });

  it("REFUSES a span that matches no period band", async () => {
    const db = fakeDb();
    const fin = financials();
    const mangled = {
      ...fin,
      // A 14-month transition year. The old ladder made this ANNUAL.
      period: { ...fin.period, days: 425 },
    };
    const result = await storeFiling(annualPageEntry(), mangled, db.deps);
    assert.equal(result, "unclassified");
    assert.equal(db.upserts.length, 0, "nothing may be written");
  });
});

describe("storeAnnualCompanion — the second row, from the same bytes", () => {
  it("writes an ANNUAL row with the FULL YEAR's figures", async () => {
    const db = fakeDb();
    const out = emptyXbrlSyncResult({ from: "01-04-2019", to: "30-04-2019" });
    await storeAnnualCompanion(
      annualPageEntry(),
      financials(),
      XML,
      out,
      db.deps,
    );

    assert.equal(out.writtenAnnual, 1);
    assert.equal(out.annualAmbiguous, 0);
    assert.equal(out.annualUnreadable, 0);
    assert.equal(db.upserts.length, 1);

    const create = db.upserts[0]!.create;
    assert.equal(create.periodType, "ANNUAL");
    // A full financial year IS the period its row claims, so NOT cumulative —
    // even though NSE's own flag on this listing says "Cumulative". One rule,
    // in `classifyFilingPeriod`, or the two write legs produce two annual rows
    // per company-year differing only in this boolean.
    assert.equal(create.cumulative, false);
    assert.equal(
      (create.periodStart as Date).toISOString().slice(0, 10),
      "2018-04-01",
    );
    assert.equal(
      (create.periodEnd as Date).toISOString().slice(0, 10),
      "2019-03-31",
    );

    const facts = create.facts as { values: Record<string, number> };
    // The published FY2019 consolidated revenue: ₹5,81,020 crore.
    assert.equal(facts.values.revenueFromOperations, 5_810_200_000_000);
  });

  it("produces a row that CANNOT collide with the quarterly one", async () => {
    // Both rows share (symbol, exchange, periodEnd, basis). Only `periodType`
    // separates them, which is why it must be derived the same way on both
    // legs — and why they must genuinely differ.
    const quarterDb = fakeDb();
    await storeFiling(annualPageEntry(), financials(), quarterDb.deps);
    const annualDb = fakeDb();
    await storeAnnualCompanion(
      annualPageEntry(),
      financials(),
      XML,
      emptyXbrlSyncResult({ from: "", to: "" }),
      annualDb.deps,
    );

    const qKey = quarterDb.upserts[0]!.where
      .symbol_exchange_periodEnd_periodType_basis_cumulative as Record<
      string,
      unknown
    >;
    const aKey = annualDb.upserts[0]!.where
      .symbol_exchange_periodEnd_periodType_basis_cumulative as Record<
      string,
      unknown
    >;
    assert.equal(qKey.symbol, aKey.symbol);
    assert.equal(
      (qKey.periodEnd as Date).getTime(),
      (aKey.periodEnd as Date).getTime(),
      "same period END — that is the whole reason the key needs periodType",
    );
    assert.notDeepEqual(qKey, aKey, "the two keys must be distinct");
  });

  it("writes NOTHING when the document has no full-year context", async () => {
    const db = fakeDb();
    const out = emptyXbrlSyncResult({ from: "", to: "" });
    const fin = financials();
    // A Q1 filing: the year-to-date column IS the quarter, so there is no
    // second period. This is 2,127 of the 2,152 rows in prod.
    await storeAnnualCompanion(
      annualPageEntry(),
      { ...fin, otherPeriods: [] },
      XML,
      out,
      db.deps,
    );
    assert.equal(db.upserts.length, 0);
    assert.equal(out.writtenAnnual, 0);
    // …and it is NOT counted as a failure. Treating "no annual column" as an
    // error would report a 99% failure rate on a healthy table.
    assert.equal(out.annualUnreadable, 0);
    assert.equal(out.annualAmbiguous, 0);
  });

  it("REFUSES rather than substituting when the year's context is unknown", async () => {
    // The safety property `parseXbrlDocument`'s selector provides, exercised
    // end to end: `otherPeriods` claims a 364-day period at a contextRef the
    // document does not declare as a resolvable period. The re-parse must fail
    // closed, not fall back to the quarter and write it as ANNUAL.
    const db = fakeDb();
    const out = emptyXbrlSyncResult({ from: "", to: "" });
    const fin = financials();
    await storeAnnualCompanion(
      annualPageEntry(),
      {
        ...fin,
        otherPeriods: [
          {
            start: "2018-04-01",
            end: "2019-03-31",
            days: 364,
            contextRef: "NotADeclaredPeriod",
            source: "reported-facts",
          },
        ],
      },
      XML,
      out,
      db.deps,
    );
    assert.equal(db.upserts.length, 0, "no row may be written");
    assert.equal(out.writtenAnnual, 0);
    assert.equal(out.annualUnreadable, 1, "and the refusal must be COUNTED");
  });

  it("REFUSES when two full-year contexts exist", async () => {
    const db = fakeDb();
    const out = emptyXbrlSyncResult({ from: "", to: "" });
    const fin = financials();
    await storeAnnualCompanion(
      annualPageEntry(),
      {
        ...fin,
        otherPeriods: [
          ...fin.otherPeriods,
          {
            start: "2017-04-01",
            end: "2018-03-31",
            days: 364,
            contextRef: "FivePriorD",
            source: "reported-facts",
          },
        ],
      },
      XML,
      out,
      db.deps,
    );
    assert.equal(db.upserts.length, 0);
    assert.equal(out.annualAmbiguous, 1);
    assert.equal(out.writtenAnnual, 0);
  });
});

/* ═════════════════════════════════════════════════════════════════════════ */
/* MONEY-1235 — the Revision must win, and it must reach the projection.     */
/* ═════════════════════════════════════════════════════════════════════════ */

/**
 * The SALSTEEL Original/Revision pair, parsed out of the REAL index capture.
 *
 * Not hand-built. The whole defect is a fact about the exact records NSE
 * serves — the Revision at index 8 with `broadcast_Date: null` and a NEW url,
 * its Original at index 9 — and a synthetic pair would let the fixture drift
 * out from under this file without a single test going red.
 * `xbrl-filing-index.test.ts` pins the raw bytes; this consumes them.
 */
const INDEX_CAPTURE: unknown = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "core",
      "__tests__",
      "fixtures",
      "xbrl-index",
      "integrated-capped-20.sample.json",
    ),
    "utf-8",
  ),
) as unknown;

/** `[Revision, Original]` — the order the index actually returns them in. */
function salsteelInIndexOrder(): FilingIndexEntry[] {
  const page = parseFilingIndexPage(INDEX_CAPTURE, "integrated");
  assert.ok(page !== null, "the capture must parse");
  const pair = page.entries.filter((e) => e.symbol === "SALSTEEL");
  assert.equal(pair.length, 2, "the fixture must still hold BOTH siblings");
  assert.equal(
    pair[0]!.revisionKind,
    "REVISION",
    "index order is newest-first: the Revision comes FIRST",
  );
  assert.equal(pair[1]!.revisionKind, "ORIGINAL");
  return pair;
}

/** Revenue the CORRECTED filing reports. */
const REVISED_REVENUE = 9_876_500_000;
/** …and what the superseded Original said. Storing this is the bug. */
const SUPERSEDED_REVENUE = 1_234_500_000;

/**
 * Stand in for "what the XML at this url parses to".
 *
 * The two siblings are two different documents; we hold only one real XBRL
 * fixture, so the same parsed document is re-stamped with a distinguishable
 * revenue per url. What is under test is WHICH facts end up in the row, not
 * how they were extracted — that is `xbrl-financials-logic`'s test.
 */
function factsFor(entry: FilingIndexEntry) {
  const fin = financials();
  return {
    ...fin,
    // The document's basis, echoed from the listing, so two GENUINELY different
    // filings (a company's consolidated and standalone results for one quarter)
    // land on two rows the way they do in production. Without this every entry
    // in the capture would collide on one key and the no-sibling guard below
    // would be asserting an artefact of the harness.
    basis:
      entry.basis === "CONSOLIDATED"
        ? ("consolidated" as const)
        : ("standalone" as const),
    values: {
      ...fin.values,
      revenueFromOperations:
        entry.revisionKind === "REVISION"
          ? REVISED_REVENUE
          : SUPERSEDED_REVENUE,
    },
  };
}

interface StoredRow extends Record<string, unknown> {
  symbol: string;
  exchange: string;
  sourceUrl: string;
}

/**
 * A fake `xbrlFiling` that honours the UNIQUE KEY.
 *
 * The plain `fakeDb()` above records upserts and stores nothing, which is right
 * for asserting a payload and useless for asserting WHO WINS. The property here
 * is only visible across two writes that collide on
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)`, so this
 * models Prisma's documented upsert: match the composite key, then `update` the
 * matched row or `create` a new one.
 *
 * It models the DATABASE, not the processor. The decisions under test —
 * `orderFilingsForWrite` and `storeFiling` — are the real production functions,
 * and the source-shape assertions in `xbrl-sync-logic.test.ts` pin that
 * `processXbrlSync` actually calls the first one.
 */
function keyedStore(): {
  deps: XbrlStoreDeps;
  upserts: Upsert[];
  rows: Map<string, StoredRow>;
  findBySourceUrl: (symbol: string, sourceUrl: string) => StoredRow | undefined;
} {
  const upserts: Upsert[] = [];
  const rows = new Map<string, StoredRow>();

  const keyOf = (where: Record<string, unknown>): string => {
    const k = where.symbol_exchange_periodEnd_periodType_basis_cumulative as
      | Record<string, unknown>
      | undefined;
    assert.ok(k, "storeFiling must upsert on the composite unique key");
    return [
      k.symbol,
      k.exchange,
      (k.periodEnd as Date).toISOString(),
      k.periodType,
      k.basis,
      k.cumulative,
    ].join("|");
  };

  return {
    upserts,
    rows,
    findBySourceUrl: (symbol, sourceUrl) =>
      [...rows.values()].find(
        (r) =>
          r.symbol === symbol &&
          r.exchange === "NSE" &&
          r.sourceUrl === sourceUrl,
      ),
    deps: {
      instrumentMapping: { findFirst: async () => null },
      xbrlFiling: {
        upsert: async (args: unknown) => {
          const a = args as Upsert;
          upserts.push(a);
          const key = keyOf(a.where);
          const existing = rows.get(key);
          // Prisma's semantics, verbatim: `update` REPLACES every key it names
          // and leaves every key it does not. That is exactly why omitting
          // `filedAt` is how "keep the incumbent" has to be expressed.
          rows.set(
            key,
            existing
              ? ({ ...existing, ...a.update } as StoredRow)
              : ({ ...a.create } as StoredRow),
          );
          return {};
        },
      },
    },
  };
}

/**
 * One `processXbrlSync` download pass, reduced to the two decisions that matter.
 *
 * The ORDER comes from the real `orderFilingsForWrite`; the WRITE from the real
 * `storeFiling`. The pre-download skip is reproduced because the flip-flop only
 * shows up on the SECOND pass, and it is the loop's own
 * `findFirst({symbol, exchange, sourceUrl})` — one indexed query, asserted
 * against the real source text in `xbrl-sync-logic.test.ts`.
 */
async function downloadPass(
  store: ReturnType<typeof keyedStore>,
  entriesAsIndexReturnedThem: FilingIndexEntry[],
): Promise<{ downloaded: number; skipped: number }> {
  let downloaded = 0;
  let skipped = 0;
  for (const entry of orderFilingsForWrite(entriesAsIndexReturnedThem)) {
    if (store.findBySourceUrl(entry.symbol, entry.xbrlUrl)) {
      skipped++;
      continue;
    }
    downloaded++;
    const result = await storeFiling(entry, factsFor(entry), store.deps);
    assert.equal(result, "written", `${entry.xbrlUrl} must be written`);
  }
  return { downloaded, skipped };
}

const revenueOf = (row: StoredRow): number =>
  (row.facts as { values: Record<string, number> }).values
    .revenueFromOperations;

describe("MONEY-1235 — for one unique key, the NEWEST filing wins", () => {
  it("the Revision survives a pass even though the index served it FIRST", async () => {
    // The defect, end to end. Both siblings describe SALSTEEL's 31-DEC-2025
    // standalone period, so both land on ONE row; the pre-download skip is
    // keyed on `sourceUrl`, which differs, so BOTH are downloaded. Whichever is
    // upserted last wins — and the modern index is newest-first, so "last" used
    // to be the superseded Original.
    const store = keyedStore();
    const pair = salsteelInIndexOrder();

    const { downloaded } = await downloadPass(store, pair);
    assert.equal(downloaded, 2, "the sourceUrl skip cannot catch a sibling");
    assert.equal(store.rows.size, 1, "…and they collide on ONE row");

    const row = [...store.rows.values()][0]!;
    assert.equal(
      revenueOf(row),
      REVISED_REVENUE,
      "the row must hold the REVISION's facts, not the Original's",
    );
    assert.equal(
      row.sourceUrl,
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1626321_14022026112433_WEB.xml",
      "…and its provenance must point at the Revision's document",
    );
  });

  it("the same pair in the OPPOSITE order lands the same row", async () => {
    // The invariant stated as a property rather than as a case: the outcome
    // must not depend on the order the index chose. Without this, "sort the
    // array" and "reverse the array" are indistinguishable — and reversing is
    // NOT a fix, because the real capture is not monotonic (indices 13/14 are
    // ascending inside an otherwise descending list).
    const store = keyedStore();
    const reversed = [...salsteelInIndexOrder()].reverse();

    await downloadPass(store, reversed);
    assert.equal(store.rows.size, 1);
    assert.equal(revenueOf([...store.rows.values()][0]!), REVISED_REVENUE);
  });

  it("REGRESSION: a SECOND overlapping pass still ends on the Revision", async () => {
    // The trailing window is deliberately overlapping, so the pair is offered
    // again on the next run. The stored `sourceUrl` matches only ONE of the two
    // siblings, so the other is re-downloaded and re-upserted — the row moves
    // on every run. What must NOT vary is where it comes to rest.
    const store = keyedStore();
    const pair = salsteelInIndexOrder();

    await downloadPass(store, pair);
    const second = await downloadPass(store, pair);

    assert.equal(
      second.downloaded,
      2,
      "both are re-downloaded — the skip is keyed on a url the row can only " +
        "hold one of. Cost, not correctness; documented in orderFilingsForWrite",
    );
    assert.equal(store.rows.size, 1, "still one row");
    assert.equal(
      revenueOf([...store.rows.values()][0]!),
      REVISED_REVENUE,
      "the run must END on the Revision however many times it is repeated",
    );
  });

  it("a filing with no sibling is written exactly once and then SKIPPED", async () => {
    // The false-positive guard. If ordering somehow broke the `sourceUrl` skip,
    // every one of the 17 Originals in that capture would be re-downloaded
    // nightly forever — and the three tests above would all still pass, because
    // they only ever look at the pair.
    const store = keyedStore();
    const page = parseFilingIndexPage(INDEX_CAPTURE, "integrated");
    assert.ok(page !== null);
    const solo = page.entries.filter((e) => e.symbol === "BGLOBAL");
    assert.equal(solo.length, 2, "two BGLOBAL filings, both Originals");

    const first = await downloadPass(store, solo);
    assert.equal(first.downloaded, 2);
    assert.equal(first.skipped, 0);

    const second = await downloadPass(store, solo);
    assert.equal(second.downloaded, 0, "nothing may be re-downloaded");
    assert.equal(second.skipped, 2);
  });
});

describe("MONEY-1235 — storeFiling clears the projection cursor on UPDATE", () => {
  it("`update` sets projectedAt to null and `create` omits the key entirely", async () => {
    // `projectedAt` is the projection's ONLY cursor: it selects with
    // `UNPROJECTED_FILING_WHERE = {OR: [{projectedAt: null},
    // {projectedAt: {isSet: false}}]}` on every run. Nothing anywhere in the
    // repo unset it, so an already-projected filing whose facts were rewritten
    // became invisible to the projection FOREVER and `stock_financials` kept
    // serving the superseded numbers.
    //
    // The two arms of that filter are two different Mongo states and a query
    // for one does not match the other (MONEY-1234), which is why the value
    // matters as much as its presence.
    const db = fakeDb();
    await storeFiling(annualPageEntry(), financials(), db.deps);
    assert.equal(db.upserts.length, 1);
    const { create, update } = db.upserts[0]!;

    assert.equal(
      update.projectedAt,
      null,
      "an UPDATE must re-open the filing for the projection",
    );
    assert.ok(
      "projectedAt" in update,
      "…and it must be the explicit null arm, not an absent key",
    );
    assert.equal(
      "projectedAt" in create,
      false,
      "a CREATE must leave it unset — `isSet: false` already selects it, and " +
        "writing null there would be a second way of saying the same thing",
    );
  });

  it("the UPDATE payload still carries the facts it is re-opening for", async () => {
    // A cursor reset with nothing to re-project is a no-op that looks like a
    // fix. The update branch must carry the new `facts`, `coverage` and
    // `sourceUrl` alongside the cleared stamp.
    const db = fakeDb();
    await storeFiling(annualPageEntry(), financials(), db.deps);
    const { update } = db.upserts[0]!;
    assert.ok(update.facts !== undefined, "facts");
    assert.ok(update.sourceUrl !== undefined, "sourceUrl");
    assert.equal(typeof update.coverage, "number");
    // `sourceUrl` in particular: `sameProvenance` compares it, so it is what
    // stops a genuine revision being skipped downstream as UNCHANGED.
    assert.equal(update.sourceUrl, annualPageEntry().xbrlUrl);
  });
});

describe("MONEY-1235 — a revision must never blank the filedAt it inherits", () => {
  /** A modern Revision as NSE serves one: no broadcast date, a revised one. */
  function revisionEntry(): FilingIndexEntry {
    return {
      ...annualPageEntry(),
      era: "integrated",
      revisionKind: "REVISION",
      broadcastAt: null,
      revisedAt: new Date(Date.UTC(2026, 1, 14, 23, 24, 28)),
      createdAt: new Date(Date.UTC(2026, 1, 14, 23, 24, 33)),
      indexSequence: 143_654,
    };
  }

  it("falls back to revisedAt when the broadcast date is null", async () => {
    // Measured: 3 of 20 records in one capture and 16 of 20 in another are
    // Revisions, and EVERY one of them has `broadcast_Date: null` and a
    // `revised_Date`. Passing `entry.broadcastAt` straight through therefore
    // overwrote a good `filedAt` with null on the common shape of a revision.
    const db = fakeDb();
    await storeFiling(revisionEntry(), financials(), db.deps);
    const { create, update } = db.upserts[0]!;
    const expected = Date.UTC(2026, 1, 14, 23, 24, 28);
    assert.equal((create.filedAt as Date).getTime(), expected);
    assert.equal((update.filedAt as Date).getTime(), expected);
  });

  it("the broadcast date still WINS when both are present", async () => {
    // `revisedAt` is a fallback, not a replacement. `filedAt` means "when NSE
    // broadcast it"; promoting the revision timestamp over a real broadcast
    // would quietly redefine the column.
    const db = fakeDb();
    await storeFiling(
      {
        ...revisionEntry(),
        broadcastAt: new Date(Date.UTC(2026, 1, 14, 1, 2, 3)),
      },
      financials(),
      db.deps,
    );
    const { create } = db.upserts[0]!;
    assert.equal(
      (create.filedAt as Date).getTime(),
      Date.UTC(2026, 1, 14, 1, 2, 3),
    );
  });

  it("REGRESSION: with NEITHER date the UPDATE omits filedAt entirely", async () => {
    // `update:` replaces every key it names, so there is no null that means
    // "keep what is there" — absence is the only way to say it. `create:` still
    // carries the key, because a new row has no incumbent to preserve and an
    // explicit null is the honest record of "NSE gave no date".
    const db = fakeDb();
    await storeFiling(
      { ...revisionEntry(), broadcastAt: null, revisedAt: null },
      financials(),
      db.deps,
    );
    const { create, update } = db.upserts[0]!;
    assert.equal(
      "filedAt" in update,
      false,
      "naming filedAt here would null out a date a previous write supplied",
    );
    assert.ok("filedAt" in create, "but a CREATE records the absence");
    assert.equal(create.filedAt, null);
  });

  it("the incumbent's filedAt survives a dateless re-write, end to end", async () => {
    // The property the omission exists for, asserted against a store that
    // actually keeps rows rather than against the payload alone.
    const store = keyedStore();
    const dated = {
      ...revisionEntry(),
      broadcastAt: new Date(Date.UTC(2026, 1, 14, 23, 24, 16)),
      revisedAt: null,
      xbrlUrl: "https://nsearchives.nseindia.com/corporate/xbrl/A.xml",
    };
    await storeFiling(dated, financials(), store.deps);

    const dateless = {
      ...revisionEntry(),
      broadcastAt: null,
      revisedAt: null,
      xbrlUrl: "https://nsearchives.nseindia.com/corporate/xbrl/B.xml",
    };
    await storeFiling(dateless, financials(), store.deps);

    assert.equal(store.rows.size, 1, "same period — one row");
    const row = [...store.rows.values()][0]!;
    assert.equal(row.sourceUrl, dateless.xbrlUrl, "the later write did land");
    assert.equal(
      (row.filedAt as Date).getTime(),
      Date.UTC(2026, 1, 14, 23, 24, 16),
      "…and it did NOT take the filedAt with it",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — the projection cursor is cleared only when something CHANGED   */
/* -------------------------------------------------------------------------- */

/** `fakeDb`, plus the incumbent read `storeFiling` now performs. */
function fakeDbWithIncumbent(
  stored: {
    sourceUrl?: string | null;
    facts?: unknown;
  } | null,
): { deps: XbrlStoreDeps; upserts: Upsert[]; reads: unknown[] } {
  const upserts: Upsert[] = [];
  const reads: unknown[] = [];
  return {
    upserts,
    reads,
    deps: {
      instrumentMapping: { findFirst: async () => null },
      xbrlFiling: {
        upsert: async (args: unknown) => {
          upserts.push(args as Upsert);
          return {};
        },
        findUnique: async (args: unknown) => {
          reads.push(args);
          return stored;
        },
      },
    },
  };
}

describe("storeFiling — `projectedAt` is not cleared by a no-op re-store", () => {
  it("OMITS the clear when sourceUrl and facts are unchanged", async () => {
    // The `--annual-existing` backfill re-reads a stored row's own XML and
    // upserts the ANNUAL companion it already wrote. Clearing the cursor there
    // re-inflates a projection backlog the drain has already cleared, silently
    // and on every scanned row.
    const entry = annualPageEntry();
    const fin = financials();
    const db = fakeDbWithIncumbent({
      sourceUrl: entry.xbrlUrl,
      facts: { family: fin.family, values: { ...fin.values } },
    });
    await storeFiling(entry, fin, db.deps);
    assert.equal(db.upserts.length, 1);
    assert.ok(
      !("projectedAt" in db.upserts[0]!.update),
      "an unchanged re-store must leave the projection cursor alone",
    );
  });

  it("CLEARS the cursor when the sourceUrl moved — a real revision", async () => {
    const entry = annualPageEntry();
    const fin = financials();
    const db = fakeDbWithIncumbent({
      sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/OLD.xml",
      facts: { family: fin.family, values: { ...fin.values } },
    });
    await storeFiling(entry, fin, db.deps);
    assert.equal(db.upserts[0]!.update.projectedAt, null);
  });

  it("CLEARS the cursor when a value moved under the SAME url", async () => {
    // A parser fix re-run over stored bytes. `sourceUrl` cannot see it.
    const entry = annualPageEntry();
    const fin = financials();
    const db = fakeDbWithIncumbent({
      sourceUrl: entry.xbrlUrl,
      facts: {
        family: fin.family,
        values: { ...fin.values, profitBeforeTax: -1 },
      },
    });
    await storeFiling(entry, fin, db.deps);
    assert.equal(db.upserts[0]!.update.projectedAt, null);
  });

  it("CLEARS the cursor when the incumbent's facts are unreadable", async () => {
    // Fail OPEN. An unnecessary re-projection is a SKIP/UNCHANGED no-op; a
    // missed one leaves `stock_financials` on superseded numbers forever.
    for (const facts of [null, "a string", [], { values: 7 }]) {
      const db = fakeDbWithIncumbent({
        sourceUrl: annualPageEntry().xbrlUrl,
        facts,
      });
      await storeFiling(annualPageEntry(), financials(), db.deps);
      assert.equal(
        db.upserts[0]!.update.projectedAt,
        null,
        `facts=${JSON.stringify(facts)} must fail open`,
      );
    }
  });

  it("CLEARS the cursor when the deps supply no findUnique at all", async () => {
    // The old unconditional behaviour, preserved for a caller that cannot read.
    const db = fakeDb();
    await storeFiling(annualPageEntry(), financials(), db.deps);
    assert.equal(db.upserts[0]!.update.projectedAt, null);
  });

  it("never writes `projectedAt` on the CREATE branch", async () => {
    // A new row is absent-and-therefore-selected via `isSet: false`; an
    // explicit null there is a second way of saying the same thing.
    const db = fakeDbWithIncumbent(null);
    await storeFiling(annualPageEntry(), financials(), db.deps);
    assert.ok(!("projectedAt" in db.upserts[0]!.create));
    // …and with no incumbent the update branch still clears, because a null
    // read is indistinguishable from "we could not look".
    assert.equal(db.upserts[0]!.update.projectedAt, null);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — download order: newest SYMBOLS first, oldest WRITES first      */
/* -------------------------------------------------------------------------- */

describe("downloadOrder", () => {
  /** A minimal entry: only `symbol` and `xbrlUrl` matter to this function. */
  const e = (symbol: string, url: string): FilingIndexEntry =>
    ({ ...annualPageEntry(), symbol, xbrlUrl: url }) as FilingIndexEntry;

  it("visits the symbol with the NEWEST filing first", () => {
    // The input is `orderFilingsForWrite`'s oldest-first stream, so the LAST
    // entry is the newest overall and its symbol must lead.
    const out = downloadOrder([
      e("OLDCO", "old-1"),
      e("MIDCO", "mid-1"),
      e("NEWCO", "new-1"),
    ]);
    assert.deepEqual(
      out.map((x) => x.symbol),
      ["NEWCO", "MIDCO", "OLDCO"],
    );
  });

  it("PRESERVES the within-symbol order — the newest-wins invariant", () => {
    // This is the property the whole regrouping turns on. Two entries for one
    // symbol upsert onto the same `XbrlFiling` row when they share a period, so
    // reversing them inside a group re-creates the exact defect
    // `orderFilingsForWrite` exists to remove: the superseded Original written
    // last.
    const out = downloadOrder([
      e("ACME", "original"),
      e("ACME", "revision"),
      e("ZED", "z-1"),
    ]);
    const acme = out.filter((x) => x.symbol === "ACME").map((x) => x.xbrlUrl);
    assert.deepEqual(acme, ["original", "revision"]);
  });

  it("keeps every entry — a regrouping is not a filter", () => {
    const input = [
      e("A", "a1"),
      e("B", "b1"),
      e("A", "a2"),
      e("C", "c1"),
      e("B", "b2"),
    ];
    const out = downloadOrder(input);
    assert.equal(out.length, input.length);
    assert.deepEqual(
      [...out.map((x) => x.xbrlUrl)].sort(),
      [...input.map((x) => x.xbrlUrl)].sort(),
    );
  });

  it("ranks a group by its NEWEST member, not its oldest", () => {
    // The distinguishing case, and it is the realistic one: a symbol with an
    // old filing AND a fresh revision in the same window. Ranking a group by
    // where it FIRST appears in the oldest-first stream would defer it behind
    // symbols whose only filing is older than that revision — the deferral this
    // regrouping exists to prevent, rebuilt one level down.
    //
    // Indices: OLD@0, MID@1, MID@2, OLD@3.
    //   newest-member ranking -> OLD (3) before MID (2)
    //   first-member  ranking -> MID (1) before OLD (0)   <- the defect
    const out = downloadOrder([
      e("OLD", "old-original"),
      e("MID", "mid-1"),
      e("MID", "mid-2"),
      e("OLD", "old-revision"),
    ]);
    assert.deepEqual(
      out.map((x) => x.xbrlUrl),
      ["old-original", "old-revision", "mid-1", "mid-2"],
    );
  });

  it("is a TOTAL order — the same input always yields the same output", () => {
    const input = [e("A", "a1"), e("B", "b1"), e("A", "a2"), e("B", "b2")];
    assert.deepEqual(
      downloadOrder(input).map((x) => x.xbrlUrl),
      downloadOrder(input).map((x) => x.xbrlUrl),
    );
    // B's newest sits at index 3, A's at index 2, so B leads.
    assert.deepEqual(
      downloadOrder(input).map((x) => x.xbrlUrl),
      ["b1", "b2", "a1", "a2"],
    );
  });

  it("REGRESSION: a budget cut drops the OLDEST symbols, not the newest", () => {
    // The defect, stated as the property it violated. Truncating the raw
    // oldest-first stream keeps the oldest filings and drops the results that
    // just published; truncating the regrouped stream does the reverse.
    const input = [e("QUIET", "q1"), e("QUIET", "q2"), e("JUSTFILED", "j1")];
    const budgetCut = 2;
    assert.deepEqual(
      input.slice(0, budgetCut).map((x) => x.symbol),
      ["QUIET", "QUIET"],
      "the un-regrouped stream spends the budget on the quiet symbol",
    );
    assert.ok(
      downloadOrder(input)
        .slice(0, budgetCut)
        .some((x) => x.symbol === "JUSTFILED"),
      "the regrouped stream reaches the symbol that just filed",
    );
  });

  it("handles an empty window", () => {
    assert.deepEqual(downloadOrder([]), []);
  });
});

/* -------------------------------------------------------------------------- */
/* reparseStoredFiling — MONEY-1252                                           */
/* -------------------------------------------------------------------------- */

/**
 * A March-quarter Ind-AS filing that carries BOTH MONEY-1250 concepts.
 *
 * TATACONSUM Q4-FY26: `CashAndCashEquivalents` 357.26 Cr,
 * `BankBalanceOtherThanCashAndCashEquivalents` 365.33 Cr and
 * `CurrentInvestments` 690.36 Cr — so the projection's
 * `totalCash = sumPresent([cash, bankBalanceOther, currentInvestments])` is
 * 1,412.95 Cr against the 357.26 Cr a pre-MONEY-1250 parse could produce. It is
 * also a Q4, so it declares the full financial year as a second context and
 * exercises the ANNUAL companion leg.
 *
 * The RELIANCE fixture above cannot stand in: it carries no balance-sheet cash
 * tags at all, so a re-parse of it changes nothing and every assertion below
 * would pass against a broken parser.
 */
const REPARSE_XML = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "core",
    "__tests__",
    "fixtures",
    "xbrl",
    "tataconsum-q4fy26-standalone-indas-2026-01-31.trimmed.xml",
  ),
  "utf-8",
);

/** The stored row, as the re-parse job selects it. */
function storedRef(): StoredFilingRef {
  return {
    symbol: "TATACONSUM",
    sourceUrl:
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1_01012026_WEB.xml",
    isin: "INE192A01025",
    basis: "STANDALONE",
    filerKind: "GENERIC",
    audited: true,
    filedAt: new Date(Date.UTC(2026, 3, 20, 9, 0)),
  };
}

/** The parsed primary financials for the fixture. */
function reparsedPrimary() {
  const outcome = parseXbrlDocument(REPARSE_XML);
  assert.equal(outcome.kind, "financials");
  if (outcome.kind !== "financials") throw new Error("unreachable");
  return outcome.financials;
}

/**
 * `facts` exactly as a PRE-MONEY-1250 parse produced it: identical in every
 * respect except that the two concepts that did not exist then are absent.
 * That is the real ~96,000-row population, not a hypothetical.
 */
function preMoney1250Facts(): unknown {
  const fin = reparsedPrimary() as unknown as {
    family: string;
    values: Record<string, number>;
  };
  const values = { ...fin.values };
  delete values.bankBalanceOther;
  delete values.currentInvestments;
  return { family: fin.family, values };
}

describe("reparseStoredFiling — both write legs, from bytes we already hold", () => {
  it("the fixture actually carries the two MONEY-1250 concepts", () => {
    // The floor under every assertion below. Without it a fixture swap could
    // make the whole suite pass while proving nothing about the concepts this
    // job exists to land.
    const v = reparsedPrimary().values as unknown as Record<string, number>;
    assert.equal(v.cashAndCashEquivalents, 3_572_600_000);
    assert.equal(v.bankBalanceOther, 3_653_300_000);
    assert.equal(v.currentInvestments, 6_903_600_000);
  });

  it("writes the PRIMARY row AND the ANNUAL companion — two upserts", async () => {
    // The whole point. `storeAnnualCompanion` re-parses the same bytes for the
    // YEAR's contextRef, and ANNUAL is exactly what the reconcile gate
    // compares. A re-parse that ran only the first leg would rewrite 75,238
    // quarterly rows and leave all 20,338 annual ones on the old concept table.
    const db = fakeDbWithIncumbent({
      sourceUrl: "old",
      facts: preMoney1250Facts(),
    });
    const verdict = await reparseStoredFiling(
      storedRef(),
      REPARSE_XML,
      db.deps,
    );

    assert.equal(verdict.bucket, "financials");
    assert.equal(verdict.refusal, null);
    assert.equal(verdict.annual, "written");
    assert.equal(db.upserts.length, 2);
    assert.deepEqual(
      db.upserts.map((u) => u.create.periodType),
      ["QUARTERLY", "ANNUAL"],
    );
  });

  it("the rewritten facts CARRY the two concepts", async () => {
    const db = fakeDbWithIncumbent({
      sourceUrl: "old",
      facts: preMoney1250Facts(),
    });
    await reparseStoredFiling(storedRef(), REPARSE_XML, db.deps);
    const facts = db.upserts[0]!.create.facts as {
      values: Record<string, number>;
    };
    assert.equal(facts.values.bankBalanceOther, 3_653_300_000);
    assert.equal(facts.values.currentInvestments, 6_903_600_000);
  });

  it("CLEARS projectedAt when the facts moved — the load-bearing half", async () => {
    // `storeFiling` sets `projectedAt: null` via `projectionInputChanged`.
    // Without it the nightly projection selects with `unprojectedOnly` and
    // skips these rows as already-projected, so the corrected totalCash never
    // reaches `stock_financials` and the whole re-parse is invisible to a
    // reader.
    const db = fakeDbWithIncumbent({
      sourceUrl: storedRef().sourceUrl,
      facts: preMoney1250Facts(),
    });
    await reparseStoredFiling(storedRef(), REPARSE_XML, db.deps);

    assert.ok(
      "projectedAt" in db.upserts[0]!.update,
      "the primary row's projection cursor must be cleared",
    );
    assert.equal(db.upserts[0]!.update.projectedAt, null);
  });

  it("does NOT clear projectedAt when the facts are unchanged", async () => {
    // Re-running a completed range must not re-inflate a drained projection
    // backlog with nothing changed and nothing logged (MONEY-1238). This is
    // what makes the job safely idempotent.
    const fin = reparsedPrimary() as unknown as {
      family: string;
      values: unknown;
    };
    const db = fakeDbWithIncumbent({
      sourceUrl: storedRef().sourceUrl,
      facts: { family: fin.family, values: fin.values },
    });
    await reparseStoredFiling(storedRef(), REPARSE_XML, db.deps);

    assert.ok(
      !("projectedAt" in db.upserts[0]!.update),
      "an unchanged re-parse must leave the projection cursor alone",
    );
  });

  it("a non-XBRL document is BUCKETED and writes NOTHING", async () => {
    const db = fakeDbWithIncumbent(null);
    const verdict = await reparseStoredFiling(
      storedRef(),
      "<!DOCTYPE html><html>blocked</html>",
      db.deps,
    );
    assert.equal(verdict.bucket, "unparseable");
    assert.equal(verdict.refusal, null);
    assert.equal(verdict.annual, "none");
    assert.equal(db.upserts.length, 0, "nothing may be written");
  });

  it("a governance filing is nonFinancial, not a failure, and writes nothing", async () => {
    const governance = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "core",
        "__tests__",
        "fixtures",
        "xbrl",
        "infy-q1fy27-governance-2024-12-31.trimmed.xml",
      ),
      "utf-8",
    );
    const db = fakeDbWithIncumbent(null);
    const verdict = await reparseStoredFiling(storedRef(), governance, db.deps);
    assert.equal(verdict.bucket, "nonFinancial");
    assert.equal(db.upserts.length, 0);
  });

  it("an unmapped statement family gets its OWN bucket, not a failure", async () => {
    // A General Insurance filing. Nothing about it is unknown — it is a
    // recorded decision in ENTRY_POINT_KINDS — so it must never join the
    // failure numerator, where it would report a defect no code change clears.
    const gi = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "core",
        "__tests__",
        "fixtures",
        "xbrl",
        "gicre-q1fy27-standalone-gi-2025-01-31.xml",
      ),
      "utf-8",
    );
    const db = fakeDbWithIncumbent(null);
    const verdict = await reparseStoredFiling(storedRef(), gi, db.deps);
    assert.equal(verdict.bucket, "unmappedFamily");
    assert.equal(db.upserts.length, 0);
  });

  it("a store REFUSAL writes NOTHING and does not attempt the ANNUAL leg", async () => {
    // One honest refusal, not two: the companion re-parses the SAME document
    // and would refuse for the same reason, doubling the counter for one fact.
    //
    // The refusal is forced through the document rather than through the
    // source: blank the filing's own `Symbol` and hand it a row whose symbol is
    // blank too, which is exactly `storeFiling`'s `no-symbol` precondition.
    const noSymbol = REPARSE_XML.replace(
      '<in-capmkt:Symbol contextRef="OneD">TATACONSUM</in-capmkt:Symbol>',
      '<in-capmkt:Symbol contextRef="OneD"></in-capmkt:Symbol>',
    );
    assert.notEqual(
      noSymbol,
      REPARSE_XML,
      "the symbol tag must have been found",
    );

    const db = fakeDbWithIncumbent(null);
    const verdict = await reparseStoredFiling(
      { ...storedRef(), symbol: "" },
      noSymbol,
      db.deps,
    );
    assert.equal(verdict.bucket, "financials");
    assert.equal(verdict.refusal, "no-symbol");
    assert.equal(verdict.annual, "none");
    assert.equal(db.upserts.length, 0, "a refused row writes nothing at all");
  });
});

describe("entryFromStoredFiling — a stored row restated as an index entry", () => {
  it("preserves filedAt, so a re-parse can never null the stored date", async () => {
    // `storeFiling` writes `entry.broadcastAt ?? entry.revisedAt`. If this
    // helper dropped `filedAt`, every re-parsed row would lose the date NSE
    // gave it — silently, because the column is nullable.
    const ref = storedRef();
    const entry = entryFromStoredFiling(ref);
    assert.equal(entry.broadcastAt?.toISOString(), ref.filedAt?.toISOString());

    const db = fakeDbWithIncumbent({
      sourceUrl: "old",
      facts: preMoney1250Facts(),
    });
    await reparseStoredFiling(ref, REPARSE_XML, db.deps);
    assert.equal(
      (db.upserts[0]!.update.filedAt as Date).toISOString(),
      ref.filedAt!.toISOString(),
    );
  });

  it("carries the row's own symbol, isin, basis and filerKind", () => {
    const entry = entryFromStoredFiling(storedRef());
    assert.equal(entry.symbol, "TATACONSUM");
    assert.equal(entry.isin, "INE192A01025");
    assert.equal(entry.basis, "STANDALONE");
    assert.equal(entry.filerKind, "GENERIC");
  });

  it("states NO periodType and NO cumulative — the DOCUMENT decides both", () => {
    // MONEY-1114's rule, restated at the one place a synthetic entry could
    // smuggle the old behaviour back in.
    const entry = entryFromStoredFiling(storedRef());
    assert.equal(entry.periodType, null);
    assert.equal(entry.cumulative, null);
  });

  it("maps an unknown filerKind to GENERIC rather than passing it through", () => {
    const entry = entryFromStoredFiling({
      ...storedRef(),
      filerKind: "SOMETHING_NEW",
    });
    assert.equal(entry.filerKind, "GENERIC");
  });
});
