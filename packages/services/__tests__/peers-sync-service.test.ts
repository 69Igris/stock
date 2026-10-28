/**
 * MONEY-1145 — peers sync service seam.
 *
 * The ranking rules are covered exhaustively by the pure
 * `peer-selection-logic.test.ts`. What is NOT covered there, and what actually
 * broke the ORIGINAL peers writer, lives at this seam:
 *
 *   - the sentinel `instrumentId: "000000000000000000000000"` the research
 *     writer stored when it could not resolve an instrument, producing rows no
 *     reader querying by instrumentId could ever match;
 *   - the `source` field, which defaults to the vendor name `"TICKERTAPE"` in
 *     the schema — inheriting it for rows we computed ourselves would be both
 *     wrong and a regression of MONEY-1144, which removed vendor names from the
 *     product surface;
 *   - writing empty results rather than skipping them, which is what makes
 *     "no row" mean *not computed* and "0 peers" mean *computed, none found*.
 *
 * Source-level assertions, because the service reaches Prisma directly and a
 * behavioural test would need a live Mongo. Every pattern below is
 * WHITESPACE-TOLERANT on purpose: prettier runs in the commit hook, so an
 * assertion that requires a particular line break passes locally and fails
 * the moment the file is formatted. That is exactly how this file first broke.
 *
 * Comments are stripped first so a mention in prose cannot satisfy an assertion
 * about code — the LINE-before-BLOCK ordering is MONEY-1143.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PEERS_SOURCE, buildRatioLookup } from "../src/peers-sync.service";

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const SRC = stripComments(
  readFileSync(
    fileURLToPath(new URL("../src/peers-sync.service.ts", import.meta.url)),
    "utf8",
  ),
);

describe("MONEY-1145 — peers sync service", () => {
  it("[regression] never writes the sentinel instrumentId", () => {
    // The original writer's worst failure: a row that EXISTS and is invisible.
    assert.ok(
      !SRC.includes("000000000000000000000000"),
      "the sentinel id must not appear in code — rows written under it are " +
        "unreachable by any reader querying instrumentId",
    );
    // And it must actively skip rather than invent one.
    assert.match(
      SRC,
      /if\s*\(!instrumentId\)\s*return false/,
      "an unresolvable instrument must be skipped, not given a placeholder id",
    );
  });

  it("[regression] stamps its own provenance, not the schema's vendor default", () => {
    assert.equal(
      PEERS_SOURCE,
      "DERIVED",
      "rows we compute must not claim a third-party source",
    );
    assert.ok(
      !/["']TICKERTAPE["']/.test(SRC),
      "MONEY-1144 removed vendor names from the product surface; inheriting " +
        "the schema default would put one back",
    );
    // Set on BOTH branches — a create that omits it silently inherits
    // `@default("TICKERTAPE")` from the schema.
    const stamps = (SRC.match(/source: PEERS_SOURCE/g) ?? []).length;
    assert.equal(
      stamps,
      2,
      `source must be set on both the create and the update branch, found ${stamps}`,
    );
  });

  it("upserts on the NATURAL key, not the mutable instrumentId FK", () => {
    // The whole of MONEY-1145: instrumentId is denormalised and re-seeding
    // instrument_mappings silently orphans every dependent row.
    assert.match(SRC, /symbol_exchange:\s*\{\s*symbol:/);
  });

  it("writes empty results rather than skipping them", () => {
    // "no row" = not computed yet; "row with 0 peers" = computed, genuinely
    // none. Skipping empties collapses those two, which is exactly why the tab
    // could sit empty unnoticed — and leaves a re-classified instrument
    // serving its old peers forever.
    assert.ok(
      !/peers\.length === 0[\s\S]{0,40}(return|continue)/.test(SRC),
      "empty peer sets must still be written",
    );
    assert.match(SRC, /peerCount: peers\.length/);
  });

  it("bounds its write fan-out", () => {
    assert.match(
      SRC,
      /mapWithConcurrency\(/,
      "thousands of upserts must not go out unbounded — it stampedes the pool",
    );
    assert.ok(
      !/Promise\.all\(\s*rows/.test(SRC),
      "rows must not be fanned out with an unbounded Promise.all",
    );
  });

  it("skips the SECTOR_SKIPPED sentinel via the shared helper", () => {
    // NOT `sector: { not: null }` — 14,893 of 22,153 instruments carry "N/A",
    // and that naive test treats every one of them as classified.
    assert.match(SRC, /hasRealSector\(/);
    assert.ok(
      !/sector:\s*\{\s*not:\s*null\s*\}/.test(SRC),
      'a `sector != null` filter counts the "N/A" sentinel as a real sector',
    );
  });
});

/**
 * MONEY-1255 — the BSE half of `stock_peers` was entirely blank.
 *
 * `stock_ratios` is keyed to NSE symbols; `instrument_mappings` has a row per
 * LISTING. The lookup used the exact (symbol, exchange) key, so every BSE
 * instrument missed and its peers row was written `marketCap: null, pe: null,
 * roe: null` — with `changePercent` populated, because that one joins on
 * `instrumentId`. Confirmed in prod on every BSE row.
 *
 * That signature is worth naming: THREE of four numeric columns null and the
 * fourth fine is not "no data yet", it is a JOIN that missed. An all-null row
 * would have looked like a sync that had not run.
 *
 * Behavioural, not source-level: `buildRatioLookup` is pure, so unlike the rest
 * of this file it can be fed the real adversarial shape.
 */
describe("MONEY-1255 — ratios resolve across listings of one company", () => {
  type Row = {
    symbol: string;
    exchange: string;
    marketCap: number | null;
    pe: number | null;
    roe: number | null;
  };
  const nse: Row = {
    symbol: "APOLLOTYRE",
    exchange: "NSE",
    marketCap: 28_023.35,
    pe: 24.1,
    roe: 12.4,
  };

  it("[regression] a BSE listing resolves to the company's NSE ratios", () => {
    // The exact prod failure: this returned undefined, so the peers row got
    // three nulls and the BSE side of the tab rendered blank.
    const lookup = buildRatioLookup([nse]);
    const got = lookup("APOLLOTYRE", "BSE");
    assert.deepEqual(got, nse);
    assert.equal(
      got?.marketCap,
      28_023.35,
      "marketCap must survive the fallback — in CRORES, unscaled",
    );
  });

  it("an exact venue-specific row still WINS over the fallback", () => {
    // The fallback may only fill a null; it must never displace a real row.
    const bse: Row = { ...nse, exchange: "BSE", marketCap: 1, pe: 2, roe: 3 };
    const lookup = buildRatioLookup([nse, bse]);
    assert.deepEqual(lookup("APOLLOTYRE", "BSE"), bse);
    assert.deepEqual(lookup("APOLLOTYRE", "NSE"), nse);
  });

  it("resolves an NSE listing to its own row, unchanged", () => {
    assert.deepEqual(buildRatioLookup([nse])("APOLLOTYRE", "NSE"), nse);
  });

  it("[regression] the fallback is ONE-WAY — non-NSE rows never leak", () => {
    // If the fallback index were built from every row instead of NSE-only, two
    // different companies sharing a ticker across venues would resolve to each
    // other — inventing fundamentals, which is worse than the null it fixes.
    const bseOnly: Row = { ...nse, exchange: "BSE" };
    const lookup = buildRatioLookup([bseOnly]);
    assert.equal(
      lookup("APOLLOTYRE", "NSE"),
      undefined,
      "a BSE-only row must not answer for an NSE listing",
    );
    assert.equal(
      lookup("APOLLOTYRE", "MCX"),
      undefined,
      "nor for any other venue",
    );
  });

  it("returns undefined for an unknown symbol rather than inventing a row", () => {
    const lookup = buildRatioLookup([nse]);
    assert.equal(lookup("NOTLISTED", "NSE"), undefined);
    assert.equal(lookup("NOTLISTED", "BSE"), undefined);
    assert.equal(lookup("", ""), undefined);
  });

  it("does not confuse two symbols that share a key separator boundary", () => {
    // `symbolExchangeKey` joins on NUL precisely so "AB"+"CD" and "A"+"BCD"
    // cannot collide. Pinned here because the fallback added a SECOND index.
    const a: Row = { ...nse, symbol: "AB", exchange: "NSE" };
    const b: Row = { ...nse, symbol: "A", exchange: "BNSE", marketCap: 999 };
    const lookup = buildRatioLookup([a, b]);
    assert.deepEqual(lookup("AB", "NSE"), a);
    assert.deepEqual(lookup("A", "BNSE"), b);
  });
});
