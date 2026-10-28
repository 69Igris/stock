/**
 * NSE corporate-results XBRL → canonical financials — MONEY-1113 (XBRL F1),
 * extended to the SEBI integrated-filing taxonomy by MONEY-1200.
 *
 * Pure. No I/O, no DB, no clock. Give it the bytes of one filing, get back one
 * period's numbers or a reason it is not that.
 *
 * ## What these documents actually are
 *
 * NSE publishes results as XBRL instances at
 * `nsearchives.nseindia.com/corporate/xbrl/…`. There are TWO taxonomies, split
 * at the same regime change that splits the two INDEXES (see
 * `xbrl-filing-index.ts`), and they do not share a namespace:
 *
 *   LEGACY      xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin"
 *   INTEGRATED  xmlns:in-capmkt="http://www.sebi.gov.in/xbrl/2026-01-31/in-capmkt"
 *
 * ### This is the MONEY-1113 seam one layer deeper, and it cost a whole table
 *
 * MONEY-1113 established that there are two indexes and that building against
 * the documented one is a silent no-op. True, and insufficient: the two eras
 * also serve DIFFERENT TAXONOMIES. This module was built and tested exclusively
 * against `in-bse-fin`, so once the integrated index started supplying every
 * current filing, `findTaxonomy` returned null on well-formed documents and the
 * job downloaded 1,500 filings, understood 1,499 of them as nothing, wrote 0
 * rows and reported `ok: true` (measured on prod 2026-08-14). `xbrl_filings`
 * was EMPTY while every log line read as success.
 *
 * Hence the two rules this module now enforces:
 *
 *   1. Dispatch on the DECLARED NAMESPACE, never on a guess. The root element's
 *      `xmlns` set says which taxonomy and which entry point the filer used;
 *      nothing here sniffs tags to decide that.
 *   2. A taxonomy we do not recognise is a DISTINCT, COUNTED outcome
 *      ({@link XbrlDocumentOutcome}), never a zero. "Understood nothing" and
 *      "there was nothing" must never render as the same number again.
 *
 * ### The version is discovered, never assumed
 *
 * Both taxonomies are DATE-VERSIONED and both have shipped more than one
 * version into production: `in-bse-fin` at 2018-03-31 / 2019-09-30 /
 * 2020-03-31, and `in-capmkt` at 2024-12-31 (governance), 2025-01-31 (the
 * Dec-2025 quarter) and 2026-01-31 (the Jun-2026 quarter). The fixtures carry
 * all of them, so nothing here hardcodes one. The concept table is looked up
 * through {@link resolveConceptTable} so a future version that renames a tag is
 * a data change, not a code change.
 *
 * ### Statement FAMILIES
 *
 * A family is "which concepts this filer can possibly have". Four exist:
 *
 *   - `ind-as`     — Ind-AS, the non-financial default.
 *   - `banking`    — RBI Form-A. `NameOfTheCompany` becomes `NameOfBank`,
 *     `RevenueFromOperations` becomes `InterestEarned`, `ProfitLossForPeriod`
 *     becomes `ProfitLossForThePeriod`, and the balance sheet is
 *     Capital/Deposits/Advances, not Equity/Assets.
 *   - `nbfc`       — Ind-AS Division III (integrated only). Its balance sheet
 *     has NO current/non-current split, and it reports `Borrowings` and
 *     `Investments` the way a bank does.
 *   - `non-ind-as` — Indian GAAP, "other than bank" (integrated only).
 *     `DepreciationAndAmortisationExpense`, `ProfitLossForThePeriod`,
 *     `ShareholdersFunds`/`ShareCapital`/`ReservesAndSurplus`.
 *
 * **`nbfc` exists as its own family because of one measured trap.** An NBFC
 * filing carries `InterestEarned` AND `RevenueFromOperations` in the same
 * context — NAGA DHUNSERI Q1-FY27 reports `InterestEarned` ₹3.93 lakh beside
 * `RevenueFromOperations` ₹94.48 Cr. The old tag-sniffing family detector
 * (`InterestEarned` exists ⇒ banking) therefore classified every NBFC as a
 * bank, which reported fourteen RBI concepts it can never have as MISSING and
 * suppressed its EBITDA. The entry-point namespace says `IntegratedFinance_NBFC`
 * outright, so the guess was never necessary.
 *
 * The `governance` entry point is NOT a family: those filings legitimately
 * carry no financials at all (board composition, committee meetings, investor
 * complaints — 29 of 500 records in a live window). They resolve to
 * `kind: "non-financial"`, which is what keeps them out of the failure
 * numerator instead of inflating "unparseable" on a perfectly healthy run.
 *
 * ## The context problem — the highest-risk part of this module
 *
 * XBRL scopes every fact to a `contextRef`. The naive read is "find the first
 * `RevenueFromOperations`" and the naive fix is "check the context's period".
 * BOTH are wrong on real NSE filings, for two independent reasons:
 *
 * 1. **The `<xbrli:context>` periods LIE.** In every fixture the quarter context
 *    (`OneD`) and the year-to-date context (`FourD`) declare the *same*
 *    `<xbrli:startDate>`/`<xbrli:endDate>`. GLAXO Q2-FY25: both contexts say
 *    2024-07-01..2024-09-30, but `FourD` holds the H1 figures — revenue
 *    ₹1,811.05 Cr against the quarter's ₹1,000.05 Cr. Trusting `<xbrli:period>`
 *    and taking either context would be an 81% overstatement reported as a
 *    quarter, with nothing anywhere to contradict it.
 *
 *    The truth is carried as FACTS inside each context:
 *    `DateOfStartOfReportingPeriod` / `DateOfEndOfReportingPeriod`. Those are
 *    per-context, present in all three fixtures across all three taxonomy
 *    versions, and they are the ONLY thing that separates the quarter from the
 *    YTD column. So they are the primary source of truth here, and
 *    `<xbrli:period>` is demoted to a fallback.
 *
 * 2. **The context may not be declared at all.** BHARTIARTL Q2-FY20
 *    (`…_WEB.xml`) references `contextRef="OneD"` and `contextRef="FourD"` from
 *    106 facts and never declares either context. It is invalid XBRL. A
 *    conforming parser drops the entire primary income statement for that
 *    filing and reports nothing — silently, since the segment contexts it CAN
 *    resolve still parse.
 *
 *    So the unit of grouping here is the contextRef STRING, not a resolved
 *    context object. A context declaration, when present, only adds dimensions
 *    and a fallback period; its absence costs coverage, never correctness.
 *
 * ### The resolution rule
 *
 * Candidate = a contextRef group that (a) is not dimensioned — a declared
 * context carrying `<xbrldi:explicitMember>` is a segment or expense breakdown,
 * never the headline column — and (b) declares its own reporting period through
 * the two facts above, falling back to `<xbrli:period>`.
 *
 * Condition (b) is doing real work beyond supplying dates: the breakdown
 * contexts hold two facts each (a member label and a value) and NEVER carry a
 * reporting-period fact. So an *undeclared* dimensioned context — which we
 * cannot detect structurally — still fails the filter. That is what makes
 * treating "undeclared" as "undimensioned" safe.
 *
 * Primary = the SHORTEST candidate among those sharing the LATEST end date.
 * Same end date + shorter span is exactly "the most granular current period":
 * the quarter, not the year-to-date. Prior-period comparatives end earlier and
 * are filtered by the latest-end-date step, so a comparative can only ever be
 * chosen if the filing contains nothing else — and then its dates say so.
 *
 * Every other resolved period is returned in {@link XbrlFinancials.otherPeriods}
 * so the choice is auditable.
 *
 * **`otherPeriods` carries DATES ONLY — never values.** An earlier reading of
 * this paragraph took it for "the YTD column is already in hand", and it is
 * not: `values` is extracted for the chosen contextRef alone, so a March-quarter
 * filing's full-year figures are resolved, ranked, and then dropped. Reaching
 * them means re-reading the document with
 * {@link XbrlParseOptions.periodContextRef} — which is why that option exists,
 * and why a projection over already-stored `XbrlFiling.facts` blobs cannot
 * produce an annual row no matter how it is written (MONEY-1114).
 *
 * ### Balance sheet
 *
 * Instant contexts get no reporting-period facts, and NSE reuses the same
 * instant on the comparative (ICICI's `OneI` and `FourI` are both @2024-09-30),
 * so the date cannot disambiguate them either. The only remaining signal is the
 * filer's column convention — `OneD` ↔ `OneI`, `FourD` ↔ `FourI` — so the
 * instant is matched by stripping the `D`/`I` suffix off the chosen duration
 * contextRef. That is weaker evidence than the duration side and it is recorded
 * as such on {@link XbrlFinancials.balanceSheetSource}.
 *
 * ## Scale
 *
 * `LevelOfRoundingUsedInFinancialStatements` says Lakhs / Crores / Millions and
 * is a PRESENTATION label for the original statement — the XBRL values are
 * already absolute rupees. Verified against three published figures: GSK Pharma
 * Q2-FY25 revenue ₹1,000.05 Cr (label "Lakhs"), ICICI Bank Q2-FY25 interest
 * earned ₹40,537.38 Cr (label "Crores"), Bharti Airtel Q2-FY20 consolidated
 * revenue ₹21,131.3 Cr (label "Millions"). Nothing here rescales; the label is
 * passed through so a caller can spot a filer that breaks the convention.
 *
 * ### …and that is exactly why the WRITER has to rescale — MONEY-1205
 *
 * "Already absolute rupees" is correct about the filing and was silently wrong
 * about the destination. `StockFinancials` is denominated in **₹ CRORE**: every
 * one of its 32,359 prod rows came from Tickertape, whose feed is in crore and
 * is stored unconverted (HDFCBANK FY2025 revenue 470,915.93 = ₹4.71 lakh crore).
 * So this module and the projection writer were pointing rupee-scale values at
 * a crore-scale column — a 10,000,000x overstatement, in the one table with no
 * `source` in its unique key, therefore unrecoverable once written.
 *
 * The conversion belongs at the WRITER boundary, not here: this module's
 * contract is to report what the filing said, and rescaling inside it would
 * make `XbrlFiling.facts` disagree with the document it was parsed from.
 * {@link RUPEES_PER_CRORE} / {@link rupeesToCrores} are declared here — beside
 * the paragraph that establishes the source unit — and applied by
 * `workers/src/processors/xbrl-projection-writer.ts` immediately after
 * `projectFinancials`, before `planFinancialsWrite` ever sees a value.
 *
 * This does NOT defeat the reconcile gate. `reconcile()` classifies a 1e7 gap
 * as `SCALE_MISMATCH` (1e7 is in `KNOWN_SCALES`), which BLOCKS the switchover —
 * correctly, while the units disagree. Converting makes the two figures
 * genuinely comparable, so the gate starts judging the numbers instead of the
 * units. Defeating it would have meant widening the tolerance or dropping 1e7
 * from `KNOWN_SCALES`; neither happened.
 *
 * ## Failure vs. empty
 *
 * `null` means "this is not a filing I can attribute numbers to" — not XML, not
 * this taxonomy, or no resolvable reporting period. It never means "found
 * nothing". A recognised filing with no mapped concepts returns a real object
 * with `coverage.level === "none"`, because that is a different fact about the
 * world and the caller must be able to tell them apart.
 *
 * Absence is likewise explicit: a concept that is missing is missing from
 * `values` AND listed in `coverage.missing`. `0` is a legitimate reported value
 * — these filings are full of genuine `0.00` — so it is never conflated with
 * absent.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which of the two taxonomies the document declares.
 *
 * NOT an era guess from a date — the namespace itself. A 2018 filing re-served
 * today is still `in-bse-fin`, and the whole point of MONEY-1200 is that the
 * document, not the calendar, decides how to read it.
 */
export type XbrlDialect = "in-bse-fin" | "in-capmkt";

/** Which entry point the filer used. Drives which concepts we EXPECT to exist. */
export type XbrlFamily = "ind-as" | "banking" | "nbfc" | "non-ind-as";

/** `NatureOfReportStandaloneConsolidated`. */
export type XbrlBasis = "standalone" | "consolidated";

/**
 * Canonical concepts. Deliberately a closed union: the point of the mapping is
 * that a bank's `InterestEarned` and a manufacturer's `RevenueFromOperations`
 * land on the SAME key, so downstream code never branches on filer type.
 */
export type XbrlConcept =
  // --- income statement (both families) ---
  | "revenueFromOperations"
  | "otherIncome"
  | "totalIncome"
  | "totalExpenses"
  | "financeCosts"
  | "costOfMaterialsConsumed"
  | "purchasesOfStockInTrade"
  | "changesInInventories"
  | "employeeBenefitExpense"
  | "depreciationAndAmortisation"
  | "exceptionalItems"
  | "profitBeforeTax"
  | "taxExpense"
  | "profitFromContinuingOperations"
  | "profitFromDiscontinuedOperationsBeforeTax"
  | "profitFromDiscontinuedOperationsAfterTax"
  | "profitForPeriod"
  | "profitAttributableToOwners"
  | "profitAttributableToNonControllingInterests"
  | "shareOfProfitOfAssociates"
  | "otherComprehensiveIncome"
  | "comprehensiveIncome"
  // --- per share ---
  | "basicEps"
  | "dilutedEps"
  | "basicEpsContinuing"
  | "dilutedEpsContinuing"
  | "faceValuePerShare"
  | "paidUpEquityShareCapital"
  // --- banking-only income statement ---
  | "operatingProfitBeforeProvisions"
  | "provisionsOtherThanTax"
  | "grossNpa"
  | "netNpa"
  | "grossNpaRatio"
  | "netNpaRatio"
  | "cet1Ratio"
  | "returnOnAssets"
  // --- balance sheet, Ind-AS shape ---
  | "totalAssets"
  | "totalEquity"
  | "equityShareCapital"
  | "otherEquity"
  | "totalLiabilities"
  | "currentAssets"
  | "nonCurrentAssets"
  | "currentLiabilities"
  | "nonCurrentLiabilities"
  | "inventories"
  | "tradeReceivables"
  | "cashAndCashEquivalents"
  | "bankBalanceOther"
  | "currentInvestments"
  | "borrowingsCurrent"
  | "borrowingsNonCurrent"
  | "propertyPlantAndEquipment"
  // --- balance sheet, RBI Form-A shape ---
  | "bankCapital"
  | "bankReservesAndSurplus"
  | "deposits"
  | "borrowings"
  | "debtSecurities"
  | "subordinatedLiabilities"
  | "advances"
  | "investments";

/** Which statement a concept belongs to — drives coverage reporting. */
export type XbrlConceptGroup = "income" | "perShare" | "balanceSheet";

/**
 * How much of the canonical model this filing actually supports.
 *
 * `level` is a ladder, not a percentage, because the decisions downstream are
 * discrete: can I show a revenue/profit headline at all (`headline`), can I
 * build a P&L (`income`), can I compute balance-sheet ratios (`full`).
 *
 * `none` means "below the headline bar", NOT "found nothing" — `present` still
 * enumerates everything that was extracted. A filing can legitimately land on
 * `none` with real values in hand.
 */
export type XbrlCoverageLevel = "none" | "headline" | "income" | "full";

export interface XbrlCoverage {
  level: XbrlCoverageLevel;
  /** Concepts found, sorted. */
  present: XbrlConcept[];
  /**
   * Expected-for-this-family concepts that were NOT found, sorted. Absence is
   * visible here rather than being inferable only from a gap in `values`.
   */
  missing: XbrlConcept[];
  /** Per-statement found/expected counts, for coarse quality metrics. */
  byGroup: Record<XbrlConceptGroup, { present: number; expected: number }>;
}

export interface XbrlPeriod {
  /** ISO `YYYY-MM-DD`. */
  start: string;
  /** ISO `YYYY-MM-DD`. */
  end: string;
  /** Inclusive-of-start, exclusive-of-end day count. Used to rank candidates. */
  days: number;
  contextRef: string;
  /**
   * `reported-facts` — from `DateOfStartOfReportingPeriod`, trustworthy.
   * `context-period` — from `<xbrli:period>`, which the quarter and the YTD
   * column routinely share; a filing resolved this way cannot distinguish them
   * and fell back to document order.
   */
  source: "reported-facts" | "context-period";
}

/**
 * The taxonomy this document declares, as declared.
 *
 * Every field is READ OFF the instance. None is inferred from the filename, the
 * index record or the date — those are the three things that were available and
 * wrong when the parser silently stopped understanding current filings.
 */
export interface XbrlTaxonomy {
  /** Full namespace URI as declared. */
  namespace: string;
  /** Which taxonomy family the namespace belongs to. */
  dialect: XbrlDialect;
  /** The date segment, e.g. `2020-03-31` / `2026-01-31`. Discovered, never assumed. */
  version: string;
  /** Prefix bound to it in this document (`in-bse-fin` / `in-capmkt`). */
  prefix: string;
  /**
   * The integrated taxonomy's ENTRY POINT, verbatim — `IntegratedFinance_IndAS`,
   * `IntegratedFinance_NBFC`, `IntegratedFinance_Banking`,
   * `IntegratedFinance_OtherThanBank`, `IntegratedGovernance`.
   *
   * Read out of the `in-capmkt-ent` namespace, which is the filer's own
   * declaration of what kind of document this is. `null` on `in-bse-fin`, whose
   * entry point is carried in the `<link:schemaRef>` href instead.
   */
  entryPoint: string | null;
}

export interface XbrlFinancials {
  taxonomy: XbrlTaxonomy;
  family: XbrlFamily;
  /**
   * Where {@link XbrlFinancials.family} came from.
   *
   * `entry-point` is a DECLARATION; `schema-ref` and `tag-evidence` are
   * INFERENCES kept only for `in-bse-fin`, which has no entry-point namespace.
   * Recorded because the difference is exactly what the NBFC misclassification
   * turned on, and a stored row must be able to say which one it relied on.
   */
  familySource: "entry-point" | "schema-ref" | "tag-evidence" | "default";
  /** NSE trading symbol. From the context entity identifier or the `Symbol` fact. */
  symbol: string | null;
  /**
   * The BSE scrip code, when the filing identifies the entity by one.
   *
   * Kept SEPARATE from `symbol` rather than merged into it. Integrated filings
   * routinely set `<xbrli:identifier scheme=".../ScripCode">500209</…>` where a
   * legacy filing sets `scheme=".../NSESymbol">INFY`, so a parser that reads the
   * identifier without reading its SCHEME reports "500209" as Infosys's trading
   * symbol — a value that joins to no instrument and looks like data.
   */
  scripCode: string | null;
  /** `null` for taxonomy versions that omit it — the 2018-03-31 files do. */
  companyName: string | null;
  /** `null` when absent; only the banking fixture carries one. */
  isin: string | null;
  basis: XbrlBasis | null;
  /** `WhetherResultsAreAuditedOrUnaudited`; `null` when absent. */
  audited: boolean | null;
  /** `DescriptionOfPresentationCurrency`, e.g. `INR`. */
  currency: string | null;
  /** `LevelOfRoundingUsedInFinancialStatements`. Reported, NOT applied. */
  roundingLabel: string | null;
  /** `ReportingQuarter`, e.g. `Half yearly`. Filer-declared, often loose. */
  reportingQuarterLabel: string | null;
  /** The period the values below belong to. */
  period: XbrlPeriod;
  /** Every other resolved undimensioned period — comparatives, YTD columns. */
  otherPeriods: XbrlPeriod[];
  /** Instant date the balance-sheet values belong to, if any were found. */
  balanceSheetDate: string | null;
  /**
   * `column` — matched via the filer's `OneD`↔`OneI` convention (preferred).
   * `date` — matched only by instant == period end, which cannot separate a
   * comparative sharing that instant. `null` — no balance sheet found.
   */
  balanceSheetSource: "column" | "date" | null;
  /** Only concepts actually found. Finite numbers only. */
  values: Partial<Record<XbrlConcept, number>>;
  /**
   * The XBRL element name that supplied each found concept — MONEY-1250.
   *
   * Same keys as {@link XbrlFinancials.values}. A concept mapped from several
   * tags (`revenueFromOperations` accepts `RevenueFromOperations` OR
   * `InterestEarned`) otherwise loses the company's own choice, and that choice
   * is the FILING'S OWN STATEMENT about what kind of business it is — the
   * evidence MONEY-1239's lender blocker needed and could not reach.
   *
   * OPTIONAL, and that is not defensiveness. ~90,188 filings were stored before
   * this existed, and a row read back from `XbrlFiling.facts` genuinely has no
   * `tags` — declaring it required would make the TYPE assert something the
   * DATA does not, which is the shape that produced MONEY-1050/1205/1234/1236.
   * A reader must therefore treat `undefined` as "not recorded", never as "no
   * tag matched": the first is a stored row predating this change, the second
   * cannot happen (a concept with no matching tag is absent from `values` too).
   */
  tags?: Partial<Record<XbrlConcept, string>>;
  coverage: XbrlCoverage;
}

/**
 * Income lines a source reports DIRECTLY, rather than as the components
 * {@link XbrlFinancials.values} would have to be assembled from — MONEY-1346.
 *
 * ## Why this exists at all
 *
 * `projectFinancials` builds operating income as `revenue - totalExpenses +
 * financeCosts` and EBITDA as `PBT + financeCosts + depreciation`, because an
 * Indian filing publishes NEITHER figure: they are not Ind-AS or RBI concepts,
 * so there is no tag to read and the components are the only route.
 *
 * A DOCUMENT-derived reading is the opposite shape. A model reading an annual
 * report is asked for the operating-profit and EBITDA lines the statement
 * itself presents, and it is NOT asked for `totalExpenses`, `profitBeforeTax`
 * or `depreciationAndAmortisation` — so the components route yields nothing and
 * a figure that WAS read is thrown away. `operatingMargin` and `ebitdaMargin`
 * are then null for the whole no-XBRL cohort, not because the number is
 * unknown but because there is no door for it.
 *
 * ## It is a FALLBACK, never an override
 *
 * Every consumer prefers its own derivation and reaches for this only when that
 * derivation produced `undefined`. An XBRL filing never populates this field —
 * `parseXbrlFinancials` does not emit it — so the branch is unreachable for
 * every existing caller, which is what makes it safe to add to a path that
 * feeds a one-way-door write.
 *
 * ABSOLUTE RUPEES, like {@link XbrlFinancials.values}. A caller holding crores
 * must convert first; mixing the two scales inside one margin is silent.
 */
export interface ReportedIncomeLines {
  /** Operating profit EXCLUDING other income, as the statement presents it. */
  operatingIncomeExOtherIncome?: number;
  /** EBITDA before exceptional items, as the statement presents it. */
  ebitdaBeforeExceptionalItems?: number;
}

/**
 * The slice of a filing the RATIO engines actually read — MONEY-1346.
 *
 * `deriveRatios`, `projectFinancials` and `deriveShareCount` need four things:
 * the facts, which family's conventions to apply, which basis they are on, and
 * which period they describe. They do NOT need a taxonomy, a `schemaRef`, a
 * `contextRef`, an ISIN or a coverage report — all of which `XbrlFinancials`
 * carries because it describes a PARSED XBRL DOCUMENT.
 *
 * Naming that slice is what lets a non-XBRL source (a model's reading of a
 * filed PDF) reach the same derivations without either fabricating a taxonomy
 * it never had or forking the ratio code. `XbrlFinancials` remains assignable
 * to it, so every existing call site is unchanged.
 *
 * `family` is REQUIRED, not optional. Both `projectFinancials` and
 * `deriveRatios` branch on `isLenderFamily(family)` — a lender gets no EBITDA,
 * no ROCE and no interest coverage, because adding interest expended back to a
 * bank's profit produces a number with no meaning. Defaulting it would make
 * that refusal depend on a field the caller forgot to set.
 */
export interface RatioInputs extends Pick<
  XbrlFinancials,
  "values" | "basis" | "family"
> {
  /**
   * The SPAN only — `contextRef` and `source` are XBRL-document provenance and
   * nothing in the ratio engines reads them (`isAdjacentAnnual` reads `end`).
   * A full {@link XbrlPeriod} is assignable here, so an XBRL caller is
   * unchanged; a document-derived source is not made to invent a `contextRef`
   * it never had, which would be a fabricated provenance field sitting in a
   * structure whose whole contract is that provenance is read off the
   * instance.
   */
  period: Pick<XbrlPeriod, "start" | "end" | "days">;
  /** See {@link ReportedIncomeLines}. Absent on every XBRL-parsed filing. */
  reportedIncome?: ReportedIncomeLines;
}

/**
 * What one downloaded document turned out to be.
 *
 * A discriminated union rather than `XbrlFinancials | null`, because the four
 * ways of "not financials" are four different facts about the world and the
 * caller has to be able to count them apart:
 *
 *   - `non-financial` is HEALTHY. Governance filings are ~6% of a normal day
 *     and carry no numbers by design. Counting them as failures makes a healthy
 *     run look broken, which is how a real failure threshold gets ignored.
 *   - `unknown-taxonomy` is the MONEY-1200 failure itself: a well-formed XBRL
 *     instance in a namespace this module has never been taught. It MUST be
 *     loud, and it must carry the namespaces it saw, because the fix is one
 *     table entry and finding it should not require re-downloading anything.
 *   - `unknown-entry-point` is the same failure one level in: a document that
 *     IS `in-capmkt` but declares an entry point we have no concept map for.
 *     Deliberately NOT parsed as `ind-as`: an insurance or REIT entry point
 *     read through the Ind-AS map would produce plausible-looking numbers under
 *     the wrong concepts, which is strictly worse than a counted gap.
 *   - `unmapped-family` is that same gap once someone has LOOKED at it. Same
 *     refusal to parse, opposite epistemic status: `unknown-entry-point` means
 *     "nobody has seen this yet, go and look", `unmapped-family` means "we
 *     looked, here is what it is, and mapping it is its own piece of work".
 *     The distinction is the whole point — see {@link UnmappedStatementShape}.
 *   - `no-period` is a recognised filing we refuse to date. Numbers with no
 *     period are exactly how a prior-year comparative gets stored as this
 *     quarter.
 *
 * `not-xbrl` covers the non-documents: empty input, HTML challenge pages, the
 * 404 body NSE serves for its own stub URL.
 */
export type XbrlDocumentOutcome =
  | { kind: "financials"; financials: XbrlFinancials }
  | {
      kind: "non-financial";
      taxonomy: XbrlTaxonomy;
      /** Why it carries no financials. Today only governance filings do this. */
      reason: "governance";
    }
  | {
      kind: "unknown-taxonomy";
      /**
       * The namespace URIs declared on the root element, so an operator can add
       * the mapping from the log line alone. Bounded — see MAX_REPORTED_NS.
       */
      namespaces: string[];
    }
  | {
      kind: "unknown-entry-point";
      taxonomy: XbrlTaxonomy;
      /** The unrecognised entry point, verbatim. `null` when none was declared. */
      entryPoint: string | null;
    }
  | {
      kind: "unmapped-family";
      taxonomy: XbrlTaxonomy;
      /** The entry point, verbatim — e.g. `IntegratedFinance_GI`. Never null. */
      entryPoint: string;
      /** Which recognised-but-unmapped statement shape this document is. */
      shape: UnmappedStatementShape;
    }
  | { kind: "no-period"; taxonomy: XbrlTaxonomy; family: XbrlFamily }
  | { kind: "not-xbrl" };

/**
 * Statement shapes we RECOGNISE and deliberately do not map.
 *
 * ## Why this type exists at all — MONEY-1220
 *
 * `IntegratedFinance_GI` filings had been landing in `unknown-entry-point`
 * since the integrated era began, which made the nightly prod run print
 * "unknown XBRL taxonomy seen — add it to ENTRY_POINT_KINDS" on 16, 17 and 18
 * August 2026 and every run before them. The instruction in that log line was
 * wrong: the entry point is not a mystery, it is General Insurance, and adding
 * it to `ENTRY_POINT_KINDS` as a family is the one thing that must NOT happen
 * casually.
 *
 * Measured on GICRE Q1-FY27 (the committed fixture, byte-verbatim from the prod
 * feed archive): the document declares 104 distinct `in-capmkt` concepts, and
 * the union of every tag our table maps across all four families meets it in
 * exactly THREE — `Assets`, `Investments`, `OtherIncome`. Not one of the three
 * is on the income ladder, so parsing this through any existing family yields a
 * row with no revenue and no profit. It is not a variant of the
 * Revenue → Expenses → PBT → PAT ladder; it is the IRDAI Revenue Account, whose
 * top line is `PremiumEarned`/`GrossPremiumsWritten`, whose PAT is
 * `ProfitLossAfterTax` (not `ProfitLossForPeriod`), whose PBT is
 * `ProfitOrLossBeforeTax` (not `ProfitBeforeTax`), whose tax is
 * `ProvisionForTax` (not `TaxExpense`), and whose EPS is a single combined
 * `BasicAndDilutedEPS…` rather than the basic/diluted pair. Its revenue lines
 * are also DIMENSIONAL — segmented into Fire / Marine / Health contexts — which
 * the flat per-context scan below does not model.
 *
 * So there are two honest options and only one of them is cheap. Mapping it
 * means a fifth {@link XbrlFamily}, which changes what `expectedIn` means for
 * every row of `CONCEPTS`, feeds the lender/non-lender branch in
 * `xbrl-projection.ts`, and starts writing `StockFinancials` rows for insurers.
 * `StockFinancials` has no `source` in its key, so the first such write
 * destroys the incumbent value and there is nothing left to reconcile against —
 * which makes "enable a new family off one issuer's filing" the wrong move
 * inside a log-cleanup change. It is a ticket, not a table entry.
 *
 * The cheap option is this one: say what the document IS, refuse to parse it,
 * and count it apart. That converts recurring noise into a standing, countable
 * decision without inventing a number.
 *
 * **It is deliberately NOT folded into `non-financial`.** That bucket is
 * documented as HEALTHY — "carries no numbers by design" — and a GI filing
 * carries GICRE's real ₹1,922.04 Cr quarterly PAT. Calling it non-financial
 * would retire the warning by asserting something false, and the gap would stop
 * being visible on the very day someone wants to close it.
 */
export type UnmappedStatementShape = "general-insurance";

/* -------------------------------------------------------------------------- */
/* Concept table                                                              */
/* -------------------------------------------------------------------------- */

interface ConceptSpec {
  group: XbrlConceptGroup;
  /**
   * Candidate local names in priority order. Candidates from several families
   * sit in one list on purpose — the families are tag-disjoint for every
   * concept mapped here, so a single ordered list resolves them without
   * branching, and an unrecognised family still parses whatever it shares.
   *
   * This is the `in-bse-fin` list AND the `in-capmkt` default. The SEBI
   * taxonomy re-uses the ICAI local names almost wholesale — verified element
   * by element against real integrated filings — so listing them again would
   * be fifty identical lines hiding the eight that genuinely differ.
   * `xbrl-integrated-taxonomy.test.ts` mechanically proves every mapped
   * integrated name occurs in a real integrated document, so "identical" is a
   * measurement here, not an assumption.
   */
  tags: readonly string[];
  /**
   * `in-capmkt` overrides, per family. A family absent from this map uses
   * `tags`. Present ONLY where a real integrated filing proved a different
   * local name — the file and the value are cited on each entry.
   */
  capmkt?: Partial<Record<XbrlFamily, readonly string[]>>;
  /**
   * Families that are expected to carry this concept. A concept a family cannot
   * have (a bank has no `Inventories`) must not be reported as missing, or
   * "missing" degrades into noise and stops meaning anything.
   */
  expectedIn: readonly XbrlFamily[];
}

const ALL_FAMILIES: readonly XbrlFamily[] = [
  "ind-as",
  "banking",
  "nbfc",
  "non-ind-as",
];
/**
 * Retained spelling for "every family known when this table was written".
 * Now genuinely every family: the four entry points SEBI publishes.
 */
const BOTH: readonly XbrlFamily[] = ALL_FAMILIES;
/** Ind-AS proper only — excludes the NBFC and Indian-GAAP shapes. */
const INDAS: readonly XbrlFamily[] = ["ind-as"];
/**
 * The three non-bank shapes. They all run a Revenue → Expenses → PBT → PAT
 * ladder with a depreciation line, which a bank does not.
 */
const NON_BANK: readonly XbrlFamily[] = ["ind-as", "nbfc", "non-ind-as"];
/** Ind-AS proper and Division III — the two that report OCI and associates. */
const INDAS_LIKE: readonly XbrlFamily[] = ["ind-as", "nbfc"];
const BANKING: readonly XbrlFamily[] = ["banking"];
/** Lenders: a bank's and an NBFC's balance sheets share these lines. */
const LENDERS: readonly XbrlFamily[] = ["banking", "nbfc"];
/**
 * Expected in NO family — MONEY-1250.
 *
 * `expectedIn` carries a STRONGER claim than "we parse this": a concept listed
 * for a family is counted in `byGroup.expected` and named in `coverage.missing`
 * when absent, and the fixture suites assert `present === expected` exactly. It
 * means "every filing of this family MUST carry this element".
 *
 * An OPTIONAL element cannot say that. `DebtSecurities` is present in 81.1% of
 * the Ind-AS lender filings that produce a totalDebt and `SubordinatedLiabilities`
 * in 77.0% — the absences are measured true zeros (433 of 437 reconcile against
 * the filing's own `FinancialLiabilities` total to within 0.5%), not gaps. Under
 * any non-empty cohort roughly a fifth of NBFC filings would report a phantom
 * missing concept, and every Form-A bank would report two.
 *
 * `[]` still PARSES the element and still lists it in `coverage.present`; it
 * only declines to call its absence a defect. That is the whole difference
 * between reading a value and requiring one.
 */
const OPTIONAL: readonly XbrlFamily[] = [];
/** The two shapes that classify the balance sheet current vs non-current. */
const SPLIT_BALANCE_SHEET: readonly XbrlFamily[] = ["ind-as", "non-ind-as"];
/**
 * Reported when present, never reported missing — concepts whose absence
 * carries no information because it depends on the filing, not the family
 * (a standalone filing has no owners/minority split to disclose).
 */
const CONDITIONAL: readonly XbrlFamily[] = [];

/**
 * concept → tags. This table IS the mapping; there are no per-concept
 * conditionals anywhere below it.
 */
const CONCEPTS: Readonly<Record<XbrlConcept, ConceptSpec>> = {
  // --- income statement ---
  revenueFromOperations: {
    group: "income",
    // A bank's top line is interest earned; `Income` (interest + other) is the
    // total and is mapped separately, so it must not be a candidate here.
    tags: ["RevenueFromOperations", "InterestEarned"],
    expectedIn: BOTH,
  },
  otherIncome: { group: "income", tags: ["OtherIncome"], expectedIn: BOTH },
  totalIncome: { group: "income", tags: ["Income"], expectedIn: BOTH },
  totalExpenses: {
    group: "income",
    tags: ["Expenses", "ExpenditureExcludingProvisionsAndContingencies"],
    expectedIn: BOTH,
  },
  financeCosts: {
    group: "income",
    tags: ["FinanceCosts", "InterestExpended"],
    expectedIn: BOTH,
  },
  // ── Cost of goods: the three lines a gross margin needs ──────────────────
  //
  // Ind-AS has no "cost of goods sold" line. It reports the components
  // separately and expects the reader to add them:
  //
  //     COGS = CostOfMaterialsConsumed
  //          + PurchasesOfStockInTrade
  //          + ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade
  //
  // The third is a DELTA and is SIGNED: inventory that grew is a credit, i.e. a
  // negative expense. It must be ADDED, never abs()'d — abs() inflates COGS in
  // every year a company built stock, which is exactly the year a margin trend
  // is worth reading.
  //
  // Present in 11 of our 18 captured fixtures, so these were always parseable.
  // Nothing mapped them, so `grossMargin` had no inputs and sat in
  // XBRL_UNOWNED_RATIO_COLUMNS looking like a missing SOURCE rather than a
  // missing mapping. MONEY-1220.
  //
  // NON_BANK: a bank has no cost of materials. Lenders therefore get a null
  // gross margin by construction, which is the honest answer — not zero.
  costOfMaterialsConsumed: {
    group: "income",
    tags: ["CostOfMaterialsConsumed"],
    expectedIn: NON_BANK,
  },
  purchasesOfStockInTrade: {
    group: "income",
    tags: ["PurchasesOfStockInTrade"],
    expectedIn: NON_BANK,
  },
  changesInInventories: {
    group: "income",
    tags: [
      "ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade",
      "ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTradeAndOthers",
      "ChangesInInventories",
    ],
    expectedIn: NON_BANK,
  },
  employeeBenefitExpense: {
    group: "income",
    tags: ["EmployeeBenefitExpense", "EmployeesCost"],
    expectedIn: BOTH,
  },
  depreciationAndAmortisation: {
    group: "income",
    tags: ["DepreciationDepletionAndAmortisationExpense"],
    // Indian GAAP drops "Depletion": AIFL Q1-FY27 files
    // `DepreciationAndAmortisationExpense`. The Ind-AS spelling appears nowhere
    // in that document, so without this the concept reads as absent from every
    // non-Ind-AS filer forever.
    capmkt: { "non-ind-as": ["DepreciationAndAmortisationExpense"] },
    // Banks report depreciation inside operating expenses, not as a line.
    expectedIn: NON_BANK,
  },
  exceptionalItems: {
    group: "income",
    tags: ["ExceptionalItemsBeforeTax", "ExceptionalItems"],
    expectedIn: BOTH,
  },
  profitBeforeTax: {
    group: "income",
    tags: ["ProfitBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax"],
    expectedIn: BOTH,
  },
  taxExpense: { group: "income", tags: ["TaxExpense"], expectedIn: BOTH },
  profitFromContinuingOperations: {
    group: "income",
    tags: [
      "ProfitLossForPeriodFromContinuingOperations",
      "ProfitLossFromOrdinaryActivitiesAfterTax",
    ],
    // Indian GAAP inserts a "The": ProfitLossFor*The*PeriodFromContinuing… .
    // AIFL Q1-FY27 = 1,031,000.
    capmkt: {
      "non-ind-as": ["ProfitLossForThePeriodFromContinuingOperations"],
    },
    expectedIn: BOTH,
  },
  profitFromDiscontinuedOperationsBeforeTax: {
    group: "income",
    tags: ["ProfitLossFromDiscontinuedOperationsBeforeTax"],
    // Indian GAAP says "Discontinuing", not "Discontinued".
    capmkt: {
      "non-ind-as": ["ProfitLossFromDiscontinuingOperationsBeforeTax"],
    },
    expectedIn: NON_BANK,
  },
  profitFromDiscontinuedOperationsAfterTax: {
    group: "income",
    // ...and on the after-tax line it is also SINGULAR: "Operation", not
    // "Operations". Not a typo here — that is the local name AIFL files.
    tags: ["ProfitLossFromDiscontinuedOperationsAfterTax"],
    capmkt: {
      "non-ind-as": ["ProfitLossFromDiscontinuingOperationAfterTax"],
    },
    expectedIn: NON_BANK,
  },
  profitForPeriod: {
    group: "income",
    // The banking taxonomy inserts a "The": ProfitLossFor*The*Period.
    tags: ["ProfitLossForPeriod", "ProfitLossForThePeriod"],
    expectedIn: BOTH,
  },
  profitAttributableToOwners: {
    group: "income",
    tags: [
      "ProfitOrLossAttributableToOwnersOfParent",
      "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates",
    ],
    expectedIn: CONDITIONAL,
  },
  profitAttributableToNonControllingInterests: {
    group: "income",
    tags: ["ProfitOrLossAttributableToNonControllingInterests"],
    expectedIn: CONDITIONAL,
  },
  shareOfProfitOfAssociates: {
    group: "income",
    tags: [
      "ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod",
    ],
    expectedIn: INDAS_LIKE,
  },
  // Other comprehensive income is an Ind-AS construct. Indian GAAP has no such
  // statement, so `non-ind-as` is excluded rather than reported missing.
  otherComprehensiveIncome: {
    group: "income",
    tags: ["OtherComprehensiveIncomeNetOfTaxes"],
    expectedIn: INDAS_LIKE,
  },
  comprehensiveIncome: {
    group: "income",
    tags: ["ComprehensiveIncomeForThePeriod"],
    expectedIn: INDAS_LIKE,
  },

  // --- per share ---
  basicEps: {
    group: "perShare",
    tags: [
      "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
      "BasicEarningsPerShareAfterExtraordinaryItems",
    ],
    expectedIn: BOTH,
  },
  dilutedEps: {
    group: "perShare",
    tags: [
      "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
      "DilutedEarningsPerShareAfterExtraordinaryItems",
    ],
    expectedIn: BOTH,
  },
  // The continuing-only EPS pair is absent from the Indian-GAAP entry point:
  // AIFL files only the combined `…FromContinuingAndDiscontinuedOperations`.
  basicEpsContinuing: {
    group: "perShare",
    tags: [
      "BasicEarningsLossPerShareFromContinuingOperations",
      "BasicEarningsPerShareBeforeExtraordinaryItems",
    ],
    expectedIn: INDAS_LIKE.concat(BANKING),
  },
  dilutedEpsContinuing: {
    group: "perShare",
    tags: [
      "DilutedEarningsLossPerShareFromContinuingOperations",
      "DilutedEarningsPerShareBeforeExtraordinaryItems",
    ],
    expectedIn: INDAS_LIKE.concat(BANKING),
  },
  faceValuePerShare: {
    group: "perShare",
    tags: ["FaceValueOfEquityShareCapital"],
    expectedIn: BOTH,
  },
  paidUpEquityShareCapital: {
    group: "perShare",
    tags: ["PaidUpValueOfEquityShareCapital"],
    expectedIn: BOTH,
  },

  // --- banking-only ---
  operatingProfitBeforeProvisions: {
    group: "income",
    tags: ["OperatingProfitBeforeProvisionAndContingencies"],
    expectedIn: BANKING,
  },
  provisionsOtherThanTax: {
    group: "income",
    tags: ["ProvisionsOtherThanTaxAndContingencies"],
    expectedIn: BANKING,
  },
  grossNpa: {
    group: "income",
    tags: ["GrossNonPerformingAssets"],
    expectedIn: BANKING,
  },
  // "NonPerformingAssets" is the NET figure in the RBI schedule; Gross has its
  // own tag above. The naming is the taxonomy's, not ours.
  netNpa: {
    group: "income",
    tags: ["NonPerformingAssets"],
    expectedIn: BANKING,
  },
  grossNpaRatio: {
    group: "income",
    tags: ["PercentageOfGrossNpa"],
    expectedIn: BANKING,
  },
  netNpaRatio: {
    group: "income",
    tags: ["PercentageOfNpa"],
    expectedIn: BANKING,
  },
  cet1Ratio: { group: "income", tags: ["CET1Ratio"], expectedIn: BANKING },
  returnOnAssets: {
    group: "income",
    tags: ["ReturnOnAssets"],
    expectedIn: BANKING,
  },

  // --- balance sheet, Ind-AS ---
  totalAssets: {
    group: "balanceSheet",
    // `Assets` is the total in BOTH shapes — the one balance-sheet tag the
    // families share.
    tags: ["Assets"],
    expectedIn: BOTH,
  },
  // Indian GAAP's equity side is Shareholders' Funds = Share Capital +
  // Reserves & Surplus; there is no `Equity`/`OtherEquity` anywhere in a
  // `non-ind-as` filing. Measured on DYCL's FY26 annual.
  totalEquity: {
    group: "balanceSheet",
    // Banks have no single equity total; it is Capital + ReservesAndSurplus,
    // and summing them here would be derivation, not parsing. Left absent.
    tags: ["Equity"],
    capmkt: { "non-ind-as": ["ShareholdersFunds"] },
    expectedIn: NON_BANK,
  },
  equityShareCapital: {
    group: "balanceSheet",
    tags: ["EquityShareCapital"],
    capmkt: { "non-ind-as": ["ShareCapital"] },
    expectedIn: NON_BANK,
  },
  otherEquity: {
    group: "balanceSheet",
    tags: ["OtherEquity"],
    capmkt: { "non-ind-as": ["ReservesAndSurplus"] },
    expectedIn: NON_BANK,
  },
  totalLiabilities: {
    group: "balanceSheet",
    // Indian GAAP totals the RIGHT-HAND SIDE as `EquityAndLiabilities` and
    // files no bare `Liabilities`, so `non-ind-as` is excluded rather than
    // mapped onto a total that also contains equity.
    tags: ["Liabilities"],
    expectedIn: INDAS_LIKE,
  },
  // The current / non-current split is Schedule III Division I & II. Division
  // III (NBFC) has NO such classification — measured: RELIGARE's FY26 annual
  // files Assets/Equity/Liabilities and none of the four split lines.
  currentAssets: {
    group: "balanceSheet",
    tags: ["CurrentAssets"],
    expectedIn: SPLIT_BALANCE_SHEET,
  },
  nonCurrentAssets: {
    group: "balanceSheet",
    tags: ["NoncurrentAssets"],
    expectedIn: SPLIT_BALANCE_SHEET,
  },
  currentLiabilities: {
    group: "balanceSheet",
    tags: ["CurrentLiabilities"],
    expectedIn: SPLIT_BALANCE_SHEET,
  },
  nonCurrentLiabilities: {
    group: "balanceSheet",
    tags: ["NoncurrentLiabilities"],
    expectedIn: SPLIT_BALANCE_SHEET,
  },
  inventories: {
    group: "balanceSheet",
    tags: ["Inventories"],
    expectedIn: NON_BANK,
  },
  tradeReceivables: {
    group: "balanceSheet",
    // The `Current` suffix belongs to the split shape. Both non-split filers
    // report a plain `TradeReceivables`.
    tags: ["TradeReceivablesCurrent"],
    capmkt: {
      nbfc: ["TradeReceivables"],
      "non-ind-as": ["TradeReceivables"],
    },
    expectedIn: NON_BANK,
  },
  cashAndCashEquivalents: {
    group: "balanceSheet",
    tags: ["CashAndCashEquivalents"],
    expectedIn: NON_BANK,
  },
  /**
   * The two lines that turn our cash into the market's cash — MONEY-1250.
   *
   * `totalCash` mapped `CashAndCashEquivalents` alone and disagreed with the
   * incumbent on 85.8% of 2,437 comparable pairs, 99.4% of it one way, median
   * `ours/theirs` 0.267. The incumbent's column is
   * `CashAndCashEquivalents + BankBalanceOtherThanCashAndCashEquivalents +
   * CurrentInvestments`: 28 of 29 sampled filings fit that exactly (RELIANCE
   * 106,502 -> 225,211, WIPRO 12,197 -> 53,345, TCS 8,342 -> 46,152) and 0 of 29
   * fit cash alone.
   *
   * Both were already IN the filings — same balance sheet, same context — and
   * simply had no concept here. That is what made this a PARSER GAP to close
   * rather than a divergence to declare, which is the whole distinction against
   * `debtToEquity`, where the taxonomy publishes no lease-liability balance
   * element to add.
   *
   * OPTIONAL, like the two NBFC debt concepts: a company with no short-term
   * deposits and no current investments carries neither line, and `expectedIn`
   * asserts that EVERY filing of a family must have the element.
   */
  bankBalanceOther: {
    group: "balanceSheet",
    tags: ["BankBalanceOtherThanCashAndCashEquivalents", "BankBalances"],
    expectedIn: OPTIONAL,
  },
  currentInvestments: {
    group: "balanceSheet",
    tags: ["CurrentInvestments"],
    expectedIn: OPTIONAL,
  },
  borrowingsCurrent: {
    group: "balanceSheet",
    tags: ["BorrowingsCurrent"],
    expectedIn: INDAS,
  },
  borrowingsNonCurrent: {
    group: "balanceSheet",
    tags: ["BorrowingsNoncurrent"],
    expectedIn: INDAS,
  },
  propertyPlantAndEquipment: {
    group: "balanceSheet",
    tags: ["PropertyPlantAndEquipment"],
    expectedIn: NON_BANK,
  },

  // --- balance sheet, RBI Form-A ---
  bankCapital: {
    group: "balanceSheet",
    tags: ["Capital"],
    expectedIn: BANKING,
  },
  bankReservesAndSurplus: {
    group: "balanceSheet",
    tags: ["ReservesAndSurplus"],
    // `ReservesAndSurplus` is ALSO the Indian-GAAP name for other equity, and
    // it is mapped there. Blanking it here keeps one number out of two
    // canonical keys — a `non-ind-as` filer has no RBI reserves line, and
    // `coverage.present` listing both would be a duplicate dressed as breadth.
    capmkt: { "non-ind-as": [] },
    expectedIn: BANKING,
  },
  deposits: { group: "balanceSheet", tags: ["Deposits"], expectedIn: BANKING },
  // An NBFC funds itself with `Borrowings` and holds `Investments` exactly as a
  // bank does — measured on RELIGARE's FY26 annual — so both are expected in
  // LENDERS, not BANKING alone.
  borrowings: {
    group: "balanceSheet",
    tags: ["Borrowings"],
    expectedIn: LENDERS,
  },
  /**
   * Ind-AS lender funding lines the RBI Form-A balance sheet does not have —
   * MONEY-1250.
   *
   * An NBFC filing Division III splits its funding across FOUR elements;
   * `Borrowings` alone is a MEDIAN of 45% of the total. Measured against the
   * incumbent on 135 Ind-AS-shape company-years: `Borrowings` alone agrees
   * within 1% on 21, the four-way sum on 100. Above Rs 10,000 Cr of debt it is
   * 0 of 43 versus 37 of 43.
   *
   * A true Form-A bank has NEITHER element (0 of 76) and needs neither: RBI
   * Schedule 4 `Borrowings` already contains bonds and Tier-2 capital. The
   * derivation therefore branches on FILING SHAPE, not on `family` — `family`
   * is "banking" for 665 NBFC documents because an NBFC tags `InterestEarned`.
   *
   * Coverage on the 439 Ind-AS filings that produce a totalDebt today:
   * `DebtSecurities` 81.1%, `SubordinatedLiabilities` 77.0%. The absences are
   * measured true zeros, not gaps — 433 of 437 filings reconcile the additive
   * children against their own `FinancialLiabilities` total to within 0.5%.
   */
  debtSecurities: {
    group: "balanceSheet",
    tags: ["DebtSecurities"],
    expectedIn: OPTIONAL,
  },
  subordinatedLiabilities: {
    group: "balanceSheet",
    tags: ["SubordinatedLiabilities"],
    expectedIn: OPTIONAL,
  },
  advances: { group: "balanceSheet", tags: ["Advances"], expectedIn: BANKING },
  investments: {
    group: "balanceSheet",
    tags: ["Investments"],
    expectedIn: LENDERS,
  },
};

const ALL_CONCEPTS = Object.keys(CONCEPTS) as XbrlConcept[];

/**
 * Per-version overrides, keyed by the DISCOVERED taxonomy version.
 *
 * Empty today and that is the finding, not an omission: the local names above
 * are byte-identical across 2018-03-31, 2019-09-30 and 2020-03-31 — what varies
 * between filings is the FAMILY, not the version. The seam exists so that a
 * 2027 taxonomy that renames a tag is one entry here instead of a rewrite, and
 * so the version is provably not baked into the lookup path.
 */
const VERSION_OVERRIDES: Readonly<
  Record<string, Partial<Record<XbrlConcept, readonly string[]>>>
> = {};

/**
 * The concept→tags table in force for a given taxonomy version, dialect and
 * family.
 *
 * Exported so the mapping is testable directly, and so a caller can see which
 * tags a (version, dialect, family) resolves to without parsing a document.
 *
 * Precedence, most specific first:
 *   1. `VERSION_OVERRIDES[version]` — a version that renamed a tag.
 *   2. `CONCEPTS[c].capmkt[family]` — an integrated family that spells it
 *      differently. An EMPTY array here is meaningful: "this family does not
 *      have this concept", not "fall through".
 *   3. `CONCEPTS[c].tags` — the shared list.
 *
 * `ctx` is optional so the pre-MONEY-1200 single-argument call still resolves
 * the legacy table, which is what every `in-bse-fin` caller wants.
 */
export function resolveConceptTable(
  version: string,
  ctx?: { dialect?: XbrlDialect; family?: XbrlFamily },
): ReadonlyMap<XbrlConcept, readonly string[]> {
  const overrides = VERSION_OVERRIDES[version];
  const dialect = ctx?.dialect ?? "in-bse-fin";
  const family = ctx?.family;
  const out = new Map<XbrlConcept, readonly string[]>();
  for (const concept of ALL_CONCEPTS) {
    const versioned = overrides?.[concept];
    if (versioned !== undefined) {
      out.set(concept, versioned);
      continue;
    }
    const perFamily =
      dialect === "in-capmkt" && family !== undefined
        ? CONCEPTS[concept].capmkt?.[family]
        : undefined;
    // `?? ` not `|| `: an empty override is a deliberate "not in this family".
    out.set(concept, perFamily ?? CONCEPTS[concept].tags);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Non-financial facts we read for identity / provenance                      */
/* -------------------------------------------------------------------------- */

const TAG_REPORTING_START = "DateOfStartOfReportingPeriod";
const TAG_REPORTING_END = "DateOfEndOfReportingPeriod";
const TAG_BASIS = "NatureOfReportStandaloneConsolidated";
const TAG_AUDITED = "WhetherResultsAreAuditedOrUnaudited";
const TAG_SYMBOL = "Symbol";
const TAG_ISIN = "ISIN";
const TAG_CURRENCY = "DescriptionOfPresentationCurrency";
/**
 * `in-bse-fin` spells it `LevelOfRoundingUsedInFinancialStatements`; every
 * `in-capmkt` entry point shortened it to `LevelOfRounding`. Both are listed
 * because the names are unambiguous and a single ordered list beats a dialect
 * branch for a metadata field.
 */
const ROUNDING_TAGS = [
  "LevelOfRoundingUsedInFinancialStatements",
  "LevelOfRounding",
] as const;
const TAG_REPORTING_QUARTER = "ReportingQuarter";
const TAG_SCRIP_CODE = "ScripCode";
/** Ind-AS calls it `NameOfTheCompany`; the banking entry point `NameOfBank`. */
const NAME_TAGS = ["NameOfTheCompany", "NameOfBank"] as const;

/* -------------------------------------------------------------------------- */
/* XML scanning                                                               */
/* -------------------------------------------------------------------------- */

/**
 * There is no XML parser in `packages/core`'s dependency tree — the root
 * `fast-xml-parser` entry is a `resolutions` pin for a transitive dep, not a
 * declared dependency — and pulling one in for a single call site would be a
 * new supply-chain edge on a money path. These instances are machine-generated
 * from one exchange utility: flat element/text facts, quoted attributes, no
 * CDATA, no mixed content, no namespace redeclaration (checked across all three
 * fixtures). So a targeted scanner covers them, and its blind spots — mixed
 * content, nested facts, prefix rebinding — are shapes that cannot occur here.
 *
 * The scan is linear: one regex finds an opening tag, `indexOf` finds its
 * close. There is no nested quantifier and no backreference, so no backtracking
 * blowup on adversarial input.
 */
interface RawFact {
  local: string;
  contextRef: string;
  text: string;
}

/** Matches `<pfx:Local attr="…">`, tolerating `>` inside quoted attributes. */
function openTagRe(prefix: string): RegExp {
  return new RegExp(
    `<${escapeRe(prefix)}:([A-Za-z0-9_.-]+)((?:[^>"']|"[^"]*"|'[^']*')*)(/?)>`,
    "g",
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${escapeRe(name)}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m?.[1] ?? null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // A malformed numeric reference stays literal rather than becoming U+FFFD
      // — the raw text is more useful than a silent substitution.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Every taxonomy-prefixed fact, in document order. */
function scanFacts(xml: string, prefix: string): RawFact[] {
  const out: RawFact[] = [];
  const open = openTagRe(prefix);
  const close = `</${prefix}:`;
  let m: RegExpExecArray | null;

  while ((m = open.exec(xml)) !== null) {
    const whole = m[0];
    const local = m[1] ?? "";
    const attrs = m[2] ?? "";
    // Self-closing = nil. No value, so not a fact — and crucially not a zero.
    if (m[3] === "/") continue;

    const start = m.index + whole.length;
    const end = xml.indexOf(`${close}${local}>`, start);
    if (end === -1) continue; // truncated mid-fact: drop it, keep the rest.

    const text = xml.slice(start, end);
    // Only leaf facts carry values. A nested element means this is a container
    // (never seen in these instances) and its text is not a value.
    if (text.includes("<")) continue;

    out.push({
      local,
      contextRef: attr(attrs, "contextRef") ?? "",
      text: decodeXmlText(text).trim(),
    });
    open.lastIndex = end;
  }
  return out;
}

interface RawContext {
  id: string;
  startDate: string | null;
  endDate: string | null;
  instant: string | null;
  dimensioned: boolean;
  entityIdentifier: string | null;
  /**
   * The identifier's `scheme` attribute — which registry the value belongs to.
   * Without it the value is an opaque string, and an NSE symbol and a BSE scrip
   * code are indistinguishable.
   */
  entityScheme: string | null;
}

function scanContexts(xml: string, instancePrefix: string): RawContext[] {
  const out: RawContext[] = [];
  const open = openTagRe(instancePrefix);
  const closeTag = `</${instancePrefix}:context>`;
  let m: RegExpExecArray | null;

  while ((m = open.exec(xml)) !== null) {
    const whole = m[0];
    const attrs = m[2] ?? "";
    if (m[1] !== "context" || m[3] === "/") continue;

    const start = m.index + whole.length;
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break; // truncated: nothing after this can be a context.
    const body = xml.slice(start, end);
    open.lastIndex = end;

    const id = attr(attrs, "id");
    if (id === null) continue;

    out.push({
      id,
      startDate: childText(body, instancePrefix, "startDate"),
      endDate: childText(body, instancePrefix, "endDate"),
      instant: childText(body, instancePrefix, "instant"),
      // Any explicit/typed member makes this a breakdown slice, not a column.
      dimensioned: /:(explicitMember|typedMember)\b/.test(body),
      entityIdentifier: childText(body, instancePrefix, "identifier"),
      entityScheme: childAttr(body, instancePrefix, "identifier", "scheme"),
    });
  }
  return out;
}

/** One attribute off a child element's OPEN TAG, e.g. `identifier@scheme`. */
function childAttr(
  body: string,
  prefix: string,
  local: string,
  name: string,
): string | null {
  const re = new RegExp(
    `<${escapeRe(prefix)}:${escapeRe(local)}((?:[^>"']|"[^"]*"|'[^']*')*)>`,
  );
  const attrs = re.exec(body)?.[1];
  return attrs === undefined ? null : attr(attrs, name);
}

function childText(body: string, prefix: string, local: string): string | null {
  const re = new RegExp(
    `<${escapeRe(prefix)}:${escapeRe(local)}(?:\\s[^>]*)?>([^<]*)</${escapeRe(
      prefix,
    )}:${escapeRe(local)}>`,
  );
  const raw = re.exec(body)?.[1];
  return raw === undefined ? null : decodeXmlText(raw).trim();
}

/** `xmlns:pfx="uri"` → prefix bound to `uri`, or `null`. */
function prefixForNamespace(xml: string, uri: string): string | null {
  const re = new RegExp(`xmlns:([A-Za-z0-9_.-]+)\\s*=\\s*"${escapeRe(uri)}"`);
  return re.exec(xml)?.[1] ?? null;
}

const XBRL_INSTANCE_NS = "http://www.xbrl.org/2003/instance";

/** How many namespace URIs an `unknown-taxonomy` outcome carries. */
const MAX_REPORTED_NS = 24;

/**
 * The ROOT ELEMENT's attribute text.
 *
 * Namespace scanning is scoped to the root rather than the whole document on
 * purpose. These filings carry a free-text
 * `DisclosureOfNotesOnFinancialResults…` block containing arbitrary
 * entity-escaped HTML, and a filer is free to paste a namespace URI into it.
 * Every real declaration sits on the root — checked across both taxonomies and
 * all five entry points — so the narrower scan loses nothing and cannot be
 * steered by a filer's prose.
 *
 * Matched by local name `xbrl` under ANY prefix, because the prefix bound to
 * the XBRL instance namespace is the filer's choice.
 */
function rootAttributes(xml: string): string | null {
  const m = /<([A-Za-z0-9_.-]+:)?xbrl(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/.exec(
    xml,
  );
  return m === null ? null : (m[2] ?? "");
}

/** Every `xmlns:pfx="uri"` on the root, as `[prefix, uri]`. */
function namespaceDeclarations(rootAttrs: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /xmlns:([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootAttrs)) !== null) out.push([m[1] ?? "", m[2] ?? ""]);
  return out;
}

/**
 * The two taxonomy namespaces we know how to read.
 *
 * **Both patterns are `$`-ANCHORED, and that is load-bearing in both eras.**
 * `in-bse-fin` documents also declare `…/in-bse-fin-roles`,
 * `…/in-bse-fin-types` and `…/in-bse-fin/in-bse-fin-ent`; `in-capmkt`
 * documents also declare `…/in-capmkt-types` and
 * `…/IntegratedFinance_IndAS/2026-01-31/in-capmkt/in-capmkt-ent` — which
 * CONTAINS `/in-capmkt` as an interior segment. An unanchored match picks
 * whichever is declared first and keys the concept table off a sibling
 * schema's URI, or reads the version out of the wrong one.
 */
const DIALECT_PATTERNS: readonly {
  dialect: XbrlDialect;
  re: RegExp;
}[] = [
  {
    dialect: "in-bse-fin",
    re: /^https?:\/\/[^"]*\/xbrl\/fin\/(\d{4}-\d{2}-\d{2})\/in-bse-fin$/,
  },
  {
    dialect: "in-capmkt",
    re: /^https?:\/\/[^"]*\/xbrl\/(\d{4}-\d{2}-\d{2})\/in-capmkt$/,
  },
];

/**
 * The `in-capmkt-ent` entry-point segment, e.g. `IntegratedFinance_NBFC`.
 *
 * The entity schema's URI is `…/xbrl/{EntryPoint}/{version}/in-capmkt/in-capmkt-ent`
 * — the ONE place the document states what kind of filing it is. Verified
 * present on 20/20 sampled live documents across all five entry points, and on
 * every committed integrated fixture.
 */
const ENTRY_POINT_RE =
  /^https?:\/\/[^"]*\/xbrl\/([A-Za-z0-9_]+)\/\d{4}-\d{2}-\d{2}\/in-capmkt\/in-capmkt-ent$/;

/**
 * Which taxonomy this document declares — dispatch, not detection.
 *
 * Returns `null` only when NO known taxonomy namespace is on the root. The
 * caller turns that into `unknown-taxonomy` WITH the namespaces it saw, so the
 * next unrecognised taxonomy is one table entry away instead of an
 * investigation.
 */
function findTaxonomy(rootAttrs: string): XbrlTaxonomy | null {
  const decls = namespaceDeclarations(rootAttrs);

  let entryPoint: string | null = null;
  for (const [, uri] of decls) {
    const m = ENTRY_POINT_RE.exec(uri);
    if (m !== null) {
      entryPoint = m[1] ?? null;
      break;
    }
  }

  for (const { dialect, re } of DIALECT_PATTERNS) {
    for (const [prefix, uri] of decls) {
      const m = re.exec(uri);
      const version = m?.[1];
      if (version === undefined) continue;
      return {
        namespace: uri,
        dialect,
        version,
        prefix,
        entryPoint: dialect === "in-capmkt" ? entryPoint : null,
      };
    }
  }
  return null;
}

/**
 * Entry point → what the document IS.
 *
 * `governance` is not a family — those filings carry no financial concepts at
 * all — so it is modelled as its own outcome rather than as a family with an
 * empty concept table. Anything not listed here is `unknown`, which is REPORTED
 * rather than read through the Ind-AS map: an entry point we have never seen
 * (insurance, a REIT/InvIT shape) would yield plausible numbers filed under the
 * wrong concepts, and a wrong number is worse than a counted gap.
 *
 * `unmapped` is the THIRD arm, and it is not a softer `governance`: it means we
 * have read a real filing of that shape and decided, on the evidence, that
 * mapping it is its own piece of work. See {@link UnmappedStatementShape} for
 * why General Insurance is one and what it would cost to promote it to a
 * family. An entry point moves out of this arm by acquiring a concept table,
 * never by being quietly re-pointed at `ind-as`.
 */
const ENTRY_POINT_KINDS: Readonly<
  Record<
    string,
    | { family: XbrlFamily }
    | { governance: true }
    | { unmapped: UnmappedStatementShape }
  >
> = {
  IntegratedFinance_IndAS: { family: "ind-as" },
  IntegratedFinance_NBFC: { family: "nbfc" },
  IntegratedFinance_Banking: { family: "banking" },
  IntegratedFinance_OtherThanBank: { family: "non-ind-as" },
  IntegratedGovernance: { governance: true },
  // NSE stamps its own comment on these: `<!--IFGI V1.3 (26-06-2026)-->`, and
  // names the file INTEGRATED_FILING_GI_*. Two of them (GICRE standalone and
  // consolidated) were in the 2026-08-18 prod window and were the entire
  // `unknownTaxonomy: 2` that run reported.
  IntegratedFinance_GI: { unmapped: "general-insurance" },
};

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Numeric facts only. Non-finite is rejected AT THE BOUNDARY so no NaN or
 * Infinity can enter `values` and poison an aggregate downstream.
 *
 * `Number("")` is `0`, so empty text must be rejected before coercion or every
 * blank fact becomes a reported zero.
 */
function toFiniteNumber(text: string): number | null {
  if (text.length === 0) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  return ISO_DATE.test(t) ? t : null;
}

/** Whole days between two ISO dates; `null` if either is unusable or reversed. */
function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse one NSE corporate-results XBRL instance.
 *
 * Returns `null` when the document is not a financial-results XBRL instance we
 * recognise, or when no reporting period can be resolved. A period is not
 * optional: numbers with no period are exactly how a prior-year comparative
 * gets stored as this quarter, so a filing we cannot date is a filing we
 * refuse rather than a filing we half-report.
 *
 * **This collapses five outcomes into one `null`, which is what let a taxonomy
 * mismatch look like an empty market.** Ingestion callers that report counts
 * must use {@link parseXbrlDocument} instead; this wrapper exists for callers
 * that genuinely only want the numbers.
 */
export function parseXbrlFinancials(xml: string): XbrlFinancials | null {
  const outcome = parseXbrlDocument(xml);
  return outcome.kind === "financials" ? outcome.financials : null;
}

/**
 * Optional controls for {@link parseXbrlDocument}.
 *
 * Omitting this object — or every field on it — is byte-for-byte the
 * pre-MONEY-1114 behaviour. That is a hard contract, not a nicety: every
 * existing caller reads the quarter, and this file's primary-period rule is
 * load-bearing for both the quarterly ingest and for `otherPeriods` being an
 * auditable record of what was NOT chosen.
 */
export interface XbrlParseOptions {
  /**
   * Read the values of THIS resolved period instead of the primary one.
   *
   * ## Why the option exists — MONEY-1114
   *
   * A March-quarter filing carries the quarter AND the full financial year in
   * one document, under two contextRefs (`OneD` / `FourD`). The primary rule
   * picks the SHORTEST candidate sharing the LATEST end date, so it always
   * picks the quarter — correctly — and the year's numbers were parsed and
   * discarded. {@link XbrlFinancials.otherPeriods} recorded that the year
   * EXISTED, but it carries dates only, so the figures were unreachable without
   * re-reading the document. Measured on RELIANCE Q4-FY19 consolidated: `FourD`
   * holds 53 facts including `RevenueFromOperations` 5,810,200,000,000 (the
   * published ₹5,81,020 Cr FY19 consolidated revenue), none of which reached
   * `values`.
   *
   * ## It is a contextRef STRING, never an index
   *
   * Document order is not a contract and `otherPeriods` is a ranking, not a
   * schema. An index would silently re-point at a different period the moment
   * the candidate ordering changed — which is the same class of failure as
   * reading a prior-year comparative as this quarter, and just as invisible.
   *
   * ## It REFUSES rather than substituting
   *
   * A contextRef that resolves to no candidate period yields `no-period`, NOT a
   * quiet fall back to the primary. Returning the quarter's numbers under an
   * ANNUAL label would be a wrong figure that looks right, stored in a table
   * whose unique key would then make it the incumbent.
   *
   * Note this is the RESOLVED-period set — undimensioned duration contexts that
   * declare their own reporting period. A dimensioned segment context is not a
   * candidate and asking for one refuses, which is the intended answer: a
   * segment column is not a reporting period.
   */
  periodContextRef?: string;
}

/**
 * Parse one NSE corporate-results XBRL instance, reporting WHAT IT WAS.
 *
 * The dispatch is on the DECLARED namespace — see {@link findTaxonomy}. Nothing
 * here guesses a taxonomy from the filename, the index record or the date.
 *
 * `opts` is additive — see {@link XbrlParseOptions}. With it omitted this
 * function behaves exactly as it did before MONEY-1114.
 */
export function parseXbrlDocument(
  xml: string,
  opts?: XbrlParseOptions,
): XbrlDocumentOutcome {
  if (typeof xml !== "string" || xml.length === 0) return { kind: "not-xbrl" };

  const rootAttrs = rootAttributes(xml);
  if (rootAttrs === null) return { kind: "not-xbrl" };

  const taxonomy = findTaxonomy(rootAttrs);
  if (taxonomy === null) {
    return {
      kind: "unknown-taxonomy",
      namespaces: namespaceDeclarations(rootAttrs)
        .map(([, uri]) => uri)
        .slice(0, MAX_REPORTED_NS),
    };
  }

  const instancePrefix = prefixForNamespace(xml, XBRL_INSTANCE_NS);
  if (instancePrefix === null) return { kind: "not-xbrl" };
  // The root must actually be an XBRL instance. Without this an XSD or a
  // linkbase that merely mentions the namespaces would parse to an empty shell.
  if (!new RegExp(`<${escapeRe(instancePrefix)}:xbrl[\\s>]`).test(xml)) {
    return { kind: "not-xbrl" };
  }

  // --- what kind of integrated document is this? ------------------------------
  // Resolved BEFORE any scanning, so a governance filing costs a namespace
  // lookup rather than a full parse that finds nothing.
  let family: XbrlFamily;
  let familySource: XbrlFinancials["familySource"];
  if (taxonomy.dialect === "in-capmkt") {
    // Narrowed with an `if` rather than a ternary so `entryPoint` is a `string`
    // in the arms below — `unmapped-family` reports it non-null, and an
    // assertion here would be the only unchecked claim in the function.
    const entryPoint = taxonomy.entryPoint;
    if (entryPoint === null) {
      return { kind: "unknown-entry-point", taxonomy, entryPoint: null };
    }
    const kind = ENTRY_POINT_KINDS[entryPoint];
    if (kind === undefined) {
      return { kind: "unknown-entry-point", taxonomy, entryPoint };
    }
    if ("governance" in kind) {
      return { kind: "non-financial", taxonomy, reason: "governance" };
    }
    // Recognised, and deliberately not parsed. Checked BEFORE `kind.family` is
    // read, for the same reason governance is: the point of the registry is
    // that a shape we cannot read never reaches the concept scan at all.
    if ("unmapped" in kind) {
      return {
        kind: "unmapped-family",
        taxonomy,
        entryPoint,
        shape: kind.unmapped,
      };
    }
    family = kind.family;
    familySource = "entry-point";
  } else {
    // `in-bse-fin` has no entry-point namespace; its family is inferred.
    const inferred = detectLegacyFamily(xml);
    family = inferred.family;
    familySource = inferred.source;
  }

  const contexts = scanContexts(xml, instancePrefix);
  const contextById = new Map(contexts.map((c) => [c.id, c]));
  const facts = scanFacts(xml, taxonomy.prefix);
  if (facts.length === 0) return { kind: "not-xbrl" };

  // Group by contextRef STRING. A missing <context> declaration costs us the
  // dimension flag and the fallback period, never the facts themselves — which
  // is the only reason BHARTIARTL's undeclared OneD/FourD survive at all.
  const byContext = new Map<string, Map<string, string>>();
  const order: string[] = [];
  for (const f of facts) {
    if (f.contextRef.length === 0) continue;
    let bucket = byContext.get(f.contextRef);
    if (bucket === undefined) {
      bucket = new Map();
      byContext.set(f.contextRef, bucket);
      order.push(f.contextRef);
    }
    // First occurrence wins, deterministically. The only repeated tag observed
    // in any fixture is `CashAndCashEquivalentsCashFlowStatement`, emitted
    // twice as the cash-flow opening and closing balance — a tag no canonical
    // concept maps to, so the choice is inert today. Stating the rule keeps a
    // future mapping from silently depending on scan order.
    if (!bucket.has(f.local)) bucket.set(f.local, f.text);
  }

  const periods = resolvePeriods(order, byContext, contextById);
  // The RANKING is untouched by the selector — `resolvePeriods` still orders by
  // latest end date then shortest span. All the selector does is choose which
  // ranked candidate to read. With no selector this is index 0, i.e. exactly
  // `periods[0]` / `periods.slice(1)` as before.
  const chosen =
    opts?.periodContextRef === undefined
      ? 0
      : periods.findIndex((p) => p.contextRef === opts.periodContextRef);
  // -1 = the caller asked for a contextRef that is not a resolved period.
  // REFUSE. See XbrlParseOptions.periodContextRef.
  if (chosen < 0) return { kind: "no-period", taxonomy, family };
  const period = periods[chosen];
  if (period === undefined) return { kind: "no-period", taxonomy, family };
  const otherPeriods = periods.filter((_, i) => i !== chosen);
  const primary = byContext.get(period.contextRef) ?? new Map<string, string>();

  const table = resolveConceptTable(taxonomy.version, {
    dialect: taxonomy.dialect,
    family,
  });

  // --- balance sheet context -------------------------------------------------
  const bs = resolveBalanceSheetContext(
    period,
    order,
    byContext,
    contextById,
    table,
  );

  // --- values ---------------------------------------------------------------
  const values: Partial<Record<XbrlConcept, number>> = {};
  // WHICH ELEMENT SATISFIED EACH CONCEPT — MONEY-1250.
  //
  // Recorded for every concept, not just the ambiguous ones: the cost is one
  // string per found concept and the alternative is discovering months later
  // that the one you needed was the one you did not keep. See
  // `firstNumberTagged` for the case that forced this.
  const tags: Partial<Record<XbrlConcept, string>> = {};
  for (const concept of ALL_CONCEPTS) {
    const source =
      CONCEPTS[concept].group === "balanceSheet" ? bs?.facts : primary;
    if (source === undefined) continue;
    const hit = firstNumberTagged(source, table.get(concept) ?? []);
    if (hit !== null) {
      values[concept] = hit.value;
      tags[concept] = hit.tag;
    }
  }

  return {
    kind: "financials",
    financials: {
      taxonomy,
      family,
      familySource,
      symbol: resolveSymbol(primary, contexts, byContext),
      scripCode: resolveScripCode(primary, contexts, byContext),
      companyName: firstText(byContext, NAME_TAGS),
      isin: firstText(byContext, [TAG_ISIN]),
      basis: parseBasis(
        primary.get(TAG_BASIS) ?? firstText(byContext, [TAG_BASIS]),
      ),
      audited: parseAudited(
        primary.get(TAG_AUDITED) ?? firstText(byContext, [TAG_AUDITED]),
      ),
      currency: firstText(byContext, [TAG_CURRENCY]),
      roundingLabel: firstText(byContext, ROUNDING_TAGS),
      reportingQuarterLabel: firstText(byContext, [TAG_REPORTING_QUARTER]),
      period,
      otherPeriods,
      balanceSheetDate: bs?.date ?? null,
      balanceSheetSource: bs?.source ?? null,
      values,
      tags,
      coverage: buildCoverage(values, family),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Context resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every undimensioned duration period in the document, primary first.
 *
 * Ranking (see the module header for why): latest end date wins, then the
 * SHORTEST span at that end date — the quarter rather than the year-to-date
 * that ends on the same day. Document order breaks exact ties, which is the
 * filer's own column order (`OneD` before `FourD`).
 */
function resolvePeriods(
  order: readonly string[],
  byContext: ReadonlyMap<string, ReadonlyMap<string, string>>,
  contextById: ReadonlyMap<string, RawContext>,
): XbrlPeriod[] {
  const candidates: XbrlPeriod[] = [];

  for (const ref of order) {
    const ctx = contextById.get(ref);
    // A declared dimensioned context is a segment/expense slice, never a column.
    if (ctx?.dimensioned === true) continue;
    // An instant context has no duration and cannot carry an income statement.
    if (ctx !== undefined && ctx.instant !== null) continue;

    const facts = byContext.get(ref);
    if (facts === undefined) continue;

    const reportedStart = toIsoDate(facts.get(TAG_REPORTING_START));
    const reportedEnd = toIsoDate(facts.get(TAG_REPORTING_END));

    let start: string | null;
    let end: string | null;
    let source: XbrlPeriod["source"];
    if (reportedStart !== null && reportedEnd !== null) {
      start = reportedStart;
      end = reportedEnd;
      source = "reported-facts";
    } else if (ctx !== undefined) {
      // Fallback only. These dates are shared between the quarter and the YTD
      // column in every fixture, so a document resolved this way is relying on
      // document order to pick a column.
      start = toIsoDate(ctx.startDate);
      end = toIsoDate(ctx.endDate);
      source = "context-period";
    } else {
      continue;
    }
    if (start === null || end === null) continue;

    const days = daysBetween(start, end);
    if (days === null) continue;

    candidates.push({ start, end, days, contextRef: ref, source });
  }

  if (candidates.length === 0) return [];

  const docIndex = new Map(order.map((ref, i) => [ref, i]));
  return candidates.sort((a, b) => {
    if (a.end !== b.end) return a.end < b.end ? 1 : -1; // latest end first
    if (a.days !== b.days) return a.days - b.days; // then shortest span
    return (
      (docIndex.get(a.contextRef) ?? 0) - (docIndex.get(b.contextRef) ?? 0)
    );
  });
}

interface BalanceSheetPick {
  date: string;
  source: "column" | "date";
  facts: ReadonlyMap<string, string>;
}

/**
 * The instant context whose values belong to the chosen duration.
 *
 * Instants carry no reporting-period facts and NSE reuses one instant across
 * columns (ICICI's `OneI` and `FourI` are both @2024-09-30), so the date alone
 * cannot separate them. The filer's column convention can: `OneD` ↔ `OneI`.
 * Date matching is the fallback and is flagged as the weaker evidence it is.
 *
 * Returns `null` rather than a guess when neither rule finds a context with
 * mapped balance-sheet facts — a filing with no balance sheet (BHARTIARTL's is
 * income-statement only) must read as absent, not as zeroes.
 */
function resolveBalanceSheetContext(
  period: XbrlPeriod,
  order: readonly string[],
  byContext: ReadonlyMap<string, ReadonlyMap<string, string>>,
  contextById: ReadonlyMap<string, RawContext>,
  table: ReadonlyMap<XbrlConcept, readonly string[]>,
): BalanceSheetPick | null {
  const bsTags = new Set<string>();
  for (const concept of ALL_CONCEPTS) {
    if (CONCEPTS[concept].group !== "balanceSheet") continue;
    for (const tag of table.get(concept) ?? []) bsTags.add(tag);
  }

  /** The facts of `ref`, but only if any of them is a balance-sheet line. */
  const balanceSheetFacts = (
    ref: string,
  ): ReadonlyMap<string, string> | null => {
    const facts = byContext.get(ref);
    if (facts === undefined) return null;
    for (const tag of facts.keys()) if (bsTags.has(tag)) return facts;
    return null;
  };

  // Preferred: same column, instant flavour. `OneD` → `OneI`.
  if (period.contextRef.endsWith("D")) {
    const columnRef = `${period.contextRef.slice(0, -1)}I`;
    const ctx = contextById.get(columnRef);
    const facts = balanceSheetFacts(columnRef);
    if (ctx?.dimensioned !== true && facts !== null) {
      // An undeclared instant context still has a known date: the period end
      // it was matched to. That is the same leniency the duration side needs
      // for BHARTIARTL's undeclared OneD.
      return {
        date: toIsoDate(ctx?.instant) ?? period.end,
        source: "column",
        facts,
      };
    }
  }

  // Fallback: any undimensioned instant landing on the period end.
  for (const ref of order) {
    const ctx = contextById.get(ref);
    if (ctx === undefined || ctx.dimensioned) continue;
    const instant = toIsoDate(ctx.instant);
    if (instant === null || instant !== period.end) continue;
    const facts = balanceSheetFacts(ref);
    if (facts === null) continue;
    return { date: instant, source: "date", facts };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Identity / metadata                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The family of an `in-bse-fin` filing, which has no entry-point namespace.
 *
 * INFERENCE, and confined to the legacy dialect for that reason. The schemaRef
 * is the filer's own declaration and is checked first — read out of the
 * `<link:schemaRef xlink:href="…">` attribute specifically, NOT by grepping the
 * document, because these filings carry a free-text
 * `DisclosureOfNotesOnFinancialResults…` block that could contain any word.
 * Tag evidence is the fallback: in the LEGACY taxonomy, `NameOfBank` and
 * `InterestEarned` exist in no Ind-AS filing.
 *
 * **That last sentence stops being true in the integrated taxonomy**, which is
 * exactly why this function is not used there: an NBFC files `InterestEarned`
 * alongside `RevenueFromOperations`, and the integrated banking entry point's
 * schemaRef href is `in-capmkt-ent-2026-01-31.xsd` — the same string every
 * other integrated filing uses, so it carries no family signal at all. Both
 * halves of this heuristic fail on `in-capmkt`; the entry-point namespace is
 * used instead.
 */
function detectLegacyFamily(xml: string): {
  family: XbrlFamily;
  source: XbrlFinancials["familySource"];
} {
  // `[\s:]href` so both `href` and the usual `xlink:href` spelling match.
  const href = /schemaRef[^>]*[\s:]href\s*=\s*"([^"]*)"/i.exec(xml)?.[1];
  if (href !== undefined && /banking/i.test(href)) {
    return { family: "banking", source: "schema-ref" };
  }
  // Scanned as taxonomy-prefixed OPEN TAGS rather than as free text, so a
  // filer's notes cannot vote.
  if (/<[A-Za-z0-9_.-]+:(NameOfBank|InterestEarned)[\s>]/.test(xml)) {
    return { family: "banking", source: "tag-evidence" };
  }
  return { family: "ind-as", source: "default" };
}

/**
 * The scheme URIs whose identifier value is an EXCHANGE TRADING SYMBOL.
 *
 * Matched on the last path segment, case-insensitively: legacy filings use
 * `http://www.nseindia.com/NSESymbol`, integrated ones
 * `http://www.sebi.gov.in/in-capmkt/Symbol`.
 */
const SYMBOL_SCHEME_RE = /\/(nse)?symbol$/i;
/** …and the ones whose value is a BSE scrip code, which is not a symbol. */
const SCRIP_CODE_SCHEME_RE = /\/scripcode$/i;

/**
 * NSE symbol.
 *
 * The context entity identifier is preferred ONLY when its `scheme` says it is
 * a symbol. It is present on every context in every fixture, including the
 * 2018-03-31 files that carry no `NameOfTheCompany` and no `ISIN` at all — but
 * in the integrated taxonomy the scheme varies BY FILER: Infosys and Cipla
 * identify themselves by `…/ScripCode` (500209, 500087) while Axis Bank and
 * NDGL use `…/Symbol`. Reading the identifier without reading its scheme
 * reports "500209" as Infosys's trading symbol — a value that joins to no
 * instrument, is not obviously wrong in a log, and would be written straight
 * into `XbrlFiling.symbol`.
 */
function resolveSymbol(
  primary: ReadonlyMap<string, string>,
  contexts: readonly RawContext[],
  byContext: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  for (const ctx of contexts) {
    const id = ctx.entityIdentifier;
    if (typeof id !== "string" || id.length === 0) continue;
    // An UNRECOGNISED scheme is accepted: a new spelling of "symbol" should
    // still work, and only the scrip-code scheme is known to hold a non-symbol.
    if (
      ctx.entityScheme !== null &&
      !SYMBOL_SCHEME_RE.test(ctx.entityScheme) &&
      SCRIP_CODE_SCHEME_RE.test(ctx.entityScheme)
    ) {
      continue;
    }
    return id;
  }
  const fromFact =
    primary.get(TAG_SYMBOL) ?? firstText(byContext, [TAG_SYMBOL]);
  return fromFact !== null && fromFact.length > 0 ? fromFact : null;
}

/**
 * The BSE scrip code, when stated. Never merged into `symbol`.
 *
 * Read from the `ScripCode` FACT first (present in every integrated filing) and
 * from a scrip-code-schemed entity identifier second. `"000000"` is a real
 * value NDGL files for a company that is NSE-only, so it is preserved rather
 * than normalised away — an unlisted-on-BSE marker is information.
 */
function resolveScripCode(
  primary: ReadonlyMap<string, string>,
  contexts: readonly RawContext[],
  byContext: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  const fromFact =
    primary.get(TAG_SCRIP_CODE) ?? firstText(byContext, [TAG_SCRIP_CODE]);
  if (fromFact !== null && fromFact.length > 0) return fromFact;
  for (const ctx of contexts) {
    const id = ctx.entityIdentifier;
    if (typeof id !== "string" || id.length === 0) continue;
    if (
      ctx.entityScheme !== null &&
      SCRIP_CODE_SCHEME_RE.test(ctx.entityScheme)
    )
      return id;
  }
  return null;
}

function parseBasis(raw: string | null | undefined): XbrlBasis | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "consolidated") return "consolidated";
  if (v === "standalone" || v === "non-consolidated") return "standalone";
  return null;
}

function parseAudited(raw: string | null | undefined): boolean | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "audited") return true;
  if (v === "unaudited" || v === "un-audited") return false;
  return null;
}

/** First non-empty value for any of `tags`, scanning contexts in document order. */
function firstText(
  byContext: ReadonlyMap<string, ReadonlyMap<string, string>>,
  tags: readonly string[],
): string | null {
  for (const facts of byContext.values()) {
    for (const tag of tags) {
      const v = facts.get(tag);
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
}

/** First candidate tag that yields a finite number. Order is priority. */
function firstNumber(
  facts: ReadonlyMap<string, string>,
  tags: readonly string[],
): number | null {
  return firstNumberTagged(facts, tags)?.value ?? null;
}

/**
 * The first usable number AND the element that carried it — MONEY-1250.
 *
 * `firstNumber` returns the value alone, which is why a concept mapped from
 * SEVERAL tags loses the company's own choice between them. The load-bearing
 * case is `revenueFromOperations: ["RevenueFromOperations", "InterestEarned"]`:
 * an RBI Form-A bank tags `InterestEarned`, an Ind-AS filer tags
 * `RevenueFromOperations`, and after the fold `values` cannot tell them apart.
 *
 * MONEY-1239 hit exactly this and recorded that splitting the tag is "the
 * prerequisite for any fix here". It is not a split that is needed — the
 * document already distinguishes them. What was needed is not throwing the
 * distinction away.
 *
 * Verified against real filings (2026-08-22):
 *
 *     3MINDIA    RevenueFromOperations present, InterestEarned ABSENT
 *     ICICIBANK  RevenueFromOperations ABSENT,  InterestEarned present
 *     360ONE     BOTH present, InterestEarned = 0.00
 */
function firstNumberTagged(
  facts: ReadonlyMap<string, string>,
  tags: readonly string[],
): { value: number; tag: string } | null {
  for (const tag of tags) {
    const raw = facts.get(tag);
    if (raw === undefined) continue;
    const n = toFiniteNumber(raw);
    if (n !== null) return { value: n, tag };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What this filing supports, and what it does not.
 *
 * `missing` lists only concepts the FAMILY is expected to carry. A bank has no
 * `Inventories` and never will; listing it would make "missing" a list of
 * things that are fine, and a list like that gets ignored.
 */
function buildCoverage(
  values: Partial<Record<XbrlConcept, number>>,
  family: XbrlFamily,
): XbrlCoverage {
  const present: XbrlConcept[] = [];
  const missing: XbrlConcept[] = [];
  const byGroup: Record<
    XbrlConceptGroup,
    { present: number; expected: number }
  > = {
    income: { present: 0, expected: 0 },
    perShare: { present: 0, expected: 0 },
    balanceSheet: { present: 0, expected: 0 },
  };

  for (const concept of ALL_CONCEPTS) {
    const spec = CONCEPTS[concept];
    const expected = spec.expectedIn.includes(family);
    // `!== undefined`, never truthiness: a reported 0.00 is a value.
    const found = values[concept] !== undefined;

    if (expected) byGroup[spec.group].expected++;
    if (found) {
      present.push(concept);
      if (expected) byGroup[spec.group].present++;
    } else if (expected) {
      missing.push(concept);
    }
  }

  const hasRevenue = values.revenueFromOperations !== undefined;
  const hasProfit =
    values.profitForPeriod !== undefined ||
    values.profitFromContinuingOperations !== undefined;
  const hasBalanceSheet = values.totalAssets !== undefined;
  // A P&L needs the run from top line to tax, not just the two headline rows.
  const hasIncomeStatement =
    hasRevenue &&
    hasProfit &&
    values.totalIncome !== undefined &&
    values.totalExpenses !== undefined &&
    values.profitBeforeTax !== undefined &&
    values.taxExpense !== undefined;

  let level: XbrlCoverageLevel = "none";
  if (hasIncomeStatement && hasBalanceSheet) level = "full";
  else if (hasIncomeStatement) level = "income";
  else if (hasRevenue && hasProfit) level = "headline";

  present.sort();
  missing.sort();
  return { level, present, missing, byGroup };
}

/* -------------------------------------------------------------------------- */
/* Units — the StockFinancials denomination boundary (MONEY-1205)             */
/* -------------------------------------------------------------------------- */

/**
 * ₹1 crore, in rupees. 1e7.
 *
 * Named rather than inlined because the number is meaningless on sight and
 * because it collides with a magnitude that already means something else in
 * this codebase: `KNOWN_SCALES` in `xbrl-projection.ts` lists 1e7 as a
 * reconciliation VERDICT factor. One is the conversion; the other is the alarm
 * that fires when the conversion has not happened. Keeping them separately
 * named is what stops someone "unifying" them and deleting the alarm.
 */
export const RUPEES_PER_CRORE = 1e7;

/**
 * Absolute rupees → ₹ crore, for values crossing INTO `StockFinancials`.
 *
 * Returns `undefined` for anything that is not a finite number, so an absent or
 * poisoned input stays absent rather than becoming `0` or `NaN`. That matters
 * more than usual here: the caller spreads the result into a Prisma `update:`,
 * where `undefined` means "leave the column alone" and `NaN` means "write NaN".
 *
 * Deliberately NOT rounded. These are ₹ crore with real fractional parts
 * (₹4.71 lakh crore carries paise-level precision at 2dp of crore), and
 * rounding at the writer would manufacture a disagreement for the reconcile
 * gate to report against a source that is in fact exact.
 */
export function rupeesToCrores(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const out = value / RUPEES_PER_CRORE;
  return Number.isFinite(out) ? out : undefined;
}
