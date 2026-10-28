/**
 * MONEY-1145 — peer selection.
 *
 * `stock_peers` was empty platform-wide (0 rows) because nothing wrote it
 * outside a StockSage research pass. These cases pin the selection rules that
 * replace it, and in particular the two that are traps rather than preferences:
 * cross-exchange self-matching, and linear-vs-log market-cap distance.
 *
 * All pure — no DB, no network, no clock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasRealSector,
  marketCapDistance,
  indexUniverse,
  selectPeers,
  MIN_INDUSTRY_GROUP,
  MAX_PEERS,
  type PeerCandidate,
} from "../../src/market-data/instruments/peer-selection-logic";
import { SECTOR_SKIPPED } from "../../src/market-data/instruments/sector-enrichment-logic";

function c(symbol: string, opts: Partial<PeerCandidate> = {}): PeerCandidate {
  return {
    symbol,
    exchange: "NSE",
    name: `${symbol} Ltd`,
    sector: "Healthcare",
    industry: "Pharmaceuticals",
    marketCap: 10_000,
    pe: 20,
    roe: 15,
    changePercent: 1,
    ...opts,
  };
}

/** Build a group of `n` members big enough to clear MIN_INDUSTRY_GROUP. */
function group(prefix: string, n: number, opts: Partial<PeerCandidate> = {}) {
  return Array.from({ length: n }, (_, i) =>
    c(`${prefix}${i}`, { marketCap: 1_000 * (i + 1), ...opts }),
  );
}

describe("MONEY-1145 — hasRealSector", () => {
  it('rejects the SECTOR_SKIPPED sentinel "N/A"', () => {
    // 14,893 of 22,153 active instruments carry this. Treating it as a sector
    // would bucket them all together and give every one of them peers drawn
    // from that soup — `sector: { not: null }` is exactly the naive test
    // holdings.service.ts:195 already warns about.
    assert.equal(SECTOR_SKIPPED, "N/A", "sentinel moved — update this module");
    assert.equal(hasRealSector(SECTOR_SKIPPED), false);
    assert.equal(hasRealSector("N/A"), false);
  });

  it("rejects null, undefined and empty", () => {
    assert.equal(hasRealSector(null), false);
    assert.equal(hasRealSector(undefined), false);
    assert.equal(hasRealSector(""), false);
  });

  it("accepts a real sector", () => {
    assert.equal(hasRealSector("Healthcare"), true);
  });
});

describe("MONEY-1145 — marketCapDistance", () => {
  it("[regression] is LOG scale, not linear", () => {
    // The whole point. 5,000 -> 10,000 is the same 2x step as
    // 50,000 -> 100,000, so they must score equally. Under linear distance the
    // second pair would be 10x "further apart", and every large-cap's peer set
    // would collapse onto whichever giants sit closest in absolute rupees.
    const near = marketCapDistance(5_000, 10_000);
    const far = marketCapDistance(50_000, 100_000);
    assert.ok(near !== null && far !== null);
    assert.ok(
      Math.abs(near - far) < 1e-9,
      `same multiple must score the same: ${near} vs ${far}`,
    );
  });

  it("is symmetric and zero for identical caps", () => {
    assert.equal(marketCapDistance(1_000, 1_000), 0);
    assert.equal(marketCapDistance(400, 900), marketCapDistance(900, 400));
  });

  it("returns null rather than a number for unusable input", () => {
    // null (not 0) so the caller can rank these LAST. A missing cap treated as
    // distance 0 would jump straight to the front of the peer list.
    assert.equal(marketCapDistance(null, 100), null);
    assert.equal(marketCapDistance(100, undefined), null);
    assert.equal(marketCapDistance(NaN, 100), null);
    assert.equal(marketCapDistance(Infinity, 100), null);
    assert.equal(marketCapDistance(0, 100), null, "0 is bad data, not tiny");
    assert.equal(marketCapDistance(-5, 100), null);
  });
});

describe("MONEY-1145 — selectPeers", () => {
  it("[regression] never returns the same company listed on another exchange", () => {
    // The trap: NSE and BSE list many of the same companies. Ranking across
    // exchanges hands RELIANCE-NSE its own BSE listing — identical market cap,
    // so a perfect score, so rank 1. Every dual-listed company's peer list
    // would open with itself.
    const universe = [
      c("RELIANCE", { exchange: "NSE", marketCap: 1_900_000 }),
      c("RELIANCE", { exchange: "BSE", marketCap: 1_900_000 }),
      ...group("NSEPEER", MIN_INDUSTRY_GROUP, { exchange: "NSE" }),
    ];
    const target = universe[0]!;
    const peers = selectPeers(target, indexUniverse(universe));

    assert.ok(peers.length > 0, "sanity: the target should get peers at all");
    assert.equal(
      peers.filter((p) => p.symbol === "RELIANCE").length,
      0,
      "the target's own symbol must never appear, on ANY exchange",
    );
  });

  it("ranks nearest market cap first", () => {
    const target = c("TARGET", { marketCap: 10_000 });
    const universe = [
      target,
      c("FAR", { marketCap: 1 }),
      c("NEAR", { marketCap: 11_000 }),
      c("MID", { marketCap: 30_000 }),
      c("ALSOFAR", { marketCap: 5_000_000 }),
      c("PAD", { marketCap: 12_000 }),
    ];
    const peers = selectPeers(target, indexUniverse(universe));
    assert.equal(peers[0]!.symbol, "NEAR");
    assert.equal(peers[1]!.symbol, "PAD");
  });

  it("sorts unrankable peers LAST, not first", () => {
    const target = c("TARGET", { marketCap: 10_000 });
    const universe = [
      target,
      c("NOCAP", { marketCap: null }),
      c("ZEROCAP", { marketCap: 0 }),
      ...group("REAL", MIN_INDUSTRY_GROUP),
    ];
    const peers = selectPeers(target, indexUniverse(universe));
    const names = peers.map((p) => p.symbol);
    const firstBad = Math.min(
      names.indexOf("NOCAP") === -1 ? Infinity : names.indexOf("NOCAP"),
      names.indexOf("ZEROCAP") === -1 ? Infinity : names.indexOf("ZEROCAP"),
    );
    const lastGood = Math.max(
      ...names.map((n, i) => (n.startsWith("REAL") ? i : -1)),
    );
    assert.ok(
      firstBad > lastGood,
      `unrankable peers must follow every rankable one: ${names.join(", ")}`,
    );
  });

  it("widens from industry to sector when the industry group is too thin", () => {
    const target = c("SOLO", { industry: "Tiny Niche", marketCap: 10_000 });
    const universe = [
      target,
      c("ALSOSOLO", { industry: "Tiny Niche", marketCap: 9_000 }),
      // Same SECTOR, different industry — only reachable via the widening.
      ...group("SIB", 6, { industry: "Pharmaceuticals" }),
    ];
    const peers = selectPeers(target, indexUniverse(universe));
    assert.ok(
      peers.some((p) => p.symbol.startsWith("SIB")),
      "a 2-member industry must widen to the sector rather than return 1 peer",
    );
  });

  it("stays inside the industry when it IS big enough", () => {
    const target = c("T", { industry: "Pharmaceuticals", marketCap: 10_000 });
    const universe = [
      target,
      ...group("PHARMA", MIN_INDUSTRY_GROUP, { industry: "Pharmaceuticals" }),
      ...group("OTHER", 50, { industry: "Hospitals" }),
    ];
    const peers = selectPeers(target, indexUniverse(universe));
    assert.ok(
      peers.every((p) => p.symbol.startsWith("PHARMA")),
      "a big-enough industry must not leak sector siblings in",
    );
  });

  it('returns [] for a "N/A" sector rather than peers from the 14,893-row soup', () => {
    const target = c("UNKNOWN", { sector: SECTOR_SKIPPED });
    const universe = [target, ...group("X", 10, { sector: SECTOR_SKIPPED })];
    assert.deepEqual(selectPeers(target, indexUniverse(universe)), []);
  });

  it("caps at MAX_PEERS, matching the reader's slice(0, 12)", () => {
    const target = c("T", { marketCap: 10_000 });
    const universe = [target, ...group("P", 40)];
    const peers = selectPeers(target, indexUniverse(universe));
    assert.equal(peers.length, MAX_PEERS);
  });

  it("[regression] is DETERMINISTIC — ties break on symbol", () => {
    // This job re-runs daily and upserts. A non-deterministic order would
    // rewrite every row every run, churning updatedAt across the collection and
    // making "did peers actually change?" unanswerable.
    const target = c("T", { marketCap: 10_000 });
    const tied = ["ZZZ", "AAA", "MMM"].map((s) => c(s, { marketCap: 10_000 }));
    const first = selectPeers(
      target,
      indexUniverse([target, ...tied, ...group("P", 5)]),
    );
    const shuffled = selectPeers(
      target,
      indexUniverse([target, ...[...tied].reverse(), ...group("P", 5)]),
    );
    assert.deepEqual(first, shuffled, "input order must not change the output");

    const tiedOut = first.filter((p) =>
      ["AAA", "MMM", "ZZZ"].includes(p.symbol),
    );
    assert.deepEqual(
      tiedOut.map((p) => p.symbol),
      ["AAA", "MMM", "ZZZ"],
      "equal distances must order alphabetically",
    );
  });

  it("carries the metrics through unchanged", () => {
    // marketCap stays in CRORES end to end — the reader formats it with
    // formatMarketCapCrores, and re-scaling here would resurrect MONEY-1144.
    const target = c("T", { marketCap: 10_000 });
    const peer = c("P", {
      marketCap: 9_000,
      pe: 33.5,
      roe: 12.25,
      changePercent: -1.5,
    });
    const peers = selectPeers(
      target,
      indexUniverse([target, peer, ...group("Q", 5)]),
    );
    const got = peers.find((p) => p.symbol === "P");
    assert.deepEqual(got, {
      symbol: "P",
      name: "P Ltd",
      marketCap: 9_000,
      pe: 33.5,
      roe: 12.25,
      changePercent: -1.5,
    });
  });

  it("an instrument with no group at all gets [], not a crash", () => {
    const target = c("LONELY", { sector: "Nowhere", industry: "Nothing" });
    assert.deepEqual(selectPeers(target, indexUniverse([target])), []);
  });
});
