/**
 * MONEY-1235 — the research layer sorted financial periods LEXICOGRAPHICALLY,
 * so the wrong row was "newest".
 *
 * `getOrFetchFinancials` read `orderBy: { period: "desc" }` and then treated
 * `existing[0]` as the newest row — for `isStale(newest.fetchedAt, …)` AND for
 * the `source` label handed to the research agent. `period` is a free-text
 * LABEL, so that is a string sort, and the XBRL switchover breaks it twice:
 *
 *  1. QUARTERLY MISORDER. `periodLabel()` emits `Q${q}-${fyEndYear}` on an
 *     Indian fiscal year, so the newest quarter of a symbol that has entered
 *     FY2027 is `"Q1-2027"` — which sorts BELOW every `"Q4-2026"` /
 *     `"Q3-2026"` / `"Q2-2026"` string. Prod holds 71,450 quarterly filings and
 *     ZERO quarterly `stock_financials` rows, so this order arrives with the
 *     first rows the projection ever writes; there is no existing behaviour to
 *     regress and none to catch it either.
 *
 *  2. THE FROZEN TTM ROW WINS FOREVER. `"TTM" > "FY 20xx"` because `"T" > "F"`.
 *     ~2,123 `period:"TTM"` rows live under `periodType:"ANNUAL"` and
 *     `periodLabel()` structurally never emits "TTM", so the projection can
 *     never displace them — Tickertape values, a `TICKERTAPE` source and a
 *     frozen `fetchedAt`, permanently. Under a label sort that row is
 *     `existing[0]` for every symbol that has one, so the tools report
 *     `source: "TICKERTAPE"` and log "stale" nightly while every FY row beside
 *     it is fresh `NSE_XBRL`.
 *
 * Everything asserted below is the REAL exported code in
 * `packages/research/src/data-sources/db-store-logic.ts`. `db-store.ts` itself
 * imports Prisma at module scope and cannot be loaded under `node:test`, so the
 * last describe block is a source scan proving the reader actually calls these
 * helpers — the shape that stops the logic being fixed in a module nothing
 * runs.
 *
 * Source: packages/research/src/data-sources/db-store{,-logic}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isTtmPeriod,
  periodEndFromLabel,
  financialsPeriodTime,
  sortFinancialsNewestFirst,
  pickNewestPeriodicRow,
  authorityMaxSource,
  describeStaleTtm,
  annotateStaleTtmRows,
  labelStaleTtmPeriod,
  latestRatiosTimestamp,
  TTM_STALE_BEHIND_DAYS,
} from "../src/data-sources/db-store-logic";

const SRC = join(import.meta.dirname, "..", "src", "data-sources");
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");

/**
 * Comments stripped. The prose in this file QUOTES the removed expressions
 * ("this used to read `existing[0]!.source`"), so a scan for their absence has
 * to look at code — otherwise documenting the fix would fail the test that
 * checks it.
 */
const code = (f: string): string =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const DAY = 24 * 60 * 60 * 1000;

/**
 * The fixture the ticket describes, built the way prod actually stores it:
 *
 *  - the TTM row has NO `periodEnd`. Tickertape ships `endDate: ""` for it and
 *    `parseTickertapePeriodEnd` refuses to write an Invalid Date, so the column
 *    is null — which is exactly why a label sort was the only order available.
 *  - the XBRL rows DO have one; the writer sets it on CREATE and on UPDATE
 *    (workers/src/processors/xbrl-projection-writer.ts).
 */
const NIGHTLY = new Date("2026-08-20T18:15:00.000Z");
const FROZEN = new Date("2026-03-12T21:40:00.000Z"); // Tickertape's last run

const annualRows = [
  {
    period: "TTM",
    periodEnd: null,
    source: "TICKERTAPE",
    fetchedAt: FROZEN,
    statementType: "INCOME",
    rawData: null,
    revenue: 100,
  },
  {
    period: "FY 2026",
    periodEnd: new Date("2026-03-31T00:00:00.000Z"),
    source: "NSE_XBRL",
    fetchedAt: NIGHTLY,
    statementType: "INCOME",
    rawData: null,
    revenue: 90,
  },
  {
    period: "FY 2025",
    periodEnd: new Date("2025-03-31T00:00:00.000Z"),
    source: "NSE_XBRL",
    fetchedAt: NIGHTLY,
    statementType: "INCOME",
    rawData: null,
    revenue: 80,
  },
];

const quarterlyRows = [
  {
    period: "Q1-2027",
    periodEnd: new Date("2026-06-30T00:00:00.000Z"),
    source: "NSE_XBRL",
    fetchedAt: NIGHTLY,
    statementType: "INCOME",
    rawData: null,
  },
  {
    period: "Q4-2026",
    periodEnd: new Date("2026-03-31T00:00:00.000Z"),
    source: "NSE_XBRL",
    fetchedAt: NIGHTLY,
    statementType: "INCOME",
    rawData: null,
  },
  {
    period: "Q3-2026",
    periodEnd: new Date("2025-12-31T00:00:00.000Z"),
    source: "NSE_XBRL",
    fetchedAt: NIGHTLY,
    statementType: "INCOME",
    rawData: null,
  },
];

describe("MONEY-1235 — the lexicographic sort, stated as the bug", () => {
  it("a label sort really does put Q4-2026 above the newer Q1-2027", () => {
    // Not a hypothetical. This is `orderBy: { period: "desc" }` reproduced in
    // one line, and it is what the reader shipped.
    const lexical = ["Q1-2027", "Q4-2026", "Q3-2026"].sort((a, b) =>
      b.localeCompare(a),
    );
    assert.deepEqual(lexical, ["Q4-2026", "Q3-2026", "Q1-2027"]);
  });

  it('a label sort really does put "TTM" above every "FY 20xx"', () => {
    const lexical = ["FY 2026", "TTM", "FY 2025"].sort((a, b) =>
      b.localeCompare(a),
    );
    assert.equal(lexical[0], "TTM");
  });
});

describe("MONEY-1235 — periodEndFromLabel (the undated fallback)", () => {
  it("resolves the Indian-fiscal quarter labels periodLabel() emits", () => {
    // Q<n>-<fyEndYear>, April-March. Q1-2027 is Apr-Jun 2026.
    assert.equal(
      periodEndFromLabel("Q1-2027"),
      Date.UTC(2026, 5, 30),
      "Q1 of FY2027 ends 30 Jun 2026",
    );
    assert.equal(periodEndFromLabel("Q2-2026"), Date.UTC(2025, 8, 30));
    assert.equal(periodEndFromLabel("Q3-2026"), Date.UTC(2025, 11, 31));
    assert.equal(periodEndFromLabel("Q4-2026"), Date.UTC(2026, 2, 31));
  });

  it("orders the quarters correctly where a string compare does not", () => {
    const labels = ["Q4-2026", "Q1-2027", "Q2-2026", "Q3-2026"];
    const ordered = [...labels].sort(
      (a, b) => (periodEndFromLabel(b) ?? 0) - (periodEndFromLabel(a) ?? 0),
    );
    assert.deepEqual(ordered, ["Q1-2027", "Q4-2026", "Q3-2026", "Q2-2026"]);
  });

  it("resolves annual labels to 31 March, prefixed or bare", () => {
    assert.equal(periodEndFromLabel("FY 2026"), Date.UTC(2026, 2, 31));
    assert.equal(periodEndFromLabel("2026"), Date.UTC(2026, 2, 31));
    assert.equal(periodEndFromLabel("FY24"), Date.UTC(2024, 2, 31));
  });

  it("refuses to date TTM rather than guessing a position for it", () => {
    assert.equal(periodEndFromLabel("TTM"), null);
    assert.equal(periodEndFromLabel(" ttm "), null);
    assert.equal(periodEndFromLabel(""), null);
    assert.equal(periodEndFromLabel(undefined), null);
  });

  it("identifies the TTM row case-insensitively and ignores padding", () => {
    assert.equal(isTtmPeriod("TTM"), true);
    assert.equal(isTtmPeriod(" ttm "), true);
    assert.equal(isTtmPeriod("FY 2026"), false);
    assert.equal(isTtmPeriod(null), false);
  });
});

describe("MONEY-1235 — the real periodEnd always wins over the label", () => {
  it("prefers the column when both are available", () => {
    // A deliberately CONTRADICTORY row: the label says FY 2019, the column says
    // 2026. The column is what the writer asserted, so it must win — otherwise
    // a mislabelled row (SANOFI's Dec year-end, MONEY-1232) would be filed by
    // its label rather than by its date.
    assert.equal(
      financialsPeriodTime({
        period: "FY 2019",
        periodEnd: new Date("2026-03-31T00:00:00.000Z"),
      }),
      Date.UTC(2026, 2, 31),
    );
  });

  it("falls back to the label for the legacy rows that have no column", () => {
    assert.equal(
      financialsPeriodTime({ period: "FY 2025", periodEnd: null }),
      Date.UTC(2025, 2, 31),
    );
  });

  it("an Invalid Date is treated as ABSENT, never as time 0", () => {
    // `new Date("").getTime()` is NaN. Coercing it would file the row at the
    // epoch — confidently last — instead of admitting it is unplaceable.
    assert.equal(financialsPeriodTime({ period: "TTM", periodEnd: "" }), null);
    assert.equal(
      financialsPeriodTime({ period: "TTM", periodEnd: new Date("nope") }),
      null,
    );
  });
});

describe("MONEY-1235 — the mixed fixture the ticket describes", () => {
  it("the ANNUAL call reports FY 2026 as newest, not the frozen TTM row", () => {
    const ordered = sortFinancialsNewestFirst(annualRows);
    const newest = pickNewestPeriodicRow(ordered);
    assert.equal(newest?.period, "FY 2026");
    // And the stamp that drives `isStale` is the nightly one, not March's.
    assert.equal(newest?.fetchedAt.getTime(), NIGHTLY.getTime());
  });

  it("the ANNUAL call reports source NSE_XBRL, not TICKERTAPE", () => {
    // The old reader took `existing[0].source` under a label sort, which is the
    // frozen TTM row for every symbol that has one.
    assert.equal(authorityMaxSource(annualRows), "NSE_XBRL");
  });

  it("the QUARTERLY call returns Q1-2027 FIRST", () => {
    assert.deepEqual(
      sortFinancialsNewestFirst(quarterlyRows).map((r) => r.period),
      ["Q1-2027", "Q4-2026", "Q3-2026"],
    );
  });

  it("orders the quarters correctly even with every periodEnd missing", () => {
    // The legacy shape: rows written before `periodEnd` existed. The label
    // fallback has to carry the whole order on its own.
    const undated = quarterlyRows.map((r) => ({ ...r, periodEnd: null }));
    assert.deepEqual(
      sortFinancialsNewestFirst(undated).map((r) => r.period),
      ["Q1-2027", "Q4-2026", "Q3-2026"],
    );
  });

  it("the undated TTM row sorts LAST, never into a leading position", () => {
    assert.deepEqual(
      sortFinancialsNewestFirst(annualRows).map((r) => r.period),
      ["FY 2026", "FY 2025", "TTM"],
    );
  });

  it("does not mutate the caller's array", () => {
    const input = [...annualRows];
    sortFinancialsNewestFirst(input);
    assert.equal(input[0]!.period, "TTM");
  });

  /**
   * A TTM row that DOES carry a `periodEnd`.
   *
   * The repo disagrees with itself about whether this happens.
   * `packages/research/src/data-sources/persistence.ts:56` and the mapper's own
   * doc say Tickertape ships `endDate: ""` for TTM, so `periodEnd` is omitted;
   * `StockFinancialsTab.tsx` says "Tickertape sends `endDate` on every row
   * including TTM" and its fixture gives TTM a real one. Only one can be true
   * of any given row, and BOTH shapes are cheap to be correct against — so the
   * guard does not rest on the answer.
   *
   * The undated case is covered above (TTM sorts last, so a "first non-TTM row"
   * rule would accidentally work). This is the case where it does NOT: a dated
   * TTM sorts FIRST, and picking `ordered[0]` would hand `isStale` the frozen
   * March stamp for every symbol, which is the whole defect.
   */
  const datedTtm = [
    {
      period: "TTM",
      periodEnd: new Date("2026-06-30T00:00:00.000Z"),
      source: "TICKERTAPE",
      fetchedAt: FROZEN,
    },
    {
      period: "FY 2026",
      periodEnd: new Date("2026-03-31T00:00:00.000Z"),
      source: "NSE_XBRL",
      fetchedAt: NIGHTLY,
    },
  ];

  it("a DATED TTM row still sorts first — its date is real and is honoured", () => {
    assert.deepEqual(
      sortFinancialsNewestFirst(datedTtm).map((r) => r.period),
      ["TTM", "FY 2026"],
    );
  });

  it("…but is STILL not the newest PERIOD, so staleness reads FY 2026's stamp", () => {
    // Ordering and freshness are separate questions. The TTM row can legitimately
    // sit first in a chronological list while being useless as an answer to "are
    // our filings current" — nothing refreshes it, so its age reports only when
    // Tickertape stopped.
    const newest = pickNewestPeriodicRow(sortFinancialsNewestFirst(datedTtm));
    assert.equal(newest?.period, "FY 2026");
    assert.equal(newest?.fetchedAt.getTime(), NIGHTLY.getTime());
  });

  it("falls back to the leading row only when EVERY row is TTM", () => {
    // Degenerate, but `?? ordered[0]!` in the reader depends on it: something
    // beats throwing on a symbol whose only stored row is the aggregate.
    assert.equal(pickNewestPeriodicRow([datedTtm[0]!]), undefined);
  });
});

describe("MONEY-1235 — authorityMaxSource", () => {
  it("follows FINANCIALS_AUTHORITY, not row order", () => {
    assert.equal(
      authorityMaxSource([
        { source: "YAHOO" },
        { source: "SCREENER" },
        { source: "TICKERTAPE" },
      ]),
      "TICKERTAPE",
    );
  });

  it("ranks an unknown source LAST — a new upstream cannot claim to be best", () => {
    assert.equal(
      authorityMaxSource([{ source: "SOME_NEW_FEED" }, { source: "YAHOO" }]),
      "YAHOO",
    );
    // …but it is still reported when it is all there is.
    assert.equal(
      authorityMaxSource([{ source: "SOME_NEW_FEED" }]),
      "SOME_NEW_FEED",
    );
  });

  it("labels a provenance-less payload UNKNOWN rather than inventing one", () => {
    assert.equal(authorityMaxSource([]), "UNKNOWN");
    assert.equal(
      authorityMaxSource([{ source: null }, { source: "  " }]),
      "UNKNOWN",
    );
  });
});

describe("MONEY-1235 — the frozen TTM row is badged, not hidden", () => {
  it("flags a TTM that stopped while the periodic rows kept moving", () => {
    const notice = describeStaleTtm(annualRows);
    assert.ok(notice, "the March TTM row is 161 days behind the nightly rows");
    assert.equal(notice.asOf, FROZEN.toISOString());
    assert.ok(
      notice.behindDays > TTM_STALE_BEHIND_DAYS,
      `behindDays ${notice.behindDays} must exceed the ${TTM_STALE_BEHIND_DAYS}-day window`,
    );
  });

  it("does NOT flag a TTM that is simply old alongside equally old filings", () => {
    // A company that has not filed for months is normal. The defect is a TTM
    // frozen while its NEIGHBOURS move, which is why the rule is relative.
    const allOld = annualRows.map((r) => ({ ...r, fetchedAt: FROZEN }));
    assert.equal(describeStaleTtm(allOld), null);
  });

  it("makes no claim when it cannot tell", () => {
    assert.equal(describeStaleTtm([]), null, "no TTM row");
    assert.equal(
      describeStaleTtm([{ period: "TTM", fetchedAt: FROZEN }]),
      null,
      "no periodic row to compare against",
    );
    assert.equal(
      describeStaleTtm([
        { period: "TTM", fetchedAt: null },
        { period: "FY 2026", fetchedAt: NIGHTLY },
      ]),
      null,
      "no usable stamp on the TTM row",
    );
  });

  it("re-badges ONLY the TTM label, and leaves every other row untouched", () => {
    const notice = describeStaleTtm(annualRows)!;
    const out = annotateStaleTtmRows(annualRows, notice);
    const ttm = out.find((r) => r.period.startsWith("TTM"))!;
    assert.equal(ttm.period, "TTM (as of 2026-03-12)");
    assert.equal(ttm.ttmStaleAsOf, notice.asOf);
    assert.equal(ttm.ttmBehindDays, notice.behindDays);
    // The FY rows keep their labels EXACTLY — `period` is part of
    // `StockFinancials`' unique key and this is a read-path presentation label.
    assert.deepEqual(
      out.filter((r) => !r.period.startsWith("TTM")).map((r) => r.period),
      ["FY 2026", "FY 2025"],
    );
    // The numbers survive the re-badge — this dates the figure, it does not
    // hide it.
    assert.equal((ttm as { revenue?: number }).revenue, 100);
  });

  it("labelStaleTtmPeriod puts the DATE in the label the model reads", () => {
    assert.equal(
      labelStaleTtmPeriod("TTM", "2026-03-12T21:40:00.000Z"),
      "TTM (as of 2026-03-12)",
    );
  });
});

describe("MONEY-1235 — ratios freshness reads BOTH clocks", () => {
  const derived = new Date("2026-08-20T16:30:00.000Z");

  it("takes ratiosDerivedAt when the nightly derive is newer than fetchedAt", () => {
    // The live shape: `xbrl-ratios-daily` stamps `ratiosDerivedAt` nightly and
    // deliberately never touches `fetchedAt`, so reading `fetchedAt` alone made
    // `isStale(…, "ratios")` — a 24-HOUR threshold — permanently true for every
    // symbol on the platform.
    assert.equal(
      latestRatiosTimestamp({
        fetchedAt: FROZEN,
        ratiosDerivedAt: derived,
      })!.getTime(),
      derived.getTime(),
    );
  });

  it("keeps fetchedAt when it is the newer of the two", () => {
    assert.equal(
      latestRatiosTimestamp({
        fetchedAt: derived,
        ratiosDerivedAt: FROZEN,
      })!.getTime(),
      derived.getTime(),
    );
  });

  it("survives a null on either side without collapsing to the epoch", () => {
    assert.equal(
      latestRatiosTimestamp({
        fetchedAt: null,
        ratiosDerivedAt: derived,
      })!.getTime(),
      derived.getTime(),
    );
    assert.equal(
      latestRatiosTimestamp({
        fetchedAt: derived,
        ratiosDerivedAt: null,
      })!.getTime(),
      derived.getTime(),
    );
  });

  it("returns null — not 1970 — when neither clock is set", () => {
    // `Math.max(-Infinity, -Infinity)` fed to `new Date` is an Invalid Date,
    // and `isStale` on 1970 is "stale" by 56 years. Both are wrong answers to
    // "we do not know".
    assert.equal(
      latestRatiosTimestamp({ fetchedAt: null, ratiosDerivedAt: null }),
      null,
    );
  });
});

describe("MONEY-1235 — the reader actually calls all of this", () => {
  // db-store.ts imports Prisma at module scope, so it cannot be executed here.
  // Without this block the helpers above could be perfect and unreachable —
  // which is precisely how the DB-first cache in this same file shipped broken
  // and stayed broken (MONEY-1205).
  const src = code("db-store.ts");
  const fn = src.slice(
    src.indexOf("export async function getOrFetchFinancials"),
    src.indexOf(
      "export ",
      src.indexOf("export async function getOrFetchFinancials") + 10,
    ),
  );

  it("getOrFetchFinancials sorts before it picks anything", () => {
    assert.match(fn, /sortFinancialsNewestFirst\(existing\)/);
  });

  it("getOrFetchFinancials no longer treats existing[0] as newest", () => {
    assert.doesNotMatch(
      fn,
      /existing\[0\]/,
      "the newest row must come from pickNewestPeriodicRow, not from DB order",
    );
    assert.match(fn, /pickNewestPeriodicRow\(ordered\)/);
  });

  it("getOrFetchFinancials reports the authority-max source", () => {
    assert.match(fn, /authorityMaxSource\(ordered\)/);
    assert.match(fn, /source,\s*fromCache: true/);
  });

  it("getOrFetchFinancials badges the frozen TTM row", () => {
    assert.match(fn, /describeStaleTtm\(ordered\)/);
    assert.match(fn, /annotateStaleTtmRows\(ordered, staleTtm\)/);
  });

  it("getOrFetchRatios reads max(fetchedAt, ratiosDerivedAt)", () => {
    const ratios = src.slice(
      src.indexOf("export async function getOrFetchRatios"),
      src.indexOf(
        "export ",
        src.indexOf("export async function getOrFetchRatios") + 10,
      ),
    );
    assert.match(ratios, /latestRatiosTimestamp\(existing\)/);
    assert.match(ratios, /isStale\(asOf, "ratios"\)/);
    assert.doesNotMatch(
      ratios,
      /isStale\(existing\.fetchedAt/,
      "fetchedAt alone is the frozen analyst clock, not the ratios clock",
    );
  });
});
