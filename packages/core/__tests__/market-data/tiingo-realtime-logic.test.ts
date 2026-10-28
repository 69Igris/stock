/**
 * The frame contract, pinned against 236 LIVE frames captured 2026-08-31.
 *
 * Why fixtures and not hand-written literals: this project has already paid
 * once for trusting Tiingo's documented field order. The EOD CSV is documented
 * `date,open,high,low,close` and is really `date,close,high,low,open`, so a
 * positional parser written from the docs swaps open and close on every US
 * security. The docs give no field-by-field layout for these websocket arrays
 * at all, so the layout here is DERIVED from captured bytes and re-checked
 * arithmetically by `sanityCheckLevel4Layout` over the whole corpus.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeRtFrame,
  buildSubscribePayload,
  classifyRefusal,
  sanityCheckLevel4Layout,
  TIINGO_RT_WS_URL,
  TIINGO_RT_SNAPSHOT_URL,
  TIINGO_RT_THRESHOLD_LEVEL,
  type TiingoRtQuote,
} from "../../src/market-data/tiingo/tiingo-realtime-logic";
import { MinuteBarAggregator } from "../../src/market-data/tiingo/tiingo-minute-bars";

const FIX = join(import.meta.dirname, "..", "fixtures", "tiingo-realtime");
const load = (f: string): unknown[] =>
  JSON.parse(readFileSync(join(FIX, f), "utf8")) as unknown[];

const level4 = load("equity-intraday-level4.json");
const level6 = load("equity-intraday-level6.json");
const refusals = JSON.parse(
  readFileSync(join(FIX, "refusals.json"), "utf8"),
) as Record<
  string,
  { response: { code: number; message: string }; messageType: string }
>;

describe("PREMISE: the captured corpus is real and non-trivial", () => {
  it("holds enough frames of each level to be evidence", () => {
    // Without this, every loop below can pass over an empty array — the
    // vacuous-guard shape this repo has shipped more than once.
    assert.ok(level4.length >= 100, `level4 corpus is ${level4.length} frames`);
    assert.ok(level6.length >= 100, `level6 corpus is ${level6.length} frames`);
    const a4 = level4.filter(
      (f) => (f as { messageType?: string }).messageType === "A",
    );
    const a6 = level6.filter(
      (f) => (f as { messageType?: string }).messageType === "A",
    );
    assert.ok(a4.length >= 50, `level4 has ${a4.length} data frames`);
    assert.ok(a6.length >= 50, `level6 has ${a6.length} data frames`);
  });

  it("the corpus carries the control frames too, not only data", () => {
    const types = new Set(
      level4.map((f) => (f as { messageType?: string }).messageType),
    );
    assert.ok(types.has("I"), "no subscribe ack in the corpus");
    assert.ok(types.has("H"), "no heartbeat in the corpus");
  });
});

describe("level 4 — the quote-shaped feed", () => {
  it("decodes every captured data frame into a complete quote", () => {
    let seen = 0;
    for (const f of level4) {
      if ((f as { messageType?: string }).messageType !== "A") continue;
      const out = decodeRtFrame(JSON.stringify(f), 4);
      assert.equal(
        out.kind,
        "quote",
        `frame did not decode: ${JSON.stringify(f)}`,
      );
      if (out.kind !== "quote") continue;
      seen++;
      assert.ok(out.quote.ticker.length > 0);
      assert.ok(
        out.quote.ts instanceof Date && Number.isFinite(out.quote.ts.getTime()),
      );
      assert.equal(
        out.quote.service,
        "cons",
        "the consolidated feed identifies itself",
      );
      for (const k of [
        "bid",
        "ask",
        "mid",
        "bidSize",
        "askSize",
        "spread",
      ] as const) {
        assert.notEqual(
          out.quote[k],
          null,
          `${k} was null in ${JSON.stringify(f)}`,
        );
      }
    }
    assert.ok(seen >= 50, `only ${seen} frames exercised`);
  });

  it("THE LAYOUT CLAIM: (ask-bid)/mid reproduces the reported spread, corpus-wide", () => {
    // This is what makes the positional layout measured rather than assumed.
    // A transposition — bid read as size, ask as spread — misses by orders of
    // magnitude and fails here long before it can invert a stored quote.
    let checked = 0;
    for (const f of level4) {
      if ((f as { messageType?: string }).messageType !== "A") continue;
      const out = decodeRtFrame(JSON.stringify(f), 4);
      if (out.kind !== "quote") continue;
      const v = sanityCheckLevel4Layout(out.quote);
      assert.ok(v.ok, `${v.detail} :: ${JSON.stringify(f)}`);
      checked++;
    }
    assert.ok(checked >= 50, `only ${checked} layout checks ran`);
  });

  it("bid <= mid <= ask on every captured frame", () => {
    for (const f of level4) {
      if ((f as { messageType?: string }).messageType !== "A") continue;
      const out = decodeRtFrame(JSON.stringify(f), 4);
      if (out.kind !== "quote") continue;
      const { bid, mid, ask } = out.quote;
      if (bid === null || mid === null || ask === null) continue;
      assert.ok(bid <= mid && mid <= ask, `unordered: ${bid}/${mid}/${ask}`);
    }
  });
});

describe("level 6 — reference price only", () => {
  it("decodes to a reference, never to a quote", () => {
    let seen = 0;
    for (const f of level6) {
      if ((f as { messageType?: string }).messageType !== "A") continue;
      const out = decodeRtFrame(JSON.stringify(f), 6);
      assert.equal(out.kind, "reference");
      if (out.kind !== "reference") continue;
      seen++;
      assert.notEqual(out.price, null);
    }
    assert.ok(seen >= 50);
    // The reason the tick path requires level 4: no bid, no ask, no sizes.
    // A quote hash cannot be populated from this shape at all.
  });

  it("a level-6 frame read AS level 4 is refused, not misread", () => {
    // Width is the tripwire. Three elements decoded against an eight-element
    // layout would read the price as a spread and leave bid/ask undefined —
    // the corruption must be visible instead.
    const a6 = level6.find(
      (f) => (f as { messageType?: string }).messageType === "A",
    )!;
    const out = decodeRtFrame(JSON.stringify(a6), 4);
    assert.equal(out.kind, "ignored");
  });
});

describe("control frames", () => {
  it("the subscribe ack carries a subscription id", () => {
    const i = level4.find(
      (f) => (f as { messageType?: string }).messageType === "I",
    )!;
    const out = decodeRtFrame(JSON.stringify(i));
    assert.equal(out.kind, "ack");
    if (out.kind === "ack") assert.ok((out.subscriptionId ?? 0) > 0);
  });

  it("a heartbeat is a heartbeat, not a quote", () => {
    const h = level4.find(
      (f) => (f as { messageType?: string }).messageType === "H",
    )!;
    assert.equal(decodeRtFrame(JSON.stringify(h)).kind, "heartbeat");
  });

  it("never throws on junk", () => {
    for (const junk of [
      "",
      "{",
      "null",
      "[]",
      '{"messageType":"A"}',
      '{"messageType":"A","data":[]}',
    ]) {
      const out = decodeRtFrame(junk);
      assert.ok(
        out.kind === "ignored" || out.kind === "refusal",
        `threw or mis-decoded: ${junk}`,
      );
    }
  });
});

describe("refusals are classified BY BODY — the two that look alike", () => {
  it("a thresholdLevel 400 is a PARAMETER problem, not an entitlement one", () => {
    // Measured: levels 0 and 5 are refused with this text while 4 and 6 work on
    // the same key in the same second. Reading it as "not entitled" would
    // disable a working feed and send someone to Tiingo billing.
    const out = decodeRtFrame(
      JSON.stringify(refusals["thresholdLevelRejected"]),
    );
    assert.equal(out.kind, "refusal");
    if (out.kind === "refusal")
      assert.equal(out.refusal.kind, "threshold-level");
  });

  it("the BOATS 403 IS an entitlement gap, and names the service", () => {
    const out = decodeRtFrame(JSON.stringify(refusals["boatsNotEntitled"]));
    assert.equal(out.kind, "refusal");
    if (out.kind === "refusal") {
      assert.equal(out.refusal.kind, "not-entitled");
      if (out.refusal.kind === "not-entitled")
        assert.equal(out.refusal.service, "boats");
    }
  });

  it("an auth failure is neither of the above", () => {
    assert.equal(classifyRefusal("Invalid token.", 401).kind, "auth");
  });
});

describe("subscribe payload", () => {
  it("OMITS thresholdLevel unless asked", () => {
    const p = buildSubscribePayload({ token: "t", tickers: ["AAPL"] });
    assert.equal("thresholdLevel" in p.eventData, false);
    assert.deepEqual(
      p.eventData.tickers,
      ["aapl"],
      "the feed wants lower case",
    );
  });

  it("REFUSES a thresholdLevel this account cannot use", () => {
    // The contract test the plan calls for: 0 and 5 must be unconstructable,
    // so the 400 that reads like an entitlement rejection can never be sent.
    for (const bad of [0, 5, 1, 99]) {
      assert.throws(
        () =>
          buildSubscribePayload({
            token: "t",
            tickers: ["AAPL"],
            thresholdLevel: bad,
          }),
        /not supported by this account/,
        `thresholdLevel ${bad} was accepted`,
      );
    }
  });

  it("accepts the two levels the account really has", () => {
    for (const good of [4, 6]) {
      const p = buildSubscribePayload({
        token: "t",
        tickers: ["AAPL"],
        thresholdLevel: good,
      });
      assert.equal(p.eventData.thresholdLevel, good);
    }
  });

  it("builds an unsubscribe with the same shape", () => {
    const p = buildSubscribePayload({
      token: "t",
      tickers: ["AAPL"],
      event: "unsubscribe",
    });
    assert.equal(p.eventName, "unsubscribe");
  });
});

describe("endpoint constants", () => {
  it("point at the 24x5 consolidated feed and NOT at IEX", () => {
    // The doc page recommends IEX; the CEO's email supersedes it for this
    // account. Pinned so a future reader cannot quietly migrate back on the
    // strength of the stale sentence.
    assert.equal(TIINGO_RT_WS_URL, "wss://api.tiingo.com/equity/intraday");
    assert.equal(TIINGO_RT_WS_URL.includes("iex"), false);
    assert.equal(TIINGO_RT_SNAPSHOT_URL.includes("iex"), false);
    assert.equal(
      TIINGO_RT_THRESHOLD_LEVEL,
      4,
      "level 6 cannot populate a quote",
    );
  });

  it("the batch snapshot URL keeps its TRAILING SLASH", () => {
    // Without it the endpoint answers 301, and fetch drops the Authorization
    // header across the redirect — which presents as an auth failure rather
    // than a routing one. Measured 2026-08-31.
    assert.ok(TIINGO_RT_SNAPSHOT_URL.endsWith("/"));
  });
});

/**
 * NEGATIVE INPUTS FOR THE TRIPWIRE.
 *
 * Everything above feeds `sanityCheckLevel4Layout` the PASSING corpus, which
 * an unconditional `return { ok: true }` satisfies completely. Measured: the
 * gutted function, a tolerance widened from 1e-6 to 1e6, and the ordering
 * branch replaced by `if (false)` were all GREEN across the whole suite — and
 * the gutted tripwire COMPOSED with a real decoder transposition still passed
 * 19/19 while every stored quote carried `spread: 60` and `bidSize: 0.000032`.
 *
 * A tripwire is only evidence if something is known to trip it. Each case
 * below is built so that exactly ONE branch can catch it.
 */
describe("the layout tripwire must REFUSE, not only accept", () => {
  const base = (over: Partial<TiingoRtQuote>): TiingoRtQuote => ({
    ticker: "aapl",
    ts: new Date("2026-08-31T17:58:11.030Z"),
    bid: 314.975,
    ask: 314.985,
    mid: 314.98,
    bidSize: 60,
    askSize: 140,
    spread: 3.1748841831068004e-5,
    service: "cons",
    ...over,
  });

  it("PREMISE: the unmutated base quote passes, so a refusal below means something", () => {
    // Without this, every `ok === false` assertion is satisfied by a function
    // that refuses everything — the mirror image of the defect being fixed.
    assert.equal(sanityCheckLevel4Layout(base({})).ok, true);
  });

  it("THE ORDERING BRANCH: a SELF-CONSISTENT inverted book is refused", () => {
    // Bid and ask swapped, and the spread swapped WITH them — which is what a
    // real upstream column transposition would look like, because the feed
    // computes the spread from the same two columns it transposed. The
    // arithmetic therefore still reconciles exactly (delta 0), so the spread
    // check CANNOT see this one. Ordering is the only branch left.
    const bid = 314.985;
    const ask = 314.975;
    const mid = 314.98;
    const q = base({ bid, ask, mid, spread: (ask - bid) / mid });
    assert.equal(
      Math.abs((ask - bid) / mid - q.spread!),
      0,
      "premise: self-consistent",
    );
    const v = sanityCheckLevel4Layout(q);
    assert.equal(v.ok, false, `an inverted book passed: ${v.detail}`);
    assert.match(v.detail, /inverted book|not ordered/);
  });

  it("THE MID-ORDERING BRANCH: a mid OUTSIDE an otherwise-ordered book is refused", () => {
    // The case the `bid <= ask` check above cannot see and the spread check is
    // built not to see. Bid and ask are in the right order, and the reported
    // spread reconciles EXACTLY against this mid — but the mid sits outside the
    // book, which is what a mid column transposed with an adjacent price column
    // looks like. `bid <= mid <= ask` is the only branch left.
    const bid = 314.975;
    const ask = 314.98;
    const mid = 314.985; // above the ask
    const q = base({ bid, ask, mid, spread: (ask - bid) / mid });
    assert.ok(bid <= ask, "premise: the book itself is ordered");
    assert.equal(
      Math.abs((ask - bid) / mid - q.spread!),
      0,
      "premise: self-consistent",
    );
    const v = sanityCheckLevel4Layout(q);
    assert.equal(v.ok, false, `a mid outside the book passed: ${v.detail}`);
    assert.match(v.detail, /not ordered/);
  });

  it("THE TOLERANCE BRANCH: a spread wrong by 60 is refused", () => {
    // 60 is not arbitrary — it is `bidSize` from a real captured frame. The
    // exact composed defect this file exists to catch is `spread: num(data[3])`
    // reading the size column, and 60 vs a derived 3.2e-5 is what that looks
    // like. A tolerance of 1e6 swallows it whole.
    const v = sanityCheckLevel4Layout(base({ spread: 60 }));
    assert.equal(v.ok, false, `spread=60 passed: ${v.detail}`);
    assert.match(v.detail, /spread mismatch/);
  });

  it("THE TOLERANCE BRANCH: 1e-6 is the real boundary, in both directions", () => {
    // Pins the MAGNITUDE, not just the sign of the comparison. The feed rounds
    // the spread it publishes, so the tolerance must stay loose enough for
    // rounding and tight enough to catch a transposition.
    const truth = (314.985 - 314.975) / 314.98;
    assert.equal(
      sanityCheckLevel4Layout(base({ spread: truth + 9e-7 })).ok,
      true,
    );
    assert.equal(
      sanityCheckLevel4Layout(base({ spread: truth + 1.1e-6 })).ok,
      false,
    );
  });

  it("does NOT refuse a genuinely incomplete frame — abstention is still allowed", () => {
    // The abstain path must survive: refusing everything would be just as
    // useless as accepting everything, and noisier.
    assert.equal(sanityCheckLevel4Layout(base({ spread: null })).ok, true);
    assert.equal(sanityCheckLevel4Layout(base({ bid: null })).ok, true);
  });
});

/**
 * A MID OF EXACTLY ZERO — the one input where a fabricated price reaches
 * storage, and the one input the tripwire used to skip.
 *
 * The old code abstained at `mid === 0` with `{ok: true}`, so an inverted book
 * whose mid was unusable passed the only guard built to see it. Meanwhile the
 * decoder kept the 0, `toQuotePayload` mapped it to `last: 0`, and the
 * aggregator accepted it (`Number.isFinite(0)` is true) and wrote a bar of
 * `{open: 0, high: 0, low: 0, close: 0}`.
 *
 * A mid of 0 is an ABSENCE. This is an equity feed; no equity is priced at
 * 0.00, and the mid is the feed's own midpoint of a book — zero means there is
 * no book to take a midpoint of.
 */
describe("a mid of zero is an ABSENCE, not a price", () => {
  const frame = (over: Record<number, unknown>): string =>
    JSON.stringify({
      messageType: "A",
      service: "cons",
      data: Object.assign(
        [
          "2026-08-31T13:58:11.030145337-04:00",
          "aapl",
          3.2e-5,
          60,
          314.975,
          314.98,
          314.985,
          140,
        ],
        over,
      ),
    });

  it("decodes to null, so no tradeable-looking zero reaches the quote hash", () => {
    const out = decodeRtFrame(frame({ 5: 0 }), 4);
    assert.equal(out.kind, "quote");
    if (out.kind !== "quote") return;
    assert.equal(out.quote.mid, null, "a mid of 0 was stored as a price");
  });

  it("a NEGATIVE mid is null too — no equity has one", () => {
    const out = decodeRtFrame(frame({ 5: -1 }), 4);
    assert.equal(out.kind, "quote");
    if (out.kind === "quote") assert.equal(out.quote.mid, null);
  });

  it("the aggregator therefore drops it instead of writing a zero-price bar", () => {
    // End to end: this is the behaviour that changed. Before, one frame
    // produced {open:0,high:0,low:0,close:0,ticks:1} and every counter said
    // the pipeline was healthy.
    const out = decodeRtFrame(frame({ 5: 0 }), 4);
    assert.equal(out.kind, "quote");
    if (out.kind !== "quote") return;
    const agg = new MinuteBarAggregator();
    agg.ingest({
      symbol: "AAPL",
      tsMs: out.quote.ts.getTime(),
      mid: out.quote.mid,
    });
    assert.deepEqual(agg.drain(), [], "a bar was fabricated from a zero mid");
    assert.equal(agg.counters.droppedNoPrice, 1);
    assert.equal(agg.counters.accepted, 0);
  });

  it("the tripwire still catches an inverted book when the mid is unusable", () => {
    // THE regression this pairs with. `bid <= ask` needs no mid, so a missing
    // mid must not buy an inverted book a free pass.
    const out = decodeRtFrame(frame({ 4: 5, 5: 0, 6: 1 }), 4);
    assert.equal(out.kind, "quote");
    if (out.kind !== "quote") return;
    assert.equal(out.quote.mid, null);
    const v = sanityCheckLevel4Layout(out.quote);
    assert.equal(
      v.ok,
      false,
      `inversion missed with an absent mid: ${v.detail}`,
    );
  });

  it("a non-positive mid handed in DIRECTLY is refused, never silently passed", () => {
    // The function is exported. Answering "ok" to a division it cannot perform
    // reports a layout verified having verified nothing.
    for (const mid of [0, -1]) {
      const v = sanityCheckLevel4Layout({
        ticker: "aapl",
        ts: new Date(),
        bid: 0,
        ask: 0,
        mid,
        bidSize: 0,
        askSize: 0,
        spread: 0,
        service: "cons",
      });
      assert.equal(v.ok, false, `mid=${mid} passed: ${v.detail}`);
    }
  });

  it("the zero rule is SCOPED to the mid — a zero bid is still a PRICE", () => {
    // `toQuotePayload` pins that a null and a zero must not be collapsed. Zero
    // size is ordinary and a zero spread is a locked market. Folding this rule
    // into `num()` would destroy all four.
    const out = decodeRtFrame(frame({ 2: 0, 3: 0, 4: 0, 7: 0 }), 4);
    assert.equal(out.kind, "quote");
    if (out.kind !== "quote") return;
    assert.equal(out.quote.bid, 0, "a zero bid was collapsed to an absence");
    assert.equal(
      out.quote.spread,
      0,
      "a locked market was collapsed to an absence",
    );
    assert.equal(out.quote.bidSize, 0);
    assert.equal(out.quote.askSize, 0);
  });
});

/**
 * `parseTs` — one line, and the whole socket holder rests on it.
 *
 * `decodeRtFrame`'s header promises it never throws, because "a socket holder
 * that dies on an unexpected shape takes the whole feed down for every
 * subscriber". That promise is not self-contained: `onFrame` runs inside
 * `ws.on("message")`, and `workers/src/realtime/main.ts` calls
 * `usMarketSession(frame.quote.ts)` on the decoded frame — which THROWS BY
 * DESIGN on an Invalid Date. So dropping the `Number.isFinite` guard here does
 * not produce a slightly-wrong timestamp; it produces a dead socket.
 */
describe("a malformed timestamp NEVER becomes an Invalid Date", () => {
  const withTs = (ts: unknown): string =>
    JSON.stringify({
      messageType: "A",
      service: "cons",
      data: [ts, "aapl", 3.2e-5, 60, 314.975, 314.98, 314.985, 140],
    });

  it("PREMISE: the same frame with a REAL timestamp decodes to a quote", () => {
    // Otherwise every assertion below passes because the frame is bad for some
    // entirely different reason.
    const out = decodeRtFrame(withTs("2026-08-31T13:58:11.030145337-04:00"), 4);
    assert.equal(out.kind, "quote");
  });

  it("is ignored, not decoded into a quote carrying NaN time", () => {
    for (const bad of [
      "not-a-date",
      "",
      "aapl",
      "2026-13-45T99:99:99Z",
      "undefined",
      1756654691030,
      null,
      {},
    ]) {
      const out = decodeRtFrame(withTs(bad), 4);
      assert.equal(
        out.kind,
        "ignored",
        `${JSON.stringify(bad)} decoded to ${out.kind}`,
      );
    }
  });

  it("no frame this decoder emits can carry an unusable Date", () => {
    // The property the consumer actually depends on, asserted directly rather
    // than inferred from the cases above.
    for (const bad of ["not-a-date", "", "2026-13-45T99:99:99Z"]) {
      const out = decodeRtFrame(withTs(bad), 4);
      if (out.kind === "quote")
        assert.ok(Number.isFinite(out.quote.ts.getTime()));
      if (out.kind === "reference")
        assert.ok(Number.isFinite(out.ts.getTime()));
    }
    for (const f of level4) {
      const out = decodeRtFrame(JSON.stringify(f), 4);
      if (out.kind === "quote")
        assert.ok(
          Number.isFinite(out.quote.ts.getTime()),
          "corpus frame carried an Invalid Date",
        );
    }
  });
});

/**
 * bidSize / askSize: pinned by COLUMN, because nothing else can pin them.
 *
 * The spread identity `(ask - bid) / mid == spread` fixes columns 2, 4, 5 and
 * 6 arithmetically. The two SIZE columns participate in no identity at all, so
 * no algebra inside a frame can tell column 3 from column 7 — and asserting
 * "askSize is usually larger" would pin a microstructure accident of one
 * capture as if it were a contract.
 *
 * What IS pinnable, honestly:
 *   - the MAPPING, element-wise against the captured bytes; and
 *   - that the two columns really do differ often enough for a swap to be
 *     observable at all (108 of 118 frames).
 *
 * That proves the decoder still reads the columns we measured on 2026-08-31.
 * It does NOT prove Tiingo LABELS column 3 "bidSize" — the only in-frame
 * argument for that is the layout's mirror symmetry about the mid:
 * `spread, bidSize, bid | mid | ask, askSize`.
 */
describe("the two size columns — pinned positionally, and honestly", () => {
  it("PREMISE: a transposition would actually be visible in this corpus", () => {
    let differ = 0;
    let total = 0;
    for (const f of level4) {
      const d = f as { messageType?: string; data?: unknown[] };
      if (d.messageType !== "A" || !Array.isArray(d.data)) continue;
      total++;
      if (d.data[3] !== d.data[7]) differ++;
    }
    assert.ok(total >= 50, `only ${total} A-frames`);
    assert.ok(
      differ >= 50,
      `only ${differ} of ${total} frames have bidSize !== askSize — a swap would be invisible here`,
    );
  });

  it("bidSize is column 3 and askSize is column 7, on every captured frame", () => {
    let checked = 0;
    for (const f of level4) {
      const d = f as { messageType?: string; data?: unknown[] };
      if (d.messageType !== "A" || !Array.isArray(d.data)) continue;
      const out = decodeRtFrame(JSON.stringify(f), 4);
      if (out.kind !== "quote") continue;
      assert.equal(
        out.quote.bidSize,
        d.data[3],
        `bidSize is not column 3: ${JSON.stringify(f)}`,
      );
      assert.equal(
        out.quote.askSize,
        d.data[7],
        `askSize is not column 7: ${JSON.stringify(f)}`,
      );
      checked++;
    }
    assert.ok(checked >= 50, `only ${checked} frames exercised`);
  });
});

/**
 * The remaining guards, each of which a mutation walked straight through.
 */
describe("guards that the passing corpus can never exercise", () => {
  it("`num` refuses a non-finite number — and JSON really can produce one", () => {
    // `JSON.parse('{"a":1e999}').a === Infinity`. It is not a hypothetical
    // shape: any overflowing literal on the wire arrives as Infinity, and an
    // Infinity mid would reach the aggregator's `Number.isFinite` guard as a
    // dropped tick while an Infinity SPREAD would silently defeat the layout
    // tripwire (`Math.abs(Infinity - x) <= 1e-6` is false, but `derived` and
    // `delta` both go non-finite and the detail string becomes unreadable).
    const raw =
      '{"messageType":"A","service":"cons","data":["2026-08-31T13:58:11.030145337-04:00","aapl",1e999,60,314.975,314.98,314.985,140]}';
    assert.equal(JSON.parse(raw).data[2], Number.POSITIVE_INFINITY, "premise");
    const out = decodeRtFrame(raw, 4);
    assert.equal(out.kind, "quote");
    if (out.kind === "quote")
      assert.equal(out.quote.spread, null, "Infinity was stored as a number");
  });

  it("an EMPTY ticker is dropped — never written to a keyless `rt:us:quote:`", () => {
    // The existing junk case `{"messageType":"A","data":[]}` fails the width
    // check and the `ts` half of this guard, so it never reaches the ticker
    // half. This frame is well-formed in every respect except identity.
    const out = decodeRtFrame(
      JSON.stringify({
        messageType: "A",
        service: "cons",
        data: [
          "2026-08-31T13:58:11.030145337-04:00",
          "",
          3.2e-5,
          60,
          314.975,
          314.98,
          314.985,
          140,
        ],
      }),
      4,
    );
    assert.equal(
      out.kind,
      "ignored",
      "a quote with no symbol would be stored under an empty key",
    );
  });

  it("a 4xx is a REFUSAL even when the frame is not messageType E", () => {
    // Every captured refusal carries `messageType: "E"`, so the `code >= 400`
    // clause never fires in the corpus and both `>= -> >` and deleting the
    // clause outright survive. A 429 on a metered feed is precisely the frame
    // that must not be filed as "ignored".
    const at = (code: number, type = "X"): ReturnType<typeof decodeRtFrame> =>
      decodeRtFrame(
        JSON.stringify({
          messageType: type,
          response: { code, message: `code ${code}` },
        }),
      );
    assert.equal(at(429).kind, "refusal", "a 429 was not treated as a refusal");
    assert.equal(
      at(400).kind,
      "refusal",
      "400 is ON the boundary and must be included",
    );
    assert.equal(at(503).kind, "refusal");
    // Below the boundary it is not a refusal — the clause is a threshold, not
    // a blanket "any response object means failure".
    assert.equal(at(200).kind, "ignored");
    assert.equal(at(399).kind, "ignored");
  });
});
