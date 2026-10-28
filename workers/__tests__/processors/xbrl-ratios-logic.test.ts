/**
 * MONEY-1235 — the four `xbrl-ratios` decisions that were previously inline
 * expressions inside a Prisma query object, where nothing could assert them.
 *
 * Each `describe` below corresponds to a bug that shipped, ran nightly for a
 * release, and reported a healthy `[job-outcome]` the whole time:
 *
 *   rankRatiosTargets    the rotation never advanced (MONEY-1211 again)
 *   selectPeriodWinners  no basis selection at all, for 70.5% of filers
 *   classifyTtmInputs    "TTM unavailable" hid the fact that ~70% of it was
 *                        one fixable cause
 *   betaExcludeDatesFrom a split inside the window forged a ~ln(2) return
 *
 * The behavioural half — that the batch really does move across nights when the
 * whole processor runs — lives in `xbrl-ratios-rotation.test.ts`. This file is
 * the unit half, and both are needed: a pure ranking function can be perfect
 * while the caller never calls it, which is precisely how the old code got here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectAnnualExtractsByPeriod } from "@usemoney/core/market-data";
import {
  ANNUAL_FILINGS_TAKE,
  ANNUAL_EXTRACT_ROWS_TAKE,
  PRICE_MAX_AGE_DAYS,
  QTY_CHANGING_ACTION_TYPES,
  betaExcludeDatesFrom,
  classifyTtmInputs,
  rankRatiosTargets,
  selectPeriodWinners,
  type RatiosDerivedMarker,
  type RatiosFilingRow,
  type RatiosTargetCandidate,
} from "../../src/processors/xbrl-ratios-logic";

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const inst = (id: string, symbol: string): RatiosTargetCandidate => ({
  id,
  symbol,
  exchange: "NSE",
});

/**
 * Deterministic shuffle. `Math.random` is banned in this repo and would make a
 * failure unreproducible — which for an ordering bug is the whole ballgame.
 */
function rotate<T>(xs: readonly T[], by: number): T[] {
  const k = ((by % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/* ────────────────────────────────────────────────────────────────────────── */

describe("rankRatiosTargets — the nightly rotation", () => {
  const A = inst("i-a", "AAA");
  const B = inst("i-b", "BBB");
  const C = inst("i-c", "CCC");

  it("ranks NEVER-derived instruments ahead of derived ones", () => {
    // C has no marker row at all — the shape of every filing-bearing symbol
    // this job has not yet reached. A and B were derived long ago. Alphabetical
    // order would put C last and it would never be selected.
    const markers: RatiosDerivedMarker[] = [
      { symbol: "AAA", exchange: "NSE", ratiosDerivedAt: utc("2026-08-20") },
      { symbol: "BBB", exchange: "NSE", ratiosDerivedAt: utc("2026-08-19") },
    ];
    const out = rankRatiosTargets([A, B, C], markers, 3);
    assert.deepEqual(
      out.map((t) => t.symbol),
      ["CCC", "BBB", "AAA"],
    );
  });

  it("treats an ABSENT marker and an explicit null identically", () => {
    // The Prisma+Mongo rule that has cost this repo four tickets: a
    // `{ ratiosDerivedAt: null }` WHERE clause matches the explicit null and
    // MISSES the absent field. Ranking on a SELECTED value cannot have that
    // bug, and this asserts the two shapes really do land in the same bucket.
    const out = rankRatiosTargets(
      [A, B, C],
      [
        { symbol: "AAA", exchange: "NSE", ratiosDerivedAt: null }, // explicitly null
        // i-b: no row at all (absent)
        { symbol: "CCC", exchange: "NSE", ratiosDerivedAt: utc("2020-01-01") },
      ],
      3,
    );
    assert.deepEqual(
      out.map((t) => t.symbol),
      ["AAA", "BBB", "CCC"],
      "null and absent must both outrank a real (even ancient) stamp",
    );
  });

  it("orders derived instruments least-recently-first", () => {
    const out = rankRatiosTargets(
      [A, B, C],
      [
        { symbol: "AAA", exchange: "NSE", ratiosDerivedAt: utc("2026-08-20") },
        { symbol: "BBB", exchange: "NSE", ratiosDerivedAt: utc("2026-01-01") },
        { symbol: "CCC", exchange: "NSE", ratiosDerivedAt: utc("2026-06-15") },
      ],
      3,
    );
    assert.deepEqual(
      out.map((t) => t.symbol),
      ["BBB", "CCC", "AAA"],
    );
  });

  it("is a function of the SET, not of the order rows arrived in", () => {
    // Mongo's equal-key order is unspecified. A selection that changes with it
    // is not reproducible, and neither are its bugs.
    const markers: RatiosDerivedMarker[] = [
      { symbol: "AAA", exchange: "NSE", ratiosDerivedAt: utc("2026-08-01") },
      { symbol: "BBB", exchange: "NSE", ratiosDerivedAt: utc("2026-08-01") }, // tie
      { symbol: "CCC", exchange: "NSE", ratiosDerivedAt: utc("2026-08-01") }, // tie
    ];
    const expected = ["AAA", "BBB", "CCC"];
    for (let k = 0; k < 3; k++) {
      const out = rankRatiosTargets(
        rotate([A, B, C], k),
        rotate(markers, k),
        3,
      );
      assert.deepEqual(
        out.map((t) => t.symbol),
        expected,
        `rotation ${k} produced a different batch`,
      );
    }
  });

  it("treats an Invalid Date as never-derived rather than as time 0", () => {
    // NaN compares false against everything, so a naive numeric sort scatters
    // such a row unpredictably through the batch.
    const out = rankRatiosTargets(
      [A, B],
      [
        {
          symbol: "AAA",
          exchange: "NSE",
          ratiosDerivedAt: new Date("not-a-date"),
        },
        { symbol: "BBB", exchange: "NSE", ratiosDerivedAt: utc("2020-01-01") },
      ],
      2,
    );
    assert.deepEqual(
      out.map((t) => t.symbol),
      ["AAA", "BBB"],
    );
  });

  it("cuts to the limit and never returns more", () => {
    const out = rankRatiosTargets([A, B, C], [], 2);
    assert.equal(out.length, 2);
    assert.deepEqual(rankRatiosTargets([A, B, C], [], 0), []);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("selectPeriodWinners — one filing per reported period", () => {
  const row = (over: Partial<RatiosFilingRow>): RatiosFilingRow => ({
    id: "f1",
    periodEnd: utc("2025-03-31"),
    periodType: "ANNUAL",
    cumulative: false,
    basis: "CONSOLIDATED",
    coverage: 0.8,
    filedAt: utc("2025-05-01"),
    sourceUrl: "https://nse/f1.xml",
    ...over,
  });

  it("CONSOLIDATED beats STANDALONE for the same period", () => {
    // 1,486 of 2,108 symbols (70.5%) file both for their newest year, and the
    // two differ by a MULTIPLE for any holding company. AMBUJACEM FY2025:
    // 13,964.95 standalone vs 28,965.46 consolidated.
    const consol = row({ id: "c", basis: "CONSOLIDATED" });
    const standalone = row({ id: "s", basis: "STANDALONE" });
    for (const input of [
      [consol, standalone],
      [standalone, consol],
    ]) {
      const out = selectPeriodWinners(input);
      assert.equal(out.length, 1, "one period must yield one winner");
      assert.equal(out[0]!.id, "c");
    }
  });

  it("keeps a CUMULATIVE row separate from the discrete quarter it shares an end with", () => {
    // A nine-month YTD column and Q3 share a `periodEnd`. Merging them lets the
    // basis tie-break return the YTD row and silently triple a quarter.
    const discrete = row({
      id: "q3",
      periodType: "QUARTERLY",
      periodEnd: utc("2024-12-31"),
      cumulative: false,
    });
    const ytd = row({
      id: "ytd",
      periodType: "QUARTERLY",
      periodEnd: utc("2024-12-31"),
      cumulative: true,
    });
    const out = selectPeriodWinners([ytd, discrete]);
    assert.equal(out.length, 2, "these are two different facts");
    assert.equal(out[0]!.id, "q3", "the discrete quarter sorts first");
    assert.equal(out[1]!.id, "ytd");
  });

  it("prefers ANNUAL over QUARTERLY at the SAME period end", () => {
    // Indian filers publish Q4 and the full year on the same date.
    // `planRatiosWrite` refuses roe/roa/roce/revenueGrowth/earningsGrowth unless
    // told ANNUAL, so under the old arbitrary pick whether a company got a ROCE
    // at all depended on which row Mongo returned first.
    // The ids are chosen so the LAST-RESORT `id` tie-break would pick the
    // QUARTERLY row. Only the period-type rank can put the annual first, so a
    // mutation that neutralises it turns this red instead of passing by luck.
    const annual = row({ id: "zz-annual", periodType: "ANNUAL" });
    const q4 = row({ id: "aa-q4", periodType: "QUARTERLY" });
    for (const input of [
      [q4, annual],
      [annual, q4],
    ]) {
      assert.equal(selectPeriodWinners(input)[0]!.id, "zz-annual");
    }
  });

  it("returns newest-first and is invariant under input rotation", () => {
    const rows = [
      row({ id: "y2023", periodEnd: utc("2023-03-31") }),
      row({ id: "y2024", periodEnd: utc("2024-03-31") }),
      row({ id: "y2025", periodEnd: utc("2025-03-31") }),
      // …each with a standalone twin, the 70.5% case.
      row({
        id: "y2023s",
        periodEnd: utc("2023-03-31"),
        basis: "STANDALONE",
      }),
      row({
        id: "y2024s",
        periodEnd: utc("2024-03-31"),
        basis: "STANDALONE",
      }),
      row({
        id: "y2025s",
        periodEnd: utc("2025-03-31"),
        basis: "STANDALONE",
      }),
    ];
    const expected = ["y2025", "y2024", "y2023"];
    for (let k = 0; k < rows.length; k++) {
      const out = selectPeriodWinners(rotate(rows, k));
      assert.deepEqual(
        out.map((r) => r.id),
        expected,
        `rotation ${k} changed the winners`,
      );
    }
  });

  it("falls back through coverage, filedAt and sourceUrl on a basis tie", () => {
    // The tie-break chain belongs to `selectFilingForPeriod`; this asserts the
    // grouping actually HANDS it every candidate rather than pre-picking one.
    const thin = row({ id: "thin", coverage: 0.2 });
    const rich = row({ id: "rich", coverage: 0.9 });
    assert.equal(selectPeriodWinners([thin, rich])[0]!.id, "rich");
  });

  it("ANNUAL_FILINGS_TAKE covers 6 fiscal years at the dual-basis factor", () => {
    // MONEY-1207: a take counted in ROWS over a population where one logical
    // unit occupies several rows returns fewer distinct units than asked for.
    // 5Y CAGR needs 6 points; 70.5% of filers publish two rows per year.
    assert.ok(
      ANNUAL_FILINGS_TAKE >= 6 * 2,
      `take ${ANNUAL_FILINGS_TAKE} cannot yield 6 winners for a dual-basis filer`,
    );
  });

  it("yields >= 6 WINNERS from a full dual-basis take", () => {
    const rows: RatiosFilingRow[] = [];
    for (let y = 0; y < ANNUAL_FILINGS_TAKE / 2; y++) {
      for (const basis of ["CONSOLIDATED", "STANDALONE"]) {
        rows.push(
          row({
            id: `${2025 - y}-${basis}`,
            periodEnd: utc(`${2025 - y}-03-31`),
            basis,
          }),
        );
      }
    }
    assert.equal(rows.length, ANNUAL_FILINGS_TAKE, "fixture size sanity");
    assert.ok(
      selectPeriodWinners(rows).length >= 6,
      "a full take must still supply the 6 points a 5Y CAGR needs",
    );
  });

  /* ── MONEY-1346: the EXTRACT table's factor is worse, and measured ─────── */

  it("ANNUAL_EXTRACT_ROWS_TAKE yields 6 periods at the MEASURED factor of 4", () => {
    // The extract table keys on `(documentId, periodEnd, periodType, basis)`,
    // not on basis alone — an annual report prints the prior year as its
    // comparative, so FY2025 appears again in the FY2026 report, on both
    // bases, from two different documents.
    //
    // MEASURED on prod 2026-09-05 over 1,288 instruments: rows per
    // (instrument, periodEnd) run 1 -> 1,551 groups, 2 -> 770, 3 -> 3,
    // 4 -> 17. So FOUR is the observed worst case, not the two the filing
    // table can produce, and `take: 8` returned as few as TWO distinct
    // periods.
    const rows = [];
    for (let y = 0; y < 6; y++) {
      for (let dup = 0; dup < 4; dup++) {
        rows.push({
          periodEnd: utc(`${2025 - y}-03-31`),
          periodType: "ANNUAL",
          basis: dup % 2 === 0 ? "CONSOLIDATED" : "STANDALONE",
        });
      }
    }
    assert.equal(rows.length, 24, "six years at the measured worst case");
    assert.ok(
      ANNUAL_EXTRACT_ROWS_TAKE >= rows.length,
      `take ${ANNUAL_EXTRACT_ROWS_TAKE} cannot reach 6 periods at 4 rows each`,
    );
    // The behaviour, not just the arithmetic: slice as the query would and
    // collapse as the reader does.
    const selected = selectAnnualExtractsByPeriod(
      rows.slice(0, ANNUAL_EXTRACT_ROWS_TAKE) as never,
    );
    assert.equal(
      selected.length,
      6,
      "a full take must supply the 6 points a 5Y CAGR needs",
    );
    // And the old value provably could not: this is the defect, reproduced.
    assert.equal(
      selectAnnualExtractsByPeriod(rows.slice(0, 8) as never).length,
      2,
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("classifyTtmInputs — WHY a TTM died", () => {
  const q = (basis: string) => ({ basis });

  it("names mixed basis, which is the ~70% case", () => {
    // Two quarters × two bases is what `filter(QUARTERLY).slice(0, 4)` used to
    // hand `deriveTtm` for a dual-basis filer. It refused, correctly — and `pe`
    // and `evToEbitda` were then null for 70% of filers with no counter saying
    // so.
    assert.equal(
      classifyTtmInputs(
        [
          q("CONSOLIDATED"),
          q("STANDALONE"),
          q("CONSOLIDATED"),
          q("STANDALONE"),
        ],
        0,
      ),
      "mixed-basis",
    );
  });

  it("separates 'never filed a quarter' from 'filed too few'", () => {
    assert.equal(classifyTtmInputs([], 0), "no-quarters");
    assert.equal(
      classifyTtmInputs([q("CONSOLIDATED"), q("CONSOLIDATED")], 0),
      "insufficient-quarters",
    );
  });

  it("separates an unreadable facts blob from a genuine absence", () => {
    assert.equal(classifyTtmInputs([], 3), "unreadable-facts");
  });

  it("passes a clean four-quarter single-basis set through", () => {
    assert.equal(
      classifyTtmInputs(
        [
          q("CONSOLIDATED"),
          q("CONSOLIDATED"),
          q("CONSOLIDATED"),
          q("CONSOLIDATED"),
        ],
        0,
      ),
      null,
      "deriveTtm still judges contiguity and span — this only classifies inputs",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("betaExcludeDatesFrom — the split artefact", () => {
  it("keeps an 18:30Z ex-date whose IST day is the FIRST day of the window", () => {
    // MONEY-1527. The existing cases below use dates YEARS outside the window,
    // so they cannot discriminate one day — reverting the slack left them all
    // green. This one sits exactly on the boundary.
    //
    // Prod stores `exDate` in two conventions 5h30m apart. An action whose IST
    // calendar day IS `since` is stamped 18:30Z on the day BEFORE, so a bare
    // `exDate < since` drops it — and its bar is inside the series, so the
    // split's ~-90% log return is regressed with nothing excluded.
    const since = utc("2024-01-02");
    const istMidnightOfSince = new Date(since.getTime() - 5.5 * 60 * 60 * 1000);
    assert.ok(
      istMidnightOfSince < since,
      "the fixture must sit before `since` on the raw instant",
    );

    const out = betaExcludeDatesFrom(
      [{ exDate: istMidnightOfSince, type: "SPLIT" }],
      since,
    );
    assert.equal(
      out.length,
      1,
      "an ex-date on the window's first IST day must survive the filter",
    );
  });

  it("still drops an action genuinely outside the window", () => {
    // The slack is one day, not an open door.
    const since = utc("2024-01-02");
    const out = betaExcludeDatesFrom(
      [{ exDate: utc("2023-12-25"), type: "SPLIT" }],
      since,
    );
    assert.equal(out.length, 0);
  });

  const since = utc("2024-08-21");

  it("selects only the qty-changing action types", () => {
    const out = betaExcludeDatesFrom(
      [
        { exDate: utc("2025-01-10"), type: "SPLIT" },
        { exDate: utc("2025-02-10"), type: "BONUS" },
        { exDate: utc("2025-03-10"), type: "DEMERGER" },
        // A dividend's ex-date drop is a REAL return. Dropping it would discard
        // market data to guard against an artefact that is not there.
        { exDate: utc("2025-04-10"), type: "DIVIDEND" },
        { exDate: utc("2025-05-10"), type: "BUYBACK" },
        { exDate: utc("2025-06-10"), type: null },
      ],
      since,
    );
    assert.deepEqual(
      out.map((d) => d.toISOString().slice(0, 10)),
      ["2025-01-10", "2025-02-10", "2025-03-10"],
    );
  });

  it("drops actions before the window and unparseable ex-dates", () => {
    const out = betaExcludeDatesFrom(
      [
        { exDate: utc("2020-01-01"), type: "SPLIT" }, // outside the window
        { exDate: new Date("nonsense"), type: "SPLIT" },
      ],
      since,
    );
    assert.deepEqual(out, []);
  });

  it("declares the type set explicitly rather than by negation", () => {
    assert.deepEqual([...QTY_CHANGING_ACTION_TYPES].sort(), [
      "BONUS",
      "DEMERGER",
      "SPLIT",
    ]);
  });
});

describe("PRICE_MAX_AGE_DAYS", () => {
  it("permits a holiday-Monday reach-back but not a suspended counter", () => {
    // A weekend either side of a mid-week holiday cluster is the longest run of
    // consecutive non-trading days an Indian calendar produces.
    assert.ok(PRICE_MAX_AGE_DAYS >= 4, "must survive a long holiday weekend");
    assert.ok(
      PRICE_MAX_AGE_DAYS <= 14,
      "a suspended instrument must fall out within a couple of weeks, not " +
        "keep collecting a fresh ratiosDerivedAt off an arbitrarily old close",
    );
  });
});

describe("rankRatiosTargets — the cursor key must match the WRITE key", () => {
  const A = inst("i-a", "AAA");
  const B = inst("i-b", "BBB");

  it("REGRESSION: a marker whose instrumentId is FOREIGN still counts", () => {
    // THE DEFECT (MONEY-1235). The cursor was READ by `instrumentId` and
    // WRITTEN by `symbol_exchange`, and the upsert's `update:` branch never
    // sets `instrumentId` — so an existing row keeps whatever it already had.
    //
    // `sync-prod-to-qa.sh` delivers `stock_ratios` into QA carrying PROD's
    // ObjectIds while `instrument_mappings` is QA-DIRECT with its own, and
    // `repair-instrument-links.ts` is a separate manual `--apply`-gated step.
    // Until it runs, EVERY marker lookup missed: the row was stamped nightly,
    // the ranker never found it, the instrument stayed rank-0 forever and the
    // same first N symbols were re-derived every night — MONEY-1211 exactly.
    //
    // `cursorUnstampable` could not catch it, because the write genuinely
    // succeeded. Only a key mismatch shows it, which is what this fixture is:
    // the marker's identity is the SYMBOL, and the ObjectId is deliberately
    // one that matches no candidate.
    const markers: RatiosDerivedMarker[] = [
      { symbol: "AAA", exchange: "NSE", ratiosDerivedAt: utc("2026-08-20") },
    ];
    const out = rankRatiosTargets([A, B], markers, 2);
    // BBB has no marker (never derived) so it leads; AAA was derived yesterday
    // and goes to the back. Under the old instrumentId keying AAA's marker was
    // invisible, both looked never-derived, and the tie fell to symbol order —
    // putting AAA first every single night.
    assert.deepEqual(
      out.map((t) => t.symbol),
      ["BBB", "AAA"],
    );
  });

  it("distinguishes the same symbol on different exchanges", () => {
    // The key is the TUPLE, not the symbol — `@@unique([symbol, exchange])`.
    const nse = { id: "i-1", symbol: "DUAL", exchange: "NSE" };
    const bse = { id: "i-2", symbol: "DUAL", exchange: "BSE" };
    const markers: RatiosDerivedMarker[] = [
      { symbol: "DUAL", exchange: "NSE", ratiosDerivedAt: utc("2026-08-20") },
    ];
    const out = rankRatiosTargets([nse, bse], markers, 2);
    assert.deepEqual(
      out.map((t) => t.exchange),
      ["BSE", "NSE"],
      "the BSE listing is never-derived and must lead",
    );
  });
});
