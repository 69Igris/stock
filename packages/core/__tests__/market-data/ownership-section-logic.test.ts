/**
 * UNIT TEST — ownership sections for the stock page (MONEY-1204, P14 14c.4/5/6).
 *
 * These are behavioural tests, not shape tests: every case below is a wrong
 * answer the section could plausibly give, written so that the obvious lazy
 * implementation FAILS.
 *
 * The cases that carry the weight:
 *
 *   1. `NSE wins whole and is not merged with Tickertape` — the two tables
 *      describe the same quarters with quarter strings that DO NOT JOIN
 *      (`2026-03` vs `Q4-2026`). A merge would interleave two providers inside
 *      one series with a single source label on it.
 *   2. `a Tickertape-only symbol is flagged fallback` — an unlabelled fallback
 *      is a silent downgrade, and `fallback` is the flag the chip renders from.
 *   3. `nulls stay null` — `-`/blank means NOT REPORTED. `Number("")` is 0, and
 *      a 0 promoter pledge is an all-clear the filer never gave.
 *   4. `a QoQ delta does not step over a missing quarter` — comparing across a
 *      gap prints a six-month move as a quarter-on-quarter one.
 *   5. `canonical YYYY-MM quarters sort` — the pre-existing rank function in
 *      stock-tabs.ts scores every month of a year identically, so this needed
 *      its own parser and the test pins it.
 *   6. `an unrecognised insider action survives` — upstream stores unknown
 *      source text verbatim with no OTHER bucket; dropping or renaming it is
 *      how a new SEBI transaction type disappears from the UI.
 *   7. `the 90-day net excludes pledges and undisclosed quantities` — a pledge
 *      moves no shares, and a null qty is not a zero one.
 *   8. `repeat buyer at exactly 2 prints and exactly 90 days` — both boundaries,
 *      from both sides, because an exclusive bound makes "90 days" mean 89.
 *
 * Everything is synchronous with an injected `now`: no timers, no clock races,
 * nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANNOUNCEMENT_DOC_TYPES,
  buildDealsSection,
  buildInsiderSection,
  buildPledgeTrend,
  buildShareholdingSection,
  computeQoqDeltas,
  dealSide,
  dealTextOrNull,
  detectRepeatClients,
  groupInsiderEventsByMonth,
  insiderActionLabel,
  insiderDirection,
  insiderPersonLabel,
  matchLikelyDocument,
  netInsiderActivity,
  normalizeClientName,
  normalizeNseShareholding,
  normalizeTickertapeShareholding,
  quarterEndDate,
  quarterSortRank,
  readOwnershipPct,
  shareholdingQuarterLabel,
  sortShareholdingNewestFirst,
  type DealInput,
  type InsiderEventInput,
  type NseShareholdingRow,
  type ShareholdingObservation,
  type StockDocumentInput,
  type TickertapeShareholdingRow,
} from "../../src/market-data/ownership-section-logic";

// ════════════════════════════════════════════════════════════════════════════
// Absence primitives
// ════════════════════════════════════════════════════════════════════════════

describe("14c.4 absence: readOwnershipPct", () => {
  it("blank and sentinel inputs are null, and a reported zero survives", () => {
    // The whole point: `Number("")` is 0 and `Number("-")` is NaN. Neither may
    // reach the UI as a percentage.
    for (const blank of [
      "",
      "  ",
      "-",
      "--",
      "NA",
      "N/A",
      "NIL",
      null,
      undefined,
    ]) {
      assert.equal(
        readOwnershipPct(blank),
        null,
        `${String(blank)} must be null`,
      );
    }
    // A filer who reported zero pledge said something, and it is not "unknown".
    assert.equal(readOwnershipPct(0), 0);
    assert.equal(readOwnershipPct("0"), 0);
    assert.equal(readOwnershipPct("0.00"), 0);
  });

  it("parses numeric strings with separators, rejects non-finite", () => {
    assert.equal(readOwnershipPct("54.31"), 54.31);
    assert.equal(readOwnershipPct("1,234.5"), 1234.5);
    assert.equal(readOwnershipPct("12.5%"), 12.5);
    assert.equal(readOwnershipPct(Number.NaN), null);
    assert.equal(readOwnershipPct(Number.POSITIVE_INFINITY), null);
    assert.equal(readOwnershipPct("abc"), null);
  });
});

describe("14c.6 absence: dealTextOrNull", () => {
  it("`-`, blank and a missing column all become null — never the string 'null'", () => {
    assert.equal(dealTextOrNull("-"), null);
    assert.equal(dealTextOrNull(""), null);
    assert.equal(dealTextOrNull("   "), null);
    assert.equal(dealTextOrNull(null), null);
    assert.equal(dealTextOrNull(undefined), null);
    assert.equal(dealTextOrNull("null"), null);
    assert.equal(dealTextOrNull("Market Trade"), "Market Trade");
    assert.equal(dealTextOrNull("  Market   Trade  "), "Market Trade");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.4 — quarter ordering
// ════════════════════════════════════════════════════════════════════════════

describe("14c.4 quarterSortRank", () => {
  it("ranks canonical YYYY-MM quarters apart (the stock-tabs rank cannot)", () => {
    // stock-tabs.ts#sortQuartersNewestFirst scores `year*10 + quarterOrMonth`,
    // and for "2026-03" it finds no Q<n> and no month NAME, so 2026-03,
    // 2026-06, 2026-09 and 2026-12 all score 20260 and tie.
    const ranks = ["2026-03", "2026-06", "2026-09", "2026-12"].map(
      quarterSortRank,
    );
    assert.deepEqual(ranks, [
      2026 * 12 + 3,
      2026 * 12 + 6,
      2026 * 12 + 9,
      2026 * 12 + 12,
    ]);
    assert.equal(new Set(ranks).size, 4, "no two canonical quarters may tie");
  });

  it("ranks Tickertape's free-form labels, year before quarter", () => {
    const q4of2020 = quarterSortRank("Q4-2020");
    const q1of2025 = quarterSortRank("Q1-2025");
    assert.ok(q4of2020 !== null && q1of2025 !== null);
    assert.ok(
      (q1of2025 as number) > (q4of2020 as number),
      "Q1-2025 is newer than Q4-2020",
    );
    assert.equal(quarterSortRank("2024-Q2"), 2024 * 12 + 6);
    assert.equal(quarterSortRank("Mar 2024"), 2024 * 12 + 3);
  });

  it("returns null for an unrecoverable label instead of guessing", () => {
    assert.equal(quarterSortRank(""), null);
    assert.equal(quarterSortRank("LATEST"), null);
    assert.equal(quarterSortRank("2026-13"), null);
  });

  it("dates a quarter to its END, which is what `asOf` is stamped from", () => {
    // `asOf` must describe the DATA, not our fetch time. A quarter that sorts
    // must therefore also date, or the section falls back to stamping the copy
    // time — the exact lie the provenance envelope exists to prevent.
    assert.equal(
      quarterEndDate("2026-03")?.toISOString(),
      "2026-03-31T00:00:00.000Z",
    );
    assert.equal(
      quarterEndDate("2025-12")?.toISOString(),
      "2025-12-31T00:00:00.000Z",
    );
    assert.equal(
      quarterEndDate("Q2-2024")?.toISOString(),
      "2024-06-30T00:00:00.000Z",
    );
    assert.equal(quarterEndDate("LATEST"), null);
  });

  it("labels canonical quarters and leaves anything else verbatim", () => {
    assert.equal(shareholdingQuarterLabel("2026-03"), "Mar 2026");
    assert.equal(shareholdingQuarterLabel("Q3-2024"), "Q3-2024");
    assert.equal(shareholdingQuarterLabel("  2025-12 "), "Dec 2025");
  });

  it("sorts newest first and parks unrankable labels at the end in input order", () => {
    const rows: ShareholdingObservation[] = [
      "2025-03",
      "LATEST",
      "2026-03",
      "STALE",
      "2025-12",
    ].map((quarter) => ({
      quarter,
      label: quarter,
      // This case is about ORDERING, not provenance. `source` is nullable and
      // a null here says "no filing behind this fixture" rather than inventing
      // an exchange the assertions would then ignore.
      source: null,
      promoterPct: 1,
      pledgedPct: null,
      fiiPct: null,
      diiPct: null,
      publicPct: null,
    }));
    assert.deepEqual(
      sortShareholdingNewestFirst(rows).map((r) => r.quarter),
      ["2026-03", "2025-12", "2025-03", "LATEST", "STALE"],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.4 — source precedence
// ════════════════════════════════════════════════════════════════════════════

const NSE_ROWS: NseShareholdingRow[] = [
  {
    quarter: "2026-03",
    promoterPct: 50.1,
    pledgedPct: 2.5,
    fiiPct: 20,
    diiPct: 15,
    publicPct: 14.9,
  },
  {
    quarter: "2025-12",
    promoterPct: 50.4,
    pledgedPct: 3,
    fiiPct: 19,
    diiPct: 15.5,
    publicPct: 15.1,
  },
];

const TT_ROWS: TickertapeShareholdingRow[] = [
  {
    quarter: "Q4-2026",
    promoter: 49.9,
    fii: 21,
    dii: 14,
    public: 15.1,
    pledgedPercent: 2.1,
  },
  {
    quarter: "Q3-2026",
    promoter: 49.5,
    fii: 20.5,
    dii: 14.5,
    public: 15.5,
    pledgedPercent: 2.2,
  },
];

describe("14c.4 precedence: NSE primary, Tickertape fallback", () => {
  it("given BOTH, NSE wins whole and `fallback` is false", () => {
    const out = buildShareholdingSection({
      nse: NSE_ROWS,
      tickertape: TT_ROWS,
    });
    assert.equal(out.source, "NSE_SHP");
    assert.equal(out.fallback, false);
    assert.deepEqual(
      out.quarters.map((q) => q.quarter),
      ["2026-03", "2025-12"],
    );
    // The decisive assertion: not one Tickertape quarter leaked into the series.
    // The two tables' quarter strings do not join, so a merge would show four
    // rows under one "NSE" label.
    assert.equal(
      out.quarters.some((q) => q.quarter.startsWith("Q")),
      false,
      "no Tickertape quarter may appear when NSE has rows",
    );
    assert.equal(out.quarters.length, 2);
  });

  it("given ONLY Tickertape, it is served AND labelled fallback", () => {
    const out = buildShareholdingSection({ nse: [], tickertape: TT_ROWS });
    assert.equal(out.source, "TICKERTAPE");
    assert.equal(out.fallback, true);
    assert.deepEqual(
      out.quarters.map((q) => q.quarter),
      ["Q4-2026", "Q3-2026"],
    );
    assert.equal(out.quarters[0]?.promoterPct, 49.9);
    // Tickertape's `pledgedPercent` must land on the same field name the NSE
    // series uses, or the pledge chart silently empties on the fallback path.
    assert.equal(out.quarters[0]?.pledgedPct, 2.1);
  });

  it("given NEITHER, source is null and nothing is fabricated", () => {
    const out = buildShareholdingSection({ nse: [], tickertape: [] });
    assert.equal(out.source, null);
    assert.equal(out.fallback, false);
    assert.deepEqual(out.quarters, []);
    assert.deepEqual(out.pledgeTrend, []);
  });

  it("an all-null NSE row does not suppress a populated Tickertape series", () => {
    // A row with every percentage blank carries no information. Counting it as
    // "NSE has data" would show an empty panel wearing a confident NSE label
    // while a usable fallback sat unused.
    const hollow: NseShareholdingRow[] = [
      {
        quarter: "2026-03",
        promoterPct: null,
        pledgedPct: null,
        fiiPct: null,
        diiPct: null,
        publicPct: null,
      },
    ];
    const out = buildShareholdingSection({ nse: hollow, tickertape: TT_ROWS });
    assert.equal(out.source, "TICKERTAPE");
    assert.equal(out.fallback, true);
  });

  it("null percentages stay null through the whole pipeline — never 0", () => {
    const rows: NseShareholdingRow[] = [
      {
        quarter: "2026-03",
        promoterPct: 50,
        // Not reported. `?? 0` here is how an undisclosed pledge becomes an
        // all-clear; the value must survive as null all the way to the wire.
        pledgedPct: null,
        fiiPct: 0, // a REPORTED zero — must NOT be conflated with the null above
        diiPct: null,
        publicPct: null,
      },
    ];
    const out = buildShareholdingSection({ nse: rows, tickertape: [] });
    const q = out.quarters[0];
    assert.ok(q);
    assert.equal(q.pledgedPct, null);
    assert.equal(q.fiiPct, 0);
    assert.notEqual(q.pledgedPct, 0);
    assert.equal(out.pledgeTrend[0]?.pledgedPct, null);
  });

  it("normalizers map both column vocabularies onto one shape", () => {
    assert.equal(
      normalizeNseShareholding([{ quarter: "2026-03", promoterPct: 1 }])[0]
        ?.promoterPct,
      1,
    );
    assert.equal(
      normalizeTickertapeShareholding([{ quarter: "Q1-2026", promoter: 2 }])[0]
        ?.promoterPct,
      2,
    );
    // A row with no quarter cannot be keyed or plotted; it is dropped, not
    // given an empty label.
    assert.equal(
      normalizeNseShareholding([{ quarter: "  ", promoterPct: 1 }]).length,
      0,
    );
  });

  it("caps the series at maxQuarters, newest kept", () => {
    const many: NseShareholdingRow[] = Array.from({ length: 20 }, (_, i) => ({
      quarter: `20${String(10 + i).padStart(2, "0")}-03`,
      promoterPct: 40 + i,
    }));
    const out = buildShareholdingSection({
      nse: many,
      tickertape: [],
      maxQuarters: 4,
    });
    assert.equal(out.quarters.length, 4);
    assert.equal(out.quarters[0]?.quarter, "2029-03");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.4 — QoQ deltas + pledge trend
// ════════════════════════════════════════════════════════════════════════════

function obs(
  quarter: string,
  promoterPct: number | null,
  pledgedPct: number | null = null,
): ShareholdingObservation {
  return {
    quarter,
    label: quarter,
    // Deltas and pledge series are computed from the percentages alone, so the
    // shared fixture carries no source. Nullable by design — see
    // ShareholdingObservation.source.
    source: null,
    promoterPct,
    pledgedPct,
    fiiPct: null,
    diiPct: null,
    publicPct: null,
  };
}

describe("14c.4 computeQoqDeltas", () => {
  it("subtracts the immediately older quarter", () => {
    const out = computeQoqDeltas([obs("2026-03", 50.1), obs("2025-12", 50.4)]);
    assert.equal(out[0]?.deltas.promoterPct, -0.3);
    // Oldest quarter has nothing to compare against — null, not 0.
    assert.equal(out[1]?.deltas.promoterPct, null);
  });

  it("does NOT step over a quarter that did not report the field", () => {
    // Series: Mar-26 = 50, Dec-25 = NOT REPORTED, Sep-25 = 45.
    // Comparing Mar-26 against Sep-25 would print +5 and call it a QUARTERLY
    // move when it spans two quarters. The honest answer is "unknown".
    const out = computeQoqDeltas([
      obs("2026-03", 50),
      obs("2025-12", null),
      obs("2025-09", 45),
    ]);
    assert.equal(out[0]?.deltas.promoterPct, null, "gap must not be skipped");
    assert.notEqual(out[0]?.deltas.promoterPct, 5);
    assert.equal(out[1]?.deltas.promoterPct, null, "current is null");
    assert.equal(out[2]?.deltas.promoterPct, null, "no older quarter");
  });

  it("does NOT step over a quarter that is ABSENT from the series", () => {
    // B4 — the previous test covers a null FIELD on a PRESENT row. This is the
    // other absence: the row itself never arrived. Positional `[i+1]` compares
    // Jun-26 against Sep-25 and labels a NINE-MONTH move as quarter-on-quarter.
    const out = computeQoqDeltas([obs("2026-06", 62), obs("2025-09", 74)]);
    assert.equal(out[0]?.deltas.promoterPct, null, "not a quarterly move");
    assert.notEqual(out[0]?.deltas.promoterPct, -12);
  });

  it("does not invent a pledge event across an absent quarter", () => {
    // The pledge case is the damaging one: a published 0 → 40 renders as
    // "+40 this quarter" on a promoter who pledged over three quarters.
    const out = computeQoqDeltas([
      obs("2026-06", 62, 40),
      obs("2025-09", 74, 0),
    ]);
    assert.equal(out[0]?.deltas.pledgedPct, null);
    assert.notEqual(out[0]?.deltas.pledgedPct, 40);
  });

  it("still compares two genuinely adjacent quarters", () => {
    // The guard is adjacency, not "any gap at all" — consecutive quarters in
    // any accepted label form must still produce their delta.
    const adjacent = computeQoqDeltas([obs("2026-06", 62), obs("2026-03", 60)]);
    assert.equal(adjacent[0]?.deltas.promoterPct, 2);
    const yearEnd = computeQoqDeltas([obs("2026-03", 62), obs("2025-12", 60)]);
    assert.equal(yearEnd[0]?.deltas.promoterPct, 2);
  });

  it("refuses a delta when a quarter label cannot be ranked at all", () => {
    // `normalizeQuarter` stores an unparseable label VERBATIM ("Q1FY26"), and a
    // label we cannot place in time cannot be shown to be the previous quarter.
    const out = computeQoqDeltas([obs("2026-06", 62), obs("Q1FY26", 60)]);
    assert.equal(out[0]?.deltas.promoterPct, null);
  });

  it("a reported zero is a real delta, not a missing one", () => {
    const out = computeQoqDeltas([obs("2026-03", 0), obs("2025-12", 2)]);
    assert.equal(out[0]?.deltas.promoterPct, -2);
  });

  it("rounds away float artefacts", () => {
    const out = computeQoqDeltas([obs("2026-03", 0.3), obs("2025-12", 0.1)]);
    assert.equal(out[0]?.deltas.promoterPct, 0.2); // not 0.19999999999999998
  });

  it("pledge trend is oldest-first and keeps nulls as gaps", () => {
    const trend = buildPledgeTrend([
      obs("2026-03", 50, 2.5),
      obs("2025-12", 50, null),
      obs("2025-09", 50, 3),
    ]);
    assert.deepEqual(
      trend.map((p) => p.quarter),
      ["2025-09", "2025-12", "2026-03"],
    );
    assert.deepEqual(
      trend.map((p) => p.pledgedPct),
      [3, null, 2.5],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.5 — insider activity
// ════════════════════════════════════════════════════════════════════════════

const NOW = new Date("2026-08-15T00:00:00.000Z");
const daysAgo = (n: number): Date =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("14c.5 insiderDirection / insiderActionLabel", () => {
  it("classifies the five known actions", () => {
    assert.equal(insiderDirection("BUY"), "BUY");
    assert.equal(insiderDirection("SELL"), "SELL");
    assert.equal(insiderDirection("PLEDGE_CREATION"), "PLEDGE");
    assert.equal(insiderDirection("PLEDGE_RELEASE"), "PLEDGE");
    assert.equal(insiderDirection("PLEDGE_INVOCATION"), "PLEDGE");
  });

  it("an unrecognised action is UNKNOWN, not silently a BUY", () => {
    // Upstream deliberately has no OTHER bucket: unknown source text is stored
    // VERBATIM. Anything that guesses a direction here would net a transaction
    // whose sign nobody knows.
    assert.equal(insiderDirection("ENCUMBRANCE OTHER THAN PLEDGE"), "UNKNOWN");
    assert.equal(insiderDirection(""), "UNKNOWN");
  });

  it("renders an unknown action verbatim rather than dropping or renaming it", () => {
    assert.equal(insiderActionLabel("BUY"), "Buy");
    assert.equal(insiderActionLabel("PLEDGE_INVOCATION"), "Pledge invoked");
    assert.equal(
      insiderActionLabel("ENCUMBRANCE OTHER THAN PLEDGE"),
      "ENCUMBRANCE OTHER THAN PLEDGE",
    );
    assert.equal(insiderActionLabel(""), "Not stated");
  });
});

// ── MONEY-1205 · `category` outranks `action` for pledges ───────────────────
//
// NSE's `/api/corporate-pledgedata` publishes NO event-type field and NO
// pledgor column. The parser was not misreading them; they do not exist.
// Measured on prod 2026-08-17: all 5,734 `category: "PLEDGE"` rows carry
// `action: ""` and all 5,734 carry `person: ""`. Reading `action` alone
// therefore classified the ENTIRE pledge feed as UNKNOWN, and every pledged
// stock in the market told its reader it held "N filings with an unrecognised
// transaction type" — while naming nobody as the pledgor, which read as a
// filer withholding a field that was never published.
//
// The rows are also not filings at all: they are a DAILY COMPANY SNAPSHOT of a
// running `numSharesPledged` total. Calling a re-statement of one standing
// position an "event" invents an event; counting sixty of them invents sixty.
//
// The real pledge FILINGS are a disjoint set and must keep their own wording:
// on prod they arrive under `category: "PIT"` with explicit actions (209
// `PLEDGE`, 143 `PLEDGE INVOKE`, 220 `PLEDGE REVOKE`). No row in the database
// is both.
describe("MONEY-1205 insiderDirection/label — the pledge snapshot feed", () => {
  it("[regression] a PLEDGE-category row is PLEDGE even with an empty action", () => {
    // The whole bug in one assertion. Every row in the feed looks like this.
    assert.equal(insiderDirection("", "PLEDGE"), "PLEDGE");
    assert.equal(
      insiderDirection("", ""),
      "UNKNOWN",
      "an empty action WITHOUT the category is still genuinely unknown",
    );
  });

  it("the category wins regardless of what the action says", () => {
    // "Regardless of `action`" is the stated rule, so an action that would
    // otherwise net as a BUY must not net at all on a pledge row.
    assert.equal(insiderDirection("BUY", "PLEDGE"), "PLEDGE");
    assert.equal(insiderDirection("SELL", "PLEDGE"), "PLEDGE");
    assert.equal(insiderDirection("ANYTHING ELSE", "PLEDGE"), "PLEDGE");
  });

  it("is case- and whitespace-insensitive on the category", () => {
    assert.equal(insiderDirection("", " pledge "), "PLEDGE");
  });

  it("[regression] real pledge FILINGS are untouched by the category rule", () => {
    // These are the disjoint set: prod files them under PIT with a real action.
    // They ARE events that happened on a day, and they must keep classifying
    // through the action path.
    assert.equal(insiderDirection("PLEDGE INVOKE", "PIT"), "PLEDGE");
    assert.equal(insiderDirection("PLEDGE REVOKE", "PIT"), "PLEDGE");
    assert.equal(insiderDirection("BUY", "PIT"), "BUY");
    assert.equal(insiderDirection("SELL", "SAST"), "SELL");
  });

  it("labels an empty pledge action as a position update, not 'Not stated'", () => {
    // "Not stated" is a claim about NSE — that a transaction type exists and
    // the filer withheld it. There is no such field to withhold.
    assert.equal(insiderActionLabel("", "PLEDGE"), "Pledge position update");
    assert.equal(
      insiderActionLabel("", "PIT"),
      "Not stated",
      "elsewhere an empty action really is a blank we expected filled",
    );
    assert.equal(
      insiderActionLabel("PLEDGE_INVOCATION", "PIT"),
      "Pledge invoked",
      "a stated action still wins over the category default",
    );
  });

  it("names the row rather than accusing anyone of not disclosing", () => {
    assert.equal(
      insiderPersonLabel("", "PLEDGE"),
      "Company-wide pledged shares",
    );
    assert.equal(
      insiderPersonLabel(null, "PIT"),
      "Person not disclosed",
      "a PIT filing with no person really did omit one",
    );
    assert.equal(
      insiderPersonLabel("Ramesh Damani", "PLEDGE"),
      "Ramesh Damani",
      "a named pledgor is never overwritten by the fallback label",
    );
  });
});

describe("14c.5 netInsiderActivity", () => {
  const events: InsiderEventInput[] = [
    {
      date: daysAgo(5),
      category: "PIT",
      action: "BUY",
      qty: 1000,
      value: 100000,
      person: "A Promoter",
    },
    {
      date: daysAgo(10),
      category: "PIT",
      action: "SELL",
      qty: 400,
      value: 44000,
      person: "B Promoter",
    },
    // Outside the 90-day window — must not be netted.
    {
      date: daysAgo(120),
      category: "PIT",
      action: "BUY",
      qty: 999999,
      value: 9999999,
      person: "C",
    },
    // A pledge moves no ownership.
    {
      date: daysAgo(3),
      category: "PLEDGE",
      action: "PLEDGE_CREATION",
      qty: 500000,
      value: null,
      person: "A Promoter",
    },
    // Unknown action: rendered, never netted.
    {
      date: daysAgo(2),
      category: "SAST",
      action: "ENCUMBRANCE OTHER THAN PLEDGE",
      qty: 700,
      value: 70000,
      person: "D",
    },
  ];

  it("nets buys against sells inside the window only", () => {
    const s = netInsiderActivity(events, { now: NOW, windowDays: 90 });
    assert.equal(s.buyQty, 1000);
    assert.equal(s.sellQty, 400);
    assert.equal(s.netQty, 600);
    assert.equal(s.buyValue, 100000);
    assert.equal(s.netValue, 56000);
    assert.equal(s.eventCount, 4, "the 120-day-old event is out of the window");
  });

  it("excludes pledges and unknown actions from the net but counts them", () => {
    const s = netInsiderActivity(events, { now: NOW, windowDays: 90 });
    assert.equal(s.pledgeCount, 1);
    assert.equal(s.unknownCount, 1);
    assert.equal(s.buyCount, 1);
    assert.equal(s.sellCount, 1);
    // 500,000 pledged shares + 700 unknown-direction shares must be nowhere in
    // the net; if they leaked in, netQty would be 501,300 or similar.
    assert.equal(s.netQty, 600);
  });

  it("an undisclosed quantity is null, not zero, and is counted", () => {
    const s = netInsiderActivity(
      [
        {
          date: daysAgo(1),
          category: "PIT",
          action: "BUY",
          qty: null,
          value: null,
        },
        {
          date: daysAgo(2),
          category: "PIT",
          action: "BUY",
          qty: 250,
          value: null,
        },
      ],
      { now: NOW, windowDays: 90 },
    );
    assert.equal(s.buyQty, 250, "sums only what was disclosed");
    assert.equal(s.undisclosedQtyCount, 1);
    // No value was disclosed by ANY filing — that is unknown, not ₹0.
    assert.equal(s.buyValue, null);
    assert.equal(s.netValue, null);
    assert.equal(s.undisclosedValueCount, 2);
  });

  it("no events at all yields nulls, never zeros", () => {
    const s = netInsiderActivity([], { now: NOW, windowDays: 90 });
    assert.equal(s.netQty, null);
    assert.equal(s.netValue, null);
    assert.equal(s.eventCount, 0);
  });

  it("the window lower bound is INCLUSIVE at exactly 90 days", () => {
    const atBoundary: InsiderEventInput[] = [
      {
        date: daysAgo(90),
        category: "PIT",
        action: "BUY",
        qty: 10,
        value: null,
      },
    ];
    const justOutside: InsiderEventInput[] = [
      {
        date: daysAgo(91),
        category: "PIT",
        action: "BUY",
        qty: 10,
        value: null,
      },
    ];
    assert.equal(
      netInsiderActivity(atBoundary, { now: NOW, windowDays: 90 }).buyQty,
      10,
    );
    assert.equal(
      netInsiderActivity(justOutside, { now: NOW, windowDays: 90 }).buyQty,
      null,
    );
  });

  it("keeps a future-dated filing — `date` is the transaction window END", () => {
    // `InsiderEvent.date` is `acqtoDt`, the end of the declared transaction
    // window, so a filing can name a window ending after today. Dropping it
    // would silently lose the newest disclosure on the page.
    const future: InsiderEventInput[] = [
      {
        date: new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000),
        category: "PIT",
        action: "BUY",
        qty: 42,
        value: null,
      },
    ];
    assert.equal(
      netInsiderActivity(future, { now: NOW, windowDays: 90 }).buyQty,
      42,
    );
  });
});

describe("MONEY-1205 netInsiderActivity — snapshots are not filings", () => {
  // The shape of the real feed: one standing position restated every session,
  // no action, no pledgor — alongside a genuine SAST/PIT pledge filing that
  // DID happen on a day.
  const snapshot = (ago: number): InsiderEventInput => ({
    date: daysAgo(ago),
    category: "PLEDGE",
    action: "",
    qty: 500000,
    value: null,
    person: "",
  });

  it("[regression] a pledge snapshot is never counted as UNKNOWN", () => {
    // The user-visible bug: `unknownCount` drove a banner reading "N filings
    // with an unrecognised transaction type", and on prod every one of the
    // 5,734 pledge rows has an empty action — so the banner appeared on every
    // pledged stock in the market. Suppressing it is a consequence of
    // classifying correctly, not a separate special case in the UI.
    const s = netInsiderActivity([snapshot(1), snapshot(2), snapshot(3)], {
      now: NOW,
      windowDays: 90,
    });
    assert.equal(s.unknownCount, 0, "nothing here is unrecognised");
    assert.equal(s.pledgeCount, 3);
    assert.equal(s.pledgeSnapshotCount, 3);
  });

  it("splits daily snapshots from real pledge filings", () => {
    // The two must be worded apart: a `PLEDGE INVOKE` filing IS an event on a
    // day; a snapshot is the same position restated. Counting sixty
    // re-statements as sixty events invents fifty-nine of them.
    const s = netInsiderActivity(
      [
        snapshot(1),
        snapshot(2),
        {
          date: daysAgo(4),
          category: "PIT",
          action: "PLEDGE INVOKE",
          qty: 1000,
          value: null,
          person: "A Promoter",
        },
      ],
      { now: NOW, windowDays: 90 },
    );
    assert.equal(s.pledgeCount, 3, "both kinds are pledges");
    assert.equal(s.pledgeSnapshotCount, 2, "only two are snapshots");
    assert.equal(
      s.pledgeCount - s.pledgeSnapshotCount,
      1,
      "the real filing must survive the split — this is what the UI subtracts",
    );
    assert.equal(s.unknownCount, 0);
  });

  it("neither kind moves the net — a pledge transfers no ownership", () => {
    const s = netInsiderActivity(
      [
        snapshot(1),
        {
          date: daysAgo(2),
          category: "PIT",
          action: "BUY",
          qty: 100,
          value: 1000,
          person: "A",
        },
      ],
      { now: NOW, windowDays: 90 },
    );
    assert.equal(s.buyQty, 100);
    assert.equal(s.netQty, 100, "the 500,000-share pledge must not net");
  });

  it("[regression] a genuinely unknown action still raises the banner", () => {
    // The suppression must be narrow. Widening it to "quieten the banner"
    // would hide the one case the no-OTHER-bucket design exists to expose.
    const s = netInsiderActivity(
      [
        snapshot(1),
        {
          date: daysAgo(2),
          category: "SAST",
          action: "ENCUMBRANCE OTHER THAN PLEDGE",
          qty: 700,
          value: 70000,
          person: "D",
        },
      ],
      { now: NOW, windowDays: 90 },
    );
    assert.equal(s.unknownCount, 1, "a real unknown must still be reported");
    assert.equal(s.pledgeSnapshotCount, 1);
  });
});

describe("14c.5 groupInsiderEventsByMonth + buildInsiderSection", () => {
  it("groups newest month first with newest event first inside it", () => {
    const section = buildInsiderSection(
      [
        {
          date: new Date("2026-06-10T00:00:00Z"),
          category: "PIT",
          action: "BUY",
          qty: 1,
        },
        {
          date: new Date("2026-08-01T00:00:00Z"),
          category: "PIT",
          action: "SELL",
          qty: 2,
        },
        {
          date: new Date("2026-08-12T00:00:00Z"),
          category: "PIT",
          action: "BUY",
          qty: 3,
        },
      ],
      { now: NOW },
    );
    assert.deepEqual(
      section.months.map((m) => m.monthKey),
      ["2026-08", "2026-06"],
    );
    assert.equal(section.months[0]?.label, "Aug 2026");
    assert.deepEqual(
      section.months[0]?.events.map((e) => e.qty),
      [3, 2],
    );
  });

  it("an unrecognised action is RENDERED, not dropped", () => {
    const section = buildInsiderSection(
      [
        {
          date: daysAgo(1),
          category: "SAST",
          action: "ENCUMBRANCE OTHER THAN PLEDGE",
          qty: 5,
        },
      ],
      { now: NOW },
    );
    assert.equal(section.eventCount, 1);
    const ev = section.months[0]?.events[0];
    assert.ok(ev);
    assert.equal(ev.action, "ENCUMBRANCE OTHER THAN PLEDGE");
    assert.equal(ev.actionLabel, "ENCUMBRANCE OTHER THAN PLEDGE");
    assert.equal(ev.direction, "UNKNOWN");
  });

  it("nets over ALL events but caps only the rendered timeline", () => {
    const many: InsiderEventInput[] = Array.from({ length: 10 }, (_, i) => ({
      date: daysAgo(i + 1),
      category: "PIT",
      action: "BUY",
      qty: 100,
      value: null,
    }));
    const section = buildInsiderSection(many, { now: NOW, limit: 3 });
    assert.equal(section.eventCount, 3, "display cap applies to the timeline");
    assert.equal(
      section.summary.buyQty,
      1000,
      "the net must see every event, not just the visible ones",
    );
  });

  it("emits ISO dates and plain numbers — nothing JSON.stringify can throw on", () => {
    const section = buildInsiderSection(
      [
        {
          date: daysAgo(1),
          category: "PIT",
          action: "BUY",
          qty: 12345,
          value: 999,
        },
      ],
      { now: NOW },
    );
    // `InsiderEvent.qty` is a Prisma BigInt; JSON.stringify THROWS on one, so a
    // server action returning it crashes at the server/client boundary. This
    // asserts the view is already wire-safe.
    assert.doesNotThrow(() => JSON.stringify(section));
    assert.equal(typeof section.months[0]?.events[0]?.qty, "number");
    assert.equal(typeof section.months[0]?.events[0]?.dateIso, "string");
  });
});

describe("14c.5 matchLikelyDocument", () => {
  const docs: StockDocumentInput[] = [
    {
      id: "doc-far",
      docType: "corporate_filing",
      title: "Board meeting outcome",
      sourceUrl: "https://nse/1",
      date: new Date("2026-08-20T00:00:00Z"), // +5d — outside ±2
    },
    {
      id: "doc-near",
      docType: "corporate_filing",
      title: "Disclosure under Reg 7(2)",
      sourceUrl: "https://nse/2",
      date: new Date("2026-08-16T00:00:00Z"), // +1d
    },
    {
      id: "doc-wrongtype",
      docType: "annual_report",
      title: "Annual report FY26",
      sourceUrl: null,
      date: new Date("2026-08-15T00:00:00Z"), // same day but not an announcement
    },
  ];

  it("picks the closest announcement inside ±2 days and marks it LIKELY", () => {
    const link = matchLikelyDocument(NOW, docs);
    assert.ok(link);
    assert.equal(link.id, "doc-near");
    assert.equal(link.likely, true);
    assert.equal(link.dayGap, 1);
  });

  it("never matches a non-announcement doc type, even on the exact day", () => {
    const link = matchLikelyDocument(NOW, [docs[2] as StockDocumentInput]);
    assert.equal(link, null);
    assert.equal(ANNOUNCEMENT_DOC_TYPES.includes("annual_report"), false);
  });

  it("returns null rather than reaching for the nearest thing outside the window", () => {
    // A filing five days away is not evidence for this trade. No link beats a
    // wrong link the UI will present as corroboration.
    const link = matchLikelyDocument(NOW, [docs[0] as StockDocumentInput]);
    assert.equal(link, null);
  });

  it("ignores documents with no usable date", () => {
    const link = matchLikelyDocument(NOW, [
      {
        id: "d",
        docType: "corporate_filing",
        title: "x",
        sourceUrl: null,
        date: null,
      },
    ]);
    assert.equal(link, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.6 — deals
// ════════════════════════════════════════════════════════════════════════════

describe("14c.6 client-name normalisation and side parsing", () => {
  it("collapses spacing/case/trailing punctuation but not distinct funds", () => {
    assert.equal(
      normalizeClientName("Graviton Research Capital  LLP."),
      normalizeClientName("GRAVITON RESEARCH CAPITAL LLP"),
    );
    assert.notEqual(
      normalizeClientName("ABC MUTUAL FUND A"),
      normalizeClientName("ABC MUTUAL FUND B"),
    );
    assert.equal(normalizeClientName("-"), "");
    assert.equal(normalizeClientName(null), "");
  });

  it("parses both the word and the letter forms of the side", () => {
    assert.equal(dealSide("BUY"), "BUY");
    assert.equal(dealSide("buy"), "BUY");
    assert.equal(dealSide("B"), "BUY");
    assert.equal(dealSide("SELL"), "SELL");
    assert.equal(dealSide("S"), "SELL");
    assert.equal(dealSide(""), null);
    assert.equal(dealSide("-"), null);
  });
});

describe("14c.6 detectRepeatClients", () => {
  const deal = (
    clientName: string,
    ago: number,
    buySell = "BUY",
    qty: number | null = 100,
  ): DealInput => ({
    date: daysAgo(ago),
    securityName: "ACME LTD",
    clientName,
    buySell,
    qty,
    avgPrice: 10,
    dealType: "BULK",
    remarks: null,
  });

  it("flags a client at EXACTLY the 2-print threshold, not 3", () => {
    const out = detectRepeatClients([deal("FUND A", 1), deal("FUND A", 30)], {
      now: NOW,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.prints, 2);
    assert.equal(out[0]?.clientName, "FUND A");
  });

  it("does NOT flag a single print", () => {
    const out = detectRepeatClients([deal("FUND A", 1), deal("FUND B", 2)], {
      now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it("counts a print at EXACTLY 90 days (inclusive bound)", () => {
    const out = detectRepeatClients([deal("FUND A", 1), deal("FUND A", 90)], {
      now: NOW,
      windowDays: 90,
    });
    assert.equal(out.length, 1, "a 90-day-old print is inside a 90-day window");
    assert.equal(out[0]?.prints, 2);
  });

  it("drops a print at 91 days, so the client falls back to one print", () => {
    const out = detectRepeatClients([deal("FUND A", 1), deal("FUND A", 91)], {
      now: NOW,
      windowDays: 90,
    });
    assert.deepEqual(out, [], "91 days is outside a 90-day window");
  });

  it("nets disclosed quantities per client and reports null when none disclosed", () => {
    const out = detectRepeatClients(
      [deal("FUND A", 1, "BUY", 500), deal("FUND A", 2, "SELL", 200)],
      { now: NOW },
    );
    assert.equal(out[0]?.netQty, 300);
    assert.equal(out[0]?.buyPrints, 1);
    assert.equal(out[0]?.sellPrints, 1);

    const undisclosed = detectRepeatClients(
      [deal("FUND B", 1, "BUY", null), deal("FUND B", 2, "SELL", null)],
      { now: NOW },
    );
    assert.equal(undisclosed[0]?.netQty, null, "undisclosed is not zero");
  });

  it("ignores rows with no counterparty — the feed's whole point is the name", () => {
    const out = detectRepeatClients(
      [deal("-", 1), deal("", 2), deal("  ", 3)],
      {
        now: NOW,
      },
    );
    assert.deepEqual(out, []);
  });
});

describe("14c.6 buildDealsSection", () => {
  const deals: DealInput[] = [
    {
      date: daysAgo(1),
      securityName: "ACME LTD",
      clientName: "FUND A",
      buySell: "BUY",
      qty: 1000,
      avgPrice: 12.5,
      dealType: "BULK",
      remarks: "-",
    },
    {
      date: daysAgo(40),
      securityName: "-",
      clientName: "FUND A",
      buySell: "SELL",
      qty: 400,
      avgPrice: 13,
      dealType: "BLOCK",
      remarks: null,
    },
    {
      date: daysAgo(200),
      securityName: "ACME LTD",
      clientName: "FUND Z",
      buySell: "BUY",
      qty: 10,
      avgPrice: null,
      dealType: "BULK",
      remarks: "Market Trade",
    },
  ];

  it("renders newest first with `-` remarks and names nulled out", () => {
    const out = buildDealsSection(deals, { now: NOW });
    assert.equal(out.dealCount, 3);
    assert.equal(out.deals[0]?.clientName, "FUND A");
    assert.equal(out.deals[0]?.remarks, null, "`-` must not render as a dash");
    assert.equal(out.deals[1]?.securityName, null);
    assert.equal(out.deals[2]?.remarks, "Market Trade");
  });

  it("computes value only when qty AND price are both known", () => {
    const out = buildDealsSection(deals, { now: NOW });
    assert.equal(out.deals[0]?.value, 12500);
    // qty 10 × unknown price is unknown, not ₹0 — a free trade never happened.
    assert.equal(out.deals[2]?.value, null);
  });

  it("marks repeat-client rows and counts bulk vs block", () => {
    const out = buildDealsSection(deals, { now: NOW });
    assert.equal(out.repeatClients.length, 1);
    assert.equal(out.repeatClients[0]?.clientName, "FUND A");
    assert.equal(out.deals[0]?.repeatClient, true);
    assert.equal(out.deals[1]?.repeatClient, true);
    assert.equal(out.deals[2]?.repeatClient, false, "FUND Z printed once");
    assert.equal(out.bulkCount, 2);
    assert.equal(out.blockCount, 1);
  });

  it("detects a repeat client whose second print fell outside the display cap", () => {
    const many: DealInput[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        date: daysAgo(i + 1),
        securityName: "ACME",
        clientName: `NOISE ${i}`,
        buySell: "BUY",
        qty: 1,
        avgPrice: 1,
        dealType: "BULK",
        remarks: null,
      })),
      {
        date: daysAgo(10),
        securityName: "ACME",
        clientName: "FUND A",
        buySell: "BUY",
        qty: 1,
        avgPrice: 1,
        dealType: "BULK",
        remarks: null,
      },
      {
        date: daysAgo(11),
        securityName: "ACME",
        clientName: "FUND A",
        buySell: "BUY",
        qty: 1,
        avgPrice: 1,
        dealType: "BULK",
        remarks: null,
      },
    ];
    const out = buildDealsSection(many, { now: NOW, limit: 3 });
    assert.equal(out.dealCount, 3);
    assert.equal(
      out.repeatClients.some((r) => r.clientName === "FUND A"),
      true,
      "repeat detection must run before the display cap",
    );
  });

  it("counts bulk vs block over EVERY deal, not just the visible page", () => {
    // B3 — the cap is a DISPLAY cap. Counting after it turns "60 bulk · 10
    // block" into "50 bulk · 0 block": the newest 50 rows here are all bulk, so
    // the ten block deals vanish from the headline of the deals panel while
    // still being in the data the panel was built from.
    const mk = (i: number, dealType: string): DealInput => ({
      date: daysAgo(i),
      securityName: "ACME",
      clientName: `FUND ${i}`,
      buySell: "BUY",
      qty: 1,
      avgPrice: 1,
      dealType,
      remarks: null,
    });
    const many: DealInput[] = [
      ...Array.from({ length: 60 }, (_, i) => mk(i + 1, "BULK")),
      ...Array.from({ length: 10 }, (_, i) => mk(i + 100, "BLOCK")),
    ];
    const out = buildDealsSection(many, { now: NOW, limit: 50 });
    assert.equal(out.bulkCount, 60, "counted over the deals, not the page");
    assert.equal(out.blockCount, 10, "ten block deals must not read as zero");
    // …and `dealCount` stays the POST-cap number it is documented as.
    assert.equal(out.dealCount, 50);
    assert.equal(out.deals.length, 50);
  });

  it("does not count a deal it could not date, in either total", () => {
    // An undateable row cannot be placed in the panel at all, so counting it in
    // the headline would advertise a deal nothing can show.
    const out = buildDealsSection(
      [
        {
          date: "not-a-date",
          securityName: "ACME",
          clientName: "FUND A",
          buySell: "BUY",
          qty: 1,
          avgPrice: 1,
          dealType: "BULK",
          remarks: null,
        },
        {
          date: daysAgo(1),
          securityName: "ACME",
          clientName: "FUND B",
          buySell: "BUY",
          qty: 1,
          avgPrice: 1,
          dealType: "BLOCK",
          remarks: null,
        },
      ],
      { now: NOW },
    );
    assert.equal(out.bulkCount, 0);
    assert.equal(out.blockCount, 1);
    assert.equal(out.dealCount, 1);
  });

  it("is wire-safe — no BigInt, no Date", () => {
    const out = buildDealsSection(deals, { now: NOW });
    assert.doesNotThrow(() => JSON.stringify(out));
    assert.equal(typeof out.deals[0]?.dateIso, "string");
    assert.equal(typeof out.deals[0]?.qty, "number");
  });
});
