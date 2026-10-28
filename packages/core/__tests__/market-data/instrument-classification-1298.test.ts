/**
 * The three feed-supplied rules that reach the stamped-default rows — MONEY-1298.
 *
 * `instrument_mappings` held 20,850 active rows typed EQUITY. Measured on prod
 * 2026-08-30, the real Indian cash-equity universe is **5,610 distinct symbols**
 * (8,083 ISIN-bearing rows: 3,184 NSE + 4,899 BSE) — so ~61% of that table was
 * not equity. `classifyCashInstrument` abstained on almost all of it, because
 * the one column it read (`series`) is the broker dump's stamped default "EQ"
 * on every row nothing has sourced.
 *
 * ## Why this file exists as a RULE TABLE
 *
 * Each case below is a population that was COUNTED on prod, not an example
 * invented to exercise a branch. The counts are in the case names so a future
 * reader can re-measure them, and so a rule that stops firing is a visible
 * regression rather than a quieter classifier.
 *
 *   segment "INDICES"          213 rows -> INDEX    (NSE 136, BSE 77)
 *   NSE `-XX` symbol suffix  7,149 rows -> DEBT 6,172 · EQUITY 876
 *                                          · INVIT 21 · REIT 6 · UNKNOWN 72
 *   BSE stamped default,
 *   no ISIN, name === symbol 5,392 rows -> DEBT 5,288 · ABSTAIN 104
 *
 * ## The two directions that must BOTH hold
 *
 * A classifier of this kind is only as good as its refusals, and the expensive
 * direction is the false DEBT: a retype clears `sector`/`industry`, and the
 * enrichment pipeline queries `instrumentType: "EQUITY"` only, so a real
 * company typed DEBT leaves the screener and cannot be re-enriched back. So
 * every rule here is paired with the population it must NOT touch — the 876 NSE
 * SME/trade-for-trade rows, the 104 named BSE rows, AUGMONT (a real company
 * with no ISIN yet), and a bare RELIANCE.
 *
 * Source: packages/core/src/market-data/instruments/instrument-classification.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCashInstrument,
  recoverNseSeriesFromSymbol,
  isNonEquityClass,
  STAMPED_DEFAULT_SERIES,
  INDEX_SEGMENT_CODE,
  type ClassifyInput,
} from "../../src/market-data/instruments/instrument-classification";
import { ZerodhaInstrumentProvider } from "../../src/market-data/instruments/zerodha-instruments";
import { composeUpdatePayload } from "../../src/market-data/instruments/instrument-sync";
import type { RawInstrument } from "../../src/market-data/instruments/types";

/**
 * A row exactly as prod stores it: Kite's stamped "EQ", no ISIN, `name` equal
 * to the code for anything Kite has no company name for.
 */
function row(over: Partial<ClassifyInput> & { symbol: string }): ClassifyInput {
  return {
    name: over.name ?? over.symbol,
    exchange: "NSE",
    series: STAMPED_DEFAULT_SERIES,
    isin: null,
    segmentCode: "NSE",
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// RULE 1 — the exchange's own segment
// ───────────────────────────────────────────────────────────────────────────

describe("rule: segment INDICES -> INDEX (213 rows)", () => {
  it("types the NSE index pseudo-rows as INDEX (136 rows)", () => {
    for (const symbol of [
      "NIFTY 50",
      "NIFTY BANK",
      "NIFTY MIDCAP 100",
      "INDIA VIX",
      "NIFTY IT",
    ]) {
      const r = classifyCashInstrument(
        row({ symbol, segmentCode: INDEX_SEGMENT_CODE }),
      );
      assert.equal(r.klass, "INDEX", `${symbol} must be INDEX`);
      assert.equal(r.reason, "segment-indices");
    }
  });

  it("types the BSE index pseudo-rows as INDEX (77 rows)", () => {
    // Note SENSEX, AUTO, POWER and REALTY: pure-alpha symbols that a name or
    // symbol heuristic would happily read as tickers. The segment is what
    // separates them, which is the entire argument for using it.
    for (const [symbol, name] of [
      ["SENSEX", "SENSEX"],
      ["BANKEX", "BSE INDEX BANKEX"],
      ["AUTO", "BSE INDEX AUTO"],
      ["REALTY", "BSE INDEX REALTY"],
      ["METALINDEX", "BSE INDEX METAL"],
    ] as const) {
      const r = classifyCashInstrument(
        row({ symbol, name, exchange: "BSE", segmentCode: INDEX_SEGMENT_CODE }),
      );
      assert.equal(r.klass, "INDEX", `${symbol} must be INDEX`);
    }
  });

  it("does NOT catch the funds that TRACK an index", () => {
    // The three index-NAMED rows outside the INDICES segment on prod are all
    // real Nifty-50 ETFs with real ISINs. A name matcher cannot tell them from
    // the index — the fund is named after it — and `isETF` fires on " ETF"
    // anywhere in the name, so ordering the segment check FIRST is what keeps
    // this from being a coin flip.
    const r = classifyCashInstrument(
      row({
        symbol: "NIFTYJBLK",
        name: "JIOBLACKROCK NIFTY 50 ETF",
        isin: "INF22M001184",
        segmentCode: "NSE",
      }),
    );
    assert.equal(r.klass, "ETF");
    assert.notEqual(r.klass, "INDEX");
  });

  it("the segment beats the ETF NAME matcher, not the other way round", () => {
    // Mutation target. Move the INDICES check below `isETF` and this flips to
    // ETF: the name carries " ETF" and the symbol is an index pseudo-row.
    const r = classifyCashInstrument(
      row({
        symbol: "SOME INDEX",
        name: "SOME ETF INDEX",
        segmentCode: INDEX_SEGMENT_CODE,
      }),
    );
    assert.equal(r.klass, "INDEX", "segment must outrank the name heuristic");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RULE 2 — the NSE series, recovered from the trading symbol
// ───────────────────────────────────────────────────────────────────────────

describe("rule: NSE `-XX` symbol suffix IS the series (7,149 rows)", () => {
  /**
   * Every NSE debt family measured on prod, with its row count. `-SG` alone is
   * 4,308 rows — state development loans, the single largest mistyped block in
   * the table.
   */
  const DEBT_CASES: Array<[string, string, number]> = [
    ["664UP30-SG", "SDL UP 6.64% 2030", 4308],
    ["667GS2050-GS", "GOI LOAN  6.67% 2050", 132],
    ["364D280826-TB", "GOI TBILL 364D-28/08/26", 86],
    ["SGBSEP28VI-GB", "2.50%GOLDBONDS2028SR-VI", 45],
    ["965SCL25C-N0", "965SCL25C-N0", 985],
    ["79NHIT35-N1", "79NHIT35-N1", 107],
    ["855IREDA29-N2", "855IREDA29-N2", 37],
    ["855IREDA34-N3", "855IREDA34-N3", 29],
    ["875NHAI29-N6", "875NHAI29-N6", 24],
    ["861REC34-ND", "861REC34-ND", 20],
    ["97SFL28-YS", "97SFL28-YS", 3],
    ["87SCL27-Z6", "87SCL27-Z6", 2],
  ];

  for (const [symbol, name, n] of DEBT_CASES) {
    it(`types ${symbol} as DEBT (family measured at ${n} rows)`, () => {
      const r = classifyCashInstrument(row({ symbol, name }));
      assert.equal(r.klass, "DEBT", `${symbol} is a bond, not a company`);
      assert.match(
        r.reason,
        /^nse-symbol-series/,
        "the reason must record that the verdict came from the SYMBOL, not " +
          "from a sourced `series` column — an auditor reading the dry run " +
          "has to be able to tell those apart",
      );
    });
  }

  it("types the trust series RR/IV as REIT/INVIT (6 + 21 rows)", () => {
    assert.equal(
      classifyCashInstrument(
        row({ symbol: "EMBASSY-RR", name: "EMBASSY OFFICE PARKS REIT" }),
      ).klass,
      "REIT",
    );
    assert.equal(
      classifyCashInstrument(
        row({ symbol: "PGINVIT-IV", name: "POWERGRID INFRA INVESTMENT TRUST" }),
      ).klass,
      "INVIT",
    );
  });

  it("leaves the 876 SME / trade-for-trade EQUITY suffixes as EQUITY", () => {
    // THE case that decides whether this rule is safe to run. These are real
    // securities — 455 `-SM`, 249 `-BE`, 128 `-ST`, 38 `-BZ`, plus `-IT`, `-SZ`
    // and `-E1` — and 446 of them carry 13,917 `daily_prices` rows on the
    // SUFFIXED id. Recovering the series and feeding it to the SAME tables the
    // price feed uses is what makes them come back EQUITY instead of falling
    // into a suffix-is-debt heuristic.
    for (const [symbol, name] of [
      ["OMFURN-SM", "OMFURN INDIA"],
      ["RELINFRA-BE", "RELIANCE INFRASTRUCTURE"],
      ["UCL-ST", "USHANTI COLOUR CHEM"],
      ["SANWARIA-BZ", "SANWARIA CONSUMER"],
      ["BDR-IT", "BDR BUILDCON"],
      ["PERFECT-SZ", "PERFECT INFRAENGINEER"],
      ["ATLPP-E1", "ATL RE.0.50 PPD UP"],
    ] as const) {
      const r = classifyCashInstrument(row({ symbol, name }));
      assert.equal(r.klass, "EQUITY", `${symbol} is a real security`);
    }
  });

  it("ABSTAINS on the 72 suffixes NSE has not published a meaning for", () => {
    // `-SF` (50), `-RL` (6, ETF iNAV pseudo-rows), `-D1` (2), `-W1` (warrants),
    // and the A*/B* codes (13). The A/B families look like debt from their
    // symbols and are NOT added to `NSE_SERIES_FAMILIES_UNPRICED`, because the
    // NSE equity series `BE` and `BZ` start with B — a family rule on that
    // letter would type 287 real equities DEBT. Abstaining is the answer until
    // someone reads the circular.
    for (const symbol of [
      "MHLSRD-SF",
      "AXISILINAV-RL",
      "CHOLAFIN-D1",
      "ELECTCAST-W1",
      "971SCL28-AN",
      "925SCL28I-BA",
    ]) {
      const r = classifyCashInstrument(row({ symbol }));
      assert.equal(r.klass, "UNKNOWN", `${symbol} must abstain`);
    }
  });

  it("a bare RELIANCE is untouched, with or without an ISIN", () => {
    for (const isin of [null, "INE002A01018"]) {
      const r = classifyCashInstrument(
        row({ symbol: "RELIANCE", name: "RELIANCE INDUSTRIES", isin }),
      );
      assert.equal(r.klass, "EQUITY");
      assert.equal(r.reason, "nse-series-EQ", "no recovery, no re-tagging");
    }
  });

  it("refuses to recover a series once an exchange master has claimed the row", () => {
    // KLBRENG-B, MCCHRLS-B and UMIYA-MRO are real companies whose TICKER
    // contains a dash. None matches a two-character suffix today, so the ISIN
    // gate is protecting against the fourth one — a real company whose suffix
    // DOES collide with a debt series. Without the gate that company is typed
    // DEBT and disappears from the screener.
    assert.equal(
      recoverNseSeriesFromSymbol({
        symbol: "REALCO-SG",
        exchange: "NSE",
        series: "EQ",
        isin: "INE123A01010",
      }),
      null,
      "an ISIN-bearing row must never have a series recovered from its symbol",
    );
    assert.equal(
      classifyCashInstrument(
        row({ symbol: "REALCO-SG", name: "REAL CO", isin: "INE123A01010" }),
      ).klass,
      "EQUITY",
      "…and must therefore fall through to the stored series",
    );
  });

  it("refuses to recover when the row already carries a REAL series", () => {
    // A sourced value outranks a symbol suffix. Otherwise a row the bhavcopy
    // correctly typed would be re-decided from a stale ticker.
    assert.equal(
      recoverNseSeriesFromSymbol({
        symbol: "SOMECO-SG",
        exchange: "NSE",
        series: "BE",
        isin: null,
      }),
      null,
    );
  });

  it("treats an EMPTY series as no evidence, not as the stamp", () => {
    // "empty" and "the broker's default" are different states and must stay
    // that way: the former has to keep abstaining.
    assert.equal(
      recoverNseSeriesFromSymbol({
        symbol: "SOMECO-SG",
        exchange: "NSE",
        series: null,
        isin: null,
      }),
      null,
    );
    assert.equal(
      classifyCashInstrument(row({ symbol: "SOMECO-SG", series: null })).klass,
      "UNKNOWN",
    );
  });

  it("only matches a TWO-character suffix", () => {
    // Same shape guard the price feed uses. `-MRO` and `-NAV` are three chars
    // and `-B` is one; none may fall into a family bucket by accident.
    for (const symbol of ["UMIYA-MRO", "KLBRENG-B", "HANGSENG BEES-NAV"]) {
      assert.equal(
        recoverNseSeriesFromSymbol({
          symbol,
          exchange: "NSE",
          series: "EQ",
          isin: null,
        }),
        null,
        `${symbol} must not yield a series`,
      );
    }
  });

  it("does not apply the NSE convention to BSE symbols", () => {
    // BSE does not encode a series in the trading symbol. `RAMAPPR-B` is a real
    // BSE company on group Z.
    assert.equal(
      recoverNseSeriesFromSymbol({
        symbol: "SOMECO-SG",
        exchange: "BSE",
        series: "EQ",
        isin: null,
      }),
      null,
    );
  });

  it("the recovered series reaches the DEBT check BEFORE the trust NAME matcher", () => {
    // The inversion this classifier already fixed once, re-opened by recovering
    // the series in the wrong place. An NCD issued by an infrastructure trust
    // is named "… Trust NCD"; if the name matcher runs first it returns INVIT
    // on the strength of the word "Trust" and the exchange's own explicit "this
    // is series N1" never gets read.
    //
    // BOTH arms of `seriesSaysDebt` are exercised, and the second one was added
    // because the first mutation run proved this case vacuous without it:
    // `seriesSaysDebt` is an OR of an EXACT-match lookup and a FAMILY-prefix
    // lookup, and `-N1` only reaches the family arm. Breaking the exact arm
    // alone left the suite green — a test that named the invariant while
    // covering half of it.
    const family = classifyCashInstrument(
      row({
        symbol: "79NHIT35-N1",
        name: "NATIONAL HIGHWAYS INFRA TRUST NCD - INVIT",
      }),
    );
    assert.equal(
      family.klass,
      "DEBT",
      "family arm: the series outranks the name",
    );

    const exact = classifyCashInstrument(
      row({
        symbol: "664UP30-SG",
        name: "UP INFRASTRUCTURE INVESTMENT TRUST SDL",
      }),
    );
    assert.equal(
      exact.klass,
      "DEBT",
      "exact arm: the series outranks the name",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RULE 3 — BSE rows the scrip master has never sourced
// ───────────────────────────────────────────────────────────────────────────

describe("rule: BSE stamped default + no ISIN + code-for-a-name (5,392 rows)", () => {
  it("types the 5,288 bond / CP / SDL codes as DEBT", () => {
    for (const symbol of [
      "778JCL29",
      "1048NHF27",
      "DCBL080726",
      "IOCL10726",
      "91SKFL28",
      "1250ICLF27",
      "77861HDB36",
      "TCAPPERP",
      "CHOLACCD",
      "VALIANTOCPS",
    ]) {
      const r = classifyCashInstrument(
        row({ symbol, exchange: "BSE", segmentCode: "BSE" }),
      );
      assert.equal(r.klass, "DEBT", `${symbol} is a debt code`);
      assert.equal(r.reason, "bse-unenriched-code");
    }
  });

  it("ABSTAINS on the 104 rows that carry a real company name", () => {
    // The rule MONEY-1302 proposed — "BSE group EQ and no ISIN" — would have
    // typed every one of these DEBT. ~45 are real companies; a false DEBT
    // verdict removes them from the screener and clears their sector with no
    // re-enrichment path back.
    for (const [symbol, name] of [
      ["TEMPSENS", "TEMPSENS INSTRUMENTS (INDIA) L"],
      ["NOVYRA", "NOVYRA PHARMACHEM"],
      ["BENARA", "BENARA BEARINGS AND PISTONS LI"],
      ["KUSUMEL", "KUSAM ELECTRICAL INDUSTRIES LT"],
      ["BROACH", "BROACH LIFECARE HOSPITAL LIMIT"],
      ["GDIL", "GLOBAL DEFENCE INDUSTRIES LIMI"],
      ["UNIJOLL", "UNIJOLLY INVESTMENTS CO.LTD."],
      ["08ADD", "NIPPON INDIA MUTUAL FUND"],
    ] as const) {
      const r = classifyCashInstrument(
        row({ symbol, name, exchange: "BSE", segmentCode: "BSE" }),
      );
      assert.equal(r.klass, "UNKNOWN", `${symbol} (${name}) must abstain`);
      assert.match(r.reason, /unrecognised/);
    }
  });

  it("never fires on a row an exchange master HAS sourced", () => {
    // Two independent exits: a real group letter, and an ISIN.
    assert.equal(
      classifyCashInstrument(
        row({ symbol: "BEPL", exchange: "BSE", series: "B", isin: null }),
      ).klass,
      "EQUITY",
    );
    assert.equal(
      classifyCashInstrument(
        row({
          symbol: "TEMPSENS",
          exchange: "BSE",
          series: "EQ",
          isin: "INE123A01010",
        }),
      ).klass,
      "UNKNOWN",
      "an ISIN-bearing row must abstain, never be typed DEBT",
    );
  });

  it("keeps abstaining on a genuinely unknown BSE group", () => {
    // A new BSE equity group must not become debt on the strength of its name.
    const r = classifyCashInstrument(
      row({ symbol: "NEWCO", exchange: "BSE", series: "Q" }),
    );
    assert.equal(r.klass, "UNKNOWN");
    assert.match(r.reason, /unrecognised/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The gate that is NOT a signal
// ───────────────────────────────────────────────────────────────────────────

describe("absence of an ISIN is a gate, never a verdict", () => {
  it("AUGMONT — a real, newly-listed NSE company with no ISIN — stays EQUITY", () => {
    // The falsification of "no ISIN therefore not equity". AUGMONT ENTERPRISES
    // is on prod today with no ISIN, no dash suffix and Kite's own company
    // name. Every rule here requires a POSITIVE feed signal on top of the
    // absence, which is why it survives all three.
    const r = classifyCashInstrument(
      row({ symbol: "AUGMONT", name: "AUGMONT ENTERPRISES" }),
    );
    assert.equal(r.klass, "EQUITY");
  });

  it("NIF500BETA — no ISIN, no suffix, a real name — stays EQUITY too", () => {
    const r = classifyCashInstrument(
      row({ symbol: "NIF500BETA", name: "UTIAMC - NIF500BETA" }),
    );
    assert.equal(r.klass, "EQUITY");
  });
});

describe("INDEX is a non-equity class", () => {
  it("isNonEquityClass covers it", () => {
    // `reclassify-instruments.ts` retypes DEBT + INDEX; a class that is not
    // listed here reads as "equity, or we do not know" to every other caller.
    assert.equal(isNonEquityClass("INDEX"), true);
    assert.equal(isNonEquityClass("EQUITY"), false);
    assert.equal(isNonEquityClass("UNKNOWN"), false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Survival: the nightly Zerodha sync must not revert any of this
// ───────────────────────────────────────────────────────────────────────────

describe("a retyped row survives the 22:00 Zerodha instrument sync", () => {
  /** The `-SG` row as Kite hands it over: stamped "EQ", no ISIN, type EQUITY. */
  function kiteRow(over: Partial<RawInstrument> = {}): RawInstrument {
    return {
      symbol: "664UP30-SG",
      exchange: "NSE",
      name: "SDL UP 6.64% 2030",
      tradingSymbol: "664UP30-SG",
      instrumentType: "EQUITY",
      series: "EQ",
      lotSize: 1,
      tickSize: 0.01,
      zerodhaToken: 999,
      ...over,
    } as RawInstrument;
  }

  it("the composed UPDATE payload carries no instrumentType and no series", () => {
    const zerodha = new ZerodhaInstrumentProvider();
    const raw = kiteRow();
    const out = composeUpdatePayload(
      zerodha,
      raw,
      zerodha.mapToUpsert(raw),
      "664UP30-SG.NS",
    );
    assert.ok(
      !("instrumentType" in out),
      "Kite's generic EQUITY must not reach an existing row — this is the " +
        "field that would revert the DEBT retype within 24h",
    );
    assert.ok(
      !("series" in out),
      "the stamped 'EQ' must not reach an existing row either — the whole " +
        "recovery rule keys on it, so re-stamping it would re-open the case " +
        "every night",
    );
  });

  it("applying that payload leaves the DEBT verdict intact", () => {
    // The JOIN, not the halves. The payload assertion above is necessary and
    // not sufficient: what matters is the row's verdict AFTER a sync, so this
    // simulates the write and re-classifies.
    const zerodha = new ZerodhaInstrumentProvider();
    const raw = kiteRow();
    const update = composeUpdatePayload(
      zerodha,
      raw,
      zerodha.mapToUpsert(raw),
      "664UP30-SG.NS",
    ) as Record<string, unknown>;

    // The stored row as it stands the morning after `reclassify --apply`.
    const stored: Record<string, unknown> = {
      symbol: "664UP30-SG",
      name: "SDL UP 6.64% 2030",
      exchange: "NSE",
      series: "EQ",
      isin: null,
      segmentCode: "NSE",
      instrumentType: "DEBT",
      sector: null,
    };
    const after = { ...stored, ...update };

    assert.equal(
      after.instrumentType,
      "DEBT",
      "the sync must not have moved the row back to EQUITY",
    );
    assert.equal(
      classifyCashInstrument({
        symbol: String(after.symbol),
        name: String(after.name),
        exchange: String(after.exchange),
        series: after.series as string | null,
        isin: after.isin as string | null,
        segmentCode: after.segmentCode as string | null,
      }).klass,
      "DEBT",
      "and the verdict must still be reachable from the post-sync row",
    );
  });

  it("an INDEX row survives it too — segmentCode is what the sync CAN rewrite", () => {
    // Zerodha's `mapToUpdate` narrows away `series` and `instrumentType` but
    // KEEPS `segmentCode`, so the INDEX rule's own input is the one field the
    // nightly sync is still authoritative for. It rewrites it to the same
    // value, which is why the retype holds — and it is also why
    // `reclassify-instruments.ts` pins `segmentCode` in its write guard.
    const zerodha = new ZerodhaInstrumentProvider();
    const raw = kiteRow({
      symbol: "NIFTY 50",
      tradingSymbol: "NIFTY 50",
      name: "NIFTY 50",
      instrumentType: "INDEX",
      segmentCode: INDEX_SEGMENT_CODE,
    } as Partial<RawInstrument>);
    const update = composeUpdatePayload(
      zerodha,
      raw,
      zerodha.mapToUpsert(raw),
      "^NSEI",
    ) as Record<string, unknown>;

    assert.ok(!("instrumentType" in update));
    const after = {
      symbol: "NIFTY 50",
      name: "NIFTY 50",
      exchange: "NSE",
      series: "EQ",
      isin: null,
      segmentCode: INDEX_SEGMENT_CODE,
      instrumentType: "INDEX",
      ...update,
    };
    assert.equal(after.instrumentType, "INDEX");
    assert.equal(
      classifyCashInstrument({
        symbol: String(after.symbol),
        name: String(after.name),
        exchange: String(after.exchange),
        series: after.series as string | null,
        isin: after.isin as string | null,
        segmentCode: after.segmentCode as string | null,
      }).klass,
      "INDEX",
    );
  });
});

describe("bse-unenriched-code: the parser can FABRICATE name === symbol", () => {
  // `mapCSVRowToRaw` writes `name: row.name || baseSymbol`, so a row Kite ships
  // with a blank name arrives here indistinguishable from one where Kite
  // repeated the instrument code — and only the second is evidence of a bond.
  // The classifier's abstention for a nameless row is real but UNREACHABLE from
  // the pipeline, because the `||` has already run.
  //
  // This is the same defect as the abstention fixture fixed earlier in this
  // ticket (a helper defaulting `name = symbol`), one layer up in production
  // code rather than in a test.
  const bse = (symbol: string, name: string) =>
    classifyCashInstrument({
      symbol,
      name,
      exchange: "BSE",
      series: "EQ",
      isin: null,
    } as Parameters<typeof classifyCashInstrument>[0]);

  it("does NOT type a real company as DEBT when Kite shipped no name", () => {
    // Every company MONEY-1298 exists to protect is purely alphabetic, which is
    // what the digit requirement keys on. Without it, `name || baseSymbol`
    // hands this row the exact bond signature and the verdict is irreversible:
    // DEBT clears sector/industry and the enrichment pipeline queries
    // `instrumentType: "EQUITY"` only.
    for (const sym of [
      "TEMPSENS",
      "NOVYRA",
      "BENARA",
      "AUGMONT",
      "PILANI INVE", // measured in prod: a REAL company this rule typed DEBT
    ]) {
      assert.notEqual(
        bse(sym, sym).klass,
        "DEBT",
        `${sym} must not be typed DEBT`,
      );
    }
  });

  it("does NOT type a REIT/InvIT as DEBT when Kite shipped no name", () => {
    // A blank name simultaneously disarms `classifyTrustInstrument` (it reads
    // the NAME only) and arms this rule, so the trust classes are the most
    // exposed of all.
    assert.notEqual(bse("NHITINVIT", "NHITINVIT").klass, "DEBT");
  });

  it("does NOT type a BSE INDEX row as DEBT", () => {
    // 10 of the 19 digit-free rows carry segment INDICES. The INDEX rule claims
    // them only when a caller PASSES `segmentCode`, and neither live caller
    // does — so reached without it they were landing here.
    for (const sym of ["SENSEX", "BSE PSU BANK", "FINANCIAL SERVICES"]) {
      assert.notEqual(
        bse(sym, sym).klass,
        "DEBT",
        `${sym} must not be typed DEBT`,
      );
    }
  });

  it("STILL types a real bond code as DEBT", () => {
    // The 5,283 rows the rule exists for. Losing these would be the other
    // failure, so this is the half that stops the guard being written by
    // simply disabling the rule.
    for (const sym of [
      "1020NFL27",
      "778JCL29",
      "DCBL080726",
      "IOCL10726",
      "91SKFL28",
    ]) {
      assert.equal(bse(sym, sym).klass, "DEBT", `${sym} must be typed DEBT`);
      assert.equal(bse(sym, sym).reason, "bse-unenriched-code");
    }
  });

  it("a sourced company name still abstains, digits or not", () => {
    // The original signal, unchanged: a real name is not a repeated code.
    assert.notEqual(bse("1020NFL27", "Some Issuer Ltd").klass, "DEBT");
    assert.notEqual(
      bse("TEMPSENS", "Tempsens Instruments (India) Ltd").klass,
      "DEBT",
    );
  });
});
