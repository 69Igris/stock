/**
 * Capital-gains tax tool — negative / edge / boundary coverage.
 *
 * De-shadow guarantee: this file imports and executes the REAL exported
 * `computeCapitalGainsTaxTool` from the source module and asserts ITS output.
 * No tax logic is re-declared here.
 *
 * Source under test:
 *   packages/research/src/tools/compute-capital-gains-tax.ts
 *
 * Indian CG rules pinned (Budget 2024): STCG (equity, ≤365d) @ 20% s111A;
 * LTCG (equity, >365d) @ 12.5% above the ₹1.25L s112A exemption; F&O flagged
 * as business income (not taxed here). Holding boundary: day 365 = STCG,
 * day 366 = LTCG.
 *
 * Three real bugs were found while writing these and fixed in source (guards
 * only, no happy-path change): (1) STCG-loss set-off against a net LTCG *loss*
 * corrupted both legs; (2) a NaN buy/sell value leaked NaN→null into totalTax;
 * (3) an unparseable date produced NaN holdingDays and silently bucketed the
 * trade as LTCG. The corrected behavior is asserted below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeCapitalGainsTaxTool } from "../src/tools/compute-capital-gains-tax";
import type { ToolOutput } from "../src/tools/types";
import type { CapitalGainsTaxResult } from "../src/types";

const FY = "2025-26";

interface Trade {
  symbol: string;
  buyDate: string;
  sellDate: string;
  /** Full ISO exit instant (MONEY-620) — preferred FY-filter key when present. */
  sellTimestamp?: string;
  buyValue: number;
  sellValue: number;
  segment?: string;
}

async function run(trades: unknown, fy: unknown = FY): Promise<ToolOutput> {
  return computeCapitalGainsTaxTool.execute({ trades, fy });
}

/** Run and assert success, returning the typed payload. */
async function ok(trades: Trade[], fy = FY): Promise<CapitalGainsTaxResult> {
  const out = await run(trades, fy);
  assert.equal(out.success, true, out.error);
  return out.data as CapitalGainsTaxResult;
}

/** Assert every numeric field in the result is finite (no NaN/Infinity leak). */
function assertAllFinite(d: CapitalGainsTaxResult): void {
  const nums = [
    d.totalTax,
    d.effectiveRate,
    d.equity.stcg.gains,
    d.equity.stcg.losses,
    d.equity.stcg.net,
    d.equity.stcg.tax,
    d.equity.ltcg.gains,
    d.equity.ltcg.losses,
    d.equity.ltcg.net,
    d.equity.ltcg.taxable,
    d.equity.ltcg.tax,
    d.fno.profits,
    d.fno.losses,
    d.fno.net,
  ];
  for (const n of nums) {
    assert.ok(
      Number.isFinite(n),
      `expected finite, got ${n} in ${JSON.stringify(d)}`,
    );
  }
}

describe("computeCapitalGainsTaxTool — input validation", () => {
  test("missing trades → failure", async () => {
    const out = await computeCapitalGainsTaxTool.execute({ fy: FY });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /trades array and fy are required/);
  });

  test("missing fy → failure", async () => {
    const out = await computeCapitalGainsTaxTool.execute({
      trades: [],
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /trades array and fy are required/);
  });

  test("empty trades array → succeeds with all-zero result", async () => {
    const d = await ok([]);
    assert.equal(d.totalTax, 0);
    assert.equal(d.effectiveRate, 0);
    assert.equal(d.equity.stcg.net, 0);
    assert.equal(d.equity.ltcg.net, 0);
    assert.equal(d.trades.length, 0);
    assertAllFinite(d);
  });

  test("tool advertises the right name/category", () => {
    assert.equal(computeCapitalGainsTaxTool.name, "compute_capital_gains_tax");
    assert.equal(computeCapitalGainsTaxTool.category, "computation");
  });
});

describe("computeCapitalGainsTaxTool — holding-period boundary (LTCG threshold day)", () => {
  // 2024-04-01 → 2025-04-01 is exactly 365 days (2024 is a leap year, but the
  // span Apr→Apr does not cross Feb 29 twice; daysBetween reports 365).
  test("exactly 365 days → STCG (not yet long-term)", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2024-04-01",
        sellDate: "2025-04-01",
        buyValue: 100,
        sellValue: 200,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades[0]!.holdingDays, 365);
    assert.equal(d.trades[0]!.type, "STCG");
    assert.equal(d.equity.stcg.gains, 100);
    assert.equal(d.equity.ltcg.gains, 0);
  });

  test("366 days → LTCG (one day past the boundary)", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2024-04-01",
        sellDate: "2025-04-02",
        buyValue: 100,
        sellValue: 200,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades[0]!.holdingDays, 366);
    assert.equal(d.trades[0]!.type, "LTCG");
    assert.equal(d.equity.ltcg.gains, 100);
    assert.equal(d.equity.stcg.gains, 0);
  });

  test("same-day buy/sell (0 days) → STCG, zero gain", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2025-06-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 100,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades[0]!.holdingDays, 0);
    assert.equal(d.trades[0]!.type, "STCG");
    assert.equal(d.equity.stcg.net, 0);
    assert.equal(d.totalTax, 0);
  });
});

describe("computeCapitalGainsTaxTool — STCG/LTCG tax math", () => {
  test("STCG gain taxed at 20% (s111A)", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 1000,
        sellValue: 2000,
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.stcg.net, 1000);
    assert.equal(d.equity.stcg.tax, 200); // 1000 * 0.20
    assert.equal(d.totalTax, 200);
    assert.equal(d.effectiveRate, 0.2);
  });

  test("LTCG below ₹1.25L exemption → zero tax", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 100000,
        sellValue: 200000, // gain 100k < 125k exemption
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.ltcg.net, 100000);
    assert.equal(d.equity.ltcg.taxable, 0);
    assert.equal(d.equity.ltcg.tax, 0);
    assert.equal(d.totalTax, 0);
  });

  test("LTCG exactly at the ₹1.25L exemption → zero taxable", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 0,
        sellValue: 125000, // gain == exemption
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.ltcg.net, 125000);
    assert.equal(d.equity.ltcg.taxable, 0);
    assert.equal(d.equity.ltcg.tax, 0);
  });

  test("LTCG above exemption → 12.5% on the excess only (s112A)", async () => {
    const d = await ok([
      {
        symbol: "A",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 0,
        sellValue: 225000, // gain 225k, taxable 100k
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.ltcg.net, 225000);
    assert.equal(d.equity.ltcg.taxable, 100000);
    assert.equal(d.equity.ltcg.tax, 12500); // 100k * 0.125
    assert.equal(d.totalTax, 12500);
  });

  test("huge gains do not overflow or go non-finite", async () => {
    const d = await ok([
      {
        symbol: "BIG",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 0,
        sellValue: 1_000_000_000, // 100 cr
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.stcg.tax, 200_000_000); // 1e9 * 0.2
    assertAllFinite(d);
  });
});

describe("computeCapitalGainsTaxTool — loss set-off", () => {
  test("STCG net loss sets off against a net LTCG GAIN", async () => {
    const d = await ok([
      // STCG loss -500
      {
        symbol: "A",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 1000,
        sellValue: 500,
        segment: "EQ",
      },
      // LTCG gain +2000 (well above exemption-relevant math here is net only)
      {
        symbol: "B",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 1000,
        sellValue: 3000,
        segment: "EQ",
      },
    ]);
    // STCG loss is absorbed → 0; LTCG net reduced by 500 → 1500
    assert.equal(d.equity.stcg.net, 0);
    assert.equal(d.equity.ltcg.net, 1500);
    assertAllFinite(d);
  });

  // BUG #1 (FIXED): with both legs at a net LOSS, the old code computed
  // `Math.min(|stcgLoss|, ltcgNet)` where ltcgNet is negative, set off the
  // negative, and corrupted STCG to -110 / LTCG to 0. A short-term loss must
  // never be set off against a long-term *loss*.
  test("both STCG and LTCG net losses are preserved (no spurious set-off)", async () => {
    const d = await ok([
      // STCG -50
      {
        symbol: "A",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 50,
        segment: "EQ",
      },
      // LTCG -60
      {
        symbol: "B",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 40,
        segment: "EQ",
      },
    ]);
    assert.equal(d.equity.stcg.net, -50);
    assert.equal(d.equity.ltcg.net, -60);
    assert.equal(d.equity.stcg.tax, 0);
    assert.equal(d.equity.ltcg.tax, 0);
    assert.equal(d.totalTax, 0);
    assert.equal(d.effectiveRate, 0); // totalGains <= 0 → rate 0, not NaN
    assertAllFinite(d);
  });

  test("STCG loss larger than LTCG gain → STCG keeps residual loss", async () => {
    const d = await ok([
      // STCG -1000
      {
        symbol: "A",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 2000,
        sellValue: 1000,
        segment: "EQ",
      },
      // LTCG +300
      {
        symbol: "B",
        buyDate: "2023-01-01",
        sellDate: "2025-06-01",
        buyValue: 700,
        sellValue: 1000,
        segment: "EQ",
      },
    ]);
    // Set off 300 → LTCG net 0, STCG net -700
    assert.equal(d.equity.ltcg.net, 0);
    assert.equal(d.equity.stcg.net, -700);
    assert.equal(d.equity.stcg.tax, 0); // Math.max(0, ...) clamps negative tax
    assert.equal(d.totalTax, 0);
    assertAllFinite(d);
  });
});

describe("computeCapitalGainsTaxTool — F&O segregation", () => {
  test("F&O is flagged as business income, not taxed as CG", async () => {
    const d = await ok([
      {
        symbol: "NIFTY",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 10000,
        sellValue: 15000,
        segment: "FO",
      },
    ]);
    assert.equal(d.fno.profits, 5000);
    assert.equal(d.fno.net, 5000);
    assert.equal(d.equity.stcg.tax, 0);
    assert.equal(d.equity.ltcg.tax, 0);
    assert.equal(d.totalTax, 0); // F&O excluded from CG tax
    assert.equal(d.trades[0]!.type, "F&O");
    assert.match(d.fno.note, /business income/i);
  });

  test("FUT/OPT segments also route to F&O", async () => {
    const d = await ok([
      {
        symbol: "FUTX",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 50,
        segment: "FUT",
      },
      {
        symbol: "OPTX",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 250,
        segment: "OPT",
      },
    ]);
    assert.equal(d.fno.losses, 50); // FUT -50
    assert.equal(d.fno.profits, 150); // OPT +150
    assert.equal(d.fno.net, 100);
  });
});

describe("computeCapitalGainsTaxTool — FY window filtering", () => {
  test("trades outside the FY (by sell date) are excluded", async () => {
    const d = await ok(
      [
        // In FY 2025-26 (Apr 2025 – Mar 2026)
        {
          symbol: "IN",
          buyDate: "2025-05-01",
          sellDate: "2025-12-01",
          buyValue: 100,
          sellValue: 300,
          segment: "EQ",
        },
        // Sold before FY start → excluded
        {
          symbol: "OUT",
          buyDate: "2024-01-01",
          sellDate: "2024-12-31",
          buyValue: 100,
          sellValue: 999,
          segment: "EQ",
        },
      ],
      "2025-26",
    );
    assert.equal(d.trades.length, 1);
    assert.equal(d.trades[0]!.symbol, "IN");
    assert.equal(d.equity.stcg.gains, 200);
  });

  test("sell on FY-end boundary 03-31 is included", async () => {
    const d = await ok(
      [
        {
          symbol: "EDGE",
          buyDate: "2025-05-01",
          sellDate: "2026-03-31",
          buyValue: 100,
          sellValue: 200,
          segment: "EQ",
        },
      ],
      "2025-26",
    );
    assert.equal(d.trades.length, 1);
    assert.equal(d.equity.stcg.gains, 100);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-620 — IST FY boundary on the RESEARCH path (sellTimestamp filter)
//
// The production tax path feeds this tool the FULL exit instant via
// `sellTimestamp`. The tool replicates the IST-anchored UTC FY window from
// `@usemoney/services` `tax-logic.ts` `fyWindowUtc` (it cannot import it —
// services depends on research, not the reverse). The literal UTC bounds below
// are the SAME ones the service computes; a cross-package test in
// `apps/web/__tests__/actions/tax.test.ts` asserts the two windows are
// bit-for-bit equal. Here we prove the seam verdicts directly.
//
// FY "2024-25" IST window in UTC:  2024-03-31T18:30:00.000Z .. 2025-03-31T18:29:59.999Z
// ════════════════════════════════════════════════════════════════════════════

describe("computeCapitalGainsTaxTool — IST FY boundary via sellTimestamp (MONEY-620)", () => {
  /** Was the single seam trade kept by the FY filter? */
  async function kept(sellTimestamp: string, fy: string): Promise<boolean> {
    const d = await ok(
      [
        {
          symbol: "SEAM",
          buyDate: "2020-01-01",
          sellDate: sellTimestamp.slice(0, 10),
          sellTimestamp,
          buyValue: 100,
          sellValue: 200,
          segment: "EQ",
        },
      ],
      fy,
    );
    return d.trades.length === 1;
  }

  test("Apr 1 02:00 IST (= Mar 31 20:30 UTC) lands in FY 2024-25, NOT 2023-24", async () => {
    const iso = "2024-03-31T20:30:00.000Z";
    assert.equal(await kept(iso, "2024-25"), true);
    assert.equal(await kept(iso, "2023-24"), false);
  });

  test("Mar 31 23:30 IST (2025) lands in FY 2024-25, NOT 2025-26", async () => {
    const iso = "2025-03-31T18:00:00.000Z"; // 2025-03-31T23:30+05:30
    assert.equal(await kept(iso, "2024-25"), true);
    assert.equal(await kept(iso, "2025-26"), false);
  });

  test("Mar 31 23:30 IST (2024) lands in FY 2023-24", async () => {
    const iso = "2024-03-31T18:00:00.000Z"; // 2024-03-31T23:30+05:30
    assert.equal(await kept(iso, "2023-24"), true);
    assert.equal(await kept(iso, "2024-25"), false);
  });

  test("gte boundary (Apr 1 00:00 IST) is inclusive; 1ms before is excluded", async () => {
    assert.equal(await kept("2024-03-31T18:30:00.000Z", "2024-25"), true);
    assert.equal(await kept("2024-03-31T18:29:59.999Z", "2024-25"), false);
  });

  test("lte boundary (Mar 31 23:59:59.999 IST) is inclusive; 1ms after is excluded", async () => {
    assert.equal(await kept("2025-03-31T18:29:59.999Z", "2024-25"), true);
    assert.equal(await kept("2025-03-31T18:30:00.000Z", "2024-25"), false);
  });

  test("a mid-year exit (Aug, far from the seam) is unaffected — behaviour-preserving", async () => {
    assert.equal(await kept("2024-08-15T06:00:00.000Z", "2024-25"), true);
  });

  test("sellTimestamp takes precedence over a (stale) UTC sellDate at the seam", async () => {
    // Apr 1 02:00 IST: the UTC sellDate is "2024-03-31" (prior-FY-looking), but
    // the instant belongs to FY 2024-25. The timestamp must win.
    const d = await ok(
      [
        {
          symbol: "SEAM",
          buyDate: "2020-01-01",
          sellDate: "2024-03-31", // UTC date — would string-match FY 2023-24's end
          sellTimestamp: "2024-03-31T20:30:00.000Z",
          buyValue: 100,
          sellValue: 200,
          segment: "EQ",
        },
      ],
      "2024-25",
    );
    assert.equal(d.trades.length, 1, "instant in 2024-25 must be kept");
  });

  test("an unparseable sellTimestamp falls back to the date-only string filter", async () => {
    // Garbage timestamp → fall back to sellDate string compare against FY window.
    const d = await ok(
      [
        {
          symbol: "FALLBACK",
          buyDate: "2025-05-01",
          sellDate: "2025-12-01", // inside FY 2025-26 by string compare
          sellTimestamp: "not-a-timestamp",
          buyValue: 100,
          sellValue: 200,
          segment: "EQ",
        },
      ],
      "2025-26",
    );
    assert.equal(d.trades.length, 1);
  });
});

describe("computeCapitalGainsTaxTool — non-finite & malformed inputs (no leak)", () => {
  // BUG #2 (FIXED): a NaN buy/sell value used to propagate to totalTax: NaN
  // (serialized as `null`). Non-finite money is now coerced to 0.
  test("NaN buyValue is coerced to 0 (no NaN/null in totals)", async () => {
    const d = await ok([
      {
        symbol: "X",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: NaN,
        sellValue: 50,
        segment: "EQ",
      },
    ]);
    // buy→0, sell 50 → STCG gain 50 → tax 10
    assert.equal(d.equity.stcg.gains, 50);
    assert.equal(d.equity.stcg.tax, 10);
    assert.equal(d.totalTax, 10);
    assertAllFinite(d);
  });

  test("Infinity sellValue is coerced to 0 (no Infinity leak)", async () => {
    const d = await ok([
      {
        symbol: "X",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: Infinity,
        segment: "EQ",
      },
    ]);
    // sell→0, buy 100 → STCG loss 100
    assert.equal(d.equity.stcg.losses, 100);
    assert.equal(d.equity.stcg.net, -100);
    assertAllFinite(d);
  });

  // BUG #3 (FIXED): an unparseable date produced NaN holdingDays, and since
  // `NaN <= 365` is false the trade was silently classified LTCG. Such trades
  // are now excluded (cannot be reliably dated) rather than misclassified.
  test("unparseable buyDate → trade excluded, no LTCG misclassification", async () => {
    const d = await ok([
      {
        symbol: "BAD",
        buyDate: "not-a-date",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 200,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades.length, 0);
    assert.equal(d.equity.ltcg.gains, 0);
    assert.equal(d.equity.stcg.gains, 0);
    assert.equal(d.totalTax, 0);
    assertAllFinite(d);
  });

  test("a datable trade alongside an undatable one keeps only the valid one", async () => {
    const d = await ok([
      {
        symbol: "GOOD",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 300,
        segment: "EQ",
      },
      {
        symbol: "BAD",
        buyDate: "garbage",
        sellDate: "2025-06-01",
        buyValue: 100,
        sellValue: 9999,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades.length, 1);
    assert.equal(d.trades[0]!.symbol, "GOOD");
    assert.equal(d.equity.stcg.gains, 200);
    assertAllFinite(d);
  });
});

describe("computeCapitalGainsTaxTool — effectiveRate & ordering", () => {
  test("effectiveRate is 0 when net gains are non-positive (no divide-by-zero)", async () => {
    const d = await ok([
      {
        symbol: "L",
        buyDate: "2025-05-01",
        sellDate: "2025-06-01",
        buyValue: 1000,
        sellValue: 500,
        segment: "EQ",
      },
    ]);
    assert.equal(d.effectiveRate, 0);
    assert.ok(Number.isFinite(d.effectiveRate));
  });

  test("trades sorted by sellDate descending", async () => {
    const d = await ok([
      {
        symbol: "OLD",
        buyDate: "2025-04-15",
        sellDate: "2025-05-01",
        buyValue: 100,
        sellValue: 110,
        segment: "EQ",
      },
      {
        symbol: "NEW",
        buyDate: "2025-04-15",
        sellDate: "2025-12-01",
        buyValue: 100,
        sellValue: 110,
        segment: "EQ",
      },
    ]);
    assert.equal(d.trades[0]!.symbol, "NEW");
    assert.equal(d.trades[1]!.symbol, "OLD");
  });
});
