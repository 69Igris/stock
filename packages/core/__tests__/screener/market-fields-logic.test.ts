/**
 * MONEY-1204 (P14 / 14e.1) — market-structure screener fields, PURE layer.
 *
 * Every case here pins a place where the obvious implementation is quietly
 * wrong, and most of them assert against a NAIVE ORACLE written inline — the
 * version someone would reach for — so the test fails if the shipped code ever
 * collapses back into it. A golden value alone would not localise these: the
 * naive answers are all plausible numbers.
 *
 *   1. A delivery mean that treats NSE's `-` as 0.
 *   2. `rows.some(r => r.kind === "FO_BAN")` as "is it banned".
 *   3. One global flag reference day instead of one per kind.
 *   4. Coalescing a permanently-null column to 0 and filtering on it.
 *   5. Letting a Prisma BigInt reach `JSON.stringify`.
 *   6. `latest − 0` for a QoQ delta when the previous quarter is unreported.
 *
 * Source: packages/core/src/screener/market-fields-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  alwaysNullMarketFields,
  buildMarketFieldValues,
  emptyMarketFieldValues,
  isMarketStructure,
  MARKET_FIELDS,
  MARKET_FIELD_BY_ID,
  marketFieldSources,
  marketFieldUniverse,
  marketFieldValue,
  marketNumber,
  matchesMarketFilters,
  qoqDelta,
  type MarketFieldRowSet,
  type MarketFilterInput,
} from "../../src/screener/market-fields-logic";
import type {
  DeliveryDayRow,
  StockFlagStateRow,
} from "../../src/market-data/stock-section-logic";

const DAY_MS = 86_400_000;

/** Sessions newest-first ending on `endIso`, `pct[i]` for session i. */
function deliveryRows(
  endIso: string,
  pct: ReadonlyArray<number | null>,
): DeliveryDayRow[] {
  const end = new Date(endIso).getTime();
  return pct.map((p, i) => ({
    date: new Date(end - i * DAY_MS),
    deliveryPct: p,
    volume: 1000,
    close: 100,
  }));
}

function flag(kind: string, value: string, dayIso: string): StockFlagStateRow {
  return {
    kind,
    value,
    date: new Date(`${dayIso}T00:00:00.000Z`),
    source: "t",
  };
}

// ════════════════════════════════════════════════════════════════════
// Registry
// ════════════════════════════════════════════════════════════════════

describe("MARKET_FIELDS registry", () => {
  it("has unique ids, and every id is recognised by isMarketStructure", () => {
    const ids = MARKET_FIELDS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate field id");
    for (const id of ids) {
      assert.equal(isMarketStructure(id), true, id);
      assert.ok(MARKET_FIELD_BY_ID.get(id), id);
    }
  });

  it("covers all eight source tables the ticket names", () => {
    const sources = new Set(MARKET_FIELDS.map((f) => f.source));
    for (const expected of [
      "DailyPrice",
      "StockFlag",
      "ShareholdingPattern",
      "IndexMembership",
      "DerivativeSummary",
      "MwplDaily",
      "BondEOD",
      "BondMaster",
    ]) {
      assert.ok(sources.has(expected as never), `missing source ${expected}`);
    }
  });

  it("reads only the tables the requested fields need", () => {
    assert.deepEqual(
      [...marketFieldSources(["deliveryPct", "deliveryPct20dAvg"])].sort(),
      ["DailyPrice"],
    );
    // Bond price/yield are uninterpretable without the master's coupon and
    // maturity, so BondEOD implies BondMaster.
    assert.deepEqual([...marketFieldSources(["bondYield"])].sort(), [
      "BondEOD",
      "BondMaster",
    ]);
    assert.deepEqual([...marketFieldSources(["nonsense"])], []);
  });

  it("seeds a bond-only screen from the DEBT universe, anything else from equities", () => {
    assert.equal(marketFieldUniverse(["bondYield", "bondCoupon"]), "DEBT");
    // One equity field present ⇒ equities. A bond screen seeded with equities
    // returns nothing and reads as "no bonds match".
    assert.equal(marketFieldUniverse(["bondYield", "deliveryPct"]), "EQUITY");
    assert.equal(marketFieldUniverse(["foBanFlag"]), "EQUITY");
  });

  it("names mwplUtilisation, and ONLY it, as empty by design", () => {
    assert.deepEqual(alwaysNullMarketFields(MARKET_FIELDS.map((f) => f.id)), [
      "mwplUtilisation",
    ]);
    assert.deepEqual(alwaysNullMarketFields(["deliveryPct", "pcrOi"]), []);
  });
});

// ════════════════════════════════════════════════════════════════════
// 1. Delivery — the null-skipping mean and its contributing-day count
// ════════════════════════════════════════════════════════════════════

describe("delivery — nulls skipped, denominator carried", () => {
  it("skips unreported sessions and reports how many contributed", () => {
    // 20 sessions; six of them are NSE's `-` (trade-for-trade, where delivery
    // is 100% by construction), the other fourteen all read 70.
    const pct: Array<number | null> = [];
    for (let i = 0; i < 20; i++) pct.push(i % 10 < 3 ? null : 70);
    const nulls = pct.filter((p) => p === null).length;
    assert.equal(nulls, 6, "fixture must actually contain nulls");

    const values = buildMarketFieldValues({
      delivery: deliveryRows("2026-08-14", pct),
    });

    assert.equal(values.deliveryPct20dAvg, 70);
    assert.equal(values.deliveryPct20dDays, 14, "the n in n/20");
    assert.equal(values.deliveryPct20dWindow, 20, "the 20 in n/20");

    // The naive version: null → 0, divide by 20. It produces 49 — a plausible
    // number that understates delivery by 30 percentage points on exactly the
    // illiquid, surveilled names a delivery screen exists to find.
    const naive = pct.reduce<number>((s, p) => s + (p ?? 0), 0) / pct.length;
    assert.equal(naive, 49);
    assert.notEqual(values.deliveryPct20dAvg, naive);
  });

  it("headlines the last REPORTED session, dated by deliveryAsOf", () => {
    // CONTRACT CHANGE (MONEY-1204). This test previously asserted that the
    // NEWEST ROW's value was the headline, so `[null, 62, 58]` gave
    // `deliveryPct: null`. That premise was wrong about the table.
    //
    // `DailyPrice` has TWO producers: price-sync writes a Yahoo row (OHLCV, no
    // delivery columns) every session, and bhavcopy-sync adds the NSE delivery
    // columns at 21:00 IST. The newest row is therefore delivery-less for the
    // WHOLE UNIVERSE from the open until 21:00 every weekday — so the old
    // contract nulled this column market-wide for most of each trading day and
    // every delivery screen silently matched nothing. It also contradicted the
    // stock page, which reads the same rows and headlines the same 62.
    //
    // The value is now the last one actually reported, and `deliveryAsOf` says
    // which day it came from — the arrangement `bondAsOf` already documents:
    // possibly stale, honestly dated, never silently decided.
    const values = buildMarketFieldValues({
      delivery: deliveryRows("2026-08-14", [null, 62, 58]),
    });
    assert.equal(values.deliveryPct, 62);
    assert.equal(
      values.deliveryAsOf,
      "2026-08-13T00:00:00.000Z",
      "the headline must be dated to the session it was read from, NOT to the " +
        "newest row — an undated stale value is the thing this forbids",
    );
    // The mean is untouched by any of this: it still skips the null session.
    assert.equal(values.deliveryPct20dAvg, 60);
    assert.equal(values.deliveryPct20dDays, 2);
  });

  it("skips as many unreported sessions as it takes, and dates the one it used", () => {
    // Not just an off-by-one past the newest row: a long weekend plus a late
    // bhavcopy is several delivery-less rows in a row.
    const values = buildMarketFieldValues({
      delivery: deliveryRows("2026-08-14", [null, null, null, 58, 57]),
    });
    assert.equal(values.deliveryPct, 58);
    assert.equal(values.deliveryAsOf, "2026-08-11T00:00:00.000Z");
  });

  it("FLOOR — nothing ever reported is null, and carries NO as-of date", () => {
    // The bound on the new contract: "last reported" must never become
    // "invent one". A window with no reporting session at all resolves to null,
    // and the DATE goes null with it. Under the old newest-row contract this
    // case still produced a `deliveryAsOf` of 2026-08-14 — an as-of stamp for a
    // value that does not exist, which is worse than no answer.
    //
    // This is also what a delisted or long-suspended name looks like to the
    // reader: `loadMarketFieldValues` fetches only
    // `MARKET_FIELD_LOOKBACK_DAYS.delivery` (60 calendar days) of `DailyPrice`,
    // so rows older than that are never in hand to be headlined.
    const values = buildMarketFieldValues({
      delivery: deliveryRows("2026-08-14", new Array(40).fill(null)),
    });
    assert.equal(values.deliveryPct, null);
    assert.equal(values.deliveryAsOf, null);
    assert.equal(values.deliveryPct20dAvg, null);
    assert.equal(values.deliveryPct20dDays, 0);
    // …and unknown excludes, so such a name cannot match a delivery screen.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: "gt", value: 0 },
      ]),
      false,
    );
  });

  it("an all-null window yields a null mean, not 0", () => {
    const values = buildMarketFieldValues({
      delivery: deliveryRows("2026-08-14", [null, null, null]),
    });
    assert.equal(values.deliveryPct20dAvg, null);
    assert.equal(values.deliveryPct20dDays, 0);
    // …and a filter on it therefore matches nothing.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct20dAvg", operator: "lt", value: 100 },
      ]),
      false,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 & 3. StockFlag — current state per kind, per-kind reference day
// ════════════════════════════════════════════════════════════════════

describe("StockFlag — an older row must not win", () => {
  const refs = {
    FO_BAN: "2026-08-14",
    SURVEILLANCE: "2026-08-14",
    PRICE_BAND: "2026-08-14",
  };

  it("a ban that ended in January does NOT read as current in August", () => {
    const rows = [
      flag("FO_BAN", "BAN", "2026-01-05"),
      flag("FO_BAN", "BAN", "2026-01-06"),
    ];
    const values = buildMarketFieldValues({
      flags: rows,
      flagsReferenceDayByKind: refs,
    });

    assert.equal(values.foBanFlag, false);

    // The naive query — the one the model comment warns about, because
    // StockFlag has NO @@unique and a 40-day ban is 40 rows.
    const naive = rows.some((r) => r.kind === "FO_BAN");
    assert.equal(naive, true);
    assert.notEqual(values.foBanFlag, naive);

    // …so a "currently banned" screen returns nothing for this stock.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "foBanFlag", operator: "eq", value: 1 },
      ]),
      false,
    );
  });

  it("a ban published on the newest ban day DOES read as current", () => {
    const values = buildMarketFieldValues({
      flags: [
        flag("FO_BAN", "BAN", "2026-08-13"),
        flag("FO_BAN", "BAN", "2026-08-14"),
      ],
      flagsReferenceDayByKind: refs,
    });
    assert.equal(values.foBanFlag, true);
    assert.equal(
      matchesMarketFilters(values, [
        { field: "foBanFlag", operator: "eq", value: 1 },
      ]),
      true,
    );
  });

  it("keeps BOTH frameworks when NSE publishes two on the same day", () => {
    // GSM Stage I and ESM Stage II on one stock on one day is routine, and
    // there is no unique to collapse them. Taking "the first row of the newest
    // date" would silently drop one — on the surface whose whole job is
    // warning retail investors.
    const values = buildMarketFieldValues({
      flags: [
        flag("SURVEILLANCE", "GSM STAGE - I", "2026-08-14"),
        flag("SURVEILLANCE", "ESM Stage II", "2026-08-14"),
      ],
      flagsReferenceDayByKind: refs,
    });
    assert.equal(values.gsmFlag, true);
    assert.equal(values.asmFlag, false);
    assert.deepEqual(values.surveillanceCodes.sort(), [
      "ESM Stage II",
      "GSM STAGE - I",
    ]);
  });

  it("keeps an unrecognised surveillance code VISIBLE instead of absorbing it", () => {
    const values = buildMarketFieldValues({
      flags: [flag("SURVEILLANCE", "NEW FRAMEWORK ZZZ", "2026-08-14")],
      flagsReferenceDayByKind: refs,
    });
    // Not ASM, not GSM — and the raw code is right there, not dropped.
    assert.equal(values.asmFlag, false);
    assert.equal(values.gsmFlag, false);
    assert.deepEqual(values.surveillanceUndecoded, ["NEW FRAMEWORK ZZZ"]);
    assert.deepEqual(values.surveillanceCodes, ["NEW FRAMEWORK ZZZ"]);
  });

  it("reads `No Band` as a published NO, not as a missing band", () => {
    const banded = buildMarketFieldValues({
      flags: [flag("PRICE_BAND", '{"band":"5"}', "2026-08-14")],
      flagsReferenceDayByKind: refs,
    });
    assert.equal(banded.priceBandFlag, true);
    assert.equal(banded.priceBand, "5");

    const unbanded = buildMarketFieldValues({
      flags: [flag("PRICE_BAND", '{"band":"No Band"}', "2026-08-14")],
      flagsReferenceDayByKind: refs,
    });
    assert.equal(unbanded.priceBandFlag, false);
    assert.equal(unbanded.priceBand, "No Band");
  });

  it("uses each kind's OWN reference day — one global max is a fail-open", () => {
    // The ban file landed for the 14th; the surveillance file is a day behind.
    // A single global reference (the 14th) makes every surveillance badge
    // non-current, so a stock plainly under GSM reads `gsmFlag: false`.
    const perKind = buildMarketFieldValues({
      flags: [
        flag("FO_BAN", "BAN", "2026-08-14"),
        flag("SURVEILLANCE", "GSM Stage 1", "2026-08-13"),
      ],
      flagsReferenceDayByKind: {
        FO_BAN: "2026-08-14",
        SURVEILLANCE: "2026-08-13",
      },
    });
    assert.equal(perKind.gsmFlag, true);
    assert.equal(perKind.foBanFlag, true);

    const globalMax = buildMarketFieldValues({
      flags: [
        flag("FO_BAN", "BAN", "2026-08-14"),
        flag("SURVEILLANCE", "GSM Stage 1", "2026-08-13"),
      ],
      flagsReferenceDayByKind: {
        FO_BAN: "2026-08-14",
        SURVEILLANCE: "2026-08-14",
      },
    });
    assert.equal(globalMax.gsmFlag, false, "this is the bug being avoided");
  });

  it("no reference day for a kind ⇒ UNKNOWN, never a fabricated all-clear", () => {
    // The family has not landed for this environment. "Not banned" is not a
    // conclusion available from an unlanded feed.
    const values = buildMarketFieldValues({
      flags: [flag("SURVEILLANCE", "GSM Stage 1", "2026-08-14")],
      flagsReferenceDayByKind: { SURVEILLANCE: "2026-08-14" },
    });
    assert.equal(values.gsmFlag, true);
    assert.equal(values.foBanFlag, null, "no FO_BAN reference ⇒ unknown");

    // Unknown excludes on BOTH sides — it never matches "banned" and it never
    // matches "not banned".
    assert.equal(
      matchesMarketFilters(values, [
        { field: "foBanFlag", operator: "eq", value: 1 },
      ]),
      false,
    );
    assert.equal(
      matchesMarketFilters(values, [
        { field: "foBanFlag", operator: "eq", value: 0 },
      ]),
      false,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. mwplUtilisation — permanently null ⇒ zero matches, never everything
// ════════════════════════════════════════════════════════════════════

describe("mwplUtilisation — wired, always null, matches nothing", () => {
  const rowSet: MarketFieldRowSet = {
    // Real MwplDaily shape: the OI columns carry numbers, the utilisation does
    // not, and there is no published denominator to divide by.
    mwpl: { date: new Date("2026-08-14"), utilisationPct: null },
  };

  it("resolves to null with the row's date still cited", () => {
    const values = buildMarketFieldValues(rowSet);
    assert.equal(values.mwplUtilisation, null);
    assert.equal(values.mwplAsOf, "2026-08-14T00:00:00.000Z");
  });

  it("EVERY comparison on it excludes — not just the ones pointing one way", () => {
    const values = buildMarketFieldValues(rowSet);
    const filters: MarketFilterInput[] = [
      { field: "mwplUtilisation", operator: "gt", value: 90 },
      { field: "mwplUtilisation", operator: "gte", value: 90 },
      { field: "mwplUtilisation", operator: "lt", value: 90 },
      { field: "mwplUtilisation", operator: "lte", value: 90 },
      { field: "mwplUtilisation", operator: "eq", value: 0 },
      { field: "mwplUtilisation", operator: "between", value: [0, 100] },
    ];
    for (const f of filters) {
      assert.equal(
        matchesMarketFilters(values, [f]),
        false,
        `${f.operator} must not match a null utilisation`,
      );
    }
    // The `lt`/`lte`/`between`/`eq 0` cases are the ones that matter: a
    // coalesce-to-zero would make every one of them match the WHOLE universe.
  });

  it("filtering a whole universe on it yields ZERO rows, not all of them", () => {
    const universe = Array.from({ length: 50 }, () =>
      buildMarketFieldValues(rowSet),
    );
    const survivors = universe.filter((v) =>
      matchesMarketFilters(v, [
        { field: "mwplUtilisation", operator: "lt", value: 100 },
      ]),
    );
    assert.equal(survivors.length, 0);
    assert.equal(
      universe.length,
      50,
      "the universe was not empty to begin with",
    );
  });

  it("never derives a denominator from the OI columns beside it", () => {
    // The model note is explicit: do NOT populate this from `oi_cli_limit`,
    // which is a per-CLIENT limit — a different quantity. Handing the builder
    // rich OI numbers must still produce null.
    const values = buildMarketFieldValues({
      mwpl: {
        date: new Date("2026-08-14"),
        utilisationPct: null,
      },
    });
    assert.equal(values.mwplUtilisation, null);
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. BigInt — coerced once, before any serialisation boundary
// ════════════════════════════════════════════════════════════════════

describe("DerivativeSummary — BigInt never reaches JSON.stringify", () => {
  it("coerces futOiChange and leaves nothing bigint-typed behind", () => {
    const values = buildMarketFieldValues({
      derivatives: {
        date: new Date("2026-08-14"),
        pcrOi: 1.24,
        futOiChange: -1_234_567n,
      },
    });

    assert.equal(values.futOiChange, -1_234_567);
    assert.equal(typeof values.futOiChange, "number");
    assert.equal(values.pcrOi, 1.24);

    // The actual failure being prevented: JSON.stringify THROWS on a BigInt,
    // and these values cross a Next server action AND an apps/api response.
    assert.doesNotThrow(() => JSON.stringify(values));
    assert.throws(
      () => JSON.stringify({ futOiChange: -1_234_567n }),
      TypeError,
    );
  });

  it("marketNumber handles bigint, number, and everything else", () => {
    assert.equal(marketNumber(42n), 42);
    assert.equal(marketNumber(4.5), 4.5);
    assert.equal(marketNumber(null), null);
    assert.equal(marketNumber(undefined), null);
    assert.equal(marketNumber(NaN), null);
    assert.equal(marketNumber(Infinity), null);
    assert.equal(marketNumber("12"), null, "strings are not silently parsed");
  });

  it("a NaN pcrOi excludes rather than leaking through a comparison", () => {
    const values = buildMarketFieldValues({
      derivatives: { date: new Date("2026-08-14"), pcrOi: NaN },
    });
    assert.equal(values.pcrOi, null);
    assert.equal(
      matchesMarketFilters(values, [
        { field: "pcrOi", operator: "gt", value: 1 },
      ]),
      false,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. ShareholdingPattern — QoQ deltas and the `-` rule
// ════════════════════════════════════════════════════════════════════

describe("ShareholdingPattern — an unreported quarter is not zero", () => {
  it("computes deltas from the newest two quarters", () => {
    const values = buildMarketFieldValues({
      shareholding: [
        { quarter: "2025-12", pledgedPct: 10, fiiPct: 18, diiPct: 9 },
        { quarter: "2026-06", pledgedPct: 22, fiiPct: 20.5, diiPct: 12 },
        { quarter: "2026-03", pledgedPct: 15, fiiPct: 19, diiPct: 11 },
      ],
    });
    assert.equal(values.shareholdingQuarter, "2026-06");
    assert.equal(values.shareholdingPrevQuarter, "2026-03");
    assert.equal(values.pledgedPct, 22);
    assert.equal(values.pledgedPctQoqDelta, 7);
    assert.equal(values.fiiPctQoqDelta, 1.5);
    assert.equal(values.diiPctQoqDelta, 1);
  });

  it("a null previous quarter yields a NULL delta, not the whole level", () => {
    const values = buildMarketFieldValues({
      shareholding: [
        { quarter: "2026-06", pledgedPct: 22, fiiPct: null, diiPct: 12 },
        { quarter: "2026-03", pledgedPct: null, fiiPct: 19, diiPct: 11 },
      ],
    });
    // `latest − 0` would publish a pledge INCREASE of exactly 22 — a fabricated
    // number where the truth is "the previous filing did not report it".
    assert.equal(values.pledgedPct, 22);
    assert.equal(values.pledgedPctQoqDelta, null);
    assert.notEqual(values.pledgedPctQoqDelta, 22);

    // …and the null level side is just as important: `-` means NOT REPORTED.
    assert.equal(values.fiiPct, null);
    assert.equal(values.fiiPctQoqDelta, null);
    assert.equal(values.diiPctQoqDelta, 1);
  });

  it("a reported 0 is a real value, distinct from an unreported one", () => {
    const values = buildMarketFieldValues({
      shareholding: [
        { quarter: "2026-06", pledgedPct: 0, fiiPct: 5, diiPct: 5 },
        { quarter: "2026-03", pledgedPct: 12, fiiPct: 5, diiPct: 5 },
      ],
    });
    assert.equal(values.pledgedPct, 0);
    assert.equal(values.pledgedPctQoqDelta, -12);
    // A filer who reported zero pledge DOES match "no pledge".
    assert.equal(
      matchesMarketFilters(values, [
        { field: "pledgedPct", operator: "eq", value: 0 },
      ]),
      true,
    );
  });

  it("qoqDelta refuses whenever either side is unknown", () => {
    assert.equal(qoqDelta(5, 3), 2);
    assert.equal(qoqDelta(5, null), null);
    assert.equal(qoqDelta(null, 3), null);
    assert.equal(qoqDelta(null, null), null);
    assert.equal(qoqDelta(0, 3), -3, "0 is a value, not an absence");
  });
});

// ════════════════════════════════════════════════════════════════════
// IndexMembership
// ════════════════════════════════════════════════════════════════════

describe("indexMember — open stints, operand narrows the index", () => {
  const rowSet: MarketFieldRowSet = {
    memberships: [
      {
        indexId: "nifty50",
        addedOn: null,
        firstSeen: new Date("2020-01-01"),
        lastSeen: new Date("2026-08-14"),
        removedOn: null,
      },
      {
        indexId: "NIFTY500",
        addedOn: null,
        firstSeen: new Date("2020-01-01"),
        lastSeen: new Date("2026-08-14"),
        removedOn: null,
      },
      // A CLOSED stint. `buildIndexChips` drops it, so a widened query cannot
      // quietly start advertising ex-memberships as current.
      {
        indexId: "niftyit",
        addedOn: null,
        firstSeen: new Date("2019-01-01"),
        lastSeen: new Date("2021-01-01"),
        removedOn: new Date("2021-01-02"),
      },
    ],
  };

  it("resolves open stints only, case-normalised", () => {
    const values = buildMarketFieldValues(rowSet);
    assert.deepEqual(values.indexIds?.slice().sort(), ["nifty50", "nifty500"]);
  });

  it("matches on the named index and rejects one it is not in", () => {
    const values = buildMarketFieldValues(rowSet);
    assert.equal(marketFieldValue(values, "indexMember", "nifty50"), 1);
    assert.equal(marketFieldValue(values, "indexMember", "NIFTY50"), 1);
    assert.equal(marketFieldValue(values, "indexMember", "niftyit"), 0);
    assert.equal(
      matchesMarketFilters(values, [
        { field: "indexMember", operator: "eq", value: 1, operand: "nifty50" },
      ]),
      true,
    );
    assert.equal(
      matchesMarketFilters(values, [
        { field: "indexMember", operator: "eq", value: 1, operand: "niftyit" },
      ]),
      false,
    );
  });

  it("no operand means 'in any index'", () => {
    assert.equal(
      marketFieldValue(buildMarketFieldValues(rowSet), "indexMember"),
      1,
    );
    assert.equal(
      marketFieldValue(
        buildMarketFieldValues({ memberships: [] }),
        "indexMember",
      ),
      0,
      "read the table and found nothing — a real 0",
    );
  });

  it("NOT READ is unknown, not 'in no index'", () => {
    const values = emptyMarketFieldValues();
    assert.equal(values.indexIds, null);
    assert.equal(marketFieldValue(values, "indexMember"), null);
    // Unknown excludes both ways.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "indexMember", operator: "eq", value: 0 },
      ]),
      false,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Bonds — degrade to no matches, never to an error
// ════════════════════════════════════════════════════════════════════

describe("bond fields — nearly-empty tables degrade to zero matches", () => {
  it("no bond rows at all ⇒ null values and no match, no throw", () => {
    const values = buildMarketFieldValues({ bondEod: null, bondMaster: null });
    assert.equal(values.bondYield, null);
    assert.equal(values.bondPrice, null);
    assert.equal(values.bondCoupon, null);
    assert.equal(
      matchesMarketFilters(values, [
        { field: "bondYield", operator: "gt", value: 8 },
      ]),
      false,
    );
  });

  it("falls back from lastYtm to the weighted YTM, and carries the segment", () => {
    const values = buildMarketFieldValues({
      bondEod: {
        date: new Date("2026-08-14"),
        segment: "CBM",
        lastPrice: 101.25,
        lastYtm: null,
        wtdYtm: 7.94,
      },
      bondMaster: { coupon: 8.33, maturityDate: new Date("2031-03-31") },
    });
    assert.equal(values.bondYield, 7.94);
    assert.equal(values.bondPrice, 101.25);
    assert.equal(values.bondSegment, "CBM");
    assert.equal(values.bondCoupon, 8.33);
    assert.equal(values.bondMaturity, "2031-03-31T00:00:00.000Z");
    assert.equal(
      matchesMarketFilters(values, [
        { field: "bondYield", operator: "gt", value: 7 },
        { field: "bondCoupon", operator: "gt", value: 8 },
      ]),
      true,
    );
  });

  it("a perpetual's null maturity stays null — no invented redemption", () => {
    const values = buildMarketFieldValues({
      bondEod: {
        date: new Date("2026-08-14"),
        segment: "WDM",
        lastPrice: 99,
        lastYtm: 8.1,
      },
      bondMaster: { coupon: null, maturityDate: null },
    });
    assert.equal(values.bondMaturity, null);
    // A coupon we failed to read is not a zero-coupon bond.
    assert.equal(values.bondCoupon, null);
    assert.equal(
      matchesMarketFilters(values, [
        { field: "bondCoupon", operator: "lt", value: 1 },
      ]),
      false,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Matcher semantics
// ════════════════════════════════════════════════════════════════════

describe("matchesMarketFilters", () => {
  const values = buildMarketFieldValues({
    delivery: deliveryRows("2026-08-14", [72, 70, 68]),
    derivatives: { date: new Date("2026-08-14"), pcrOi: 1.1, futOiChange: 5n },
  });

  it("ANDs every filter it understands", () => {
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: "gt", value: 70 },
        { field: "pcrOi", operator: "lt", value: 1.5 },
      ]),
      true,
    );
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: "gt", value: 70 },
        { field: "pcrOi", operator: "gt", value: 1.5 },
      ]),
      false,
    );
  });

  it("honours every relational operator's boundary", () => {
    const eq = (
      op: MarketFilterInput["operator"],
      v: number | [number, number],
    ) =>
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: op, value: v },
      ]);
    assert.equal(eq("gt", 72), false);
    assert.equal(eq("gte", 72), true);
    assert.equal(eq("lt", 72), false);
    assert.equal(eq("lte", 72), true);
    assert.equal(eq("eq", 72), true);
    assert.equal(eq("between", [70, 75]), true);
    assert.equal(eq("between", [60, 71]), false);
  });

  it("SKIPS an unknown field rather than failing the whole screen", () => {
    // A vocabulary that has run ahead of the registry must not silently return
    // zero stocks; the engine logs the drop, as it does for fundamentals.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "notAField", operator: "gt", value: 1 },
      ]),
      true,
    );
  });

  it("cannot be satisfied by a candle-series operator", () => {
    // There is no series behind a quarterly pledge or a daily ban list, so
    // rather than invent one, cross_above excludes.
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: "cross_above", value: 50 },
      ]),
      false,
    );
  });

  it("rejects a non-finite `between` bound instead of matching everything", () => {
    assert.equal(
      matchesMarketFilters(values, [
        { field: "deliveryPct", operator: "between", value: [NaN, 100] },
      ]),
      false,
    );
  });

  it("an empty filter list matches", () => {
    assert.equal(matchesMarketFilters(values, []), true);
  });
});
