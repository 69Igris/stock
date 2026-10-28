/**
 * Who owns a SESSION — MONEY-1373.
 *
 * ## The rule this extends, and why it is not enough on its own
 *
 * MONEY-1309 established that a `(symbol, timeframe, session)` may hold bars
 * from exactly ONE `source`, because the two producers measure different
 * things: the Tiingo realtime sink builds bars from quote MIDS and writes
 * `volume: 0` meaning "this feed does not report volume", while a trade-derived
 * feed writes a real number. A session holding both has a volume column that is
 * meaningless in a way no reader can detect, and an OHLC whose definition
 * changes partway through the day.
 *
 * `mayWriteIntoDay` enforces that, and it is deliberately GENERIC — it names no
 * vendor, and this module does not change it. Read its header: naming a vendor
 * inside it would encode one collision and miss the others.
 *
 * But a pure refusal is the wrong answer for the case this ticket creates.
 * Databento's daily append lands on sessions the realtime sink already filled
 * hours earlier, and those bars are strictly WORSE: quote-mid prices with a
 * structural zero volume, against consolidated trade prints with real volume.
 * Refusing would mean the warehouse permanently keeps the inferior copy of
 * every session, and the backtest engine — the entire reason for buying this
 * data — would read quote mids.
 *
 * So this module adds a DISPLACEMENT verdict on top of the refusal: a session
 * held by a strictly weaker source may be REPLACED wholesale by a stronger one.
 * Not merged — replaced — because a merge is exactly the mixed session the rule
 * forbids.
 *
 * ## Four things this refuses, and each one matters
 *
 *   1. TIINGO_RT arriving on a DATABENTO session. The reverse of the case
 *      above, and it must never happen: a live tick would overwrite a settled
 *      trade-derived bar with a quote mid.
 *   2. ANY displacement on `D1`. Tiingo owns the daily series outright. This is
 *      enforced twice over — by RANK, since `DATABENTO` (55) is below `TIINGO`
 *      (60), and by an explicit timeframe test here — because a rank table is
 *      one edit away from being reordered and the daily series is the one every
 *      user-facing surface reads.
 *   3. A session held by an equal-or-stronger source at any timeframe.
 *   4. Nothing at all, when the session is empty or already ours — those are
 *      plain writes, and the second is what makes a re-run idempotent.
 *
 * ## Displacement is a WRITER-side step, not a repository one
 *
 * `CandleRepository.putCandles` `$set`s `source` unconditionally on its upgrade
 * path, which is correct for a repository whose job is "write what you are
 * given". The session rule therefore has to be applied BEFORE the call, by the
 * writer that knows it is a second source — `candle-sink.ts` says exactly this
 * about `mayWriteIntoDay`, and `databento-session-writer.ts` is the equivalent
 * caller on this side.
 */

import { isIntradayTimeframe } from "../candles/candle-logic";
import { shouldUpgradePriceSource } from "../price-source-authority";
import { mayWriteIntoDay } from "../tiingo/tiingo-rt-sink-logic";

export type SessionVerdict =
  | { action: "write"; reason: string }
  | { action: "displace"; deleting: string[]; reason: string }
  | { action: "refuse"; reason: string; d1: boolean };

/**
 * May `incomingSource` write into a session currently holding `existingSources`?
 *
 * `existingSources` is the DISTINCT set of sources already present in the
 * session — normally zero or one, because the rule keeps it that way, but the
 * signature admits several so a session left mixed by an interrupted write can
 * be healed rather than refused forever.
 */
export function decideSessionWrite(args: {
  incomingSource: string;
  existingSources: readonly string[];
  timeframe: string;
}): SessionVerdict {
  const { incomingSource, timeframe } = args;
  const existing = args.existingSources.filter((s) => s !== "");

  // 1. Empty session. Defer to the generic rule rather than restating it.
  if (existing.length === 0) {
    const verdict = mayWriteIntoDay(incomingSource, null);
    return { action: "write", reason: verdict.reason };
  }

  // 2. Already ours. This is what makes a re-run a no-op instead of a churn of
  //    delete-and-rewrite, and it is checked before any authority comparison —
  //    a source never displaces itself.
  if (existing.every((s) => s === incomingSource)) {
    return { action: "write", reason: "same source" };
  }

  // 3. Never displace a non-intraday series. Tiingo owns D1 and every
  //    user-facing surface reads it; the rank table already says so, and this
  //    says it again in a way a reordering cannot silently undo.
  if (!isIntradayTimeframe(timeframe)) {
    return {
      action: "refuse",
      d1: true,
      reason:
        `session holds ${existing.join(", ")} at timeframe ${timeframe}; ` +
        `refusing ${incomingSource}. Displacement is for INTRADAY timeframes ` +
        "only — the daily series is Tiingo's, and it is what every " +
        "user-facing surface reads.",
    };
  }

  const weaker = existing.filter(
    (s) => s !== incomingSource && shouldUpgradePriceSource(s, incomingSource),
  );
  const blocking = existing.filter(
    (s) => s !== incomingSource && !shouldUpgradePriceSource(s, incomingSource),
  );

  // 4. Anything we cannot outrank blocks the whole session. Not a partial
  //    displacement: removing the weaker half would leave the stronger half
  //    beside our bars, which is the mixed session the rule exists to prevent.
  if (blocking.length > 0) {
    return {
      action: "refuse",
      d1: false,
      reason: mayWriteIntoDay(incomingSource, blocking[0]!).reason,
    };
  }

  return {
    action: "displace",
    deleting: weaker,
    reason:
      `replacing ${weaker.join(", ")} with ${incomingSource} for this ` +
      `${timeframe} session: trade-derived bars with real volume outrank ` +
      "quote-derived bars with a structural zero, and a session must still " +
      "hold ONE source.",
  };
}
