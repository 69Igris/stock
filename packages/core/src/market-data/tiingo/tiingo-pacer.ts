/**
 * The ONE rate limiter for every Tiingo call in this repo — MONEY-1263.
 *
 * ## Why this file exists
 *
 * The quota is per ACCOUNT, not per client. When the corporate-actions and news
 * clients were added, each copied the EOD client's pacer, and each copy carried
 * its own module-scope `lastRequestAtMs`. Four call sites — EOD, corporate
 * actions, news, and the permaTicker search — were then pacing independently
 * against one shared ceiling, so the effective rate was FOUR TIMES the cap the
 * pacer exists to enforce. The search client was worse still: a flat 200ms
 * delay that did not consult the plan at all, so it ignored `TIINGO_PLAN`
 * entirely.
 *
 * Nothing would have failed loudly. Tiingo publishes no quota headers (verified:
 * a successful call returns only `x-frame-options`), so the first symptom would
 * have been a 429 wall mid-backfill — the exact outcome proactive pacing is
 * built to prevent, arriving through the machinery meant to prevent it.
 *
 * A shared module holds shared state. That is the whole design.
 *
 * ## Why proactive at all
 *
 * A 429 is the only feedback this API gives and it arrives too late to steer
 * by. The retry ladder in each client REACTS to a wall already hit; this keeps
 * us from reaching it. Both are needed — reacting alone means a backfill
 * discovers the limit by failing tens of thousands of times at the worst
 * possible moment.
 *
 * ## Why evenly spread and not a token bucket
 *
 * An hourly cap is enforced over a rolling hour, so spending it in the first
 * five minutes buys nothing and risks a lockout for the remaining fifty-five.
 * At COMMERCIAL's 20,000/hr that is one request per 180ms — still ~1.3 hours
 * for the whole equity universe. No caller benefits from a burst allowance, and
 * a burst is precisely what would trip a ceiling we cannot observe.
 */

import { tiingoLimits } from "./tiingo-logic";
import { TiingoRateLimitError } from "./tiingo-errors";

/**
 * Raised when the DAILY ceiling is reached. Callers circuit-break the run.
 *
 * ## Why it EXTENDS TiingoRateLimitError rather than Error
 *
 * Because every circuit-breaker in the repo was already written against
 * `TiingoRateLimitError` — seven of them, across `us-eod-sync` and the three
 * backfill scripts — and none of them knew this class existed. As a plain
 * `Error` it fell into their generic `else` branch, which means the daily cap
 * did the OPPOSITE of what a cap is for: the throw happens BEFORE any sleep, so
 * the run tore through every remaining symbol in seconds recording each as a
 * failure, and because `rateLimited` was never set it also kept self-chaining —
 * a job that hit its ceiling and responded by asking for more.
 *
 * Making it a SUBCLASS means every existing `instanceof TiingoRateLimitError`
 * catches it correctly without being found and edited, and a future breaker
 * written against the parent inherits the behaviour rather than the bug. The
 * distinction stays available to anyone who wants it, but nobody has to know.
 */
export class TiingoDailyCapError extends TiingoRateLimitError {
  constructor(message: string) {
    super(message);
    this.name = "TiingoDailyCapError";
  }
}

let lastRequestAtMs = 0;
let dayWindowStartedMs = 0;
let dayRequestCount = 0;

/** Reset the shared pacing state. Tests only — module state would leak. */
export function __resetTiingoPacer(): void {
  lastRequestAtMs = 0;
  dayWindowStartedMs = 0;
  dayRequestCount = 0;
}

/** Requests charged in the current day window. Diagnostics only. */
export function tiingoRequestsToday(): number {
  return dayRequestCount;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until it is this caller's turn, then charge one request.
 *
 * EVERY Tiingo request in the repo goes through here — including each RETRY,
 * because a retry is another request against the same quota and a ladder that
 * skipped the pacer would burst at exactly the moment we are already being
 * limited.
 *
 * Throws {@link TiingoDailyCapError} at the daily ceiling rather than sleeping.
 * Sleeping until tomorrow inside a worker with a 600s Pub/Sub ack deadline is
 * not a throttle, it is a hang that ends in redelivery and a second copy of the
 * job; throwing lets the caller checkpoint and chain.
 */
export async function paceTiingoRequest(): Promise<void> {
  const limits = tiingoLimits();
  const now = Date.now();

  if (dayWindowStartedMs === 0 || now - dayWindowStartedMs >= 86_400_000) {
    dayWindowStartedMs = now;
    dayRequestCount = 0;
  }
  if (dayRequestCount >= limits.perDay) {
    throw new TiingoDailyCapError(
      `Tiingo daily cap ${limits.perDay} reached for plan ` +
        `${process.env.TIINGO_PLAN ?? "COMMERCIAL"}`,
    );
  }

  const minIntervalMs = Math.ceil(3_600_000 / limits.perHour);
  const since = now - lastRequestAtMs;
  if (lastRequestAtMs !== 0 && since < minIntervalMs) {
    await delay(minIntervalMs - since);
  }
  lastRequestAtMs = Date.now();
  dayRequestCount++;
}
