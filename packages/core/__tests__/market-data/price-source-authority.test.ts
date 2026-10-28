/**
 * UNIT TEST — DailyPrice source precedence (MONEY-1175).
 *
 * This is the second time the same defect class has shipped: a writer deciding
 * "may I overwrite this row?" locally, with no declared authority model.
 * MONEY-1093 was the instrument-master version (Zerodha's dump overwriting
 * `series` / `instrumentType` it could not actually determine, reverting every
 * deliberate retype within 24h) and produced `InstrumentProvider.mapToUpdate` —
 * see instrument-provider-authority.test.ts. This is the DailyPrice version.
 *
 * The regression test that matters is `upgrades a YAHOO row` further down: it
 * is the exact production scenario, and nothing in the suite asserted it before,
 * which is precisely why 7,646 Yahoo rows could hold RELIANCE's history hostage
 * while the job reported success every night.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_SOURCE_AUTHORITY,
  UNKNOWN_SOURCE_AUTHORITY,
  priceSourceAuthority,
  shouldUpgradePriceSource,
  partitionPriceWrites,
} from "../../src/market-data/price-source-authority";

interface Row {
  instrumentId: string;
  close: number;
}
const row = (instrumentId: string, close = 100): Row => ({
  instrumentId,
  close,
});
const existingMap = (
  entries: Array<[string, string | null]>,
): Map<string, { id: string; source: string | null }> =>
  new Map(entries.map(([iid, source]) => [iid, { id: `oid-${iid}`, source }]));

describe("price source authority", () => {
  it("ranks the exchange above the broker above the redistributor", () => {
    assert.ok(
      priceSourceAuthority("BHAVCOPY") > priceSourceAuthority("ZERODHA"),
      "exchange must outrank broker",
    );
    assert.ok(
      priceSourceAuthority("ZERODHA") > priceSourceAuthority("YAHOO"),
      "broker must outrank third-party redistributor",
    );
    assert.ok(
      priceSourceAuthority("YAHOO") > priceSourceAuthority("SOMETHING_NEW"),
      "a known source must outrank an unrecognised one",
    );
  });

  it("treats BHAVCOPY and BHAVCOPY_HIST as EQUAL", () => {
    // Same exchange file, two ingest paths. If these ever diverge, a historical
    // replay starts clobbering the nightly copy of the same day (or vice
    // versa) and re-parsing stops being idempotent.
    assert.equal(
      PRICE_SOURCE_AUTHORITY.BHAVCOPY,
      PRICE_SOURCE_AUTHORITY.BHAVCOPY_HIST,
    );
  });

  it("does not upgrade at EQUAL authority, in either direction", () => {
    assert.equal(shouldUpgradePriceSource("BHAVCOPY", "BHAVCOPY_HIST"), false);
    assert.equal(shouldUpgradePriceSource("BHAVCOPY_HIST", "BHAVCOPY"), false);
    assert.equal(
      shouldUpgradePriceSource("BHAVCOPY_HIST", "BHAVCOPY_HIST"),
      false,
    );
  });

  it("never lets a lower-authority source overwrite a higher one", () => {
    assert.equal(shouldUpgradePriceSource("BHAVCOPY", "YAHOO"), false);
    assert.equal(shouldUpgradePriceSource("BHAVCOPY_HIST", "YAHOO"), false);
    assert.equal(shouldUpgradePriceSource("ZERODHA", "YAHOO"), false);
  });

  it("upgrades YAHOO to either exchange source", () => {
    assert.equal(shouldUpgradePriceSource("YAHOO", "BHAVCOPY_HIST"), true);
    assert.equal(shouldUpgradePriceSource("YAHOO", "BHAVCOPY"), true);
  });

  it("treats a missing/null source as upgradable", () => {
    // Legacy rows predating the `source` column must not be immortal.
    assert.equal(shouldUpgradePriceSource(null, "BHAVCOPY_HIST"), true);
    assert.equal(shouldUpgradePriceSource(undefined, "BHAVCOPY_HIST"), true);
  });
});

describe("the US candle sources are RANKED, not left to fall through", () => {
  // MONEY-1373. Both of these write `candles` rows today. Until now TIINGO_RT
  // resolved to UNKNOWN_SOURCE_AUTHORITY (1) — a live daily writer with no
  // declared precedence, which is the MONEY-1175 shape one collection over.

  it("DATABENTO sits BELOW TIINGO — a D1 collision is refused STRUCTURALLY", () => {
    // The load-bearing half. Tiingo owns the daily series: it returns a
    // security's whole history raw, with the CRSP adjustment inputs alongside,
    // and the read-time adjustment is computed from those columns. Ranking
    // Databento under it means the refusal falls out of the comparison rather
    // than out of a guard somebody has to remember on the next writer.
    assert.equal(shouldUpgradePriceSource("TIINGO", "DATABENTO"), false);
    assert.equal(shouldUpgradePriceSource("DATABENTO", "TIINGO"), true);
  });

  it("DATABENTO sits ABOVE ZERODHA — a multi-venue blend beats one broker", () => {
    // The same argument that put TIINGO above ZERODHA, with more force: Kite's
    // candles are bounded in history and our Personal-tier app carries no
    // quote entitlement at all.
    assert.equal(shouldUpgradePriceSource("ZERODHA", "DATABENTO"), true);
    assert.equal(shouldUpgradePriceSource("DATABENTO", "ZERODHA"), false);
  });

  it("TIINGO_RT is above YAHOO and below every trade-derived source", () => {
    // Quote-MID bars with a structural `volume: 0` — a licensed live feed
    // carrying RAW prices, which is why it outranks Yahoo's split-ADJUSTED
    // closes; a mid is not a transaction, which is why it outranks nothing
    // that is.
    assert.equal(shouldUpgradePriceSource("YAHOO", "TIINGO_RT"), true);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "YAHOO"), false);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "DATABENTO"), true);
    assert.equal(shouldUpgradePriceSource("DATABENTO", "TIINGO_RT"), false);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "TIINGO"), true);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "ZERODHA"), true);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "BHAVCOPY"), true);
  });

  it("is EXPLICIT, not a fall-through to UNKNOWN", () => {
    // The whole point of the change. If either name is dropped from the table
    // these collapse to 1 and every comparison above becomes a coin toss
    // against the other unknown.
    assert.equal(PRICE_SOURCE_AUTHORITY.DATABENTO, 55);
    assert.equal(PRICE_SOURCE_AUTHORITY.TIINGO_RT, 20);
    assert.ok(priceSourceAuthority("DATABENTO") > UNKNOWN_SOURCE_AUTHORITY);
    assert.ok(priceSourceAuthority("TIINGO_RT") > UNKNOWN_SOURCE_AUTHORITY);
  });

  it("still does not upgrade at EQUAL authority, for the new values too", () => {
    // Equal rank must not overwrite: it keeps a re-run idempotent instead of
    // rewriting every row it already wrote.
    assert.equal(shouldUpgradePriceSource("DATABENTO", "DATABENTO"), false);
    assert.equal(shouldUpgradePriceSource("TIINGO_RT", "TIINGO_RT"), false);
  });

  it("the full order is BHAVCOPY > TIINGO > DATABENTO > ZERODHA > TIINGO_RT > YAHOO", () => {
    // One assertion nobody can satisfy by renumbering half the table.
    const order = [
      "BHAVCOPY",
      "TIINGO",
      "DATABENTO",
      "ZERODHA",
      "TIINGO_RT",
      "YAHOO",
    ];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        priceSourceAuthority(order[i - 1]) > priceSourceAuthority(order[i]),
        `${order[i - 1]} must outrank ${order[i]}`,
      );
    }
  });
});

describe("partitionPriceWrites", () => {
  it("creates rows that do not exist yet", () => {
    const out = partitionPriceWrites(
      [row("a"), row("b")],
      "BHAVCOPY_HIST",
      existingMap([]),
    );
    assert.equal(out.create.length, 2);
    assert.equal(out.upgrade.length, 0);
    assert.equal(out.preserved, 0);
  });

  it("REGRESSION (MONEY-1175): upgrades a YAHOO row instead of skipping it", () => {
    // The production shape. Before the fix this row was skipped, and the
    // exchange's own print for that date was discarded permanently.
    const out = partitionPriceWrites(
      [row("reliance", 1234.5)],
      "BHAVCOPY_HIST",
      existingMap([["reliance", "YAHOO"]]),
    );
    assert.equal(out.create.length, 0);
    assert.equal(out.preserved, 0, "a Yahoo row must NOT be preserved");
    assert.equal(out.upgrade.length, 1);
    assert.equal(out.upgrade[0]!.existingId, "oid-reliance");
    assert.equal(out.upgrade[0]!.existingSource, "YAHOO");
    assert.equal(out.upgrade[0]!.row.close, 1234.5);
  });

  it("still preserves a nightly BHAVCOPY row — the ORIGINAL rule survives", () => {
    // The skip existed for a real reason: history must not clobber live data.
    // Fixing the Yahoo case must not cost us that guarantee.
    const out = partitionPriceWrites(
      [row("infy")],
      "BHAVCOPY_HIST",
      existingMap([["infy", "BHAVCOPY"]]),
    );
    assert.equal(out.upgrade.length, 0);
    assert.equal(out.create.length, 0);
    assert.equal(out.preserved, 1);
  });

  it("is idempotent: a second pass over its own output upgrades nothing", () => {
    // Re-parsing is routine — checkpoints get purged, families get re-run. If
    // an equal-authority row upgraded, every re-run would rewrite every row it
    // already wrote: millions of pointless writes and a churned oplog.
    const first = partitionPriceWrites(
      [row("a"), row("b")],
      "BHAVCOPY_HIST",
      existingMap([
        ["a", "YAHOO"],
        ["b", null],
      ]),
    );
    assert.equal(first.upgrade.length, 2);

    const second = partitionPriceWrites(
      [row("a"), row("b")],
      "BHAVCOPY_HIST",
      existingMap([
        ["a", "BHAVCOPY_HIST"],
        ["b", "BHAVCOPY_HIST"],
      ]),
    );
    assert.equal(second.upgrade.length, 0);
    assert.equal(second.create.length, 0);
    assert.equal(second.preserved, 2);
  });

  it("collapses an instrument repeated within one file, first occurrence wins", () => {
    // One exchange file can list an instrument under multiple series. A repeat
    // reaching createMany aborts the whole chunk on the unique index.
    const out = partitionPriceWrites(
      [row("a", 10), row("a", 99), row("b", 5)],
      "BHAVCOPY_HIST",
      existingMap([]),
    );
    assert.equal(out.dupInBatch, 1);
    assert.equal(out.create.length, 2);
    assert.equal(out.create[0]!.close, 10, "first occurrence must win");
  });

  it("counts a repeat even when the first copy was an upgrade", () => {
    // The dedupe must run before the create/upgrade decision, or the same _id
    // lands twice in one bulk update.
    const out = partitionPriceWrites(
      [row("a", 10), row("a", 99)],
      "BHAVCOPY_HIST",
      existingMap([["a", "YAHOO"]]),
    );
    assert.equal(out.dupInBatch, 1);
    assert.equal(out.upgrade.length, 1);
    assert.equal(out.upgrade[0]!.row.close, 10);
  });

  it("splits a mixed batch into all three buckets at once", () => {
    const out = partitionPriceWrites(
      [row("new"), row("stale"), row("live")],
      "BHAVCOPY_HIST",
      existingMap([
        ["stale", "YAHOO"],
        ["live", "BHAVCOPY"],
      ]),
    );
    assert.deepEqual(
      out.create.map((r) => r.instrumentId),
      ["new"],
    );
    assert.deepEqual(
      out.upgrade.map((u) => u.row.instrumentId),
      ["stale"],
    );
    assert.equal(out.preserved, 1);
  });

  it("refuses to let YAHOO overwrite the exchange, whichever way it is called", () => {
    // The same helper guards the Yahoo writer. Direction must be symmetric.
    const out = partitionPriceWrites(
      [row("a")],
      "YAHOO",
      existingMap([["a", "BHAVCOPY_HIST"]]),
    );
    assert.equal(out.upgrade.length, 0);
    assert.equal(out.preserved, 1);
  });
});
