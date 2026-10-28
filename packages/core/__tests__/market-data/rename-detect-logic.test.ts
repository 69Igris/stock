/**
 * UNIT TEST — rename detection at deactivation time (MONEY-1177).
 *
 * The case that matters most is `refuses an AMBIGUOUS match`. A missed rename
 * costs a chart; a WRONG one grafts one company's price history onto another,
 * which is unrecoverable without knowing it happened. So ambiguity must resolve
 * to "not a rename", never to a best guess.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectRenames,
  nextPreviousSymbols,
  type ActiveInstrument,
  type StaleInstrument,
} from "../../src/market-data/instruments/rename-detect-logic";

const stale = (
  symbol: string,
  isin: string | null,
  exchange = "NSE",
): StaleInstrument => ({ id: `old-${symbol}`, symbol, exchange, isin });

const live = (
  symbol: string,
  isin: string | null,
  exchange = "NSE",
  previousSymbols: string[] = [],
): ActiveInstrument => ({
  id: `new-${symbol}`,
  symbol,
  exchange,
  isin,
  previousSymbols,
});

describe("detectRenames", () => {
  it("matches a stale row to the active row carrying its ISIN", () => {
    const { renames, plainStale } = detectRenames(
      [stale("ZOMATO", "INE758T01015")],
      [live("ETERNAL", "INE758T01015")],
    );
    assert.equal(renames.length, 1);
    assert.equal(renames[0]!.from.symbol, "ZOMATO");
    assert.equal(renames[0]!.to.symbol, "ETERNAL");
    assert.equal(plainStale.length, 0);
  });

  it("treats a genuine delisting as plain stale", () => {
    const { renames, plainStale } = detectRenames(
      [stale("DEADCO", "INE999Z01011")],
      [live("SOMEONEELSE", "INE111A01011")],
    );
    assert.equal(renames.length, 0);
    assert.deepEqual(
      plainStale.map((s) => s.symbol),
      ["DEADCO"],
    );
  });

  it("refuses an AMBIGUOUS match rather than guessing", () => {
    // Two active rows somehow share the ISIN. Picking one would graft decades
    // of price history onto a company at random.
    const { renames, plainStale } = detectRenames(
      [stale("OLDCO", "INE155A01022")],
      [live("SUCC1", "INE155A01022"), live("SUCC2", "INE155A01022")],
    );
    assert.equal(renames.length, 0);
    assert.equal(plainStale.length, 1);
  });

  it("never guesses when the stale row has NO ISIN", () => {
    // The only alternative would be name similarity, and a wrong match here is
    // silent data corruption.
    const { renames, plainStale } = detectRenames(
      [stale("MYSTERY", null)],
      [live("PLAUSIBLE", "INE111A01011")],
    );
    assert.equal(renames.length, 0);
    assert.equal(plainStale.length, 1);
  });

  it("does not match across exchanges", () => {
    // One ISIN legitimately lists on BOTH NSE and BSE; a stale NSE row is not
    // renamed just because a BSE row shares its ISIN.
    const { renames, plainStale } = detectRenames(
      [stale("THING", "INE222A01011", "NSE")],
      [live("OTHER", "INE222A01011", "BSE")],
    );
    assert.equal(renames.length, 0);
    assert.equal(plainStale.length, 1);
  });

  it("ignores the dual listing and still finds the same-exchange rename", () => {
    const { renames } = detectRenames(
      [stale("ZOMATO", "INE758T01015", "NSE")],
      [
        live("ETERNAL", "INE758T01015", "NSE"),
        live("ETERNAL", "INE758T01015", "BSE"),
      ],
    );
    assert.equal(renames.length, 1);
    assert.equal(renames[0]!.to.exchange, "NSE");
  });

  it("is not confused by a row that merely re-appeared under the same symbol", () => {
    // Same symbol + same ISIN is the row itself, not a successor.
    const { renames, plainStale } = detectRenames(
      [stale("SAME", "INE333A01011")],
      [live("SAME", "INE333A01011")],
    );
    assert.equal(renames.length, 0);
    assert.equal(plainStale.length, 1);
  });

  it("handles a batch of mixed outcomes in one pass", () => {
    const { renames, plainStale } = detectRenames(
      [
        stale("ZOMATO", "INE758T01015"),
        stale("GONE", "INE444A01011"),
        stale("NOISIN", null),
      ],
      [live("ETERNAL", "INE758T01015")],
    );
    assert.deepEqual(
      renames.map((r) => r.from.symbol),
      ["ZOMATO"],
    );
    assert.deepEqual(plainStale.map((s) => s.symbol).sort(), [
      "GONE",
      "NOISIN",
    ]);
  });
});

describe("nextPreviousSymbols", () => {
  it("adds the predecessor's symbol", () => {
    assert.deepEqual(nextPreviousSymbols(live("ETERNAL", "X"), "ZOMATO"), [
      "ZOMATO",
    ]);
  });

  it("carries the predecessor's OWN aliases forward (A -> B -> C)", () => {
    // Without this, renaming twice loses the oldest name and the ticker users
    // actually remember stops resolving.
    assert.deepEqual(nextPreviousSymbols(live("CCC", "X"), "BBB", ["AAA"]), [
      "AAA",
      "BBB",
    ]);
  });

  it("returns null when nothing would change (no pointless write)", () => {
    assert.equal(
      nextPreviousSymbols(live("ETERNAL", "X", "NSE", ["ZOMATO"]), "ZOMATO"),
      null,
    );
  });

  it("never lets an instrument alias its own symbol", () => {
    assert.equal(nextPreviousSymbols(live("ACME", "X"), "acme"), null);
  });

  it("normalises case and dedupes", () => {
    assert.deepEqual(
      nextPreviousSymbols(live("NEW", "X", "NSE", ["OLD"]), "old", ["Older"]),
      ["OLD", "OLDER"],
    );
  });
});
