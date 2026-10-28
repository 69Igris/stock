/**
 * Manual-holding dedup, validation and merge arithmetic — MONEY-1236.
 *
 * Binds to the REAL exports of `apps/web/lib/actions/holdings-dedup-logic.ts`,
 * the module BOTH manual-add surfaces import:
 *
 *   - `addManualHoldingAction` (apps/web/lib/actions/holdings.ts)  — web UI
 *   - `POST /api/holdings` (apps/web/app/api/[[...path]]/route.ts) — REST
 *
 * The module previously had ZERO tests while carrying money arithmetic that a
 * repaired dedup had just made reachable for the first time. The adversarial
 * inputs below are the ones that actually reached it.
 *
 * Source: apps/web/lib/actions/holdings-dedup-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  manualHoldingWhere,
  mergeManualHolding,
  newManualHoldingValues,
  parseManualHoldingInput,
} from "../../lib/actions/holdings-dedup-logic";

const REPO_WEB = join(__dirname, "..", "..");

/**
 * Read a source file with its COMMENTS REMOVED.
 *
 * The structural assertions below look for re-implemented code. Without this,
 * they also match the prose that DESCRIBES the old implementation — and every
 * one of these fixes carries a comment quoting the pattern it replaced, so the
 * checks fired on their own documentation. A structural match has to be bound
 * to the thing it is actually about.
 */
function readCode(rel: string): string {
  // LINE comments FIRST, then BLOCK — never the reverse (MONEY-1143, and
  // `__tests__/meta/comment-strip-ordering.test.ts` enforces it repo-wide). A
  // `//` comment that contains a `/*` opens a phantom block running to the next
  // `*/`, which can be hundreds of lines away; block-first stripping once ate
  // 11,192 characters out of Sidebar.tsx. Every assertion below is an ABSENCE
  // check, which is precisely where a swallowed span passes for the wrong
  // reason.
  return readFileSync(join(REPO_WEB, rel), "utf8")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("manualHoldingWhere", () => {
  it("matches BOTH null shapes — absent is what the writers actually produce", () => {
    // Prod 2026-08-21: 16 of 99 holdings have `broker` ABSENT, 0 explicit null,
    // and all 16 absent ones are `brokerName: "manual"`. A bare `{broker:null}`
    // reached none of them, so 100% of this path's own output was invisible to
    // its own dedup.
    const where = manualHoldingWhere("u1", "tatamotors", "NSE");
    assert.deepEqual(where.OR, [
      { broker: null },
      { broker: { isSet: false } },
    ]);
  });

  it("upper-cases the symbol so the lookup matches what the writer stored", () => {
    assert.equal(
      manualHoldingWhere("u1", "tatamotors", "NSE").symbol,
      "TATAMOTORS"
    );
  });

  it("scopes to the user — never a cross-account merge", () => {
    const where = manualHoldingWhere("u-42", "INFY", "NSE");
    assert.equal(where.userId, "u-42");
    assert.equal(where.exchange, "NSE");
  });
});

describe("parseManualHoldingInput — the guard that stops NaN reaching a real row", () => {
  const valid = {
    symbol: "TATAMOTORS",
    exchange: "NSE",
    quantity: 10,
    averagePrice: 100,
  };

  it("accepts a well-formed payload and normalises it", () => {
    const r = parseManualHoldingInput({
      ...valid,
      symbol: " tatamotors ",
      exchange: "nse",
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      symbol: "TATAMOTORS",
      exchange: "NSE",
      quantity: 10,
      averagePrice: 100,
      currentPrice: null,
    });
  });

  it("REGRESSION: a missing quantity is REJECTED, not folded in as NaN", () => {
    // The exact live request: POST /api/holdings {"symbol":"TATAMOTORS"}.
    // Before the guard, `parseInt(undefined)` = NaN reached mergeManualHolding
    // and destroyed the row's quantity, cost basis and P&L.
    const r = parseManualHoldingInput({ symbol: "TATAMOTORS" });
    assert.equal(r.ok, false);
  });

  for (const bad of [
    NaN,
    Infinity,
    -Infinity,
    "abc",
    "",
    null,
    undefined,
    {},
    [],
  ]) {
    it(`rejects quantity = ${JSON.stringify(bad)}`, () => {
      assert.equal(
        parseManualHoldingInput({ ...valid, quantity: bad }).ok,
        false
      );
    });
  }

  for (const bad of [NaN, Infinity, "abc", "", null, undefined]) {
    it(`rejects averagePrice = ${JSON.stringify(bad)}`, () => {
      assert.equal(
        parseManualHoldingInput({ ...valid, averagePrice: bad }).ok,
        false
      );
    });
  }

  it("rejects zero and negative quantity — this endpoint only ADDS", () => {
    assert.equal(parseManualHoldingInput({ ...valid, quantity: 0 }).ok, false);
    assert.equal(parseManualHoldingInput({ ...valid, quantity: -5 }).ok, false);
  });

  it("ALLOWS averagePrice 0 — bonus and gifted shares are real positions", () => {
    const r = parseManualHoldingInput({ ...valid, averagePrice: 0 });
    assert.ok(r.ok);
    assert.equal(r.value.averagePrice, 0);
  });

  it("rejects negative averagePrice", () => {
    assert.equal(
      parseManualHoldingInput({ ...valid, averagePrice: -1 }).ok,
      false
    );
  });

  it('REGRESSION: a missing symbol is REJECTED, never coerced to "UNDEFINED"', () => {
    // `String(body.symbol).toUpperCase()` produced the literal "UNDEFINED", and
    // because manualHoldingWhere then matched on that string, every subsequent
    // malformed request merged into the SAME junk row and compounded it.
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      const r = parseManualHoldingInput({ ...valid, symbol: bad });
      assert.equal(
        r.ok,
        false,
        `symbol ${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it("treats an absent currentPrice as null — NOT as zero", () => {
    // The distinction is load-bearing: null means "keep the row's mark",
    // 0 would mean "this position is worthless".
    const r = parseManualHoldingInput(valid);
    assert.ok(r.ok);
    assert.equal(r.value.currentPrice, null);
  });

  it("accepts numeric strings, the shape a JSON body actually carries", () => {
    const r = parseManualHoldingInput({
      symbol: "INFY",
      exchange: "NSE",
      quantity: "10",
      averagePrice: "1500.25",
      currentPrice: "1600",
    });
    assert.ok(r.ok);
    assert.deepEqual(
      [r.value.quantity, r.value.averagePrice, r.value.currentPrice],
      [10, 1500.25, 1600]
    );
  });

  it("defaults exchange to NSE but never silently accepts a non-string", () => {
    const r = parseManualHoldingInput({ ...valid, exchange: 7 });
    assert.ok(r.ok);
    assert.equal(r.value.exchange, "NSE");
  });
});

describe("mergeManualHolding", () => {
  const existing = { quantity: 10, investedValue: 1000, currentPrice: 200 };

  it("weights the average across BOTH lots, not the mean of two averages", () => {
    // 10 @ 100 + 30 @ 200 = 40 units, 7000 invested -> 175, not (100+200)/2.
    const m = mergeManualHolding(existing, 30, 6000, 210);
    assert.equal(m.quantity, 40);
    assert.equal(m.investedValue, 7000);
    assert.equal(m.averagePrice, 175);
  });

  it("REGRESSION: a null currentPrice KEEPS the row's mark, never the lot cost", () => {
    // Adding 5 shares at cost 120 to a holding marked at 200 used to reset the
    // mark to 120 and show a fabricated loss until the next price refresh. A
    // cost price is not a mark and this endpoint does not revalue positions.
    const m = mergeManualHolding(existing, 5, 600, null);
    assert.equal(m.currentPrice, 200, "must keep the existing mark");
    assert.equal(m.currentValue, 15 * 200);
  });

  it("uses a supplied currentPrice when the caller genuinely has one", () => {
    assert.equal(mergeManualHolding(existing, 5, 600, 250).currentPrice, 250);
  });

  it("emits only FINITE money for every quotient it guards", () => {
    const m = mergeManualHolding(
      { quantity: 0, investedValue: 0, currentPrice: 0 },
      0,
      0,
      null
    );
    for (const [k, v] of Object.entries(m)) {
      assert.ok(Number.isFinite(v), `${k} must be finite, got ${v}`);
    }
  });

  it("derives P&L consistently with the values it emits", () => {
    const m = mergeManualHolding(existing, 10, 2000, 250);
    assert.equal(m.unrealizedPnL, m.currentValue - m.investedValue);
    assert.equal(m.pnlPercentage, (m.unrealizedPnL / m.investedValue) * 100);
  });
});

describe("newManualHoldingValues", () => {
  it("REGRESSION: a zero-cost lot yields 0%, never NaN", () => {
    // The API route's inline version divided by `averagePrice` with no guard,
    // so any bonus/gifted lot entered at cost 0 wrote NaN into pnlPercentage.
    const v = newManualHoldingValues({
      symbol: "X",
      exchange: "NSE",
      quantity: 10,
      averagePrice: 0,
      currentPrice: 50,
    });
    assert.equal(v.pnlPercentage, 0);
    for (const [k, n] of Object.entries(v)) {
      assert.ok(Number.isFinite(n), `${k} must be finite, got ${n}`);
    }
  });

  it("marks at cost when no currentPrice is supplied", () => {
    const v = newManualHoldingValues({
      symbol: "X",
      exchange: "NSE",
      quantity: 10,
      averagePrice: 100,
      currentPrice: null,
    });
    assert.equal(v.currentPrice, 100);
    assert.equal(v.unrealizedPnL, 0);
    assert.equal(v.pnlPercentage, 0);
  });
});

describe("META: the module header's SHARED claim is enforced, not asserted", () => {
  // An earlier revision's comment said the where-clause and arithmetic were
  // "SHARED with addHoldingAction" while holdings.ts still carried its own
  // inline copy — and named a function that does not exist. A comment that
  // asserts a de-duplication nobody performed is worse than no comment: it
  // stops the next reader from grepping for the second copy.
  const CALL_SITES = [
    "lib/actions/holdings.ts",
    "app/api/[[...path]]/route.ts",
  ];

  for (const rel of CALL_SITES) {
    it(`${rel} imports the shared module`, () => {
      const src = readCode(rel);
      assert.match(
        src,
        /holdings-dedup-logic/,
        `${rel} must import the shared dedup module, not re-implement it`
      );
    });

    it(`${rel} does not re-implement the broker OR-filter inline`, () => {
      const src = readCode(rel);
      assert.doesNotMatch(
        src,
        /OR:\s*\[\s*\{\s*broker:\s*null\s*\}/,
        `${rel} must call manualHoldingWhere() rather than inline the predicate`
      );
    });

    it(`${rel} does not re-implement the weighted-average division inline`, () => {
      const src = readCode(rel);
      assert.doesNotMatch(
        src,
        /averagePrice:\s*new(?:Invested|Total)\s*\/\s*new(?:Qty|Quantity)/,
        `${rel} must call mergeManualHolding() — the inline copy had no zero guard`
      );
    });
  }

  it("the header names a function that actually exists", () => {
    const header = readFileSync(
      join(REPO_WEB, "lib/actions/holdings-dedup-logic.ts"),
      "utf8"
    );
    const action = readFileSync(
      join(REPO_WEB, "lib/actions/holdings.ts"),
      "utf8"
    );
    const named = header.match(/`(add\w*HoldingAction)`/g) ?? [];
    assert.ok(named.length > 0, "header should name the calling action");
    for (const n of named) {
      const fn = n.replace(/`/g, "");
      assert.match(
        action,
        new RegExp(`export async function ${fn}\\b`),
        `header names ${fn}, which does not exist in holdings.ts`
      );
    }
  });
});
