/**
 * Pure helpers for NSE/BSE market-hours gating.
 *
 * NSE/BSE share trading hours: Mon-Fri 09:15-15:30 IST.
 * Public holidays are not handled here (would need a server-supplied calendar).
 *
 * The functions accept an optional `Date` parameter so tests can pin time;
 * production callers pass the current Date implicitly.
 */

const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30
const WEEKEND_DAYS = ["Sat", "Sun"];

export interface MarketSnapshot {
  /** HH:MM:SS in IST, 24-hour format */
  time: string;
  /** True if market is currently open (Mon-Fri, 09:15 ≤ now < 15:30 IST) */
  isOpen: boolean;
}

/**
 * Compute the IST market snapshot at a given instant.
 * @param at Instant to evaluate. Defaults to `new Date()`.
 */
export function getMarketSnapshot(at: Date = new Date()): MarketSnapshot {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata",
    hour12: false,
  }).format(at);

  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
    hour12: false,
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = parseInt(
    parts.find((p) => p.type === "hour")?.value || "00",
    10
  );
  const minute = parseInt(
    parts.find((p) => p.type === "minute")?.value || "00",
    10
  );
  const minutesSinceMidnight = hour * 60 + minute;

  const isWeekday = !WEEKEND_DAYS.includes(weekday);
  const isOpen =
    isWeekday &&
    minutesSinceMidnight >= MARKET_OPEN_MIN &&
    minutesSinceMidnight < MARKET_CLOSE_MIN;

  return { time, isOpen };
}

/**
 * Convenience boolean check.
 */
export function isMarketOpenAt(at: Date = new Date()): boolean {
  return getMarketSnapshot(at).isOpen;
}
