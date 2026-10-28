/**
 * Session ownership and displacement — MONEY-1373.
 *
 * The prompt this implements asked for both directions to be tested, and that
 * is the right demand: a one-way rule tested one way is a rule nobody has
 * checked. DATABENTO must replace TIINGO_RT on an intraday session, TIINGO_RT
 * must never replace DATABENTO, and nothing may displace anything on the daily
 * series.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideSessionWrite } from "../../src/market-data/databento/databento-day-authority";
import { DATABENTO_SOURCE } from "../../src/market-data/databento/databento-logic";
import { RT_CANDLE_SOURCE } from "../../src/market-data/tiingo/tiingo-rt-sink-logic";
import { PRICE_SOURCE_AUTHORITY } from "../../src/market-data/price-source-authority";

const M1 = "M1";
const H1 = "H1";
const D1 = "D1";

describe("[premise] the sources this rule arbitrates are really ranked", () => {
  it("DATABENTO outranks TIINGO_RT, and TIINGO outranks DATABENTO", () => {
    // Without this the whole suite could pass against a table where every
    // source is unknown and therefore equal.
    const rank = (s: string): number => PRICE_SOURCE_AUTHORITY[s] ?? 0;
    assert.ok(
      rank(DATABENTO_SOURCE) > rank(RT_CANDLE_SOURCE),
      `DATABENTO ${rank(DATABENTO_SOURCE)} vs TIINGO_RT ${rank(RT_CANDLE_SOURCE)}`,
    );
    assert.ok(
      rank("TIINGO") > rank(DATABENTO_SOURCE),
      "TIINGO must outrank DATABENTO so a D1 collision is refused by RANK too",
    );
  });
});

describe("DATABENTO over a TIINGO_RT session — the case the append exists for", () => {
  it("DISPLACES on M1, naming what it removes", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE],
      timeframe: M1,
    });
    assert.equal(v.action, "displace");
    assert.deepEqual(v.action === "displace" ? v.deleting : [], [
      RT_CANDLE_SOURCE,
    ]);
    assert.match(v.reason, /trade-derived/);
  });

  it("displaces on H1 too — the rule is about the TIMEFRAME CLASS", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE],
      timeframe: H1,
    });
    assert.equal(v.action, "displace");
  });

  it("HEALS a session an interrupted write left holding BOTH", () => {
    // Delete-then-write has an intermediate state, and a crash there leaves a
    // mixed session. Refusing it forever would make the interruption permanent;
    // displacing only the weaker source finishes the job the next run.
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE, DATABENTO_SOURCE],
      timeframe: M1,
    });
    assert.equal(v.action, "displace");
    assert.deepEqual(v.action === "displace" ? v.deleting : [], [
      RT_CANDLE_SOURCE,
    ]);
  });

  it("displaces an UNKNOWN source, which ranks below everything named", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: ["SOME_OLD_IMPORT"],
      timeframe: M1,
    });
    assert.equal(v.action, "displace");
  });
});

describe("the REVERSE is refused — a live tick never overwrites a settled bar", () => {
  it("TIINGO_RT over a DATABENTO session is refused", () => {
    const v = decideSessionWrite({
      incomingSource: RT_CANDLE_SOURCE,
      existingSources: [DATABENTO_SOURCE],
      timeframe: M1,
    });
    assert.equal(v.action, "refuse");
    assert.equal(v.action === "refuse" ? v.d1 : true, false);
    // The reason comes from the generic rule, so the two paths cannot drift
    // into telling different stories about the same collision.
    assert.match(v.reason, /must hold one source/i);
  });

  it("DATABENTO over a TIINGO (EOD) session is refused even at M1", () => {
    // Rank, not timeframe: TIINGO outranks DATABENTO everywhere.
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: ["TIINGO"],
      timeframe: M1,
    });
    assert.equal(v.action, "refuse");
  });

  it("refuses the WHOLE session when any source blocks, never a partial displace", () => {
    // Removing the weaker half would leave the stronger half beside our bars —
    // the mixed session the rule exists to prevent, arrived at by the mechanism
    // meant to enforce it.
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE, "TIINGO"],
      timeframe: M1,
    });
    assert.equal(v.action, "refuse");
  });
});

describe("D1 is never displaced, by anyone", () => {
  it("refuses DATABENTO over a TIINGO daily session and FLAGS it", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: ["TIINGO"],
      timeframe: D1,
    });
    assert.equal(v.action, "refuse");
    assert.equal(v.action === "refuse" ? v.d1 : false, true);
  });

  it("refuses even over a source DATABENTO would outrank at M1", () => {
    // The belt-and-braces case. If the rank table were ever reordered, this is
    // the assertion that still refuses — which is why the timeframe test exists
    // beside the rank one rather than instead of it.
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE],
      timeframe: D1,
    });
    assert.equal(v.action, "refuse");
    assert.equal(v.action === "refuse" ? v.d1 : false, true);
    assert.match(v.reason, /INTRADAY timeframes only/i);
  });

  it("refuses on W1 as well — 'not intraday' is the test, not 'is D1'", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [RT_CANDLE_SOURCE],
      timeframe: "W1",
    });
    assert.equal(v.action, "refuse");
    assert.equal(v.action === "refuse" ? v.d1 : false, true);
  });
});

describe("plain writes", () => {
  it("an EMPTY session is written", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [],
      timeframe: M1,
    });
    assert.equal(v.action, "write");
  });

  it("our OWN session is written — this is what makes a re-run a no-op", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: [DATABENTO_SOURCE],
      timeframe: M1,
    });
    assert.equal(v.action, "write");
    assert.equal(v.reason, "same source");
  });

  it("our own D1 session is written — the D1 guard is about DISPLACEMENT", () => {
    // A refusal here would make the daily series unwritable by its own owner.
    const v = decideSessionWrite({
      incomingSource: "TIINGO",
      existingSources: ["TIINGO"],
      timeframe: D1,
    });
    assert.equal(v.action, "write");
  });

  it("ignores an empty-string source rather than treating it as a holder", () => {
    const v = decideSessionWrite({
      incomingSource: DATABENTO_SOURCE,
      existingSources: ["", ""],
      timeframe: M1,
    });
    assert.equal(v.action, "write");
  });
});
