/**
 * MONEY-847 — dynamic FY-dropdown pure-logic tests (REAL exports, no shadow).
 *
 * Imports the REAL exported helpers from the trades SERVICE logic module
 * (`packages/services/src/trades-logic.ts`) — the exact code that
 * `packages/services/src/trades.service.ts#getAvailableFYs` (the Tradebook FY
 * dropdown path: `apps/web/lib/actions/trades.ts → getAvailableFYsAction`)
 * CALLS. No inline reimplementation: the production FY-span math and the
 * assertions run the same bytes.
 *
 * The module is Prisma-free (only imports `./mappings`), so importing it never
 * opens a DB/Redis handle — the test stays pure and exits clean (no orphan).
 *
 * Covers:
 *   - fyStartYearIST: the IST (Asia/Kolkata, fixed +5:30) FY boundary, incl. the
 *     1-Apr-midnight edge a UTC-only reading mis-buckets, and Invalid Date.
 *   - financialYearOption: id/label/from/to shape + zero-padded "FY YY-YY".
 *   - availableFinancialYears: every FY a min→max span covers, NEWEST first,
 *     plus the null / Invalid / single-FY / swapped-bounds edges.
 *
 * Source: packages/services/src/trades-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fyStartYearIST,
  financialYearOption,
  availableFinancialYears,
  type FinancialYearOption,
} from "../../../../packages/services/src/trades-logic";

describe("fyStartYearIST", () => {
  it("April → that calendar year", () => {
    assert.equal(fyStartYearIST(new Date("2025-04-01T00:00:00Z")), 2025);
  });

  it("Jan/Feb/Mar belong to the PREVIOUS FY start", () => {
    assert.equal(fyStartYearIST(new Date("2026-02-15T00:00:00Z")), 2025);
    assert.equal(fyStartYearIST(new Date("2026-03-31T12:00:00Z")), 2025);
  });

  it("1-Apr 00:00 IST (31-Mar 18:30 UTC) buckets into the NEW FY", () => {
    assert.equal(fyStartYearIST(new Date("2025-03-31T18:30:00Z")), 2025);
  });

  it("31-Mar 23:59 IST (31-Mar 18:29 UTC) stays in the OLD FY", () => {
    assert.equal(fyStartYearIST(new Date("2025-03-31T18:29:00Z")), 2024);
  });

  it("accepts string and epoch inputs", () => {
    assert.equal(fyStartYearIST("2024-07-01T00:00:00Z"), 2024);
    assert.equal(
      fyStartYearIST(new Date("2024-07-01T00:00:00Z").getTime()),
      2024
    );
  });

  it("Invalid Date → null", () => {
    assert.equal(fyStartYearIST(new Date("not-a-date")), null);
    assert.equal(fyStartYearIST(NaN), null);
  });
});

describe("financialYearOption", () => {
  it("builds id/label/from/to + IST-anchored gte/lte instants for a start year", () => {
    // MONEY-846: the option now also carries the IST-anchored UTC instant window
    // (`gte`/`lte`) so the client sends instants to getTradesAction and the DB
    // window is IST-correct. `from`/`to` stay date-only (display/label).
    assert.deepEqual(financialYearOption(2025), {
      id: "fy-2025",
      label: "FY 25-26",
      from: "2025-04-01",
      to: "2026-03-31",
      gte: "2025-03-31T18:30:00.000Z", // 1-Apr-2025 00:00 IST
      lte: "2026-03-31T18:29:59.999Z", // 31-Mar-2026 23:59:59.999 IST
    } satisfies FinancialYearOption);
  });

  it("zero-pads the two-digit years across a decade boundary", () => {
    const fy = financialYearOption(2009);
    assert.equal(fy.label, "FY 09-10");
    assert.equal(fy.from, "2009-04-01");
    assert.equal(fy.to, "2010-03-31");
    // Instants follow the same IST anchoring across the decade boundary.
    assert.equal(fy.gte, "2009-03-31T18:30:00.000Z");
    assert.equal(fy.lte, "2010-03-31T18:29:59.999Z");
  });
});

describe("availableFinancialYears", () => {
  it("returns every FY a multi-year span covers, NEWEST first", () => {
    const fys = availableFinancialYears(
      new Date("2023-06-10T00:00:00Z"), // FY 2023
      new Date("2026-01-20T00:00:00Z") // FY 2025 (Jan → prev FY start)
    );
    assert.deepEqual(
      fys.map((f) => f.id),
      ["fy-2025", "fy-2024", "fy-2023"]
    );
    assert.deepEqual(
      fys.map((f) => f.label),
      ["FY 25-26", "FY 24-25", "FY 23-24"]
    );
  });

  it("a single-FY span yields exactly one option", () => {
    const fys = availableFinancialYears(
      new Date("2025-04-05T00:00:00Z"),
      new Date("2026-03-30T00:00:00Z")
    );
    assert.equal(fys.length, 1);
    assert.equal(fys[0]!.id, "fy-2025");
  });

  it("null / undefined bounds → [] (user has no trades)", () => {
    assert.deepEqual(availableFinancialYears(null, null), []);
    assert.deepEqual(availableFinancialYears(undefined, new Date()), []);
    assert.deepEqual(availableFinancialYears(new Date(), null), []);
  });

  it("Invalid Date bounds → []", () => {
    assert.deepEqual(
      availableFinancialYears(new Date("x"), new Date("2026-01-01")),
      []
    );
  });

  it("defensively swaps reversed bounds (min > max) and still spans them", () => {
    const fys = availableFinancialYears(
      new Date("2026-01-20T00:00:00Z"), // FY 2025
      new Date("2023-06-10T00:00:00Z") // FY 2023
    );
    assert.deepEqual(
      fys.map((f) => f.id),
      ["fy-2025", "fy-2024", "fy-2023"]
    );
  });
});
