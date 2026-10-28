/**
 * "Value held", not "combined weight". MONEY-1484.
 *
 * ## THE TILE SUMMED SOMETHING THAT CANNOT BE SUMMED
 *
 * It rendered `sumOrNull(funds.map(f => f.percentToNav))` — each scheme's
 * weight IN ITS OWN NAV. Those are fractions with different denominators, so
 * the sum is not a percentage of anything. MEASURED on RELIANCE, Aug 2026:
 *
 *     116 scheme rows, 11 AMCs
 *     SUM of weights  505.36 %          (the panel showed 107.87% — a subset)
 *     SUM of value    ₹53,53,903 lakh   = ₹53,539 Cr
 *     market cap      ₹16.60 L Cr       -> 3.2% held
 *
 * A cap at 100 was briefly shipped and was WORSE than the raw figure: it made
 * a meaningless number look meaningful. Replaced rather than clamped.
 *
 * RUPEES ARE ADDITIVE — `marketValueLakh` shares one denominator — so the sum
 * is legitimate, and divided by market cap it answers the question the tile was
 * reaching for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatValueHeld,
  heldShareOfMarketCapPct,
  heldHint,
} from "@/components/stock/StockFundsHolding";

const RELIANCE_LAKH = 5_353_903.284; // measured, Aug 2026
const RELIANCE_MCAP = 1.66e13; // ₹16.60 L Cr in rupees

describe("the rupee figure", () => {
  it("renders the measured RELIANCE total in crores", () => {
    assert.equal(formatValueHeld(RELIANCE_LAKH), "₹53,539 Cr");
  });

  it("steps up to lakh-crore only when it earns it", () => {
    assert.equal(formatValueHeld(1.66e7), "₹1.66 L Cr");
    assert.equal(formatValueHeld(99), "₹99 L");
  });

  it("absence is a dash, never a zero", () => {
    // "no scheme disclosed a value" and "funds hold nothing" are opposite
    // claims, and a 0 asserts the second.
    assert.equal(formatValueHeld(null), "—");
    assert.equal(formatValueHeld(Number.NaN), "—");
  });
});

describe("share of market cap", () => {
  it("the measured case comes out at 3.2%", () => {
    const share = heldShareOfMarketCapPct(RELIANCE_LAKH, RELIANCE_MCAP);
    assert.ok(share !== null);
    assert.ok(Math.abs(share - 3.225) < 0.01, `expected ~3.22%, got ${share}`);
  });

  it("the lakh→rupee conversion is right, not off by a factor of 100", () => {
    // 1 lakh = 1e5 rupees. Getting this wrong yields a plausible-looking number
    // two orders out, which no reader could catch.
    assert.equal(heldShareOfMarketCapPct(1, 1e5), 100);
    assert.equal(heldShareOfMarketCapPct(1, 1e7), 1);
  });

  it("a missing or absurd market cap yields null, not 0 and not Infinity", () => {
    for (const mc of [null, undefined, 0, -1, Number.NaN]) {
      assert.equal(
        heldShareOfMarketCapPct(RELIANCE_LAKH, mc as number | null),
        null,
        `market cap ${String(mc)} must not produce a number`
      );
    }
    assert.equal(heldShareOfMarketCapPct(null, RELIANCE_MCAP), null);
  });
});

describe("the hint states what the number is NOT", () => {
  it("names the share and the undisclosed count together", () => {
    const h = heldHint(
      { valueHeldLakh: RELIANCE_LAKH, undisclosedValueCount: 3, fundCount: 24 },
      RELIANCE_MCAP
    );
    assert.match(h ?? "", /% of market cap/);
    assert.match(h ?? "", /3 schemes disclosed no value/);
  });

  it("singular reads correctly", () => {
    const h = heldHint(
      { valueHeldLakh: RELIANCE_LAKH, undisclosedValueCount: 1, fundCount: 24 },
      null
    );
    assert.match(h ?? "", /1 scheme disclosed no value/);
    assert.doesNotMatch(h ?? "", /schemes/);
  });

  it("no market cap simply drops that clause — the tile still stands", () => {
    // The rupee value is single-source and needs no join, so a caller without a
    // market cap gets one fewer caveat rather than a broken tile.
    const h = heldHint(
      { valueHeldLakh: RELIANCE_LAKH, undisclosedValueCount: 0, fundCount: 24 },
      null
    );
    assert.equal(h, undefined);
  });
});
