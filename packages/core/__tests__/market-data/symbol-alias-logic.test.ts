/**
 * UNIT TEST — former-symbol alias derivation (MONEY-1177).
 *
 * The load-bearing case is `rejects a concurrent variant`. Grouping by ISIN
 * alone would happily call CITIUSINVT-IV a "former symbol" of CITIUSINVT and
 * pollute search with it; the succession rule is the only thing that separates
 * a rename from two names that legitimately coexist under one ISIN.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSymbolSpans,
  decideAliases,
  mergeWithSeed,
  matchedAlias,
  withFormerlyHint,
  aliasGroupKey,
  MIN_OBSERVATIONS,
  type SymbolObservation,
} from "../../src/market-data/symbol-alias-logic";

const D = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();

const obs = (
  isin: string,
  symbol: string,
  dates: string[],
  exchange = "NSE",
): SymbolObservation[] =>
  dates.map((d) => ({ isin, symbol, exchange, date: D(d) }));

const active = (entries: Record<string, string[]>): Map<string, Set<string>> =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe("buildSymbolSpans", () => {
  it("collapses sightings into one span per symbol, sorted by first sighting", () => {
    const spans = buildSymbolSpans([
      ...obs("INE758T01015", "ETERNAL", ["2025-06-01", "2026-01-01"]),
      ...obs("INE758T01015", "ZOMATO", ["2021-08-01", "2024-01-01"]),
    ]);
    const g = spans.get(aliasGroupKey("INE758T01015", "NSE"))!;
    assert.equal(g.length, 2);
    assert.equal(g[0]!.symbol, "ZOMATO", "oldest first");
    assert.equal(g[0]!.firstSeen, D("2021-08-01"));
    assert.equal(g[0]!.lastSeen, D("2024-01-01"));
    assert.equal(g[0]!.observations, 2);
  });

  it("keeps NSE and BSE apart", () => {
    const spans = buildSymbolSpans([
      ...obs("X", "A", ["2020-01-01"], "NSE"),
      ...obs("X", "B", ["2020-01-01"], "BSE"),
    ]);
    assert.equal(spans.size, 2);
  });

  it("ignores rows with no ISIN (pre-1998 legacy files have no ISIN column)", () => {
    const spans = buildSymbolSpans([
      { isin: "", symbol: "ACC", exchange: "NSE", date: D("1995-10-05") },
    ]);
    assert.equal(spans.size, 0);
  });
});

describe("decideAliases", () => {
  const zomato = buildSymbolSpans([
    ...obs("INE758T01015", "ZOMATO", [
      "2021-08-01",
      "2023-01-01",
      "2024-01-01",
    ]),
    ...obs("INE758T01015", "ETERNAL", ["2025-06-01", "2026-01-01"]),
  ]);

  it("derives ZOMATO as a former symbol of ETERNAL", () => {
    const out = decideAliases(
      zomato,
      new Map([[aliasGroupKey("INE758T01015", "NSE"), "ETERNAL"]]),
      active({ NSE: ["ETERNAL"] }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.currentSymbol, "ETERNAL");
    assert.deepEqual(out[0]!.aliases, ["ZOMATO"]);
  });

  it("REJECTS a concurrent variant — the case ISIN-grouping alone gets wrong", () => {
    // Rights entitlements / series variants share an ISIN and trade at the SAME
    // time. A suffix blocklist would be a guess about NSE's naming; overlap is
    // a fact about the data.
    const spans = buildSymbolSpans([
      ...obs("INE999X01011", "CITIUSINVT", ["2026-01-01", "2026-04-01"]),
      ...obs("INE999X01011", "CITIUSINVT-IV", ["2026-01-01", "2026-04-01"]),
    ]);
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE999X01011", "NSE"), "CITIUSINVT"]]),
      active({ NSE: ["CITIUSINVT"] }),
    );
    assert.deepEqual(out[0]!.aliases, []);
    assert.equal(out[0]!.rejected[0]!.reason, "concurrent-variant");
  });

  it("rejects a ticker the exchange has since reassigned to a live company", () => {
    // Aliasing a reused ticker would route searches for the NEW company to the
    // old one — worse than having no alias.
    const spans = buildSymbolSpans([
      ...obs("INE111A01011", "OLDCO", ["2010-01-01", "2011-01-01"]),
      ...obs("INE111A01011", "NEWCO", ["2020-01-01", "2021-01-01"]),
    ]);
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE111A01011", "NSE"), "NEWCO"]]),
      active({ NSE: ["NEWCO", "OLDCO"] }), // OLDCO now belongs to someone else
    );
    assert.deepEqual(out[0]!.aliases, []);
    assert.equal(out[0]!.rejected[0]!.reason, "symbol-active-elsewhere");
  });

  it("rejects a single-sighting symbol as a probable bad parse", () => {
    const spans = buildSymbolSpans([
      ...obs("INE222A01011", "TYPO", ["2015-01-01"]),
      ...obs("INE222A01011", "REAL", ["2020-01-01", "2021-01-01"]),
    ]);
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE222A01011", "NSE"), "REAL"]]),
      active({ NSE: ["REAL"] }),
    );
    assert.deepEqual(out[0]!.aliases, []);
    assert.equal(out[0]!.rejected[0]!.reason, "single-observation");
    assert.ok(MIN_OBSERVATIONS >= 2);
  });

  it("chains multiple renames: A -> B -> C yields both A and B", () => {
    const spans = buildSymbolSpans([
      ...obs("INE333A01011", "AAA", ["2010-01-01", "2011-01-01"]),
      ...obs("INE333A01011", "BBB", ["2015-01-01", "2016-01-01"]),
      ...obs("INE333A01011", "CCC", ["2020-01-01", "2021-01-01"]),
    ]);
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE333A01011", "NSE"), "CCC"]]),
      active({ NSE: ["CCC"] }),
    );
    assert.deepEqual(out[0]!.aliases, ["AAA", "BBB"]);
  });

  it("still derives when the CURRENT symbol postdates every sample", () => {
    // Rename happened after the last archived file we sampled: treat the
    // current symbol as starting at +Infinity, so predecessors still resolve.
    const spans = buildSymbolSpans([
      ...obs("INE444A01011", "OLDNAME", ["2024-01-01", "2025-01-01"]),
      ...obs("INE444A01011", "MIDNAME", ["2025-06-01", "2025-07-01"]),
    ]);
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE444A01011", "NSE"), "BRANDNEW"]]),
      active({ NSE: ["BRANDNEW"] }),
    );
    assert.deepEqual(out[0]!.aliases, ["MIDNAME", "OLDNAME"]);
  });

  it("skips a group with no active instrument holding the ISIN", () => {
    const spans = buildSymbolSpans([
      ...obs("INE555A01011", "GONE1", ["2010-01-01", "2011-01-01"]),
      ...obs("INE555A01011", "GONE2", ["2015-01-01", "2016-01-01"]),
    ]);
    assert.deepEqual(decideAliases(spans, new Map(), active({})), []);
  });

  it("skips an ISIN that only ever had one name", () => {
    const spans = buildSymbolSpans(
      obs("INE666A01011", "STABLE", ["2010-01-01", "2020-01-01"]),
    );
    const out = decideAliases(
      spans,
      new Map([[aliasGroupKey("INE666A01011", "NSE"), "STABLE"]]),
      active({ NSE: ["STABLE"] }),
    );
    assert.deepEqual(out, []);
  });
});

describe("mergeWithSeed", () => {
  it("adds a seeded alias that ISIN-grouping cannot see (TATAMOTORS -> TMCV)", () => {
    // TMCV is a NEW security with a NEW ISIN, so nothing links it to
    // TATAMOTORS in the archive. Only human knowledge of the demerger does.
    const merged = mergeWithSeed(
      [],
      new Map([["TMCV::NSE", ["TATAMOTORS"]]]),
      active({ NSE: ["TMCV", "TMPV"] }),
    );
    assert.deepEqual(merged.get("TMCV::NSE"), ["TATAMOTORS"]);
  });

  it("lets a demerger produce the SAME alias on two successors", () => {
    const merged = mergeWithSeed(
      [
        {
          isin: "INE155A01022",
          exchange: "NSE",
          currentSymbol: "TMPV",
          aliases: ["TATAMOTORS"],
          rejected: [],
        },
      ],
      new Map([["TMCV::NSE", ["TATAMOTORS"]]]),
      active({ NSE: ["TMCV", "TMPV"] }),
    );
    assert.deepEqual(merged.get("TMPV::NSE"), ["TATAMOTORS"]);
    assert.deepEqual(merged.get("TMCV::NSE"), ["TATAMOTORS"]);
  });

  it("never writes an alias that is a live ticker, even from the seed", () => {
    const merged = mergeWithSeed(
      [],
      new Map([["NEWCO::NSE", ["STILLTRADING"]]]),
      active({ NSE: ["NEWCO", "STILLTRADING"] }),
    );
    assert.equal(merged.get("NEWCO::NSE"), undefined);
  });

  it("never lets an instrument alias its own current symbol", () => {
    const merged = mergeWithSeed(
      [],
      new Map([["ACME::NSE", ["ACME", "OLDACME"]]]),
      active({ NSE: ["ACME"] }),
    );
    assert.deepEqual(merged.get("ACME::NSE"), ["OLDACME"]);
  });

  it("unions derived and seeded aliases for the same instrument", () => {
    const merged = mergeWithSeed(
      [
        {
          isin: "INE777A01011",
          exchange: "NSE",
          currentSymbol: "ACME",
          aliases: ["ACMEOLD"],
          rejected: [],
        },
      ],
      new Map([["ACME::NSE", ["ACMEANCIENT"]]]),
      active({ NSE: ["ACME"] }),
    );
    assert.deepEqual(merged.get("ACME::NSE"), ["ACMEANCIENT", "ACMEOLD"]);
  });
});

describe("matchedAlias / withFormerlyHint", () => {
  it("names the alias that matched, so the UI can explain itself", () => {
    // Without this a user who searched ZOMATO sees a result called ETERNAL and
    // no reason why — which reads as a bug rather than a rename.
    assert.equal(matchedAlias(["ZOMATO"], "zomato"), "ZOMATO");
    assert.equal(
      withFormerlyHint("Eternal Limited", ["ZOMATO"], "zomato"),
      "Eternal Limited (formerly ZOMATO)",
    );
  });

  it("leaves a normal symbol hit untouched", () => {
    assert.equal(matchedAlias(["ZOMATO"], "ETERNAL"), null);
    assert.equal(
      withFormerlyHint("Eternal Limited", ["ZOMATO"], "ETERNAL"),
      "Eternal Limited",
    );
  });

  it("is safe on instruments with no aliases and on an empty query", () => {
    assert.equal(matchedAlias([], "X"), null);
    assert.equal(matchedAlias(undefined, "X"), null);
    assert.equal(matchedAlias(["ZOMATO"], "   "), null);
    assert.equal(withFormerlyHint("Acme", null, "acme"), "Acme");
  });

  it("matches exactly, never by prefix (mirrors the `has` lookup)", () => {
    // The DB query is an exact array-element match; the label must not claim a
    // hit the query could not have produced.
    assert.equal(matchedAlias(["ZOMATO"], "ZOM"), null);
  });
});
