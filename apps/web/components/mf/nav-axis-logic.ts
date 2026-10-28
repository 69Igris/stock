/**
 * X-axis tick formatting for the fund-detail NAV chart.
 *
 * The axis formatted EVERY tick as `new Date(t).getFullYear()`, regardless of
 * the selected period. On 1M or 3M every point falls in the same calendar
 * year, so the axis rendered the same string a dozen times — "2026 2026 2026
 * 2026 …" — which is not a broken chart so much as an axis that has stopped
 * carrying information. Nothing errors, and at 3Y/5Y/ALL the same code is
 * correct, which is why it survived.
 *
 * Granularity is derived from the SPAN of the data actually plotted rather
 * than from the period button, because those can disagree: a fund launched six
 * weeks ago has ~30 points under "1Y", and labelling those by year would
 * reproduce the bug inside a period that looks like it should be safe.
 *
 * Pure and recharts-free so it can be unit-tested under node:test — the canvas
 * that consumes it imports recharts and cannot be.
 */

export type NavAxisGranularity = "day" | "month" | "monthYear" | "year";

/** Below this many days, individual days are worth naming. Covers 1M and 3M. */
const DAY_SPAN_LIMIT = 120;
/** Below this, months. Above it, months would repeat too often to read. */
const MONTH_SPAN_LIMIT = 400;

const MS_PER_DAY = 86_400_000;

/**
 * Choose a tick granularity for a series spanning `firstIso` … `lastIso`.
 *
 * Unparseable bounds fall back to "day", the most specific option: a wrong
 * date rendered as "07 Aug" is visibly odd, whereas the same wrong date
 * rendered as "2026" looks entirely normal and hides the problem.
 */
export function navAxisGranularity(
  firstIso: string,
  lastIso: string
): NavAxisGranularity {
  const start = new Date(firstIso).getTime();
  const end = new Date(lastIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "day";

  const spanDays = Math.abs(end - start) / MS_PER_DAY;
  if (spanDays <= DAY_SPAN_LIMIT) return "day";
  if (spanDays <= MONTH_SPAN_LIMIT) {
    // A span inside ONE calendar year needs no year on each tick; one that
    // crosses New Year does, or "Jan" appears twice meaning different years.
    return new Date(start).getFullYear() === new Date(end).getFullYear()
      ? "month"
      : "monthYear";
  }
  return "year";
}

/**
 * Render one tick. Returns "" for an unparseable value — a blank tick reads as
 * a gap, while "Invalid Date" would be printed on the axis in full.
 */
export function formatNavAxisTick(
  iso: string,
  granularity: NavAxisGranularity
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  switch (granularity) {
    case "day":
      return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
      });
    case "month":
      return d.toLocaleDateString("en-IN", { month: "short" });
    case "monthYear":
      return d.toLocaleDateString("en-IN", {
        month: "short",
        year: "2-digit",
      });
    case "year":
      return String(d.getFullYear());
  }
}
