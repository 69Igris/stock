/**
 * What a decoded tick becomes — PURE.
 *
 * Three destinations, three different reasons, and they must not be conflated:
 *
 *   QUOTE HASH   the latest price, overwritten. Read by the web path. Losing one
 *                update costs a second of staleness.
 *   MINUTE BARS  history, appended. Losing one loses a minute forever.
 *   RAW JSONL    the bytes as they arrived. The only artefact that can settle an
 *                argument about what the feed actually said.
 *
 * The middle one is the reason `mayWrite` is consulted on the write path and not
 * only on a timer: a quote that is a second stale is invisible, a duplicated bar
 * is permanent.
 */

import type { TiingoRtQuote } from "./tiingo-realtime-logic";
import type { RtQuotePayload } from "./tiingo-rt-keys";
import type { RtTick } from "./tiingo-minute-bars";
import { usMarketDateKey } from "../us-market-hours";

/** How the payload names its own provenance. Never inferred by a reader. */
export const RT_SOURCE = "TIINGO_RT";

/**
 * The candle `source` for realtime-derived bars.
 *
 * NOT `TIINGO`, which is the EOD backbone's stamp. These bars are built from
 * quote MIDS with no volume, and the EOD bars are trade-derived with real
 * volume; one series carrying both would put a structural zero beside a real
 * number. The distinct stamp is what lets the mixed-source guard tell them
 * apart, and what lets a reader know which it is looking at.
 *
 * Also not `TIINGO_IEX`: the feed is the consolidated 24x5 venue, not IEX, and
 * a provenance stamp naming the wrong venue is worse than a vague one.
 */
export const RT_CANDLE_SOURCE = "TIINGO_RT";

export type RtSession = "pre" | "rth" | "post" | "closed";

/**
 * Decoded frame to the value stored in the quote hash.
 *
 * `last` is the MID. The feed publishes no trade price — 118 of 118 captured
 * frames are top-of-book — so calling the mid "last" is the closest honest
 * mapping available, and the field is documented as such everywhere it appears.
 * Inventing a trade price from a quote would be the one thing worse than not
 * having one.
 */
export function toQuotePayload(
  quote: TiingoRtQuote,
  session: RtSession,
): RtQuotePayload {
  return {
    symbol: quote.ticker.trim().toUpperCase(),
    bid: quote.bid,
    ask: quote.ask,
    last: quote.mid,
    bidSize: quote.bidSize,
    askSize: quote.askSize,
    ts: quote.ts.getTime(),
    src: RT_SOURCE,
    session,
  };
}

/** Decoded frame to the aggregator's input. */
export function toAggregatorTick(quote: TiingoRtQuote): RtTick {
  return {
    symbol: quote.ticker.trim().toUpperCase(),
    tsMs: quote.ts.getTime(),
    mid: quote.mid,
  };
}

export interface RtCandleRow {
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

/**
 * A closed minute bar to a `CandleWriteRow`.
 *
 * `volume: 0` MEANS "this feed does not report volume", not "nothing traded".
 * That is a real distinction and it is why these rows carry their own source
 * stamp: a reader that mixes them with EOD bars would chart a structural zero
 * as a quiet session. `Candle.volume` is required, so 0 is the only
 * representable answer — the honesty has to live in the source column and in
 * the guard that keeps the two apart.
 *
 * Returns `null` when the listing is unknown. A bar written under a guessed
 * `listingId` is worse than a missing bar: `listingId` is the field that stops
 * two companies that shared a ticker becoming one series, and a wrong one is
 * indistinguishable from a right one afterwards.
 */
export function toCandleRow(args: {
  symbol: string;
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  listingId: string | null;
  exchange: string | null;
  timeframe?: string;
}): RtCandleRow | null {
  if (!args.listingId || !args.exchange) return null;
  return {
    symbol: args.symbol,
    exchange: args.exchange,
    timeframe: args.timeframe ?? "M1",
    ts: new Date(args.tsMs),
    listingId: args.listingId,
    open: args.open,
    high: args.high,
    low: args.low,
    close: args.close,
    volume: 0,
    source: RT_CANDLE_SOURCE,
  };
}

/**
 * One raw frame as a JSONL line for the archive.
 *
 * SELF-DESCRIBING, the same rule `serializeColdShard` follows: an archived
 * object that cannot be identified from its own bytes is an unidentifiable
 * blob. `gunzip | head -1` must say what feed this is, which symbol, and when —
 * without reference to the key it happens to be stored under.
 */
export function toArchiveLine(args: {
  receivedAtMs: number;
  raw: string;
}): string {
  return JSON.stringify({
    f: "tiingo-equity-intraday",
    r: args.receivedAtMs,
    d: args.raw,
  });
}

/**
 * The key the mixed-source rule is stated over: `(symbol, timeframe, US ET
 * SESSION DATE)`.
 *
 * Exported so every writer that has to ask "who owns this day?" builds the
 * byte-identical string. Two writers spelling one key two ways is the same
 * defect class as two writers deciding precedence locally — see
 * `price-source-authority.ts`, which exists because that happened.
 *
 * NUL separator written as the ESCAPE, never as a raw byte — the house
 * convention (`candle-logic.ts` keys its shards the same way) because a symbol
 * may contain a dash or a dot and a printable separator eventually collides. A
 * raw 0x00 in source is invisible in a diff and a review; the repo's hygiene
 * tripwire has caught two in this branch alone.
 */
export function sessionKey(
  symbol: string,
  timeframe: string,
  dateKey: string,
): string {
  return `${symbol}\u0000${timeframe}\u0000${dateKey}`;
}

/**
 * Group closed bars by the symbol-SESSION they belong to.
 *
 * The mixed-source guard is stated per `(symbol, timeframe, US ET session
 * date)`, so the writer needs the same grouping to ask the question once per
 * group instead of once per row.
 *
 * ## Why the ET session date and NOT the UTC calendar day — MONEY-1373
 *
 * The key was `ts.toISOString().slice(0, 10)` and that SPILLS. The US feed day
 * runs 04:00-20:00 ET; under EST (UTC-5) the post-market hours 19:00-19:59 ET
 * fall on UTC day D+1 — which is ALSO the UTC day of the NEXT session's 04:00
 * ET pre-market. So one UTC key spanned the tail of session D and the head of
 * session D+1, and whichever writer landed there first locked the other out of
 * the whole key: the trade-derived append refused for ALL of session D+1, or
 * the realtime sink refused session D's last hour forever. Both refusals are
 * silent and both look correct from the side that won.
 *
 * One ET session, one key, no spill. Do not "simplify" this back to
 * `toISOString()`.
 */
export function groupBySymbolDay(
  rows: readonly RtCandleRow[],
): Map<string, RtCandleRow[]> {
  const out = new Map<string, RtCandleRow[]>();
  for (const r of rows) {
    const key = sessionKey(r.symbol, r.timeframe, usMarketDateKey(r.ts));
    const bucket = out.get(key);
    if (bucket) bucket.push(r);
    else out.set(key, [r]);
  }
  return out;
}

/**
 * May these rows be written into a day that already holds `existingSource`?
 *
 * THE MIXED-SOURCE RULE. A symbol-day must hold bars from ONE source. The two
 * producers here are not comparable measurements: EOD bars are trade-derived
 * with real volume, realtime bars are quote-mid-derived with a structural zero.
 * Interleaving them yields a series whose volume column is meaningless in a way
 * no reader can detect, and whose OHLC silently changes definition partway
 * through a day.
 *
 * Deliberately GENERIC — it compares whatever source is already there against
 * whatever is arriving, and names neither. The prompt framed this as "never
 * writable into any series Databento owns"; Databento does not appear anywhere
 * in this repo, so hard-coding that name would encode a vendor we do not have
 * and miss the collision we do (TIINGO vs TIINGO_RT). Naming the rule after the
 * property rather than the vendor is what makes it correct for both.
 */
export function mayWriteIntoDay(
  incomingSource: string,
  existingSource: string | null,
): { allowed: boolean; reason: string } {
  if (existingSource === null) return { allowed: true, reason: "day is empty" };
  if (existingSource === incomingSource)
    return { allowed: true, reason: "same source" };
  return {
    allowed: false,
    reason:
      `symbol-day already holds ${existingSource}; refusing ${incomingSource}. ` +
      "A day must hold one source: these producers measure different things " +
      "(trade-derived with volume vs quote-mid-derived without), and mixing " +
      "them makes the volume column meaningless with nothing to reveal it.",
  };
}
