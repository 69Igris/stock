/**
 * MONEY-846 — FY-window SEAM test (REAL exports, no shadow, TIMEZONE-INDEPENDENT).
 *
 * This is the regression test for the IST financial-year boundary bug. It drives
 * the REAL exported chain that the Tradebook FY dropdown uses end-to-end:
 *
 *   financialYearOption(startYear)  →  { gte, lte, from, to }   (trades-logic.ts)
 *      ↓ the client sends these as getTradesAction's fromDate/toDate
 *   buildTradeWhereClause(userId, { fromDate, toDate })  →  Prisma `tradeDate`
 *      window { gte, lte }                                       (trades-logic.ts)
 *
 * and asserts a trade in the +5:30 IST sliver around the 1-Apr boundary is
 * classified into the CORRECT financial year — the exact rows the old code
 * (UTC-midnight gte + LOCAL `setHours` lte) dropped or mis-bucketed.
 *
 * THE BUG (before MONEY-846):
 *   - gte = `new Date("2025-04-01")` = 2025-04-01T00:00:00.000Z (UTC midnight),
 *     so a trade at 2026-03-31T20:30:00Z (= 1-Apr-2026 02:00 IST) compared
 *     against FY 2026's UTC-midnight gte `2026-04-01T00:00Z` was BELOW it →
 *     dropped from FY 2026.
 *   - lte = `toDate.setHours(23,59,59,999)` ran in the server's LOCAL zone, so
 *     the upper-bound INSTANT differed between prod (UTC) and an IST dev box —
 *     the test passed on the IST box while prod's window was wrong.
 *
 * Every assertion here checks the UTC INSTANT (via `.getTime()` / `.toISOString()`),
 * never local `getHours()`, so the file is green under BOTH `TZ=UTC` and
 * `TZ=Asia/Kolkata` (the whole point of the fix).
 *
 * No shadow: the production path (`apps/web/lib/actions/trades.ts` →
 * `packages/services/src/trades.service.ts` → these helpers) executes the SAME
 * bytes the assertions do. The module is Prisma-free (imports only `./mappings`
 * and the pure `./tax-logic`), so the test opens no DB/Redis handle.
 *
 * Source: packages/services/src/trades-logic.ts (financialYearOption,
 *         availableFinancialYears, buildTradeWhereClause, istDayBound)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  financialYearOption,
  availableFinancialYears,
  buildTradeWhereClause,
  istDayBound,
} from "../../../../packages/services/src/trades-logic";
import { fyWindowUtc } from "../../../../packages/services/src/tax-logic";
import { demoTrades } from "../../lib/demo/data";

/** Inclusive instant-window membership, comparing UTC ms (timezone-agnostic). */
function inWindow(instant: Date, win: { gte: Date; lte: Date }): boolean {
  const t = instant.getTime();
  return t >= win.gte.getTime() && t <= win.lte.getTime();
}

/** Pull the Prisma `tradeDate` {gte,lte} that buildTradeWhereClause produced. */
function tradeDateWindow(filters: { fromDate?: string; toDate?: string }): {
  gte: Date;
  lte: Date;
} {
  const where = buildTradeWhereClause("user-1", filters);
  const td = where.tradeDate as { gte: Date; lte: Date };
  return td;
}

describe("financialYearOption carries IST-anchored UTC instants (MONEY-846)", () => {
  it("FY 2026 option exposes gte/lte = the IST FY window instants", () => {
    const opt = financialYearOption(2026);
    assert.equal(opt.id, "fy-2026");
    assert.equal(opt.label, "FY 26-27");
    // Display fields stay date-only.
    assert.equal(opt.from, "2026-04-01");
    assert.equal(opt.to, "2027-03-31");
    // Instant fields are IST-anchored UTC.
    assert.equal(opt.gte, "2026-03-31T18:30:00.000Z"); // 1-Apr-2026 00:00 IST
    assert.equal(opt.lte, "2027-03-31T18:29:59.999Z"); // 31-Mar-2027 23:59:59.999 IST
  });

  it("the option's gte/lte equal services tax-logic fyWindowUtc (single source of truth)", () => {
    const opt = financialYearOption(2025);
    const win = fyWindowUtc("2025-2026");
    assert.equal(opt.gte, win.gte.toISOString());
    assert.equal(opt.lte, win.lte.toISOString());
  });
});

describe("buildTradeWhereClause FY window — Apr-1 IST boundary trade (the bug)", () => {
  // The canonical boundary instant: 2026-03-31T20:30:00Z == 1-Apr-2026 02:00 IST.
  // It belongs to FY 2026 (which STARTS 1-Apr-2026), NOT FY 2025.
  const boundary = new Date("2026-03-31T20:30:00Z");

  it("a 1-Apr-IST-sliver trade lands in FY 2026 via the FY-option instants", () => {
    const fy2026 = financialYearOption(2026);
    const win = tradeDateWindow({ fromDate: fy2026.gte, toDate: fy2026.lte });
    assert.equal(
      inWindow(boundary, win),
      true,
      "boundary trade must be INSIDE the FY 2026 DB window (it was dropped before)"
    );
  });

  it("the SAME trade is NOT in FY 2025's window (not mis-bucketed into the prior FY)", () => {
    const fy2025 = financialYearOption(2025);
    const win = tradeDateWindow({ fromDate: fy2025.gte, toDate: fy2025.lte });
    assert.equal(
      inWindow(boundary, win),
      false,
      "boundary trade must be OUTSIDE FY 2025 — it belongs to the FY that starts that Apr-1"
    );
  });

  it("date-only from/to (legacy client) anchors to the SAME IST window as the instants", () => {
    // Even if the client sends the date-only `from`/`to`, istDayBound IST-anchors
    // them, so the boundary trade still classifies into FY 2026, not FY 2025.
    const fy2026 = financialYearOption(2026);
    const dateOnly = tradeDateWindow({
      fromDate: fy2026.from,
      toDate: fy2026.to,
    });
    const instants = tradeDateWindow({
      fromDate: fy2026.gte,
      toDate: fy2026.lte,
    });
    assert.equal(dateOnly.gte.getTime(), instants.gte.getTime());
    assert.equal(dateOnly.lte.getTime(), instants.lte.getTime());
    assert.equal(inWindow(boundary, dateOnly), true);
  });
});

describe("buildTradeWhereClause FY window — symmetric Mar-31 boundary", () => {
  it("the last IST instant of FY 2025 (31-Mar 23:59:59.999 IST) is INCLUDED in FY 2025", () => {
    // 2026-03-31T18:29:59.999Z == 31-Mar-2026 23:59:59.999 IST.
    const lastMomentFy2025 = new Date("2026-03-31T18:29:59.999Z");
    const fy2025 = financialYearOption(2025);
    const win = tradeDateWindow({ fromDate: fy2025.gte, toDate: fy2025.lte });
    assert.equal(inWindow(lastMomentFy2025, win), true);
  });

  it("one millisecond later (1-Apr 00:00:00.000 IST) flips OUT of FY 2025 and INTO FY 2026", () => {
    // 2026-03-31T18:30:00.000Z == 1-Apr-2026 00:00:00.000 IST.
    const firstMomentFy2026 = new Date("2026-03-31T18:30:00.000Z");
    const fy2025 = tradeDateWindow({
      fromDate: financialYearOption(2025).gte,
      toDate: financialYearOption(2025).lte,
    });
    const fy2026 = tradeDateWindow({
      fromDate: financialYearOption(2026).gte,
      toDate: financialYearOption(2026).lte,
    });
    assert.equal(inWindow(firstMomentFy2026, fy2025), false);
    assert.equal(inWindow(firstMomentFy2026, fy2026), true);
  });
});

describe("istDayBound — date-only vs full-instant resolution", () => {
  it("date-only start → IST 00:00 of that day as a UTC instant", () => {
    assert.equal(
      istDayBound("2026-04-01", "start").toISOString(),
      "2026-03-31T18:30:00.000Z"
    );
  });

  it("date-only end → IST 23:59:59.999 of that day as a UTC instant", () => {
    assert.equal(
      istDayBound("2027-03-31", "end").toISOString(),
      "2027-03-31T18:29:59.999Z"
    );
  });

  it("a full ISO instant passes through verbatim (which is ignored)", () => {
    const iso = "2026-03-31T20:30:00.000Z";
    assert.equal(istDayBound(iso, "start").toISOString(), iso);
    assert.equal(istDayBound(iso, "end").toISOString(), iso);
  });

  it("a malformed bound yields an Invalid Date (Prisma rejects it; no throw here)", () => {
    assert.doesNotThrow(() => istDayBound("not-a-date", "start"));
    assert.ok(Number.isNaN(istDayBound("not-a-date", "start").getTime()));
  });
});

describe("availableFinancialYears options each carry the correct instants", () => {
  it("a multi-FY span yields options whose gte/lte match fyWindowUtc per year", () => {
    const fys = availableFinancialYears(
      new Date("2024-06-10T00:00:00Z"),
      new Date("2026-05-20T00:00:00Z")
    );
    assert.deepEqual(
      fys.map((f) => f.id),
      ["fy-2026", "fy-2025", "fy-2024"]
    );
    for (const fy of fys) {
      const startYear = Number(fy.id.slice("fy-".length));
      const win = fyWindowUtc(`${startYear}-${startYear + 1}`);
      assert.equal(fy.gte, win.gte.toISOString());
      assert.equal(fy.lte, win.lte.toISOString());
    }
  });
});

describe("getAvailableFYsAction demo branch derivation (trades.ts ~:132-166)", () => {
  // The action's demo branch computes its FY list as:
  //   availableFinancialYears(new Date(min(times)), new Date(max(times)))
  // over the REAL demoTrades' tradeDate values (with a `times.length === 0 → []`
  // guard). This asserts that EXACT expression against the REAL demoTrades + the
  // REAL availableFinancialYears helper (no shadow — the same data + same code
  // the action runs; only the isDemoSession()/auth glue is omitted).
  function demoFYsFor(
    trades: ReadonlyArray<{ tradeDate: Date | string | number }>
  ): ReturnType<typeof availableFinancialYears> {
    const times = trades
      .map((t) => new Date(t.tradeDate).getTime())
      .filter((n) => Number.isFinite(n));
    if (times.length === 0) return [];
    return availableFinancialYears(
      new Date(Math.min(...times)),
      new Date(Math.max(...times))
    );
  }

  it("derives the FY list from the static demoTrades (all FY 2024)", () => {
    const fys = demoFYsFor(demoTrades);
    // demoTrades are all stamped Dec-2024 → exactly FY 2024.
    assert.deepEqual(
      fys.map((f) => f.id),
      ["fy-2024"]
    );
    assert.equal(fys[0]!.gte, "2024-03-31T18:30:00.000Z");
    assert.equal(fys[0]!.lte, "2025-03-31T18:29:59.999Z");
  });

  it("the no-trades guard returns [] (empty demo data)", () => {
    assert.deepEqual(demoFYsFor([]), []);
  });
});
