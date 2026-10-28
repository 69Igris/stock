/**
 * The pure decisions inside `scripts/data/snapshot-vendor-fundamentals.ts` —
 * MONEY-1401 B3.
 *
 * ## Why these are tested at all
 *
 * `stock_ratios` is `@@unique([symbol, exchange])` and `stock_financials` is
 * `@@unique([symbol, exchange, statementType, periodType, period])` — the two
 * lines `vendor-fundamentals-wiring.test.ts` reads out of `schema.prisma` so
 * they need no line number here. Neither carries `source`, so the first XBRL write
 * ERASES the incumbent Tickertape value rather than sitting beside it. This
 * snapshot is the only thing that makes that door two-way, which means the
 * restore CLASSIFICATION is the last line of defence for 2,135 ratio rows and
 * 32,359 financial rows.
 *
 * The failure mode is silent in both directions and is entirely decided by the
 * natural key:
 *
 *   - a key field DROPPED conflates rows that are different rows. One symbol's
 *     NSE and BSE ratios become one; every fiscal year of one statement
 *     collapses into whichever the iteration reached last. The plan comes out
 *     SMALLER and reports success.
 *   - a key field ADDED splits one row into several, and a restore then tries
 *     to insert duplicates of a row that is already there.
 *
 * Neither shows up as an error, which is why the classification lives in
 * `scripts/data/snapshot-vendor-fundamentals-logic.ts` — a module with ZERO
 * imports — instead of inline in a `main()` that opens a database connection.
 * Same split as `series-readiness.ts` out of `reclassify-instruments.ts`
 * (MONEY-1196) and `instrument-name-repair.ts` out of
 * `repair-instrument-names.ts` (MONEY-1205).
 *
 * ## Mutation log
 *
 * Every case below was run against a deliberately broken source and confirmed
 * RED before being kept. Recorded at each `it(...)`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * A DYNAMIC import, and it has to be — the same boundary
 * `financials-basis-backfill.test.ts` documents. `tsx` transpiles a script
 * under `scripts/` to CommonJS, and a static named import resolves the shape at
 * parse time against the ESM view. Do not "tidy" this into a static import.
 */
const {
  SNAPSHOT_COLLECTION,
  naturalKey,
  naturalKeyString,
  snapshotDayOf,
  snapshotDocId,
  planSnapshot,
  planRestore,
  reviveSnapshotRow,
  // MONEY-1401 F7
  partitionVendorRows,
  planResnapshotGuard,
} =
  (await import("../../../../scripts/data/snapshot-vendor-fundamentals-logic")) as typeof import("../../../../scripts/data/snapshot-vendor-fundamentals-logic");

type Row = Record<string, unknown>;

const AT = new Date("2026-09-13T18:30:00.000Z");

/** A `stock_ratios` row, shaped the way Prisma hands one back. */
function ratio(over: Row = {}): Row {
  return {
    id: "65f0000000000000000000a1",
    instrumentId: "65f0000000000000000000b1",
    symbol: "RELIANCE",
    exchange: "NSE",
    pe: 24.5,
    roe: 9.1,
    source: "TICKERTAPE",
    fetchedAt: new Date("2026-03-21T00:00:00.000Z"),
    ...over,
  };
}

/** A `stock_financials` row. */
function fin(over: Row = {}): Row {
  return {
    id: "65f0000000000000000000c1",
    instrumentId: "65f0000000000000000000b1",
    symbol: "RELIANCE",
    exchange: "NSE",
    statementType: "INCOME",
    periodType: "ANNUAL",
    period: "2025",
    revenue: 1000,
    source: "TICKERTAPE",
    ...over,
  };
}

/**
 * THE `@@unique` TRANSCRIPTION IS CHECKED AGAINST `schema.prisma`, NEXT DOOR.
 *
 * Two cases used to live here asserting `NATURAL_KEY_FIELDS` against a second
 * literal typed into this file. That catches a later accidental edit of the
 * constant and CANNOT catch the risk it named — a transcription error against
 * the schema, where both copies are written wrong together. It also carried
 * `schema.prisma:4988` / `:4882` in its titles, and both had drifted (the lines
 * are 5035 and 4929 today), which is the same defect in the citation.
 *
 * `vendor-fundamentals-wiring.test.ts` parses the schema and compares. Deleted
 * rather than kept beside it: a vacuous assertion that reads as coverage is
 * worse than no assertion, because it is what somebody checks the box against.
 */
describe("natural keys", () => {
  it("each collection has its own snapshot sibling", () => {
    assert.equal(
      SNAPSHOT_COLLECTION.stock_ratios,
      "stock_ratios_vendor_snapshot",
    );
    assert.equal(
      SNAPSHOT_COLLECTION.stock_financials,
      "stock_financials_vendor_snapshot",
    );
  });

  it("refuses to build a key from a row missing a key field", () => {
    // A key built around `undefined` matches every other malformed row — one
    // bucket, silently. Throwing is the only honest answer.
    assert.throws(
      () => naturalKey("stock_ratios", { symbol: "RELIANCE" }),
      /exchange.*absent/s,
    );
  });
});

describe("planSnapshot stores the row, not a reshaping of it", () => {
  it("wraps each row verbatim under `row`, with the stamps beside it", () => {
    const [doc] = planSnapshot([ratio()], {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    assert.ok(doc);
    assert.equal(doc.sourceCollection, "stock_ratios");
    assert.equal(doc.snapshotAt, AT.toISOString());
    assert.equal(doc.snapshotDay, "2026-09-13");
    assert.deepEqual(doc.key, { symbol: "RELIANCE", exchange: "NSE" });
    // Every non-Date field survives byte for byte.
    assert.equal(doc.row.pe, 24.5);
    assert.equal(doc.row.source, "TICKERTAPE");
    assert.equal(doc.row.id, "65f0000000000000000000a1");
  });

  it("records which fields were Dates, and revives exactly those", () => {
    const [doc] = planSnapshot([ratio()], {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    assert.ok(doc);
    assert.deepEqual(doc.dateFields, ["fetchedAt"]);
    assert.equal(doc.row.fetchedAt, "2026-03-21T00:00:00.000Z");

    const revived = reviveSnapshotRow(doc);
    assert.ok(revived.fetchedAt instanceof Date);
    assert.equal(
      (revived.fetchedAt as Date).toISOString(),
      "2026-03-21T00:00:00.000Z",
    );
    // A string that merely LOOKS date-ish is not revived — only what was a Date.
    assert.equal(typeof revived.source, "string");
  });

  it("the _id is deterministic, so a same-day re-run replaces rather than doubles", () => {
    const once = planSnapshot([ratio()], {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    const twice = planSnapshot([ratio()], {
      collection: "stock_ratios",
      snapshotAt: new Date("2026-09-13T23:59:59.000Z"),
    });
    assert.equal(once[0]!._id, twice[0]!._id);
    assert.equal(
      once[0]!._id,
      snapshotDocId("2026-09-13", naturalKeyString("stock_ratios", ratio())),
    );
    // A different DAY is a different snapshot and must not collide.
    const nextDay = planSnapshot([ratio()], {
      collection: "stock_ratios",
      snapshotAt: new Date("2026-09-14T00:00:00.000Z"),
    });
    assert.notEqual(once[0]!._id, nextDay[0]!._id);
    assert.equal(snapshotDayOf(AT), "2026-09-13");
  });

  it("refuses a batch containing one row twice", () => {
    // Impossible through the unique index, so it means the read paged wrong.
    // Two copies would collide on `_id` at insert time anyway; failing here
    // says WHICH row rather than "duplicate key".
    assert.throws(
      () =>
        planSnapshot([ratio(), ratio()], {
          collection: "stock_ratios",
          snapshotAt: AT,
        }),
      /duplicate natural key/,
    );
  });
});

describe("planRestore classification", () => {
  /**
   * MUTATION — `planRestore`'s `else if (live === canonical(doc.row))` changed
   * to `else if (true)`: replace 0 / unchanged 2, RED on the first assertion.
   * Reverted, green.
   */
  it("one changed row -> 1 replace, 0 insert", () => {
    const rows = [
      ratio({ symbol: "RELIANCE" }),
      ratio({ symbol: "TCS", id: "65f0000000000000000000a2", pe: 31.2 }),
    ];
    const docs = planSnapshot(rows, {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    // XBRL has since rewritten TCS's pe and stamped its own source.
    const current = [
      ratio({ symbol: "RELIANCE" }),
      ratio({
        symbol: "TCS",
        id: "65f0000000000000000000a2",
        pe: 28.9,
        source: "NSE_XBRL",
      }),
    ];

    const plan = planRestore(docs, current);
    assert.equal(plan.replace.length, 1);
    assert.equal(plan.insert.length, 0);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.replace[0]!.key.symbol, "TCS");
    // It restores the VENDOR value, not the live one.
    assert.equal(plan.replace[0]!.row.pe, 31.2);
    assert.equal(plan.replace[0]!.row.source, "TICKERTAPE");
  });

  /**
   * MUTATION — `if (live === undefined) insert.push(doc)` changed to
   * `if (false)`: the deleted row fell into `replace`, so insert 0 / replace 1.
   * RED on both counts. Reverted, green.
   */
  it("one deleted row -> 0 replace, 1 insert", () => {
    const rows = [
      ratio({ symbol: "RELIANCE" }),
      ratio({ symbol: "TCS", id: "65f0000000000000000000a2", pe: 31.2 }),
    ];
    const docs = planSnapshot(rows, {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    const current = [ratio({ symbol: "RELIANCE" })]; // TCS is gone

    const plan = planRestore(docs, current);
    assert.equal(plan.replace.length, 0);
    assert.equal(plan.insert.length, 1);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.insert[0]!.key.symbol, "TCS");
  });

  /**
   * MUTATION — `canonical` made key-order dependent (returned
   * `JSON.stringify(value)` with no sort): the identical-but-reordered row read
   * as a change, replace 1 / unchanged 1. RED. Reverted, green.
   */
  it("identical -> 0 replace, 0 insert, everything unchanged", () => {
    const rows = [
      ratio({ symbol: "RELIANCE" }),
      ratio({ symbol: "TCS", id: "65f0000000000000000000a2", pe: 31.2 }),
    ];
    const docs = planSnapshot(rows, {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    // Same content, one row's fields handed back in a different order — which
    // is a driver's prerogative and must not read as a change.
    const reordered: Row = {};
    for (const k of Object.keys(rows[1]!).reverse()) reordered[k] = rows[1]![k];

    const plan = planRestore(docs, [rows[0]!, reordered]);
    assert.equal(plan.replace.length, 0);
    assert.equal(plan.insert.length, 0);
    assert.equal(plan.unchanged, 2);
  });

  it("a row that appeared AFTER the snapshot is left alone, never deleted", () => {
    const docs = planSnapshot([ratio({ symbol: "RELIANCE" })], {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    const plan = planRestore(docs, [
      ratio({ symbol: "RELIANCE" }),
      ratio({ symbol: "NEWCO", id: "65f0000000000000000000a9" }),
    ]);
    assert.equal(plan.replace.length, 0);
    assert.equal(plan.insert.length, 0);
    assert.equal(plan.unchanged, 1);
  });

  it("refuses a batch mixing the two collections", () => {
    const mixed = [
      ...planSnapshot([ratio()], {
        collection: "stock_ratios",
        snapshotAt: AT,
      }),
      ...planSnapshot([fin()], {
        collection: "stock_financials",
        snapshotAt: AT,
      }),
    ];
    // The key differs per collection, so one batch can only ever be one
    // collection. Reading a financials row with the ratios key would silently
    // collapse every period of it into one.
    assert.throws(() => planRestore(mixed, []), /mixed batch/);
  });
});

describe("the key fields each earn their place", () => {
  /**
   * MUTATION — `exchange` removed from `NATURAL_KEY_FIELDS.stock_ratios`:
   * `planSnapshot` threw "duplicate natural key" on the two-exchange batch and
   * `naturalKeyString` returned the same string for both. RED. Reverted, green.
   */
  it("stock_ratios: the same symbol on NSE and BSE is TWO rows", () => {
    const nse = ratio({ exchange: "NSE", pe: 24.5 });
    const bse = ratio({
      exchange: "BSE",
      id: "65f0000000000000000000a3",
      pe: 24.4,
    });

    assert.notEqual(
      naturalKeyString("stock_ratios", nse),
      naturalKeyString("stock_ratios", bse),
    );

    const docs = planSnapshot([nse, bse], {
      collection: "stock_ratios",
      snapshotAt: AT,
    });
    assert.equal(docs.length, 2);

    // Only the BSE row has moved since the snapshot.
    const plan = planRestore(docs, [
      nse,
      ratio({ exchange: "BSE", id: "65f0000000000000000000a3", pe: 99.9 }),
    ]);
    assert.equal(plan.replace.length, 1);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.replace[0]!.key.exchange, "BSE");
  });

  /**
   * MUTATION — `period` removed from `NATURAL_KEY_FIELDS.stock_financials`:
   * `naturalKeyString` returned the same string for FY2024 and FY2025 and
   * `planSnapshot` threw "duplicate natural key". RED. Reverted, green.
   *
   * This is the five-field case the ratios test cannot cover: `stock_financials`
   * holds one row per (symbol, exchange, statementType, periodType, period), so
   * every fiscal year of one statement differs in ONE field only.
   */
  it("stock_financials: two rows differing only in `period` are NOT conflated", () => {
    const fy2024 = fin({
      period: "2024",
      revenue: 900,
      id: "65f0000000000000000000c0",
    });
    const fy2025 = fin({ period: "2025", revenue: 1000 });

    assert.notEqual(
      naturalKeyString("stock_financials", fy2024),
      naturalKeyString("stock_financials", fy2025),
    );

    const docs = planSnapshot([fy2024, fy2025], {
      collection: "stock_financials",
      snapshotAt: AT,
    });
    assert.equal(docs.length, 2);
    assert.deepEqual(docs.map((d) => d.key.period).sort(), ["2024", "2025"]);

    // The projection rewrote FY2025 only. FY2024 must read as unchanged, and
    // the restore must put back 1000 — not 900, which is what a `period`-less
    // key would have left in the map.
    const plan = planRestore(docs, [
      fy2024,
      fin({ period: "2025", revenue: 1234, source: "NSE_XBRL" }),
    ]);
    assert.equal(plan.replace.length, 1);
    assert.equal(plan.insert.length, 0);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.replace[0]!.key.period, "2025");
    assert.equal(plan.replace[0]!.row.revenue, 1000);
  });

  /**
   * MUTATION — `statementType` removed from the key: INCOME and BALANCE_SHEET
   * for one period collided, `planSnapshot` threw. RED. Reverted, green.
   */
  it("stock_financials: the same period's INCOME and BALANCE_SHEET are two rows", () => {
    const income = fin({ statementType: "INCOME" });
    const balance = fin({
      statementType: "BALANCE_SHEET",
      id: "65f0000000000000000000c2",
    });
    assert.notEqual(
      naturalKeyString("stock_financials", income),
      naturalKeyString("stock_financials", balance),
    );
    assert.equal(
      planSnapshot([income, balance], {
        collection: "stock_financials",
        snapshotAt: AT,
      }).length,
      2,
    );
  });

  it("the key string is unambiguous even when a field contains a separator", () => {
    // `period` is free text ("2024", "Q3-2024", "TTM"), so any separator
    // character a join would pick can appear inside it. JSON of the ordered
    // values cannot be fooled by that.
    const a = fin({ period: "Q3-2024" });
    const b = fin({ periodType: "ANNUAL", period: "Q3-2024" });
    assert.equal(
      naturalKeyString("stock_financials", a),
      naturalKeyString("stock_financials", b),
    );
    const c = fin({ periodType: "QUARTERLY-Q3", period: "2024" });
    assert.notEqual(
      naturalKeyString("stock_financials", a),
      naturalKeyString("stock_financials", c),
    );
  });
});

describe("F7 — a vendor snapshot is of the VENDOR's rows", () => {
  it("EXCLUDES a row this platform wrote itself", () => {
    // MUT: `OUR_SOURCES` -> an empty Set, and both assertions go red.
    const { vendor, ours } = partitionVendorRows([
      ratio({ symbol: "AAA", source: "TICKERTAPE" }),
      ratio({ symbol: "BBB", source: "NSE_XBRL" }),
      ratio({ symbol: "CCC", source: "DOC_PDF" }),
    ]);
    assert.deepEqual(
      vendor.map((r) => r["symbol"]),
      ["AAA"],
    );
    assert.equal(ours.length, 2);
  });

  it("keeps a row whose source is ABSENT, unknown, or not a string", () => {
    // A backup errs toward keeping. An unlisted source is a NEW VENDOR, and
    // dropping it would lose a value no restore could bring back; keeping one
    // extra row costs a row. The polarity is the whole design.
    //
    // MUT: invert the test to a vendor allowlist and every one of these lands
    // in `ours`.
    const { vendor, ours } = partitionVendorRows([
      ratio({ symbol: "AAA", source: undefined }),
      ratio({ symbol: "BBB", source: "SOME_NEW_VENDOR" }),
      ratio({ symbol: "CCC", source: 7 }),
    ]);
    assert.equal(vendor.length, 3);
    assert.equal(ours.length, 0);
  });

  // WHAT `OUR_SOURCES` CONTAINS is checked in `vendor-fundamentals-wiring.
  // test.ts`, against `FINANCIALS_AUTHORITY` in
  // `packages/core/src/market-data/xbrl-projection.ts` — a real join, where the
  // `deepEqual` against a literal that used to sit here was a second copy of
  // the same typing. Neither can catch "a new arm of ours shipped and nobody
  // added it", and nothing can; the polarity above is fail-toward-keeping for
  // exactly that reason.
});

describe("F7 — a same-day re-snapshot may not replace a DIFFERENT snapshot", () => {
  const dayOf = (rows: readonly Row[]): ReturnType<typeof planSnapshot> =>
    planSnapshot(rows, { collection: "stock_ratios", snapshotAt: AT });

  it("REFUSES when a stored row has since been overwritten by our own write", () => {
    // THE SEQUENCE THIS EXISTS FOR, and it is the normal shape of an Indian
    // working session rather than an edge case: IST 05:30-00:00 is ONE UTC day,
    // so "snapshot at 11:00, arm, run the job at 15:00, re-snapshot at 16:00 to
    // check" lands on the same `snapshotDay` and used to DELETE the vendor
    // documents and store the XBRL rows in their place — destroying the only
    // copy of the values the switchover is reversible against.
    //
    // MUT: `planResnapshotGuard` -> `{ refuse: false, conflicts: [] }` and this
    // goes red.
    const stored = dayOf([ratio({ symbol: "AAA", source: "TICKERTAPE" })]);
    const planned = dayOf([ratio({ symbol: "AAA", source: "NSE_XBRL" })]);
    const guard = planResnapshotGuard(stored, planned);
    assert.equal(guard.refuse, true);
    assert.equal(guard.conflicts.length, 1);
    assert.equal(guard.conflicts[0]!.stored, "TICKERTAPE");
    assert.equal(guard.conflicts[0]!.current, "NSE_XBRL");
  });

  it("REFUSES when a stored row has left the new plan entirely", () => {
    // The same event from the other side: `partitionVendorRows` moved the row
    // to `ours`, so it is simply absent from the plan rather than present with
    // a different source. A guard that only compared the rows it still found
    // would wave that through — which is the shape the real fix produces,
    // because the exclusion runs BEFORE the guard.
    //
    // MUT: `continue` instead of pushing a conflict for a missing key, and this
    // goes red.
    const stored = dayOf([
      ratio({ symbol: "AAA", source: "TICKERTAPE" }),
      ratio({ symbol: "BBB", source: "TICKERTAPE" }),
    ]);
    const planned = dayOf([ratio({ symbol: "AAA", source: "TICKERTAPE" })]);
    const guard = planResnapshotGuard(stored, planned);
    assert.equal(guard.refuse, true);
    assert.equal(guard.conflicts.length, 1);
    assert.match(guard.conflicts[0]!.current, /not in the new snapshot/);
  });

  it("ALLOWS a re-run whose rows are the same vendor's, numbers and all changed", () => {
    // The half that keeps same-day idempotency real: a crashed run must be
    // re-runnable, and a vendor row whose NUMBERS moved is still a vendor row.
    // Refusing on content would make the script unusable the first time
    // anything legitimately re-fetched.
    //
    // MUT: compare `canonical(doc.row)` instead of `source` and this goes red.
    const stored = dayOf([ratio({ symbol: "AAA", roe: 9.1 })]);
    const planned = dayOf([ratio({ symbol: "AAA", roe: 11.4 })]);
    assert.equal(planResnapshotGuard(stored, planned).refuse, false);
  });

  it("ALLOWS the FIRST snapshot of a day, and a NEW key appearing", () => {
    assert.equal(planResnapshotGuard([], dayOf([ratio()])).refuse, false);
    const stored = dayOf([ratio({ symbol: "AAA" })]);
    const planned = dayOf([ratio({ symbol: "AAA" }), ratio({ symbol: "BBB" })]);
    assert.equal(planResnapshotGuard(stored, planned).refuse, false);
  });

  it("holds for stock_financials too, on its five-field key", () => {
    const of = (rows: readonly Row[]): ReturnType<typeof planSnapshot> =>
      planSnapshot(rows, { collection: "stock_financials", snapshotAt: AT });
    const stored = of([fin({ source: "TICKERTAPE" })]);
    const planned = of([fin({ source: "NSE_XBRL" })]);
    assert.equal(planResnapshotGuard(stored, planned).refuse, true);
  });
});
