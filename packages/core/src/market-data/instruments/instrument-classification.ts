/* =====================================================================
   Cash-instrument classification  (MONEY-1093)
   ---------------------------------------------------------------------
   `InstrumentMapping` held 22,090 active rows typed EQUITY, of which
   11,795 were mistyped — ~9,600 with no usable sector. They were not unclassified equities —
   they were DEBT instruments mistyped as equity:

     885PFL31    8.85% Piramal Finance 2031
     689IRFC31   6.89% IRFC 2031
     726NHAI38   7.26% NHAI 2038
     EPDPGSEC28  a G-Sec

   Worse, ~2,200 of them carried a real sector ("0795GOI32" — a GOI bond
   — labelled "Financial Services"), because two writers wrote whatever
   Yahoo or Gemini returned. The instrument master is built from the
   Zerodha dump, which types every cash instrument `EQ`.

   ## Why this is not a symbol-pattern matcher

   Bonds are named after their coupon, so `^\d+[A-Z]+\d{2}` looks
   tempting. Measured against prod it hit 2,236 wrong rows and recalled
   only 2,752 of 11,795. It fails in BOTH directions:

     - real equities start with digits: 3MINDIA, 5PAISA, 63MOONS,
       20MICRONS, 1STCUS, 3PLAND
     - real bonds don't always match: CSAI240226, EPDPGSEC28, NWFL24226

   The pattern correlates with the truth without being it, which is the
   worst property a heuristic can have — it survives casual testing.

   ## The actual signal: the exchange's own settlement series

   Both exchanges publish it daily in the bhavcopy — but only the BSE half
   survives ingestion. `parseUdiffBhavcopy` applies `keepSeries` at parse time,
   and the NSE branch keeps only `NSE_CASH_SERIES`, so NSE debt rows
   (GS/GB/TB/SG and the N-, Y-, Z-prefixed families) are dropped before anything can persist their
   series. This classifier is correct for both exchanges when GIVEN a series;
   the PIPELINE only ever supplies one for BSE. NSE debt is therefore out of
   scope for the automated repair — see the note in
   `workers/src/processors/bhavcopy-sync-logic.ts`.

     - NSE issues a two-character series per instrument. The equity ones
       are enumerated in `NSE_CASH_SERIES`; the debt ones in
       `NSE_SERIES_INTENTIONALLY_UNPRICED` (GS/GB/TB/SG…) and the
       churning families `N*`/`Y*`/`Z*`. That knowledge already existed
       in `bhavcopy.ts` for the PRICE feed and is reused verbatim here
       rather than re-listed, so the two cannot drift.

     - BSE issues a group letter. Measured on the live 2026-07-29 file:
       group `F` (369 rows) and `G` (43 rows) are debt and government
       securities; the remaining 4,433 rows across A/B/X/XT/T/M/MT/Z/E/
       IF/P/MS are equity. 408 of those 412 F/G rows also carry a
       non-equity ISIN type — two independent signals agreeing.
       `FinInstrmTp` is uniformly `STK` and therefore useless: it
       separates the cash segment from derivatives, not equity from debt
       within it.

   ## Absence is not evidence

   A bhavcopy contains only what traded that day (4,845 BSE rows against
   12,674 active BSE instruments). So a known series is a decision and an
   UNKNOWN series is an abstention — never "therefore equity". Callers
   must treat UNKNOWN as "insufficient information", which is why this
   returns a discriminated result rather than a boolean.

   ## MONEY-1298: the abstentions were most of the table

   The paragraphs above are still true, and they were also most of the
   problem. `series` is the stamped default "EQ" on every row nothing has
   sourced, so the honest abstention above covered 12,541 of the 20,850
   active rows typed EQUITY. Measured on prod 2026-08-30, the real Indian
   cash-equity universe is **5,610 distinct symbols** (8,083 rows: 3,184 NSE
   + 4,899 BSE, all ISIN-bearing) — so ~61% of the "equity" table was not
   equity, and every consumer that reads it was wrong in a way no null check
   could see. ISIN coverage read "8,083 of 20,850" and looked like a broken
   enricher when it is 100% of the real set.

   The fix is not a looser series rule. It is three MORE signals, each one
   supplied by the feed rather than inferred from the string:

     1. `segmentCode === "INDICES"`  — Kite naming an index outright.
                                       213 rows (NSE 136, BSE 77) -> INDEX.
     2. The NSE trading symbol's `-XX` suffix IS the NSE series, and
        `extractBaseSymbol` keeps it. Recover it and feed it to the SAME
        tables used above. 7,149 rows -> DEBT 6,172, EQUITY 876 (untouched),
        INVIT 21, REIT 6, UNKNOWN 72.
     3. A BSE row on the stamped default, with no ISIN, whose Kite `name` is
        the instrument CODE repeated -> DEBT. 5,288 of 5,392; the 104 with a
        real company name keep abstaining.

   Two rules that were considered and REJECTED on measurement, because both
   would have typed real companies DEBT:

     - "no ISIN -> not equity". AUGMONT ENTERPRISES is a real, newly-listed
       NSE company with no ISIN yet. Absence of an ISIN is a NECESSARY gate
       here, never a sufficient signal.
     - "BSE group EQ + no ISIN -> DEBT" (the shape MONEY-1302 proposed).
       That population holds ~45 real companies — TEMPSENS INSTRUMENTS,
       NOVYRA PHARMACHEM, BENARA BEARINGS, GLOBAL DEFENCE INDUSTRIES — plus
       ~45 exchange-listed MF plans and ~55 BSE index rows. A false DEBT
       verdict deletes a company from the screener and clears its sector
       with no re-enrichment path, so the rule carries the name test.
   ===================================================================== */

import {
  NSE_CASH_SERIES,
  NSE_SERIES_INTENTIONALLY_UNPRICED,
  NSE_SERIES_FAMILIES_UNPRICED,
} from "../bhavcopy";
import {
  isETF,
  classifyTrustInstrument,
  NSE_TRUST_SERIES,
} from "./zerodha-instruments-logic";

/** What a cash-segment instrument actually is. */
export type CashInstrumentClass =
  | "EQUITY"
  | "DEBT"
  | "ETF"
  | "REIT"
  | "INVIT"
  /** Mutual-fund units listed on an exchange. */
  | "MF"
  /**
   * A published index level, not a security. NIFTY 50, SENSEX, INDIA VIX.
   * Already a documented `InstrumentMapping.instrumentType` value and already
   * read by `getIndices`, `discover-indices` and `quote-service`'s
   * QUOTABLE_TYPES — nothing new is being invented here.
   */
  | "INDEX"
  /** Insufficient information — do NOT default this to EQUITY. */
  | "UNKNOWN";

/**
 * The value `series` carries when NOTHING has sourced it from an exchange.
 *
 * The Kite dump stamps its own `instrument_type` column into `series`, and that
 * column is "EQ" for every cash instrument — bonds, T-bills, SDLs, commercial
 * paper and index pseudo-rows alike (`zerodha-instruments-logic.ts`
 * `mapCSVRowToRaw`). So on BOTH exchanges "EQ" means "Kite said cash segment",
 * never "this instrument settles on the EQ series".
 *
 * On BSE that is detectable on its own — BSE issues group LETTERS and has never
 * issued "EQ" — which is why the BSE branch abstains on it today. On NSE it is
 * not: "EQ" is a real NSE main-board series, so an unsourced row is
 * indistinguishable from a genuine equity by this column alone.
 *
 * MONEY-1298 keys both new rules on this exact literal rather than on
 * "empty-or-EQ". An EMPTY series means "no evidence at all" and must keep
 * abstaining; this means "the broker dump's default, which is not evidence".
 * Measured on prod 2026-08-30, all 7,149 candidate NSE rows and all 5,392
 * candidate BSE rows carry the literal string — none carry null.
 */
/**
 * Hybrid instruments whose symbol carries no digit but whose SUFFIX names the
 * instrument type outright. Standard Indian market vocabulary, not a list of
 * particular securities:
 *
 *   PERP  perpetual bond              TCAPPERP
 *   CCD   compulsorily convertible debenture   CHOLACCD, SMILCCD
 *   OCPS  optionally convertible preference shares   VALIANTOCPS
 *
 * Deliberately SHORT and deliberately about instrument classes. It exists so
 * `looksLikeInstrumentCode` can keep four correct DEBT verdicts that a
 * digit-only test would abstain on; it is not a place to add a symbol because
 * a particular row came out wrong.
 */
const HYBRID_DEBT_SUFFIXES = ["PERP", "CCD", "OCPS"] as const;

/**
 * Does this symbol read as an instrument CODE rather than a company ticker?
 *
 * Guards the `bse-unenriched-code` rule against a signal the pipeline
 * fabricates: `mapCSVRowToRaw` writes `name: row.name || baseSymbol`, so a row
 * Kite shipped with no name arrives with `name === symbol` and is
 * indistinguishable from one where Kite repeated the code.
 *
 * Measured on prod 2026-08-31 across the 5,302 rows the rule fires on: 5,283
 * carry a digit, and of the 19 that do not, exactly 4 are debt (the suffixes
 * above). The rest are 10 index rows, 4 MF plans and one real company.
 */
function looksLikeInstrumentCode(symbol: string): boolean {
  if (/\d/.test(symbol)) return true;
  const upper = symbol.toUpperCase();
  return HYBRID_DEBT_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

export const STAMPED_DEFAULT_SERIES = "EQ";

/**
 * Kite's `segment` value for exchange-published INDEX levels.
 *
 * This is the exchange/broker saying "this is an index" in its own words, which
 * is why it outranks every name and symbol heuristic in this file. Measured on
 * prod 2026-08-30 over the 20,850 active rows typed EQUITY:
 *
 *   segment INDICES : 213 rows (NSE 136, BSE 77), ZERO of them carrying an ISIN
 *
 * and the only three index-NAMED rows OUTSIDE it — NIFTYAXIS, NIFTYJBLK (x2) —
 * are genuine Nifty-50 ETFs with real ISINs, sitting in segment NSE/BSE. So the
 * segment separates the index from the fund that tracks it, which is exactly
 * the distinction a name matcher cannot make: "JIOBLACKROCK NIFTY 50 ETF" and
 * "NIFTY 50" differ by their segment, not by their name.
 */
export const INDEX_SEGMENT_CODE = "INDICES";

/**
 * BSE groups that are NOT equity.
 *
 * Measured on the live BSE equity bhavcopy for 2026-07-29:
 *   F  369 rows — corporate debt / NCDs / debentures
 *   G   43 rows — government securities
 * 408/412 of them carry a non-`01` ISIN type, corroborating independently.
 *
 * Deliberately a DENY-list rather than an allow-list of equity groups: BSE
 * adds groups over time (M/MT/MS for SME arrived later), and a new equity
 * group appearing should default to equity, not silently become debt.
 */
/**
 * NSE two-character series -> what the instrument actually IS.
 *
 * Deliberately separate from `NSE_SERIES_INTENTIONALLY_UNPRICED` in
 * `bhavcopy.ts`, which answers a DIFFERENT question — "should the price feed
 * skip this row?" — and includes rows skipped for pricing reasons rather than
 * because they are debt. Reusing it typed partly-paid shares and suspended SME
 * equity as DEBT.
 *
 * A drift test asserts every member of the pricing list appears here, so a new
 * unpriced series cannot silently fall through to the abstention branch.
 */
export const NSE_SERIES_CLASS: Record<string, CashInstrumentClass> = {
  // Genuinely debt.
  GS: "DEBT", // government loans (G-Secs)
  GB: "DEBT", // sovereign gold bonds
  TB: "DEBT", // treasury bills
  SG: "DEBT", // state development loans
  // Preference shares: equity in law, debt in behaviour (fixed coupon, no
  // upside), and not comparable to ordinary shares on any per-share metric —
  // which is the thing misclassification breaks. Matches the BSE segment map.
  P1: "DEBT",
  // NOT debt. Unpriced for other reasons.
  MF: "MF", // fund units — the AMFI/MutualFundMaster pipeline owns these
  E1: "EQUITY", // partly-paid SHARES; a separate corporate-action lifecycle
  SZ: "EQUITY", // suspended SME equity — no continuous price series
};

export const BSE_DEBT_GROUPS = new Set(["F", "G"]);

/**
 * The 12 BSE equity groups OBSERVED on the live equity bhavcopy (2026-07-29),
 * i.e. the values that are genuinely BSE equity groups at all.
 *
 * Counted directly from the file, and the totals reconcile exactly:
 *   B 1520 · X 1125 · A 714 · XT 359 · T 248 · M 235 · MT 104 · Z 58 · E 37
 *   · IF 18 · P 12 · MS 3   = 4,433 equity
 *   + F 369 + G 43          =   412 debt      → 4,845 rows total
 *
 * An earlier revision also listed "W" and "DR". Neither appears anywhere in
 * that file, so they were assumptions wearing the costume of a measurement —
 * and an unverified entry defeats the entire point of an allow-list: if BSE
 * uses either for a debt group, the list would hand back a confident EQUITY.
 * Removing them is not a loss of coverage; an unseen group now abstains,
 * lands in the abstention report, and prompts someone to read the circular.
 *
 * This is an ALLOW-list and that choice cost a bug to learn. The first version
 * used only the deny-list above and treated everything else as equity, on the
 * reasoning that a newly-introduced BSE equity group should not silently become
 * debt. But `InstrumentMapping.series` defaults to the STAMPED STRING "EQ" on
 * every row (22,090 of them), and BSE never issues "EQ" as a group — it is an
 * NSE series. So the deny-list saw "EQ", found it wasn't F or G, and returned a
 * confident EQUITY for 12,661 BSE rows whose real group was simply unknown.
 *
 * A wrong default is more dangerous than a missing value, because it cannot be
 * detected by a null check. Abstaining on an unrecognised group is the honest
 * behaviour: a genuinely new BSE group shows up as UNKNOWN, gets skipped by the
 * repair script, and appears in its abstention report — which is a prompt to
 * look at the exchange circular, not a silent misclassification.
 */
export const BSE_EQUITY_GROUPS = new Set([
  "A",
  "B",
  "X",
  "XT",
  "T",
  "M",
  "MT",
  "MS",
  "Z",
  "E",
  "IF",
  "P",
]);

/** Why a classification was reached — for logging and for the repair script's
 *  dry-run output, so a human can audit the decision rather than trust it. */
export interface ClassificationResult {
  klass: CashInstrumentClass;
  /** Short machine-readable reason, e.g. "bse-group-F", "nse-series-N0". */
  reason: string;
}

export interface ClassifyInput {
  symbol: string;
  name: string;
  /** "NSE" | "BSE" (others abstain). */
  exchange: string;
  /** Exchange settlement series/group. Null when never observed. */
  series?: string | null;
  /**
   * ISIN, present only once an exchange's own cash-equity MASTER has matched
   * this row — NSE's EQUITY_L/SME_EQUITY_L or BSE's scrip master. The Kite dump
   * has no ISIN column at all (`mapCSVRowToRaw` writes `isin: undefined`).
   *
   * Never sufficient on its own, and MONEY-1298 measured why: AUGMONT
   * ENTERPRISES is a real, newly-listed NSE company with no ISIN yet, so
   * "absent ISIN" cannot mean "not an equity". It is used only as a NECESSARY
   * corroborating gate on rules that already have a positive signal.
   *
   * REQUIRED, and `null` is a real answer meaning "I looked and there is
   * none". It was optional, with a note promising that omitting it "keeps the
   * pre-MONEY-1298 behaviour ... a caller that passes neither still lands in
   * the same abstention". True of this field — every rule reading it is also
   * gated on the stamped default — and NOT true of `segmentCode` beside it,
   * which is exactly why neither is optional any more: one reassurance covered
   * two fields and was only half right.
   *
   * An optional field makes a FABRICATED ABSENCE type-check. `row.isin` sitting
   * unforwarded 15 lines from the call (bhavcopy-sync-logic) compiles clean and
   * silently weakens every rule that would have used it.
   */
  isin: string | null;
  /**
   * Broker/exchange segment. {@link INDEX_SEGMENT_CODE} marks an index.
   *
   * REQUIRED, and this is the field that forced the change. The INDEX rule is
   * deliberately NOT gated on the stamped default — a segment of `INDICES` is
   * the exchange naming an index outright, which is positive sourced evidence
   * rather than an inference from absence. So omitting this column does not
   * fall back to an abstention, it CHANGES THE VERDICT:
   *
   *   {symbol:"NIFTY 50", exchange:"NSE", series:"EQ", isin:null}
   *     omitted -> EQUITY / nse-series-EQ
   *     passed  -> INDEX  / segment-indices
   *
   * and EQUITY is in `SECTOR_BEARING`, so a caller that merely forgot the
   * column marks an index row writable for a sector.
   * `scripts/data/resector-noncanonical.ts` selected `isin` and not this, and
   * did exactly that.
   */
  segmentCode: string | null;
}

/**
 * Recover an NSE settlement series from the trading symbol — MONEY-1298.
 *
 * NSE's own convention, and Kite reproduces it verbatim: a cash instrument
 * outside the main board is listed as `<BASE>-<SERIES>`. `extractBaseSymbol`
 * returns the trading symbol UNCHANGED for NSE and BSE, so the suffix survives
 * into `InstrumentMapping.symbol`. It is therefore not a symbol PATTERN in the
 * sense this file's header rejects — it is the exchange's own two-character
 * series code, sitting in a different column than we expected to read it from:
 *
 *   664UP30-SG    SDL UP 6.64% 2030            series SG — state development loan
 *   667GS2050-GS  GOI LOAN 6.67% 2050          series GS — G-Sec
 *   364D280826-TB GOI TBILL 364D-28/08/26      series TB — treasury bill
 *   965SCL25C-N0  (no name; a bond code)       series N0 — NCD family N
 *   OMFURN-SM     OMFURN INDIA                 series SM — SME EQUITY
 *   EMBASSY-RR    EMBASSY OFFICE PARKS REIT    series RR — REIT
 *
 * Recovering it and feeding it to the SAME series tables means a new NSE debt
 * series added to `bhavcopy.ts` is covered here automatically, and — critically
 * — that the equity series come back EQUITY. The 876 `-SM`/`-BE`/`-ST`/`-BZ`/
 * `-IT`/`-SZ`/`-E1` rows are real securities and this returns EQUITY for every
 * one of them, so nothing retypes them.
 *
 * Two guards, both load-bearing:
 *
 *   - Only when the stored series is the STAMPED DEFAULT. A row that already
 *     carries a real series has been sourced from the exchange and that value
 *     wins; an EMPTY series stays "no evidence" and keeps abstaining.
 *   - Only when there is NO ISIN. An ISIN means an exchange master matched this
 *     row under this symbol, which makes the suffix a coincidence rather than a
 *     series. Measured: the only three ISIN-bearing NSE rows with a dash suffix
 *     are KLBRENG-B, MCCHRLS-B (`-B`, one char, never matched) and UMIYA-MRO
 *     (`-MRO`, three chars, never matched) — real companies whose ticker simply
 *     contains a dash. The gate means a FOURTH one, whose suffix did collide
 *     with a debt series, still could not be retyped.
 *
 * Exactly two characters, so a single letter or a longer token can never fall
 * in by accident — the same shape guard the price feed uses.
 */
export function recoverNseSeriesFromSymbol(input: {
  symbol: string;
  exchange: string;
  series?: string | null;
  isin?: string | null;
}): string | null {
  if (
    String(input.exchange ?? "")
      .trim()
      .toUpperCase() !== "NSE"
  )
    return null;
  const stored = String(input.series ?? "")
    .trim()
    .toUpperCase();
  if (stored !== STAMPED_DEFAULT_SERIES) return null;
  if (String(input.isin ?? "").trim() !== "") return null;
  const m = /-([A-Z0-9]{2})$/.exec(
    String(input.symbol ?? "")
      .trim()
      .toUpperCase(),
  );
  return m ? m[1]! : null;
}

/**
 * Classify one cash-segment instrument.
 *
 * Order matters. ETFs and trusts are checked FIRST because they are
 * name-identifiable regardless of series, and because a REIT sitting in an
 * equity series would otherwise be typed EQUITY and compared against
 * operating companies on P/E — the MONEY-1085 lesson.
 */
export function classifyCashInstrument(
  input: ClassifyInput,
): ClassificationResult {
  const symbol = String(input.symbol ?? "").trim();
  const name = String(input.name ?? "").trim();
  const exchange = String(input.exchange ?? "")
    .trim()
    .toUpperCase();
  const storedSeries = String(input.series ?? "")
    .trim()
    .toUpperCase();
  const isin = String(input.isin ?? "").trim();
  const segmentCode = String(input.segmentCode ?? "")
    .trim()
    .toUpperCase();

  // ── The exchange's own segment outranks every heuristic below ──
  //
  // FIRST, ahead of the ETF name matcher, because that matcher reads the NAME
  // and index names collide with fund names by construction: the fund is named
  // after the index it tracks. `isETF` fires on " ETF" anywhere in the name, so
  // an index row named "… ETF INDEX" would come back ETF. The segment is the
  // feed stating the type outright, and it separates the 213 index rows from
  // the three real Nifty-50 ETFs cleanly — see INDEX_SEGMENT_CODE.
  if (segmentCode === INDEX_SEGMENT_CODE) {
    return { klass: "INDEX", reason: "segment-indices" };
  }

  // The NSE series, recovered from the trading symbol when — and only when —
  // the stored column is the broker dump's stamped default and no exchange
  // master has claimed the row. See `recoverNseSeriesFromSymbol`.
  //
  // Computed HERE, before anything reads `series`, so every branch below
  // (the trust map, `seriesSaysDebt`, the NSE branch itself) sees one
  // consistent answer. An earlier draft recovered it inside the NSE branch
  // only, which left `seriesSaysDebt` false for a `-N2` row and re-opened
  // exactly the name-beats-series inversion the comment below warns about.
  const recovered = recoverNseSeriesFromSymbol({
    symbol,
    exchange,
    series: storedSeries,
    isin,
  });
  const series = recovered ?? storedSeries;
  // Reason tag, so a verdict reached from the SYMBOL is never mistaken for one
  // reached from a sourced `series` column when someone audits the dry run.
  const nseTag = recovered ? "nse-symbol-series" : "nse-series";

  // ── Name-identifiable types first ──
  if (symbol && name && isETF(symbol, name)) {
    return { klass: "ETF", reason: "name-etf" };
  }

  // NSE encodes trusts in the series (RR/IV) — a stronger signal than the
  // name when we have it. Guarded on the EXCHANGE: this ran before the
  // NSE/BSE branch, so a BSE row whose group letter happened to be "RR" or
  // "IV" would be typed REIT/INVIT with reason "nse-series-RR". Not reachable
  // in today's data, but BSE_GROUP_SHAPE admits any 1-2 uppercase letters and
  // the live master already carries groups the allow-list does not know
  // (TS, ZP, IP, Y, R, SE), so it is latent rather than impossible.
  const seriesTrust = exchange === "NSE" ? NSE_TRUST_SERIES[series] : undefined;
  if (seriesTrust) {
    return { klass: seriesTrust, reason: `${nseTag}-${series}` };
  }

  // The NAME matcher runs only when the series does NOT already say "debt".
  //
  // It used to run before every series check, so an NSE row on a debt series
  // (e.g. N2, family N = corporate bonds/NCDs) named "…Infrastructure Trust
  // NCD" returned INVIT on the strength of the word "Trust" and never reached
  // the DEBT branch — a name heuristic outranking the exchange's own explicit
  // statement. That is the inversion this file's header argues against: "the
  // pattern correlates with the truth without being it".
  const seriesSaysDebt =
    exchange === "NSE"
      ? NSE_SERIES_INTENTIONALLY_UNPRICED[series] !== undefined ||
        (series.length === 2 &&
          NSE_SERIES_FAMILIES_UNPRICED[series[0]!] !== undefined)
      : exchange === "BSE" && BSE_DEBT_GROUPS.has(series);

  const nameTrust = seriesSaysDebt
    ? null
    : classifyTrustInstrument(symbol, name);
  if (nameTrust) {
    return { klass: nameTrust, reason: "name-trust" };
  }

  // ── BSE: the group letter decides ──
  if (exchange === "BSE") {
    if (!series) return { klass: "UNKNOWN", reason: "bse-no-group" };
    if (BSE_DEBT_GROUPS.has(series)) {
      return { klass: "DEBT", reason: `bse-group-${series}` };
    }
    if (BSE_EQUITY_GROUPS.has(series)) {
      return { klass: "EQUITY", reason: `bse-group-${series}` };
    }
    // ── BSE rows the scrip master has NEVER sourced — MONEY-1298 ──
    //
    // The stamped default "EQ" means "never sourced from the exchange". That
    // is still not, by itself, a statement about the instrument, and the
    // abstention below remains the default. But when it is joined by TWO more
    // absences it becomes one:
    //
    //   1. no ISIN — BSE's scrip master covers the whole ~12,600-row active
    //      universe in ONE run and supplies group + ISIN together, so a row it
    //      has never matched is not in the BSE cash-equity universe; and
    //   2. Kite supplied no NAME for it — `name` is the instrument code
    //      repeated. A listed company always has a company name in the dump.
    //
    // (2) is the positive signal and it is what makes this safe. Measured on
    // prod 2026-08-30 across the 5,392 rows satisfying (1) and the stamped
    // default:
    //
    //   name === symbol   5,288  ->  DEBT   (bond / CP / SDL / debenture codes:
    //                                        778JCL29, DCBL080726, IOCL10726,
    //                                        1048NHF27, 91SKFL28 …)
    //   real company name   104  ->  ABSTAIN
    //
    // and the 104 are exactly the rows a blanket "EQ + no ISIN -> DEBT" rule
    // would have destroyed: TEMPSENS INSTRUMENTS, NOVYRA PHARMACHEM, AUGMONT
    // ENTERPRISES, COROMANDEL AGRO, BENARA BEARINGS, KUSAM ELECTRICAL, BROACH
    // LIFECARE, GLOBAL DEFENCE INDUSTRIES — ~45 real companies — plus ~45
    // exchange-listed MF plans and two rights entitlements. A false DEBT
    // verdict removes a company from the screener and CLEARS its sector
    // irreversibly, so they abstain.
    //
    // `name === symbol` ALONE IS NOT ENOUGH, and the reason is one layer up.
    // `mapCSVRowToRaw` writes `name: row.name || baseSymbol`
    // (zerodha-instruments-logic.ts), so a row where Kite supplied NO name gets
    // the symbol copied into it. By the time a row reaches this function,
    // "Kite repeated the instrument code" and "Kite supplied nothing" are the
    // same two strings, and only the first is evidence of a bond. The classifier
    // does have a safe answer for a nameless row — it abstains — but the `||`
    // makes that branch unreachable from the pipeline.
    //
    // That is the same defect as the abstention FIXTURE this ticket already
    // fixed (a `typedRow` helper defaulting `name = symbol` supplied the very
    // signal the case asserted was absent), sitting in the production parser
    // rather than the test. `InstrumentMapping.name` is a required `String`, so
    // the parser cannot preserve the absence without a schema change; the
    // discriminator has to survive here instead.
    //
    // So the symbol must ALSO look like an instrument code. Measured on prod
    // 2026-08-31 over the 5,302 rows this rule fires on today, 5,283 carry a
    // digit and 19 do not. Those 19, in full:
    //
    //   10  segment INDICES  SENSEX, BSE PSU BANK, BSE POWER & ENERGY, BSE SME
    //                        IPO, FINANCIAL SERVICES, BSE SERVICES, BSE INTERNET
    //                        ECONOMY, BSE SENSEX SIXTY, BSE CAPITAL MKTS &
    //                        INSURANCE, BSE SELECT BUSINESS GROUPS
    //    4  MF plans         NIMFHKAD, NIMFHKAG, NIMFHKDP, NIMFHKGP
    //    4  hybrids          VALIANTOCPS, CHOLACCD, SMILCCD, TCAPPERP
    //    1  A REAL COMPANY   PILANI INVE
    //
    // which retires this comment's previous claim that "ZERO real companies
    // remain". One does, in production, today — so the hazard was never merely
    // latent, and every company MONEY-1298 set out to protect (TEMPSENS,
    // NOVYRA PHARMACHEM, BENARA BEARINGS, GLOBAL DEFENCE INDUSTRIES, AUGMONT)
    // is likewise purely alphabetic and would land here the moment Kite shipped
    // it without a name.
    //
    // The 10 INDICES rows are the other half of the correction. The old comment
    // said SENSEX "is NOT caught here: its segment is INDICES, so the rule above
    // claims it first" — true only when a caller PASSES `segmentCode`, and
    // neither live caller does (`bhavcopy-sync-logic`, `bse-master-logic`).
    // Reached without it they were typed DEBT.
    //
    // The 4 hybrids keep their DEBT verdict through HYBRID_DEBT_SUFFIXES rather
    // than being written off. A digit-only test would have abstained on them,
    // and they are genuinely debt — dropping a correct verdict to fix an
    // unrelated hazard is a trade worth avoiding when the alternative is three
    // standard, stable instrument suffixes rather than a table of names. None of
    // the companies above ends in one, so it cannot re-open the hazard.
    //
    // Still deliberately NOT a bond-shaped regex. `^\d+[A-Z]+\d{2}` was
    // measured in MONEY-1093 and hit 2,236 wrong rows. "Contains a digit" is a
    // far weaker test that keeps 99.6% of the population, and the
    // 3M/5PAISA/63MOONS class it could otherwise catch is held out by the
    // no-ISIN gate — those are listed companies and they carry one.
    if (
      series === STAMPED_DEFAULT_SERIES &&
      isin === "" &&
      symbol !== "" &&
      looksLikeInstrumentCode(symbol) &&
      name.toUpperCase() === symbol.toUpperCase()
    ) {
      return { klass: "DEBT", reason: "bse-unenriched-code" };
    }

    // Not a BSE group we recognise. The overwhelmingly common case is the
    // stamped default "EQ" (an NSE series that BSE never issues), which means
    // "never sourced from the exchange" rather than anything about the
    // instrument. Abstain — see BSE_EQUITY_GROUPS.
    return { klass: "UNKNOWN", reason: `bse-group-unrecognised-${series}` };
  }

  // ── NSE: the two-character series decides ──
  if (exchange === "NSE") {
    if (!series) return { klass: "UNKNOWN", reason: "nse-no-series" };

    // An explicit CLASS map, not the pricing list.
    //
    // This used to be `NSE_SERIES_INTENTIONALLY_UNPRICED[series] !== undefined
    // -> DEBT`, borrowing a list that exists for a different question ("should
    // the price feed skip this row?"). Three of its eight members are not debt
    // at all: `MF` is mutual-fund units, `E1` is PARTLY-PAID SHARES and `SZ` is
    // suspended SME equity with no continuous price series. So the classifier
    // would have typed equities DEBT — and `buildTypeWriteData` clears
    // sector/industry on a DEBT retype, from an unattended job with no rollback
    // file. Unreachable today only because `keepSeries` drops these rows before
    // the worker sees them, but the named follow-up is to let the metadata path
    // see exactly them.
    const explicit = NSE_SERIES_CLASS[series];
    if (explicit) {
      return { klass: explicit, reason: `${nseTag}-${series}` };
    }
    // Whole debt families, matched on the first character. Two-char codes
    // only, so a single letter or a longer string can never fall in by
    // accident — same guard the price feed uses.
    if (
      series.length === 2 &&
      NSE_SERIES_FAMILIES_UNPRICED[series[0]!] !== undefined
    ) {
      return { klass: "DEBT", reason: `${nseTag}-family-${series[0]}` };
    }
    if (NSE_CASH_SERIES.has(series)) {
      return { klass: "EQUITY", reason: `${nseTag}-${series}` };
    }
    // A series we have never classified. Abstain loudly rather than guess —
    // this is the case that should trigger a look at the exchange circular.
    return { klass: "UNKNOWN", reason: `${nseTag}-unrecognised-${series}` };
  }

  return { klass: "UNKNOWN", reason: `unsupported-exchange-${exchange}` };
}

/**
 * True when a class should live in `InstrumentMapping.instrumentType` as
 * something other than EQUITY.
 *
 * UNKNOWN is deliberately excluded: an instrument we cannot classify must be
 * left exactly as it is. Retyping on a guess is how 2,200 bonds acquired a
 * sector in the first place.
 *
 * NOTE: no production caller today. `reclassify-instruments.ts` deliberately
 * uses its own narrower `RETYPE_CLASSES` (DEBT + INDEX) because REIT/INVIT
 * would drop a held trust's news and filings coverage, and the bhavcopy
 * backfill uses `BACKFILL_TYPES` (DEBT + ETF). Kept as the canonical statement
 * of "which classes are not equity", but do not read its existence as evidence
 * that anything branches on it.
 */
export function isNonEquityClass(klass: CashInstrumentClass): boolean {
  return (
    klass === "DEBT" ||
    klass === "REIT" ||
    klass === "INVIT" ||
    klass === "INDEX"
  );
}
