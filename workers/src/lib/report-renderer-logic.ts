/**
 * Report-renderer — PURE date/dispatch logic (no Prisma / @react-pdf / I/O).
 *
 * Side-effect-free helpers extracted out of `report-renderer.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies). Importing
 * `report-renderer.ts` directly would boot Prisma (`@usemoney/database` is a
 * top-level import there), so the pure logic lives in this sibling — mirroring
 * the worker precedent `sync-logic.ts` / `import-logic.ts`. `report-renderer.ts`
 * imports and CALLS every export here, so the production code path and the tests
 * execute the SAME code.
 *
 * The old inline `report-renderer.test.ts` re-implemented `getCurrentFY` /
 * `fyToDateRange` (plus several FABRICATED helpers that had no source at all)
 * and asserted the copy — a shadow.
 *
 * @see workers/src/lib/report-renderer.ts (caller)
 * @see apps/web/__tests__/workers/report-renderer.test.ts (tests the real exports)
 */

/** Report types `renderReportToBuffer` can dispatch (the switch arms). */
export const VALID_REPORT_TYPES = [
  "tax",
  "risk",
  "portfolio_statement",
] as const;

export type ReportType = (typeof VALID_REPORT_TYPES)[number];

/** True when `reportType` is one the renderer knows how to build. */
export function isValidReportType(reportType: string): reportType is ReportType {
  return (VALID_REPORT_TYPES as readonly string[]).includes(reportType);
}

/**
 * Current Indian financial year in `YYYY-YY` form (e.g. `2025-26`). The FY runs
 * April→March, so months Apr..Dec (>= 4, 1-indexed) belong to `year-(year+1)`
 * and Jan..Mar belong to `(year-1)-year`.
 */
export function getCurrentFY(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed; April = 4
  if (month >= 4) {
    return `${year}-${String(year + 1).slice(2)}`;
  }
  return `${year - 1}-${String(year).slice(2)}`;
}

/**
 * Convert an `YYYY-YY` FY string to its `[Apr 1 00:00:00, Mar 31 23:59:59]`
 * date range (the bounds the tax-report Prisma query filters `tradeTime` on).
 *
 * GUARD: a malformed `fy` whose leading segment is not a number (`""`,
 * `"garbage"`, `"FY24"`) would make `parseInt` return `NaN` and yield an Invalid
 * Date range — which silently matches NO trades (every `gte/lte` comparison
 * against an Invalid Date is false), producing a blank report instead of an
 * error. We throw a descriptive error instead so the caller fails loudly.
 */
export function fyToDateRange(fy: string): { startDate: Date; endDate: Date } {
  const [startYear] = fy.split("-");
  const year = Number.parseInt(startYear ?? "", 10);
  if (!Number.isFinite(year)) {
    throw new Error(`Invalid financial year: "${fy}" (expected "YYYY-YY")`);
  }
  return {
    startDate: new Date(year, 3, 1), // April 1, 00:00:00
    endDate: new Date(year + 1, 2, 31, 23, 59, 59), // March 31, 23:59:59
  };
}
