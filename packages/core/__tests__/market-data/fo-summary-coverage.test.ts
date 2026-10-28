/**
 * UNIT TEST — F&O summary coverage detection (MONEY-1189).
 *
 * The load-bearing case is `a BSE-only day is INCOMPLETE`. That single
 * condition is the whole two-year prod gap: `2026-06-02` carried 27 BSE summary
 * rows against 219 EOD underlyings, the day-granularity check called it done,
 * and ~108k NSE summary rows were never derived. Every re-run agreed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  retainedUnderlyings,
  selectIncompleteDays,
  selectNightlyTargets,
  type EodUnderlying,
} from "../../src/market-data/fo-summary-coverage";

const D = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
const CUTOFF = Date.UTC(2018, 0, 1);

const keys = (...k: string[]): Set<string> => new Set(k);
const eod = (...k: string[]): EodUnderlying[] =>
  k.map((key) => ({
    key,
    isStock: !key.startsWith("NIFTY") && !key.startsWith("BANKNIFTY"),
  }));

describe("retainedUnderlyings — mirrors the retention rule", () => {
  it("keeps stock underlyings on or after the 2018 cutoff", () => {
    const out = retainedUnderlyings(
      CUTOFF,
      eod("RELIANCE|NSE", "NIFTY|NSE"),
      CUTOFF,
    );
    assert.deepEqual([...out].sort(), ["NIFTY|NSE", "RELIANCE|NSE"]);
  });

  it("drops stock underlyings BEFORE the cutoff, keeps index", () => {
    // Without this mirror, every pre-2018 day looks permanently incomplete and
    // the backfill churns over 5,000+ days re-deriving nothing.
    const out = retainedUnderlyings(
      D("2010-06-01"),
      eod("RELIANCE|NSE", "NIFTY|NSE"),
      CUTOFF,
    );
    assert.deepEqual([...out], ["NIFTY|NSE"]);
  });

  it("dedupes an underlying seen across many contracts", () => {
    // One underlying has dozens of EOD rows (strikes × expiries); the expected
    // set is per UNDERLYING, not per contract.
    const out = retainedUnderlyings(
      CUTOFF,
      [
        { key: "NIFTY|NSE", isStock: false },
        { key: "NIFTY|NSE", isStock: false },
        { key: "NIFTY|NSE", isStock: false },
      ],
      CUTOFF,
    );
    assert.equal(out.size, 1);
  });
});

describe("selectIncompleteDays", () => {
  it("REGRESSION: a BSE-only day is INCOMPLETE — the two-year prod gap", () => {
    // 2026-06-02: 27 BSE summary rows, 219 EOD underlyings. The old
    // day-granularity check saw "has summaries" and skipped it forever.
    const expected = new Map([
      [D("2026-06-02"), keys("NIFTY|NSE", "RELIANCE|NSE", "SENSEX|BSE")],
    ]);
    const present = new Map([[D("2026-06-02"), keys("SENSEX|BSE")]]);
    const out = selectIncompleteDays(expected, present);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.missing, ["NIFTY|NSE", "RELIANCE|NSE"]);
    assert.equal(out[0]!.expected, 3);
    assert.equal(out[0]!.present, 1);
  });

  it("treats a day with NO summaries as incomplete (the 2026-08-11 case)", () => {
    const expected = new Map([
      [D("2026-08-11"), keys("NIFTY|NSE", "RELIANCE|NSE")],
    ]);
    const out = selectIncompleteDays(expected, new Map());
    assert.equal(out.length, 1);
    assert.equal(out[0]!.present, 0);
  });

  it("treats a fully covered day as complete — no churn", () => {
    // Idempotence: a second run must select nothing, or the nightly rewrites
    // every row it already wrote.
    const expected = new Map([
      [D("2026-06-02"), keys("NIFTY|NSE", "SENSEX|BSE")],
    ]);
    const present = new Map([
      [D("2026-06-02"), keys("NIFTY|NSE", "SENSEX|BSE")],
    ]);
    assert.deepEqual(selectIncompleteDays(expected, present), []);
  });

  it("ignores EXTRA summary rows with no EOD backing", () => {
    // A delisted underlying keeps its historical summary row. That is not a
    // reason to re-derive the day.
    const expected = new Map([[D("2026-06-02"), keys("NIFTY|NSE")]]);
    const present = new Map([
      [D("2026-06-02"), keys("NIFTY|NSE", "DELISTED|NSE")],
    ]);
    assert.deepEqual(selectIncompleteDays(expected, present), []);
  });

  it("returns days ASCENDING — the prev-day chain depends on order", () => {
    const expected = new Map([
      [D("2026-06-03"), keys("NIFTY|NSE")],
      [D("2026-06-01"), keys("NIFTY|NSE")],
      [D("2026-06-02"), keys("NIFTY|NSE")],
    ]);
    const out = selectIncompleteDays(expected, new Map());
    assert.deepEqual(
      out.map((d) => new Date(d.dateMs).toISOString().slice(0, 10)),
      ["2026-06-01", "2026-06-02", "2026-06-03"],
    );
  });

  it("reports what is missing, not just that something is", () => {
    // The counter is the point: a silent gap is what created this ticket.
    const expected = new Map([
      [D("2026-06-02"), keys("A|NSE", "B|NSE", "C|NSE")],
    ]);
    const present = new Map([[D("2026-06-02"), keys("B|NSE")]]);
    assert.deepEqual(selectIncompleteDays(expected, present)[0]!.missing, [
      "A|NSE",
      "C|NSE",
    ]);
  });
});

describe("selectNightlyTargets", () => {
  const latest = D("2026-08-11");
  const incomplete = [
    { dateMs: D("2024-01-05"), expected: 2, present: 0, missing: ["A|NSE"] },
    { dateMs: D("2026-08-08"), expected: 2, present: 0, missing: ["A|NSE"] },
    { dateMs: D("2026-08-11"), expected: 2, present: 0, missing: ["A|NSE"] },
  ];

  it("picks up a day whose data landed AFTER the run (2026-08-11)", () => {
    // The real failure: EOD rows written 19:27Z, summariser ran 18:00Z. The
    // old nightly targeted only the last EOD date and never revisited.
    const out = selectNightlyTargets(incomplete, latest, 7);
    assert.ok(out.some((d) => d.dateMs === D("2026-08-11")));
  });

  it("also heals a recent day missed earlier in the week", () => {
    const out = selectNightlyTargets(incomplete, latest, 7);
    assert.ok(out.some((d) => d.dateMs === D("2026-08-08")));
  });

  it("does NOT drag deep history into the nightly", () => {
    // A nightly that quietly turns into a 2-year backfill is its own outage.
    const out = selectNightlyTargets(incomplete, latest, 7);
    assert.ok(!out.some((d) => d.dateMs === D("2024-01-05")));
    assert.equal(out.length, 2);
  });

  it("returns nothing when everything recent is complete", () => {
    assert.deepEqual(selectNightlyTargets([], latest, 7), []);
  });
});
