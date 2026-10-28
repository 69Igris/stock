/**
 * DB-first statement mapper (MONEY-614).
 *
 * `toTypedStatementRows` maps the synced Tickertape rawData rows to typed
 * FinancialStatement via a SAFE passthrough — it must only surface
 * correctly-named numeric fields (so it can never inject wrong data), preserve
 * the period, and drop period-only empty rows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { toTypedStatementRows } from "../../../../packages/research/src/data-sources/db-store";

test("passes through matching camelCase numeric fields incl. forensic detail", () => {
  const [s] = toTypedStatementRows([
    {
      period: "2025-03-31",
      endDate: "1743379200",
      revenue: 1000,
      netIncome: 120,
      totalAssets: 5000,
      currentAssets: 1500,
      currentLiabilities: 800,
      retainedEarnings: 2200,
      propertyPlantEquipment: 1800,
      inventory: 300,
      receivables: 400,
      payables: 250,
      sga: 90,
      depreciation: 60,
    },
  ]);

  assert.equal(s!.period, "2025-03-31");
  assert.equal(s!.revenue, 1000);
  assert.equal(s!.currentAssets, 1500);
  assert.equal(s!.retainedEarnings, 2200);
  assert.equal(s!.propertyPlantEquipment, 1800);
  assert.equal(s!.depreciation, 60);
});

test("drops non-numeric values + unknown keys (cannot inject wrong data)", () => {
  const [s] = toTypedStatementRows([
    {
      period: "2024-03-31",
      revenue: 500,
      netIncome: "120", // string → dropped (not a number)
      totalAssets: NaN, // non-finite → dropped
      someTickertapeOnlyKey: 999, // not a FinancialStatement field → ignored
    },
  ]);

  assert.equal(s!.revenue, 500);
  assert.equal(s!.netIncome, undefined); // string not coerced
  assert.equal(s!.totalAssets, undefined); // NaN filtered
  assert.equal(
    (s as unknown as Record<string, unknown>).someTickertapeOnlyKey,
    undefined
  );
});

/**
 * MONEY-1300 — the row's `basis` reaches the statement the tools return.
 *
 * `getOrFetchFinancials` runs a `findMany` with NO `select:`, so Prisma already
 * hands this mapper the whole document and `groupFinancials` spreads the row's
 * own columns. The column was therefore READ from the database and then dropped
 * one function later, because `rowToStatement`'s allowlist copied `period`,
 * `endDate` and the numeric fields and nothing else — so all three fetch tools
 * (income, balance sheet, cash flow) answered "360ONE's FY2025 total assets are
 * 19,768 Cr" with no way to say whether that was the group or the parent alone.
 * Standalone is 7,332 Cr.
 *
 * All four inputs are asserted here because two of them must be
 * indistinguishable and neither may become "CONSOLIDATED".
 */
test("MONEY-1300: carries the row's basis onto the statement", () => {
  const [s] = toTypedStatementRows([
    { period: "FY 2025", basis: "CONSOLIDATED", totalAssets: 19768 },
  ]);
  assert.equal(s!.basis, "CONSOLIDATED");

  const [standalone] = toTypedStatementRows([
    { period: "FY 2025", basis: "STANDALONE", totalAssets: 7332 },
  ]);
  assert.equal(standalone!.basis, "STANDALONE");
});

test("MONEY-1300: an ABSENT basis reads as UNKNOWN, never as consolidated", () => {
  // ~32,359 pre-projection rows carry no `basis` attribute at all — on MongoDB
  // a `db push` creates indexes, never fields. A vendor row says the literal
  // "UNKNOWN". The two states are the same answer to a reader.
  const [absent] = toTypedStatementRows([{ period: "FY 2019", revenue: 100 }]);
  const [stated] = toTypedStatementRows([
    { period: "FY 2019", basis: "UNKNOWN", revenue: 100 },
  ]);

  assert.equal(absent!.basis, stated!.basis);
  assert.equal(absent!.basis, "UNKNOWN");
  assert.notEqual(absent!.basis, "CONSOLIDATED");
});

test("filters period-only / empty rows", () => {
  const rows = toTypedStatementRows([
    { period: "2025-03-31" }, // no figures → dropped
    { period: "2024-03-31", revenue: 800 }, // real → kept
    { period: "2023-03-31", revenue: "n/a" }, // no numeric → dropped
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.period, "2024-03-31");
});
