/**
 * GST billing period computation.
 *
 * UseMoney's invoice cadence is a 15-day half-month: the 1st-to-15th and
 * 16th-to-end-of-month. The period boundary determines `time of supply` (per
 * CGST §13) - i.e. the date stamped on the invoice is the LAST day of the
 * half-month the transaction belongs to, not the date Dodo settled it. This
 * keeps GSTR-1 reporting aligned with our books.
 *
 * The half-month length is configurable via `BILLING_PERIOD_DAYS` env (default
 * 15) so we can switch to a monthly cadence later without touching engine code.
 */

const DEFAULT_PERIOD_DAYS = 15;

function getPeriodDays(): number {
  const raw = process.env.BILLING_PERIOD_DAYS;
  if (!raw) return DEFAULT_PERIOD_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERIOD_DAYS;
}

/**
 * Get the billing period (start, end) that contains the given transaction date.
 *
 * For BILLING_PERIOD_DAYS=15 (default), a 30-day month splits into two periods:
 *   1st – 15th  (e.g. 2026-04-01 → 2026-04-15)
 *   16th – end  (e.g. 2026-04-16 → 2026-04-30)
 *
 * For shorter months (Feb), the second period stretches to the actual month end.
 * Both `start` and `end` are inclusive day boundaries (00:00 → 23:59:59.999 UTC).
 */
export function getBillingPeriod(txDate: Date): {
  start: Date;
  end: Date;
} {
  const periodDays = getPeriodDays();
  const year = txDate.getUTCFullYear();
  const month = txDate.getUTCMonth();
  const day = txDate.getUTCDate();

  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  let startDay: number;
  let endDay: number;

  if (day <= periodDays) {
    startDay = 1;
    endDay = Math.min(periodDays, lastDayOfMonth);
  } else {
    startDay = periodDays + 1;
    endDay = lastDayOfMonth;
  }

  const start = new Date(Date.UTC(year, month, startDay, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, endDay, 23, 59, 59, 999));
  return { start, end };
}

/**
 * Indian financial year string for a given date - "26-27" for Apr 2026 – Mar 2027.
 * FY rolls over on April 1; March 31 belongs to the prior FY.
 */
export function getFinancialYear(d: Date): string {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed
  const fyStartYear = month >= 3 ? year : year - 1;
  const fyEndYear = fyStartYear + 1;
  const pad = (n: number) => String(n).padStart(2, "0").slice(-2);
  return `${pad(fyStartYear)}-${pad(fyEndYear)}`;
}
