/**
 * `india-sink-logic` — MONEY-1497 (B2-IN).
 *
 * Every case pins a failure that is SILENT in production. The India replay
 * writes thirty years of history into four BigQuery tables nobody reads row by
 * row, so the only defects that matter here are the ones that produce a
 * plausible-looking table: a month claimed under a hash that supersedes its own
 * siblings, a futures row carrying a `0` strike that sorts and charts as a
 * price, a delivery row whose absent SERIES was fabricated as `EQ`, a month
 * ACCEPTED over files that parsed to nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FUTURE_INSTRUMENT_TYPES,
  INDIA_DEDUPE_KEYS,
  INDIA_FAMILIES,
  INDIA_PARSER_VERSIONS,
  INDIA_QUARANTINE_REASONS,
  INDIA_SOURCES,
  INDIA_TABLES,
  IN_MARKET,
  allIndiaFamilies,
  classifyPricedRow,
  decideMonth,
  dedupeIndiaRows,
  enumerateSessionCandidates,
  groupDatesByMonth,
  indiaParserVersion,
  indiaPartitionKey,
  indiaResolutionMethod,
  indiaSourceHash,
  isFutureInstrument,
  isIndiaTable,
  isSessionInPartition,
  monthDeleteBounds,
  monthOf,
  siftRows,
  sourceFor,
  tableForFamily,
  toDeliveryDailyRow,
  toDerivativeEodRow,
  toIndexEodRow,
  toIndiaPriceBarRow,
  type ContributingFile,
  type IndiaCashBar,
  type IndiaDelivery,
  type IndiaDerivative,
  type IndiaIndexClose,
  type ListingIdBuilder,
  type RowProvenance,
} from "../src/india-sink-logic";
import { PRICE_BAR_PARSER_VERSION } from "../src/price-bar-logic";
import { stageKey, stageShardPrefix } from "../src/stage-logic";

const PROV: RowProvenance = {
  sourceObjectUri: "gs://stockbook-content-qa/feeds/NSE/bhavcopy/2024/03/x.zip",
  sourceRecordKey: "nse-cm-udiff-bhavcopy:2024-03-01",
  pipelineRunId: "lake-replay-in-2026-09-22T00-00-00-000Z",
  observedAtMs: Date.UTC(2024, 2, 1),
  ingestedAtMs: Date.UTC(2026, 8, 22),
};

/**
 * A stand-in for core's `buildListingId`, which this package cannot import
 * (`ListingIdBuilder` says why). It spells its ARGUMENTS back, so a case here
 * sees exactly what a mapper asked for — India's rule: symbol, exchange and NO
 * inception date — and nothing about the spelling, which is core's and is
 * pinned against real prod ids in
 * `packages/core/__tests__/market-data/listing-id.test.ts`.
 */
const ID: ListingIdBuilder = (symbol, exchange, start) =>
  `id(${symbol}|${exchange}|${String(start)})`;

function file(over: Partial<ContributingFile> = {}): ContributingFile {
  return {
    date: "2024-03-01",
    key: "feeds/NSE/bhavcopy/2024/03/BhavCopy_NSE_CM_20240301.csv.zip",
    generation: "1700000000000001",
    ...over,
  };
}

function cash(over: Partial<IndiaCashBar> = {}): IndiaCashBar {
  return {
    symbol: "RELIANCE",
    exchange: "NSE",
    isin: "INE002A01018",
    sessionDate: "2024-03-01",
    open: 2900.5,
    high: 2950,
    low: 2880.25,
    close: 2940.1,
    volume: 5_000_000,
    series: "EQ",
    ...over,
  };
}

function deriv(over: Partial<IndiaDerivative> = {}): IndiaDerivative {
  return {
    underlying: "NIFTY",
    exchange: "NSE",
    instrumentType: "OPTIDX",
    expiryDate: "2024-03-28",
    strike: 22000,
    optionType: "CE",
    sessionDate: "2024-03-01",
    open: 120,
    high: 180,
    low: 110,
    close: 165,
    settle: 165,
    openInterest: 1_250_000,
    changeInOi: -45_000,
    contractsTraded: 98_000,
    valueLakh: 12345.67,
    ...over,
  };
}

function delivery(over: Partial<IndiaDelivery> = {}): IndiaDelivery {
  return {
    symbol: "RELIANCE",
    exchange: "NSE",
    isin: null,
    series: "EQ",
    sessionDate: "2024-03-01",
    tradedQty: 5_000_000,
    deliverableQty: 2_100_000,
    deliveryPct: 42,
    ...over,
  };
}

function index(over: Partial<IndiaIndexClose> = {}): IndiaIndexClose {
  return {
    indexSlug: "nifty-50",
    indexName: "Nifty 50",
    exchange: "NSE",
    sessionDate: "2024-03-01",
    open: 22000,
    high: 22150,
    low: 21950,
    close: 22100,
    prevClose: 21980,
    volume: 250_000_000,
    turnoverCr: 31000.5,
    pe: 22.4,
    pb: 3.9,
    divYield: 1.25,
    ...over,
  };
}

/** `decideMonth` takes SETS; these build them from counts for readability. */
function ds(n: number): ReadonlySet<string> {
  return new Set(Array.from({ length: Math.max(0, n) }, (_, i) => `d${i}`));
}

/* ═══════════════════════════════════════════════════════════════════════
   The partition key and the source hash
   ═══════════════════════════════════════════════════════════════════════ */

describe("indiaPartitionKey", () => {
  it("is the MONTH, because the table is month-partitioned", () => {
    assert.equal(indiaPartitionKey("2024-03-17"), "IN/2024-03");
    assert.equal(indiaPartitionKey("2024-03-01"), "IN/2024-03");
    assert.equal(indiaPartitionKey("2024-03-31"), "IN/2024-03");
  });

  it("carries the MARKET, so an India month cannot claim a US one", () => {
    // `price_bar_d1` holds both markets. A bare `2024-03` would let B2's US
    // loader's ACCEPTED row make this loader skip a month it never touched.
    assert.ok(indiaPartitionKey("2024-03-01").startsWith(`${IN_MARKET}/`));
  });

  it("refuses a malformed date rather than producing a key nothing matches", () => {
    assert.throws(() => indiaPartitionKey("2024-3-1"), /YYYY-MM-DD/);
    assert.throws(() => indiaPartitionKey("2024-03"), /YYYY-MM-DD/);
    assert.throws(() => indiaPartitionKey(""), /YYYY-MM-DD/);
  });
});

describe("indiaSourceHash", () => {
  it("covers EVERY contributing day-file, not one of them", () => {
    // The B2-IN brief says `source_hash = object generation` on a MONTH key.
    // A month has ~21 files with ~21 generations, so that would claim the same
    // month 21 times under 21 hashes — and `acceptPartition` supersedes the
    // other 20, which `decideClaim` then re-LOADS. This is the fix: one hash
    // over the whole month, so adding a file changes it exactly once.
    const jan1 = indiaSourceHash([file({ date: "2024-03-01" })]);
    const both = indiaSourceHash([
      file({ date: "2024-03-01" }),
      file({ date: "2024-03-04", generation: "1700000000000002" }),
    ]);
    assert.notEqual(jan1, both);
  });

  it("is order-independent — the walk order is incidental", () => {
    const a = file({ date: "2024-03-01" });
    const b = file({ date: "2024-03-04", generation: "1700000000000002" });
    assert.equal(indiaSourceHash([a, b]), indiaSourceHash([b, a]));
  });

  it("changes when a GENERATION changes but the key does not", () => {
    // MONEY-1169 rewrote thousands of envelope-corrupted feed objects IN PLACE.
    // Same key, new bytes. Hashing names would leave every one of those months
    // un-reloadable for ever.
    const before = indiaSourceHash([file({ generation: "1700000000000001" })]);
    const after = indiaSourceHash([file({ generation: "1700000000000009" })]);
    assert.notEqual(before, after);
  });

  it("distinguishes two files that differ only by KEY", () => {
    const a = indiaSourceHash([
      file({ key: "feeds/NSE/bhavcopy/2024/03/a.zip" }),
    ]);
    const b = indiaSourceHash([
      file({ key: "feeds/NSE/bhavcopy/2024/03/b.zip" }),
    ]);
    assert.notEqual(a, b);
  });

  it("REFUSES an empty set rather than returning the empty digest", () => {
    // sha256("") is a real, stable, wrong value. A month where every fetch
    // 404'd would claim it, load nothing, and freeze the gap under a hash no
    // successful run would ever reproduce.
    assert.throws(() => indiaSourceHash([]), /zero files/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Parser versions
   ═══════════════════════════════════════════════════════════════════════ */

describe("parser versions", () => {
  it("are DISTINCT per table", () => {
    const seen = new Set(Object.values(INDIA_PARSER_VERSIONS));
    assert.equal(
      seen.size,
      INDIA_TABLES.length,
      "a shared version makes an F&O fix force a thirty-year cash reload",
    );
  });

  it("never collide with B2's US price-bar version", () => {
    // `price_bar_d1` is shared. One string across both markets would make a US
    // parser fix look like it had covered India, in the one column that exists
    // to say otherwise.
    for (const v of Object.values(INDIA_PARSER_VERSIONS)) {
      assert.notEqual(v, PRICE_BAR_PARSER_VERSION);
    }
  });

  it("throws on a table with no declared version", () => {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => indiaParserVersion("not_a_table" as any),
      /no parser version declared/,
    );
  });

  it("moved past v1 for both tables whose rows carry a listing_id — MONEY-1522", () => {
    // Prod holds its two-part `{symbol}:{exchange}` ids under exactly these v1
    // strings, every month ACCEPTED in the ledger. `parser_version` is part of
    // the ledger identity, so reverting the bump makes the replay SKIP all 383
    // price_bar_d1 months as already loaded — the retired spelling stays in
    // place for ever, behind a clean run.
    assert.notEqual(INDIA_PARSER_VERSIONS.price_bar_d1, "in-bhavcopy-v1");
    assert.notEqual(INDIA_PARSER_VERSIONS.delivery_daily, "in-delivery-v1");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Family wiring
   ═══════════════════════════════════════════════════════════════════════ */

describe("INDIA_FAMILIES", () => {
  it("spells the registry ids verbatim, prefix included", () => {
    // The brief calls one of these `sec-bhavdata-full`, which is the FEED slug.
    // The registry id is `nse-sec-bhavdata-full`, and `familyById` returns
    // undefined for the other — so the replay would select nothing and report
    // a clean run over zero files.
    assert.ok(INDIA_FAMILIES.delivery_daily.includes("nse-sec-bhavdata-full"));
    assert.ok(!INDIA_FAMILIES.delivery_daily.includes("sec-bhavdata-full"));
    assert.ok(INDIA_FAMILIES.index_eod.includes("nse-indices-close"));
    assert.ok(!INDIA_FAMILIES.index_eod.includes("ind-close-all"));
  });

  it("assigns every family to exactly one table", () => {
    const all = allIndiaFamilies();
    assert.equal(new Set(all).size, all.length, "a family feeding two tables");
    for (const f of all) assert.ok(tableForFamily(f));
  });

  it("does not claim MTO — no parser for it exists in this repo", () => {
    // `nse-mto-delivery` is registered and archived and is NOT in feed-parse's
    // PARSERS table. Listing it here would make the replay fetch thousands of
    // objects it cannot read, then report them as unreadable for ever.
    assert.ok(!allIndiaFamilies().includes("nse-mto-delivery"));
  });

  it("returns null for a family this replay does not read", () => {
    assert.equal(tableForFamily("nse-bulk-deals"), null);
    assert.equal(tableForFamily("nse-mto-delivery"), null);
  });

  it("covers both F&O eras and both exchanges", () => {
    for (const id of [
      "nse-fo-legacy",
      "nse-fo-udiff-bhavcopy",
      "bse-fo-udiff-bhavcopy",
    ]) {
      assert.equal(tableForFamily(id), "derivatives_eod_in");
    }
  });

  it("isIndiaTable is closed", () => {
    for (const t of INDIA_TABLES) assert.ok(isIndiaTable(t));
    assert.ok(!isIndiaTable("corporate_action"));
    assert.ok(!isIndiaTable("fund_nav_d1"));
    assert.ok(!isIndiaTable(42));
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Source values
   ═══════════════════════════════════════════════════════════════════════ */

describe("sourceFor", () => {
  it("does NOT call an index close a bhavcopy", () => {
    // `source` is an authority rank AND a provenance label. `ind_close_all` is
    // not a bhavcopy, and `NSE_INDICES` is the spelling Mongo's own IndexClose
    // writer already uses, so the two stores agree.
    assert.equal(sourceFor("index_eod"), "NSE_INDICES");
    assert.notEqual(sourceFor("index_eod"), sourceFor("price_bar_d1"));
  });

  it("matches what feed-parse writes into DailyPrice, verbatim", () => {
    // `lake-parity-in` joins the two sides on it; a second spelling would make
    // every bar look Yahoo-filled.
    assert.equal(sourceFor("price_bar_d1"), "BHAVCOPY_HIST");
  });

  it("is what `replaceMonth` scopes its DELETE by, so it must be total", () => {
    // A table with no declared source would delete nothing and double the
    // month on every reload.
    for (const t of INDIA_TABLES) {
      assert.ok(sourceFor(t).length > 0);
      assert.equal(INDIA_SOURCES[t], sourceFor(t));
    }
  });

  it("throws on an unknown table rather than defaulting to a rank", () => {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => sourceFor("not_a_table" as any),
      /no source declared/,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Identity
   ═══════════════════════════════════════════════════════════════════════ */

describe("listing_id — core's builder, India's rule (MONEY-1522)", () => {
  it("asks for (symbol, exchange, NO start date) and writes the answer verbatim", () => {
    // India holds no listing inception date, so every India writer passes
    // null — `unknown` in the real id. A writer that spelled the id itself, or
    // passed a session date, would be a second spelling again.
    const bar = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    assert.equal(bar.listing_id, "id(RELIANCE|NSE|null)");
  });

  it("gives a delivery row the SAME id its bar carries", () => {
    // `delivery_daily` keys on `listing_id` too (INDIA_DEDUPE_KEYS). A third
    // spelling there would split delivery from price on one listing.
    assert.equal(
      toDeliveryDailyRow(delivery(), PROV, "BHAVCOPY_HIST", ID).listing_id,
      toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID).listing_id,
    );
  });

  it("lets the builder's refusal of a blank half through, rather than absorbing it", () => {
    // The empty-half guard moved INTO the builder. A mapper that caught its
    // throw and carried on would restore the silent merge the guard exists to
    // stop; propagating it is what makes the replay count the file unreadable.
    const refuses: ListingIdBuilder = () => {
      throw new Error("an empty half silently merges every such row");
    };
    assert.throws(
      () =>
        toIndiaPriceBarRow(
          cash({ symbol: "" }),
          PROV,
          "BHAVCOPY_HIST",
          refuses,
        ),
      /empty half/,
    );
    assert.throws(
      () =>
        toDeliveryDailyRow(
          delivery({ exchange: " " }),
          PROV,
          "BHAVCOPY_HIST",
          refuses,
        ),
      /empty half/,
    );
  });
});

describe("indiaResolutionMethod", () => {
  it("names EXACT_ISIN only when the row actually carried one", () => {
    assert.equal(indiaResolutionMethod("INE002A01018"), "EXACT_ISIN");
  });

  it("falls back to SYMBOL_VENUE_DATED for the pre-ISIN legacy era", () => {
    // `cm14NOV2006bhav.csv` still ends at `TIMESTAMP,` — no ISIN column at all
    // (per-file-derivable-map.md correction 1). A large slice of history, not
    // an edge case, and it is the only thing that later distinguishes a reused
    // ticker from its predecessor.
    assert.equal(indiaResolutionMethod(null), "SYMBOL_VENUE_DATED");
    assert.equal(indiaResolutionMethod(undefined), "SYMBOL_VENUE_DATED");
    assert.equal(indiaResolutionMethod("   "), "SYMBOL_VENUE_DATED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Row mapping
   ═══════════════════════════════════════════════════════════════════════ */

describe("toIndiaPriceBarRow", () => {
  it("stamps INDIA's parser version, not B2's US one", () => {
    const row = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    assert.equal(row.parser_version, INDIA_PARSER_VERSIONS.price_bar_d1);
    assert.notEqual(row.parser_version, PRICE_BAR_PARSER_VERSION);
  });

  it("keeps the ISIN and records how identity was arrived at", () => {
    const withIsin = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    assert.equal(withIsin.isin, "INE002A01018");
    assert.equal(withIsin.resolution_method, "EXACT_ISIN");

    const without = toIndiaPriceBarRow(
      cash({ isin: null }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(without.isin, null);
    assert.equal(without.resolution_method, "SYMBOL_VENUE_DATED");
  });

  it("stores an empty-string ISIN as NULL", () => {
    // `""` satisfies `IS NOT NULL`, which hides exactly the rows a coverage
    // query goes looking for.
    const row = toIndiaPriceBarRow(
      cash({ isin: "  " }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.isin, null);
  });

  it("emits volume as a decimal STRING, bigint included", () => {
    const row = toIndiaPriceBarRow(
      cash({ volume: 9_007_199_254_740_993n }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.volume, "9007199254740993");
    assert.doesNotThrow(() => JSON.stringify(row));
  });

  it("stamps market IN and the session date verbatim", () => {
    const row = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    assert.equal(row.market, "IN");
    assert.equal(row.session_date, "2024-03-01");
  });

  it("carries observed_at from the SESSION, never the replay's clock", () => {
    // Point-in-time correctness is observed_at (lake-layout.md §6). Stamping
    // `now` would back-date thirty years of history to the day it was loaded.
    const row = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    assert.equal(row.observed_at, new Date(Date.UTC(2024, 2, 1)).toISOString());
    assert.notEqual(row.observed_at, row.ingested_at);
  });
});

describe("toDerivativeEodRow", () => {
  it("nulls strike and option type for a FUTURE, by instrument type", () => {
    const fut = toDerivativeEodRow(
      // Mongo's sentinels, which a lake row must not inherit: a `0` strike
      // sorts, aggregates and charts as a price.
      deriv({ instrumentType: "FUTIDX", strike: 0, optionType: "XX" }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(fut.strike_price, null);
    assert.equal(fut.option_type, null);
  });

  it("nulls them even when the sentinel is a DIFFERENT spelling", () => {
    // The decision is on the instrument type, never on the sentinel value, so
    // a future spelled "NA" or "" cannot leak through as a real option type.
    const fut = toDerivativeEodRow(
      deriv({ instrumentType: "FUTSTK", strike: 123.5, optionType: "NA" }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(fut.strike_price, null);
    assert.equal(fut.option_type, null);
  });

  it("keeps strike and option type for an OPTION", () => {
    const opt = toDerivativeEodRow(deriv(), PROV, "BHAVCOPY_HIST");
    assert.equal(opt.strike_price, 22000);
    assert.equal(opt.option_type, "CE");
  });

  it("keeps a NEGATIVE change in open interest", () => {
    // OI change is signed. Coercing it would turn every unwind into a build.
    const row = toDerivativeEodRow(
      deriv({ changeInOi: -45_000 }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(row.change_in_oi, "-45000");
  });

  it("emits every count as an INT64 string and every price as a number", () => {
    const row = toDerivativeEodRow(deriv(), PROV, "BHAVCOPY_HIST");
    assert.equal(typeof row.open_interest, "string");
    assert.equal(typeof row.contracts_traded, "string");
    assert.equal(typeof row.close, "number");
    assert.equal(typeof row.value_lakh, "number");
  });

  it("turns a non-finite settle into NULL, never 0", () => {
    const row = toDerivativeEodRow(
      deriv({ settle: Number.NaN }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(row.settle_price, null);
  });

  it("stamps the F&O parser version", () => {
    const row = toDerivativeEodRow(deriv(), PROV, "BHAVCOPY_HIST");
    assert.equal(row.parser_version, INDIA_PARSER_VERSIONS.derivatives_eod_in);
  });

  it("isFutureInstrument is case- and whitespace-tolerant", () => {
    for (const t of FUTURE_INSTRUMENT_TYPES) {
      assert.ok(isFutureInstrument(t.toLowerCase()));
      assert.ok(isFutureInstrument(` ${t} `));
    }
    assert.ok(!isFutureInstrument("OPTIDX"));
    assert.ok(!isFutureInstrument("OPTSTK"));
  });
});

describe("toDeliveryDailyRow", () => {
  it("passes a NULL series through — MTO rows carry no SERIES column", () => {
    // per-file-derivable-map.md correction 2. Defaulting to "EQ" would
    // fabricate exactly the value a delivery screen must exclude: BE/BZ
    // trade-for-trade rows are 100% delivery by construction.
    const row = toDeliveryDailyRow(
      delivery({ series: null }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.series, null);
  });

  it("treats a blank series as NULL, not as a series called ''", () => {
    const row = toDeliveryDailyRow(
      delivery({ series: "  " }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.series, null);
  });

  it("keeps an UNREPORTED delivery percent NULL rather than 0", () => {
    // The file prints `-`. Zero delivery and unreported delivery are different
    // facts; a mean over the two differs by the whole column.
    const row = toDeliveryDailyRow(
      delivery({ deliveryPct: null, deliverableQty: null }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.delivery_pct, null);
    assert.equal(row.deliverable_qty, null);
  });

  it("distinguishes a real zero from an absence", () => {
    const row = toDeliveryDailyRow(
      delivery({ deliveryPct: 0, deliverableQty: 0 }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(row.delivery_pct, 0);
    assert.equal(row.deliverable_qty, "0");
  });
});

describe("toIndexEodRow", () => {
  it("keeps all THIRTEEN columns, not the four Mongo stores", () => {
    const row = toIndexEodRow(index(), PROV, "NSE_INDICES");
    assert.equal(row.pe_ratio, 22.4);
    assert.equal(row.pb_ratio, 3.9);
    assert.equal(row.div_yield, 1.25);
    assert.equal(row.turnover_cr, 31000.5);
    assert.equal(row.volume, "250000000");
    assert.equal(row.prev_close, 21980);
  });

  it("accepts a row that is almost entirely null", () => {
    // `Nifty50 Dividend Points` prints `-` for O/H/L, volume, turnover, P/E,
    // P/B and div yield while carrying a real close. A NOT NULL on any measure
    // would reject a valid row.
    const row = toIndexEodRow(
      index({
        open: null,
        high: null,
        low: null,
        volume: null,
        turnoverCr: null,
        pe: null,
        pb: null,
        divYield: null,
        prevClose: null,
      }),
      PROV,
      "NSE_INDICES",
    );
    assert.equal(row.close, 22100);
    assert.equal(row.open, null);
    assert.equal(row.volume, null);
  });

  it("keys on the slug and keeps the printed name as evidence", () => {
    const row = toIndexEodRow(index(), PROV, "NSE_INDICES");
    assert.equal(row.index_slug, "nifty-50");
    assert.equal(row.index_name, "Nifty 50");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   The date walk
   ═══════════════════════════════════════════════════════════════════════ */

describe("enumerateSessionCandidates", () => {
  it("drops weekends and keeps every weekday", () => {
    // 2024-03-01 is a Friday.
    const days = enumerateSessionCandidates("2024-03-01", "2024-03-07");
    assert.deepEqual(days, [
      "2024-03-01",
      "2024-03-04",
      "2024-03-05",
      "2024-03-06",
      "2024-03-07",
    ]);
  });

  it("KEEPS holidays — this repo has no calendar reaching 1994", () => {
    // 2024-03-25 was Holi, a market holiday. It stays in: `NSE_HOLIDAYS_BY_FY`
    // covers recent financial years only, and a holiday candidate costs one
    // 404, which is the correct price for not owning a thirty-year calendar.
    assert.ok(
      enumerateSessionCandidates("2024-03-25", "2024-03-25").includes(
        "2024-03-25",
      ),
    );
  });

  it("spans a month and a year boundary", () => {
    const days = enumerateSessionCandidates("2023-12-29", "2024-01-02");
    assert.deepEqual(days, ["2023-12-29", "2024-01-01", "2024-01-02"]);
  });

  it("handles a leap day", () => {
    assert.ok(
      enumerateSessionCandidates("2024-02-28", "2024-03-01").includes(
        "2024-02-29",
      ),
    );
  });

  it("returns [] for a reversed range rather than looping for ever", () => {
    assert.deepEqual(
      enumerateSessionCandidates("2024-03-05", "2024-03-01"),
      [],
    );
  });

  it("adds the special-session calendar's dates in range, in order, once (MONEY-1613)", () => {
    // 2019-10-27 is the Sunday Muhurat; 2019-10-28 (a Monday) is already a
    // weekday candidate, so listing it in the calendar must not double it.
    assert.deepEqual(
      enumerateSessionCandidates("2019-10-25", "2019-10-28", [
        "2019-10-28",
        "2019-10-27",
        "2019-11-02",
        "2019-10-19",
      ]),
      ["2019-10-25", "2019-10-27", "2019-10-28"],
    );
  });

  it("refuses a date that passes the regex and is not real", () => {
    // 2017-02-30 parses to 2017-03-02 and then sorts nowhere near where the
    // caller meant — the same rule identity-logic.ts states.
    assert.throws(
      () => enumerateSessionCandidates("2017-02-30", "2017-03-01"),
      /not a real date/,
    );
    assert.throws(
      () => enumerateSessionCandidates("2024-3-1", "2024-03-05"),
      /YYYY-MM-DD/,
    );
  });
});

describe("groupDatesByMonth", () => {
  it("keeps order within a month and yields months in first-seen order", () => {
    const g = groupDatesByMonth([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
      "2024-03-04",
    ]);
    assert.deepEqual([...g.keys()], ["2024-02", "2024-03"]);
    assert.deepEqual(g.get("2024-03"), ["2024-03-01", "2024-03-04"]);
  });

  it("monthOf truncates without touching the day", () => {
    assert.equal(monthOf("2024-03-31"), "2024-03");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   De-duplication
   ═══════════════════════════════════════════════════════════════════════ */

describe("dedupeIndiaRows", () => {
  it("collapses the two ind_close_all prefixes onto one row per session", () => {
    // `nse-indices-close` (nsearchives) and `nse-index-snapshot`
    // (niftyindices) publish the SAME layout for the same day. Without this
    // the month holds two rows per index-session and every aggregate
    // double-counts while looking entirely normal.
    const a = toIndexEodRow(index(), PROV, "NSE_INDICES");
    const b = toIndexEodRow(index({ close: 22101 }), PROV, "NSE_INDICES");
    const out = dedupeIndiaRows([a, b], INDIA_DEDUPE_KEYS.index_eod);
    assert.equal(out.length, 1);
    assert.equal(
      out[0]!.close,
      22100,
      "FIRST wins — the caller controls order",
    );
  });

  it("keeps two DIFFERENT indices on the same session", () => {
    const a = toIndexEodRow(index(), PROV, "NSE_INDICES");
    const b = toIndexEodRow(
      index({ indexSlug: "nifty-bank" }),
      PROV,
      "NSE_INDICES",
    );
    assert.equal(
      dedupeIndiaRows([a, b], INDIA_DEDUPE_KEYS.index_eod).length,
      2,
    );
  });

  it("keeps a call and a put at the same strike", () => {
    // `option_type` is the ONLY column separating them. A dedupe key that
    // omitted it would silently discard half of every option chain.
    const ce = toDerivativeEodRow(deriv(), PROV, "BHAVCOPY_HIST");
    const pe = toDerivativeEodRow(
      deriv({ optionType: "PE" }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(
      dedupeIndiaRows([ce, pe], INDIA_DEDUPE_KEYS.derivatives_eod_in).length,
      2,
    );
  });

  it("keeps two expiries of the same underlying", () => {
    const near = toDerivativeEodRow(deriv(), PROV, "BHAVCOPY_HIST");
    const far = toDerivativeEodRow(
      deriv({ expiryDate: "2024-04-25" }),
      PROV,
      "BHAVCOPY_HIST",
    );
    assert.equal(
      dedupeIndiaRows([near, far], INDIA_DEDUPE_KEYS.derivatives_eod_in).length,
      2,
    );
  });

  it("keeps NSE and BSE bars for a dual-listed symbol", () => {
    const nse = toIndiaPriceBarRow(cash(), PROV, "BHAVCOPY_HIST", ID);
    const bse = toIndiaPriceBarRow(
      cash({ exchange: "BSE" }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(
      dedupeIndiaRows([nse, bse], INDIA_DEDUPE_KEYS.price_bar_d1).length,
      2,
    );
  });

  it("REFUSES an empty key rather than collapsing the whole partition", () => {
    assert.throws(
      () => dedupeIndiaRows([{ a: 1 }, { a: 2 }], []),
      /refusing an empty key/,
    );
  });

  it("REFUSES a misspelled key field", () => {
    // A typo does not error, it WEAKENS the key: every row reads `undefined`
    // for that field. One wholly-wrong key collapses the whole partition to a
    // single row and reports a clean de-dupe.
    assert.throws(
      () => dedupeIndiaRows([{ session_date: "2024-03-01" }], ["sesion_date"]),
      /not on the row/,
    );
  });

  it("names every field that is missing, not just the first", () => {
    assert.throws(() => dedupeIndiaRows([{ a: 1 }], ["b", "c"]), /b, c/);
  });

  it("allows an empty row set — nothing to check and nothing to collapse", () => {
    assert.deepEqual(dedupeIndiaRows([], ["anything"]), []);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Quarantine
   ═══════════════════════════════════════════════════════════════════════ */

describe("siftRows", () => {
  it("counts EVERY refusal exactly, whatever the sample cap", () => {
    // An under-reported refusal count is the number an operator acts on.
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const r = siftRows(rows, () => "NO_FINITE_PRICE", 3);
    assert.equal(r.rows.length, 0);
    assert.equal(r.counts.NO_FINITE_PRICE, 50);
    assert.equal(r.quarantined.length, 3, "the CAP is on the sample only");
  });

  it("keeps the rows a classifier passes", () => {
    const r = siftRows([{ id: 1 }, { id: 2 }], (row) =>
      row.id === 1 ? "BAD_DATE" : null,
    );
    assert.deepEqual(r.rows, [{ id: 2 }]);
    assert.equal(r.counts.BAD_DATE, 1);
  });

  it("refuses a bar with no finite price at all", () => {
    // `toPriceBarRow` turns NaN into NULL rather than 0, which is right — but
    // an all-NULL bar still occupies a session, so a coverage query counting
    // sessions would report the month complete.
    const dead = toIndiaPriceBarRow(
      cash({ open: Number.NaN, high: null, low: null, close: Infinity }),
      PROV,
      "BHAVCOPY_HIST",
      ID,
    );
    assert.equal(classifyPricedRow(dead), "NO_FINITE_PRICE");
  });

  it("keeps a bar with only a close", () => {
    // BSE pre-modern index rows are close-only: O/H/L blank on all 199 rows of
    // a 1986 file. Refusing those would delete the whole era.
    const closeOnly = toIndexEodRow(
      index({ open: null, high: null, low: null }),
      PROV,
      "NSE_INDICES",
    );
    assert.equal(classifyPricedRow(closeOnly), null);
  });

  it("WRONG_MONTH is a named reason, because the row cannot be corrected", () => {
    // `replaceMonth` deletes ONE month before it loads, so a row whose own date
    // lands in an adjacent month sits outside every subsequent reload's
    // predicate: it can never be corrected, only accumulated.
    assert.ok(INDIA_QUARANTINE_REASONS.includes("WRONG_MONTH"));
  });

  it("names its reasons rather than returning a boolean", () => {
    assert.ok(INDIA_QUARANTINE_REASONS.length >= 4);
    for (const r of INDIA_QUARANTINE_REASONS) {
      assert.match(r, /^[A-Z_]+$/);
    }
  });
});

describe("isSessionInPartition", () => {
  it("accepts every day of the partition's own month", () => {
    for (const d of ["2024-03-01", "2024-03-17", "2024-03-31"]) {
      assert.ok(isSessionInPartition("IN/2024-03", d));
    }
  });

  it("refuses an adjacent month on BOTH sides", () => {
    // The archive key says which day a file is; the parser reads the day off
    // the file's own column. `parseSecBhavdataFull` counts exactly that
    // disagreement as `dateMismatch`, so this is a measured class.
    assert.ok(!isSessionInPartition("IN/2024-03", "2024-02-29"));
    assert.ok(!isSessionInPartition("IN/2024-03", "2024-04-01"));
  });

  it("does not match a different YEAR's same month", () => {
    assert.ok(!isSessionInPartition("IN/2024-03", "2023-03-15"));
  });

  it("refuses a month-shaped value where a DATE was expected", () => {
    // The trailing dash is what makes the prefix a boundary: a bare
    // `startsWith("2024-03")` would call the month itself a member of the
    // month, and a caller that lost the day component would silently keep the
    // row instead of quarantining it.
    assert.ok(!isSessionInPartition("IN/2024-03", "2024-03"));
  });

  it("refuses a partition key it does not recognise", () => {
    assert.throws(
      () => isSessionInPartition("2024-03", "2024-03-01"),
      /unrecognised partition key/,
    );
  });

  it("agrees with monthDeleteBounds on every date it accepts", () => {
    // The rows KEPT and the rows DELETED must describe the same month, or a
    // reload leaves behind exactly the rows it refused to replace.
    const key = "IN/2024-03";
    const b = monthDeleteBounds(key);
    for (const d of ["2024-03-01", "2024-03-31", "2024-02-29", "2024-04-01"]) {
      assert.equal(
        isSessionInPartition(key, d),
        d >= b.fromInclusive && d < b.toExclusive,
        `${d} disagrees between the keep rule and the delete bounds`,
      );
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Coverage and the delete bounds
   ═══════════════════════════════════════════════════════════════════════ */

describe("decideMonth", () => {
  it("loads when every file read produced a session", () => {
    const v = decideMonth({
      datesRead: ds(21),
      sessionDates: ds(21),
      rowCount: 42_000,
    });
    assert.equal(v.action, "load");
    assert.equal(v.action === "load" && v.expectedSessions, 21);
    assert.equal(v.action === "load" && v.actualSessions, 21);
  });

  it("makes a file that parsed to NOTHING fail the coverage gate", () => {
    // MONEY-1169's shape: thousands of envelope-corrupted files each parsing
    // to nothing looked exactly like success. `expectedSessions` is files READ,
    // so a parser silently returning [] leaves actual < expected.
    const v = decideMonth({
      datesRead: ds(21),
      sessionDates: ds(18),
      rowCount: 36_000,
    });
    assert.equal(v.action, "load");
    assert.ok(
      v.action === "load" && v.actualSessions < v.expectedSessions,
      "acceptPartition's decideCoverage must refuse this",
    );
  });

  it("REGRESSION: two families on the SAME date do not refuse the month", () => {
    // The first cut counted FILES. From 2024 onward NSE and BSE both publish
    // every session of cash, of F&O, and both `ind_close_all` prefixes publish
    // every index day — so a healthy 21-session month reads 42 files and yields
    // 21 session dates. `21 >= 42` is false, so `acceptPartition` would have
    // THROWN on every month this replay exists to load. A gate that refuses
    // health is worse than no gate: the only obvious fix is to loosen it.
    const v = decideMonth({
      datesRead: ds(21),
      sessionDates: ds(21),
      rowCount: 84_000,
    });
    assert.equal(v.action, "load");
    assert.ok(
      v.action === "load" && v.actualSessions >= v.expectedSessions,
      "decideCoverage must accept a month both exchanges covered in full",
    );
  });

  it("SKIPS a month with no readable file — that is not a failure", () => {
    // Before a family's floor, or a month the archive does not hold. A REJECT
    // would record a failure that reruns for ever.
    const v = decideMonth({
      datesRead: ds(0),
      sessionDates: ds(0),
      rowCount: 0,
    });
    assert.equal(v.action, "skip");
    assert.match(v.action === "skip" ? v.reason : "", /no day-file/);
  });

  it("SKIPS files-read-but-zero-rows, and says quarantine explains it", () => {
    const v = decideMonth({
      datesRead: ds(21),
      sessionDates: ds(0),
      rowCount: 0,
    });
    assert.equal(v.action, "skip");
    assert.match(v.action === "skip" ? v.reason : "", /quarantine/);
  });

  it("never reports load with a zero expected — `0 >= 0` would accept it", () => {
    assert.equal(
      decideMonth({ datesRead: ds(0), sessionDates: ds(0), rowCount: 1 })
        .action,
      "skip",
    );
  });

  it("takes SETS, so a FILE COUNT cannot be handed to it by mistake", () => {
    // This is the bug, made unrepresentable. The shell holds a file counter and
    // a date set side by side; it handed over the counter, which on every month
    // both exchanges cover reads as double the real expectation and makes
    // `acceptPartition` throw. A `number` is not a `ReadonlySet<string>`.
    const sets = decideMonth({
      datesRead: new Set(["2024-03-01", "2024-03-04"]),
      sessionDates: new Set(["2024-03-01", "2024-03-04"]),
      rowCount: 10,
    });
    assert.equal(sets.action, "load");
    assert.equal(sets.action === "load" && sets.expectedSessions, 2);

    // Four FILES over those same two dates still expects 2, not 4.
    const withOverlap = decideMonth({
      datesRead: new Set(["2024-03-01", "2024-03-01", "2024-03-04"]),
      sessionDates: new Set(["2024-03-01", "2024-03-04"]),
      rowCount: 10,
    });
    assert.equal(
      withOverlap.action === "load" && withOverlap.expectedSessions,
      2,
    );
  });
});

describe("monthDeleteBounds", () => {
  it("is a half-open month, so a 31-day month needs no special case", () => {
    assert.deepEqual(monthDeleteBounds("IN/2024-03"), {
      market: "IN",
      fromInclusive: "2024-03-01",
      toExclusive: "2024-04-01",
    });
  });

  it("rolls the YEAR over in December", () => {
    // A `+1` on the month alone yields `2024-13-01`, which BigQuery rejects —
    // and a caller that clamped it to `2024-12-01` would delete nothing.
    assert.deepEqual(monthDeleteBounds("IN/2024-12"), {
      market: "IN",
      fromInclusive: "2024-12-01",
      toExclusive: "2025-01-01",
    });
  });

  it("spans February in a leap year without naming a day", () => {
    const b = monthDeleteBounds("IN/2024-02");
    assert.equal(b.toExclusive, "2024-03-01");
  });

  it("refuses a partition key it does not recognise", () => {
    // A wrong bound deletes rows that are not being replaced.
    assert.throws(() => monthDeleteBounds("2024-03"), /unrecognised/);
    assert.throws(() => monthDeleteBounds("IN/2024-03-01"), /unrecognised/);
    assert.throws(() => monthDeleteBounds("IN/2024-13"), /01-12/);
  });

  it("round-trips with indiaPartitionKey", () => {
    // The rows deleted and the rows loaded must be the same month BY
    // CONSTRUCTION, not by two spellings agreeing today.
    for (const d of ["2024-01-15", "2024-12-31", "1994-11-03"]) {
      const b = monthDeleteBounds(indiaPartitionKey(d));
      assert.ok(d >= b.fromInclusive && d < b.toExclusive);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Staging — the shard layout this replay needs
   ═══════════════════════════════════════════════════════════════════════ */

describe("stage sharding", () => {
  it("nests a shard under the run so a wildcard cannot cross runs", () => {
    const k = stageKey({
      table: "derivatives_eod_in",
      partitionKey: "IN/2024-03",
      runId: "run-a",
      part: "2024-03-01",
    });
    assert.equal(
      k,
      "lake/stage/derivatives_eod_in/IN/2024-03/run-a/2024-03-01.ndjson",
    );
  });

  it("leaves B2's single-object key untouched when no part is given", () => {
    const k = stageKey({
      table: "price_bar_d1",
      partitionKey: "US/2026-03",
      runId: "run-a",
    });
    assert.equal(k, "lake/stage/price_bar_d1/US/2026-03/run-a.ndjson");
  });

  it("derives the wildcard prefix from the key itself", () => {
    // A prefix that disagrees with the key by one character matches ZERO
    // objects, and `bq load` over zero objects SUCCEEDS with zero rows.
    const args = {
      table: "derivatives_eod_in",
      partitionKey: "IN/2024-03",
      runId: "run-a",
    };
    const prefix = stageShardPrefix(args);
    const key = stageKey({ ...args, part: "2024-03-04" });
    assert.ok(key.startsWith(prefix), `${key} must start with ${prefix}`);
    assert.ok(prefix.endsWith("/"));
  });

  it("two runs never share a shard prefix", () => {
    const base = { table: "price_bar_d1", partitionKey: "IN/2024-03" };
    assert.notEqual(
      stageShardPrefix({ ...base, runId: "run-a" }),
      stageShardPrefix({ ...base, runId: "run-b" }),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   NUMERIC scale — MONEY-1512
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Decimal places as BigQuery will SEE them. The load path is NDJSON, so the
 * question is never what the JS number holds — it is what `JSON.stringify`
 * emits. `15029.864596500001` is a perfectly ordinary float and a REFUSED
 * NUMERIC literal.
 */
function serialisedDecimals(v: unknown): number {
  const s = JSON.stringify(v);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

describe("NUMERIC scale (MONEY-1512)", () => {
  // The exact arithmetic the parser performs: TtlTrfVal is rupees-and-paise
  // and `bhavcopy-derivatives.ts` divides it by 100,000 to get lakh.
  const TTL_TRF_VAL = 1502986459.65;
  const VALUE_LAKH = TTL_TRF_VAL / 100_000;

  function derivative(over: Partial<IndiaDerivative> = {}): IndiaDerivative {
    return {
      underlying: "NIFTY",
      exchange: "NSE",
      instrumentType: "FUTIDX",
      expiryDate: "2026-08-28",
      strike: null,
      optionType: null,
      sessionDate: "2026-08-05",
      open: 24500.1,
      high: 24600.2,
      low: 24400.3,
      close: 24550.4,
      settle: 24550.4,
      openInterest: 12_345,
      changeInOi: -678,
      contractsTraded: 9_012,
      valueLakh: VALUE_LAKH,
      ...over,
    };
  }

  it("the measured production value is a float BigQuery refuses", () => {
    // Pins the premise. If this ever stops holding, the guard below is
    // testing nothing and must be re-derived rather than deleted.
    assert.equal(VALUE_LAKH, 15029.864596500001);
    assert.equal(serialisedDecimals(VALUE_LAKH), 12);
  });

  it("value_lakh is rounded to the column's scale of 6", () => {
    const row = toDerivativeEodRow(derivative(), PROV, "nse-fo-udiff-bhavcopy");
    // Not `<= 6`: a value that happened to round short would let the rule pass
    // by luck. This is the one answer the DDL admits.
    assert.equal(JSON.stringify(row.value_lakh), "15029.864597");
  });

  it("every NUMERIC column of a derivative row is rounded to EXACTLY scale 6", () => {
    // EXACT serialisations, not `<= 6`. A `<= 6` loop passes when a column is
    // over-rounded to 4 places, so it catches only the "no rounding at all"
    // class the three string assertions already catch. Silent precision LOSS
    // has to be pinned from the other side too — MONEY-1512 review.
    const row = toDerivativeEodRow(
      derivative({
        strike: 24500 / 3,
        optionType: "CE",
        instrumentType: "OPTIDX",
        open: 1 / 3,
        high: 2 / 3,
        low: 1 / 7,
        close: 2 / 7,
        settle: 22 / 7,
      }),
      PROV,
      "nse-fo-udiff-bhavcopy",
    );
    const expected: ReadonlyArray<readonly [keyof typeof row, string]> = [
      ["strike_price", "8166.666667"],
      ["open", "0.333333"],
      ["high", "0.666667"],
      ["low", "0.142857"],
      ["close", "0.285714"],
      ["settle_price", "3.142857"],
      ["value_lakh", "15029.864597"],
    ];
    for (const [col, want] of expected) {
      assert.equal(JSON.stringify(row[col]), want, col);
    }
  });

  it("INT64 counts stay decimal strings and are NOT rounded into floats", () => {
    // The sibling defect: routing a count through the rounder would turn a
    // value above 2^53 into a wrong number that still looks like a count.
    const row = toDerivativeEodRow(derivative(), PROV, "nse-fo-udiff-bhavcopy");
    assert.equal(row.open_interest, "12345");
    assert.equal(row.change_in_oi, "-678");
    assert.equal(row.contracts_traded, "9012");
  });

  it("delivery_pct is scale 4, not 6 — it is the one narrower column", () => {
    // NOT a quotient. Both producers parse the exchange's own pre-formatted
    // percent column (`DELIV_PER` on NSE, `delPer` on BSE) and `delivery.ts`
    // divides nothing — an earlier version of this case computed
    // `(3_000_000 / 7_000_000) * 100`, a value the column cannot receive, and
    // its comment asserted a division that does not exist.
    //
    // What IS worth pinning is the COLUMN's contract: whatever reaches this
    // mapper is cut to four places, because scale 4 is narrower than every
    // other NUMERIC in the lake and a fifth place fails the whole load.
    const row = toDeliveryDailyRow(
      {
        symbol: "RELIANCE",
        exchange: "NSE",
        isin: "INE002A01018",
        series: "EQ",
        sessionDate: "2026-08-05",
        tradedQty: 7_000_000,
        deliverableQty: 3_000_000,
        deliveryPct: 42.857142857,
      } satisfies IndiaDelivery,
      PROV,
      "nse-sec-bhavdata-full",
      ID,
    );
    assert.equal(JSON.stringify(row.delivery_pct), "42.8571");
  });

  it("delivery_pct does NOT get the default scale of 6", () => {
    // The mutation this closes: `numeric(d.deliveryPct, DELIVERY_PCT_SCALE)`
    // silently becoming `numeric(d.deliveryPct)`. Six places load-fail a
    // NUMERIC(9, 4) column.
    const row = toDeliveryDailyRow(
      {
        symbol: "TCS",
        exchange: "NSE",
        isin: "INE467B01029",
        series: "EQ",
        sessionDate: "2026-08-05",
        tradedQty: 1_000,
        deliverableQty: 1,
        deliveryPct: 33.333333333,
      } satisfies IndiaDelivery,
      PROV,
      "nse-sec-bhavdata-full",
      ID,
    );
    assert.equal(JSON.stringify(row.delivery_pct), "33.3333");
    assert.notEqual(JSON.stringify(row.delivery_pct), "33.333333");
  });

  it("index ratios — the quotient columns — round to EXACTLY scale 6", () => {
    const row = toIndexEodRow(
      {
        indexSlug: "nifty-50",
        indexName: "NIFTY 50",
        exchange: "NSE",
        sessionDate: "2026-08-05",
        open: 1 / 3,
        high: 2 / 3,
        low: 1 / 7,
        close: 2 / 7,
        prevClose: 3 / 7,
        volume: 42,
        turnoverCr: 1502986459.65 / 10_000_000,
        pe: 100 / 3,
        pb: 10 / 3,
        divYield: 1 / 3,
      } satisfies IndiaIndexClose,
      PROV,
      "nse-indices-close",
    );
    const expected: ReadonlyArray<readonly [keyof typeof row, string]> = [
      ["open", "0.333333"],
      ["high", "0.666667"],
      ["low", "0.142857"],
      ["close", "0.285714"],
      ["prev_close", "0.428571"],
      ["turnover_cr", "150.298646"],
      ["pe_ratio", "33.333333"],
      ["pb_ratio", "3.333333"],
      ["div_yield", "0.333333"],
    ];
    for (const [col, want] of expected) {
      assert.equal(JSON.stringify(row[col]), want, col);
    }
  });
});
