/**
 * The tick sink's decisions.
 *
 * The one that matters most is the MIXED-SOURCE rule: two producers that both
 * write `Candle` rows are not measuring the same thing, and interleaving them
 * inside one symbol-day produces a series nothing downstream can detect as
 * wrong.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  toQuotePayload,
  toAggregatorTick,
  toCandleRow,
  toArchiveLine,
  groupBySymbolDay,
  sessionKey,
  mayWriteIntoDay,
  RT_SOURCE,
  RT_CANDLE_SOURCE,
} from "../../src/market-data/tiingo/tiingo-rt-sink-logic";
import type { TiingoRtQuote } from "../../src/market-data/tiingo/tiingo-realtime-logic";

const TS = new Date("2026-08-31T17:58:11.030Z");
const quote = (over: Partial<TiingoRtQuote> = {}): TiingoRtQuote => ({
  ticker: "aapl",
  ts: TS,
  bid: 314.975,
  ask: 314.985,
  mid: 314.98,
  bidSize: 60,
  askSize: 140,
  spread: 0.000032,
  service: "cons",
  ...over,
});

describe("PREMISE: the source stamps are distinct and named", () => {
  it("realtime bars do NOT claim the EOD backbone's stamp", () => {
    // Sharing `TIINGO` would make the mixed-source guard unable to tell the two
    // producers apart, which is the whole thing it exists to do.
    assert.equal(RT_CANDLE_SOURCE, "TIINGO_RT");
    assert.notEqual(RT_CANDLE_SOURCE, "TIINGO");
    assert.equal(RT_SOURCE, "TIINGO_RT");
    // And not IEX: the feed is the consolidated 24x5 venue. A provenance stamp
    // naming the wrong venue is worse than a vague one.
    assert.equal(RT_CANDLE_SOURCE.includes("IEX"), false);
  });
});

describe("quote payload", () => {
  it("upper-cases the symbol the feed sends lower", () => {
    assert.equal(toQuotePayload(quote(), "rth").symbol, "AAPL");
  });

  it("maps the MID to `last`, because the feed publishes no trade price", () => {
    // 118 of 118 captured frames are top-of-book. Inventing a trade price from
    // a quote would be the one thing worse than not having one.
    const p = toQuotePayload(quote(), "rth");
    assert.equal(p.last, 314.98);
    assert.equal(p.bid, 314.975);
    assert.equal(p.ask, 314.985);
  });

  it("carries the session, so a pre-market print is not shown as regular hours", () => {
    assert.equal(toQuotePayload(quote(), "pre").session, "pre");
    assert.equal(toQuotePayload(quote(), "post").session, "post");
  });

  it("names its own provenance rather than leaving a reader to infer it", () => {
    assert.equal(toQuotePayload(quote(), "rth").src, "TIINGO_RT");
  });

  it("passes nulls through instead of substituting zero", () => {
    // A zero bid is a PRICE. A missing bid is an absence. Collapsing them puts
    // a tradeable-looking 0 in front of a user.
    const p = toQuotePayload(quote({ bid: null, ask: null, mid: null }), "rth");
    assert.equal(p.bid, null);
    assert.equal(p.ask, null);
    assert.equal(p.last, null);
  });
});

describe("candle rows", () => {
  const bar = {
    symbol: "AAPL",
    tsMs: TS.getTime(),
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
  };

  it("stamps M1 and the realtime source", () => {
    const row = toCandleRow({
      ...bar,
      listingId: "AAPL:NASDAQ:1980-12-12",
      exchange: "NASDAQ",
    });
    assert.ok(row);
    assert.equal(
      row!.timeframe,
      "M1",
      "the schema's reserved vocabulary, not '1m'",
    );
    assert.equal(row!.source, "TIINGO_RT");
  });

  it("writes volume 0, which MEANS 'this feed does not report volume'", () => {
    // `Candle.volume` is required, so 0 is the only representable answer. The
    // honesty lives in the source stamp and in the guard that keeps these rows
    // away from trade-derived ones.
    const row = toCandleRow({
      ...bar,
      listingId: "AAPL:NASDAQ:1980-12-12",
      exchange: "NASDAQ",
    });
    assert.equal(row!.volume, 0);
  });

  it("REFUSES to build a row without a listingId", () => {
    // `listingId` is what stops two companies that shared a ticker becoming one
    // series. A guessed one is indistinguishable from a correct one afterwards,
    // so a missing bar is strictly better than a mis-keyed one.
    assert.equal(
      toCandleRow({ ...bar, listingId: null, exchange: "NASDAQ" }),
      null,
    );
    assert.equal(
      toCandleRow({ ...bar, listingId: "", exchange: "NASDAQ" }),
      null,
    );
    assert.equal(
      toCandleRow({ ...bar, listingId: "X:Y:Z", exchange: null }),
      null,
    );
  });
});

describe("THE MIXED-SOURCE RULE", () => {
  it("allows an empty day", () => {
    assert.equal(mayWriteIntoDay("TIINGO_RT", null).allowed, true);
  });

  it("allows the same source to keep writing its own day", () => {
    assert.equal(mayWriteIntoDay("TIINGO_RT", "TIINGO_RT").allowed, true);
  });

  it("REFUSES realtime bars into a day the EOD backbone already wrote", () => {
    // The real collision in this repo: trade-derived bars with volume, against
    // quote-mid-derived bars with a structural zero. Interleaved, the volume
    // column becomes meaningless and nothing downstream can tell.
    const v = mayWriteIntoDay("TIINGO_RT", "TIINGO");
    assert.equal(v.allowed, false);
    assert.match(v.reason, /already holds TIINGO/);
  });

  it("refuses in BOTH directions — it is a property, not a ranking", () => {
    assert.equal(mayWriteIntoDay("TIINGO", "TIINGO_RT").allowed, false);
  });

  it("is GENERIC — it names no vendor", () => {
    // The brief said "never writable into any series Databento owns". Databento
    // appears nowhere in this repo, so hard-coding that name would encode a
    // vendor we do not have while missing the collision we do. Naming the rule
    // after the property covers both.
    const v = mayWriteIntoDay("ANY_NEW_FEED", "SOME_OTHER_FEED");
    assert.equal(v.allowed, false);
    assert.equal(/databento/i.test(v.reason), false);
  });
});

describe("grouping is keyed on the ET SESSION DATE — MONEY-1373", () => {
  /**
   * THE DEFECT, stated once so the cases below read as consequences.
   *
   * The key was `ts.toISOString().slice(0, 10)` — the UTC calendar day. The US
   * feed day runs 04:00-20:00 ET, so under EST (UTC-5) the post-market hours
   * 19:00-19:59 ET fall on UTC day D+1, which is ALSO the UTC day of the NEXT
   * session's 04:00 ET pre-market. One UTC key therefore spanned the TAIL of
   * session D and the HEAD of session D+1, and the mixed-source guard is stated
   * PER KEY: whichever writer landed there first locked the other out of the
   * whole thing. Trade-derived bars refused for all of session D+1, or
   * quote-derived bars refused for session D's last hour — forever, silently,
   * and correct-looking from whichever side won.
   *
   * The instants below are written as UTC literals ON PURPOSE, with the ET wall
   * clock in the comment. Stating them in ET and converting with the module's
   * own zone math would let a bug there cancel out against itself.
   */
  const mk = (symbol: string, iso: string) => ({
    symbol,
    exchange: "NASDAQ",
    timeframe: "M1",
    ts: new Date(iso),
    listingId: "x",
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 0,
    source: "TIINGO_RT",
  });

  /** Built from the escape, never pasted — the test must not smuggle a raw byte. */
  const SEP = "\u0000";
  const key = (symbol: string, day: string) => `${symbol}${SEP}M1${SEP}${day}`;

  it("REGRESSION: 19:30 ET and 09:35 ET on the same EST session are ONE key", () => {
    // 2026-01-15 is a Thursday in EST. 19:30 ET is 00:30Z on 2026-01-16 — a
    // DIFFERENT UTC day from the 09:35 ET bar, and the SAME session.
    const g = groupBySymbolDay([
      mk("AAPL", "2026-01-15T14:35:00Z"), // 09:35 ET, rth
      mk("AAPL", "2026-01-16T00:30:00Z"), // 19:30 ET, post — spills to UTC D+1
    ]);
    assert.equal(g.size, 1, "one ET session, one key");
    assert.equal(g.get(key("AAPL", "2026-01-15"))?.length, 2);
  });

  it("REGRESSION: the next session's 04:05 ET pre-market is a DIFFERENT key", () => {
    // 04:05 ET on 2026-01-16 is 09:05Z on 2026-01-16 — the SAME UTC day as the
    // 19:30 ET spill above, and a different session. MEMBERSHIP is asserted, not
    // just the count: under the old UTC key the count is also 2, with the two
    // buckets holding the wrong bars. A size-only assertion would stay green.
    const g = groupBySymbolDay([
      mk("AAPL", "2026-01-15T14:35:00Z"), // 09:35 ET, session 01-15
      mk("AAPL", "2026-01-16T00:30:00Z"), // 19:30 ET, session 01-15
      mk("AAPL", "2026-01-16T09:05:00Z"), // 04:05 ET, session 01-16
    ]);
    assert.equal(g.size, 2);
    assert.deepEqual(
      g.get(key("AAPL", "2026-01-15"))?.map((r) => r.ts.toISOString()),
      ["2026-01-15T14:35:00.000Z", "2026-01-16T00:30:00.000Z"],
      "the post-market spill belongs to the session it was quoted in",
    );
    assert.deepEqual(
      g.get(key("AAPL", "2026-01-16"))?.map((r) => r.ts.toISOString()),
      ["2026-01-16T09:05:00.000Z"],
      "the next session's pre-market must not join it",
    );
  });

  it("splits the session at ET midnight, not at UTC midnight", () => {
    // 23:59 ET and 00:01 ET either side of ET midnight are the SAME UTC day
    // under EST — the mirror image of the case above, and the one a UTC key
    // gets wrong in the other direction.
    const g = groupBySymbolDay([
      mk("AAPL", "2026-01-16T04:59:00Z"), // 23:59 ET on 01-15
      mk("AAPL", "2026-01-16T05:01:00Z"), // 00:01 ET on 01-16
    ]);
    assert.equal(g.size, 2);
    assert.ok(g.has(key("AAPL", "2026-01-15")));
    assert.ok(g.has(key("AAPL", "2026-01-16")));
  });

  it("separates symbols and timeframes as well as sessions", () => {
    const g = groupBySymbolDay([
      mk("AAPL", "2026-08-31T14:00:00Z"), // 10:00 ET (EDT)
      mk("AAPL", "2026-08-31T18:00:00Z"), // 14:00 ET, same session
      mk("AAPL", "2026-09-01T14:00:00Z"), // next session
      mk("MSFT", "2026-08-31T14:00:00Z"),
      { ...mk("AAPL", "2026-08-31T14:00:00Z"), timeframe: "M5" },
    ]);
    assert.equal(g.size, 4);
    assert.equal(g.get(key("AAPL", "2026-08-31"))?.length, 2);
    assert.equal(g.get(`AAPL${SEP}M5${SEP}2026-08-31`)?.length, 1);
  });

  it("sessionKey builds the byte-identical key the grouping uses", () => {
    // Both writers have to spell one key one way. Two writers each inventing a
    // key format is the same defect class as two writers each deciding
    // precedence — see price-source-authority.ts, which exists because of it.
    const g = groupBySymbolDay([mk("AAPL", "2026-01-15T14:35:00Z")]);
    assert.deepEqual([...g.keys()], [sessionKey("AAPL", "M1", "2026-01-15")]);
  });

  it("the separator is a NUL, and the SOURCE spells it as an escape", () => {
    // A raw 0x00 in source is invisible in a diff and in a review; the repo has
    // a tripwire for it. The KEY must contain one and the FILE must not.
    assert.ok(sessionKey("A", "M1", "2026-01-15").includes(SEP));
    assert.equal(sessionKey("A", "M1", "2026-01-15").split(SEP).length, 3);
    const src = readFileSync(
      new URL(
        "../../src/market-data/tiingo/tiingo-rt-sink-logic.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.equal(
      src.includes(SEP),
      false,
      "tiingo-rt-sink-logic.ts must not contain a raw NUL byte",
    );
    assert.ok(
      src.includes(String.raw`\u0000`),
      "…it must spell the separator as the escape instead",
    );
  });
});

describe("archive lines are self-describing", () => {
  it("names the feed inside the line, not only in the key", () => {
    // `gunzip | head -1` must identify the bytes without reference to the path
    // they were stored under — the rule `serializeColdShard` already follows.
    const line = JSON.parse(
      toArchiveLine({ receivedAtMs: 1, raw: '{"a":1}' }),
    ) as {
      f: string;
      r: number;
      d: string;
    };
    assert.equal(line.f, "tiingo-equity-intraday");
    assert.equal(line.r, 1);
    assert.equal(line.d, '{"a":1}');
  });

  it("is one line with no embedded newline", () => {
    const line = toArchiveLine({ receivedAtMs: 1, raw: '{"a":\n1}' });
    assert.equal(
      line.includes("\n"),
      false,
      "a raw newline would corrupt the JSONL framing",
    );
  });
});

describe("aggregator input", () => {
  it("carries the mid and the venue timestamp", () => {
    const t = toAggregatorTick(quote());
    assert.equal(t.symbol, "AAPL");
    assert.equal(t.mid, 314.98);
    assert.equal(t.tsMs, TS.getTime());
  });
});
