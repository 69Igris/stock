/**
 * The subscription planner.
 *
 * The case worth being certain about is the eviction ORDER: a base symbol
 * someone actually holds must never be dropped to make room for a page view,
 * because an ephemeral expires on its own and a base entry does not come back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planSubscriptions,
  ephemeralTtlMs,
  stageShedsEphemerals,
  DEFAULT_MAX_SYMBOLS,
  DEFAULT_EPHEMERAL_TTL_MS,
  SHRUNK_EPHEMERAL_TTL_MS,
  type EphemeralEntry,
  type DegradeStage,
} from "../../src/market-data/tiingo/tiingo-rt-subscription-logic";
import { TIINGO_BYTES_LADDER } from "../../src/market-data/tiingo/tiingo-budget";

const NOW = Date.UTC(2026, 7, 31, 18, 0, 0);
const eph = (symbol: string, minutesLeft: number): EphemeralEntry => ({
  symbol,
  expiresAtMs: NOW + minutesLeft * 60_000,
});

describe("PREMISE: the defaults are the documented ones", () => {
  it("cap and TTL match what the deployment config assumes", () => {
    assert.equal(DEFAULT_MAX_SYMBOLS, 3000);
    assert.equal(DEFAULT_EPHEMERAL_TTL_MS, 15 * 60_000);
  });
});

describe("union and deltas", () => {
  it("subscribes the union and unsubscribes what left it", () => {
    const p = planSubscriptions({
      base: ["AAPL", "MSFT"],
      ephemeral: [eph("TSLA", 5)],
      current: ["MSFT", "GONE"],
      nowMs: NOW,
    });
    assert.deepEqual(p.effective, ["AAPL", "MSFT", "TSLA"]);
    assert.deepEqual(
      p.toSubscribe,
      ["AAPL", "TSLA"],
      "MSFT is already on the socket",
    );
    assert.deepEqual(p.toUnsubscribe, ["GONE"]);
  });

  it("normalises case and de-duplicates across both populations", () => {
    // The feed emits lower case; every other US surface here is upper. A symbol
    // present in both sets must be subscribed once, not twice.
    const p = planSubscriptions({
      base: ["aapl", "AAPL", " msft "],
      ephemeral: [eph("aapl", 5)],
      current: [],
      nowMs: NOW,
    });
    assert.deepEqual(p.effective, ["AAPL", "MSFT"]);
  });

  it("is stable — the same input twice produces the same plan", () => {
    // The socket applies these deltas. A plan that reshuffles under a stable
    // input would churn subscribe/unsubscribe traffic forever.
    const input = {
      base: ["MSFT", "AAPL"],
      ephemeral: [eph("TSLA", 3), eph("NVDA", 9)],
      current: ["AAPL"],
      nowMs: NOW,
    };
    assert.deepEqual(planSubscriptions(input), planSubscriptions(input));
  });
});

describe("expiry", () => {
  it("drops a lapsed ephemeral and reports it as EXPIRED, not evicted", () => {
    // The two mean different things: expiry is the design working, eviction is
    // the cap biting. Folding them together would hide a cap that is too small.
    const p = planSubscriptions({
      base: [],
      ephemeral: [eph("TSLA", -1), eph("NVDA", 5)],
      current: ["TSLA", "NVDA"],
      nowMs: NOW,
    });
    assert.deepEqual(p.effective, ["NVDA"]);
    assert.deepEqual(p.expired, ["TSLA"]);
    assert.deepEqual(p.evicted, []);
    assert.deepEqual(p.toUnsubscribe, ["TSLA"]);
  });

  it("an entry expiring exactly now is expired", () => {
    const p = planSubscriptions({
      base: [],
      ephemeral: [{ symbol: "TSLA", expiresAtMs: NOW }],
      current: [],
      nowMs: NOW,
    });
    assert.deepEqual(p.expired, ["TSLA"]);
  });
});

describe("the cap evicts EPHEMERALS, never BASE", () => {
  it("keeps every base symbol and evicts the page views", () => {
    // THE ordering decision. An ephemeral is about to expire anyway and costs a
    // page a few seconds of ticks; a base symbol is one somebody HOLDS, and
    // dropping it removes them from the staleness alarm, the bar series and the
    // portfolio quote with nothing to bring it back.
    const p = planSubscriptions({
      base: ["AAPL", "MSFT"],
      ephemeral: [eph("TSLA", 10), eph("NVDA", 2)],
      current: [],
      nowMs: NOW,
      maxSymbols: 3,
    });
    assert.ok(p.effective.includes("AAPL") && p.effective.includes("MSFT"));
    assert.equal(p.effective.length, 3);
    assert.deepEqual(p.evicted, ["NVDA"], "the soonest-to-expire goes first");
    assert.ok(p.effective.includes("TSLA"));
  });

  it("evicts the SOONEST-EXPIRING ephemeral first", () => {
    const p = planSubscriptions({
      base: [],
      ephemeral: [eph("A", 1), eph("B", 20), eph("C", 10)],
      current: [],
      nowMs: NOW,
      maxSymbols: 2,
    });
    assert.deepEqual(p.effective, ["B", "C"]);
    assert.deepEqual(p.evicted, ["A"]);
  });

  it("reports baseTruncated rather than quietly serving a short set", () => {
    // If base alone exceeds the cap that is a configuration problem. Reporting
    // it makes the number visible instead of inferable from a short set.
    const p = planSubscriptions({
      base: ["A", "B", "C", "D"],
      ephemeral: [],
      current: [],
      nowMs: NOW,
      maxSymbols: 2,
    });
    assert.equal(p.effective.length, 2);
    assert.equal(p.baseTruncated, 2);
  });

  it("baseTruncated is zero in the normal case", () => {
    const p = planSubscriptions({
      base: ["A"],
      ephemeral: [],
      current: [],
      nowMs: NOW,
    });
    assert.equal(p.baseTruncated, 0);
  });
});

describe("degradation ladder", () => {
  it("baseline-only drops every ephemeral but keeps base intact", () => {
    const p = planSubscriptions({
      base: ["AAPL"],
      ephemeral: [eph("TSLA", 10)],
      current: ["AAPL", "TSLA"],
      nowMs: NOW,
      stage: "baseline-only",
    });
    assert.deepEqual(p.effective, ["AAPL"]);
    assert.deepEqual(p.toUnsubscribe, ["TSLA"]);
  });

  it("shrink-ephemeral halves the window rather than dropping anyone", () => {
    // The cheapest rung: a user still watching keeps pinging and keeps their
    // symbol; a tab left open elsewhere falls off sooner.
    assert.equal(ephemeralTtlMs("none"), DEFAULT_EPHEMERAL_TTL_MS);
    assert.equal(ephemeralTtlMs("shrink-ephemeral"), 5 * 60_000);
    assert.equal(ephemeralTtlMs("baseline-only"), 0);
    assert.equal(ephemeralTtlMs("alarm"), 0);
  });

  it("shrink-ephemeral still subscribes the ephemerals it has", () => {
    const p = planSubscriptions({
      base: ["AAPL"],
      ephemeral: [eph("TSLA", 4)],
      current: [],
      nowMs: NOW,
      stage: "shrink-ephemeral",
    });
    assert.ok(
      p.effective.includes("TSLA"),
      "the rung shortens the TTL, it does not drop",
    );
  });
});

describe("empty and degenerate inputs", () => {
  it("an empty plan unsubscribes everything currently held", () => {
    const p = planSubscriptions({
      base: [],
      ephemeral: [],
      current: ["A", "B"],
      nowMs: NOW,
    });
    assert.deepEqual(p.effective, []);
    assert.deepEqual(p.toUnsubscribe, ["A", "B"]);
  });

  it("blank symbols are ignored rather than subscribed", () => {
    const p = planSubscriptions({
      base: ["", "   "],
      ephemeral: [eph("  ", 5)],
      current: [],
      nowMs: NOW,
    });
    assert.deepEqual(p.effective, []);
  });
});

describe("the degradation ladder is MONOTONIC and speaks one vocabulary", () => {
  const NOW2 = 1_760_000_000_000;
  const e = (symbol: string, minutes: number): EphemeralEntry => ({
    symbol,
    expiresAtMs: NOW2 + minutes * 60_000,
  });

  /**
   * Every rung the PRODUCER can emit, read from the producer's own table.
   *
   * Driven from `TIINGO_BYTES_LADDER` rather than a hand-written list on
   * purpose: a rung added there is covered here automatically. The two sides
   * previously disagreed on two of three rung NAMES — the producer said
   * `shrink-ephemeral-ttl` / `sp500-only`, this module said `shrink-ephemeral`
   * / `baseline-only` — and because both were independent string-literal
   * unions, TypeScript compared nothing and the mismatch was invisible until
   * runtime, where the unmatched rungs fell through to "no degradation at all".
   */
  const RUNGS: DegradeStage[] = [
    "none",
    ...TIINGO_BYTES_LADDER.map((r) => r.stage),
  ];

  it("every rung the budget guard emits is a stage this planner understands", () => {
    // `DegradeStage` is now DERIVED from `TiingoBytesStage`, so a rename is a
    // compile error rather than a silent fallthrough. This asserts the runtime
    // half: each rung must actually reach a branch, not the default.
    for (const stage of TIINGO_BYTES_LADDER.map((r) => r.stage)) {
      assert.notEqual(
        ephemeralTtlMs(stage),
        DEFAULT_EPHEMERAL_TTL_MS,
        `rung "${stage}" produced the UNDEGRADED ttl — it fell through to the default, ` +
          "which is what a vocabulary mismatch looks like from the inside",
      );
    }
  });

  it("escalating a rung never GROWS the subscribed set", () => {
    // The defect this replaces: `planSubscriptions` tested `stage === "baseline-only"`
    // while `ephemeralTtlMs` switched on both top rungs, so escalating from
    // `baseline-only` to `alarm` went from 1 symbol back to 3. A ladder whose
    // top rung sheds LESS than the one below it is worse than no ladder,
    // because it is invoked exactly when the budget is nearly gone.
    const sizes = RUNGS.map(
      (stage) =>
        planSubscriptions({
          base: ["AAPL"],
          ephemeral: [e("NVDA", 10), e("TSLA", 5)],
          current: [],
          nowMs: NOW2,
          stage,
        }).effective.length,
    );
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(
        sizes[i]! <= sizes[i - 1]!,
        `escalating ${RUNGS[i - 1]} -> ${RUNGS[i]} GREW the set ` +
          `(${sizes[i - 1]} -> ${sizes[i]}): ${JSON.stringify(sizes)}`,
      );
    }
    assert.deepEqual(
      sizes,
      [3, 3, 1, 1],
      "expected the shed to bite at baseline-only",
    );
  });

  it("escalating a rung never LENGTHENS the ephemeral ttl", () => {
    const ttls = RUNGS.map((s) => ephemeralTtlMs(s));
    for (let i = 1; i < ttls.length; i++) {
      assert.ok(
        ttls[i]! <= ttls[i - 1]!,
        `escalating ${RUNGS[i - 1]} -> ${RUNGS[i]} LENGTHENED the ttl: ${JSON.stringify(ttls)}`,
      );
    }
    assert.deepEqual(ttls, [
      DEFAULT_EPHEMERAL_TTL_MS,
      SHRUNK_EPHEMERAL_TTL_MS,
      0,
      0,
    ]);
  });

  it("alarm sheds at least as much as the rung below it", () => {
    // Named separately because `alarm` was the ONE rung whose string matched
    // across the two vocabularies, so it was the only one that ever reached
    // this planner — and it was the one that behaved backwards.
    assert.equal(stageShedsEphemerals("alarm"), true);
    assert.equal(stageShedsEphemerals("baseline-only"), true);
    assert.equal(stageShedsEphemerals("shrink-ephemeral"), false);
    assert.equal(stageShedsEphemerals("none"), false);
  });
});

describe("duplicate ephemeral interest does not consume cap slots", () => {
  const NOW3 = 1_760_000_000_000;
  const e = (symbol: string, minutes: number): EphemeralEntry => ({
    symbol,
    expiresAtMs: NOW3 + minutes * 60_000,
  });

  it("two pings for one symbol collapse to one subscription", () => {
    // Two tabs on the same stock is a normal race, and `norm()` is applied to
    // `base` and `current` but cannot be applied to {symbol, expiresAtMs}
    // records without deciding which expiry wins.
    const p = planSubscriptions({
      base: [],
      ephemeral: [e("aapl", 10), e("AAPL", 5), e("Aapl", 3)],
      current: [],
      nowMs: NOW3,
      maxSymbols: 5,
    });
    assert.deepEqual(p.effective, ["AAPL"]);
    assert.deepEqual(p.toSubscribe, ["AAPL"]);
  });

  it("a duplicate never evicts a DISTINCT symbol", () => {
    // The consequence that makes this more than tidiness: each copy used to
    // take a cap slot, so a popular symbol could push a different user's
    // symbol off the feed entirely.
    const p = planSubscriptions({
      base: [],
      ephemeral: [e("aapl", 10), e("AAPL", 9), e("NVDA", 8)],
      current: [],
      nowMs: NOW3,
      maxSymbols: 2,
    });
    assert.deepEqual(p.effective, ["AAPL", "NVDA"]);
    assert.deepEqual(
      p.evicted,
      [],
      "no distinct symbol should have been evicted",
    );
  });

  it("the surviving copy is the one with the MOST remaining life", () => {
    // Same rule the eviction policy uses everywhere else, so the two cannot
    // disagree about which of two copies matters.
    const p = planSubscriptions({
      base: [],
      ephemeral: [e("AAPL", 1), e("AAPL", 30)],
      current: [],
      nowMs: NOW3,
      maxSymbols: 1,
    });
    assert.deepEqual(p.effective, ["AAPL"]);
    assert.deepEqual(p.expired, []);
  });
});
