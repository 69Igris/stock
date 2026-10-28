/**
 * NSE / BSE trading holiday calendar - hardcoded, refreshed per FY.
 *
 * Source: official NSE circulars + BSE notices. Calendar is published
 * once per Indian financial year (Apr 1 → Mar 31). Update this file in
 * Q4 of each FY when next year's circular drops; the
 * `NSE_HOLIDAYS_BY_FY` map is the single source of truth.
 *
 * Format:
 *   - Keys: "YY-YY" (e.g. "26-27" = Apr 2026 → Mar 2027)
 *   - Each entry: ISO date "YYYY-MM-DD" + holiday name
 *
 * Holidays already falling on Sat/Sun are intentionally retained so a
 * UI rendering "markets closed · Diwali" reads correctly even when the
 * weekend rule would have closed the market anyway.
 *
 * Special sessions like Diwali Muhurat (~1hr evening session) are NOT
 * encoded as full-day closures - the regular `getNseMarketStatus`
 * helper treats them as closed during the morning session and the
 * evening Muhurat is a separate concern (chat doesn't currently
 * surface Muhurat hours; if ever needed, add a `partialSession` flag).
 */

export interface NseHoliday {
  /** ISO date - YYYY-MM-DD, IST calendar day. */
  date: string;
  /** Display name for the badge. */
  name: string;
  /** True if both equity + F&O are closed (default). False = equity only. */
  fullClose?: boolean;
}

/**
 * NSE holidays grouped by Indian financial year (Apr 1 → Mar 31).
 *
 * FY 26-27 is transcribed from NSE circular NSE/CMTR/71775 (Circular Ref.
 * 172/2025, 12-Dec-2025, "Trading holidays for the calendar year 2026") —
 * MONEY-1615. It used to hold 2025's dates with the year changed (Ganesh
 * Chaturthi 27-Aug, Diwali 21/22-Oct, Guru Nanak 5-Nov), so the walkers
 * skipped 2026-08-27, a real trading day, and nothing archived it. NSE
 * publishes by CALENDAR year in December, so Jan–Mar 2027 holds only Republic
 * Day (fixed) until the CY2027 circular lands: a wrong date here skips a real
 * session, which is worse than a missing one (a fetch on a holiday finds
 * nothing). Transcribe from the circular — never shift last year's list.
 */
export const NSE_HOLIDAYS_BY_FY: Record<string, NseHoliday[]> = {
  "26-27": [
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-14", name: "Dr. Baba Saheb Ambedkar Jayanti" },
    { date: "2026-05-01", name: "Maharashtra Day" },
    { date: "2026-05-28", name: "Bakri Id" },
    { date: "2026-06-26", name: "Muharram" },
    { date: "2026-08-15", name: "Independence Day" }, // Saturday
    { date: "2026-09-14", name: "Ganesh Chaturthi" },
    { date: "2026-10-02", name: "Mahatma Gandhi Jayanti" },
    { date: "2026-10-20", name: "Dussehra" },
    { date: "2026-11-08", name: "Diwali Laxmi Pujan" }, // Sunday; Muhurat session
    { date: "2026-11-10", name: "Diwali-Balipratipada" },
    { date: "2026-11-24", name: "Prakash Gurpurb Sri Guru Nanak Dev" },
    { date: "2026-12-25", name: "Christmas" },
    // Jan–Mar 2027: only the fixed-date holiday until NSE's CY2027 circular.
    { date: "2027-01-26", name: "Republic Day" },
  ],
  // Add subsequent FYs here, from NSE's calendar-year circular (published
  // each December). The lookup helper falls back to "no holiday" if a date
  // lands in an unmapped FY: the badge then shows OPEN/CLOSED purely from the
  // time-of-day rule, and a walker fetches that day and finds nothing.
};

/** Return the Indian FY string (e.g. "26-27") containing the given IST date. */
export function getFinancialYear(istDate: Date): string {
  const month = istDate.getUTCMonth(); // 0-indexed; 3 = April
  const yy = istDate.getUTCFullYear() % 100;
  // Apr (3) → Dec (11) belongs to FY starting this calendar year.
  // Jan (0) → Mar (2) belongs to FY starting LAST calendar year.
  if (month >= 3) {
    return `${pad2(yy)}-${pad2((yy + 1) % 100)}`;
  }
  return `${pad2((yy - 1 + 100) % 100)}-${pad2(yy)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Convert any Date to its IST calendar date in YYYY-MM-DD form. Avoids
 * relying on the host TZ - adds the +5:30 offset manually.
 */
export function toIstDateKey(date: Date): string {
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = pad2(ist.getUTCMonth() + 1);
  const d = pad2(ist.getUTCDate());
  return `${y}-${m}-${d}`;
}

/**
 * Whether the given Date falls on an NSE-closed market holiday. Returns
 * the holiday name when true so callers can surface "markets closed ·
 * Diwali Laxmi Pujan" in the UI.
 */
export function getNseHoliday(date: Date = new Date()): NseHoliday | null {
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const fy = getFinancialYear(ist);
  const list = NSE_HOLIDAYS_BY_FY[fy];
  if (!list) return null;
  const key = toIstDateKey(date);
  return list.find((h) => h.date === key) ?? null;
}

/**
 * Is the given Date a non-trading day (weekend OR holiday)? Returned
 * tuple lets callers branch on reason - `name` is non-null only for
 * holidays.
 */
export function getNonTradingReason(date: Date = new Date()): {
  isClosed: boolean;
  reason: "WEEKEND" | "HOLIDAY" | null;
  name?: string;
} {
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const day = ist.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) {
    return { isClosed: true, reason: "WEEKEND" };
  }
  const holiday = getNseHoliday(date);
  if (holiday) {
    return { isClosed: true, reason: "HOLIDAY", name: holiday.name };
  }
  return { isClosed: false, reason: null };
}
