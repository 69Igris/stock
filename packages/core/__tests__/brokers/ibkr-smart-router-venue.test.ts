/**
 * MONEY-980: IBKR's SMART router must never be stamped as an Indian venue.
 *
 * `mapIBKRExchange` carried `SMART: "NSE"`, commented "SMART routing defaults
 * to primary exchange". SMART is IBKR's smart-ORDER-ROUTER pseudo-venue: it
 * means "IBKR chose where to execute" and it does not report the choice back.
 * So every SMART-routed holding in every market came out labelled NSE, and a
 * US position was indistinguishable from an Indian one.
 *
 * ── WHY THIS IS A MONEY TEST AND NOT A LABEL TEST ─────────────────────────────
 *
 * `exchange` is half of a MATCH KEY, not decoration. The final block below
 * drives the REAL `corpActionAppliesToLot` from
 * `packages/core/src/pairing/corp-actions.ts` — the FIFO cost-basis path —
 * rather than asserting a string, because the string is only interesting for
 * what it makes that function do.
 *
 * Two properties of that function make the wrong stamp expensive:
 *
 *   - it gates on `action.exchange !== lot.exchange` and then matches on ISIN
 *     ONLY when BOTH sides carry one, falling back to SYMBOL otherwise;
 *   - `mapIBKRTrade` sets NO `isin` (IBKR's execution payload has none), so an
 *     IBKR lot has `isin: null` and the ISIN branch is unreachable BY
 *     CONSTRUCTION. Symbol+exchange is the only live path.
 *
 * With 214 real India/US ticker collisions, a US `ACC` lot stamped NSE matched
 * ACC Ltd — the Indian cement company — and absorbed its splits into a US cost
 * basis. Silently, and in the numbers rather than in the labels.
 *
 * Pure/offline: no network, no timers, no Prisma, no open handles.
 *
 * Source: packages/core/src/brokers/adapters/interactive-brokers.ts
 *         packages/core/src/pairing/corp-actions.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  mapIBKRExchange,
  mapIBKRHolding,
  mapIBKRPosition,
  mapIBKROrder,
  mapIBKRTrade,
} from "../../src/brokers/adapters/interactive-brokers";
import { corpActionAppliesToLot } from "../../src/pairing/corp-actions";

/** Every Indian venue this adapter can emit — the set a US row must avoid. */
const INDIA_VENUES = ["NSE", "BSE"] as const;

describe("MONEY-980 - IBKR SMART is a router, not a venue", () => {
  it("a USD SMART fill does NOT come out as an Indian venue", () => {
    // The headline case. Against the pre-fix source this returns "NSE".
    const venue = mapIBKRExchange("SMART", "USD");
    assert.ok(
      !INDIA_VENUES.includes(venue as (typeof INDIA_VENUES)[number]),
      `a USD SMART fill was stamped as the Indian venue ${venue}`,
    );
  });

  it("an UNRESOLVED venue is reported as SMART, not guessed", () => {
    // Not merely "not NSE": guessing NYSE-or-NASDAQ would be the same defect
    // one market over, so pin the specific honest answer.
    assert.equal(mapIBKRExchange("SMART", "USD"), "SMART");
  });

  it("an ABSENT currency is unresolved, never assumed Indian", () => {
    // "We were not told" and "it is Indian" are different claims. IBKR's
    // execution payload does not uniformly carry `currency`.
    assert.equal(mapIBKRExchange("SMART"), "SMART");
    assert.equal(mapIBKRExchange("SMART", ""), "SMART");
  });

  it("a currency with no unambiguous default venue stays unresolved", () => {
    // Guards against a future contributor filling the table in by plausibility.
    for (const ccy of ["USD", "GBP", "EUR", "HKD", "JPY", "CAD"]) {
      assert.equal(
        mapIBKRExchange("SMART", ccy),
        "SMART",
        `${ccy} was resolved to a venue it does not pin`,
      );
    }
  });

  it("INR keeps the pre-existing NSE default, case-insensitively", () => {
    // The one currency that DOES pin a single market with one default venue.
    // Retained deliberately: this change is about the cross-MARKET guess.
    assert.equal(mapIBKRExchange("SMART", "INR"), "NSE");
    assert.equal(mapIBKRExchange("SMART", "inr"), "NSE");
  });

  it("every REAL venue code still maps exactly as before", () => {
    // The regression fence: SMART moved, nothing else did.
    const unchanged: Array<[string, string]> = [
      ["NASDAQ", "NASDAQ"],
      ["NYSE", "NYSE"],
      ["ARCA", "NYSE"],
      ["AMEX", "NYSE"],
      ["NSE", "NSE"],
      ["BSE", "BSE"],
      ["LSE", "LSE"],
      ["IDEALPRO", "FOREX"],
      // Unmapped codes have always fallen through as themselves, which is why
      // returning "SMART" is inside this function's existing contract.
      ["TSE", "TSE"],
      ["SEHK", "SEHK"],
    ];
    for (const [code, want] of unchanged) {
      assert.equal(mapIBKRExchange(code), want, `${code} regressed`);
    }
    // A real venue code is NOT currency-sensitive — currency resolves the
    // router and nothing else.
    assert.equal(mapIBKRExchange("NASDAQ", "INR"), "NASDAQ");
    assert.equal(mapIBKRExchange("NSE", "USD"), "NSE");
  });
});

describe("MONEY-980 - the currency reaches all four IBKR mappers", () => {
  // A parameter the mapper accepts and no caller forwards is inert — the
  // `createMissing` shape (MONEY-1235). Each of the four record mappers is
  // driven with a US SMART payload and must not emit an Indian venue.
  const usSmart = {
    ticker: "ACC",
    exchange: "SMART",
    currency: "USD",
    conid: 1234,
    position: 10,
    avgCost: 100,
    mktPrice: 110,
    assetClass: "STK",
    secType: "STK",
    side: "BUY",
    size: 10,
    price: 110,
    orderId: "o-1",
    execution_id: "e-1",
  } as Record<string, unknown>;

  const mappers: Array<
    [string, (r: Record<string, unknown>) => { exchange: string }]
  > = [
    ["mapIBKRHolding", mapIBKRHolding],
    ["mapIBKRPosition", mapIBKRPosition],
    ["mapIBKROrder", mapIBKROrder],
    ["mapIBKRTrade", mapIBKRTrade],
  ];

  for (const [name, fn] of mappers) {
    it(`${name} does not stamp a USD SMART row as Indian`, () => {
      assert.equal(fn(usSmart).exchange, "SMART");
    });

    it(`${name} still honours an explicit listingExchange`, () => {
      // `currency` must not override a venue IBKR actually named. All four
      // call sites prefer `listingExchange`, so SMART is only ever the
      // last-resort branch.
      assert.equal(
        fn({ ...usSmart, listingExchange: "NASDAQ" }).exchange,
        "NASDAQ",
      );
    });

    it(`${name} keeps an INR SMART row on NSE`, () => {
      assert.equal(fn({ ...usSmart, currency: "INR" }).exchange, "NSE");
    });
  }
});

describe("MONEY-980 - no call site may silently skip the currency", () => {
  /**
   * `currency` is OPTIONAL in the signature, and an optional discriminator that
   * a caller forgets is a no-op wearing a fix's clothes — a SMART row with no
   * currency resolves to the sentinel and an Indian user's holdings quietly
   * change venue. That is the `createMissing` shape (MONEY-1235): a parameter
   * declared on the type and forwarded by nobody.
   *
   * The four cases above already prove the four CURRENT call sites forward it,
   * at runtime, and a dropped forward turns one of them red (mutation-verified).
   * This case covers the one thing runtime cannot: a FIFTH call site added
   * later. It scans the source so a new caller has to answer the question.
   *
   * Preferred over making the parameter REQUIRED: the venue-code path
   * (`ARCA` -> `NYSE`) has no opinion about currency, so a required argument
   * would force ~10 unrelated call sites to pass a meaningless `undefined` —
   * ceremony that reads as an answer without being one.
   */
  const SRC = join(
    import.meta.dirname,
    "..",
    "..",
    "src",
    "brokers",
    "adapters",
    "interactive-brokers.ts",
  );

  it("[meta] the scan reads a real file", () => {
    // A scan over "" passes vacuously — the shadow shape this repo has a
    // standing rule against, and the one that hid MONEY-1263's moved path.
    assert.ok(existsSync(SRC), `adapter source not found at ${SRC}`);
    assert.ok(
      readFileSync(SRC, "utf8").length > 5000,
      "adapter source read as suspiciously short",
    );
  });

  it("every mapIBKRExchange CALL forwards a currency", () => {
    const src = readFileSync(SRC, "utf8");
    const calls: string[] = [];

    let idx = src.indexOf("mapIBKRExchange(");
    while (idx !== -1) {
      // Skip the declaration itself — it is the only occurrence preceded by
      // `function `.
      const isDeclaration = src.slice(0, idx).trimEnd().endsWith("function");
      if (!isDeclaration) {
        // Walk to the matching close paren so a multi-line call is captured
        // whole; a fixed-width slice would truncate exactly the arg we test.
        let depth = 0;
        let end = idx + "mapIBKRExchange".length;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth++;
          else if (src[end] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        calls.push(src.slice(idx, end + 1));
      }
      idx = src.indexOf("mapIBKRExchange(", idx + 1);
    }

    assert.equal(
      calls.length,
      4,
      `expected 4 call sites (holding/position/order/trade), found ${calls.length}` +
        " — a new one must forward currency, or this count needs updating with a reason",
    );
    for (const call of calls) {
      assert.match(
        call,
        /currency/,
        `a mapIBKRExchange call omits the currency discriminator:\n${call}`,
      );
    }
  });
});

describe("MONEY-980 - the consequence: a US lot must not absorb an India action", () => {
  // ACC is one of 214 real India/US ticker collisions: ACC Ltd (NSE, cement)
  // and an unrelated US listing. The action below is a REAL-shaped Indian 1:2
  // split; the lot is what an IBKR US SMART fill produces.
  const indiaSplit = {
    id: "ca-acc-split",
    symbol: "ACC",
    exchange: "NSE",
    isin: "INE012A01025",
    type: "SPLIT",
    ratio: 2,
    exDate: new Date("2026-03-01T00:00:00.000Z"),
  };

  const now = new Date("2026-06-01T00:00:00.000Z");

  it("the US lot's venue is what decides, and it must not be NSE", () => {
    // Build the lot the way the pipeline does — through the REAL mapper, not
    // by hand — so this case fails if the mapper regresses OR if the pairing
    // guard changes underneath it.
    const usTrade = mapIBKRTrade({
      ticker: "ACC",
      exchange: "SMART",
      currency: "USD",
      side: "BUY",
      size: 10,
      price: 250,
      secType: "STK",
      execution_id: "e-us-1",
      tradeTime: "2026-01-15T00:00:00.000Z",
    });

    const usLot = {
      // IBKR executions carry no ISIN, so this is null in production. That is
      // exactly what makes symbol+exchange the only live match path.
      isin: null,
      symbol: usTrade.symbol,
      exchange: usTrade.exchange,
      tradeDate: new Date("2026-01-15T00:00:00.000Z"),
    };

    assert.equal(usLot.isin, null, "an IBKR lot must have no ISIN to match on");
    assert.equal(
      corpActionAppliesToLot(indiaSplit, usLot, now),
      false,
      "ACC Ltd's Indian split was applied to a US ACC lot's cost basis",
    );
  });

  it("[control] a genuine NSE lot DOES still absorb the same action", () => {
    // Without this the case above passes for a boring reason — e.g. a broken
    // ratio or an exDate outside the window would make EVERY lot return false,
    // and the test would prove nothing about the venue at all.
    const nseLot = {
      isin: null,
      symbol: "ACC",
      exchange: "NSE",
      tradeDate: new Date("2026-01-15T00:00:00.000Z"),
    };
    assert.equal(
      corpActionAppliesToLot(indiaSplit, nseLot, now),
      true,
      "the control lot did not match — this fixture proves nothing",
    );
  });

  it("[control] the two lots differ ONLY in exchange", () => {
    // Pins that the control is a true control: same symbol, same null ISIN,
    // same trade date. The venue is the single independent variable.
    const usLot = mapIBKRTrade({
      ticker: "ACC",
      exchange: "SMART",
      currency: "USD",
      side: "BUY",
      size: 10,
      price: 250,
      secType: "STK",
      execution_id: "e-us-1",
    });
    assert.equal(usLot.symbol, "ACC");
    assert.notEqual(usLot.exchange, "NSE");
  });
});
