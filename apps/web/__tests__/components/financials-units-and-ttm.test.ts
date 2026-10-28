/**
 * MONEY-1207 — the Financials tab printed the right data in the wrong unit and
 * the freshest column in the oldest slot.
 *
 * Two defects, one table:
 *
 *  1. `StockFinancials`' money columns are CRORES. The tab divided them by 1e7
 *     again under the comment "source data is in INR", so HDFC Bank's
 *     ₹4,70,915.93 Cr revenue rendered as **₹0.05 Cr**. That is the failure
 *     `stock-format.ts`'s own doc has warned about since MONEY-1144: a
 *     confident WRONG number, not a missing one, so no empty state fires and
 *     nothing looks broken.
 *
 *  2. Tickertape's annual endpoint emits an extra row with
 *     `displayPeriod: "TTM"`. `parsePeriodKey("TTM")` finds no digits, so
 *     `comparePeriodsDesc` sorts it LAST — the freshest figure on the platform
 *     landed in the far-right, oldest column of a chronological table, and for
 *     any symbol with 7+ annual rows it was dropped entirely by `.slice(0, 6)`.
 *     The fix orders on `periodEnd` (100% populated by the source, TTM row
 *     included) and falls back to the label comparator only when it is absent.
 *
 * Source: apps/web/app/stock/[symbol]/stock-format.ts
 *         apps/web/components/stock/StockFinancialsTab.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { formatStatementCrores } from "@/app/stock/[symbol]/stock-format";

// The tab is a client component importing a CSS module; stub it so the real
// sorter can be executed rather than described.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tab = require("../../components/stock/StockFinancialsTab") as {
  sortByPeriodDesc: <T extends { period: string; periodEnd?: unknown }>(
    rows: T[]
  ) => T[];
  isTtmRow: (row: { period: string }) => boolean;
};
const { sortByPeriodDesc, isTtmRow } = tab;

const row = (period: string, periodEnd: string | null) => ({
  period,
  periodEnd,
  revenue: 1,
});

describe("statement money is formatted as crores, not re-divided", () => {
  it("HDFCBANK FY2025 revenue renders as lakh crore, not ₹0.05 Cr", () => {
    // The exact value on prod for HDFCBANK / INCOME / FY 2025.
    assert.equal(formatStatementCrores(470915.93), "₹4.71 L Cr");
    // The old behaviour, stated so a regression is unmistakable:
    assert.notEqual(formatStatementCrores(470915.93), "₹0.05 Cr");
  });

  it("uses the thousands step a statement table needs", () => {
    assert.equal(formatStatementCrores(1200), "₹1.20 k Cr");
    assert.equal(formatStatementCrores(100047.28), "₹1.00 L Cr");
    assert.equal(formatStatementCrores(52.5), "₹52.50 Cr");
  });

  it("a null or non-finite value is an em dash, never 0", () => {
    for (const v of [null, undefined, NaN, Infinity]) {
      const out = formatStatementCrores(v as number | null | undefined);
      assert.doesNotMatch(out, /0/, `${String(v)} rendered as ${out}`);
    }
  });
});

describe("TTM sorts first and is not compared against a fiscal year", () => {
  it("orders on periodEnd, so TTM leads instead of trailing", () => {
    const rows = [
      row("FY 2023", "2023-03-31"),
      row("TTM", "2026-06-30"),
      row("FY 2025", "2025-03-31"),
      row("FY 2024", "2024-03-31"),
    ];
    assert.deepEqual(
      sortByPeriodDesc(rows).map((r) => r.period),
      ["TTM", "FY 2025", "FY 2024", "FY 2023"]
    );
  });

  it("the label comparator ALONE would bury TTM — that is the bug", () => {
    // Same rows with no periodEnd: this is the pre-fix behaviour, kept as an
    // executable statement of what the sortable key is for.
    const undated = [
      row("FY 2025", null),
      row("TTM", null),
      row("FY 2024", null),
    ];
    assert.equal(sortByPeriodDesc(undated).at(-1)?.period, "TTM");
  });

  it("a dated row outranks an undated one rather than being guessed into place", () => {
    const mixed = [row("FY 2024", null), row("FY 2023", "2023-03-31")];
    assert.deepEqual(
      sortByPeriodDesc(mixed).map((r) => r.period),
      ["FY 2023", "FY 2024"]
    );
  });

  it("identifies the TTM row case-insensitively and ignores padding", () => {
    assert.equal(isTtmRow({ period: "TTM" }), true);
    assert.equal(isTtmRow({ period: " ttm " }), true);
    assert.equal(isTtmRow({ period: "FY 2025" }), false);
  });
});
