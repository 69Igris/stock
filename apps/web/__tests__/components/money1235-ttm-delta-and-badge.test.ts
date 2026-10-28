/**
 * MONEY-1235 — the Financials tab's TTM handling, under the XBRL switchover.
 *
 * Two defects, both in the same table, both arriving with data that does not
 * exist yet — which is why neither could be caught by an existing test.
 *
 *  1. THE DELTA PAIRED AGAINST TTM. The suppression was
 *     `rows[0] ? isTtmRow(rows[0]) : false` — column 0 only. That covered every
 *     position TTM could occupy while every row was undated. Once the XBRL
 *     projection writes `FY 2026` with a real `periodEnd`
 *     (workers/src/processors/xbrl-projection-writer.ts sets it on CREATE and
 *     UPDATE) and the frozen TTM row keeps none, dated and undated rows
 *     interleave and TTM can land at ANY index. At index 1 the column-0 delta
 *     compared a fiscal year against a trailing-twelve-month aggregate — the
 *     exact fabricated comparison this code's own comment forbids, and with the
 *     projection redefining `operatingIncome` as EBIT while the frozen row
 *     keeps Tickertape's definition, not even the same metric on both sides.
 *
 *  2. THE FROZEN TTM COLUMN READ AS CURRENT. `periodLabel()` structurally never
 *     emits "TTM", so the projection can never displace those ~2,123 rows: they
 *     keep Tickertape values and a frozen `fetchedAt` permanently, rendered in
 *     the same table as rows refreshed last night with nothing to tell them
 *     apart. Deriving a real TTM from the quarterly rows is a later phase; this
 *     is the interim, and it BADGES rather than hides — the figure is not
 *     wrong, it is old.
 *
 * Source: apps/web/components/stock/StockFinancialsTab.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// The tab is a client component importing a CSS module and the "use server"
// actions; stub both so the real helpers can be EXECUTED rather than described.
interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request.endsWith(".css")) return {};
  if (request === "@/lib/actions/stock-tabs") {
    return { getStockFinancialsAction: async () => ({ success: true }) };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

interface Row {
  period: string;
  periodEnd?: string | null;
  fetchedAt?: string | null;
  revenue?: number | null;
  operatingIncome?: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tab = require("../../components/stock/StockFinancialsTab") as {
  leadingDelta: (rows: Row[], field: string) => number | null;
  staleTtmAsOf: (rows: Row[], behindDays?: number) => string | null;
  formatAsOfDate: (v: string | Date | null | undefined) => string | null;
  sortByPeriodDesc: (rows: Row[]) => Row[];
  isTtmRow: (row: { period: string }) => boolean;
  sixPeriodsKeepingTtm: (rows: Row[]) => Row[];
  TTM_STALE_BEHIND_DAYS: number;
};
const {
  leadingDelta,
  staleTtmAsOf,
  formatAsOfDate,
  sortByPeriodDesc,
  sixPeriodsKeepingTtm,
  TTM_STALE_BEHIND_DAYS,
} = tab;

// The stamps prod actually carries: the projection runs nightly, and
// `financial-data-sync` — the only writer that ever touched a TTM row — was
// retired with its data frozen on a March snapshot.
const NIGHTLY = "2026-08-20T18:15:00.000Z";
const FROZEN = "2026-03-12T21:40:00.000Z";

/**
 * The post-switchover ANNUAL shape. The TTM row has NO `periodEnd` — Tickertape
 * ships `endDate: ""` for it and the mapper refuses to write an Invalid Date —
 * while every projected FY row has one.
 */
const ttmSecond: Row[] = [
  {
    period: "FY 2026",
    periodEnd: "2026-03-31",
    fetchedAt: NIGHTLY,
    revenue: 120,
    operatingIncome: 30,
  },
  {
    period: "TTM",
    periodEnd: null,
    fetchedAt: FROZEN,
    revenue: 118,
    operatingIncome: 25,
  },
  {
    period: "FY 2025",
    periodEnd: "2025-03-31",
    fetchedAt: NIGHTLY,
    revenue: 100,
    operatingIncome: 20,
  },
];

describe("MONEY-1235 — the delta pairs FY against FY, never against TTM", () => {
  it("with TTM at index 1, the delta is FY 2026 vs FY 2025", () => {
    // 120 vs 100 = +20%. The pre-fix pairing was rows[0] vs rows[1] =
    // 120 vs 118 = +1.69%, an FY compared against a trailing-twelve-month
    // aggregate and labelled "change vs the previous period".
    assert.equal(leadingDelta(ttmSecond, "revenue"), 20);
    assert.notEqual(
      leadingDelta(ttmSecond, "revenue"),
      ((120 - 118) / 118) * 100
    );
  });

  it("holds for operatingIncome, where the two sides are not even the same metric", () => {
    // The projection defines `operatingIncome` as EBIT; the frozen TTM row
    // carries Tickertape's definition. 30 vs 20 = +50%, FY-over-FY.
    assert.equal(leadingDelta(ttmSecond, "operatingIncome"), 50);
  });

  it("a LEADING TTM still suppresses the delta entirely", () => {
    // The chip renders inside column 0, so an FY-vs-FY number displayed there
    // would be read as the TTM column's change. Unchanged behaviour, restated
    // so the pairing fix cannot quietly re-enable it.
    const ttmFirst: Row[] = [
      {
        period: "TTM",
        periodEnd: "2026-06-30",
        fetchedAt: FROZEN,
        revenue: 118,
      },
      {
        period: "FY 2026",
        periodEnd: "2026-03-31",
        fetchedAt: NIGHTLY,
        revenue: 120,
      },
      {
        period: "FY 2025",
        periodEnd: "2025-03-31",
        fetchedAt: NIGHTLY,
        revenue: 100,
      },
    ];
    assert.equal(leadingDelta(ttmFirst, "revenue"), null);
  });

  it("TTM anywhere further down is simply skipped, not fatal", () => {
    const ttmLast: Row[] = [
      { period: "FY 2026", periodEnd: "2026-03-31", revenue: 120 },
      { period: "FY 2025", periodEnd: "2025-03-31", revenue: 100 },
      { period: "TTM", periodEnd: null, revenue: 118 },
    ];
    assert.equal(leadingDelta(ttmLast, "revenue"), 20);
  });

  it("one FY row and one TTM row is NOT a pair", () => {
    // Nothing to compare against once TTM is excluded. `null` (no chip) is the
    // honest answer; the pre-fix code would have produced a number.
    const lonely: Row[] = [
      { period: "FY 2026", periodEnd: "2026-03-31", revenue: 120 },
      { period: "TTM", periodEnd: null, revenue: 118 },
    ];
    assert.equal(leadingDelta(lonely, "revenue"), null);
  });

  it("still returns null for the ordinary non-finite cases", () => {
    assert.equal(leadingDelta([], "revenue"), null);
    assert.equal(
      leadingDelta(
        [
          { period: "FY 2026", revenue: 120 },
          { period: "FY 2025", revenue: 0 },
        ],
        "revenue"
      ),
      null,
      "a zero prior is a divide-by-zero, not a 100% jump"
    );
  });

  it("the fixture really does order TTM into second place", () => {
    // The premise of the whole block, executed rather than assumed: an undated
    // TTM lands behind the dated FY 2026 and ahead of… whatever the comparator
    // says. Pinning the ORDER here is what keeps the fixture honest.
    assert.equal(sortByPeriodDesc(ttmSecond)[0]!.period, "FY 2026");
  });
});

describe("MONEY-1235 — the frozen TTM column carries its as-of date", () => {
  it("badges a TTM that stopped while the periodic rows kept moving", () => {
    assert.equal(staleTtmAsOf(ttmSecond), "12 Mar 2026");
  });

  it("does NOT badge a TTM that is old alongside equally old filings", () => {
    // A company that has not filed for months is normal, and badging it would
    // train the reader to ignore the badge. The rule is RELATIVE on purpose.
    const allOld = ttmSecond.map((r) => ({ ...r, fetchedAt: FROZEN }));
    assert.equal(staleTtmAsOf(allOld), null);
  });

  it("makes no claim when there is nothing to compare against", () => {
    assert.equal(staleTtmAsOf([]), null);
    assert.equal(
      staleTtmAsOf([{ period: "TTM", fetchedAt: FROZEN }]),
      null,
      "no periodic row"
    );
    assert.equal(
      staleTtmAsOf([
        { period: "TTM", fetchedAt: null },
        { period: "FY 2026", fetchedAt: NIGHTLY },
      ]),
      null,
      "no usable stamp on the TTM row"
    );
    assert.equal(
      staleTtmAsOf([
        { period: "TTM", fetchedAt: FROZEN },
        { period: "FY 2026", fetchedAt: "not-a-date" },
      ]),
      null,
      "an unparseable stamp is ABSENT, not the epoch"
    );
  });

  it("the threshold is one SEBI filing window, and it is exclusive", () => {
    const base = Date.UTC(2026, 0, 1);
    const exactly = [
      { period: "TTM", fetchedAt: new Date(base).toISOString() },
      {
        period: "FY 2026",
        fetchedAt: new Date(
          base + TTM_STALE_BEHIND_DAYS * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
    ];
    assert.equal(
      staleTtmAsOf(exactly),
      null,
      "exactly 45 days is not yet late"
    );
    const oneMore = [
      exactly[0]!,
      {
        period: "FY 2026",
        fetchedAt: new Date(
          base + (TTM_STALE_BEHIND_DAYS + 1) * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
    ];
    assert.equal(staleTtmAsOf(oneMore), "1 Jan 2026");
  });

  it("formats without Intl so server and client agree", () => {
    assert.equal(formatAsOfDate("2026-03-12T21:40:00.000Z"), "12 Mar 2026");
    assert.equal(
      formatAsOfDate(new Date("2026-12-31T00:00:00.000Z")),
      "31 Dec 2026"
    );
    assert.equal(formatAsOfDate(null), null);
    assert.equal(formatAsOfDate(""), null);
    assert.equal(formatAsOfDate("not-a-date"), null);
  });
});

describe("MONEY-1235 — the delta must not cross a SOURCE boundary", () => {
  it("returns null when the two newest rows come from different sources", () => {
    // Mid-drain shape. This switchover redefined `operatingIncome` as EBIT,
    // where Tickertape's column was its own operating income — so pairing an
    // NSE_XBRL row against a TICKERTAPE one renders a DEFINITIONAL step change
    // under a label that reads "Change vs the previous period".
    const mixed: Row[] = [
      {
        period: "FY 2025",
        endDate: "2025-03-31",
        source: "NSE_XBRL",
        revenue: 150,
        operatingIncome: 30,
      },
      {
        period: "FY 2024",
        endDate: "2024-03-31",
        source: "TICKERTAPE",
        revenue: 100,
        operatingIncome: 20,
      },
    ] as unknown as Row[];
    assert.equal(leadingDelta(mixed, "revenue"), null);
    assert.equal(leadingDelta(mixed, "operatingIncome"), null);
  });

  it("still computes when both rows share a source", () => {
    // The control: the guard must suppress a definitional mismatch, not the
    // ordinary case.
    const same: Row[] = [
      {
        period: "FY 2025",
        endDate: "2025-03-31",
        source: "NSE_XBRL",
        revenue: 150,
      },
      {
        period: "FY 2024",
        endDate: "2024-03-31",
        source: "NSE_XBRL",
        revenue: 100,
      },
    ] as unknown as Row[];
    assert.equal(leadingDelta(same, "revenue"), 50);
  });
});

describe("MONEY-1235 — the TTM column survives the six-column cut", () => {
  const periodic = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      period: `FY ${2026 - i}`,
      endDate: `${2026 - i}-03-31`,
      source: "NSE_XBRL",
      revenue: 100 + i,
    })) as unknown as Row[];
  const ttm = {
    period: "TTM",
    source: "TICKERTAPE",
    revenue: 999,
  } as unknown as Row;

  it("keeps TTM when there are SEVEN periods — a bare slice(0,6) drops it", () => {
    // Tickertape's TTM row has no `endDate`, so `sortByPeriodDesc` files it
    // LAST. Prod has 5 FY rows + TTM = 6 today, so it survives at index 5 by
    // exactly one place; the first createMissing run or the 2018+ backfill adds
    // a seventh period and both the column and its staleness badge vanish.
    const out = sixPeriodsKeepingTtm([...periodic(7), ttm]);
    assert.equal(
      out.filter((r) => r.period === "TTM").length,
      1,
      "TTM dropped"
    );
    assert.equal(out.length, 7, "six periodic columns plus TTM");
    assert.equal(out[0]!.period, "FY 2026");
  });

  it("caps the PERIODIC columns at six", () => {
    const out = sixPeriodsKeepingTtm([...periodic(10), ttm]);
    assert.equal(out.filter((r) => r.period !== "TTM").length, 6);
  });

  it("is a no-op shape when there is no TTM row at all", () => {
    const out = sixPeriodsKeepingTtm(periodic(3));
    assert.equal(out.length, 3);
  });
});
