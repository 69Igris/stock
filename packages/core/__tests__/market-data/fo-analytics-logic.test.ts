/**
 * UNIT TEST — F&O chain analytics (MONEY-1100 P4.4).
 *
 * Two layers, on purpose:
 *
 * 1. **Synthetic chains small enough to compute by hand.** The whole point of a
 *    pure math module is that the arithmetic can be checked away from the data.
 *    The 3-strike chain below has its full max-pain table written out in the
 *    comment, so a reader can verify the expected answer without running
 *    anything — and a wrong formula cannot be "confirmed" by re-deriving the
 *    expectation from the implementation.
 *
 * 2. **One shape-compatibility test against a REAL UDiFF F&O day**
 *    (`fo_udiff_day.sample.csv`, NSE 2026-08-10, the whole ABCAPITAL chain).
 *    The parser's rows are handed to `computeDerivativeSummary` with no
 *    mapping, no cast and no adapter, so the two modules are provably wired to
 *    the same shape rather than to two compatible-looking interfaces. Its
 *    expected numbers were cross-checked with an INDEPENDENT brute-force script
 *    written straight off the CSV (max pain 410, callOi 10,685,700, putOi
 *    4,061,000, futOi 40,148,100) — not read back out of this module.
 *
 * The null-vs-0 cases are not edge-case padding: "no previous day" and "open
 * interest did not move" are different facts, and this suite is what stops them
 * collapsing into the same stored number.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseUdiffFoBhavcopy } from "../../src/market-data/bhavcopy-derivatives";
import {
  computeDerivativeSummary,
  computeMaxPain,
  classifyOiBuildup,
  type DerivativeContractRow,
} from "../../src/market-data/fo-analytics-logic";

// ─── Fixtures & builders ─────────────────────────────────────────────

const DAY = new Date(Date.UTC(2026, 7, 10)); // Mon 2026-08-10
const PREV_DAY = new Date(Date.UTC(2026, 7, 7)); // Fri 2026-08-07
const NEAR = new Date(Date.UTC(2026, 7, 25)); // near monthly expiry
const NEXT = new Date(Date.UTC(2026, 8, 29)); // next monthly expiry
const WEEKLY = new Date(Date.UTC(2026, 7, 11)); // weekly option expiry

function row(p: Partial<DerivativeContractRow>): DerivativeContractRow {
  return {
    symbol: "TESTCO",
    exchange: "NSE",
    instrument: "FUTSTK",
    expiry: NEAR,
    strike: 0,
    optionType: "XX",
    date: DAY,
    close: 100,
    volume: 0,
    openInt: 0,
    ...p,
  };
}

const fut = (
  expiry: Date,
  close: number,
  openInt: number,
  extra: Partial<DerivativeContractRow> = {},
) => row({ instrument: "FUTSTK", expiry, close, openInt, ...extra });

const ce = (
  expiry: Date,
  strike: number,
  openInt: number,
  volume = 0,
  extra: Partial<DerivativeContractRow> = {},
) =>
  row({
    instrument: "OPTSTK",
    optionType: "CE",
    expiry,
    strike,
    openInt,
    volume,
    close: 1,
    ...extra,
  });

const pe = (
  expiry: Date,
  strike: number,
  openInt: number,
  volume = 0,
  extra: Partial<DerivativeContractRow> = {},
) =>
  row({
    instrument: "OPTSTK",
    optionType: "PE",
    expiry,
    strike,
    openInt,
    volume,
    close: 1,
    ...extra,
  });

/**
 * THE hand-computed chain. Everything in the happy-path tests refers back here.
 *
 * Futures            close   OI
 *   NEAR (25-Aug)     110    1000
 *   NEXT (29-Sep)     112     250
 *   → futOi 1250 · nearFutOi 1000 · rolled 250 → rolloverPct 20 (near share 80)
 *   → underlyingClose 100 ⇒ basis (110−100)/100×100 = +10.00%
 *
 * Near option chain (25-Aug)      far leg (29-Sep)
 *   strike   CE OI / vol   PE OI / vol      CE 130: OI 40 / vol 20
 *      100      10 /  5       30 / 20
 *      110      20 / 10       20 / 10
 *      120      30 / 15       10 / 15
 *   → callOi 60+40 = 100 · putOi 60      ⇒ pcrOi 60/100 = 0.60
 *   → callVol 30+20 = 50 · putVol 45     ⇒ pcrVol 45/50 = 0.90
 *
 * Max pain over the NEAR chain — Pain(P) = Σce OI·max(0,P−K) + Σpe OI·max(0,K−P):
 *   P=100 → ce 0                       + pe 20·(110−100) + 10·(120−100) = 400
 *   P=110 → ce 10·(110−100) = 100      + pe 10·(120−110)               = 200  ← min
 *   P=120 → ce 10·20 + 20·10 = 400     + pe 0                          = 400
 *   ⇒ max pain 110
 */
function baseToday(): DerivativeContractRow[] {
  return [
    fut(NEAR, 110, 1000),
    fut(NEXT, 112, 250),
    ce(NEAR, 100, 10, 5),
    ce(NEAR, 110, 20, 10),
    ce(NEAR, 120, 30, 15),
    pe(NEAR, 100, 30, 20),
    pe(NEAR, 110, 20, 10),
    pe(NEAR, 120, 10, 15),
    ce(NEXT, 130, 40, 20),
  ];
}

/** Previous session: near future 108 / OI 900, next future 111 / OI 200. */
function basePrev(): DerivativeContractRow[] {
  return [
    fut(NEAR, 108, 900, { date: PREV_DAY }),
    fut(NEXT, 111, 200, { date: PREV_DAY }),
  ];
}

function approx(actual: number | null, expected: number, msg?: string): void {
  assert.ok(actual !== null, msg ?? "expected a value, got null");
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg ?? "approx"}: ${actual} !≈ ${expected}`,
  );
}

// ─── computeMaxPain ──────────────────────────────────────────────────

describe("computeMaxPain", () => {
  it("finds the hand-computed minimum of the 3-strike chain", () => {
    // Pain table verified by hand in the baseToday() comment: 400 / 200 / 400.
    const calls = [ce(NEAR, 100, 10), ce(NEAR, 110, 20), ce(NEAR, 120, 30)];
    const puts = [pe(NEAR, 100, 30), pe(NEAR, 110, 20), pe(NEAR, 120, 10)];
    assert.equal(computeMaxPain(calls, puts), 110);
  });

  it("is unchanged by a constant lot-size multiplier", () => {
    // The published formula multiplies every payout by contracts-per-lot. It is
    // one positive constant, so it cannot move the argmin — which is why this
    // module does not carry a per-symbol, per-era lot-size table.
    const lot = 1250;
    const calls = [
      ce(NEAR, 100, 10 * lot),
      ce(NEAR, 110, 20 * lot),
      ce(NEAR, 120, 30 * lot),
    ];
    const puts = [
      pe(NEAR, 100, 30 * lot),
      pe(NEAR, 110, 20 * lot),
      pe(NEAR, 120, 10 * lot),
    ];
    assert.equal(computeMaxPain(calls, puts), 110);
  });

  it("resolves an exact tie to the lowest strike, deterministically", () => {
    // Symmetric book: CE 100 OI 10 and PE 110 OI 10.
    //   P=100 → ce 0 + pe 10·(110−100) = 100
    //   P=110 → ce 10·(110−100) = 100 + pe 0 = 100   → tie
    // Both score 100; the rule is "lowest strike", not "whichever the Map
    // iterated first" — reproducible inputs must give reproducible summaries.
    const calls = [ce(NEAR, 100, 10)];
    const puts = [pe(NEAR, 110, 10)];
    assert.equal(computeMaxPain(calls, puts), 100);
    // …and the reversed argument order must not change it.
    assert.equal(computeMaxPain([ce(NEAR, 100, 10)], [pe(NEAR, 110, 10)]), 100);
  });

  it("returns null for an empty chain and for a chain nobody holds", () => {
    assert.equal(computeMaxPain([], []), null);
    // Every candidate payout is 0 here, so "the minimum" would just be the
    // first strike scanned — a number that looks like a market level and isn't.
    assert.equal(
      computeMaxPain([ce(NEAR, 100, 0)], [pe(NEAR, 120, 0)]),
      null,
      "zero-OI chain must be null, not the lowest strike",
    );
  });

  it("sums duplicate strikes on the same side rather than overwriting", () => {
    // Two rows at the same strike (a split feed page) must add up: 10+10 CE at
    // 100 reproduces the 20-OI answer, not the 10-OI one.
    const doubled = computeMaxPain(
      [ce(NEAR, 100, 10), ce(NEAR, 100, 10), ce(NEAR, 120, 5)],
      [pe(NEAR, 120, 40)],
    );
    const single = computeMaxPain(
      [ce(NEAR, 100, 20), ce(NEAR, 120, 5)],
      [pe(NEAR, 120, 40)],
    );
    assert.equal(doubled, single);
  });
});

// ─── classifyOiBuildup ───────────────────────────────────────────────

describe("classifyOiBuildup", () => {
  it("maps all four sign quadrants", () => {
    assert.equal(classifyOiBuildup(+1, +1), "LONG");
    assert.equal(classifyOiBuildup(-1, +1), "SHORT");
    assert.equal(classifyOiBuildup(-1, -1), "LONG_UNWIND");
    assert.equal(classifyOiBuildup(+1, -1), "SHORT_COVER");
  });

  it("returns null when either axis is flat — a non-event is not a signal", () => {
    assert.equal(classifyOiBuildup(0, +100), null);
    assert.equal(classifyOiBuildup(+5, 0), null);
    assert.equal(classifyOiBuildup(0, 0), null);
  });

  it("returns null for non-finite deltas instead of guessing a quadrant", () => {
    assert.equal(classifyOiBuildup(Number.NaN, 1), null);
    assert.equal(classifyOiBuildup(1, Number.POSITIVE_INFINITY), null);
  });
});

// ─── Happy path ──────────────────────────────────────────────────────

describe("computeDerivativeSummary — hand-computed chain", () => {
  const s = computeDerivativeSummary({
    symbol: "TESTCO",
    exchange: "NSE",
    date: DAY,
    today: baseToday(),
    prevDay: basePrev(),
    underlyingClose: 100,
  });

  it("uses every row and rejects none", () => {
    assert.equal(s.rowsUsed, 9);
    assert.equal(s.rowsRejected, 0);
    assert.equal(s.prevRowsUsed, 2);
    assert.equal(s.prevRowsRejected, 0);
  });

  it("totals futures OI across ALL expiries (the roll-proof basis)", () => {
    assert.equal(s.futOi, 1250);
    assert.equal(s.nearFutOi, 1000);
    assert.equal(s.nearFutClose, 110);
    assert.equal(s.nearFutExpiry?.toISOString().slice(0, 10), "2026-08-25");
  });

  it("differences futures OI against the previous day, same basis", () => {
    // 1250 today − (900 + 200) yesterday.
    assert.equal(s.futOiChange, 150);
  });

  it("prices the basis off the NEAREST future against the cash close", () => {
    assert.equal(s.futBasisPct, 10);
  });

  it("reports rollover as the ROLLED-FORWARD share, with the near share beside it", () => {
    // 250 of 1250 has moved out of the near contract. Every Indian broker
    // prints this orientation; the complement is exposed separately so nobody
    // has to guess which one a stored 20 means.
    assert.equal(s.rolloverPct, 20);
    assert.equal(s.nearExpiryOiPct, 80);
  });

  it("computes PCR across all expiries, OI and volume independently", () => {
    assert.equal(s.callOi, 100); // 60 near + 40 far
    assert.equal(s.putOi, 60);
    assert.equal(s.callVol, 50); // 30 near + 20 far
    assert.equal(s.putVol, 45);
    assert.equal(s.pcrOi, 0.6);
    assert.equal(s.pcrVol, 0.9);
  });

  it("pins max pain to the hand-computed strike", () => {
    assert.equal(s.maxPain, 110);
    assert.equal(s.maxPainExpiry?.toISOString().slice(0, 10), "2026-08-25");
  });

  it("classifies the buildup from the near future's own day-over-day move", () => {
    // close 108 → 110 (+2) with OI 900 → 1000 (+100): price up on rising OI.
    assert.equal(s.oiBuildup, "LONG");
  });

  it("is independent of row order", () => {
    const reversed = computeDerivativeSummary({
      symbol: "TESTCO",
      exchange: "NSE",
      date: DAY,
      today: [...baseToday()].reverse(),
      prevDay: [...basePrev()].reverse(),
      underlyingClose: 100,
    });
    assert.deepEqual(reversed, s);
  });

  it("never emits a non-finite number in any numeric field", () => {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "number") {
        assert.ok(Number.isFinite(v), `${k} is non-finite: ${v}`);
      }
    }
  });
});

// ─── Expiry selection ────────────────────────────────────────────────

describe("expiry selection", () => {
  it("computes max pain on the NEAREST OPTION expiry, not the futures one", () => {
    // Index reality: weekly options, monthly futures. Pinning max pain to the
    // futures expiry would compute it over a chain a month from settling.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        fut(NEAR, 110, 1000),
        // Weekly chain: puts dominate low, calls dominate high → min at 100.
        ce(WEEKLY, 100, 5),
        ce(WEEKLY, 110, 50),
        pe(WEEKLY, 100, 5),
        pe(WEEKLY, 110, 5),
        // Monthly chain, deliberately centred elsewhere.
        ce(NEAR, 120, 40),
        pe(NEAR, 120, 40),
      ],
    });
    assert.equal(s.maxPainExpiry?.toISOString().slice(0, 10), "2026-08-11");
    assert.equal(s.nearFutExpiry?.toISOString().slice(0, 10), "2026-08-25");
    assert.equal(s.maxPain, 100);
  });

  it("excludes later expiries from the max-pain chain", () => {
    // The far CE at strike 100 with 1000 OI would drag the argmin from 110 down
    // to 100 if expiries were pooled — see the baseToday() pain table.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        ce(NEAR, 100, 10),
        ce(NEAR, 110, 20),
        ce(NEAR, 120, 30),
        pe(NEAR, 100, 30),
        pe(NEAR, 110, 20),
        pe(NEAR, 120, 10),
        ce(NEXT, 100, 1000),
      ],
    });
    assert.equal(s.maxPain, 110);
    assert.equal(s.maxPainExpiry?.toISOString().slice(0, 10), "2026-08-25");
    // …but PCR is explicitly an all-expiries number, so the far leg counts here.
    assert.equal(s.callOi, 1060);
  });

  it("matches the buildup contract by EXPIRY, not by the near slot", () => {
    // The session after an expiry: today's near contract (NEXT) was yesterday's
    // second month. Comparing "near slot to near slot" would difference two
    // different contracts and print a violent fake signal every month.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEXT, 112, 250)],
      prevDay: [
        fut(NEAR, 108, 900, { date: PREV_DAY }), // expired contract
        fut(NEXT, 115, 300, { date: PREV_DAY }), // the real comparand
      ],
    });
    // vs NEXT yesterday: 115 → 112 (−3) with OI 300 → 250 (−50) = LONG_UNWIND.
    // vs the near SLOT (108 → 112, 900 → 250) it would have read SHORT_COVER.
    assert.equal(s.oiBuildup, "LONG_UNWIND");
    assert.equal(s.futOiChange, 250 - 1200);
  });

  it("returns a null buildup when the near contract has no previous-day row", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 1000)],
      prevDay: [fut(NEXT, 111, 200, { date: PREV_DAY })],
    });
    assert.equal(s.oiBuildup, null, "no same-contract comparand ⇒ null");
    // …while the TOTAL-basis OI change is still well defined.
    assert.equal(s.futOiChange, 800);
  });
});

// ─── null-vs-zero: the decisions this module exists to get right ─────

describe("American-style option types (pre-2011 stock options)", () => {
  // NSE stock options were AMERICAN (OPTION_TYP "CA"/"PA") from their 2001
  // launch until the January-2011 conversion to European. Accepting only
  // CE/PE silently dropped every one of those rows — 14,204 on 2009-07-31
  // alone — leaving pcrOi/pcrVol/maxPain null across a decade of history with
  // no error. Index options were European throughout, so the same file mixes
  // both vocabularies and the gap read as "stock names have no option data".
  const ca = (expiry: Date, strike: number, openInt: number, volume = 0) =>
    row({
      instrument: "OPTSTK",
      optionType: "CA",
      expiry,
      strike,
      openInt,
      volume,
      close: 1,
    });
  const pa = (expiry: Date, strike: number, openInt: number, volume = 0) =>
    row({
      instrument: "OPTSTK",
      optionType: "PA",
      expiry,
      strike,
      openInt,
      volume,
      close: 1,
    });

  it("classifies CA as a call and PA as a put", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [ca(NEAR, 100, 200, 20), pa(NEAR, 100, 100, 5)],
    });
    assert.equal(s.callOi, 200);
    assert.equal(s.putOi, 100);
    assert.equal(s.pcrOi, 0.5);
    assert.equal(s.pcrVol, 0.25);
    assert.equal(s.rowsRejected, 0, "no American row may be rejected");
  });

  it("produces the SAME summary as the European spelling of the same chain", () => {
    const args = { symbol: "TESTCO", date: DAY, underlyingClose: 100 };
    const american = computeDerivativeSummary({
      ...args,
      today: [
        ca(NEAR, 100, 200, 20),
        ca(NEAR, 110, 50, 5),
        pa(NEAR, 100, 100, 5),
      ],
    });
    const european = computeDerivativeSummary({
      ...args,
      today: [
        ce(NEAR, 100, 200, 20),
        ce(NEAR, 110, 50, 5),
        pe(NEAR, 100, 100, 5),
      ],
    });
    // Exercise style changes nothing about what a call or a put IS.
    assert.equal(american.callOi, european.callOi);
    assert.equal(american.putOi, european.putOi);
    assert.equal(american.pcrOi, european.pcrOi);
    assert.equal(american.maxPain, european.maxPain);
  });

  it("handles a real-era MIXED file: American stock options + European index options", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [ca(NEAR, 100, 200), pe(NEAR, 100, 150)],
    });
    assert.equal(s.callOi, 200);
    assert.equal(s.putOi, 150);
    assert.equal(s.rowsRejected, 0);
  });

  it("still rejects an unrecognised option type rather than guessing a side", () => {
    // The counter must keep working — it is what surfaced CA/PA in the first
    // place, so a future dialect has to stay visible instead of being absorbed.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        ce(NEAR, 100, 200),
        row({
          instrument: "OPTSTK",
          optionType: "ZZ",
          expiry: NEAR,
          strike: 100,
          openInt: 999,
          close: 1,
        }),
      ],
    });
    assert.equal(s.callOi, 200, "the ZZ row must not join either side");
    assert.equal(s.putOi, null);
    assert.equal(s.rowsRejected, 1);
  });
});

describe("null is 'could not determine', never 0", () => {
  it("nulls every day-over-day field when prevDay is absent", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: baseToday(),
      underlyingClose: 100,
    });
    assert.equal(
      s.futOiChange,
      null,
      "must NOT be 0 — we had nothing to compare",
    );
    assert.equal(s.oiBuildup, null);
    // Same-day fields are unaffected.
    assert.equal(s.futOi, 1250);
    assert.equal(s.maxPain, 110);
  });

  it("treats an EMPTY prevDay the same as a missing one", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: baseToday(),
      prevDay: [],
    });
    assert.equal(s.futOiChange, null);
    assert.equal(s.oiBuildup, null);
  });

  it("nulls PCR when the call side is 0 — never Infinity", () => {
    // Calls exist but carry no open interest; puts do. The raw division is
    // Infinity, which is exactly the non-finite poison this repo hardens on.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        ce(NEAR, 100, 0, 5),
        pe(NEAR, 100, 100, 10),
        pe(NEAR, 110, 50, 10),
      ],
    });
    assert.equal(s.callOi, 0, "0 OI is a measured fact and stays 0");
    assert.equal(s.pcrOi, null);
    // Volume is guarded independently: calls DID trade, so pcrVol exists.
    assert.equal(s.callVol, 5);
    assert.equal(s.putVol, 20);
    assert.equal(s.pcrVol, 4);
  });

  it("nulls PCR components when a side has no rows at all", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [pe(NEAR, 100, 100, 10)],
    });
    assert.equal(s.callOi, null, "no CE rows ⇒ unknown, not 0");
    assert.equal(s.callVol, null);
    assert.equal(s.putOi, 100);
    assert.equal(s.pcrOi, null);
    assert.equal(s.pcrVol, null);
  });

  it("reports a real 0 PCR when puts are absent but calls are present", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [ce(NEAR, 100, 100, 10)],
    });
    assert.equal(s.putOi, null);
    assert.equal(s.pcrOi, 0, "no puts against live calls is a measured 0");
    assert.equal(s.pcrVol, 0);
  });

  it("nulls the basis for every unusable underlying close", () => {
    const base = { symbol: "TESTCO", date: DAY, today: baseToday() };
    for (const bad of [null, undefined, 0, -100, Number.NaN] as const) {
      const s = computeDerivativeSummary({ ...base, underlyingClose: bad });
      assert.equal(s.futBasisPct, null, `underlyingClose ${String(bad)}`);
    }
    // …and a usable one still computes.
    approx(
      computeDerivativeSummary({ ...base, underlyingClose: 100 }).futBasisPct,
      10,
    );
  });

  it("futures-only day: PCR and max pain are null, futures fields are not", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 1000), fut(NEXT, 112, 250)],
      underlyingClose: 100,
    });
    assert.equal(s.pcrOi, null);
    assert.equal(s.pcrVol, null);
    assert.equal(s.maxPain, null);
    assert.equal(s.maxPainExpiry, null);
    assert.equal(s.callOi, null);
    assert.equal(s.putOi, null);
    assert.equal(s.futOi, 1250);
    assert.equal(s.rolloverPct, 20);
    assert.equal(s.futBasisPct, 10);
  });

  it("options-only day: every futures field is null, options still compute", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        ce(NEAR, 100, 10),
        ce(NEAR, 110, 20),
        ce(NEAR, 120, 30),
        pe(NEAR, 100, 30),
        pe(NEAR, 110, 20),
        pe(NEAR, 120, 10),
      ],
      prevDay: [],
      underlyingClose: 100,
    });
    assert.equal(s.futOi, null, "no futures rows ⇒ unknown, not 0");
    assert.equal(s.futOiChange, null);
    assert.equal(s.futBasisPct, null);
    assert.equal(s.rolloverPct, null);
    assert.equal(s.nearExpiryOiPct, null);
    assert.equal(s.nearFutExpiry, null);
    assert.equal(s.oiBuildup, null);
    assert.equal(s.maxPain, 110);
    assert.equal(s.pcrOi, 1);
  });

  it("nulls rollover when futures rows exist but carry no open interest", () => {
    // 0/0 — the split is undefined, not "0% rolled".
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 0), fut(NEXT, 112, 0)],
    });
    assert.equal(s.futOi, 0, "measured 0 OI stays 0");
    assert.equal(s.rolloverPct, null);
    assert.equal(s.nearExpiryOiPct, null);
  });

  it("keeps a genuine 0 rollover when nothing has rolled yet", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 1000)],
    });
    assert.equal(s.rolloverPct, 0, "single live expiry ⇒ a real 0% rolled");
    assert.equal(s.nearExpiryOiPct, 100);
  });

  it("keeps a genuine 0 OI change distinct from an unknown one", () => {
    const flat = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 1000)],
      prevDay: [fut(NEAR, 110, 1000, { date: PREV_DAY })],
    });
    assert.equal(flat.futOiChange, 0, "OI genuinely did not move");
    assert.equal(flat.oiBuildup, null, "…and a flat day is still no quadrant");
  });
});

// ─── Guards on the job's query, not on the parser ────────────────────

describe("identity + poison guards", () => {
  it("rejects and counts rows for another underlying, exchange or day", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      exchange: "NSE",
      date: DAY,
      today: [
        fut(NEAR, 110, 1000),
        fut(NEAR, 999, 5000, { symbol: "OTHERCO" }),
        fut(NEAR, 888, 4000, { exchange: "BSE" }),
        fut(NEAR, 777, 3000, { date: PREV_DAY }),
        row({ instrument: "STK", expiry: NEAR, close: 1, openInt: 7 }),
      ],
    });
    assert.equal(s.rowsUsed, 1);
    assert.equal(s.rowsRejected, 4);
    assert.equal(s.futOi, 1000, "only this underlying's own row counted");
  });

  it("rejects previous-day rows that carry TODAY's date (a double-paged batch)", () => {
    // The most convincing wrong answer available: re-feeding today as prevDay
    // would make every day-over-day delta exactly 0.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [fut(NEAR, 110, 1000)],
      prevDay: [fut(NEAR, 110, 1000)], // date defaults to DAY
    });
    assert.equal(s.prevRowsUsed, 0);
    assert.equal(s.prevRowsRejected, 1);
    assert.equal(s.futOiChange, null, "must not report a fabricated 0");
    assert.equal(s.oiBuildup, null);
  });

  it("drops non-finite numerics instead of NaN-poisoning the whole summary", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        fut(NEAR, 110, 1000),
        fut(NEXT, Number.NaN, 250),
        ce(NEAR, 100, Number.NaN, 5),
        pe(NEAR, 100, 30, Number.POSITIVE_INFINITY),
        ce(NEAR, 110, 20, 10),
        pe(NEAR, 110, 20, 10),
      ],
      underlyingClose: 100,
    });
    assert.equal(s.rowsRejected, 3);
    assert.equal(s.futOi, 1000);
    assert.equal(s.callOi, 20);
    assert.equal(s.putOi, 20);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "number") {
        assert.ok(Number.isFinite(v), `${k} is non-finite: ${v}`);
      }
    }
  });

  it("rejects an option row carrying the futures strike sentinel", () => {
    // A strike of 0 on an option row is a mis-mapped future. Left in, it becomes
    // a candidate settlement price of 0, whose summed payout is always the
    // smallest available — max pain would collapse to 0 for the whole day.
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        ce(NEAR, 0, 5000),
        pe(NEAR, 0, 5000),
        ce(NEAR, 100, 10),
        ce(NEAR, 110, 20),
        ce(NEAR, 120, 30),
        pe(NEAR, 100, 30),
        pe(NEAR, 110, 20),
        pe(NEAR, 120, 10),
      ],
    });
    assert.equal(s.rowsRejected, 2);
    assert.equal(s.maxPain, 110, "sentinel strike must not drag max pain to 0");
  });

  it("counts, rather than drops, an instrument code it does not recognise", () => {
    // The legacy era also carries FUTIVX / FUTIRC / OPTIRC. Prefix matching
    // keeps them; anything matching neither prefix surfaces as a number.
    const s = computeDerivativeSummary({
      symbol: "INDIAVIX",
      date: DAY,
      today: [
        row({
          symbol: "INDIAVIX",
          instrument: "FUTIVX",
          expiry: NEAR,
          close: 14,
          openInt: 500,
        }),
        row({
          symbol: "INDIAVIX",
          instrument: "WEIRDNEW",
          expiry: NEAR,
          close: 1,
          openInt: 9,
        }),
      ],
    });
    assert.equal(s.futOi, 500, "FUT-prefixed legacy codes still count");
    assert.equal(s.rowsRejected, 1);
  });

  it("survives an Invalid Date without throwing", () => {
    const s = computeDerivativeSummary({
      symbol: "TESTCO",
      date: DAY,
      today: [
        fut(NEAR, 110, 1000),
        fut(new Date("not-a-date"), 111, 400),
        row({
          instrument: "FUTSTK",
          expiry: NEAR,
          close: 1,
          openInt: 3,
          date: new Date("nope"),
        }),
      ],
    });
    assert.equal(s.futOi, 1000);
    assert.equal(s.rowsRejected, 2);
  });
});

// ─── Shape compatibility with the real parser output ─────────────────

describe("shape-compat: real UDiFF F&O day → summary, no adapter", () => {
  const csv = readFileSync(
    join(import.meta.dirname, "..", "fixtures", "fo_udiff_day.sample.csv"),
    "utf-8",
  );
  // NSE 2026-08-10, ABCAPITAL's whole chain: 3 futures + 56 options over three
  // expiries. UndrlygPric on every row is 407.75 — used as the cash close.
  const parsed = parseUdiffFoBhavcopy(csv, "NSE", DAY);

  // The point of the test: the parser's rows go STRAIGHT in. If either module's
  // shape drifts this stops compiling/running rather than silently adapting.
  const s = computeDerivativeSummary({
    symbol: "ABCAPITAL",
    exchange: "NSE",
    date: DAY,
    today: parsed.rows,
    underlyingClose: 407.75,
  });

  it("consumes every parsed row without rejecting any", () => {
    assert.equal(parsed.rows.length, 59);
    assert.equal(parsed.skipped, 0);
    assert.equal(s.rowsUsed, 59, "no row of a real F&O day may be dropped");
    assert.equal(s.rowsRejected, 0);
  });

  it("totals the three real futures contracts", () => {
    // 38,976,300 (25-Aug) + 877,300 (29-Sep) + 294,500 (27-Oct).
    assert.equal(s.futOi, 40_148_100);
    assert.equal(s.nearFutOi, 38_976_300);
    assert.equal(s.nearFutClose, 411.3);
    assert.equal(s.nearFutExpiry?.toISOString().slice(0, 10), "2026-08-25");
  });

  it("prices a plausible carry basis against the published UndrlygPric", () => {
    // (411.30 − 407.75) / 407.75 × 100 — a ~0.87% premium two weeks from expiry.
    approx(s.futBasisPct, 0.8706315144083413);
  });

  it("reproduces the independently brute-forced PCR and max pain", () => {
    // Cross-checked against a script written straight off the CSV columns.
    assert.equal(s.callOi, 10_685_700);
    assert.equal(s.putOi, 4_061_000);
    assert.equal(s.callVol, 2294);
    assert.equal(s.putVol, 962);
    approx(s.pcrOi, 4_061_000 / 10_685_700);
    approx(s.pcrVol, 962 / 2294);
    assert.equal(s.maxPain, 410, "spot was 407.75 — max pain pins at 410");
    assert.equal(s.maxPainExpiry?.toISOString().slice(0, 10), "2026-08-25");
  });

  it("splits rollover mid-cycle, with no previous day to difference against", () => {
    // 2026-08-10 is 15 days from the 25-Aug expiry: almost nothing has rolled.
    approx(s.rolloverPct, ((40_148_100 - 38_976_300) / 40_148_100) * 100);
    assert.ok(s.rolloverPct !== null && s.rolloverPct < 5);
    approx(s.nearExpiryOiPct, 100 - (s.rolloverPct ?? 0));
    // No prevDay supplied ⇒ these stay unknown rather than reading as flat.
    assert.equal(s.futOiChange, null);
    assert.equal(s.oiBuildup, null);
  });

  it("emits no non-finite number anywhere on a real day", () => {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "number") {
        assert.ok(Number.isFinite(v), `${k} is non-finite: ${v}`);
      }
    }
  });
});
