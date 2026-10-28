/**
 * The READ side of the US realtime layer — pure decisions, zero I/O.
 *
 * `tiingo-rt-keys.ts` owns the key vocabulary the socket holder WRITES.
 * This module owns what a READER does with what it finds there, and it is
 * deliberately I/O-free so every branch below is testable without Redis, without
 * Mongo and — the point of the whole exercise — without a Tiingo token. There is
 * no HTTP client reachable from here, by construction: the request path serves
 * US quotes out of our own two stores and NEVER out of `api.tiingo.com`.
 * `tiingo-rt-read.ts` supplies the ports.
 *
 * ## The three outcomes, and the one rule behind them
 *
 *   rt fresh + session bar   TIINGO_RT  fallback:false   a live quote
 *   session bar, no fresh rt TIINGO     fallback:true    the last close
 *   no session bar           (absent)                    fail-open, like India
 *
 * THE RULE: a quote is emitted only when a session bar supplies its PREVIOUS
 * CLOSE. Without one there is no basis for `change` / `changePercent`, and the
 * feed publishes a bid/ask — a point, not a session — so `open`, `high`, `low`
 * and `volume` have no basis either. `UsQuote` types all of them `number`, so
 * "unknown" cannot be said in the payload; the only two ways to emit are to
 * invent a flat zero or to widen every money field to `number | null` across
 * the shared `QuoteData` and push nulls into the India path that can never
 * produce one (measured: six bridge sites in `yahoo-client.ts` alone). A flat
 * 0.00% reads as "unchanged" — a claim about the market — and it is invisible
 * on screen, whereas an absent symbol is visible and is the fail-open contract
 * `/api/market/quote` already has. So: no bar, no quote.
 *
 * ## MONEY-1309 follow-up — there used to be a FOURTH outcome, and it was wrong
 *
 * A stale realtime quote with no bar used to be served as `TIINGO_RT` +
 * `fallback:true`, justified like this: "`us-eod-sync` runs 11:00 IST — about
 * 01:30 ET — so a session that closed at 16:00 ET has NO bar in `candles` for
 * roughly nine and a half hours, and the EOD fallback would rewind the price by
 * a day."
 *
 * THAT JUSTIFICATION DESCRIBES A CASE THE SECOND OUTCOME ALREADY HANDLES. The
 * EOD leg reads a THIRTY-DAY window, so during that nine-and-a-half-hour gap the
 * previous sessions' bars are all present, `latest` is defined, and the second
 * outcome fires. The fourth was reachable only when the window returned ZERO
 * bars — i.e. we hold no history for the symbol at all, which is the opposite of
 * the scenario it was written for and, in practice, is the EOD fan-out cap
 * (see `US_EOD_FALLBACK_MAX_SYMBOLS`) rather than a market condition.
 *
 * It is what made a symbol past that cap render a REAL price beside a
 * FABRICATED 0.00% change and a zero volume the feed never sent — and, before
 * the `isLiveQuoteProvenance` fix below, under a green "Live quote" badge,
 * because the disclaimer read `source` and never `fallback`.
 *
 * ## Why `fallback` and not a freshness number
 *
 * `SectionProvenance.fallback` already means "not the preferred provider" on
 * every other data-engine surface in this app, and the chip that renders it is
 * already built. An EOD close standing in for a realtime quote is exactly that
 * relationship, so it reuses the existing vocabulary rather than inventing a
 * second one the reader has to learn.
 */

import { TIINGO_US_EXCHANGES } from "./tiingo-logic";
import { DEFAULT_EPHEMERAL_TTL_MS } from "./tiingo-rt-subscription-logic";
import type { RtQuotePayload } from "./tiingo-rt-keys";
import type { CandleBar } from "../candles/candle-logic";

/* ─── Which venues are American ──────────────────────────────────────────── */

/**
 * US venue names, exactly as `UsInstrument.exchange` and `Candle.exchange`
 * spell them.
 *
 * A TYPE-LEVEL MIRROR of {@link TIINGO_US_EXCHANGES}, which stays the single
 * runtime list — `marketForExchange` already carries the note about what a
 * second spelling of "which venues are American" cost the sector taxonomy
 * (MONEY-1093). A `ReadonlySet<string>` cannot produce a literal union, so the
 * union is written out here and PINNED against the set by
 * `us-quote-read-logic.test.ts`: adding a venue to one and not the other fails
 * the suite instead of silently narrowing a type nothing checks at runtime.
 */
export type UsExchange =
  | "NASDAQ"
  | "NYSE"
  | "AMEX"
  | "NYSE ARCA"
  | "NYSE MKT"
  | "NYSE NAT"
  | "BATS"
  | "NMFQS";

/** The mirror, as data, so a test can compare it against the runtime set. */
export const US_EXCHANGE_NAMES: readonly UsExchange[] = [
  "NASDAQ",
  "NYSE",
  "AMEX",
  "NYSE ARCA",
  "NYSE MKT",
  "NYSE NAT",
  "BATS",
  "NMFQS",
];

/**
 * Is this venue name American?
 *
 * Delegates to the runtime set rather than to {@link US_EXCHANGE_NAMES} on
 * purpose: the set is the source of truth, the union is the mirror, and a guard
 * that read the mirror would agree with itself even when the two have drifted.
 */
export function isUsExchange(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return TIINGO_US_EXCHANGES.has(value.trim().toUpperCase());
}

/** Canonical spelling of a US venue, or `null` when it is not one of ours. */
export function normalizeUsExchange(
  value: string | null | undefined,
): UsExchange | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return TIINGO_US_EXCHANGES.has(upper) ? (upper as UsExchange) : null;
}

/* ─── Freshness ──────────────────────────────────────────────────────────── */

/**
 * How old a stored realtime quote may be and still be called LIVE.
 *
 * Fifteen minutes, chosen against the thing it is competing with rather than
 * against a feeling: an exchange-delayed feed (what every India surface in this
 * app renders, with the `DelayedDataNote` disclaimer) is delayed by ~15 minutes.
 * A realtime quote older than that carries no advantage over the delayed
 * product, so calling it "live" would be a claim with nothing behind it.
 *
 * It is deliberately NOT tight (30s, say). The consolidated feed publishes on
 * QUOTE CHANGE, and a thin name legitimately goes minutes without one; a tight
 * window would make such a symbol flap between LIVE and FALLBACK on consecutive
 * polls, which reads as a broken page rather than as a quiet order book. Fifteen
 * minutes of silence during a session is the socket holder being down, not the
 * market being calm.
 */
export const RT_QUOTE_MAX_AGE_MS = 15 * 60_000;

/**
 * The SAME decision, spelled for a Redis `EX` — MONEY-1309 follow-up.
 *
 * The writer (`workers/src/realtime/main.ts`) sets `rt:us:quote:<SYMBOL>` with a
 * TTL, and that TTL is a freshness threshold whether or not anyone calls it one:
 * a key that has expired is indistinguishable from a symbol the feed never
 * quoted, so the READER's 15-minute window can only ever judge quotes the WRITER
 * has already decided to keep. The two shipped as two independent numbers —
 * `EX 90` against a 15-minute window — which made the binding threshold 90
 * SECONDS, ten times tighter than the window above, and produced exactly the
 * LIVE/FALLBACK flapping on thin names that the window was chosen to avoid.
 * Fifteen minutes of reasoning was written down and then overridden by a
 * constant in another file.
 *
 * So there is ONE free number here — {@link RT_QUOTE_MAX_AGE_MS} — and this is
 * derived from it. The `+ 60` is a GRACE, not a second decision: it keeps the
 * reader's explicit, documented check the binding one rather than Redis's clock.
 * With an exactly-equal TTL the key and the quote's liveness expire in the same
 * instant, so whichever of the two clocks runs slightly ahead silently becomes
 * the arbiter, and `isRtQuoteFresh` could never observe a stale-but-present
 * quote at all.
 *
 * The invariant, stated so it can be tested rather than remembered:
 *
 *   RT_QUOTE_TTL_SECONDS * 1000  >=  RT_QUOTE_MAX_AGE_MS
 *
 * Break it in the other direction and the freshness check becomes dead code.
 */
export const RT_QUOTE_TTL_SECONDS = RT_QUOTE_MAX_AGE_MS / 1_000 + 60;

/**
 * How long one page view keeps a symbol in the ephemeral subscription set.
 *
 * A SLIDING window: every view re-scores the member to `now + TTL`, so an open
 * tab that keeps polling keeps its subscription alive, and a closed one ages out
 * without anything having to notice it closed.
 *
 * NOT A SECOND NUMBER. This used to declare its own `10 * 60_000` while the
 * PLANNER that acts on the set — `planSubscriptions`, which decides who is
 * evicted when the ceiling is reached — used `DEFAULT_EPHEMERAL_TTL_MS`
 * (15 minutes). Two spellings of one TTL on opposite sides of the same sorted
 * set: the writer scores a member to expire at +10m and the planner reasons
 * about it as if it expired at +15m, so eviction order is computed from a
 * deadline nothing honours. The planner owns the value; this is an alias so the
 * read path cannot drift from it again.
 */
export const RT_EPHEMERAL_TTL_MS = DEFAULT_EPHEMERAL_TTL_MS;

/** Score for one ephemeral member: the epoch ms at which it expires. */
export function ephemeralExpiryScore(
  nowMs: number,
  ttlMs: number = RT_EPHEMERAL_TTL_MS,
): number {
  return nowMs + ttlMs;
}

/**
 * The largest epoch-ms a `Date` can represent — ±100,000,000 days from the
 * epoch, per ECMA-262 (`Number.MAX_SAFE_INTEGER` is far outside it).
 */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Can this number become a `Date` we can serialise?
 *
 * `Number.isFinite` is NOT enough, and the gap is a real throw: `1e20` is finite,
 * `new Date(1e20)` is an Invalid Date, and `.toISOString()` on it raises
 * `RangeError: Invalid time value`. `decideUsQuote` documents "never throws" and
 * calls `toISOString()` on `rt.ts` — a value that arrives as JSON off a Redis
 * key written by another process, i.e. exactly the kind of input a purity claim
 * has to survive rather than assume.
 */
export function isRepresentableInstant(ms: unknown): ms is number {
  return (
    typeof ms === "number" &&
    Number.isFinite(ms) &&
    Math.abs(ms) <= MAX_TIME_VALUE
  );
}

/**
 * Is a stored quote young enough to be presented as live?
 *
 * A quote timestamped in the FUTURE counts as fresh — the same clock-skew
 * convention `isEnvelopeFresh` uses in the web quote cache. Two processes on two
 * Cloud Run instances will disagree by milliseconds, and treating that as
 * staleness would blank the newest quotes rather than the oldest.
 */
export function isRtQuoteFresh(
  quote: Pick<RtQuotePayload, "ts">,
  nowMs: number,
  maxAgeMs: number = RT_QUOTE_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(quote.ts)) return false;
  return nowMs - quote.ts < maxAgeMs;
}

/* ─── Shapes ─────────────────────────────────────────────────────────────── */

/** Which of our own two stores answered. Never a vendor round trip. */
export type UsQuoteSource = "TIINGO_RT" | "TIINGO";

/**
 * Where one quote came from and how old it is.
 *
 * Structurally compatible with `SectionProvenance` in
 * `apps/web/components/stock/SectionShell.tsx`, so the chip that already renders
 * provenance for nineteen data-engine sections renders this one too.
 */
export interface UsQuoteProvenance {
  source: UsQuoteSource;
  /** ISO timestamp of what the NUMBER describes, not of the response. */
  asOf: string;
  /** True when this is not the preferred provider — i.e. not a live quote. */
  fallback: boolean;
  /**
   * Which US session the quote was taken in.
   *
   * Rides along because the consolidated feed's day is 04:00-20:00 ET: a price
   * can be a genuine pre- or post-market print, and a surface that renders it as
   * a regular-hours price is wrong in a way the number itself cannot reveal.
   */
  session?: RtQuotePayload["session"];
  note?: string;
}

/**
 * One resolved US quote.
 *
 * Field-for-field assignable to the web app's `QuoteData` (plus `provenance`),
 * so it flows through the existing quote provider chain, the existing response
 * shapers and the existing hook without a translation layer. Core does not
 * import the web type — that would invert the dependency — so the compatibility
 * is structural and is pinned by `us-quote-read-logic.test.ts`.
 */
export interface UsQuote {
  symbol: string;
  exchange: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  timestamp: Date;
  provenance: UsQuoteProvenance;
}

/* ─── May this be presented as LIVE? ─────────────────────────────────────── */

/**
 * The ONE answer to "may this quote be rendered as a live price?" — MONEY-1309
 * follow-up.
 *
 * It reads BOTH fields, and that is the entire point. Liveness is a property of
 * the PAIR (`source`, `fallback`), never of the source alone: the read path can
 * emit `TIINGO_RT` with `fallback:true`, and a consumer that branches on the
 * source only will call that combination live.
 *
 * That is not hypothetical — it shipped. `DelayedDataNote` in apps/web asked
 * `isLiveQuoteSource(source)` and never looked at `fallback`, so a fallback
 * quote rendered a green `Live quote · 05:30 am` badge WITH THE COMPLIANCE
 * DISCLAIMER REPLACED BY IT, on the same page where the provenance chip was
 * correctly showing an amber `fallback` pill. Two consumers of one fact; one
 * checked both fields, one checked half.
 *
 * So the rule lives HERE, next to the type that names the sources, and every
 * consumer imports it rather than re-deriving it:
 *
 *   - {@link batchQuoteSource}                  the envelope label
 *   - apps/api  `/v1/market/us/quotes`          per-quote `delayed`
 *   - apps/web  `quote-logic.isLiveQuote`       the response envelope AND the
 *                                               `DelayedDataNote` disclaimer
 *
 * Fail-closed on every unknown: no provenance, an unrecognised source, a
 * missing `fallback`. A new upstream must opt IN to being called live.
 *
 * NOTE the parameter is deliberately loose (`string`/`boolean` rather than
 * {@link UsQuoteSource}/`boolean`). Two of the three callers receive this object
 * across a package or a network boundary — apps/api reads a `UsQuote` shaped by
 * a different deploy of this package, apps/web reads JSON off the wire — so the
 * value arriving is whatever was serialised, not whatever the type says. A signature
 * that only accepted the narrow type would push a cast to each call site, and a
 * cast is how an unchecked value gets in.
 */
export function isLiveQuoteProvenance(
  provenance:
    | { source?: string | null; fallback?: boolean | null }
    | null
    | undefined,
): boolean {
  if (!provenance) return false;
  if (provenance.fallback === true) return false;
  return provenance.source === "TIINGO_RT";
}

/* ─── Decision ───────────────────────────────────────────────────────────── */

/** The tradeable number a realtime payload carries, or null if it carries none. */
export function rtQuotePrice(quote: RtQuotePayload): number | null {
  // `last` is the feed's own mid (the consolidated feed publishes no trade
  // price — see the note on `RtQuotePayload.last`). When it is absent we can
  // still recompute the mid ourselves, which is the same quantity from the same
  // two numbers rather than a different, weaker one.
  if (typeof quote.last === "number" && Number.isFinite(quote.last)) {
    return quote.last;
  }
  const { bid, ask } = quote;
  if (
    typeof bid === "number" &&
    Number.isFinite(bid) &&
    typeof ask === "number" &&
    Number.isFinite(ask)
  ) {
    return (bid + ask) / 2;
  }
  return null;
}

/** Percentage change, guarded against the zero-previous-close divide. */
export function percentChange(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) return 0;
  const pct = ((current - previous) / previous) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

/**
 * Resolve ONE symbol from what the two stores returned.
 *
 * `bars` must be ASCENDING by `ts` (the repository's contract), so the last
 * element is the most recent session and the one before it supplies
 * `previousClose`. A single bar yields `previousClose = close`, i.e. a flat
 * change — deliberately not a fabricated delta against nothing.
 *
 * Returns `null` when neither store could answer. That symbol is then simply
 * absent from the payload, which is the fail-open contract `/api/market/quote`
 * has always had.
 */
export function decideUsQuote(args: {
  symbol: string;
  exchange: string;
  name?: string;
  rt: RtQuotePayload | null;
  bars: readonly CandleBar[];
  nowMs: number;
  maxAgeMs?: number;
}): UsQuote | null {
  const { symbol, exchange, rt, bars, nowMs } = args;
  const maxAgeMs = args.maxAgeMs ?? RT_QUOTE_MAX_AGE_MS;
  const name = args.name ?? symbol;

  const latest = bars.length > 0 ? bars[bars.length - 1] : undefined;
  const prior = bars.length > 1 ? bars[bars.length - 2] : undefined;

  const rtPrice = rt ? rtQuotePrice(rt) : null;
  // A `ts` we cannot turn into a Date is an unusable payload, not a stale one —
  // `provenance.asOf` is built with `toISOString()` and would throw. See
  // {@link isRepresentableInstant}.
  const rtUsable =
    rt !== null && rtPrice !== null && isRepresentableInstant(rt.ts);
  const rtFresh = rtUsable && isRtQuoteFresh(rt, nowMs, maxAgeMs);

  // 1. A live quote — and ONLY when the session bar is there to anchor it.
  //
  //    The bar supplies two different things and both are load-bearing. The
  //    OHLC, because a quote is a point and stamping the day's open/high/low
  //    with the quote price invents four numbers the feed never sent. And the
  //    PREVIOUS CLOSE, which is the only thing `change` can be measured
  //    against — the consolidated feed publishes a bid/ask, not a session.
  //
  //    This used to be `latest?.open ?? rtPrice` / `priorClose ?? rtPrice`,
  //    i.e. it fell back to the quote price for every one of them. With no
  //    bars that yields `change: 0`, `changePercent: 0`, `volume: 0` and
  //    `open === high === low === price`, stamped `fallback: false` — a
  //    fabricated flat session, badged LIVE. It was reachable on every symbol
  //    past `US_EOD_FALLBACK_MAX_SYMBOLS`, which is 8 of a 20-symbol US
  //    watchlist, because the caller ASKS for a quote for every symbol and
  //    only READS bars for the first twelve.
  //
  //    The SELECTION of `previousClose` among the bars is deliberately
  //    unchanged (`prior` when there are two, else `latest`). Which session
  //    `latest` represents during RTH is a separate, real question — `us-eod-
  //    sync` runs 11:00 IST, so mid-session the newest bar is usually the
  //    PREVIOUS session rather than the one being quoted — and answering it
  //    means aligning bars to the ET session date, which is a different change
  //    from this one. Reported, not folded in.
  if (rtFresh && rt !== null && rtPrice !== null && latest) {
    const previousClose = prior?.close ?? latest.close;
    return {
      symbol,
      exchange,
      name,
      price: rtPrice,
      change: rtPrice - previousClose,
      changePercent: percentChange(rtPrice, previousClose),
      open: latest.open,
      high: latest.high,
      low: latest.low,
      previousClose,
      volume: latest.volume,
      timestamp: new Date(rt.ts),
      provenance: {
        source: "TIINGO_RT",
        asOf: new Date(rt.ts).toISOString(),
        fallback: false,
        session: rt.session,
      },
    };
  }

  // 2. The EOD close. `previousClose` is the session BEFORE the one we are
  //    quoting, so `change` is that session's move — not the move since the
  //    quote, which is a different question and would read as a live delta.
  if (latest) {
    const previousClose = prior?.close ?? latest.close;
    return {
      symbol,
      exchange,
      name,
      price: latest.close,
      change: latest.close - previousClose,
      changePercent: percentChange(latest.close, previousClose),
      open: latest.open,
      high: latest.high,
      low: latest.low,
      previousClose,
      volume: latest.volume,
      timestamp: latest.ts,
      provenance: {
        source: "TIINGO",
        asOf: latest.ts.toISOString(),
        fallback: true,
        note: "End-of-day close — no live quote for this symbol",
      },
    };
  }

  // 3. No session bar. Fail-open: the symbol is absent, not an error.
  //
  //    This is where a usable-but-unanchored realtime quote now lands, and the
  //    module note above records why the branch that used to serve it is gone:
  //    its stated justification (the post-close gap before `us-eod-sync` runs)
  //    is a case branch 2 handles, because the EOD leg reads a THIRTY-DAY
  //    window. What actually reached it was "we hold no bar for this symbol",
  //    and the only honest fields in that state are `price` and `timestamp`.
  //
  //    `rtUsable` stays computed above because {@link isRtQuoteFresh} needs it;
  //    it no longer selects an outcome.
  return null;
}

/**
 * The coarse, envelope-level label for a whole batch.
 *
 * Per-quote `provenance` is the truth; this exists because the response envelope
 * and the provider chain both carry ONE `source` for the request. It is
 * deliberately pessimistic: a batch is only called live when EVERY quote in it
 * is live, because a single fallback quote rendered under a "live" banner is the
 * exact mislabelling this whole module exists to prevent. An EMPTY batch is not
 * live either — nothing resolved, so there is nothing to be live about.
 */
export function batchQuoteSource(
  quotes: readonly {
    provenance?: { source?: string | null; fallback?: boolean | null };
  }[],
): UsQuoteSource {
  if (quotes.length === 0) return "TIINGO";
  // The per-quote rule is {@link isLiveQuoteProvenance}, not a second copy of
  // it. This function used to inline `!prov || prov.fallback === true ||
  // prov.source !== "TIINGO_RT"` — the correct condition, written out a second
  // time. `DelayedDataNote` wrote it a THIRD time and dropped the `fallback`
  // operand, which is the defect that made this consolidation necessary.
  for (const quote of quotes) {
    if (!isLiveQuoteProvenance(quote.provenance)) return "TIINGO";
  }
  return "TIINGO_RT";
}
