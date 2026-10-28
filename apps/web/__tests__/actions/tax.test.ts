/**
 * Tax report — DE-SHADOWED tests for the LIVE money path (MONEY-620).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN
 * ────────────────────────────────────────────────────────────────────────────
 * The previous version of this file was a textbook SHADOW: it re-declared
 * `getCurrentFY`, `parseFYDates`, an advance-tax installment helper, AND a
 * `classifyGain` STCG/LTCG rule INLINE and asserted the copies. It imported
 * NOTHING from source. Worse, its inline `classifyGain` used `holdingDays >= 365
 * → LTCG`, while the REAL capital-gains tool uses `holdingDays <= 365 → STCG`
 * (i.e. day 365 is SHORT-term) — so the shadow was green while asserting a
 * DIFFERENT boundary than production. A user filing on those numbers would have
 * been mis-bucketed at the exact LTCG threshold.
 *
 * This file now:
 *   (A) imports & asserts the REAL exported pure logic from the service's
 *       `tax-logic.ts` sibling (the de-shadow extraction), via the relative
 *       source path — no logic is re-declared here; and
 *   (B) drives the REAL exported `getTaxReport` / `getPairedTradesForFY`
 *       services end-to-end through a recording-prisma `require.cache` seam
 *       (the established `services-data-e2e.test.ts` pattern), proving the live
 *       user-facing tax report never crashes on a bad stored trade and never
 *       leaks NaN/Invalid into the returned figures, and that every query is
 *       scoped to the caller's userId (IDOR).
 *
 * The capital-gains CLASSIFICATION + arithmetic itself lives in
 * `@usemoney/research`'s `computeCapitalGainsTaxTool` and is de-shadowed in
 * `packages/research/__tests__/compute-capital-gains-tax.test.ts`. Here we keep
 * that tool REAL (un-stubbed, pure math) so the service is genuinely exercised
 * end-to-end through it.
 *
 * Source under test:
 *   packages/services/src/tax-logic.ts      (pure helpers — unit layer)
 *   packages/services/src/tax.service.ts    (getTaxReport / getPairedTradesForFY)
 *
 * Bugs found while writing these and FIXED in source (guards only — correct
 * tax numbers are unchanged):
 *   BUG #1: a stored PairedTradeView row with an unparseable `entryDate`/
 *           `exitDate` threw `RangeError: Invalid time value` on `.toISOString()`
 *           inside `getPairedTradesForFY`, taking down the ENTIRE tax report.
 *   BUG #2: a Holding with an unparseable `createdAt` threw the same RangeError
 *           inside `getTaxReport`'s harvesting projection.
 *   BUG #3: a NaN/Infinity `entryPrice`/`exitPrice`/`quantity` leaked a NaN
 *           `buyValue`/`sellValue` into the gain (rendered as a corrupt figure).
 *
 * Runs under the default `node --import tsx --test` (CJS) — CWD must be
 * `apps/web` for the `@/` alias. No live Mongo / Redis is ever touched.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── (A) UNIT LAYER: import the REAL exported pure logic ─────────────────────
//
// Relative source path (no `@/` alias — this is a cross-package import). This is
// the de-shadow: we assert the SAME functions the service calls.
import {
  getCurrentFY,
  parseFYDates,
  fyWindowUtc,
  finite,
  safeISODate,
  mapPairedTradeRow,
  mapPairedTradesForFY,
  mapHoldingForHarvesting,
  mapHoldingsForHarvesting,
  type RawPairedTradeRow,
  type RawHoldingRow,
} from "../../../../packages/services/src/tax-logic";

// The research capital-gains tool replicates the IST FY window (it sits below
// services in the dep graph and cannot import `fyWindowUtc`). This test asserts
// the two windows are bit-for-bit equal at the boundary — the de-sync guard.
import { computeCapitalGainsTaxTool } from "../../../../packages/research/src/tools/compute-capital-gains-tax";
import type { ToolOutput } from "../../../../packages/research/src/tools/types";
import type { CapitalGainsTaxResult as CGResult } from "../../../../packages/research/src/types";

// ════════════════════════════════════════════════════════════════════════════
// (A) UNIT — tax-logic.ts pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe("tax-logic.getCurrentFY (real export)", () => {
  it("returns YYYY-YY format", () => {
    assert.match(
      getCurrentFY(new Date("2025-07-15T00:00:00Z")),
      /^\d{4}-\d{2}$/
    );
  });

  it("Apr 1 lands in the NEW FY (FY starts in April)", () => {
    // 2025-04-01 → FY 2025-26
    assert.equal(getCurrentFY(new Date("2025-04-01T06:00:00Z")), "2025-26");
  });

  it("Mar 31 lands in the OLD FY (last day of the FY)", () => {
    // 2025-03-31 → FY 2024-25
    assert.equal(getCurrentFY(new Date("2025-03-31T06:00:00Z")), "2024-25");
  });

  it("January is in the previous-April FY", () => {
    assert.equal(getCurrentFY(new Date("2026-01-10T06:00:00Z")), "2025-26");
  });

  it("December is in the same-April FY", () => {
    assert.equal(getCurrentFY(new Date("2025-12-31T06:00:00Z")), "2025-26");
  });

  it("defaults to the real clock and still returns a valid FY (no throw)", () => {
    assert.match(getCurrentFY(), /^\d{4}-\d{2}$/);
  });
});

describe("tax-logic.parseFYDates / fyWindowUtc (real export — IST-anchored, MONEY-620)", () => {
  // FY "2025-26" = Apr 1 2025 00:00:00.000 IST → Mar 31 2026 23:59:59.999 IST
  //              = 2025-03-31T18:30:00.000Z   → 2026-03-31T18:29:59.999Z (UTC)
  it("parses 2025-26 to the IST-anchored UTC window (not naive UTC midnight)", () => {
    const { start, end } = parseFYDates("2025-26");
    assert.equal(start.toISOString(), "2025-03-31T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-03-31T18:29:59.999Z");
  });

  it("parseFYDates == fyWindowUtc (alias agrees field-for-field)", () => {
    const a = parseFYDates("2024-25");
    const b = fyWindowUtc("2024-25");
    assert.equal(a.start.getTime(), b.gte.getTime());
    assert.equal(a.end.getTime(), b.lte.getTime());
  });

  it("FY 2024-25 exact UTC bounds (the worked example)", () => {
    const { gte, lte } = fyWindowUtc("2024-25");
    assert.equal(gte.toISOString(), "2024-03-31T18:30:00.000Z");
    assert.equal(lte.toISOString(), "2025-03-31T18:29:59.999Z");
  });

  it("accepts a 4-digit end label (2024-2025) identically to 2024-25", () => {
    const a = fyWindowUtc("2024-2025");
    const b = fyWindowUtc("2024-25");
    assert.equal(a.gte.getTime(), b.gte.getTime());
    assert.equal(a.lte.getTime(), b.lte.getTime());
  });

  it("start strictly before end, spanning ~one year", () => {
    const { start, end } = parseFYDates("2024-25");
    assert.ok(start.getTime() < end.getTime());
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    assert.ok(days >= 364 && days <= 366, `got ${days} days`);
  });

  it("the IST Apr-1 00:00 start instant is INSIDE the window (gte inclusive)", () => {
    const { start, end } = parseFYDates("2025-26");
    const boundary = new Date("2025-04-01T00:00:00.000+05:30"); // = 2025-03-31T18:30Z
    assert.ok(boundary >= start && boundary <= end);
    assert.equal(boundary.getTime(), start.getTime()); // exactly the gte
  });

  it("the IST Mar-31 23:59:59.999 end instant is INSIDE the window (lte inclusive)", () => {
    const { start, end } = parseFYDates("2025-26");
    const boundary = new Date("2026-03-31T23:59:59.999+05:30"); // = 2026-03-31T18:29:59.999Z
    assert.ok(boundary >= start && boundary <= end);
    assert.equal(boundary.getTime(), end.getTime()); // exactly the lte
  });

  it("one ms past the IST Mar-31 end is OUTSIDE the window", () => {
    const { end } = parseFYDates("2025-26");
    const justAfter = new Date("2026-04-01T00:00:00.000+05:30"); // = 2026-03-31T18:30Z
    assert.ok(justAfter > end);
  });

  it("one ms before the IST Apr-1 start is OUTSIDE the window", () => {
    const { start } = parseFYDates("2025-26");
    const justBefore = new Date("2025-03-31T23:59:59.999+05:30"); // = 2025-03-31T18:29:59.999Z
    assert.ok(justBefore < start);
  });

  it("a trade at Apr 1 02:00 IST is INSIDE the new FY (was misfiled to the prior FY)", () => {
    // Apr 1 2024 02:00 IST = 2024-03-31T20:30:00Z. The OLD naive-UTC window
    // (gte 2024-04-01T00:00Z) excluded it from FY 2024-25; the IST window includes it.
    const { gte, lte } = fyWindowUtc("2024-25");
    const seam = new Date("2024-04-01T02:00:00+05:30");
    assert.equal(seam.toISOString(), "2024-03-31T20:30:00.000Z");
    assert.ok(
      seam >= gte && seam <= lte,
      "Apr 1 early-IST must be in FY 2024-25"
    );
    // And it is NOT in the prior FY 2023-24.
    const prior = fyWindowUtc("2023-24");
    assert.ok(seam > prior.lte, "must NOT belong to FY 2023-24");
  });

  it("a trade at Mar 31 23:30 IST stays in the CURRENT FY (not pushed to the next)", () => {
    // Mar 31 2025 23:30 IST = 2025-03-31T18:00:00Z, inside FY 2024-25.
    const { gte, lte } = fyWindowUtc("2024-25");
    const seam = new Date("2025-03-31T23:30:00+05:30");
    assert.equal(seam.toISOString(), "2025-03-31T18:00:00.000Z");
    assert.ok(
      seam >= gte && seam <= lte,
      "Mar 31 late-IST stays in FY 2024-25"
    );
    const next = fyWindowUtc("2025-26");
    assert.ok(seam < next.gte, "must NOT belong to FY 2025-26");
  });

  it("throws RangeError on a malformed FY string (caller catches → sanitized)", () => {
    assert.throws(() => parseFYDates("not-a-fy"), RangeError);
    assert.throws(() => parseFYDates(""), RangeError);
    assert.throws(() => fyWindowUtc("garbage"), RangeError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-620 — CROSS-PATH AGREEMENT: the service FY window (tax-logic
// `fyWindowUtc`) and the research capital-gains tool's FY filter MUST classify
// the SAME exit instant into the SAME IST FY. Research can't import the helper
// (dep-graph direction), so it replicates the arithmetic; here we drive the REAL
// tool through a `sellTimestamp` and assert the boundary verdicts match.
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — service FY window ≡ research FY filter (IST boundary)", () => {
  /** Run the REAL tool and return whether a single trade survived the FY filter. */
  async function toolIncludes(
    sellTimestamp: string,
    fy: string
  ): Promise<boolean> {
    const out: ToolOutput = await computeCapitalGainsTaxTool.execute({
      trades: [
        {
          symbol: "SEAM",
          buyDate: "2020-01-01", // long-held; irrelevant to the FY filter
          sellDate: sellTimestamp.slice(0, 10),
          sellTimestamp,
          buyValue: 100,
          sellValue: 200,
          segment: "EQ",
        },
      ],
      fy,
    });
    assert.equal(out.success, true, out.error);
    return (out.data as CGResult).trades.length === 1;
  }

  /** The service-side verdict: is this instant inside the FY's UTC window? */
  function windowIncludes(sellTimestamp: string, fy: string): boolean {
    const { gte, lte } = fyWindowUtc(fy);
    const t = new Date(sellTimestamp).getTime();
    return t >= gte.getTime() && t <= lte.getTime();
  }

  // Each seam instant is asserted on BOTH paths and they must AGREE.
  const seams: Array<{
    label: string;
    iso: string;
    fy: string;
    inFy: boolean;
  }> = [
    {
      label: "Apr 1 02:00 IST → FY 2024-25 (not 2023-24)",
      iso: "2024-03-31T20:30:00.000Z", // = 2024-04-01T02:00+05:30
      fy: "2024-25",
      inFy: true,
    },
    {
      label: "Apr 1 02:00 IST is NOT in the prior FY 2023-24",
      iso: "2024-03-31T20:30:00.000Z",
      fy: "2023-24",
      inFy: false,
    },
    {
      label: "Mar 31 23:30 IST → FY 2024-25 (not 2025-26)",
      iso: "2025-03-31T18:00:00.000Z", // = 2025-03-31T23:30+05:30
      fy: "2024-25",
      inFy: true,
    },
    {
      label: "Mar 31 23:30 IST is NOT in the next FY 2025-26",
      iso: "2025-03-31T18:00:00.000Z",
      fy: "2025-26",
      inFy: false,
    },
    {
      label: "Mar 31 23:30 IST (2024) → FY 2023-24",
      iso: "2024-03-31T18:00:00.000Z", // = 2024-03-31T23:30+05:30
      fy: "2023-24",
      inFy: true,
    },
    {
      label: "exact gte boundary Apr 1 00:00 IST is INSIDE (inclusive)",
      iso: "2024-03-31T18:30:00.000Z",
      fy: "2024-25",
      inFy: true,
    },
    {
      label: "exact lte boundary Mar 31 23:59:59.999 IST is INSIDE (inclusive)",
      iso: "2025-03-31T18:29:59.999Z",
      fy: "2024-25",
      inFy: true,
    },
    {
      label: "one ms before gte is OUTSIDE",
      iso: "2024-03-31T18:29:59.999Z",
      fy: "2024-25",
      inFy: false,
    },
    {
      label: "one ms after lte is OUTSIDE",
      iso: "2025-03-31T18:30:00.000Z",
      fy: "2024-25",
      inFy: false,
    },
    {
      label:
        "mid-year trade (Aug, far from any seam) is INSIDE — behaviour-preserving",
      iso: "2024-08-15T06:00:00.000Z",
      fy: "2024-25",
      inFy: true,
    },
  ];

  for (const s of seams) {
    it(`${s.label} — tool & window agree (${s.inFy ? "IN" : "OUT"})`, async () => {
      const toolVerdict = await toolIncludes(s.iso, s.fy);
      const windowVerdict = windowIncludes(s.iso, s.fy);
      assert.equal(
        toolVerdict,
        windowVerdict,
        `tool=${toolVerdict} window=${windowVerdict} for ${s.iso} / FY ${s.fy}`
      );
      assert.equal(toolVerdict, s.inFy, `expected inFy=${s.inFy}`);
    });
  }

  it("the duplicated research window is bit-for-bit equal to the service window", async () => {
    // Probe the tool at instants 1ms inside each bound: if the tool's internal
    // window differed from fyWindowUtc by even 1ms, one of these would disagree.
    for (const fy of ["2023-24", "2024-25", "2025-26"]) {
      const { gte, lte } = fyWindowUtc(fy);
      const justInsideGte = new Date(gte.getTime()).toISOString();
      const justInsideLte = new Date(lte.getTime()).toISOString();
      const justBeforeGte = new Date(gte.getTime() - 1).toISOString();
      const justAfterLte = new Date(lte.getTime() + 1).toISOString();
      assert.equal(await toolIncludes(justInsideGte, fy), true, `gte ${fy}`);
      assert.equal(await toolIncludes(justInsideLte, fy), true, `lte ${fy}`);
      assert.equal(await toolIncludes(justBeforeGte, fy), false, `<gte ${fy}`);
      assert.equal(await toolIncludes(justAfterLte, fy), false, `>lte ${fy}`);
    }
  });
});

describe("tax-logic.finite (real export — non-finite money guard)", () => {
  it("passes finite numbers through unchanged", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(123.45), 123.45);
    assert.equal(finite(-9999), -9999);
    assert.equal(finite(1e15), 1e15);
  });

  it("coerces NaN / ±Infinity / null / undefined to 0", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
  });
});

describe("tax-logic.safeISODate (real export — Invalid-Date crash guard)", () => {
  it("returns the UTC YYYY-MM-DD for a valid Date", () => {
    assert.equal(safeISODate(new Date("2025-06-15T18:30:00Z")), "2025-06-15");
  });

  it("returns null for an Invalid Date (NEVER throws RangeError)", () => {
    // This is the exact crash vector: new Date("garbage").toISOString() throws.
    assert.doesNotThrow(() => safeISODate(new Date("garbage")));
    assert.equal(safeISODate(new Date("garbage")), null);
    assert.equal(safeISODate(new Date(NaN)), null);
  });

  it("returns null for null / undefined / non-Date", () => {
    assert.equal(safeISODate(null), null);
    assert.equal(safeISODate(undefined), null);
  });

  it("the epoch (0) is a VALID date, not treated as missing", () => {
    assert.equal(safeISODate(new Date(0)), "1970-01-01");
  });
});

describe("tax-logic.mapPairedTradeRow (real export)", () => {
  const base: RawPairedTradeRow = {
    symbol: "INFY",
    entryDate: new Date("2025-05-01T00:00:00Z"),
    exitDate: new Date("2025-06-01T00:00:00Z"),
    entryPrice: 100,
    exitPrice: 150,
    quantity: 10,
    segment: "EQ",
  };

  it("maps a clean row: dates → YYYY-MM-DD, value = price * qty", () => {
    const r = mapPairedTradeRow(base);
    assert.ok(r);
    assert.equal(r!.symbol, "INFY");
    assert.equal(r!.buyDate, "2025-05-01");
    assert.equal(r!.sellDate, "2025-06-01");
    // MONEY-620: full exit instant carried for the IST-accurate FY filter.
    assert.equal(r!.sellTimestamp, "2025-06-01T00:00:00.000Z");
    assert.equal(r!.buyValue, 1000); // 100 * 10
    assert.equal(r!.sellValue, 1500); // 150 * 10
    assert.equal(r!.segment, "EQ");
  });

  it("MONEY-620: a seam exit keeps its FULL instant in sellTimestamp (not the UTC date)", () => {
    // Apr 1 02:00 IST = 2024-03-31T20:30:00Z. The date-only sellDate is the UTC
    // day "2024-03-31", but sellTimestamp preserves the exact instant so the
    // tool can classify it into the correct IST FY.
    const r = mapPairedTradeRow({
      ...base,
      exitDate: new Date("2024-04-01T02:00:00+05:30"),
    });
    assert.ok(r);
    assert.equal(r!.sellDate, "2024-03-31"); // UTC calendar date (unchanged semantics)
    assert.equal(r!.sellTimestamp, "2024-03-31T20:30:00.000Z"); // full instant
  });

  it("BUG #1 GUARD: an Invalid entryDate → row DROPPED (null), no throw", () => {
    const row = { ...base, entryDate: new Date("nope") };
    assert.doesNotThrow(() => mapPairedTradeRow(row));
    assert.equal(mapPairedTradeRow(row), null);
  });

  it("BUG #1 GUARD: an Invalid exitDate → row DROPPED (null), no throw", () => {
    const row = { ...base, exitDate: new Date("not-a-date") };
    assert.equal(mapPairedTradeRow(row), null);
  });

  it("a null entry/exit date → row DROPPED (null)", () => {
    assert.equal(mapPairedTradeRow({ ...base, entryDate: null }), null);
    assert.equal(mapPairedTradeRow({ ...base, exitDate: null }), null);
  });

  it("BUG #3 GUARD: NaN entryPrice → buyValue 0 (finite), not NaN", () => {
    const r = mapPairedTradeRow({ ...base, entryPrice: NaN });
    assert.ok(r);
    assert.equal(r!.buyValue, 0);
    assert.ok(Number.isFinite(r!.buyValue));
    assert.equal(r!.sellValue, 1500); // unaffected
  });

  it("BUG #3 GUARD: Infinity exitPrice → sellValue 0 (finite), not Infinity", () => {
    const r = mapPairedTradeRow({ ...base, exitPrice: Infinity });
    assert.ok(r);
    assert.equal(r!.sellValue, 0);
    assert.ok(Number.isFinite(r!.sellValue));
  });

  it("BUG #3 GUARD: NaN quantity → both values 0 (finite)", () => {
    const r = mapPairedTradeRow({ ...base, quantity: NaN });
    assert.ok(r);
    assert.equal(r!.buyValue, 0);
    assert.equal(r!.sellValue, 0);
    assert.ok(Number.isFinite(r!.buyValue) && Number.isFinite(r!.sellValue));
  });

  it("null exitPrice → sellValue 0 (closed-but-no-exit-price edge)", () => {
    const r = mapPairedTradeRow({ ...base, exitPrice: null });
    assert.ok(r);
    assert.equal(r!.sellValue, 0);
  });
});

describe("tax-logic.mapPairedTradesForFY (real export — list mapping)", () => {
  it("drops only the undatable rows, keeps the valid ones", () => {
    const rows: RawPairedTradeRow[] = [
      {
        symbol: "GOOD",
        entryDate: new Date("2025-05-01T00:00:00Z"),
        exitDate: new Date("2025-06-01T00:00:00Z"),
        entryPrice: 100,
        exitPrice: 200,
        quantity: 1,
        segment: "EQ",
      },
      {
        symbol: "BADENTRY",
        entryDate: new Date("garbage"),
        exitDate: new Date("2025-06-01T00:00:00Z"),
        entryPrice: 100,
        exitPrice: 9999,
        quantity: 1,
        segment: "EQ",
      },
      {
        symbol: "BADEXIT",
        entryDate: new Date("2025-05-01T00:00:00Z"),
        exitDate: new Date(NaN),
        entryPrice: 100,
        exitPrice: 9999,
        quantity: 1,
        segment: "EQ",
      },
    ];
    const out = mapPairedTradesForFY(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.symbol, "GOOD");
  });

  it("empty input → empty output (no throw)", () => {
    assert.deepEqual(mapPairedTradesForFY([]), []);
  });

  it("every undatable row dropped → empty output (no crash, no NaN)", () => {
    const rows: RawPairedTradeRow[] = [
      {
        symbol: "X",
        entryDate: new Date("bad"),
        exitDate: new Date("bad"),
        entryPrice: 1,
        exitPrice: 2,
        quantity: 1,
        segment: "EQ",
      },
    ];
    assert.deepEqual(mapPairedTradesForFY(rows), []);
  });
});

describe("tax-logic.mapHoldingForHarvesting (real export)", () => {
  const today = "2026-06-05";
  const base: RawHoldingRow = {
    symbol: "TCS",
    quantity: 10,
    averagePrice: 3000,
    currentPrice: 3500,
    createdAt: new Date("2025-01-10T00:00:00Z"),
  };

  it("maps a clean holding: currentValue, costBasis, buyDate", () => {
    const h = mapHoldingForHarvesting(base, today);
    assert.equal(h.symbol, "TCS");
    assert.equal(h.currentValue, 35000); // 3500 * 10
    assert.equal(h.costBasis, 30000); // 3000 * 10
    assert.equal(h.buyDate, "2025-01-10");
  });

  it("currentPrice falls back to averagePrice when missing (matches `||`)", () => {
    const h = mapHoldingForHarvesting({ ...base, currentPrice: null }, today);
    assert.equal(h.currentValue, 30000); // averagePrice 3000 * 10
  });

  it("BUG #2 GUARD: Invalid createdAt → falls back to today, no throw", () => {
    const row = { ...base, createdAt: new Date("not-a-date") };
    assert.doesNotThrow(() => mapHoldingForHarvesting(row, today));
    assert.equal(mapHoldingForHarvesting(row, today).buyDate, today);
  });

  it("missing createdAt → falls back to today", () => {
    assert.equal(
      mapHoldingForHarvesting({ ...base, createdAt: null }, today).buyDate,
      today
    );
  });

  it("non-finite price/qty are sanitized to finite values", () => {
    const h = mapHoldingForHarvesting(
      { ...base, quantity: NaN, averagePrice: Infinity, currentPrice: NaN },
      today
    );
    assert.ok(Number.isFinite(h.currentValue));
    assert.ok(Number.isFinite(h.costBasis));
    assert.equal(h.currentValue, 0);
    assert.equal(h.costBasis, 0);
  });

  it("list wrapper maps each holding and never throws on a bad one", () => {
    const rows: RawHoldingRow[] = [
      base,
      {
        symbol: "BAD",
        quantity: 1,
        averagePrice: 10,
        currentPrice: 12,
        createdAt: new Date("x"),
      },
    ];
    const out = mapHoldingsForHarvesting(rows, today);
    assert.equal(out.length, 2);
    assert.equal(out[1]!.buyDate, today); // bad date → today fallback
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (B) LIVE SERVICE — drive the REAL getTaxReport / getPairedTradesForFY
//     through a recording-prisma require.cache seam (capital-gains tool kept REAL)
// ════════════════════════════════════════════════════════════════════════════

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/** Recording prisma double — captures every model.method(args), returns queued results. */
class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    const err = self.failures.get(`${model}.${method}`);
                    if (err) return Promise.reject(err);
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection ───────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

interface CoreCacheRecorder {
  getCachedCalls: Array<{ namespace: string; userId: string; rest: unknown[] }>;
  setCachedCalls: Array<{
    namespace: string;
    userId: string;
    subkey: string;
    value: unknown;
    rest: unknown[];
  }>;
  /** When set, the next getCached returns this value (then clears). */
  cacheHit?: unknown;
}

function freshCoreRecorder(): CoreCacheRecorder {
  return { getCachedCalls: [], setCachedCalls: [] };
}

let activePrisma: RecordingPrisma = new RecordingPrisma();
let activeCore: CoreCacheRecorder = freshCoreRecorder();

/** Stable prisma stub forwarding to the active recorder (identity never changes). */
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined; // not a thenable
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") {
          return async (
            namespace: string,
            userId: string,
            ...rest: unknown[]
          ) => {
            activeCore.getCachedCalls.push({ namespace, userId, rest });
            const hit = activeCore.cacheHit;
            activeCore.cacheHit = undefined;
            return hit ?? null;
          };
        }
        if (k === "setCached") {
          return async (
            namespace: string,
            userId: string,
            subkey: string,
            value: unknown,
            ...rest: unknown[]
          ) => {
            activeCore.setCachedCalls.push({
              namespace,
              userId,
              subkey,
              value,
              rest,
            });
          };
        }
        return async () => {};
      },
    }
  );
}

let servicesSingleton: ServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

/** Install stubs + require the barrel once. The research tools are KEPT REAL. */
function installServices(): ServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // Drop already-loaded service modules so they re-bind to our stubs.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // NOTE: `@usemoney/research/tools` is intentionally NOT stubbed — the capital
  // gains / harvesting / advance-tax / ITR tools are pure compute with no I/O,
  // so the service runs through the REAL math (true integration).

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

// ── structural types for the bits we drive ──────────────────────────────────

interface ServiceOk<T> {
  success: true;
  data: T;
  message?: string;
}
interface ServiceErr {
  success: false;
  error: string;
}
type Result<T> = ServiceOk<T> | ServiceErr;

interface PairedTradeForFYRow {
  symbol: string;
  buyDate: string;
  sellDate: string;
  sellTimestamp: string;
  buyValue: number;
  sellValue: number;
  segment: string;
}

interface CapitalGains {
  fy: string;
  equity: {
    stcg: { gains: number; losses: number; net: number; tax: number };
    ltcg: {
      gains: number;
      losses: number;
      net: number;
      exemption: number;
      taxable: number;
      tax: number;
    };
  };
  fno: { profits: number; losses: number; net: number; note: string };
  totalTax: number;
  effectiveRate: number;
  trades: Array<Record<string, unknown>>;
}

interface TaxReport {
  capitalGains: CapitalGains;
  harvesting: {
    opportunities: unknown[];
    totalPotentialSaving: number;
    gaarWarning: string;
  };
  advanceTax: {
    totalEstimatedTax: number;
    isApplicable: boolean;
    installments: unknown[];
    interestU234C: number;
  };
  itrSchedule: {
    scheduleCG: {
      s111A: { description: string; stcgGains: number; stcgTax: number };
      s112A: {
        description: string;
        ltcgGains: number;
        exemption: number;
        taxable: number;
        ltcgTax: number;
      };
    };
    csvData: string;
    summary: string;
  };
}

interface ServicesModule {
  getPairedTradesForFY: (
    userId: string,
    fy?: string
  ) => Promise<Result<PairedTradeForFYRow[]>>;
  getTaxReport: (userId: string, fy?: string) => Promise<Result<TaxReport>>;
}

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got: ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}

/** A clean PairedTradeView DB row for the FY 2025-26. */
function ptv(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    symbol: "INFY",
    entryDate: new Date("2025-05-01T00:00:00Z"),
    exitDate: new Date("2025-06-01T00:00:00Z"),
    entryPrice: 100,
    exitPrice: 200,
    quantity: 10,
    segment: "EQ",
    ...over,
  };
}

// ── (B.1) getPairedTradesForFY — query shape, IDOR, Invalid-Date safety ──────

describe("MONEY-620 — getPairedTradesForFY (LIVE service, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });

  it("IDOR: query is scoped to the caller's userId + CLOSED + FY exit window", async () => {
    prisma.queue("pairedTradeView", "findMany", []);
    await svc.getPairedTradesForFY("user-tax-1", "2025-26");

    const call = prisma.callsFor("pairedTradeView", "findMany")[0];
    assert.ok(call, "expected pairedTradeView.findMany");
    const args = call.args as {
      where: {
        userId: string;
        status: string;
        exitDate: { gte: Date; lte: Date };
      };
      orderBy: Record<string, unknown>;
    };
    assert.equal(args.where.userId, "user-tax-1");
    assert.equal(args.where.status, "CLOSED");
    // FY 2025-26 IST-anchored UTC window (MONEY-620): Apr 1 2025 00:00 IST →
    // Mar 31 2026 23:59:59.999 IST = 2025-03-31T18:30:00Z → 2026-03-31T18:29:59.999Z.
    assert.equal(
      args.where.exitDate.gte.toISOString(),
      "2025-03-31T18:30:00.000Z"
    );
    assert.equal(
      args.where.exitDate.lte.toISOString(),
      "2026-03-31T18:29:59.999Z"
    );
    // The DB window matches the single source of truth exactly.
    assert.equal(
      args.where.exitDate.gte.getTime(),
      fyWindowUtc("2025-26").gte.getTime()
    );
    assert.equal(
      args.where.exitDate.lte.getTime(),
      fyWindowUtc("2025-26").lte.getTime()
    );
    assert.deepEqual(args.orderBy, { exitDate: "desc" });
  });

  it("defaults the FY when none is passed (no throw, valid window)", async () => {
    prisma.queue("pairedTradeView", "findMany", []);
    const res = ok(await svc.getPairedTradesForFY("user-tax-2"));
    assert.deepEqual(res.data, []);
    const args = prisma.callsFor("pairedTradeView", "findMany")[0]!.args as {
      where: { exitDate: { gte: Date; lte: Date } };
    };
    // Whatever today's FY is, the window must be a valid Apr-1 → Mar-31 span.
    assert.ok(Number.isFinite(args.where.exitDate.gte.getTime()));
    assert.ok(Number.isFinite(args.where.exitDate.lte.getTime()));
    assert.ok(args.where.exitDate.gte < args.where.exitDate.lte);
  });

  it("maps clean rows to the tax-input shape (value = price * qty)", async () => {
    prisma.queue("pairedTradeView", "findMany", [ptv()]);
    const res = ok(await svc.getPairedTradesForFY("user-tax-3", "2025-26"));
    assert.equal(res.data.length, 1);
    assert.deepEqual(res.data[0], {
      symbol: "INFY",
      buyDate: "2025-05-01",
      sellDate: "2025-06-01",
      // MONEY-620: the full exit instant rides along as the tool's FY-filter key.
      sellTimestamp: "2025-06-01T00:00:00.000Z",
      buyValue: 1000,
      sellValue: 2000,
      segment: "EQ",
    });
  });

  it("BUG #1: an Invalid stored exitDate no longer crashes the whole fetch", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ symbol: "GOOD" }),
      ptv({ symbol: "BAD", exitDate: new Date("not-a-real-date") }),
    ]);
    let res!: ServiceOk<PairedTradeForFYRow[]>;
    await assert.doesNotReject(async () => {
      res = ok(await svc.getPairedTradesForFY("user-tax-4", "2025-26"));
    });
    // The undatable row is dropped; the good one survives — NOT a {success:false}.
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.symbol, "GOOD");
  });

  it("BUG #3: a NaN stored entryPrice yields a finite buyValue (0), not NaN", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ entryPrice: NaN, exitPrice: 200, quantity: 10 }),
    ]);
    const res = ok(await svc.getPairedTradesForFY("user-tax-5", "2025-26"));
    assert.equal(res.data[0]!.buyValue, 0);
    assert.ok(Number.isFinite(res.data[0]!.buyValue));
    assert.ok(Number.isFinite(res.data[0]!.sellValue));
  });

  it("empty FY → empty list (no throw, no NaN)", async () => {
    prisma.queue("pairedTradeView", "findMany", []);
    const res = ok(await svc.getPairedTradesForFY("user-tax-6", "2025-26"));
    assert.deepEqual(res.data, []);
  });

  it("a raw DB throw is sanitized to a generic error (no leak)", async () => {
    prisma.fail(
      "pairedTradeView",
      "findMany",
      new Error("E11000 duplicate key error on internal.collection")
    );
    const res = await svc.getPairedTradesForFY("user-tax-7", "2025-26");
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Failed to fetch trade data.");
  });
});

// ── (B.2) getTaxReport — full live pipeline through the REAL tools ───────────

describe("MONEY-620 — getTaxReport (LIVE service end-to-end, REAL tax tools)", () => {
  let prisma: RecordingPrisma;
  let core: CoreCacheRecorder;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });

  /** Queue the holdings read used by the harvesting step. */
  function queueHoldings(rows: Array<Record<string, unknown>> = []): void {
    prisma.queue("holding", "findMany", rows);
  }

  it("no trades + no holdings → fully-zeroed report, no NaN, no throw, cached", async () => {
    prisma.queue("pairedTradeView", "findMany", []); // getPairedTradesForFY
    queueHoldings([]);

    let res!: ServiceOk<TaxReport>;
    await assert.doesNotReject(async () => {
      res = ok(await svc.getTaxReport("user-r1", "2025-26"));
    });

    const cg = res.data.capitalGains;
    assert.equal(cg.fy, "2025-26");
    assert.equal(cg.totalTax, 0);
    assert.equal(cg.effectiveRate, 0);
    assert.equal(cg.equity.stcg.net, 0);
    assert.equal(cg.equity.ltcg.net, 0);
    assert.equal(cg.equity.ltcg.exemption, 125000); // s112A ₹1.25L pinned
    // Every headline number is finite (consumer-safety: no NaN into toFixed/toLocaleString).
    for (const n of [
      cg.totalTax,
      cg.effectiveRate,
      cg.equity.stcg.tax,
      cg.equity.ltcg.tax,
      cg.equity.ltcg.taxable,
      res.data.advanceTax.totalEstimatedTax,
      res.data.harvesting.totalPotentialSaving,
    ]) {
      assert.ok(Number.isFinite(n), `expected finite, got ${n}`);
    }
    // Cached under the tax namespace, scoped to the user.
    const set = core.setCachedCalls.find((c) => c.namespace === "tax");
    assert.ok(set, "tax report must be cached");
    assert.equal(set!.userId, "user-r1");
    assert.equal(set!.subkey, "report:2025-26");
  });

  it("IDOR: holdings harvesting query is scoped to the caller's userId", async () => {
    prisma.queue("pairedTradeView", "findMany", []);
    queueHoldings([]);
    await svc.getTaxReport("user-r2", "2025-26");
    const hCall = prisma.callsFor("holding", "findMany")[0];
    assert.ok(hCall);
    assert.equal(
      (hCall.args as { where: { userId: string } }).where.userId,
      "user-r2"
    );
  });

  it("a real STCG winner flows through the REAL tool: 20% s111A tax in the report", async () => {
    // Buy 2025-05-01 / sell 2025-06-01 (31d ≤ 365 → STCG); gain (200-100)*10 = 1000.
    prisma.queue("pairedTradeView", "findMany", [ptv()]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r3", "2025-26"));
    const eq = res.data.capitalGains.equity;
    assert.equal(eq.stcg.gains, 1000);
    assert.equal(eq.stcg.tax, 200); // 1000 * 0.20
    assert.equal(res.data.capitalGains.totalTax, 200);
    // ITR schedule mirrors the STCG figure.
    assert.equal(res.data.itrSchedule.scheduleCG.s111A.stcgTax, 200);
  });

  it("a real LTCG winner above ₹1.25L: 12.5% s112A on the excess only", async () => {
    // Buy 2023-01-01 / sell 2025-06-01 (>365d → LTCG); gain (325-0)*1000 = 325000.
    prisma.queue("pairedTradeView", "findMany", [
      ptv({
        symbol: "LT",
        entryDate: new Date("2023-01-01T00:00:00Z"),
        exitDate: new Date("2025-06-01T00:00:00Z"),
        entryPrice: 0,
        exitPrice: 325,
        quantity: 1000,
      }),
    ]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r4", "2025-26"));
    const ltcg = res.data.capitalGains.equity.ltcg;
    assert.equal(ltcg.net, 325000);
    assert.equal(ltcg.taxable, 200000); // 325000 - 125000 exemption
    assert.equal(ltcg.tax, 25000); // 200000 * 0.125
    assert.equal(res.data.capitalGains.totalTax, 25000);
  });

  it("BUG #1+#2: an Invalid-Date stored trade AND holding never crash the report", async () => {
    // One valid STCG trade + one undatable trade (would crash on .toISOString()).
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ symbol: "GOOD" }),
      ptv({ symbol: "BADDATE", entryDate: new Date("garbage") }),
    ]);
    // One valid holding + one with an Invalid createdAt (harvesting projection crash).
    queueHoldings([
      {
        symbol: "RELIANCE",
        quantity: 5,
        averagePrice: 2000,
        currentPrice: 1500, // unrealized LOSS → a harvesting opportunity
        createdAt: new Date("2025-02-01T00:00:00Z"),
      },
      {
        symbol: "BADHOLD",
        quantity: 1,
        averagePrice: 100,
        currentPrice: 50,
        createdAt: new Date("not-a-date"), // BUG #2 bait
      },
    ]);

    let res!: ServiceOk<TaxReport>;
    await assert.doesNotReject(async () => {
      res = ok(await svc.getTaxReport("user-r5", "2025-26"));
    });

    // The valid STCG trade still produced tax; the bad trade was dropped.
    assert.equal(res.data.capitalGains.equity.stcg.gains, 1000); // GOOD = (200-100)*10
    // Harvesting ran over BOTH holdings without throwing; finite saving.
    assert.ok(Number.isFinite(res.data.harvesting.totalPotentialSaving));
    // Everything the report surfaces is finite (no NaN to a formatter).
    for (const n of [
      res.data.capitalGains.totalTax,
      res.data.capitalGains.effectiveRate,
      res.data.advanceTax.totalEstimatedTax,
      res.data.harvesting.totalPotentialSaving,
    ]) {
      assert.ok(Number.isFinite(n), `expected finite, got ${n}`);
    }
  });

  it("BUG #3: NaN stored prices never make the headline tax NaN/Infinity", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ entryPrice: NaN, exitPrice: Infinity, quantity: 10 }),
    ]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r6", "2025-26"));
    // buy→0, sell→0 → zero gain → zero tax, all finite.
    assert.equal(res.data.capitalGains.equity.stcg.gains, 0);
    assert.equal(res.data.capitalGains.totalTax, 0);
    assert.ok(Number.isFinite(res.data.capitalGains.totalTax));
    assert.ok(Number.isFinite(res.data.capitalGains.effectiveRate));
  });

  it("set-off: a STCG loss reduces an LTCG gain (real tool), report stays finite", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      // STCG loss -500 : buy 1000 sell 500
      ptv({
        symbol: "STL",
        entryDate: new Date("2025-05-01T00:00:00Z"),
        exitDate: new Date("2025-06-01T00:00:00Z"),
        entryPrice: 1000,
        exitPrice: 500,
        quantity: 1,
      }),
      // LTCG gain +2000 : buy 1000 sell 3000, held >365d
      ptv({
        symbol: "LTG",
        entryDate: new Date("2023-01-01T00:00:00Z"),
        exitDate: new Date("2025-06-01T00:00:00Z"),
        entryPrice: 1000,
        exitPrice: 3000,
        quantity: 1,
      }),
    ]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r7", "2025-26"));
    const eq = res.data.capitalGains.equity;
    assert.equal(eq.stcg.net, 0); // -500 absorbed
    assert.equal(eq.ltcg.net, 1500); // 2000 - 500 set-off
    assert.ok(Number.isFinite(res.data.capitalGains.totalTax));
  });

  it("all-loss portfolio → zero tax, NEVER a negative tax", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ entryPrice: 200, exitPrice: 100, quantity: 10 }), // STCG -1000
    ]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r8", "2025-26"));
    assert.equal(res.data.capitalGains.equity.stcg.net, -1000);
    assert.equal(res.data.capitalGains.equity.stcg.tax, 0); // clamped ≥ 0
    assert.equal(res.data.capitalGains.totalTax, 0);
    assert.ok(res.data.capitalGains.totalTax >= 0);
  });

  it("a cache HIT short-circuits the whole pipeline (no DB query at all)", async () => {
    core.cacheHit = {
      capitalGains: {
        fy: "2025-26",
        equity: {
          stcg: { gains: 0, losses: 0, net: 0, tax: 0 },
          ltcg: {
            gains: 0,
            losses: 0,
            net: 0,
            exemption: 125000,
            taxable: 0,
            tax: 0,
          },
        },
        fno: { profits: 0, losses: 0, net: 0, note: "" },
        totalTax: 999,
        effectiveRate: 0,
        trades: [],
      },
      harvesting: {
        opportunities: [],
        totalPotentialSaving: 0,
        gaarWarning: "",
      },
      advanceTax: {
        totalEstimatedTax: 999,
        isApplicable: true,
        installments: [],
        interestU234C: 0,
      },
      itrSchedule: {
        scheduleCG: {
          s111A: { description: "", stcgGains: 0, stcgTax: 0 },
          s112A: {
            description: "",
            ltcgGains: 0,
            exemption: 125000,
            taxable: 0,
            ltcgTax: 0,
          },
        },
        csvData: "",
        summary: "",
      },
    };
    const res = ok(await svc.getTaxReport("user-cached", "2025-26"));
    assert.equal(res.data.capitalGains.totalTax, 999);
    // On a hit, NO DB query runs.
    assert.equal(prisma.callsFor("pairedTradeView", "findMany").length, 0);
    assert.equal(prisma.callsFor("holding", "findMany").length, 0);
    assert.equal(core.setCachedCalls.length, 0);
  });

  it("very large gains do not overflow — headline tax finite & exact", async () => {
    prisma.queue("pairedTradeView", "findMany", [
      ptv({ entryPrice: 0, exitPrice: 1_000_000_000, quantity: 1 }), // 100cr STCG gain
    ]);
    queueHoldings([]);
    const res = ok(await svc.getTaxReport("user-r9", "2025-26"));
    assert.equal(res.data.capitalGains.equity.stcg.tax, 200_000_000); // 1e9 * 0.20
    assert.ok(Number.isFinite(res.data.capitalGains.totalTax));
  });

  // Restore the real module cache so the database/core/logger stubs never leak
  // into a sibling suite running later under the full __tests__/** glob.
  after(() => {
    uninstallServices();
  });
});
