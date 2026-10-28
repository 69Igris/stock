/**
 * Resolving an AMC's monthly portfolio file by SCRAPING the page that links it.
 *
 * MONEY-1105 (Data Engine P8a), second resolver. Pure: HTML in, links out. No
 * fetching, no I/O, no Prisma — the worker owns all of that, exactly as
 * `amc-portfolio-sources.ts` owns URL construction and nothing else.
 *
 * ## Why a second resolver rather than more rows in the first one
 *
 * `amc-portfolio-sources.ts` templates a URL from a month. That works for three
 * AMCs (SBI, Nippon, HDFC — roughly 35% of industry AUM) and is *structurally
 * impossible* for the houses here:
 *
 *   DSP          every file sits under a random `<hash>-<epoch>/` directory
 *                (`.../081d3fbd38-1786372968/monthend-portfolios_31_july_2026.zip`).
 *                The hash is per-file and unguessable. There is no template.
 *   Old Bridge   Strapi stamps a random 10-hex suffix into the FILENAME itself
 *                (`..._ca0b230896.xlsx`). Same problem, one level lower.
 *   Capitalmind  ditto.
 *   PPFAS        the extension flips `.xls` -> `.xlsx` PER SCHEME mid-2026.
 *   Groww        `Jun 30, 2025` vs `June 30, 2026` vs `July 31 2026` — the month
 *                abbreviation, the day, and the comma all move independently.
 *
 * So the two tables are disjoint by construction: an AMC is either templatable
 * or scrapeable, never listed in both, and which table it appears in is what
 * decides which resolver runs. That is also why `AmcPageScrapeId` is its own
 * union rather than an extension of `AmcId` — no AMC belongs to both sets.
 *
 * ## The rule this module exists to obey
 *
 * **A guessed URL is worse than none.** A wrong URL 404s identically to "not
 * published yet", so it reports zero forever while every log line reads as
 * success. `provenance` therefore means exactly what it means next door, and
 * `verified` here is the strongest available claim: the link THIS RESOLVER PICKS
 * for a stated month was fetched and came back a real workbook.
 *
 * ## What was measured, 2026-08-14, from this machine
 *
 * Each row is the file `pickLinkForMonth(..., July-2026)` selects, fetched once:
 *
 *   DSP          200  application/zip                    1,167,224 B  PK, 2 xlsx inside
 *   PPFAS        200  application/vnd.ms-excel             407,676 B  PK (OOXML — see below)
 *   Tata         200  …spreadsheetml.sheet               1,760,778 B  PK, 140 parts
 *   Zerodha      200  …spreadsheetml.sheet                 133,897 B  PK  (ZSLVR)
 *   Groww        200  …spreadsheetml.sheet               3,553,362 B  PK, 127 parts
 *   Old Bridge   200  …spreadsheetml.sheet                 128,903 B  PK  (Focused Fund)
 *   Capitalmind  200  …spreadsheetml.sheet                 155,519 B  PK  (CMFLEXI)
 *
 * ...and the five added by the breadth pass, measured the same way, same day:
 *
 *   Mirae        200  …spreadsheetml.sheet                 355,800 B  PK  (MASCF)
 *   Baroda BNP   200  application/vnd.ms-excel          14,743,317 B  PK (OOXML — lies twice)
 *   Shriram      200  application/vnd.ms-excel             539,136 B  D0CF (a REAL OLE2 .xls)
 *   Helios       200  …spreadsheetml.sheet                 173,500 B  PK  (Flexi Cap)
 *   360 ONE      200  application/vnd.ms-excel             283,432 B  PK (OOXML — lies twice)
 *
 * Shriram is worth a second look: it is the ONLY one of the twelve whose `.xls`
 * is genuinely OLE2 (magic `D0CF`). Every other `.xls` here is a zip wearing the
 * wrong extension AND the wrong content-type. That is the whole argument for
 * sniffing magic bytes rather than believing either — a rule derived from
 * "they all lie" would have mis-read the one that does not.
 *
 * Two more things worth pinning:
 *
 *  - PPFAS serves `application/vnd.ms-excel` for a file whose bytes start `PK`
 *    and whose members are `xl/…` — i.e. an OOXML workbook wearing an `.xls`
 *    extension AND an `.xls` content-type. Both lie, exactly as Nippon's does.
 *    Never sniff the format from either; only the magic bytes are honest.
 *  - Old Bridge's *smallest* July-2026 file is 40,617 B (Flexi Cap), under the
 *    50 KB "is this really a workbook" bar. It is a genuine 3-sheet OOXML file;
 *    the house simply has three schemes. The bar was cleared on Focused Fund
 *    (128,903 B) and Arbitrage (163,653 B), which is what `verified` rests on.
 *    Recorded because a size threshold applied blind to a small AMC would have
 *    rejected a perfectly good feed.
 *
 * ## The actual hard part: telling MONTHLY from FORTNIGHTLY on the same page
 *
 * Every one of these seven pages publishes fortnightly and half-yearly
 * portfolios beside the monthly one, in near-identical filenames:
 *
 *   DSP          dsp-isin-debt-FORTNIGHTLY-portfolio-as-on-15-jul-2026.xlsx
 *                half-yearly-portfolio_march-2019.zip
 *   Zerodha      ZLIQD - Fortnightly Portfolio 15 July 2026.xlsx
 *   Groww        Fortnightly Portfolio- Jul 15, 2026.xlsx
 *   Capitalmind  CMLIQ_Fortnightly_Portfolio_DISCLOSRE_15th_Mar_2026.xlsx  (sic)
 *   Old Bridge   HY_OBMF_Portfolio_March26_….xlsx
 *
 * A resolver that matched `portfolio` and took the newest would ingest a
 * fortnightly snapshot as a month-end holding set — a wrong answer that parses
 * cleanly, stores cleanly and is invisible downstream. That is why each house
 * carries an explicit `exclude` list and why "no month could be identified"
 * returns `null` instead of the newest link.
 *
 * ## Why the period is read from the FILENAME only, never the path
 *
 * The path is where the noise lives, and each house's noise is different in kind.
 * DSP's directory is `081d3fbd38-1786372968` — a hex hash and a unix epoch, both
 * dense with digit runs. Groww's is `Portfolio/2026 -2027/`, a FINANCIAL year, so
 * a July-2026 file sits under a segment naming two calendar years. Tata's is
 * `system/files/2026-08/` for a JULY file — the publication month, the same
 * two-months-in-one-URL trap HDFC sets next door. Reading a year out of any of
 * those gives a confidently wrong period. Filename-only makes the class
 * impossible rather than merely unlikely.
 *
 * ## Why Strapi's hash must be stripped BEFORE reading a date
 *
 * Old Bridge and Capitalmind are Strapi sites: every upload gets `_<10 hex>`
 * appended to the stem. Hex digits are `[0-9a-f]`, so a hash can legitimately
 * contain the literal substring `dec` — and, being digits too, a 4-digit run in
 * 1990..2100. `_2050abcdef` parses as the year 2050 and `_2dec4b1a09` parses as
 * December. Neither raises anything. The suffix is therefore removed for those
 * two houses before any date parsing happens, which is a per-house `strapiHash`
 * flag rather than a global rule because stripping a trailing `_<hex>` from a
 * house that does not use Strapi would eat real filename content.
 *
 * ## Failure modes: `null` and `[]` are different answers
 *
 * `findMonthlyPortfolioLinks` returns `[]` for a page it read that had no
 * monthly-portfolio links — a real, successful, zero-row answer — and `null`
 * only for input that is not a page at all. Collapsing the two would make "the
 * AMC restructured its site" indistinguishable from "the AMC published nothing
 * this month", and the second is routine while the first is an outage. Same
 * discipline as `parseAmfiAmcRegistry`: make "we do not know" a distinct value.
 *
 * Likewise `pickLinkForMonth` returns `null` when the month resolves to ZERO
 * links *or* to MORE THAN ONE. An ambiguous month is not an invitation to pick
 * the first one, and the ambiguity is not hypothetical — measured over the seven
 * live pages on 2026-08-14 there are 15 such months:
 *
 *   Zerodha  13, all September 2025: every scheme is published TWICE, once as
 *            `… Sep 2025.xlsx` and once as `… Sept 2025.xlsx`.
 *   DSP       1, January 2016: `…_jan2016.zip` and `…_january2016.zip`.
 *   Capitalmind 1, November 2025: `Capitalmind_Monthly_Portfolio_Disclosure_Nov_2025`
 *            beside `Portfolio_Disclosure_30th_November_2025`.
 *
 * Nothing in the filenames says which of a pair is authoritative, so choosing
 * would be a guess wearing a result's clothing. `linksForMonth` returns both and
 * lets a caller that has more context decide.
 *
 * ## The OTHER way a month resolves to "more than one", which is NOT ambiguity
 *
 * Six of the twelve houses are `perScheme`, and for those a month legitimately
 * has one file PER SCHEME — 97 of them at Mirae, 22 at Zerodha. Calling
 * `pickLinkForMonth(links, month)` with the `scheme` argument omitted on such a
 * house is therefore null BY CONSTRUCTION, in every month, forever: "omitted"
 * means no filter, so every scheme's file matches and the count is never 1.
 *
 * That is not the same defect as a spelling collision and must not be fixed the
 * same way. The caller has to iterate the house's schemes (or pass `null` for
 * the combined workbook, where the house publishes one). It is written down here
 * because it has already been got wrong in production: a real
 * `mf-portfolio-sync` run on 2026-08-14 logged
 *
 *     no single link for this month { amc: 'ZERODHA', period: '2026-07', linksOnPage: 338 }
 *     no single link for this month { amc: 'PPFAS',   period: '2026-07', linksOnPage: 403 }
 *
 * for exactly this reason — hundreds of links found, the right month matched,
 * and no scheme asked for. `perScheme` on the config is what a caller must
 * branch on, and `schemesForMonth` below is what it iterates.
 */

import type { AmcId, AmcProvenance } from "./amc-portfolio-sources";
import { monthStart } from "./amc-portfolio-sources";

/**
 * The page-scrape houses.
 *
 * Deliberately NOT an extension of `AmcId` from `amc-portfolio-sources.ts`: the
 * two sets are disjoint (see the header), and a shared union would invite a
 * lookup that silently returns nothing because the AMC lives in the other table.
 */
/**
 * Deliberately a SUBSET of `AmcId` (amc-portfolio-sources.ts), not a parallel
 * vocabulary. A compile-time check at the bottom of this file enforces that —
 * without it the two could drift and one AMC would land in the database under
 * two different names.
 */
export type AmcPageScrapeId =
  | "ABSL"
  | "DSP"
  | "PPFAS"
  | "TATA"
  | "ZERODHA"
  | "GROWW"
  | "OLD_BRIDGE"
  | "CAPITALMIND"
  | "MIRAE"
  | "BARODA_BNP"
  | "SHRIRAM"
  | "HELIOS"
  | "THREE_SIXTY_ONE";

/**
 * How the year is spelled in this house's filenames.
 *
 * `four-digit` is the norm. `two-digit-follows-month` exists solely for Old
 * Bridge (`…_Portfolio_July_26_….xlsx`), where 26 is the YEAR and there is no
 * four-digit year anywhere in the name. A house on that rule still PREFERS a
 * four-digit year when one is present, so that the day-then-year spelling
 * (`March_31_2026`) cannot be misread as the year 2031 if Old Bridge ever
 * adopts it.
 */
export type AmcYearRule = "four-digit" | "two-digit-follows-month";

/**
 * Whether this house names the month in WORDS or in DIGITS.
 *
 * Eleven of the twelve write a month name — `july`, `Jul`, `Sept`, sometimes
 * glued straight to the year — and `month-name` is the whole of the rule for
 * them. Baroda BNP writes no month name anywhere:
 *
 *     BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls
 *
 * Under `month-name` that file dates to `null` and the house is unusable, since
 * it publishes exactly ONE monthly link at a time.
 *
 * `numeric-dmy` DECLARES the field order, which is the honest way to state
 * something the digits cannot always settle: `31-07-2026` is forced (there is no
 * 31st month) but a hypothetical `05-07-2026` is not, and no amount of parsing
 * makes it so. The declaration is backed by the observation that Baroda BNP's
 * disclosure is a MONTH-END file, so its day field is 28-31 in every month —
 * i.e. the ambiguous case does not arise for the file this house actually
 * publishes. A `numeric-dmy` house still falls through to the month-name rules
 * when it names no numeric date, so an older era spelled in words keeps working.
 */
export type AmcDateStyle = "month-name" | "numeric-dmy";

/**
 * What the "page" for this house actually is.
 *
 * Eleven serve HTML. Mirae serves JSON from an endpoint the site's own
 * `DownloadPortfolio.js` calls, and the links ride in it as `"URL":"/docs/…"` —
 * which the quoted-URL extractor already matches, since it never assumed
 * anchors. The only thing that had to change is the "is this a page at all"
 * check: a JSON body carries no tags, so the HTML test would have rejected a
 * perfectly good listing as "not a page".
 */
export type AmcBodyKind = "html" | "json";

/**
 * How the page must be REQUESTED. Data only — this module fetches nothing.
 *
 * Eleven houses are a plain GET, which is why `fetchText`-style callers have
 * worked so far without knowing this field existed. Mirae's listing endpoint is
 * POST-only and takes a JSON body naming the tab to list; a GET to the same URL
 * returns HTTP **200** with an error envelope (see `errorBody`).
 *
 * A caller that ignores this field therefore does not fail loudly on its own —
 * it gets a 200 — which is exactly why the failure is caught by `errorBody`
 * instead of being left to the transport.
 */
export interface AmcPageRequest {
  method: "GET" | "POST";
  /** Verbatim request body. Only meaningful for POST. */
  body?: string;
  /** Content-Type to send with `body`. */
  contentType?: string;
}

/** One monthly-portfolio link, as published. */
export interface ScrapedLink {
  /**
   * ABSOLUTE url, resolved against the page's own address. Never relative —
   * three of the seven houses publish `/uploads/…` or `/downloads/…` and a
   * caller that fetched those verbatim would hit its own host.
   */
  url: string;
  /**
   * The percent-DECODED final path segment, query stripped. This is the only
   * thing the period parser reads; see the header for why the path is excluded.
   */
  filename: string;
  /**
   * UTC midnight on the FIRST of the disclosure month — the same anchor
   * `monthStart` produces next door, so periods from either resolver compare.
   *
   * `null` when the filename does not identify a month unambiguously. That is a
   * real answer: the link is reported, and the caller can see it has no period,
   * rather than the link being dropped or dated by guesswork.
   */
  period: Date | null;
  /**
   * The scheme this file covers, lowercased, for houses that publish one file
   * per scheme; `null` when the file covers the whole AMC.
   *
   * Derived, not looked up: it is whatever survives in the filename BEFORE the
   * month token once the boilerplate is removed. That single rule handles all
   * seven houses (see `deriveScheme`), and `null` falls out naturally for the
   * whole-AMC files rather than being a special case.
   */
  scheme: string | null;
}

export interface AmcPageScraper {
  id: AmcPageScrapeId;
  name: string;
  /**
   * AMFI's own AMC id — the join key to `amfi-amc-registry`, mirroring the
   * field of the same name on `AmcSource`. Without it these seven houses are
   * invisible to `resolverCoverage()`, which would then under-report our
   * coverage of the 57-AMC universe by exactly the amount this file adds.
   */
  amfiMfId: string;
  /** The page whose SERVED bytes carry the links. No JavaScript needed on any of these. */
  pageUrl: string;
  /** How `pageUrl` must be requested. GET for all but Mirae. */
  pageRequest: AmcPageRequest;
  /** HTML for all but Mirae, whose listing endpoint answers with JSON. */
  bodyKind: AmcBodyKind;
  /**
   * Patterns that mean the body is an ERROR ENVELOPE rather than a listing.
   * A match makes `findMonthlyPortfolioLinks` return `null` (not a page),
   * never `[]` (a page with nothing on it).
   *
   * Empty for eleven of the twelve, and NOT ceremony for the twelfth. A GET to
   * Mirae's POST-only endpoint returns HTTP **200** with
   *
   *     {"Data":null,…,"ReturnCode":"9999","ReturnMsg":"Specified argument was
   *      out of the range of valid values.\r\nParameter name: name", …}
   *
   * — measured, 584 bytes. That parses as JSON and contains zero links, so
   * without this it reads as "Mirae published nothing this month": a successful,
   * zero-row answer, logged as such, forever. The whole point of separating
   * `null` from `[]` is lost the moment a 200-with-an-error-code lands on the
   * `[]` side.
   *
   * Same `g`-flag prohibition as `include`/`exclude`; the purity test covers
   * these too.
   */
  errorBody: readonly RegExp[];
  /**
   * A link's URL PATH must match at least one of these, when non-empty.
   *
   * This is the one place the path is consulted, and it is deliberately not the
   * place the period is read from (see the header for why that would be wrong on
   * at least three houses). Inclusion and dating are different questions: the
   * directory is often exactly what makes a file a portfolio file, while it is
   * never a reliable statement about WHICH MONTH.
   *
   * Empty for eleven houses, whose filenames carry a word to key on. Mirae's do
   * not — its files are `mascf-july2026.xlsx`, a scheme code and a date and
   * nothing else — so the only honest filter is the directory every one of its
   * 3,612 portfolio rows lives in.
   *
   * Matched against the still-percent-ENCODED pathname, lowercased.
   */
  pathInclude: readonly RegExp[];
  /**
   * A filename must match at least ONE of these to be a monthly-portfolio
   * candidate. May be empty ONLY when `pathInclude` is not — a house with
   * neither would accept every workbook on the page.
   *
   * NOTE: no `g` flag on any of these, anywhere. A `g` regex carries `lastIndex`
   * across `.test()` calls, so a shared module-level `/…/g` would return
   * different answers on alternate invocations — a purity break that looks like
   * flakiness. The purity test pins this.
   */
  include: readonly RegExp[];
  /** ...and must match NONE of these. This is what keeps fortnightly files out. */
  exclude: readonly RegExp[];
  /**
   * Hostnames in the listing that must be re-pointed at the page's own origin.
   *
   * Empty for twelve of the thirteen. ABSL's listing states every file on
   * `abcscprod.azureedge.net`, and **that host has no DNS record at all** —
   * Azure CDN `*.azureedge.net` was retired, so every published URL fails to
   * RESOLVE rather than 404ing. The same paths serve 200 from
   * `mutualfund.adityabirlacapital.com`, which is where the listing itself
   * comes from. Verified 2026-09-13: `dig` returns nothing for the CDN host,
   * and the re-based August-2026 URL returns 200 at 1,755,538 bytes.
   *
   * Only the HOST is replaced; the path and query are the publisher's. A
   * hostname not in this list is left exactly as published, so this can never
   * silently redirect a house that is working.
   */
  rebaseHosts: readonly string[];
  yearRule: AmcYearRule;
  dateStyle: AmcDateStyle;
  /** Strip Strapi's trailing `_<10 hex>` upload suffix before reading a date. */
  strapiHash: boolean;
  /**
   * House-specific words that are boilerplate rather than a scheme name — the
   * AMC's own name, mostly. Added to the shared list in `deriveScheme`.
   */
  schemeStopWords: readonly string[];
  /** True when the house publishes one file per scheme rather than one workbook. */
  perScheme: boolean;
  provenance: AmcProvenance;
  notes: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Filename -> period
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Month tokens, longest first.
 *
 * Ordering is belt-and-braces: the real protection is the non-LETTER boundary
 * check in `findMonths`, which already rejects `sep` inside `september` (the
 * next char is a letter) while accepting `march` inside `31march2026` (the
 * neighbours are digits). DSP genuinely publishes both spellings, sometimes with
 * no separator at all, so a `\b`-style word boundary would have missed
 * `feb2019`.
 */
const MONTH_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ["september", 8],
  ["february", 1],
  ["november", 10],
  ["december", 11],
  ["january", 0],
  ["october", 9],
  ["august", 7],
  ["april", 3],
  ["march", 2],
  ["sept", 8],
  ["june", 5],
  ["july", 6],
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
];

const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= "a" && ch <= "z";

const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= "0" && ch <= "9";

/** Where a month token sits. BOTH ends are needed and they are used differently. */
interface MonthHit {
  month: number;
  /** Index the token starts at — everything before it is scheme/boilerplate. */
  start: number;
  /** Index one past the token — where a trailing day or two-digit year begins. */
  end: number;
}

/**
 * Every DISTINCT month named in `text`.
 *
 * A token only counts when neither neighbour is a letter, which is what lets
 * `31march2026` and `feb2019` parse while `sep` inside `september` does not
 * double-count. Distinct is the operative word: a name that spelled the same
 * month twice would not be ambiguous, only repetitive.
 *
 * Both offsets are returned because the two consumers need opposite ends, and
 * conflating them was a real bug: `deriveScheme` slices everything BEFORE the
 * token, while the two-digit-year rule scans forward from AFTER it. Starting
 * that forward scan at `start` puts it on the token's own first letter, and the
 * "a letter here means these digits belong to something else" guard then
 * rejected every Old Bridge filename in the inventory.
 */
function findMonths(text: string): MonthHit[] {
  const found = new Map<number, MonthHit>();

  for (const [token, month] of MONTH_TOKENS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(token, from);
      if (at < 0) break;
      from = at + 1;

      if (isLetter(text[at - 1])) continue;
      if (isLetter(text[at + token.length])) continue;

      const existing = found.get(month);
      if (existing === undefined || at < existing.start) {
        found.set(month, { month, start: at, end: at + token.length });
      }
      // A longer token for this month starting at the same place has already
      // been recorded; keeping the earliest index makes the answer stable.
      break;
    }
  }

  return [...found.values()];
}

/**
 * Every DISTINCT plausible four-digit year, as an exactly-four-digit run.
 *
 * "Exactly four" is doing real work: DSP appends undelimited hashes
 * (`…october2014c083ceb8a31c664285b8ff02003db0a3.zip`), and a windowed `\d{4}`
 * scan would harvest `6642`, `4285` and friends out of the hex. Requiring the
 * run to be bounded by non-digits on both sides makes a 6-digit blob contribute
 * nothing at all, which is the correct reading.
 */
function findYears(text: string): number[] {
  const years = new Set<number>();

  for (let i = 0; i < text.length; i++) {
    if (!isDigit(text[i])) continue;
    let j = i;
    while (isDigit(text[j])) j++;
    if (j - i === 4) {
      const value = Number(text.slice(i, j));
      // 1990..2100 excludes day/amount runs while covering every disclosure any
      // of these houses has ever published (earliest observed: 2013).
      if (Number.isFinite(value) && value >= 1990 && value <= 2100) {
        years.add(value);
      }
    }
    i = j; // skip the whole run; never re-enter it at an offset
  }

  return [...years];
}

/**
 * A `dd-mm-yyyy` date written entirely in digits.
 *
 * Separators are limited to `- _ . /` and a space; a run with NO separator is
 * deliberately not matched, because `31072026` is indistinguishable from an
 * eight-digit document id and 360 ONE really does publish
 * `IN_MF_MONTHLY_PORTFOLIO_300923_….xlsx` — six digits that could be `30/09/23`
 * or could be a sequence number. Those stay `period: null`, which is the honest
 * answer, rather than being dated by a rule that cannot tell them apart.
 *
 * Both ends are bounded by non-digits so a longer run cannot donate a window:
 * without the trailing `(?!\d)` the id `19490` in Baroda BNP's own filename
 * could supply digits to a neighbouring match.
 */
const NUMERIC_DMY =
  /(?:^|[^0-9])(\d{1,2})[-_./ ](\d{1,2})[-_./ ](\d{4})(?![0-9])/;

/**
 * `DDMMYYYY` with NO separator at all — MONEY-1405 (ABSL).
 *
 * The paragraph above says a separator-less run is deliberately not matched,
 * and that stays true for SIX digits, which is the case it was written for
 * (360 ONE's `…_300923_…`, where `30/09/23` and a sequence number are
 * genuinely indistinguishable). EIGHT is a different question: the last four
 * must be a plausible YEAR, the first two a day 1-31 and the middle two a month
 * 1-12, and `findNumericDates` drops the run outright when any of the three
 * fails. That is three independent constraints, not a guess.
 *
 * It is needed because ABSL names two of its last twenty months this way —
 * `monthly-portfolio-31082026_abslmf.zip` (August 2026, the CURRENT month) and
 * `31052026_abslmf_monthly-portfolio.zip` — while the other eighteen spell the
 * month out. An undatable current month is an AMC that never ingests.
 *
 * Tried only when the separated form found nothing, so a house that writes both
 * cannot produce two hits from one date and read as a `conflict`. Both ends are
 * bounded by non-digits, so a 9-digit id can never donate an 8-digit window.
 */
const NUMERIC_DMY_COMPACT = /(?:^|[^0-9])(\d{2})(\d{2})(\d{4})(?![0-9])/;

/** A numeric date and where its digits START (not where the separator did). */
interface NumericHit {
  /** 1-31. */
  day: number;
  /** 0-11, so it composes with `MonthHit.month`. */
  month: number;
  year: number;
  start: number;
}

/**
 * Every plausible `dd-mm-yyyy` date in `text`.
 *
 * Implausible field values are DROPPED rather than clamped: a month of 13 or a
 * day of 45 means the run is not a date at all, and a clamped reading would file
 * a workbook under a month nobody published.
 */
function findNumericDates(text: string): NumericHit[] {
  const separated = scanNumericDates(text, NUMERIC_DMY);
  if (separated.length > 0) return separated;
  return scanNumericDates(text, NUMERIC_DMY_COMPACT);
}

function scanNumericDates(text: string, pattern: RegExp): NumericHit[] {
  const scanner = new RegExp(pattern.source, "g");
  const out: NumericHit[] = [];

  for (const m of text.matchAll(scanner)) {
    const dd = m[1];
    const mm = m[2];
    const yyyy = m[3];
    if (dd === undefined || mm === undefined || yyyy === undefined) continue;

    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    if (!Number.isFinite(month) || month < 1 || month > 12) continue;
    // Same window as `findYears`, for the same reason.
    if (!Number.isFinite(year) || year < 1990 || year > 2100) continue;

    // The pattern consumes one leading non-digit unless it matched at offset 0.
    // Derived from where the digits START rather than from the field widths, so
    // it is right for the separator-less form too (which has two fewer chars).
    const lead = m[0].search(/\d/);
    out.push({
      day,
      month: month - 1,
      year,
      start: (m.index ?? 0) + Math.max(lead, 0),
    });
  }

  return out;
}

/**
 * What a `numeric-dmy` house's filename says numerically.
 *
 * THREE outcomes, and collapsing the last two is a real bug rather than a
 * tidiness question. `none` means "no numeric date here, go and read the month
 * name" — which is what keeps an older era spelled in words working. `conflict`
 * means "this name makes claims that cannot both be true", and it must NOT fall
 * through to the month-name reader: `Monthly_Portfolio_June_31-07-2026` would
 * otherwise be filed under June on the strength of the half of the name that is
 * easier to parse. Same shape as picking the first of two links.
 */
type NumericReading =
  | { kind: "none" }
  | { kind: "one"; hit: NumericHit }
  | { kind: "conflict" };

const NO_NUMERIC: NumericReading = { kind: "none" };

/**
 * Read a numeric date, cross-checked against any month NAME in the same stem.
 *
 * The cross-check is not hypothetical caution: a `numeric-dmy` house is free to
 * publish `Portfolio_July_31-07-2026`, and the day a rename makes those two
 * disagree the file states two different months.
 */
function numericDateOf(stem: string, dateStyle: AmcDateStyle): NumericReading {
  if (dateStyle !== "numeric-dmy") return NO_NUMERIC;

  const hits = findNumericDates(stem);
  if (hits.length === 0) return NO_NUMERIC;
  if (hits.length > 1) return { kind: "conflict" };
  const hit = hits[0]!;

  const named = findMonths(stem);
  if (named.length > 1) return { kind: "conflict" };
  if (named.length === 1 && named[0]!.month !== hit.month) {
    return { kind: "conflict" };
  }

  return { kind: "one", hit };
}

/** Strapi's upload suffix: `_` + exactly 10 hex chars, immediately before the extension. */
const STRAPI_HASH = /_[0-9a-f]{10}$/;

/** The extensions that can only be a workbook or a container of one. */
const WORKBOOK_EXT = /\.(xlsx|xls|zip)$/i;

/** Filename with its extension and (for Strapi houses) its upload hash removed. */
function stemOf(filename: string, strapiHash: boolean): string {
  const lower = filename.toLowerCase();
  const withoutExt = lower.replace(WORKBOOK_EXT, "");
  return strapiHash ? withoutExt.replace(STRAPI_HASH, "") : withoutExt;
}

/**
 * The year, when a content hash has been appended to it with no separator.
 *
 * Both Tata and DSP have eras where the CMS glued a hash straight onto the
 * filename, producing digit runs that `findYears` correctly refuses:
 *
 *   monthly-portfolio-as-on-31-may-202018547fb5675f4cf188bebc0c610bd187.xls
 *   month_end_portfolio_disclosure_march-20144783ceb8a31c664285b8ff02003db0a3.zip
 *
 * The run is `202018547…` and `20144783…`; there is no four-digit run anywhere,
 * so those 9 files date to `null` and become invisible for backfill.
 *
 * This recovers them, and the reason it is safe is structural rather than
 * hopeful: the hash is APPENDED, so the year is necessarily the LEADING four
 * digits of the run. Three conditions keep it from ever firing on anything else:
 *
 *   1. it runs only when no clean four-digit year exists at all,
 *   2. the run must start IMMEDIATELY after the month token (separators only),
 *   3. the run must be longer than four digits — a run of exactly four is a
 *      clean year and would already have been found; a run of one or two is a
 *      day and must not be read as a year.
 *
 * Anything else stays `null`. A shorter or detached run is not evidence.
 */
function yearGluedToHash(stem: string, hit: MonthHit): number | null {
  let i = hit.end;
  while (i < stem.length && !isDigit(stem[i])) {
    if (isLetter(stem[i])) return null;
    i++;
  }
  let j = i;
  while (isDigit(stem[j])) j++;
  if (j - i <= 4) return null;

  const value = Number(stem.slice(i, i + 4));
  if (!Number.isFinite(value) || value < 1990 || value > 2100) return null;
  return value;
}

/**
 * The disclosure month a filename names, or `null` when it does not name one.
 *
 * `null` is returned — never a fallback, never the newest — whenever the answer
 * is not forced by the name:
 *   - no month token at all  (`Monthly_Portfolio_Final_1b3.xlsx` is real)
 *   - two different months   (nothing observed, but a rename could produce one)
 *   - no year, or two different four-digit years
 *
 * Exported because "what period does this filename claim" is the single
 * assertion worth making about a house, and a test that can only reach it
 * through the HTML extractor is testing two things at once.
 */
export function parsePeriodFromFilename(
  filename: string,
  cfg: Pick<AmcPageScraper, "yearRule" | "strapiHash"> & {
    /** Defaults to `month-name`, which is what eleven of the twelve houses use. */
    dateStyle?: AmcDateStyle;
  },
): Date | null {
  if (typeof filename !== "string" || filename.length === 0) return null;

  const stem = stemOf(filename, cfg.strapiHash);
  const dateStyle = cfg.dateStyle ?? "month-name";

  // An all-digits date, for the one house that names no month. Tried FIRST so
  // that the month-name path below stays exactly what it was for everyone else,
  // and falls through ONLY on `none` — an older era spelled in words is still
  // readable on a `numeric-dmy` house, while a name that contradicts itself
  // resolves to neither of its two readings.
  const numeric = numericDateOf(stem, dateStyle);
  if (numeric.kind === "conflict") return null;
  if (numeric.kind === "one") {
    return monthStart(
      new Date(Date.UTC(numeric.hit.year, numeric.hit.month, 1)),
    );
  }

  const months = findMonths(stem);
  if (months.length !== 1) return null;

  const hit = months[0]!;

  const years = findYears(stem);
  if (years.length === 1) {
    return monthStart(new Date(Date.UTC(years[0]!, hit.month, 1)));
  }
  // More than one distinct four-digit year is ambiguous under every rule.
  if (years.length > 1) return null;

  const glued = yearGluedToHash(stem, hit);
  if (glued !== null) {
    return monthStart(new Date(Date.UTC(glued, hit.month, 1)));
  }

  if (cfg.yearRule !== "two-digit-follows-month") return null;

  // Old Bridge only: the first numeric token AFTER the month is a two-digit
  // year (`…_July_26_…`). Anchored to the END of the month token rather than to
  // "the first number in the name", so a `2025-2026`-style prefix cannot supply
  // it. Reached only when no four-digit year exists, so a day-then-year spelling
  // (`March_31_2026`) is answered by the branch above and can never be read as
  // the year 2031.
  let i = hit.end;
  while (i < stem.length && !isDigit(stem[i])) {
    // Only separators may sit between the month and its year. A letter here
    // means the digits belong to some other token.
    if (isLetter(stem[i])) return null;
    i++;
  }
  let j = i;
  while (isDigit(stem[j])) j++;
  if (j - i !== 2) return null;

  const yy = Number(stem.slice(i, j));
  if (!Number.isFinite(yy)) return null;
  return monthStart(new Date(Date.UTC(2000 + yy, hit.month, 1)));
}

/**
 * The day-of-month a filename states, when it unambiguously states one.
 *
 * Only the token ADJACENT to the month counts (either side — houses spell it
 * both `15th_Mar_2026` and `June_15_2026`), and only when the name also carries
 * exactly one four-digit year. That second condition is what makes the answer
 * safe: with the year accounted for, a 1-2 digit neighbour of the month can only
 * be a day. Without it, `july-19` is unreadable — 19 could be a day or the year
 * 2019 — and this returns `null` rather than choosing.
 *
 * Returns `null` for the many names that state no day at all
 * (`ZSLVR - Monthly Portfolio July 2026`), which is not a defect: those are
 * month-granularity by construction.
 */
function statedDayOfMonth(
  stem: string,
  dateStyle: AmcDateStyle = "month-name",
): number | null {
  // A numeric date states its day outright, and it is the same single reading
  // the period came from — so the two can never disagree about the same file.
  // A contradictory name states no usable day either, and `null` here means
  // "no day stated", which `isMonthEndDay` treats as passing. That is the right
  // reading: the file has already failed to produce a period, so it can never
  // be selected for a month regardless of what this returns.
  const numeric = numericDateOf(stem, dateStyle);
  if (numeric.kind === "conflict") return null;
  if (numeric.kind === "one") return numeric.hit.day;

  const months = findMonths(stem);
  if (months.length !== 1) return null;
  if (findYears(stem).length !== 1) return null;

  const hit = months[0]!;

  const read = (from: number, step: -1 | 1): number | null => {
    let i = from;
    // Walk over separators only; a letter means the digits belong elsewhere.
    while (i >= 0 && i < stem.length && !isDigit(stem[i])) {
      if (isLetter(stem[i])) return null;
      i += step;
    }
    if (i < 0 || i >= stem.length) return null;
    let lo = i;
    let hi = i;
    while (lo > 0 && isDigit(stem[lo - 1])) lo--;
    while (isDigit(stem[hi + 1])) hi++;
    const run = hi - lo + 1;
    if (run !== 1 && run !== 2) return null;
    const value = Number(stem.slice(lo, hi + 1));
    return Number.isFinite(value) && value >= 1 && value <= 31 ? value : null;
  };

  // After the month first (`June_15_2026`), then before it (`15th_mar_2026`).
  return read(hit.end, 1) ?? read(hit.start - 1, -1);
}

/**
 * Is this filename a MONTH-END disclosure rather than a mid-month one?
 *
 * A month-end portfolio is dated the last day of the month, so a stated day
 * below 28 means the file is something else — in practice a fortnightly
 * snapshot. This is a second line of defence behind the per-house `exclude`
 * lists, and it is not redundant: Capitalmind's liquid scheme publishes
 * `CMLIQ_Portfolio_Disclosure_June_15_2026_….xlsx`, a fortnightly file that
 * never says "fortnightly" anywhere in its name. Without this rule it collided
 * with the genuine June month-end file and cost CMLIQ that month.
 *
 * Names that state no day pass, because most houses' month-end files state none.
 */
function isMonthEndDay(
  stem: string,
  dateStyle: AmcDateStyle = "month-name",
): boolean {
  const day = statedDayOfMonth(stem, dateStyle);
  return day === null || day >= 28;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Filename -> scheme
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Words that are never a scheme name.
 *
 * Everything here is publication boilerplate that appears BEFORE the month in at
 * least one house's filenames. `updated` and `final` are included even though
 * they usually trail the month, because they are equally not scheme names.
 */
const SCHEME_STOP_WORDS: ReadonlySet<string> = new Set([
  "month",
  "monthend",
  "monthly",
  "end",
  "portfolio",
  "portfolios",
  "disclosure",
  "disclosures",
  // Capitalmind ships `CMLIQ_Fortnightly_Portfolio_Disclosre_…` — the typo is
  // theirs and is kept here so the scheme token does not inherit it.
  "disclosre",
  "report",
  "reports",
  "statement",
  "scheme",
  "schemes",
  "as",
  "on",
  "of",
  "for",
  "the",
  "and",
  "final",
  "updated",
  "xls",
  "xlsx",
]);

const ORDINAL_ONLY = /^\d+(st|nd|rd|th)?$/;

/**
 * The scheme a filename is about, or `null` for a whole-AMC file.
 *
 * ONE rule for all seven houses: take everything before the month token, split
 * it into words, drop the boilerplate and any bare number/ordinal, and keep what
 * is left. Whole-AMC files leave nothing and correctly yield `null`:
 *
 *   Monthly Portfolio as on 31st July 2026     -> (nothing)  -> null
 *   monthend-portfolios_31_july_2026           -> (nothing)  -> null
 *   PPFAS_Monthly_Portfolio_Report_July_31_…   -> (nothing)  -> null   [ppfas is a house stop word]
 *   PPAF_PPFAS_Monthly_Portfolio_Report_April… -> "ppaf"
 *   ZSLVR - Monthly Portfolio July 2026        -> "zslvr"
 *   CMFLEXI_Monthly_Portfolio_Disclosure_July… -> "cmflexi"
 *   Old_Bridge_Flexi_Cap_Fund_Portfolio_July_26-> "flexi cap fund"
 *
 * A caveat worth stating rather than smoothing over: Old Bridge is not
 * self-consistent across months — `Monthly_Portfolio_AF_Dec25` uses the code
 * `AF` for the fund that `Arbitrage_Fund_Monthly_Portfolio_Nov_25` spells out.
 * So an Old Bridge scheme token is stable enough to disambiguate WITHIN a month
 * and must not be assumed stable ACROSS months. Mapping either spelling to a
 * scheme identity is the AMFI-name-matching problem and does not belong here.
 */
function deriveScheme(
  filename: string,
  cfg: Pick<AmcPageScraper, "strapiHash" | "schemeStopWords"> & {
    dateStyle?: AmcDateStyle;
  },
): string | null {
  const stem = stemOf(filename, cfg.strapiHash);

  // Whatever dated the file is also what the scheme name ends before, so the
  // two must be cut at the SAME token. Reading the period numerically while
  // still slicing at a month NAME would silently disagree on any house that has
  // both spellings.
  const numeric = numericDateOf(stem, cfg.dateStyle ?? "month-name");
  if (numeric.kind === "conflict") return null;
  let cut: number;
  if (numeric.kind === "one") {
    cut = numeric.hit.start;
  } else {
    const months = findMonths(stem);
    if (months.length !== 1) return null;
    cut = months[0]!.start;
  }

  const prefix = stem.slice(0, cut);

  const houseStops = new Set(cfg.schemeStopWords.map((w) => w.toLowerCase()));
  const words = prefix
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .filter((w) => !SCHEME_STOP_WORDS.has(w))
    .filter((w) => !houseStops.has(w))
    .filter((w) => !ORDINAL_ONLY.test(w));

  return words.length > 0 ? words.join(" ") : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * HTML -> links
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A quoted URL or root-relative path ending in a workbook extension.
 *
 * Deliberately NOT an `<a href>` parser. Three of the seven houses do not use
 * anchors at all:
 *
 *   Tata     an escaped JSON blob:  \"field_media_document\":\"https://…xlsx\"
 *   Zerodha  a JSON island:         "url":"https://…/ZSLVR - Monthly Portfolio July 2026.xlsx"
 *   Groww    anchors, but with `%20` and literal commas in the path
 *
 * Matching "quote, then a URL, then a quote" covers anchors, JSON, and Tata's
 * escaped JSON in one pass — no unescaping step is needed and no backslash is
 * ever rewritten (the mistake `amfi-amc-registry.ts` documents at length).
 *
 * The CLOSING delimiter must tolerate a preceding backslash and that is not
 * cosmetic: Tata's value ends `….xlsx\"`, so a lookahead for a bare quote sees
 * the backslash instead and fails. It failed silently, too — the house simply
 * returned zero links, which is indistinguishable from "Tata published nothing"
 * unless you already know the page has 98 of them.
 *
 * The character class excludes quotes and angle brackets — so a match cannot run
 * past its own attribute or across a tag — but ALLOWS spaces, because Zerodha's
 * URLs contain literal unencoded ones.
 *
 * Accepted prefixes are `https://`, `/`, `./` and `../`. All seven houses use
 * one of the first two today; the dot forms cost nothing and a house that
 * reorganises into year directories would otherwise start returning zero links
 * with no error. A BARE relative reference (`foo.xlsx`) is deliberately NOT
 * accepted — without a leading separator the pattern would match arbitrary text
 * inside inline scripts, and a false link is worse than a missed one here.
 *
 * No `g` flag on the module-level constant; `matchAll` gets a fresh cloned regex
 * per call so nothing carries `lastIndex` between invocations.
 */
const QUOTED_LINK =
  /["']((?:https?:\/\/|\.{0,2}\/)[^"'<>\\]*?\.(?:xlsx|xls|zip))((?:\?[^"'<>\\]*)?)(?=\\?["'])/i;

/**
 * Does this input look like a served listing at all?
 *
 * The distinction being protected is `null` (not a page) vs `[]` (a page with no
 * links). A workbook read as text, an empty string, or a JSON error envelope are
 * all "not a page"; a 3 KB HTML shell with no downloads is a page.
 *
 * `errorBody` is checked FIRST and for every house, because the shape it exists
 * to catch — HTTP 200 carrying an error code — is well-formed by construction
 * and would otherwise sail past whichever structural test came next.
 *
 * For a JSON house the structural test is only "parses, and is an object or
 * array". That is weaker than the HTML tag test on purpose: a bare
 * `"forbidden"` is valid JSON, so anything sharper would be guessing at the
 * shape of an error nobody has observed, while the one that HAS been observed is
 * named in `errorBody` where its evidence can be read.
 */
function looksLikeBody(
  input: string,
  cfg: Pick<AmcPageScraper, "bodyKind" | "errorBody">,
): boolean {
  if (input.length === 0) return false;
  // A NUL byte means binary — a workbook or a zip that reached us as text. Both
  // start `PK`, and a zip central directory is dense with `<` bytes, so the tag
  // check alone would occasionally mistake one for a page. Written as an escape:
  // a literal NUL in source makes grep call this file binary.
  if (input.includes("\u0000")) return false;
  if (cfg.errorBody.some((re) => re.test(input))) return false;

  if (cfg.bodyKind === "json") {
    const trimmed = input.trim();
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return false;
    try {
      const value: unknown = JSON.parse(trimmed);
      return typeof value === "object" && value !== null;
    } catch {
      return false;
    }
  }

  return /<[a-z!/][^>]*>/i.test(input);
}

/** Last path segment, percent-decoded, with any query already removed. */
function filenameOf(url: URL): string {
  const raw = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed `%` escapes: keep the raw segment rather than dropping the link.
    // A filename we cannot decode may still parse a period, and if it does not,
    // `period: null` reports that honestly.
    return raw;
  }
}

/**
 * Extract this house's monthly-portfolio links from its served HTML.
 *
 * Returns `[]` when the page was read and holds no monthly-portfolio links —
 * a real, successful, zero-row answer. Returns `null` ONLY when the input is not
 * a page. See the header for why those must not be the same value.
 *
 * Results are deduplicated by resolved URL, which matters: PPFAS publishes the
 * same file both as `/downloads/…` and as `https://amc.ppfas.com/downloads/…`,
 * and 32 of its 99 links are that one file counted twice.
 *
 * Source order is preserved. It carries no meaning on any of these pages — none
 * of them is reliably sorted — so nothing downstream may treat "first" or "last"
 * as "newest". `pickLinkForMonth` never uses position.
 */
export function findMonthlyPortfolioLinks(
  html: string,
  baseUrl: string,
  cfg: AmcPageScraper,
): ScrapedLink[] | null {
  if (typeof html !== "string" || !looksLikeBody(html, cfg)) return null;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // Without a usable base, every relative link would resolve wrong. Refusing is
    // the only honest answer; silently returning the absolute ones would report a
    // partial list as a complete one.
    return null;
  }

  const scanner = new RegExp(QUOTED_LINK.source, "gi");
  const seen = new Set<string>();
  const links: ScrapedLink[] = [];

  for (const match of html.matchAll(scanner)) {
    const href = match[1];
    const query = match[2] ?? "";
    if (href === undefined) continue;

    let resolved: URL;
    try {
      resolved = new URL(href + query, base);
    } catch {
      continue;
    }
    // `javascript:` and `data:` cannot appear given the pattern, but a caller
    // could pass an `ftp:` base; only http(s) is fetchable.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }

    // A DEAD host stated in the listing — see `rebaseHosts`. Re-pointed at the
    // page's own origin, path and query untouched.
    if (cfg.rebaseHosts.includes(resolved.hostname.toLowerCase())) {
      resolved = new URL(resolved.pathname + resolved.search, base);
    }

    const url = resolved.toString();
    if (seen.has(url)) continue;
    seen.add(url);

    // The ONLY use of the path, and deliberately not for dating (see header).
    if (
      cfg.pathInclude.length > 0 &&
      !cfg.pathInclude.some((re) => re.test(resolved.pathname.toLowerCase()))
    ) {
      continue;
    }

    const filename = filenameOf(resolved);
    const lower = filename.toLowerCase();

    if (cfg.include.length > 0 && !cfg.include.some((re) => re.test(lower))) {
      continue;
    }
    if (cfg.exclude.some((re) => re.test(lower))) continue;
    // The name-based excludes above cannot catch a fortnightly file that never
    // says so; the stated day can. Gated on `four-digit`, because on Old Bridge's
    // rule the digits beside the month ARE the year and would read as a day.
    if (
      cfg.yearRule === "four-digit" &&
      !isMonthEndDay(stemOf(filename, cfg.strapiHash), cfg.dateStyle)
    ) {
      continue;
    }

    links.push({
      url,
      filename,
      period: parsePeriodFromFilename(filename, cfg),
      scheme: deriveScheme(filename, cfg),
    });
  }

  return links;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Links -> the one for a month
 * ──────────────────────────────────────────────────────────────────────────── */

/** `true` when `d` is a usable Date. Guards `new Date("nonsense")` at the boundary. */
function isRealDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Every link for a month, optionally narrowed to one scheme.
 *
 * `scheme` has three distinct meanings and they are all load-bearing:
 *   omitted / `undefined` — no filter; every link for the month
 *   `null`                — ONLY whole-AMC files (a house that publishes both a
 *                           combined workbook and per-scheme files, like PPFAS,
 *                           needs this to reach the combined one)
 *   a string              — that scheme, compared case-insensitively
 *
 * An Invalid Date yields `[]` rather than throwing or matching everything.
 */
export function linksForMonth(
  links: readonly ScrapedLink[],
  month: Date,
  scheme?: string | null,
): ScrapedLink[] {
  if (!Array.isArray(links)) return [];
  if (!isRealDate(month)) return [];

  const target = monthStart(month).getTime();
  const wanted =
    typeof scheme === "string" ? scheme.trim().toLowerCase() : scheme;

  return links.filter((link) => {
    if (!isRealDate(link.period)) return false;
    if (link.period.getTime() !== target) return false;
    if (wanted === undefined) return true;
    if (wanted === null) return link.scheme === null;
    return link.scheme !== null && link.scheme.toLowerCase() === wanted;
  });
}

/**
 * THE link for a month, or `null`.
 *
 * `null` covers both "no link for that month" and "more than one", and it is
 * deliberate that those look the same to a caller: neither is a result, and
 * neither may be resolved by picking. The newest link is never a fallback — that
 * substitution is exactly how a fortnightly or a prior-month file gets stored as
 * this month's holdings while the log reads as success.
 *
 * Per-scheme houses must pass `scheme`; see `linksForMonth` for the three
 * meanings of that argument.
 */
export function pickLinkForMonth(
  links: readonly ScrapedLink[],
  month: Date,
  scheme?: string | null,
): ScrapedLink | null {
  const matches = linksForMonth(links, month, scheme);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Every scheme this month is published under, as `pickLinkForMonth` arguments.
 *
 * This exists so a caller can drive a `perScheme` house without inventing a
 * scheme list from somewhere else. `pickLinkForMonth(links, month)` with no
 * scheme is null on such a house in EVERY month by construction — six of the
 * twelve publish one file per scheme, up to 97 of them at Mirae — and a caller
 * that reads that null as "nothing published" is wrong every time. That is not a
 * hypothetical: it is the whole of the 2026-08-14 production log quoted in the
 * header.
 *
 * The values are exactly what `linksForMonth` compares against, INCLUDING the
 * `null` that means "the whole-AMC workbook" — so
 *
 *     for (const s of schemesForMonth(links, month)) pickLinkForMonth(links, month, s)
 *
 * reaches every file for the month, combined and per-scheme alike, and each pick
 * still returns null on a genuine spelling collision rather than guessing.
 *
 * Sorted for determinism, with the whole-AMC entry first because it is the one a
 * caller wanting a single workbook should try before fanning out. Duplicates are
 * collapsed: two files for one scheme in one month is ambiguity for
 * `pickLinkForMonth` to report, not a reason to iterate twice.
 */
export function schemesForMonth(
  links: readonly ScrapedLink[],
  month: Date,
): (string | null)[] {
  const seen = new Set<string | null>();
  for (const link of linksForMonth(links, month)) {
    seen.add(link.scheme === null ? null : link.scheme.toLowerCase());
  }
  const named = [...seen].filter((s): s is string => s !== null).sort();
  return seen.has(null) ? [null, ...named] : named;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The table
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Shared exclusions: the non-month-end disclosures every one of these pages mixes in.
 *
 * `hy` is Old Bridge's abbreviation for half-yearly and it is matched with an
 * explicit `[^a-z0-9]` on both sides rather than `\b`. That is not style: `_` is
 * a WORD character to JavaScript's regex engine, so `\bhy` never fires inside
 * `OBMF_HY_Portfolio_Sep_2024` — there is no boundary between `_` and `h`. The
 * `\b` version shipped in the first draft of this table and let exactly that
 * file through, dated and scheme-tagged, looking in every way like a September
 * month-end. `aum` gets the same treatment for the same reason.
 */
const NOT_MONTH_END: readonly RegExp[] = [
  /fortnight/,
  /half[\s_-]?year/,
  /(^|[^a-z0-9])hy([^a-z0-9])/,
  /quarter/,
  /annual/,
  /proxy/,
  /aaum/,
  /(^|[^a-z0-9])aum([^a-z0-9]|$)/,
];

export const AMC_PAGE_SCRAPERS: readonly AmcPageScraper[] = [
  {
    id: "ABSL",
    amfiMfId: "3",
    name: "Aditya Birla Sun Life Mutual Fund",
    // Sitecore. The `id` is the "Monthly Portfolio" accordion's ITEM ID, taken
    // from the portal page's own `data-accordian-api` attribute; `ctype` and
    // the two empty filter params are what the page's `resourceAccordianAjax`
    // (global.js) appends verbatim. `&year=0` is LOAD-BEARING: with `&year=`
    // the endpoint answers HTTP 500 wearing a 404 error page, which reads as a
    // wrong URL and is not.
    pageUrl:
      "https://mutualfund.adityabirlacapital.com/postlogin/CustomApi/Resources/" +
      "FactsheetAccordionById?id=3ccab227-9de5-4494-b78d-2b4f7c0c054a" +
      "&ctype=%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ" +
      "%2FCustomer%20Types%2FIndividual&month=%20&year=0",
    include: [/monthly[\s_-]?portfolio/, /monthly[\s_-]?disclosure/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    // Eighteen of the last twenty months name the month; TWO write a bare
    // `DDMMYYYY`, and one of those is the current month. See NUMERIC_DMY_COMPACT.
    dateStyle: "numeric-dmy",
    pageRequest: { method: "GET" },
    bodyKind: "json",
    // The endpoint answers 200 with `"ReturnCode":"1"` on success; its own JS
    // renders nothing for any other code, so anything else is an envelope and
    // not a listing.
    errorBody: [/"ReturnCode"\s*:\s*"(?!1")/],
    pathInclude: [],
    rebaseHosts: ["abcscprod.azureedge.net"],
    strapiHash: false,
    schemeStopWords: ["absl", "abslmf", "bsl", "sebi"],
    perScheme: false,
    provenance: "verified",
    notes:
      "MOVED HERE FROM `amc-portfolio-sources.ts` — MONEY-1405. Its row there " +
      "was `needs-discovery` because five spellings of July-2026 404'd beside a " +
      "June-2026 that served; the measurement was right and the conclusion was " +
      "the filename is genuinely AD-HOC. Across the last twenty months the " +
      "publisher has used at least seven conventions " +
      "(`sebi_monthly_portfolio-31-jan-2026`, `monthly-disclosure-april-30-2026`, " +
      "`absl_monthly_portfolio_report_july--2026`, " +
      "`monthly-portfolio-31082026_abslmf`), so no template can exist and the " +
      "link has to be read from the listing. " +
      "TWO TRAPS, both measured 2026-09-13. (1) `&year=0`, above. (2) THE " +
      "PUBLISHED HOST IS DEAD: every `pdfUrl` points at " +
      "`abcscprod.azureedge.net`, which has NO DNS RECORD — Azure CDN's " +
      "`*.azureedge.net` was retired — so a fetch fails to RESOLVE rather than " +
      "404ing, which reads as a network fault rather than a bad link. The same " +
      "paths serve from the AMC's own origin; `rebaseHosts` does that. " +
      "ONE zip per month wrapping ONE ~105-sheet OLE2 `.xls`, so the extension " +
      "lies in the opposite direction from Nippon's. Verified: August-2026, 200 " +
      "application/x-zip-compressed 1,755,538 bytes, 104 portfolio sheets, " +
      "as-on 2026-08-31 on all of them, 5,749 holdings, zero scale-suspect.",
  },
  {
    id: "DSP",
    amfiMfId: "6",
    name: "DSP Mutual Fund",
    pageUrl:
      "https://www.dspim.com/mandatory-disclosures/portfolio-disclosures",
    // `monthend` and `month_end` are DSP's two spellings of the same section.
    // Nothing else on the page uses either, so this is precise without being a
    // date match.
    include: [/month[\s_-]?end/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: false,
    schemeStopWords: ["dsp", "isin", "debt"],
    perScheme: false,
    provenance: "verified",
    notes:
      "ONE zip per month holding ISIN-level workbooks (July-2026: 2 members, " +
      "DSP ISIN DEBT + DSP Equity FOF). NEVER TEMPLATABLE — each file sits under " +
      "a per-file random `<hash>-<epoch>/` directory, which is the whole reason " +
      "this module exists. Filenames have drifted across at least six spellings " +
      "(`month_end_portfolio_disclosure_feb2019`, `monthend-portfolio-31march2026`, " +
      "`monthend-portfolios_31_july_2026`), including month glued to year with no " +
      "separator and an undelimited hex hash appended to the stem. The AMFI " +
      "registry link (`/about-us/mandatory-disclosure/portfolio-disclosures`) " +
      "302s to the path above; the old `/monthly-portfolio` slug 404s with a " +
      "284,839-byte HTML body, i.e. it looks like a page, not like an error. " +
      "Verified: July-2026 zip, 200 application/zip 1,167,224 B.",
  },
  {
    id: "PPFAS",
    amfiMfId: "64",
    name: "PPFAS Mutual Fund",
    pageUrl: "https://amc.ppfas.com/downloads/portfolio-disclosure/",
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: false,
    // `ppfas` is the AMC's own name; stripping it is what makes the combined
    // workbook `PPFAS_Monthly_Portfolio_Report_…` come out as scheme `null`
    // while `PPAF_PPFAS_Monthly_Portfolio_Report_…` comes out as `ppaf`.
    schemeStopWords: ["ppfas"],
    perScheme: true,
    provenance: "verified",
    notes:
      "BOTH shapes on one page: a combined `PPFAS_Monthly_Portfolio_Report_*` " +
      "(scheme `null`) and per-scheme `PP*_PPFAS_Monthly_Portfolio_Report_*`. " +
      "THE EXTENSION FLIP IS PER SCHEME, NOT PER DATE: for March-2026 onward the " +
      "per-scheme files are `.xlsx` while the combined file is STILL `.xls` in " +
      "July-2026 — so a rule of the form 'after month X it is .xlsx' is wrong for " +
      "the very file most callers want. Both extensions are matched instead. " +
      "The combined file is served as `application/vnd.ms-excel` but its bytes " +
      "are `PK` with `xl/` members: an OOXML workbook lying in BOTH its extension " +
      "and its content-type, exactly like Nippon's. Links appear twice, once " +
      "root-relative and once absolute (32 of 99), so dedup by resolved URL is " +
      "required. Verified: combined July-2026, 200 407,676 B, 15 parts.",
  },
  {
    id: "TATA",
    amfiMfId: "25",
    name: "Tata Mutual Fund",
    pageUrl: "https://www.tatamutualfund.com/schemes-related/portfolio",
    // TWO eras on one page: `portfolio-as-on-31st-july-2017.xls` (2013-2018) and
    // `Monthly Portfolio as on 31st July 2026.xlsx` (2019+). Both are the
    // month-end disclosure, so both are included.
    include: [/monthly[\s_-]?portfolio/, /^portfolio[\s_-]?as[\s_-]?on/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: false,
    schemeStopWords: ["tata", "mf", "revised", "format", "data"],
    perScheme: false,
    provenance: "verified",
    notes:
      "The AMFI registry link `/schemes-related` 302s; the real page is " +
      "`/schemes-related/portfolio`. Links ride in an ESCAPED JSON blob " +
      '(`\\"field_media_document\\":\\"https://…\\"`), not in anchors — which is ' +
      "why the extractor matches quoted URLs rather than `<a href>`. The " +
      "published host is `betacms.tatamutualfund.com`; `www` serves the identical " +
      "1,760,778 bytes for the same path, so the beta host is an alias and not a " +
      "staging leak, but the link is used as published. NOTE the path segment is " +
      "the PUBLICATION month (`2026-08`) while the filename is the DATA month " +
      "(July) — the same two-months-in-one-URL trap as HDFC, and the reason the " +
      "period is read from the filename only. Also present: `…as 31st October " +
      "2025.xlsx` (no 'on') and `…30th April 2026 (1).xlsx`. Verified: " +
      "July-2026, 200 spreadsheetml 1,760,778 B, 140 parts.",
  },
  {
    id: "ZERODHA",
    amfiMfId: "77",
    name: "Zerodha Mutual Fund",
    pageUrl: "https://www.zerodhafundhouse.com/resources/disclosures",
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: false,
    schemeStopWords: ["zerodha"],
    perScheme: true,
    provenance: "verified",
    notes:
      "One file per scheme, 22 scheme codes (ZSLVR, ZN250, ZLIQD, …), 338 " +
      'monthly links. Links ride in a JSON island as `"url":"…"` with LITERAL ' +
      "UNENCODED SPACES in the path — the reason the link pattern allows spaces " +
      "and only forbids quotes and angle brackets. Spelling is inconsistent in " +
      "two ways that both matter: the separator (`ZE500- Monthly` vs `ZSLVR - " +
      "Monthly`) and the month abbreviation (`Sep 2025` AND `Sept 2025` both " +
      "exist). Fortnightly files for the liquid/overnight schemes sit in the same " +
      "directory and are excluded by name. Verified: ZSLVR July-2026, 200 " +
      "spreadsheetml 133,897 B.",
  },
  {
    id: "GROWW",
    amfiMfId: "63",
    name: "Groww Mutual Fund",
    pageUrl: "https://growwmf.in/statutory-disclosure/portfolio",
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: false,
    schemeStopWords: ["groww"],
    perScheme: false,
    provenance: "verified",
    notes:
      "ONE combined workbook per month (July-2026: 127 parts). Fortnightly files " +
      "sit in the same directory with a near-identical name and outnumber the " +
      "monthly ones ~2:1, so the exclusion is what makes this house usable at " +
      "all. Day/month/comma all move independently across months — `Jun 30, " +
      "2025`, `Mar 31, 2026`, `July 31 2026`, `Oct 31 2025` — and the containing " +
      "directory is `Portfolio/2026 -2027/` (a FINANCIAL year, with a stray " +
      "space), which is the clearest example of why the period is never read " +
      "from the path. Verified: July-2026, 200 spreadsheetml 3,553,362 B.",
  },
  {
    id: "OLD_BRIDGE",
    amfiMfId: "78",
    name: "Old Bridge Mutual Fund",
    pageUrl: "https://oldbridgemf.com/statutory-disclosures.html",
    // NOT `monthly portfolio`: the July-2026 files are named
    // `Old_Bridge_Flexi_Cap_Fund_Portfolio_July_26_….xlsx` with no "Monthly" at
    // all, while November-2025's are `Arbitrage_Fund_Monthly_Portfolio_Nov_25`.
    // The word is optional here, so the exclusions carry the whole burden.
    include: [/portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "two-digit-follows-month",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: true,
    schemeStopWords: ["old", "bridge", "obmf"],
    perScheme: true,
    provenance: "verified",
    notes:
      "Strapi: every upload carries a random `_<10 hex>` suffix, so the URL is " +
      "unguessable AND the hash must be stripped before any date parsing — hex " +
      "is `[0-9a-f]`, so a hash can spell `dec` or contain a 4-digit run in the " +
      "year range. TWO-DIGIT YEAR with no four-digit year anywhere " +
      "(`…_Portfolio_July_26_…` is July 2026), the only house on that rule. " +
      "The scheme token is NOT stable across months: `Monthly_Portfolio_AF_Dec25` " +
      "abbreviates the fund that `Arbitrage_Fund_Monthly_Portfolio_Nov_25` spells " +
      "out. `Monthly_Portfolio_Final_….xlsx` names no month at all and correctly " +
      "yields `period: null`. Half-yearly files are abbreviated `HY` MID-NAME " +
      "(`OBMF_HY_Portfolio_Sep_2024_….xlsx`), which is why the shared exclusion " +
      "cannot use `\\b` — see NOT_MONTH_END. Smallest July-2026 file is 40,617 B (Flexi Cap) — " +
      "genuine 3-sheet OOXML, just a small AMC. Verified on Focused Fund " +
      "July-2026, 200 spreadsheetml 128,903 B.",
  },
  {
    id: "CAPITALMIND",
    amfiMfId: "81",
    name: "Capitalmind Mutual Fund",
    pageUrl: "https://capitalmindmf.com/statutory-disclosures.html",
    include: [/portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    strapiHash: true,
    schemeStopWords: ["capitalmind", "cmf"],
    perScheme: true,
    provenance: "verified",
    notes:
      "Strapi, same hash-strip requirement as Old Bridge, but a four-digit year " +
      "(`CMFLEXI_Monthly_Portfolio_Disclosure_July_31_2026_2dad58d22b.xlsx`) — so " +
      "the two Strapi houses do NOT share a date rule and cannot share a config. " +
      "Five scheme codes (CMFLEXI, CMLIQ, CMARB, CMMAAF, and a `Capitalmind_`- " +
      "prefixed variant of each). The liquid scheme publishes fortnightly files " +
      "spelled `Fortnightly_Portfolio_Disclosre` — their typo — which the " +
      "`fortnight` exclusion still catches, and which is why the exclusion " +
      "matches the stem rather than the exact word `disclosure`. TWO more shapes " +
      "matter: the liquid scheme's mid-month file is " +
      "`CMLIQ_Portfolio_Disclosure_June_15_2026_….xlsx`, which says NEITHER " +
      "'fortnightly' nor 'monthly' and is caught only by the stated-day rule — " +
      "without it, it collided with the genuine June month-end and cost CMLIQ " +
      "that month; and corrections are republished under a new name " +
      "(`CMFLEXI_Monthly_Portfolio_Disclosure_March_2026_1_Updated_….xlsx`), " +
      "which is currently the only March-2026 file and so unambiguous today. " +
      "November-2025 genuinely IS ambiguous: `Capitalmind_Monthly_Portfolio_" +
      "Disclosure_Nov_2025` and `Portfolio_Disclosure_30th_November_2025` are " +
      "both whole-AMC, so that month resolves to null by design. Verified: " +
      "CMFLEXI July-2026, 200 spreadsheetml 155,519 B.",
  },
  {
    id: "MIRAE",
    amfiMfId: "45",
    name: "Mirae Asset Mutual Fund",
    // NOT the human page (`/downloads/portfolio`, 143,803 B of HTML with zero
    // workbook links in it). This is the endpoint that page's own
    // `/DownloadPortfolio.js` calls, whose request shape is `pageRequest` below.
    pageUrl: "https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData",
    pageRequest: {
      method: "POST",
      // `modulename` is the tab id, read verbatim out of DownloadPortfolio.js
      // (`modulename="portfolio_tab1"`). `pgsize` is the whole point: the
      // default page is 25 rows out of 3,616, and the envelope's `DataCount`
      // is the only thing that says so.
      body: '{"request":{"modulename":"portfolio_tab1","pgno":1,"pgsize":5000}}',
      contentType: "application/json; charset=utf-8",
    },
    bodyKind: "json",
    // A GET to this POST-only endpoint answers 200 with `"ReturnCode":"9999"`
    // and `"Data":null`. Measured, 584 bytes. Without this the biggest AMC in
    // this table would report "published nothing" on every run that forgot to
    // POST — the exact failure `null`-vs-`[]` exists to make visible.
    errorBody: [/"ReturnCode"\s*:\s*"(?!0")/],
    rebaseHosts: [],
    // Mirae's filenames are a scheme code and a date and NOTHING else
    // (`mascf-july2026.xlsx`), so there is no word to key on and `include` is
    // empty. The directory is the honest filter: 3,612 of the endpoint's 3,616
    // rows live under it.
    pathInclude: [/\/docs\/default-source\/portfolios\//],
    include: [],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    strapiHash: false,
    schemeStopWords: ["mirae", "asset"],
    perScheme: true,
    provenance: "verified",
    notes:
      "A JSON API, not a page — the only one in this table. `POST " +
      "/AjaxService/GetDownloadsData` with `{request:{modulename:'portfolio_" +
      "tab1',pgno,pgsize}}` returns `{Data:[{Title,URL,PublishDate,…}], " +
      "DataCount:3616, ReturnCode:'0'}`. THE DEFAULT PAGE IS 25 ROWS: pgsize " +
      "must be sent, and `DataCount` is the only thing that reveals the " +
      "truncation — the same trap NSE's integrated-filing index sets. ONE FILE " +
      "PER SCHEME, 97 of them for July-2026, all distinct. Filenames carry no " +
      "word at all, just `<schemecode><sep><month><year>` — hence an empty " +
      "`include` and a `pathInclude` on the portfolios directory. TWO SCHEME " +
      "CODES BEGIN WITH `hy` (hybetf, hybif) and would be eaten by a looser " +
      "half-yearly exclusion than the one in NOT_MONTH_END, which requires a " +
      "non-alphanumeric after `hy` and so leaves them alone — worth knowing " +
      "before anyone relaxes that rule. Older eras: `macbf_dec2024.xlsx" +
      "?sfvrsn=…` (underscore + a query), `manbt_31aug2024` (day glued to " +
      "month), `maipf_sept2024` (the four-letter September again), and " +
      "`alphafof.xlsx` with no date at all, which correctly yields period null. " +
      "Verified: MASCF July-2026, 200 spreadsheetml 355,800 B.",
  },
  {
    id: "BARODA_BNP",
    amfiMfId: "4",
    name: "Baroda BNP Paribas Mutual Fund",
    pageUrl:
      "https://www.barodabnpparibasmf.in/downloads/monthly-portfolio-scheme",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    // The whole reason this axis exists — see AmcDateStyle.
    dateStyle: "numeric-dmy",
    strapiHash: false,
    schemeStopWords: ["bobbnpmf", "bnp", "paribas", "baroda"],
    perScheme: false,
    provenance: "verified",
    notes:
      "ONE combined workbook, and NO MONTH NAME ANYWHERE: " +
      "`BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls`. The trailing `19490` " +
      "is a CMS document id, not a date and not templatable, which is why this " +
      "house is here rather than next door. CURRENT MONTH ONLY — the page " +
      "carries exactly SIX workbook links in total (this file plus five " +
      "`YR5x_…` sheets that match no include rule), so there is no history to " +
      "backfill and a missed month may be unrecoverable: the SCHEDULE carries " +
      "the risk, as it does for Nippon. The file is 14,743,317 B, by far the " +
      "largest in this table, and is served as `application/vnd.ms-excel` while " +
      "its bytes start `PK` — an OOXML workbook lying in BOTH its extension and " +
      "its content-type. Verified: July-2026, 200, 14,743,317 B.",
  },
  {
    id: "SHRIRAM",
    amfiMfId: "67",
    name: "Shriram Mutual Fund",
    pageUrl: "https://www.shriramamc.in/investor-statutory-disclosures",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    strapiHash: false,
    schemeStopWords: ["shriram", "mutual", "fund", "mf", "new"],
    perScheme: false,
    provenance: "verified",
    notes:
      "One page carrying 2,593 workbook links, of which 153 are monthly " +
      "portfolios — the widest include/exclude gap in this table, and the " +
      "reason the include rule is the two-word phrase rather than `portfolio`. " +
      "The neighbours it has to reject are unusually dangerous: a DAILY debt " +
      "transaction file whose entire name is a date (`31st-July-2026.xls`), " +
      "`Shriram-MF-Average-AUM-Annexures-Jul-2026.xls`, and " +
      "`Weekly-Portfolio-Shriram-Mutual-Fund-07-August-2026.xlsx`. None matches " +
      "`monthly portfolio`; the daily one would have matched a bare `portfolio` " +
      "rule and dated cleanly to July 2026. TWO ERAS: through ~2018 one file " +
      "per scheme code (`Monthly-Portfolio-SHREDOF-APRIL-2015-NEW.xlsx`, " +
      "`…-SHEF-July-2018.xls`), and since then ONE combined workbook " +
      "(`Monthly-Portfolio-Shriram-Mutual-Fund-July-2026.xls`) — so `perScheme` " +
      "is false for the era anyone will actually fetch, and the old months " +
      "resolve per-scheme or report ambiguity, both correctly. THE ONLY `.xls` " +
      "IN THIS TABLE THAT IS REALLY OLE2 (magic D0CF); every other one is a zip " +
      "in disguise. Verified: July-2026, 200 539,136 B.",
  },
  {
    id: "HELIOS",
    amfiMfId: "76",
    name: "Helios Mutual Fund",
    pageUrl: "https://www.heliosmf.in/portfolio-disclosure/",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    strapiHash: false,
    schemeStopWords: ["helios", "mf"],
    perScheme: true,
    provenance: "verified",
    notes:
      "WordPress, so the file sits under its UPLOAD month " +
      "(`/wp-content/uploads/2026/08/` for a JULY file) — the publication-month " +
      "path trap that HDFC and Tata also set, and another reason the period is " +
      "read from the filename only. ONE FILE PER SCHEME, 8 of them for " +
      "July-2026, named " +
      "`helios-<scheme>-fund-monthly-portfolio-as-on-31st-july-2026.xlsx`. THE " +
      "OVERNIGHT FUND PUBLISHES A FORTNIGHTLY FILE DATED THE 31st " +
      "(`helios-overnight-fund-fortnightly-portfolio-as-on-31st-july-2026.xls`) " +
      "beside its genuine monthly one, so the stated-day rule does NOT separate " +
      "them and the `fortnight` exclusion is doing the whole job for that " +
      "scheme. Casing is not stable across months — 2026/08 uploads are " +
      "lowercase, earlier ones Title-Case — which costs nothing here because " +
      "every comparison lowercases, but would matter to anything keying on the " +
      "raw name. `Fortnightly-Portfolio-Helios-Overnight-Fund.xlsx` names no " +
      "date at all and is excluded before that can matter. Verified: Flexi Cap " +
      "July-2026, 200 spreadsheetml 173,500 B.",
  },
  {
    id: "THREE_SIXTY_ONE",
    amfiMfId: "62",
    name: "360 ONE Mutual Fund",
    pageUrl: "https://www.360.one/asset/mutual-funds/downloads/",
    pageRequest: { method: "GET" },
    bodyKind: "html",
    errorBody: [],
    rebaseHosts: [],
    pathInclude: [],
    include: [/monthly[\s_-]?portfolio/],
    exclude: NOT_MONTH_END,
    yearRule: "four-digit",
    dateStyle: "month-name",
    // Strapi's 10-hex suffix again, but served from S3 rather than the site —
    // the convention travels with the CMS, not with the host.
    strapiHash: true,
    schemeStopWords: [
      "360",
      "one",
      "in",
      "mf",
      "iiflamc",
      "iifl",
      "mutual",
      "funds",
      "web",
      "download",
      "online",
    ],
    perScheme: false,
    provenance: "verified",
    notes:
      "ONE combined workbook per month, on `s3.ap-south-1.amazonaws.com` under " +
      "the SAME Strapi `_<10 hex>` filename convention as Old Bridge and " +
      "Capitalmind — which is the N-for-1 worth knowing: the hash rule is a " +
      "property of the CMS and follows it onto a different host and a different " +
      "AMC. The house has been renamed twice and the filenames record it: " +
      "`IIFLAMC_IN_MF_MONTHLY_PORTFOLIO_…` (2018), `IN_MF_MONTHLY_PORTFOLIO_…` " +
      "(2019-), `360_ONE_MONTHLY_PORTFOLIO_…` (2023-24). Three date spellings " +
      "are UNREADABLE and correctly yield period null rather than a guess: " +
      "`…_300923_…` and `…_310823_…` (six digits that could be ddmmyy or a " +
      "sequence number, and no separators to say which), `…_April_18_…` (a " +
      "two-digit year on a four-digit house), and `…_AUGUST_060919_…` (six " +
      "digits whose leading four, 0609, are not a year). `…_APRIL_2022_" +
      "09052022_…` DOES read, because 09052022 is an eight-digit run and " +
      "`findYears` only accepts runs of exactly four. Half-yearly files sit in " +
      "the same bucket and are excluded by name. Verified: July-2026, 200 " +
      "283,432 B (served vnd.ms-excel, bytes are PK).",
  },
];

/** Lookup by id. */
export function amcPageScraper(
  id: AmcPageScrapeId,
): AmcPageScraper | undefined {
  return AMC_PAGE_SCRAPERS.find((s) => s.id === id);
}

/**
 * The houses a scheduled run may fetch.
 *
 * Mirrors `fetchableSources()` next door: `verified` only. An `observed` or
 * `unproven` row is present so the evidence is written down, NOT so a job can
 * pick it up — a URL nobody has fetched reports zero forever while every log
 * line reads as success.
 */
export function scrapableAmcs(): AmcPageScraper[] {
  return AMC_PAGE_SCRAPERS.filter((s) => s.provenance === "verified");
}

/**
 * Compile-time proof that every page-scrape id is a real `AmcId`.
 *
 * `MfPortfolioHolding.amc` stores this value, so a scrape id that is not an
 * AmcId would write a row nothing else can find — and no runtime test would
 * catch it, because both spellings look equally plausible in a string column.
 */
const _idsAreAmcIds: readonly AmcId[] = AMC_PAGE_SCRAPERS.map((s) => s.id);
void _idsAreAmcIds;
