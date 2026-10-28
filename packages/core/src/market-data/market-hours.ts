/**
 * NSE / BSE market-hours phase detector.
 *
 * Companion to `nse-holidays.ts` - adds the time-of-day rule on top
 * of the holiday calendar so the rest of the app can decide whether
 * to start a polling loop or render a closed-market badge.
 *
 * IST-aware via manual +5:30 offset, matching the pattern already
 * established in `toIstDateKey`. We deliberately avoid `Intl`
 * timezone APIs because Cloud Run / Vercel hosts can ship with
 * surprising default timezones; a fixed offset is the safest path.
 *
 * Phase definitions (IST):
 *   - PRE_OPEN    Mon–Fri, 00:00–09:14:59 on a non-holiday
 *   - OPEN        Mon–Fri, 09:15:00–15:29:59 on a non-holiday
 *   - POST_CLOSE  Mon–Fri, 15:30:00–23:59:59 on a non-holiday
 *   - WEEKEND     Saturday or Sunday (any time)
 *   - HOLIDAY     Any day matching `NSE_HOLIDAYS_BY_FY`
 *
 * `isLive` is true ONLY in the OPEN phase. Pre-open and post-close
 * are intentionally NOT live - quotes during those windows are stale
 * (the previous-day close until ~09:15) and polling them only burns
 * cache and confuses users.
 */

import { getNseHoliday } from "./nse-holidays";

export type MarketPhase =
  | "PRE_OPEN"
  | "OPEN"
  | "POST_CLOSE"
  | "WEEKEND"
  | "HOLIDAY";

export interface MarketStatus {
  /** Coarse phase classification - primary discriminator for UI/polling. */
  phase: MarketPhase;
  /** Convenience flag - true only during the OPEN phase. */
  isLive: boolean;
  /**
   * Human-readable reason - non-null when the market is closed for a
   * reason other than the time-of-day cutoff (e.g. "Diwali Laxmi Pujan",
   * "Weekend"). `null` when phase is OPEN, PRE_OPEN, or POST_CLOSE.
   */
  reason: string | null;
  /** Next session open instant (UTC). Non-null whenever isLive=false. */
  nextOpenAt: Date | null;
  /** Current session close instant (UTC). Non-null whenever isLive=true. */
  closesAt: Date | null;
}

/** 09:15 IST → 03:45 UTC offset minutes from start of day. */
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
/** 15:30 IST → 10:00 UTC offset minutes from start of day. */
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Convert a Date to IST clock components. */
function toIstClock(date: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutesFromMidnight: number;
} {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    day: ist.getUTCDate(),
    weekday: ist.getUTCDay(), // 0 Sun .. 6 Sat
    minutesFromMidnight: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

/** Build a UTC instant from IST date components + minutes-from-midnight. */
function istToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
): Date {
  const hh = Math.floor(minutesFromMidnight / 60);
  const mm = minutesFromMidnight % 60;
  // Construct as UTC-of-IST, then subtract the offset to land at real UTC.
  const istAsUtc = Date.UTC(year, month, day, hh, mm, 0, 0);
  return new Date(istAsUtc - IST_OFFSET_MS);
}

/**
 * Walk forward day by day until we land on a trading day (not weekend,
 * not holiday). Returns the IST clock components of that day. Worst-case
 * we walk ~5 days (Diwali cluster + weekend).
 */
function nextTradingDayIst(
  fromYear: number,
  fromMonth: number,
  fromDay: number,
): {
  year: number;
  month: number;
  day: number;
} {
  let cursor = new Date(Date.UTC(fromYear, fromMonth, fromDay));
  for (let i = 0; i < 14; i++) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    const probe = new Date(cursor.getTime() - IST_OFFSET_MS);
    const ist = toIstClock(probe);
    if (ist.weekday === 0 || ist.weekday === 6) continue;
    if (getNseHoliday(probe)) continue;
    return { year: ist.year, month: ist.month, day: ist.day };
  }
  // Defensive fallback - shouldn't happen with a 14-day search window.
  return { year: fromYear, month: fromMonth, day: fromDay };
}

/**
 * Resolve the current NSE market phase for a given instant. Defaults to
 * `new Date()` so callers can simply do `getNseMarketStatus()`.
 */
export function getNseMarketStatus(date: Date = new Date()): MarketStatus {
  const ist = toIstClock(date);

  // Holiday wins over weekday - show "Diwali" not "Pre-open".
  const holiday = getNseHoliday(date);
  if (holiday) {
    const next = nextTradingDayIst(ist.year, ist.month, ist.day);
    return {
      phase: "HOLIDAY",
      isLive: false,
      reason: holiday.name,
      nextOpenAt: istToUtc(
        next.year,
        next.month,
        next.day,
        SESSION_OPEN_MINUTES,
      ),
      closesAt: null,
    };
  }

  // Weekend before time-of-day rules.
  if (ist.weekday === 0 || ist.weekday === 6) {
    const next = nextTradingDayIst(ist.year, ist.month, ist.day);
    return {
      phase: "WEEKEND",
      isLive: false,
      reason: ist.weekday === 0 ? "Sunday" : "Saturday",
      nextOpenAt: istToUtc(
        next.year,
        next.month,
        next.day,
        SESSION_OPEN_MINUTES,
      ),
      closesAt: null,
    };
  }

  // Weekday - branch on time of day.
  if (ist.minutesFromMidnight < SESSION_OPEN_MINUTES) {
    // Pre-open same day
    return {
      phase: "PRE_OPEN",
      isLive: false,
      reason: null,
      nextOpenAt: istToUtc(ist.year, ist.month, ist.day, SESSION_OPEN_MINUTES),
      closesAt: null,
    };
  }
  if (ist.minutesFromMidnight < SESSION_CLOSE_MINUTES) {
    // Live session
    return {
      phase: "OPEN",
      isLive: true,
      reason: null,
      nextOpenAt: null,
      closesAt: istToUtc(ist.year, ist.month, ist.day, SESSION_CLOSE_MINUTES),
    };
  }
  // Post-close - next open is the next trading day's 09:15.
  const next = nextTradingDayIst(ist.year, ist.month, ist.day);
  return {
    phase: "POST_CLOSE",
    isLive: false,
    reason: null,
    nextOpenAt: istToUtc(next.year, next.month, next.day, SESSION_OPEN_MINUTES),
    closesAt: null,
  };
}

/**
 * Friendly badge text for the closed-market states. Returns `null` when
 * the market is open - let the caller render its own LIVE pulse.
 */
export function formatClosedReason(status: MarketStatus): string | null {
  if (status.isLive) return null;
  if (status.phase === "HOLIDAY" && status.reason) {
    return `Closed · ${status.reason}`;
  }
  if (status.phase === "WEEKEND") return "Closed · Weekend";
  if (status.phase === "PRE_OPEN") return "Opens 09:15 IST";
  if (status.phase === "POST_CLOSE") return "Closed · Opens tomorrow 09:15";
  return "Closed";
}
