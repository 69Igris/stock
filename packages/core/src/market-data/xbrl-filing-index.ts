/**
 * NSE's results INDEX — which filings exist, and where their XBRL lives.
 *
 * MONEY-1113 (Data Engine P10 F1). Pure: no I/O, no clock, no DB. The caller
 * fetches; this module decides what a response MEANS.
 *
 * The XBRL documents themselves are parsed by `xbrl-financials-logic.ts`. This
 * file is only about the index in front of them — and the index turned out to
 * carry more traps than the documents do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THERE ARE TWO ENDPOINTS, SPLIT AT SEBI'S INTEGRATED-FILING REGIME
 *
 * Measured against the live API on 2026-08-14:
 *
 *   /api/corporates-financial-results          Nov-2021  1,943 records
 *   (the LEGACY index)                         Nov-2022  2,484
 *                                              Nov-2023  2,541
 *                                              Nov-2024  2,402
 *                                              Nov-2025     31   <- goes quiet
 *                                              Feb-2026      4
 *
 *   /api/integrated-filing-results             Jan-Feb 2026: 5,000 records
 *   (the MODERN index)                         across 2,101 symbols
 *
 * SEBI's integrated filing took effect for the quarter ending Dec-2024, which
 * is exactly where the legacy index stops receiving new filings. It still
 * serves history, so BOTH are needed: the modern one for anything current, the
 * legacy one for the backfill.
 *
 * Building only against the legacy endpoint — the obvious thing to do, since it
 * is the one that is documented and the one every older example uses — produces
 * a daily job that finds ~0 filings forever and reports success.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE LEGACY INDEX'S `period` PARAM IS REQUIRED, AND HAS EXACTLY TWO VALUES
 *
 * Measured live 2026-08-19, window 01-05-2019 → 31-05-2019, `index=equities`:
 *
 *     period=Quarterly     1,467 records   (98.2% carry a .xml)
 *     period=Annual        1,539 records   (98.2%)
 *     period=Half-Yearly       0
 *     period=Others            0
 *     period OMITTED           0           <-- NOT "everything". Nothing.
 *     period=Zzzz          3,012 records   <-- 1467 + 1539 + 6
 *
 * Three separate traps live in that table.
 *
 * 1. **`Annual` is a whole second population, and it was never requested.**
 *    `xbrl-sync` hardcoded `?period=Quarterly&`, so for the entire history of
 *    this job annual filings were not missing from NSE — they were not asked
 *    for. 1,539 against 1,467 in one month: this is not an edge case.
 *
 * 2. **Omitting the param returns an empty array, not the union.** The obvious
 *    "just drop the filter" produces a perfectly successful 200 with zero
 *    records, which reads as a quiet month.
 *
 * 3. **An UNRECOGNISED value returns the union of everything.** Verified by set
 *    arithmetic, not by counting: every one of the 1,467 + 1,539 records
 *    (keyed on seqNumber+symbol+period+consolidated) appears in the `Zzzz`
 *    response, and the 6 extra are records whose `period` column is `null` and
 *    which therefore NO valid filter can reach. So the filter is an exact match
 *    applied only when the value is recognised — which means a typo'd param
 *    silently DOUBLES the result set rather than failing, and "fixing" the typo
 *    later silently halves it.
 *
 * `Half-Yearly` / `Others` returning 0 was checked in November too (the month
 * a half-yearly filer would file) and is 0 there as well: the `period` column
 * only ever holds `Quarterly`, `Annual` or `null`. {@link parsePeriodType} still
 * understands "half" because it costs nothing and the modern index may yet
 * grow one — but nothing on the legacy index will produce it.
 *
 * See {@link LEGACY_PERIOD_PARAMS}, which is that measurement as code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE LEGACY INDEX DOES NOT PAGINATE. AT ALL.
 *
 * `size` and `page` are accepted and ignored. Measured on the same window:
 * `page=1`, `page=2`, `page=3` and no paging params at all returned byte-
 * identical 1,119,778-byte bodies — the same 1,467 seqNumbers in the same
 * order, four times. It answers the whole window in one response.
 *
 * That matters far more than it sounds, because {@link detectTruncation}'s
 * "a full page means there is more" rule fires on it (1,467 ≥ any page size we
 * would request) and a caller that pages until a short page never gets one. It
 * re-requests the identical body until its own page cap, collecting ~40 copies
 * of every entry. See {@link indexSupportsPaging}.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE MODERN INDEX DEFAULTS TO 20 RECORDS AND SAYS NOTHING ABOUT IT
 *
 * The single most dangerous property of this API. Measured:
 *
 *   from=15-02-2026 to=15-02-2026    6 records   (a real, complete answer)
 *   from=10-02-2026 to=15-02-2026   20
 *   from=01-02-2026 to=15-02-2026   20
 *   from=01-01-2026 to=15-02-2026   20           (46 days -> same 20)
 *   ...same window with &size=5000  5,000
 *
 * Twenty is a plausible number of filings for a day, so the truncation reads as
 * a fact about the market rather than a fact about the request — and the
 * resulting coverage gap would have been attributed to NSE.
 *
 * ### The MODERN index does say so, in an envelope that is easy to throw away
 *
 * An earlier version of this comment asserted "there is no total, no hasMore".
 * That was wrong, and wrong in an instructive way: the LEGACY index returns a
 * bare array, so the unwrapping code was written to reach past `{data: […]}`
 * and the rest of the envelope was never looked at. It carries:
 *
 *     { data: [...20 records...], size: 20, page: -1, totalCount: 7091 }
 *
 * `totalCount` beside `size` is an unambiguous "you received 20 of 7091" —
 * strictly better than any inference. `detectTruncation` uses it whenever it is
 * present.
 *
 * ### The heuristic stays, because the LEGACY index really has no envelope
 *
 * There it is a bare array with no counts at all, so the structural tell is the
 * only signal available: a newest-N cap makes every record cluster on the
 * window's LAST day. That cannot be read off the count alone — a page of
 * exactly N is equally consistent with "capped at N" and "there were N".
 *
 * `size` and `page` both work and compose (page 1 and page 2 at size=200 were
 * verified disjoint), so the fix is to page. Both signals are kept because the
 * next cap will be found the way this one was.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE FLAGS ARE NOT Y/N — ALL FOUR OF THEM
 *
 * Every boolean-looking field in the legacy index is a WORD, and reading them
 * as Y/N yields `false` for all of them with no error:
 *
 *   consolidated  "Consolidated" | "Non-Consolidated"     (NOT Y/N)
 *   audited       "Audited" | "Un-Audited"                (NOT Y/N)
 *   cumulative    "Non-cumulative" | "Cumulative"         (NOT Y/N)
 *   bank          "N" | "B" (bank) | "F" (other financial) (THREE values)
 *
 * `bank` is the worst of the four because it looks closest to a flag. Over one
 * live window: 2,224 `N`, 88 `F`, 6 `B`. An `=== "Y"` test classifies all 6
 * banks and all 88 NBFCs as generic filers, which is exactly the population
 * whose XBRL uses different tags for the same concepts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE STUB URL
 *
 * A record with no XBRL still carries a well-formed URL ending in a bare dash:
 * `https://nsearchives.nseindia.com/corporate/xbrl/-`. It starts with "http",
 * it is non-empty, and it parses as a URL — so every loose validity check
 * reports it as usable, and coverage measured that way is ~100% for every year
 * back to 2012. Measured on the `.xml` suffix instead: 0% through Feb-2018,
 * 89% in May-2018, 97-98% from 2019.
 */

/** Which NSE index a record came from. They have disjoint schemas. */
export type FilingIndexEra = "legacy" | "integrated";

export type FilingBasis = "CONSOLIDATED" | "STANDALONE";

/**
 * Which exchange's results index produced a filing — MONEY-1255.
 *
 * `XbrlFiling`'s unique key already carries `exchange`, so BSE and NSE filings
 * coexist without collision. What did NOT exist until now was any way for a
 * filing to SAY which one it came from: the worker hardcoded `"NSE"` at every
 * write, which was true (NSE was the only index) and silently wrong the moment
 * it stopped being.
 */
export type FilingExchange = "NSE" | "BSE";

/**
 * How the filer is classified for tag-mapping purposes.
 *
 * `BANK` and `NBFC` are separated rather than folded into one "financial"
 * bucket because their XBRL differs: a bank files RBI Form-A concepts
 * (`InterestEarned`, `Deposits`, `CET1Ratio`), an NBFC files Ind-AS with
 * financial-sector extensions. Collapsing them would make a coverage report
 * blame the parser for concepts the filer never had.
 */
export type FilerKind = "GENERIC" | "BANK" | "NBFC";

/**
 * The period a stored row covers.
 *
 * `NINE_MONTH` is not decoration — see {@link classifyFilingPeriod}. Without it
 * the April–December year-to-date column (274 days) falls into whatever band
 * sits below "annual", which was `HALF_YEARLY`: a nine-month figure stored and
 * charted as six months.
 */
export type FilingPeriodType =
  | "QUARTERLY"
  | "HALF_YEARLY"
  | "NINE_MONTH"
  | "ANNUAL";

/**
 * Is this record the filing as first published, or a re-publication of it?
 *
 * MODERN INDEX ONLY, from `type_Sub`. NSE lets a filer withdraw and re-file the
 * same period; the re-filing gets a NEW `seq_Id`, a NEW xbrl URL, a
 * `revised_Date`, usually a `revision_Remark` — and, measured, a NULL
 * `broadcast_Date`. It does NOT replace the Original in the index: BOTH records
 * are served, inside the same window, for the same period.
 *
 * That matters because `XbrlFiling`'s unique key
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)` deliberately
 * excludes `sourceUrl` — a correction must UPDATE the period, not fork it — so
 * the two siblings collide on one row and whichever is written LAST wins.
 *
 * `null` on the LEGACY index, and that is a measured absence rather than a
 * gap waiting to be filled. See {@link parseRevisionKind}.
 */
export type FilingRevisionKind = "ORIGINAL" | "REVISION";

/**
 * One filing, normalised across the two eras.
 *
 * Fields the MODERN index does not carry are nullable rather than defaulted —
 * `isin`, `cumulative` and `periodType` simply do not exist there. Defaulting
 * them would invent data and, worse, make the two eras indistinguishable
 * downstream at exactly the point where knowing which one you have matters.
 */
export interface FilingIndexEntry {
  era: FilingIndexEra;
  symbol: string;
  /**
   * Which exchange's index produced this entry — MONEY-1255.
   *
   * OPTIONAL, and absence means NSE. That is a real default rather than an
   * "unknown" hiding in a nullable, because NSE was the only index that
   * existed when every other producer in this repo was written: an entry
   * without this field provably came from the NSE parser.
   *
   * Never read it directly — read {@link filingExchange}. One accessor is what
   * keeps the default from being re-implemented as a scattered `?? "NSE"`,
   * where a BSE entry that forgot to set it would be written to the NSE
   * namespace and look entirely normal.
   */
  exchange?: FilingExchange;
  /**
   * The BSE scrip code, when the index states one. `null`/absent on NSE.
   *
   * Carried separately from {@link symbol} and NEVER merged into it. BSE's
   * index is keyed by scrip code, and a BSE-only issuer's instance declares
   * `<Symbol>NOTLISTED</Symbol>` — a literal sentinel, not an absent field — so
   * the scrip code is the only identity such a filing actually has. See
   * `resolveWritableSymbol` in the worker for what that costs if it is missed.
   */
  scripCode?: string | null;
  /** Legacy only; the modern index has no ISIN field. */
  isin: string | null;
  /** The XBRL XML url. Guaranteed to end in `.xml` — stubs never get here. */
  xbrlUrl: string;
  /** Modern only: the iXBRL HTML rendering, when present. */
  ixbrlUrl: string | null;
  basis: FilingBasis;
  audited: boolean | null;
  /** Legacy only. `null` on modern records, never `false`. */
  cumulative: boolean | null;
  /** Legacy only. `null` on modern records — infer from the quarter-end date. */
  periodType: FilingPeriodType | null;
  filerKind: FilerKind;
  /** Quarter-end, when the record states one (modern `qe_Date`). */
  quarterEnd: Date | null;
  /** When NSE broadcast it. */
  broadcastAt: Date | null;
  /** The company name as printed. */
  companyName: string;

  // ── MONEY-1235: revision metadata. Present in the bytes since the modern
  //    index launched; parsed by NOBODY until a Revision was found overwriting
  //    itself with its own superseded Original. See FilingRevisionKind.

  /**
   * Modern `type_Sub`. `null` on legacy — the legacy index has no equivalent.
   *
   * Read for reporting and for the sibling-detection tests, NOT as the ordering
   * key: see {@link indexSequence} for why two REVISIONS of one period make a
   * kind-based "revisions last" rule insufficient.
   */
  revisionKind: FilingRevisionKind | null;
  /**
   * Modern `revised_Date` — when the filer re-filed. `null` on an Original and
   * on every legacy record.
   *
   * Load-bearing for `filedAt`: a Revision's `broadcast_Date` is NULL (3 of the
   * 20 records in `integrated-capped-20.sample.json`, 16 of 20 in the 2025-06
   * capture), so a revision write with no fallback nulls out a `filedAt` the
   * Original had already supplied.
   */
  revisedAt: Date | null;
  /**
   * Modern `creation_Date` — when NSE created the index record. `null` on
   * legacy, which publishes no equivalent (`filingDate` / `exchdisstime` are
   * about the FILER's submission, not the index row).
   */
  createdAt: Date | null;
  /**
   * The index's own row sequence — legacy `seqNumber`, modern `seq_Id` — as a
   * number, or `null` when it is absent or non-numeric.
   *
   * THE ordering key, and the reason it is a sequence rather than
   * `revisionKind`: `integrated-capped-20.sample.json` holds JAINREC's
   * 31-DEC-2025 standalone period as TWO Revisions (seq 143649 at 22:41:14 and
   * seq 143646 at 22:36:37) with no Original in the window at all. "Process
   * revisions last" leaves those two in whatever order the index returned —
   * which is newest-first, so the EARLIER revision would still win. Only a
   * monotonic key orders them.
   *
   * Comparable only WITHIN an era: legacy runs in the 1,03x,xxx–1,18x,xxx range
   * and modern in the 9x,xxx–14x,xxx range, so a legacy row sorts numerically
   * ABOVE a modern one that is a year newer.
   */
  indexSequence: number | null;
}

/** Why an index record was dropped. Every one is a REJECT, never a coercion. */
export type FilingRejectReason = "NO_SYMBOL" | "NO_XBRL" | "UNRECOGNISED_SHAPE";

export interface RejectedFilingRecord {
  reason: FilingRejectReason;
  symbol: string | null;
  /** The `xbrl` value as served, so a new absence marker is visible in logs. */
  rawXbrl: string | null;
}

export interface FilingIndexPage {
  era: FilingIndexEra;
  entries: FilingIndexEntry[];
  rejected: RejectedFilingRecord[];
  /**
   * Records the response contained, before filtering. The denominator for
   * "what share of filings actually have XBRL", which is the number P10 F2's
   * scope depends on.
   */
  listed: number;
  /**
   * Records whose `xbrl` is the stub. Reported separately from `rejected`
   * because it is NOT an error — it is the normal state of a pre-2018 filing,
   * and conflating the two makes the backfill look broken when it is complete.
   */
  stubbed: number;
  /**
   * The server's OWN count of matching records, when it reports one
   * (`totalCount` on the modern index). `null` on the legacy index, which
   * returns a bare array with no envelope at all.
   *
   * This is the exact truncation signal, and it exists — an earlier version of
   * this module inferred truncation structurally because the envelope was being
   * discarded before anyone read it.
   */
  total: number | null;
  /** The page size the server says it applied (`size`). `null` when absent. */
  serverPageSize: number | null;
}

// ─── Field helpers ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Does this value point at a real XBRL document?
 *
 * THE `.xml` suffix check. See the header — NSE's absence marker is a
 * well-formed URL ending in a bare dash, and truthiness, `startsWith("http")`
 * and `URL` parsing all accept it.
 */
export function hasXbrlDocument(url: unknown): url is string {
  const s = str(url);
  return s !== null && s.toLowerCase().endsWith(".xml");
}

/**
 * `"Consolidated"` / `"Non-Consolidated"` → basis.
 *
 * Order matters: "Non-Consolidated" CONTAINS "Consolidated", so a substring
 * test in the wrong order marks every standalone filing as consolidated. The
 * negative is therefore checked first, and the whole thing is anchored on a
 * `non` prefix rather than on `includes`.
 */
export function parseBasis(v: unknown): FilingBasis {
  const s = (str(v) ?? "").toLowerCase();
  if (s.startsWith("non")) return "STANDALONE";
  if (s.startsWith("consolidated")) return "CONSOLIDATED";
  // Anything unrecognised is STANDALONE, which is the conservative reading: a
  // standalone number understated as standalone is right more often than a
  // consolidated number asserted from an unknown label.
  return "STANDALONE";
}

/**
 * `"Audited"` / `"Un-Audited"` → boolean, or `null` when the field is absent.
 *
 * `null` rather than `false`, because "we do not know whether this was audited"
 * and "this was explicitly unaudited" are different claims to put in front of a
 * user reading a company's results.
 */
export function parseAudited(v: unknown): boolean | null {
  const s = str(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t.startsWith("un") || t.startsWith("non")) return false;
  if (t.startsWith("audited")) return true;
  return null;
}

/** `"Cumulative"` / `"Non-cumulative"` → boolean, or `null` when absent. */
export function parseCumulative(v: unknown): boolean | null {
  const s = str(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t.startsWith("non")) return false;
  if (t.startsWith("cumulative")) return true;
  return null;
}

/**
 * `type_Sub` → revision kind. MODERN INDEX ONLY — MONEY-1235.
 *
 * ## The legacy index has NO revision flag, and its lookalike is not one
 *
 * The obvious candidate is `reInd`, and it is wrong. Measured across all 105
 * legacy records in this repo's fixtures, `reInd` is a 1:1 restatement of the
 * `indAs` column — the ACCOUNTING REGIME, not a revision:
 *
 *     reInd "N" -> indAs "Ind-AS New"   80/80
 *     reInd "A" -> indAs "Non-Ind-AS"   20/20
 *     reInd "F" -> indAs "NBFC-IND"      5/5
 *
 * Reading `reInd !== "N"` as "revised" would therefore label 25 of 105 legacy
 * filings (23.8%) revisions, every one of them wrongly, and — because the
 * ordering below puts revisions last — would hand the write order to a column
 * about accounting standards.
 *
 * `oldNewFlag` is the other lookalike and is equally unusable: it takes the
 * values `"N"` (91) and ABSENT (14) across the same 105 records and never a
 * second value, so no mapping can be established from what we have. It is left
 * unparsed deliberately rather than guessed at.
 *
 * So legacy entries carry `revisionKind: null` — "this index does not say" —
 * which is a different claim from `"ORIGINAL"` and must stay different.
 *
 * Anything unrecognised is `null` rather than `"ORIGINAL"`, for the same
 * reason: a new `type_Sub` value appearing upstream must read as "unknown", not
 * as a confident "first publication".
 */
export function parseRevisionKind(v: unknown): FilingRevisionKind | null {
  const s = str(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t.startsWith("revis")) return "REVISION";
  if (t.startsWith("original")) return "ORIGINAL";
  return null;
}

/**
 * `seqNumber` / `seq_Id` → number.
 *
 * Both eras serve the sequence as a STRING (`"143654"`, `"1189117"`), so this
 * is not a redundant `typeof v === "number"` check. Refuses anything that is
 * not a run of digits: `Number("")` is 0 and `Number(" 12 ")` is 12, and a
 * sequence that silently became 0 would sort every unparsable record first and
 * let it be overwritten by everything else.
 */
export function parseIndexSequence(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (s === null || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * `bank` → filer kind. THREE values, not two: `N` / `B` / `F`.
 *
 * Anything unrecognised is GENERIC. That is deliberately a catch-all rather
 * than a rejection: an unknown filer class should still have its Ind-AS
 * concepts read, and a new letter appearing upstream must not start dropping
 * filings.
 */
export function parseFilerKind(v: unknown): FilerKind {
  switch ((str(v) ?? "").toUpperCase()) {
    case "B":
      return "BANK";
    case "F":
      return "NBFC";
    default:
      return "GENERIC";
  }
}

/** `"Quarterly"` / `"Half-Yearly"` / `"Annual"` → our closed set, or null. */
export function parsePeriodType(v: unknown): FilingPeriodType | null {
  const s = (str(v) ?? "").toLowerCase();
  if (!s) return null;
  if (s.startsWith("annual") || s.startsWith("year")) return "ANNUAL";
  if (s.startsWith("half")) return "HALF_YEARLY";
  if (s.startsWith("quarter")) return "QUARTERLY";
  return null;
}

// ─── The legacy index's `period` query parameter ─────────────────────

/**
 * The values `?period=` accepts, measured — see the header.
 *
 * TWO, and both must be requested: `Quarterly` alone is what `xbrl-sync`
 * shipped with, and it is why `xbrl_filings` held 2,152 rows of which 100% were
 * QUARTERLY. Ordered quarter-first so a run that dies halfway has collected the
 * population the nightly job depends on.
 *
 * NOT a `FilingPeriodType`. These are wire values for one endpoint's query
 * string; the stored period type is derived from the DOCUMENT's own dates by
 * {@link classifyFilingPeriod}, because the index's word and the filing's span
 * are different claims and only one of them is checkable.
 */
export const LEGACY_PERIOD_PARAMS = ["Quarterly", "Annual"] as const;

export type LegacyPeriodParam = (typeof LEGACY_PERIOD_PARAMS)[number];

/**
 * Does this index honour `size` / `page`?
 *
 * `false` for the legacy index, which ignores both and answers the whole window
 * in one body — verified byte-identical across `page=1/2/3` and no-paging. A
 * caller that pages it "until a short page" never terminates on data; it
 * terminates on its own page cap, having collected the same records once per
 * iteration.
 *
 * `true` for the modern index, which pages correctly: requested `page` is
 * 1-based and echoed back 0-based (`page=30` at `size=10` returned records
 * 291-295 of 295 and echoed `page: 29`), and consecutive pages are disjoint.
 * `page=0` and `page=1` return the SAME first page, `page=0` echoing the `-1`
 * "none requested" sentinel — so 1-based is the shape to send.
 */
export function indexSupportsPaging(era: FilingIndexEra): boolean {
  return era === "integrated";
}

/**
 * The path to request one page of one index.
 *
 * Pure, and owned here rather than in the worker, because every trap it has to
 * avoid is a fact about the INDEX and all three of them are silent:
 *
 *  - the legacy index needs `period=`, and OMITTING it returns `[]` rather than
 *    everything, so a caller that "drops the filter" gets a clean 200 with no
 *    records;
 *  - the modern index takes no period at all and ignores one if sent;
 *  - both take `size`/`page`, and only the modern one honours them.
 *
 * `period` is REQUIRED as an argument (`null` for "send none") rather than
 * optional. An optional parameter left off a legacy call is exactly the empty
 * response above, and the type system is the only thing that can catch it
 * before a run does.
 */
export function buildFilingIndexPath(opts: {
  era: FilingIndexEra;
  from: string;
  to: string;
  size: number;
  page: number;
  period: LegacyPeriodParam | null;
}): string {
  const base =
    opts.era === "integrated"
      ? "/api/integrated-filing-results"
      : "/api/corporates-financial-results";
  const period = opts.period === null ? "" : `period=${opts.period}&`;
  return (
    `${base}?${period}index=equities&from_date=${opts.from}` +
    `&to_date=${opts.to}&size=${opts.size}&page=${opts.page}`
  );
}

/**
 * Which exchange an entry belongs to. THE read path for {@link
 * FilingIndexEntry.exchange}.
 *
 * Exists so the NSE default lives in exactly one place. The alternative — a
 * `?? "NSE"` at each of the four write sites — is the same defect this ticket
 * was filed to remove, just relocated: every one of those sites would be
 * correct today and independently wrong the first time a producer forgot to
 * stamp the field.
 */
export function filingExchange(entry: {
  exchange?: FilingExchange;
}): FilingExchange {
  return entry.exchange ?? "NSE";
}

/** Host that serves a given exchange's results index. */
export const RESULTS_INDEX_HOST: Readonly<Record<FilingExchange, string>> = {
  NSE: "https://www.nseindia.com",
  BSE: "https://api.bseindia.com/BseIndiaAPI/api",
};

/** Host that serves a given exchange's XBRL INSTANCE files. */
export const RESULTS_INSTANCE_HOST: Readonly<Record<FilingExchange, string>> = {
  // NSE instance URLs arrive from the index fully qualified; this is the
  // origin they use, kept for symmetry and for building a BSE URL from the
  // site-relative path BSE returns.
  NSE: "https://nsearchives.nseindia.com",
  BSE: "https://www.bseindia.com",
};

/**
 * What to ask each exchange's results index for.
 *
 * A discriminated union rather than one widened options bag, because the two
 * indexes do not merely differ in spelling — they differ in what a REQUEST
 * even is. NSE's is a date-ranged, paged, era-split query over the whole
 * market. BSE's is keyed by SCRIP CODE and takes no date range and no paging
 * at all. An options object carrying `from`/`to`/`page` alongside `scripCode`
 * would make three fields meaningless in each branch and let a caller pass a
 * date range to BSE that is silently ignored — which is exactly how a job ends
 * up believing it walked a window it never walked.
 */
export type FilingIndexRequest =
  | {
      exchange: "NSE";
      era: FilingIndexEra;
      from: string;
      to: string;
      size: number;
      page: number;
      period: LegacyPeriodParam | null;
    }
  | { exchange: "BSE"; scripCode: string };

/**
 * The path to request one page of one exchange's results index.
 *
 * The exchange-aware entry point. {@link buildFilingIndexPath} stays exactly as
 * it was and still owns every NSE trap; this only dispatches, so adding BSE
 * could not change an NSE URL.
 *
 * ## The BSE path, and how it was established
 *
 * `Result_Arch_ng` was found by reading BSE's own Angular bundle rather than by
 * guessing, and then verified live (MONEY-1255). That matters because three
 * earlier guesses at a BSE results URL all 404'd, and the registry's standing
 * rule for this shape is that a plausible-looking path with no rows is a
 * PARAMS problem, not a licence to re-derive the path.
 *
 * It is per-scrip by construction. There is no date-ranged market-wide variant:
 * `NSTodayResults_ng/w` lists the scrips that filed TODAY and carries no XBRL
 * link, so a nightly BSE ingest is two hops — today's filers, then one
 * `Result_Arch_ng` per filer. The index returns that scrip's FULL history in
 * one response, so there is nothing to page.
 */
export function buildResultsIndexPath(req: FilingIndexRequest): string {
  if (req.exchange === "BSE") {
    return `/Result_Arch_ng/w?scrip_cd=${encodeURIComponent(req.scripCode)}`;
  }
  return buildFilingIndexPath(req);
}

/**
 * BSE's index directory for integrated-era NBFC filings is WRONG, and this is
 * the workaround — MONEY-1255.
 *
 * ## The defect
 *
 * BSE serves integrated-era (`in-capmkt`) instances out of `IF*UploadDocument`
 * directories: `IFIndasUploadDocument`, `IFOtherthanUploadDocument`. NBFC
 * filings are the ONE integrated family whose index rows point into the LEGACY
 * `NBFCUploadDocument` directory instead — and those URLs 404. The files exist;
 * they are in the sibling `IFNBFCUploadDocument`.
 *
 * Measured across three NBFCs (512437 Apollo Finvest, 539773 Advik Capital,
 * 530127 NPR Finance) and both taxonomy versions (in-capmkt 2025-01-31 and
 * 2026-01-31): every `NBFCUploadDocument/Integrated_Finance_NBFC_*` URL 404s,
 * and every one of them resolves under `IFNBFCUploadDocument`. Note the cell is
 * narrow — `NBFCUploadDocument/NBFC_*` (the LEGACY NBFC family, same directory)
 * serves perfectly well, so this is not "that directory is broken".
 *
 * ## Why a FALLBACK and not a rewrite
 *
 * The indexed URL is tried FIRST and the rewrite only on failure, so the two
 * possible futures stay distinguishable in the counters:
 *
 *   - BSE fixes its index      → recoveries fall to zero, failures stay zero.
 *   - BSE moves the sibling    → recoveries fall, FAILURES rise.
 *
 * A blind replacement would keep working through the first and go silent
 * through the second. This is a workaround for someone else's bug, not a
 * durable fact about their layout: if the recovery counter ever reads zero
 * while BSE-NBFC filings are still arriving, re-test before deleting it.
 *
 * The directory segment is matched CASE-INSENSITIVELY — BSE serves from IIS,
 * where `ifnbfcuploaddocument` and `IFNBFCUploadDocument` are the same
 * directory. Pinning the casing would let a cosmetic change on their side stop
 * the rewrite from firing, which would present as the filings simply vanishing.
 *
 * @returns the URLs to try IN ORDER. Always at least one; a second only when
 *          the known defect applies. Never throws on a malformed input — an
 *          unparseable link yields itself, and the fetch reports the failure.
 */
export function bseInstanceUrlCandidates(link: string): string[] {
  const absolute = /^https?:\/\//i.test(link)
    ? link
    : `${RESULTS_INSTANCE_HOST.BSE}${link.startsWith("/") ? "" : "/"}${link}`;

  // Only the integrated NBFC family in the legacy NBFC directory. Both halves
  // are required: the same directory's legacy `NBFC_*` files serve fine, and
  // rewriting those would turn a working URL into a 404.
  const rewritten = absolute.replace(
    /\/NBFCUploadDocument\/(?=Integrated_Finance_NBFC_)/i,
    "/IFNBFCUploadDocument/",
  );
  return rewritten === absolute ? [absolute] : [absolute, rewritten];
}

// ─── Period classification from the document's own span ──────────────

/**
 * What a stored row's period type and cumulative flag are, given its length.
 *
 * ## Why this is span-derived and not index-derived
 *
 * The index states a period as a WORD. The document states it as two dates.
 * Only one of those can be checked against the numbers it labels, and they do
 * not always mean the same thing — NSE flags every `period=Annual` record
 * `cumulative: "Cumulative"` (1,539 of 1,539 in May-2019), which is true of a
 * financial year in the sense that it accumulates four quarters, and false in
 * the sense this codebase needs. See below.
 *
 * ## The bands, and why there are GAPS between them
 *
 * `days` follows {@link XbrlPeriod}'s convention — start-inclusive,
 * end-exclusive — so a full financial year is **364-366 days, not 365**
 * (2018-04-01 → 2019-03-31 is 364). Measured spans from real filings:
 *
 *     quarter        89 / 90 / 91 / 92
 *     half-year     180 - 183
 *     nine months   272 - 275
 *     year          364 - 366   (371 for a 53-week filer)
 *
 * Anything OUTSIDE a band returns `null` and the caller must count it rather
 * than store it. That is a deliberate change from the previous
 * `>=300 ? ANNUAL : >=150 ? HALF_YEARLY : QUARTERLY` ladder, which had no gaps
 * and therefore no way to say "I do not recognise this":
 *
 *   - a 274-day nine-month year-to-date column scored `>=150` and was stored as
 *     **HALF_YEARLY** — a nine-month figure labelled six months, in a table
 *     whose unique key would then treat it as the incumbent for that period;
 *   - a 14-month transition year (companies changing financial year-end file
 *     them) scored `>=300` and became an **ANNUAL** row whose ratios are
 *     computed over 425 days of trading;
 *   - a 40-day stub period became a **QUARTERLY** row.
 *
 * None of those three produced an error, a log line, or a counter. A gap does.
 *
 * ## `cumulative` means "a PARTIAL accumulation", not NSE's "accumulated"
 *
 * The two words diverge on exactly one case and it is the important one: a
 * complete financial year. NSE says `Cumulative` because the column adds up
 * four quarters; we store `false` because **a full financial year IS the
 * period its row claims to cover**, and the flag's job here is to warn a reader
 * that a row covers less than its `periodType` implies.
 *
 * This is not cosmetic. `cumulative` is part of `XbrlFiling`'s unique key
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)`. Two writers
 * disagreeing about it do not conflict — they produce TWO annual rows for the
 * same company and year, differing in a boolean, and every consumer picks one
 * arbitrarily. So this function is the single place that decides, and both the
 * ingest leg and the annual leg call it.
 *
 * (The flag carries no key-disambiguating load of its own: the quarter, the H1,
 * the 9M and the FY that share a `periodEnd` already differ in `periodType`.
 * It is a label, and its only failure mode is being written inconsistently.)
 */
export interface FilingPeriodClass {
  periodType: FilingPeriodType;
  cumulative: boolean;
}

export function classifyFilingPeriod(days: number): FilingPeriodClass | null {
  // Non-finite reaches here as a `days` computed from an Invalid Date. It must
  // not fall through to a band comparison, which `NaN` loses silently.
  if (!Number.isFinite(days)) return null;
  if (days >= 85 && days <= 95) {
    return { periodType: "QUARTERLY", cumulative: false };
  }
  if (days >= 175 && days <= 190) {
    // The first half of a financial year, reported as a running total. Indian
    // filers publish H1 as year-to-date; the discrete second half is not a
    // column NSE indexes.
    return { periodType: "HALF_YEARLY", cumulative: true };
  }
  if (days >= 265 && days <= 285) {
    return { periodType: "NINE_MONTH", cumulative: true };
  }
  if (days >= 355 && days <= 380) {
    return { periodType: "ANNUAL", cumulative: false };
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * NSE's `DD-Mon-YYYY[ HH:MM[:SS]]` → UTC-midnight (dates) or exact instant.
 *
 * REJECTS rather than coerces. `new Date("31-DEC-2025")` is engine-dependent
 * and `new Date(undefined)` yields an Invalid Date that poisons every
 * downstream comparison silently.
 *
 * The round trip is load-bearing: `Date.UTC(2026, 1, 30)` cheerfully returns
 * 2 March rather than failing, so range-checking the digits does not reject an
 * impossible calendar day.
 */
export function parseNseIndexDate(
  v: unknown,
  opts?: { withTime?: boolean },
): Date | null {
  const s = str(v);
  if (s === null) return null;
  const m =
    /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      s,
    );
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]!.toLowerCase()];
  const year = Number(m[3]);
  if (mon === undefined) return null;

  const useTime = opts?.withTime === true && m[4] !== undefined;
  const d = new Date(
    Date.UTC(
      year,
      mon,
      day,
      useTime ? Number(m[4]) : 0,
      useTime ? Number(m[5]) : 0,
      useTime && m[6] !== undefined ? Number(m[6]) : 0,
    ),
  );
  if (Number.isNaN(d.getTime())) return null;
  // Round trip — the only thing that rejects 31-Feb.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mon) return null;
  if (d.getUTCDate() !== day) return null;
  return d;
}

// ─── Normalisation ───────────────────────────────────────────────────

function normaliseLegacy(
  rec: Record<string, unknown>,
): FilingIndexEntry | null {
  const symbol = str(rec.symbol)?.toUpperCase();
  if (!symbol) return null;
  if (!hasXbrlDocument(rec.xbrl)) return null;
  return {
    era: "legacy",
    symbol,
    isin: str(rec.isin),
    // TRIMMED: hasXbrlDocument validates the trimmed value, so storing the raw
    // one would persist a URL that passed validation and cannot be fetched.
    xbrlUrl: rec.xbrl.trim(),
    ixbrlUrl: null,
    basis: parseBasis(rec.consolidated),
    audited: parseAudited(rec.audited),
    cumulative: parseCumulative(rec.cumulative),
    periodType: parsePeriodType(rec.period),
    filerKind: parseFilerKind(rec.bank),
    // The legacy index states the period as a from/to pair rather than a
    // quarter-end. `toDate` is the period end.
    quarterEnd: parseNseIndexDate(rec.toDate),
    broadcastAt: parseNseIndexDate(rec.broadCastDate, { withTime: true }),
    companyName: str(rec.companyName) ?? "",
    // MONEY-1235. The legacy index states no revision status and no row
    // creation time — see `parseRevisionKind` for why `reInd` and `oldNewFlag`
    // are NOT those things. `seqNumber` is the only ordering signal it has.
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: parseIndexSequence(rec.seqNumber),
  };
}

function normaliseIntegrated(
  rec: Record<string, unknown>,
): FilingIndexEntry | null {
  const symbol = str(rec.symbol)?.toUpperCase();
  if (!symbol) return null;
  if (!hasXbrlDocument(rec.xbrl)) return null;
  return {
    era: "integrated",
    symbol,
    // The modern index has NO isin field. null, not "".
    isin: null,
    xbrlUrl: rec.xbrl.trim(),
    ixbrlUrl: str(rec.ixbrl),
    basis: parseBasis(rec.consolidated),
    audited: parseAudited(rec.audited),
    // Neither of these exists on a modern record. Explicitly null so a caller
    // cannot mistake an absent field for a stated `false`.
    cumulative: null,
    periodType: null,
    // The modern index carries no `bank` field either; the filer class is
    // recoverable from the XBRL filename prefix (BANKING_ / INDAS_) and is
    // resolved by the document parser, not guessed here.
    filerKind: "GENERIC",
    quarterEnd: parseNseIndexDate(rec.qe_Date),
    broadcastAt: parseNseIndexDate(rec.broadcast_Date, { withTime: true }),
    companyName: str(rec.cmName) ?? str(rec.smName) ?? "",
    // MONEY-1235 — the four fields the modern index has always carried and this
    // parser has always thrown away. `revised_Date` arrives UPPER-CASED
    // ("14-FEB-2026 23:24:28") where `creation_Date` is title-cased
    // ("14-Feb-2026 23:24:33"); `parseNseIndexDate` lower-cases the month before
    // the lookup, so both parse — that asymmetry is exactly the kind of thing a
    // month-name `switch` on the served casing would have silently dropped.
    revisionKind: parseRevisionKind(rec.type_Sub),
    revisedAt: parseNseIndexDate(rec.revised_Date, { withTime: true }),
    createdAt: parseNseIndexDate(rec.creation_Date, { withTime: true }),
    indexSequence: parseIndexSequence(rec.seq_Id),
  };
}

/**
 * Pull the record array out of a response.
 *
 * Accepts a bare array AND a `{data: [...]}` wrapper because BOTH are served:
 * the legacy index returns a bare array, and other NSE endpoints in this same
 * family wrap. Assuming one shape yields zero records from a perfectly good
 * 200, which reads as "a quiet week".
 *
 * Returns `null` — not `[]` — when the payload is neither. A failed read and an
 * empty window must never be the same value.
 */
interface ExtractedPayload {
  records: Record<string, unknown>[];
  /** The server's own `totalCount`, when the envelope carries one. */
  total: number | null;
  /** The server's own `size`, i.e. the page size it actually applied. */
  serverPageSize: number | null;
}

function finiteInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : null;
}

function extractPayload(payload: unknown): ExtractedPayload | null {
  if (Array.isArray(payload)) {
    // The legacy index. A bare array — no envelope, so no counts to read.
    return {
      records: payload.filter(isRecord),
      total: null,
      serverPageSize: null,
    };
  }
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return {
      records: payload.data.filter(isRecord),
      // The whole point of keeping the envelope. `page` is deliberately not
      // read: the modern index returns `page: -1` when none was requested,
      // which is a sentinel rather than a page number and has no use here.
      total: finiteInt(payload.totalCount),
      serverPageSize: finiteInt(payload.size),
    };
  }
  return null;
}

/**
 * Parse one page of either index.
 *
 * `null` = unrecognised payload. A page with `entries: []` and `listed: 0` is a
 * successful read of an empty window. Those are different, and every caller in
 * this repo that conflated them eventually shipped a silent no-op.
 */
export function parseFilingIndexPage(
  payload: unknown,
  era: FilingIndexEra,
): FilingIndexPage | null {
  const extracted = extractPayload(payload);
  if (extracted === null) return null;
  const { records } = extracted;

  const entries: FilingIndexEntry[] = [];
  const rejected: RejectedFilingRecord[] = [];
  let stubbed = 0;

  for (const rec of records) {
    const symbol = str(rec.symbol);
    if (!symbol) {
      rejected.push({
        reason: "NO_SYMBOL",
        symbol: null,
        rawXbrl: str(rec.xbrl),
      });
      continue;
    }
    if (!hasXbrlDocument(rec.xbrl)) {
      // Not an error — see FilingIndexPage.stubbed.
      stubbed++;
      continue;
    }
    const entry =
      era === "legacy" ? normaliseLegacy(rec) : normaliseIntegrated(rec);
    if (entry === null) {
      rejected.push({
        reason: "UNRECOGNISED_SHAPE",
        symbol,
        rawXbrl: str(rec.xbrl),
      });
      continue;
    }
    entries.push(entry);
  }

  return {
    era,
    entries,
    rejected,
    listed: records.length,
    stubbed,
    total: extracted.total,
    serverPageSize: extracted.serverPageSize,
  };
}

/**
 * Distinct broadcast DAYS in a page, nulls skipped.
 *
 * Exported, and owned here rather than left to the caller, because getting it
 * wrong silently disables the truncation guard. On the real capped response 3 of
 * 20 records are `type_Sub: "Revision"` and carry `broadcast_Date: null` (they
 * have `revised_Date` instead). The natural call site —
 * `new Set(entries.map(e => e.broadcastAt))` — therefore counts 3 buckets where
 * there are 2 real days, the `distinctDays <= 2` test misses, and the API's
 * single most dangerous property goes undetected.
 *
 * That is a 2-versus-3 judgement no caller should have to make twice.
 */
export function distinctBroadcastDays(page: FilingIndexPage): number {
  const days = new Set<string>();
  for (const e of page.entries) {
    if (e.broadcastAt === null) continue;
    days.add(e.broadcastAt.toISOString().slice(0, 10));
  }
  return days.size;
}

// ─── Truncation ──────────────────────────────────────────────────────

export interface TruncationVerdict {
  truncated: boolean;
  /** Human-readable why, for the log line. Empty when not truncated. */
  reason: string;
}

/**
 * Did this page get silently capped?
 *
 * The count alone cannot answer it: a page of exactly `pageSize` records is
 * equally consistent with "capped" and "there were exactly that many". So this
 * also looks at the STRUCTURAL signature of a newest-N cap — every record
 * landing on the last day or two of a multi-day window, when the window is wide
 * enough that filings should be spread across it.
 *
 * Errs toward reporting truncation. A false positive costs one extra paged
 * request; a false negative costs the filings, silently, forever.
 *
 * Four rules, checked in this order — exact signal first, catch-all last:
 *   1. the server's own `totalCount` vs what the walk has collected
 *   2. a page that came back exactly `pageSize` long
 *   3. the structural newest-N fingerprint (the LEGACY index's only defence)
 *   4. MONEY-1235 — on the MODERN era, an ABSENT envelope, which is not a
 *      truncation cause but a statement that rule 1 has stopped working
 */
export function detectTruncation(
  page: FilingIndexPage,
  opts: {
    pageSize: number;
    windowDays: number;
    /**
     * Distinct broadcast days in the page. OPTIONAL — omit it and
     * `distinctBroadcastDays` is used, which is the correct computation and the
     * one you want. Pass it only when you have already computed it.
     */
    distinctDays?: number;
    /**
     * Records collected across EVERY page of this query so far, INCLUDING this
     * one. Omit it on a single-page read and this page's own `listed` is used,
     * which is what the pre-MONEY-1114 behaviour was.
     *
     * ## Why this had to exist — the warning that cried wolf
     *
     * `totalCount` describes the QUERY. `listed` describes the PAGE. Comparing
     * them is only meaningful on the first page, and the caller pages until it
     * gets a SHORT one — so the comparison that decided the verdict was always
     * made on the last page, where a short page is the expected, healthy end of
     * a complete walk.
     *
     * Measured on the live nightly window (12-08-2026 → 19-08-2026):
     * `totalCount` 1,446 at `size` 500, so pages of 500 / 500 / 446. The walk
     * is COMPLETE, and the final page reported "the server reports
     * totalCount=1446 but returned 446". That is why every nightly prod run
     * printed `INDEX MAY BE TRUNCATED — the coverage below is a FLOOR, not a
     * count`: not a cap, an arithmetic error in the detector.
     *
     * A truncation warning that fires on every healthy run is worse than none,
     * because the run where the index really is capped looks identical.
     */
    collected?: number;
  },
): TruncationVerdict {
  // ── 1. The server's own count, when it gives one. Exact, so it goes first.
  //
  // The modern index reports `totalCount` beside the records it actually
  // returned. Nothing inferred from shape can beat "you received 20 of 7091",
  // and reaching for a heuristic while this sits unread in the envelope is the
  // mistake an earlier version of this module made.
  //
  // Compared against what the WALK has collected, not against this page — see
  // `collected`. A short last page of a fully-paged query is complete.
  const collected = opts.collected ?? page.listed;
  if (page.total !== null && collected < page.total) {
    return {
      truncated: true,
      reason:
        `the server reports totalCount=${page.total} but the walk has ` +
        `${collected}${page.serverPageSize !== null ? ` (size=${page.serverPageSize})` : ""}` +
        ` — page for the rest`,
    };
  }

  // ── 2. A full page means there is probably more. Normal, and why we page.
  if (page.listed >= opts.pageSize) {
    return {
      truncated: true,
      reason:
        `page returned exactly the requested size (${page.listed}), so there ` +
        `are almost certainly more — request the next page`,
    };
  }

  // ── 3. The structural fallback, for the LEGACY index, which has no envelope.
  //
  // A wide window whose records all land on one or two days is the fingerprint
  // of a newest-N cap, even when the count is under the requested size (the
  // DEFAULT cap applies when `size` is not sent at all).
  //
  // Skipped when the server DID report a total and we matched it: an exact
  // signal that says "complete" must not be overridden by an inference. A quiet
  // fortnight legitimately produces a handful of filings on one day.
  const serverSaysComplete = page.total !== null && collected >= page.total;
  const distinctDays = opts.distinctDays ?? distinctBroadcastDays(page);
  if (
    !serverSaysComplete &&
    opts.windowDays >= 5 &&
    page.listed > 0 &&
    distinctDays <= 2
  ) {
    return {
      truncated: true,
      reason:
        `${page.listed} records over a ${opts.windowDays}-day window all land ` +
        `on ${distinctDays} day(s) — the signature of a newest-N cap, ` +
        `not of a quiet period`,
    };
  }

  // ── 4. MODERN ERA ONLY: a missing envelope is itself the finding — MONEY-1235.
  //
  // Rules 1-3 leave two residual holes, and BOTH need `totalCount` to be absent:
  //
  //   (a) a capped response with no envelope whose records happen to span >= 3
  //       distinct days passes rule 1 (no total), rule 2 (listed < pageSize once
  //       we ask for 500) and rule 3 (distinctDays > 2). Nothing is left.
  //   (b) any window < 5 days disables rule 3 outright, so a capped short window
  //       has only rules 1 and 2, and rule 1 is the one that is missing.
  //
  // On the LEGACY index that state is NORMAL — it serves a bare array, has no
  // envelope at all, and rule 3 is the only defence it was ever going to have.
  // On the MODERN index it is not normal: every capture in this repo's fixtures
  // (5 files, 61 records) carries `{data, size, page, totalCount}`, and the
  // whole 20-record-cap defence rests on reading it. An envelope that stops
  // arriving means the response SHAPE changed under us, and the failure mode is
  // the dangerous direction — a shape change reads as "no truncation" and the
  // job reports a tidy, complete-looking number.
  //
  // Last, deliberately: rules 1-3 name a specific cause and are strictly more
  // useful than "shape changed". This is the catch-all under them.
  if (page.era === "integrated" && page.total === null) {
    return {
      truncated: true,
      reason:
        `the modern index returned ${page.listed} records with NO totalCount ` +
        `envelope — every capture of this endpoint carries one, so the ` +
        `response shape has changed and the 20-record cap can no longer be ` +
        `detected. Treat the count as a FLOOR`,
    };
  }
  return { truncated: false, reason: "" };
}

/**
 * Which index serves a given date.
 *
 * SEBI's integrated filing took effect for the quarter ending Dec-2024, whose
 * filings were broadcast from January 2025. Measured, the legacy index's last
 * dense month is Dec-2024 and the modern index covers 2025 onward.
 *
 * The boundary is a JUDGEMENT, not a certainty, which is why the backfill
 * walks BOTH indexes across 2024-10 → 2025-06 rather than switching hard: the
 * upsert key makes an overlap free, and a gap at the seam would be invisible.
 */
export const INTEGRATED_FILING_ERA_START = Date.UTC(2025, 0, 1);

export function eraForDate(d: Date): FilingIndexEra {
  return d.getTime() >= INTEGRATED_FILING_ERA_START ? "integrated" : "legacy";
}
