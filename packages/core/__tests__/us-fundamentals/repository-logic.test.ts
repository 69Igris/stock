/**
 * MONEY-979 T10 — the pure decisions behind the US fundamentals seam.
 *
 * Every assertion drives the REAL exported function from
 * `packages/core/src/us-fundamentals/repository-logic.ts`. Nothing is
 * re-declared inline: a test that restates the rule is a shadow test and stays
 * green when the source is deleted.
 *
 * MUTATION-VERIFIED. Each `MUTATION:` note names the exact source edit that was
 * applied, confirmed to turn this file RED, and then reverted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyInsiderCode,
  judgeCoverage,
  mapStandardizedToStatement,
  normalizeSymbolForUs,
  padCik10,
  pickPointInTime,
  resolveQoQ,
  selectThirteenFAccessions,
  summarizeInsiderActivity,
  usFormRank,
  US_COVERAGE_TARGET_YEARS,
  US_STATEMENT_FIELDS_NOT_FILED,
  type PointInTimeRow,
} from "../../src/us-fundamentals/repository-logic";
import type {
  UsHoldingRow,
  UsInsiderRow,
} from "../../src/us-fundamentals/types";

/* ════════════════════════════════════════════════════════════════════════
   1. pickPointInTime — THE acceptance property of this branch
   ═══════════════════════════════════════════════════════════════════════ */

type PitOverrides = Omit<Partial<PointInTimeRow>, "periodEnd" | "filedAt"> & {
  periodEnd: string;
  filedAt: string;
};

function pit(over: PitOverrides): PointInTimeRow {
  return {
    accession: "0000000000-00-000000",
    form: "10-Q",
    isAmendment: false,
    isLatest: false,
    ...over,
    periodEnd: new Date(over.periodEnd),
    filedAt: new Date(over.filedAt),
  } as PointInTimeRow;
}

/**
 * Two 10-Qs for the SAME quarter: the original, and a restatement filed three
 * months later. This is the whole reason `accession` is in the unique key.
 */
const Q1_ORIGINAL = pit({
  periodEnd: "2024-03-30T00:00:00.000Z",
  filedAt: "2024-05-02T00:00:00.000Z",
  accession: "0000320193-24-000001",
});
const Q1_RESTATED = pit({
  periodEnd: "2024-03-30T00:00:00.000Z",
  filedAt: "2024-08-01T00:00:00.000Z",
  accession: "0000320193-24-000009",
  isLatest: true,
});

describe("pickPointInTime", () => {
  it("asked for a date BETWEEN two filings of one quarter, returns the OLDER one", () => {
    const out = pickPointInTime(
      [Q1_RESTATED, Q1_ORIGINAL],
      new Date("2024-06-15T00:00:00.000Z"),
    );
    assert.equal(out.length, 1, "one row per periodEnd");
    assert.equal(
      out[0]?.accession,
      "0000320193-24-000001",
      "a restatement filed 2024-08-01 was not information anyone had on 2024-06-15",
    );
  });

  it("asked for a date AFTER both, returns the restatement", () => {
    const out = pickPointInTime(
      [Q1_ORIGINAL, Q1_RESTATED],
      new Date("2024-09-01T00:00:00.000Z"),
    );
    assert.equal(out[0]?.accession, "0000320193-24-000009");
  });

  it("drops a filing made after asOf entirely rather than ranking it", () => {
    const out = pickPointInTime(
      [Q1_RESTATED],
      new Date("2024-06-15T00:00:00.000Z"),
    );
    assert.deepEqual(out, [], "nothing had been filed on that date");
  });

  it("on a filedAt tie a 10-K beats a 10-Q for the same periodEnd", () => {
    const tenQ = pit({
      periodEnd: "2024-09-28T00:00:00.000Z",
      filedAt: "2024-11-01T00:00:00.000Z",
      form: "10-Q",
      accession: "0000320193-24-000100",
    });
    const tenK = pit({
      periodEnd: "2024-09-28T00:00:00.000Z",
      filedAt: "2024-11-01T00:00:00.000Z",
      form: "10-K",
      accession: "0000320193-24-000010",
    });
    const out = pickPointInTime(
      [tenQ, tenK],
      new Date("2025-01-01T00:00:00.000Z"),
    );
    assert.equal(out.length, 1);
    assert.equal(
      out[0]?.form,
      "10-K",
      "the audited annual statement wins the tie",
    );
    // ...and the accession tiebreak must NOT be what decided it: the 10-Q's
    // accession sorts HIGHER, so a rank-free implementation would pick it.
    assert.equal(out[0]?.accession, "0000320193-24-000010");
  });

  it("on a form tie a non-amendment beats an amendment", () => {
    const original = pit({
      periodEnd: "2023-12-30T00:00:00.000Z",
      filedAt: "2024-02-01T00:00:00.000Z",
      form: "10-K",
      isAmendment: false,
      accession: "0000320193-24-000001",
    });
    const amended = pit({
      periodEnd: "2023-12-30T00:00:00.000Z",
      filedAt: "2024-02-01T00:00:00.000Z",
      form: "10-K/A",
      isAmendment: true,
      accession: "0000320193-24-000999",
    });
    const out = pickPointInTime(
      [amended, original],
      new Date("2025-01-01T00:00:00.000Z"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.isAmendment, false);
    assert.equal(out[0]?.accession, "0000320193-24-000001");
  });

  it("with NO asOf it falls back to isLatest, not to the newest filedAt", () => {
    // The writer's pointer disagrees with recency on purpose here: the row it
    // marks is the OLDER filing. An implementation that quietly sorted by
    // filedAt would pass every other case in this file and fail this one.
    const flagged = pit({
      periodEnd: "2024-03-30T00:00:00.000Z",
      filedAt: "2024-05-02T00:00:00.000Z",
      accession: "PICK-ME",
      isLatest: true,
    });
    const newer = pit({
      periodEnd: "2024-03-30T00:00:00.000Z",
      filedAt: "2024-08-01T00:00:00.000Z",
      accession: "NOT-ME",
      isLatest: false,
    });
    const out = pickPointInTime([newer, flagged]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.accession, "PICK-ME");
  });

  it("returns newest periodEnd first, one row per period", () => {
    const rows = [
      pit({
        periodEnd: "2022-12-31T00:00:00.000Z",
        filedAt: "2023-02-01T00:00:00.000Z",
      }),
      pit({
        periodEnd: "2024-12-31T00:00:00.000Z",
        filedAt: "2025-02-01T00:00:00.000Z",
      }),
      pit({
        periodEnd: "2023-12-31T00:00:00.000Z",
        filedAt: "2024-02-01T00:00:00.000Z",
      }),
    ];
    const out = pickPointInTime(rows, new Date("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(
      out.map((r) => r.periodEnd.toISOString().slice(0, 10)),
      ["2024-12-31", "2023-12-31", "2022-12-31"],
    );
  });

  it("never throws on an empty input, and drops unparseable rows", () => {
    assert.deepEqual(pickPointInTime([]), []);
    assert.deepEqual(pickPointInTime([], new Date("2024-01-01")), []);
    const broken = {
      accession: "X",
      form: "10-K",
      isAmendment: false,
      isLatest: true,
      periodEnd: new Date("not a date"),
      filedAt: new Date("2024-01-01"),
    } as PointInTimeRow;
    assert.deepEqual(pickPointInTime([broken]), []);
  });

  it("ranks forms: annual 2, quarterly 1, everything else 0", () => {
    assert.equal(usFormRank("10-K"), 2);
    assert.equal(usFormRank("10-K/A"), 2);
    assert.equal(usFormRank("20-F"), 2);
    assert.equal(usFormRank("40-F"), 2);
    assert.equal(usFormRank("10-Q"), 1);
    assert.equal(usFormRank("8-K"), 0);
    assert.equal(usFormRank(null), 0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   2. resolveQoQ — the exited holder must survive
   ═══════════════════════════════════════════════════════════════════════ */

function holding(
  over: Partial<UsHoldingRow> & { managerCik10: string; cusip: string },
): UsHoldingRow {
  return {
    accession: `ACC-${over.managerCik10}`,
    rowIndex: 0,
    managerName: "Fake Capital LLC",
    periodOfReport: new Date("2026-06-30T00:00:00.000Z"),
    filedAt: new Date("2026-08-14T00:00:00.000Z"),
    figi: null,
    issuerName: "Apple Inc.",
    titleOfClass: "COM",
    valueUsd: 0,
    shares: 0,
    sharesType: "SH",
    putCall: null,
    symbol: "AAPL",
    currency: "USD",
    ...over,
  } as UsHoldingRow;
}

const CUSIP_AAPL = "037833100";

describe("resolveQoQ", () => {
  const previous = [
    holding({
      managerCik10: "0001067983",
      cusip: CUSIP_AAPL,
      shares: 400,
      valueUsd: 40_000,
    }),
    holding({
      managerCik10: "0000102909",
      cusip: CUSIP_AAPL,
      shares: 900,
      valueUsd: 90_000,
    }),
    holding({
      managerCik10: "0000909661",
      cusip: CUSIP_AAPL,
      shares: 250,
      valueUsd: 25_000,
    }),
  ];
  const current = [
    // increased
    holding({
      managerCik10: "0001067983",
      cusip: CUSIP_AAPL,
      shares: 500,
      valueUsd: 55_000,
    }),
    // decreased
    holding({
      managerCik10: "0000102909",
      cusip: CUSIP_AAPL,
      shares: 700,
      valueUsd: 77_000,
    }),
    // new
    holding({
      managerCik10: "0001350694",
      cusip: CUSIP_AAPL,
      shares: 120,
      valueUsd: 13_200,
    }),
    // 0000909661 is ABSENT — it sold out.
  ];

  const out = resolveQoQ(current, previous);
  const byManager = new Map(out.map((r) => [r.managerCik10, r]));

  it("emits an increase with a positive delta", () => {
    const row = byManager.get("0001067983");
    assert.equal(row?.sharesDelta, 100);
    assert.equal(row?.valueDelta, 15_000);
    assert.equal(row?.isNew, false);
    assert.equal(row?.isExited, false);
  });

  it("emits a decrease with a negative share delta", () => {
    const row = byManager.get("0000102909");
    assert.equal(row?.sharesDelta, -200);
    assert.equal(row?.valueDelta, -13_000);
  });

  it("flags a first-time holder as new, with the whole position as the delta", () => {
    const row = byManager.get("0001350694");
    assert.equal(row?.isNew, true);
    assert.equal(row?.sharesDelta, 120);
    assert.equal(row?.valueDelta, 13_200);
  });

  it("KEEPS the exited holder, with a negative delta and a zero position", () => {
    // MUTATION: deleting the `for (const [key, before] of prior)` exit loop in
    // resolveQoQ (so only `current` is walked) turned this case RED —
    // `row` became undefined. Restored byte-identically.
    const row = byManager.get("0000909661");
    assert.ok(
      row,
      "a manager who sold out must still appear — dropping it hides the seller",
    );
    assert.equal(row.isExited, true);
    assert.equal(row.shares, 0);
    assert.equal(row.valueUsd, 0);
    assert.equal(row.sharesDelta, -250);
    assert.equal(row.valueDelta, -25_000);
    assert.ok(
      row.valueDelta < 0,
      "the delta must be NEGATIVE, not the absolute size of the exit",
    );
  });

  it("cites the PRIOR filing on an exit — the current period has no such row", () => {
    assert.equal(byManager.get("0000909661")?.accession, "ACC-0000909661");
  });

  it("keys on manager+cusip, so one issuer's many holders never collapse", () => {
    assert.equal(
      out.length,
      4,
      "3 held + 1 exited, not 1 aggregated cusip row",
    );
  });

  it("does not throw on empty inputs", () => {
    assert.deepEqual(resolveQoQ([], []), []);
    assert.equal(
      resolveQoQ([], previous).every((r) => r.isExited),
      true,
    );
    assert.equal(
      resolveQoQ(current, []).every((r) => r.isNew),
      true,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   3. normalizeSymbolForUs
   ═══════════════════════════════════════════════════════════════════════ */

describe("normalizeSymbolForUs", () => {
  it("turns SEC's slash spelling into our dash spelling", () => {
    // MUTATION: removing `/` from the character class in the replace (leaving
    // `/[.]/g`) turned this RED. Restored.
    assert.equal(normalizeSymbolForUs("BRK/B"), "BRK-B");
  });

  it("uppercases, trims, and normalises the dotted spelling too", () => {
    assert.equal(normalizeSymbolForUs("  brk.b "), "BRK-B");
    assert.equal(normalizeSymbolForUs("aapl"), "AAPL");
    assert.equal(normalizeSymbolForUs("SPG/P/J"), "SPG-P-J");
  });

  it("returns an empty string for nothing, never throws", () => {
    assert.equal(normalizeSymbolForUs(null), "");
    assert.equal(normalizeSymbolForUs(undefined), "");
    assert.equal(normalizeSymbolForUs("   "), "");
  });

  it("pads a CIK and refuses one it cannot pad", () => {
    assert.equal(padCik10("320193"), "0000320193");
    assert.equal(padCik10(320193), "0000320193");
    assert.equal(padCik10("CIK0000320193"), "0000320193");
    assert.equal(padCik10(""), null);
    assert.equal(padCik10("abc"), null);
    assert.equal(padCik10("12345678901"), null, "11 digits is not a CIK");
  });
});

/* ════════════════════════════════════════════════════════════════════════
   4. summarizeInsiderActivity — an F is not an S
   ═══════════════════════════════════════════════════════════════════════ */

function insider(
  over: Partial<UsInsiderRow> & { transactionCode: string },
): UsInsiderRow {
  return {
    accession: `ACC-${over.transactionCode}-${over.rowIndex ?? 0}`,
    rowIndex: 0,
    issuerCik10: "0000320193",
    issuerName: "Apple Inc.",
    symbol: "AAPL",
    ownerCik10: "0001214128",
    ownerName: "COOK TIMOTHY D",
    isDirector: false,
    isOfficer: true,
    isTenPctOwner: false,
    officerTitle: "CEO",
    form: "4",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    filedAt: new Date("2026-08-03T00:00:00.000Z"),
    securityTitle: "Common Stock",
    isDerivative: false,
    isHolding: false,
    codeMeaning: null,
    equitySwap: false,
    acquiredDisposed: null,
    shares: null,
    price: null,
    value: null,
    sharesOwnedAfter: null,
    directIndirect: "D",
    currency: "USD",
    isAmendment: false,
    ...over,
  } as UsInsiderRow;
}

describe("summarizeInsiderActivity", () => {
  const rows: UsInsiderRow[] = [
    insider({
      transactionCode: "S",
      acquiredDisposed: "D",
      shares: 100_000,
      value: 22_000_000,
      rowIndex: 1,
    }),
    insider({
      transactionCode: "F",
      acquiredDisposed: "D",
      shares: 240_000,
      value: 52_800_000,
      rowIndex: 2,
    }),
    insider({
      transactionCode: "A",
      acquiredDisposed: "A",
      shares: 500_000,
      value: null,
      rowIndex: 3,
    }),
    insider({
      transactionCode: "P",
      acquiredDisposed: "A",
      shares: 10_000,
      value: 2_200_000,
      rowIndex: 4,
    }),
    insider({
      transactionCode: "G",
      acquiredDisposed: "D",
      shares: 5_000,
      value: null,
      rowIndex: 5,
    }),
    insider({
      transactionCode: "M",
      acquiredDisposed: "A",
      shares: 50_000,
      value: null,
      rowIndex: 6,
    }),
    // A Form 3 holding line — a disclosed position, not a trade.
    insider({
      transactionCode: "",
      isHolding: true,
      shares: 3_000_000,
      rowIndex: 7,
    }),
  ];

  const summary = summarizeInsiderActivity(rows, 365);

  it("puts a tax withholding (F) in its OWN bucket, not with an open-market sale (S)", () => {
    // MUTATION: changing `F: "TAX_WITHHOLDING"` to `F: "OPEN_MARKET_SELL"` in
    // US_INSIDER_CODE_CLASS turned this RED on all four assertions below.
    // Restored byte-identically.
    assert.equal(summary.byClass.OPEN_MARKET_SELL.shares, -100_000);
    assert.equal(summary.byClass.OPEN_MARKET_SELL.codes.join(","), "S");
    assert.equal(summary.byClass.TAX_WITHHOLDING.shares, -240_000);
    assert.equal(summary.byClass.TAX_WITHHOLDING.codes.join(","), "F");
  });

  it("nets ONLY open-market buys against open-market sales", () => {
    // 10,000 bought (P) - 100,000 sold (S). The 240,000 F shares and the
    // 500,000 A shares are deliberately not in this number.
    assert.equal(summary.netOpenMarketShares, -90_000);
    assert.equal(summary.netOpenMarketValue, 2_200_000 - 22_000_000);
  });

  it("reports value as null for a class where nothing carried a price", () => {
    assert.equal(
      summary.byClass.GIFT.value,
      null,
      "a gift has no price; 0 would read as worthless",
    );
    assert.equal(summary.byClass.AWARD.value, null);
    assert.equal(summary.byClass.EXERCISE.shares, 50_000);
  });

  it("excludes holding rows from every total", () => {
    assert.equal(summary.rowsCounted, 6);
    assert.equal(summary.rowsSkipped, 1);
    for (const cls of Object.values(summary.byClass)) {
      assert.notEqual(cls.shares, 3_000_000);
    }
  });

  it("anchors the window on the newest transaction, with no clock", () => {
    const old = insider({
      transactionCode: "S",
      acquiredDisposed: "D",
      shares: 999,
      transactionDate: new Date("2020-01-01T00:00:00.000Z"),
      rowIndex: 9,
    });
    const windowed = summarizeInsiderActivity([...rows, old], 30);
    assert.equal(windowed.anchor, "2026-08-01T00:00:00.000Z");
    assert.equal(
      windowed.byClass.OPEN_MARKET_SELL.shares,
      -100_000,
      "the 2020 sale is outside a 30-day window anchored on 2026-08-01",
    );
  });

  it("returns zeroes and nulls, never NaN, for an empty input", () => {
    const none = summarizeInsiderActivity([], 90);
    assert.equal(none.rowsCounted, 0);
    assert.equal(none.anchor, null);
    assert.equal(none.netOpenMarketShares, 0);
    assert.equal(none.netOpenMarketValue, null);
    assert.equal(Number.isNaN(none.netOpenMarketShares), false);
  });

  it("classifies every SEC code, and treats an unknown letter as OTHER", () => {
    assert.equal(classifyInsiderCode("P"), "OPEN_MARKET_BUY");
    assert.equal(classifyInsiderCode("s"), "OPEN_MARKET_SELL");
    assert.equal(classifyInsiderCode("X"), "EXERCISE");
    assert.equal(classifyInsiderCode("Z"), "OTHER");
    assert.equal(classifyInsiderCode("Q"), "OTHER");
    assert.equal(classifyInsiderCode(""), null);
    assert.equal(classifyInsiderCode(null), null);
    assert.equal(
      classifyInsiderCode("K"),
      "OTHER",
      "K is a display flag EDGAR appends, not a code — it must not have its own meaning here",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   5. judgeCoverage
   ═══════════════════════════════════════════════════════════════════════ */

describe("judgeCoverage", () => {
  it("a population of ONLY ineligible filers scores 100, not 0 and not NaN", () => {
    // MUTATION: changing `eligible === 0 ? 100 : …` to
    // `(eligibleCovered / eligible) * 100` produced NaN and turned this RED.
    // Restored.
    const out = judgeCoverage([
      { eligibleForCoverage: false, fiscalYearsOnFile: 2, statementYears: 2 },
      { eligibleForCoverage: false, fiscalYearsOnFile: 1, statementYears: 1 },
    ]);
    assert.equal(out.pct, 100);
    assert.equal(Number.isNaN(out.pct), false);
    assert.equal(out.eligible, 0);
    assert.equal(out.ineligible, 2);
    assert.equal(
      out.ineligibleWithAllAvailable,
      2,
      "a SPAC with all 2 of its 2 years is SATISFIED",
    );
    assert.equal(out.overallPct, 100);
  });

  it("an empty population never throws and never returns NaN", () => {
    const out = judgeCoverage([]);
    assert.equal(out.pct, 100);
    assert.equal(out.overallPct, 100);
    assert.equal(out.filers, 0);
    assert.equal(Number.isNaN(out.pct), false);
  });

  it("the gate's denominator is ELIGIBLE filers only", () => {
    const out = judgeCoverage([
      { eligibleForCoverage: true, fiscalYearsOnFile: 9, statementYears: 6 },
      { eligibleForCoverage: true, fiscalYearsOnFile: 7, statementYears: 5 },
      { eligibleForCoverage: true, fiscalYearsOnFile: 8, statementYears: 3 },
      // 20 SPACs that structurally CANNOT have five years. If they counted,
      // pct would be 2/23 = 8.7% and every release would fail on a market
      // condition rather than on anything we can fix.
      ...Array.from({ length: 20 }, () => ({
        eligibleForCoverage: false,
        fiscalYearsOnFile: 1,
        statementYears: 1,
      })),
    ]);
    assert.equal(out.eligible, 3);
    assert.equal(out.eligibleCovered, 2);
    assert.ok(Math.abs(out.pct - (2 / 3) * 100) < 1e-9);
  });

  it("an ineligible filer MISSING its available years is visible in overallPct only", () => {
    const out = judgeCoverage([
      { eligibleForCoverage: true, fiscalYearsOnFile: 9, statementYears: 6 },
      { eligibleForCoverage: false, fiscalYearsOnFile: 3, statementYears: 0 },
    ]);
    assert.equal(
      out.pct,
      100,
      "the gate is over eligible filers, and that one is covered",
    );
    assert.equal(
      out.ineligibleWithAllAvailable,
      0,
      "0 of 3 years is not 'all it has'",
    );
    assert.equal(
      out.overallPct,
      50,
      "…and the shortfall is still reported, not hidden",
    );
  });

  it("the target is five fiscal years", () => {
    assert.equal(US_COVERAGE_TARGET_YEARS, 5);
    const out = judgeCoverage([
      { eligibleForCoverage: true, fiscalYearsOnFile: 10, statementYears: 4 },
    ]);
    assert.equal(out.eligibleCovered, 0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   6. selectThirteenFAccessions — RESTATEMENT vs NEW HOLDINGS
   ═══════════════════════════════════════════════════════════════════════ */

describe("selectThirteenFAccessions", () => {
  const original = {
    accession: "ORIG",
    filedAt: "2026-08-14T00:00:00.000Z",
    isAmendment: false,
    amendmentType: null,
    tier: "HOT",
    coldPath: null,
  };

  it("a RESTATEMENT replaces the original", () => {
    const out = selectThirteenFAccessions([
      original,
      {
        accession: "AMD",
        filedAt: "2026-08-20T00:00:00.000Z",
        isAmendment: true,
        amendmentType: "RESTATEMENT",
        tier: "HOT",
        coldPath: null,
      },
    ]);
    assert.deepEqual(out.accessions, ["AMD"]);
    assert.deepEqual(out.ambiguous, []);
  });

  it("NEW HOLDINGS adds to the original", () => {
    const out = selectThirteenFAccessions([
      original,
      {
        accession: "AMD",
        filedAt: "2026-08-20T00:00:00.000Z",
        isAmendment: true,
        amendmentType: "NEW HOLDINGS",
        tier: "HOT",
        coldPath: null,
      },
    ]);
    assert.deepEqual(out.accessions.sort(), ["AMD", "ORIG"]);
    assert.deepEqual(out.ambiguous, []);
  });

  it("an UNREADABLE amendment type is additive AND reported as ambiguous", () => {
    // Additive over-counts at worst; restating DELETES holdings that were
    // really there. The caller sees the ambiguity rather than inheriting it.
    const out = selectThirteenFAccessions([
      original,
      {
        accession: "AMD",
        filedAt: "2026-08-20T00:00:00.000Z",
        isAmendment: true,
        amendmentType: null,
        tier: "HOT",
        coldPath: null,
      },
    ]);
    assert.deepEqual(out.accessions.sort(), ["AMD", "ORIG"]);
    assert.deepEqual(out.ambiguous, ["AMD"]);
  });

  it("surfaces the COLD tier and its path", () => {
    const out = selectThirteenFAccessions([
      {
        ...original,
        tier: "COLD",
        coldPath: "edgar/13f/0001067983/2024-03-31",
      },
    ]);
    assert.equal(out.hasCold, true);
    assert.deepEqual(out.coldPaths, ["edgar/13f/0001067983/2024-03-31"]);
  });

  it("is total over an empty list", () => {
    const out = selectThirteenFAccessions([]);
    assert.deepEqual(out.accessions, []);
    assert.equal(out.hasCold, false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   7. mapStandardizedToStatement — the bridge to FinancialStatement
   ═══════════════════════════════════════════════════════════════════════ */

describe("mapStandardizedToStatement", () => {
  const row = {
    standardized: {
      Revenue: 391_035_000_000,
      CostOfGoodsAndServicesSold: 210_352_000_000,
      OperatingIncomeLoss: 123_216_000_000,
      NetIncome: 93_736_000_000,
      Assets: 364_980_000_000,
      Liabilities: 308_030_000_000,
      CommonEquity: 56_950_000_000,
      LongTermDebt: 85_750_000_000,
      ShortTermDebt: 20_879_000_000,
      NetCashFromOperatingActivities: 118_254_000_000,
      CapitalExpenses: 9_447_000_000,
      _fallbacks: {
        Revenue: "RevenueFromContractWithCustomerExcludingAssessedTax",
      },
    },
    periodEnd: new Date("2024-09-28T00:00:00.000Z"),
    accession: "0000320193-24-000123",
    filedAt: new Date("2024-11-01T00:00:00.000Z"),
    form: "10-K",
    fiscalYear: 2024,
    fiscalPeriod: "FY",
  };

  const out = mapStandardizedToStatement(row);

  it("maps edgartools' STANDARD CONCEPT names onto FinancialStatement fields", () => {
    assert.equal(out.revenue, 391_035_000_000);
    assert.equal(out.costOfRevenue, 210_352_000_000);
    assert.equal(out.operatingIncome, 123_216_000_000);
    assert.equal(out.netIncome, 93_736_000_000);
    assert.equal(out.totalAssets, 364_980_000_000);
    assert.equal(out.operatingCashFlow, 118_254_000_000);
  });

  it("sums long-term and short-term debt into totalDebt", () => {
    assert.equal(out.totalDebt, 85_750_000_000 + 20_879_000_000);
  });

  it("derives grossProfit when the concept is absent but both inputs are present", () => {
    assert.equal(out.grossProfit, 391_035_000_000 - 210_352_000_000);
  });

  it("emits capitalExpenditure NEGATIVE (Yahoo's convention) though SEC files it positive", () => {
    assert.equal(out.capitalExpenditure, -9_447_000_000);
    assert.equal(out.freeCashFlow, 118_254_000_000 - 9_447_000_000);
  });

  it("carries provenance on every row", () => {
    assert.equal(out.currency, "USD");
    assert.equal(out.accession, "0000320193-24-000123");
    assert.equal(out.filedAt, "2024-11-01T00:00:00.000Z");
    assert.equal(out.endDate, "2024-09-28T00:00:00.000Z");
    assert.equal(out.period, "FY 2024");
  });

  it("leaves ebitda undefined rather than synthesising it", () => {
    assert.equal(out.ebitda, undefined);
    assert.deepEqual([...US_STATEMENT_FIELDS_NOT_FILED], ["ebitda"]);
  });

  it("does not invent fields for an empty standardized blob", () => {
    const bare = mapStandardizedToStatement({ ...row, standardized: {} });
    assert.equal(bare.revenue, undefined);
    assert.equal(bare.totalDebt, undefined);
    assert.equal(bare.freeCashFlow, undefined);
    assert.equal(bare.currency, "USD");
  });

  it("ignores a non-finite value rather than propagating NaN", () => {
    const poisoned = mapStandardizedToStatement({
      ...row,
      standardized: { Revenue: Number.NaN, NetIncome: 5 },
    });
    assert.equal(poisoned.revenue, undefined);
    assert.equal(poisoned.netIncome, 5);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   13F HOLDER AGGREGATION — one manager, one instrument, MANY filed rows
   ════════════════════════════════════════════════════════════════════════

   A round-2 review demonstrated that the two headline 13F fixes had NO
   coverage at all: reverting `holderKey` to its pre-fix
   `${managerCik10}|${cusip}` left the entire 5,616-case core suite green. The
   fixes were verified by hand probes and never pinned, so the commit message's
   "every fix mutation-verified" was false for exactly these.

   The numbers below are MEASURED from this repo's own Berkshire fixture
   (`services/us-fundamentals/tests/fixtures/thirteenf_post2023.txt.gz`), not
   invented: 89 filed rows, 29 holder positions, and Apple filed TWELVE times
   under one key totalling 227,917,808 shares.                                */

describe("13F rows are AGGREGATED per holder before they are diffed", () => {
  const PERIOD_NOW = new Date("2024-06-30T00:00:00.000Z");
  const PERIOD_PRIOR = new Date("2024-03-31T00:00:00.000Z");

  /** One filed row. `otherManagers` is what splits a position across rows. */
  const filed = (over: Record<string, unknown> = {}) =>
    ({
      accession: "0000950123-24-000001",
      rowIndex: 0,
      managerCik10: "0001067983",
      managerName: "Berkshire Hathaway Inc",
      periodOfReport: PERIOD_NOW,
      filedAt: new Date("2024-08-14T00:00:00.000Z"),
      cusip: "037833100",
      figi: null,
      issuerName: "APPLE INC",
      titleOfClass: "COM",
      valueUsd: 1_000_000,
      shares: 10_000,
      sharesType: "SH",
      putCall: null,
      symbol: "AAPL",
      ...over,
    }) as never;

  /** Apple as Berkshire actually files it: same key, different co-managers. */
  const appleTranches = (period: Date, accession: string, scale = 1) =>
    [692_000, 3_840_000, 34_000, 1_100_000].map((shares, i) =>
      filed({
        accession,
        rowIndex: i,
        periodOfReport: period,
        shares: shares * scale,
        valueUsd: shares * 289 * scale,
      }),
    );

  it("sums rows that share a holder key instead of discarding all but one", () => {
    const out = resolveQoQ(
      appleTranches(PERIOD_NOW, "0000950123-24-000001"),
      [],
    );
    assert.equal(out.length, 1, "four filed rows are ONE position");
    assert.equal(out[0]!.shares, 692_000 + 3_840_000 + 34_000 + 1_100_000);
    assert.equal(out[0]!.rowsAggregated, 4);
  });

  it("reports ZERO change when nothing traded across two identical quarters", () => {
    // THE DEFECT. Diffing filed rows pairs one arbitrary row against another:
    // on the real filing this reported a 740-million-share, $145-billion
    // phantom disposal with reason: null and degraded: false.
    const now = appleTranches(PERIOD_NOW, "0000950123-24-000002");
    const before = appleTranches(PERIOD_PRIOR, "0000950123-24-000001");
    const out = resolveQoQ(now, before);

    assert.equal(out.length, 1);
    assert.equal(out[0]!.sharesDelta, 0, "phantom share movement");
    assert.equal(out[0]!.valueDelta, 0, "phantom value movement");
    assert.equal(out[0]!.isExited, false);
    assert.equal(out[0]!.isNew, false);
  });

  it("still detects a REAL partial disposal, and does not call it an exit", () => {
    // The mirror failure: one tranche sold. Row-wise diffing produced NO exit
    // row and no delta, because another row had already claimed the key.
    const before = appleTranches(PERIOD_PRIOR, "0000950123-24-000001");
    const now = before
      .slice(1)
      .map((r) => ({ ...(r as object), periodOfReport: PERIOD_NOW }) as never);
    const out = resolveQoQ(now, before);

    assert.equal(out.length, 1);
    assert.equal(out[0]!.sharesDelta, -692_000, "the sold tranche");
    assert.equal(out[0]!.isExited, false, "a partial sale is not an exit");
    assert.equal(out[0]!.rowsAggregated, 3);
  });

  it("reports a full exit against the SUMMED prior position, not one row", () => {
    const before = appleTranches(PERIOD_PRIOR, "0000950123-24-000001");
    const out = resolveQoQ([], before);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.isExited, true);
    assert.equal(
      out[0]!.sharesDelta,
      -(692_000 + 3_840_000 + 34_000 + 1_100_000),
      "an exit must return the WHOLE position, not the largest filed row",
    );
  });

  it("an AMENDMENT supersedes wholesale — its rows are not summed with the original", () => {
    // The two reductions must not be conflated: across accessions the newest
    // filing REPLACES, within one accession rows are SUMMED. Summing an
    // amendment onto what it amends would double the position.
    const original = appleTranches(PERIOD_NOW, "0000950123-24-000001");
    const amendment = [
      filed({
        accession: "0000950123-24-000009",
        periodOfReport: PERIOD_NOW,
        filedAt: new Date("2024-09-01T00:00:00.000Z"),
        shares: 500_000,
        valueUsd: 500_000 * 289,
      }),
    ];
    const out = resolveQoQ([...original, ...amendment], []);
    assert.equal(out.length, 1);
    assert.equal(
      out[0]!.shares,
      500_000,
      "the amendment replaces the original",
    );
    assert.equal(out[0]!.rowsAggregated, 1);
  });

  it("is order-independent — the answer cannot depend on MongoDB's row order", () => {
    const rows = appleTranches(PERIOD_NOW, "0000950123-24-000001");
    const forward = resolveQoQ(rows, []);
    const reverse = resolveQoQ([...rows].reverse(), []);
    assert.deepEqual(forward, reverse);
  });

  it("keeps an OPTIONS position separate from the share position", () => {
    // This is the half `holderKey` already got right, and it has never been
    // pinned: reverting the key to `manager|cusip` left the whole suite green.
    const out = resolveQoQ(
      [
        filed({ shares: 1_000_000, valueUsd: 289_000_000 }),
        filed({
          rowIndex: 1,
          putCall: "Call",
          shares: 50_000,
          valueUsd: 14_450_000,
        }),
      ],
      [
        filed({
          periodOfReport: PERIOD_PRIOR,
          shares: 1_000_000,
          valueUsd: 289_000_000,
        }),
        filed({
          rowIndex: 1,
          periodOfReport: PERIOD_PRIOR,
          putCall: "Call",
          shares: 50_000,
          valueUsd: 14_450_000,
        }),
      ],
    );
    assert.equal(out.length, 2, "shares and calls are two positions");
    for (const row of out) {
      assert.equal(row.sharesDelta, 0, `${row.putCall ?? "shares"} moved`);
    }
  });

  it("a PRN row is not merged into the share position", () => {
    const out = resolveQoQ(
      [
        filed({ shares: 1_000, valueUsd: 100 }),
        filed({
          rowIndex: 1,
          sharesType: "PRN",
          shares: 5_000,
          valueUsd: 5_000,
        }),
      ],
      [],
    );
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((r) => r.sharesType).sort(),
      ["PRN", "SH"],
      "a PRN row's shares are dollars of face value, not shares",
    );
  });
});

describe("the holder sort is a TOTAL order", () => {
  const mk = (mgr: string, cusip: string) =>
    ({
      accession: "A",
      rowIndex: 0,
      managerCik10: mgr,
      managerName: null,
      periodOfReport: new Date("2024-06-30T00:00:00.000Z"),
      filedAt: new Date("2024-08-14T00:00:00.000Z"),
      cusip,
      figi: null,
      issuerName: "X",
      titleOfClass: "COM",
      valueUsd: 1_000_000,
      shares: 1000,
      sharesType: "SH",
      putCall: null,
      symbol: "X",
    }) as never;

  it("two holders tied on value AND delta do not depend on row order", () => {
    // Value and |delta| alone are not total: two identical, unchanged positions
    // tie on both, and the result then reflects whatever order MongoDB
    // happened to return. Probed before the fix: forward gave [1, 2], reverse
    // gave [2, 1] — the same data rendering two different lists.
    const rows = [mk("0000000001", "111111111"), mk("0000000002", "222222222")];
    const forward = resolveQoQ(rows, rows).map((r) => r.managerCik10);
    const reverse = resolveQoQ([...rows].reverse(), [...rows].reverse()).map(
      (r) => r.managerCik10,
    );
    assert.deepEqual(forward, reverse);
    assert.deepEqual(forward, ["0000000001", "0000000002"]);
  });

  it("value still dominates the tie-breakers", () => {
    const small = mk("0000000001", "111111111");
    const big = { ...(mk("0000000009", "999999999") as object), valueUsd: 9e9 };
    const out = resolveQoQ([small, big as never], []);
    assert.equal(
      out[0]!.managerCik10,
      "0000000009",
      "the tie-break outranked value",
    );
  });
});
