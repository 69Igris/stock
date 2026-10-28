/**
 * Where each AMC publishes its monthly portfolio disclosure.
 *
 * MONEY-1105 (Data Engine P8a). Pure: URL construction and nothing else. The
 * WORKBOOK parsing lives in `mf-portfolio-logic.ts`; the fetching lives in the
 * worker.
 *
 * ## Why a registry rather than a handful of hard-coded URLs
 *
 * Every one of them spells the same date differently, and some cannot be
 * templated at all. Encoding that as a table with an explicit `provenance` per
 * row is the same discipline `report-registry.ts` uses, and for the same
 * reason: **a guessed URL 404s identically to "not published yet"**, so an
 * unverified row would report zero forever while every log line read as
 * success. Rows are therefore marked with what was actually observed, and the
 * unproven ones are NOT fetched by default.
 *
 * ## What was measured, 2026-08-14, from this machine
 *
 *   SBI     200, 2,638,783 bytes — byte-for-byte the committed fixture.
 *   Nippon  200, 1,355,264 bytes — likewise.
 *   HDFC    200,   155,355 bytes — likewise.
 *   ABSL    June-2026 200; July-2026 404 across FIVE spelling variants.
 *   Kotak   not probed.
 *
 * ## …and 2026-09-13, MONEY-1405 D3
 *
 *   Kotak   200, 3,706,593 B — 119 sheets, as-on 2026-08-31. The `www.` host is
 *           a Radware wall; `vatseelabs-s3.kotakmf.com` is open. PROMOTED.
 *   ICICI   200, 25,378,416 B — a zip of 147 per-scheme workbooks, as-on
 *           2026-08-31. AMFI's own registered link for ICICI 404s. PROMOTED.
 *   UTI     200, 1,692,892 B — the API works and the zip holds real holdings,
 *           but in ONE sheet covering every scheme. `observed`, not fetched;
 *           the row says exactly what is missing.
 *
 * ## …and 2026-09-14, MONEY-1407
 *
 *   UTI     PROMOTED. That one sheet is now split on the publisher's own
 *           `SCHEME CODE<nnn>STARTS` markers (`splitConsolidatedSheet`) into 85
 *           scheme sheets, 5,435 holdings, as-on 2026-08-31 on every one. Its
 *           URL is the first in this table that has to be ASKED FOR rather than
 *           built — see `discoverUrl`.
 *   ABSL    MOVED to `amc-page-scrape.ts` — its filename really is ad-hoc (7
 *           conventions in 7 months) and the links come from a Sitecore
 *           endpoint, so it is a scrape, not a template.
 *
 * ## The date spellings, which is the whole reason this file exists
 *
 *   SBI     `31st-july-2026`   ENGLISH ORDINAL, lowercase month.
 *                              "31-july-2026" is not the same URL.
 *   Nippon  `31-July-26`       TITLE-case month, TWO-DIGIT year.
 *   HDFC    `31 July 2026`     SPACES (percent-encoded), full year — AND the
 *                              path segment is the PUBLICATION month
 *                              (`2026-08`) while the filename is the DATA
 *                              month (July). Two different months in one URL;
 *                              using either for both gives a 404.
 *   Kotak   `August-31,-2026`  TITLE-case month with a LITERAL COMMA, in the
 *                              DIRECTORY — while the FILENAME of the same file
 *                              is `…August2026`, no day and no separator.
 *   ICICI   `2026/Aug/…August` the FOLDER is abbreviated unless the month's
 *                              name is four letters or fewer (May, June, July);
 *                              the FILENAME is always the full month. Measured
 *                              8 of 8 months of 2026 — see
 *                              `iciciMonthFolders`, which used to try the full
 *                              name first and was therefore wrong in five of
 *                              those eight. `altUrls` remains as the hedge.
 *
 * ## Nippon keeps only the CURRENT month
 *
 * `NIMF-MONTHLY-PORTFOLIO-30-June-26.xls` 404s while the July file serves. That
 * makes Nippon effectively UNBACKFILLABLE at this path — the same property that
 * makes `surveillance-sync` and `institutional-flow-sync` schedule-critical. A
 * month we do not fetch is a month we may never get, which is why the job runs
 * twice (the 12th and the 20th) rather than once.
 */

/**
 * Every AMC this pipeline can name, template-resolved or page-scraped.
 *
 * The first group has a row in `AMC_SOURCES` below (a URL template, or an
 * explicit reason there is none). The rest are resolved by reading their
 * landing page — see `amc-page-scrape.ts`, whose `AmcPageScrapeId` is a subset
 * of this union by construction, and which the two tables are kept DISJOINT
 * against so one AMC never has two resolvers.
 *
 * One union rather than two because this is what lands in
 * `MfPortfolioHolding.amc`: the storage key must not depend on which mechanism
 * happened to fetch the file, or the same AMC would appear under two names the
 * day its website changes shape.
 *
 * NOTE for anyone adding a row: `workers/src/routes/mf-portfolio-sync.ts` keeps
 * its own hand-typed `KNOWN_AMCS` array to validate the job's `only` parameter.
 * It is typed `readonly AmcId[]`, so a SUBSET still compiles — adding an id here
 * does not break that route, it just means the route silently refuses to target
 * the new AMC. That list has to be extended alongside this union.
 */
export type AmcId =
  // Template-resolved (or explicitly unresolvable) — see AMC_SOURCES.
  | "SBI"
  | "NIPPON"
  | "HDFC"
  | "KOTAK"
  | "ICICI"
  | "UTI"
  // Page-scraped — see AMC_PAGE_SCRAPERS.
  | "ABSL"
  | "DSP"
  | "PPFAS"
  | "TATA"
  | "ZERODHA"
  | "GROWW"
  | "OLD_BRIDGE"
  | "CAPITALMIND"
  // Page-scraped, added by the AMC-breadth pass (MONEY-1105 P8a).
  | "MIRAE"
  | "BARODA_BNP"
  | "SHRIRAM"
  | "HELIOS"
  | "THREE_SIXTY_ONE";

export type AmcProvenance =
  /** Fetched and byte-matched against a committed fixture. */
  | "verified"
  /** A URL was observed to work for at least one month, but not templated. */
  | "observed"
  /** No reliable template; the link must be discovered from a portal page. */
  | "needs-discovery"
  /** Nothing observed. Never fetched. */
  | "unproven";

/**
 * A two-step URL: ask an endpoint, then pick one answer out of it.
 *
 * {@link AmcUrlDiscovery.pick} is where the honesty lives. It returns `null`
 * for ZERO matches and for MORE THAN ONE — never the first of several — which
 * is `pickLinkForMonth`'s rule and is why this pipeline has no invented URLs
 * in it. A guessed URL 404s identically to "not published yet".
 */
export interface AmcUrlDiscovery {
  /** The JSON endpoint to GET for the month wanted. */
  apiUrl: (month: Date) => string;
  /** The disclosure's URL, VERBATIM, out of the parsed body. */
  pick: (body: unknown, month: Date) => string | null;
}

export interface AmcSource {
  id: AmcId;
  name: string;
  /**
   * AMFI's own AMC id, from `amfi-amc-registry`. The join key between this
   * hand-built resolver table and the authoritative 57-AMC registry.
   *
   * Kept as the id rather than the name because `fundName` is what AMFI's
   * NAVAll feed groups by and is therefore load-bearing for scheme identity —
   * duplicating it here would create a second copy to drift. The id is stable
   * and opaque, which is exactly what a foreign key should be.
   */
  amfiMfId: string;
  /**
   * Build the URL for the month whose data is wanted (any date inside it).
   * `null` when this AMC has no template — that is a real answer, not a gap to
   * paper over with a guess.
   */
  buildUrl: ((month: Date) => string) | null;
  /**
   * Further URLs to try, in order, when {@link buildUrl} 404s — MONEY-1405.
   *
   * Empty for every house whose spelling is stable, which is most of them. It
   * exists for ICICI Prudential, whose MONTH FOLDER is abbreviated unless the
   * month's name is four letters or fewer — measured across all 8 published
   * months of 2026, both spellings, three probes each; see
   * {@link iciciMonthFolders}. Both spellings are observed 200s in their own
   * months, so trying the second settles a month the rule gets wrong; it is not
   * a guess of the kind the header forbids, because neither candidate was
   * invented.
   *
   * ## KNOWN SHAPE HAZARD — MONEY-1408
   *
   * A source can express "I have one URL" when it needs several, and
   * {@link fetchableSources} is documented as "the sources a scheduled run may
   * fetch". `altUrls` is honoured by exactly ONE call site today
   * (`workers/src/processors/mf-portfolio-sync.ts`), so a second consumer that
   * reads `buildUrl` alone gets a 404 in whatever months the rule misses — and
   * a 404 here reads as "not published yet".
   *
   * The fix is to collapse both fields into `buildUrls(month): readonly
   * string[]`, which makes the plural the only shape and leaves
   * `fetchableSources()`'s condition identical in meaning. `discoverUrl` stays
   * separate and correctly so: it needs a network round-trip, which is exactly
   * why MONEY-1407 split it into `apiUrl` + `pick` rather than putting a
   * `fetch` behind a field on a table every test imports.
   *
   * Not done in this change because the rename's other half is one line in that
   * worker, which was being edited concurrently. Until then the hazard is
   * NARROWED rather than closed: the primary URL is now the one that works in 8
   * of 8 measured months instead of 3 of 8.
   */
  altUrls?: (month: Date) => readonly string[];
  /**
   * The file URL must be ASKED FOR, not built — MONEY-1407 (UTI).
   *
   * UTI's disclosure is a CloudFront object whose key carries a `?VersionId=`
   * and, some months, a `_revised_final` suffix. Nothing about it is derivable
   * from the month, so the ONLY way in is its own JSON index — which is a
   * second request, not a second spelling, and therefore not `altUrls`.
   *
   * Split into an endpoint and a PURE picker for the same reason
   * `amc-page-scrape.ts` is: this module builds URLs and decides which link is
   * the right one, and the worker does the I/O. Putting a `fetch` behind a
   * field on this table would make a registry that every test imports reach
   * the network, and would make the ONE rule worth testing — which row of the
   * response is the disclosure — reachable only through it.
   */
  discoverUrl?: AmcUrlDiscovery;
  /** The page a human (or a discovery step) can find the link on. */
  portalUrl: string;
  provenance: AmcProvenance;
  /**
   * One file per scheme rather than one workbook for all of them. HDFC and
   * (assumed) Kotak. A per-scheme AMC cannot be fetched from a month alone —
   * the scheme list has to come from somewhere.
   *
   * That somewhere now exists: AMFI's NAVAll feed, grouped by AMC
   * (`amfi-scheme-bridge`). HDFC IS fetched by the worker via `buildHdfcUrl`
   * over those scheme names — proven 2026-08-14, six names straight from NAVAll
   * returning 6/6 real workbooks. It stays out of `fetchableSources()` because
   * that function means "resolvable from a month ALONE", which a per-scheme AMC
   * is not; the worker handles it on its own path.
   */
  perScheme: boolean;
  /**
   * False when the publisher keeps only the current month, so history cannot be
   * re-fetched later and the SCHEDULE carries the risk rather than the parser.
   */
  backfillable: boolean;
  notes: string;
}

const MONTHS_LOWER = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const titleMonth = (m: number): string => {
  const s = MONTHS_LOWER[m]!;
  return `${s[0]!.toUpperCase()}${s.slice(1)}`;
};

/** Last day of the month `d` falls in, as a UTC date. */
export function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/** UTC midnight on the FIRST of `d`'s month — the storage anchor for a period. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * English ordinal: 1st, 2nd, 3rd, 4th … 21st, 22nd, 23rd … 31st.
 *
 * Only SBI needs this, and only for a month-end, so in practice the input is
 * 28-31. It is written generally anyway because the special case that catches
 * people out is 11th/12th/13th — which take "th" despite ending in 1/2/3 — and
 * a version that only handled the month-end range would look correct while
 * being wrong for any other use.
 */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * HDFC's URL, which needs a scheme name as well as a month.
 *
 * NOTE the two different months: the PATH is the publication month (data for
 * July is published in `2026-08`) and the FILENAME is the data month. Passing
 * one month for both is a 404, and it is the kind of 404 that looks like "not
 * published yet".
 */
export function buildHdfcUrl(dataMonth: Date, schemeName: string): string {
  const end = monthEnd(dataMonth);
  const pub = new Date(
    Date.UTC(dataMonth.getUTCFullYear(), dataMonth.getUTCMonth() + 1, 1),
  );
  const pubSegment = `${pub.getUTCFullYear()}-${String(pub.getUTCMonth() + 1).padStart(2, "0")}`;
  const file = `Monthly ${schemeName} - ${end.getUTCDate()} ${titleMonth(end.getUTCMonth())} ${end.getUTCFullYear()}.xlsx`;
  return `https://files.hdfcfund.com/s3fs-public/${pubSegment}/${encodeURIComponent(file)}`;
}

/**
 * ICICI Prudential's blob path for one month, given the folder's spelling.
 *
 * The FILENAME always carries the full month name; only the FOLDER varies. Both
 * are percent-encoded because `Monthly Portfolio Disclosures` has spaces in it.
 */
export function buildIciciUrl(dataMonth: Date, monthFolder: string): string {
  const end = monthEnd(dataMonth);
  const full = titleMonth(end.getUTCMonth());
  return (
    `https://www.icicipruamc.com/blob/downloads/Files/` +
    `${encodeURIComponent("Monthly Portfolio Disclosures")}/` +
    `${end.getUTCFullYear()}/${encodeURIComponent(monthFolder)}/` +
    `Monthly-Portfolio-Disclosure-${full}-${end.getUTCFullYear()}.zip`
  );
}

/**
 * The month-folder spellings to try, MOST LIKELY FIRST — MONEY-1408.
 *
 * ## There IS a rule, and the note that said there was not cost us 5 months in 8
 *
 * This used to return `[full, abbr]` unconditionally, on a note reading "the
 * folder genuinely alternates and there is no rule to derive it from". The
 * evidence for that was five month names read off a portal — `Apr`, `May`,
 * `June`, `July`, `Aug` — which does look ruleless until the LENGTHS are lined
 * up beside them.
 *
 * Measured 2026-09-14, every published month of 2026, both spellings, THREE
 * probes each (a single status is not evidence — this host answered 404 once
 * and 200 on four consecutive retries minutes later):
 *
 *   January   `January` 404,404,404   `Jan`  200   23,799,043 B
 *   February  `February` 404,404,404  `Feb`  200   23,769,452 B
 *   March     `March` 404,404,404     `Mar`  200   23,939,725 B
 *   April     `April` 404,404,404     `Apr`  200   24,399,255 B
 *   May       `May` 200                             24,570,197 B
 *   June      `June` 200              `Jun`  404   24,852,245 B
 *   July      `July` 200              `Jul`  404   25,265,087 B
 *   August    `August` 404,404,404    `Aug`  200   25,378,416 B
 *
 * 8 of 8 fit ONE rule: **spell the month out when its name is four letters or
 * fewer, abbreviate to three otherwise.** May, June and July are the only names
 * that qualify, which is why the observed set looked like an alternation.
 *
 * So the primary candidate was the WRONG one in five of the eight months, not
 * "roughly every other". That was invisible because the worker tries both and
 * the second one hits — but `buildUrl` is what `fetchableSources()` hands a
 * caller, and a caller reading it alone was right 3 times in 8.
 *
 * ## The other spelling is STILL returned, deliberately
 *
 * Eight points from one calendar year is a rule, not a guarantee — the shape of
 * it (`name.length <= 4`) smells like a CMS template rather than an editorial
 * choice, and CMS templates get replaced. The fallback costs one extra request
 * only in the month the rule is wrong, and the alternative is the failure this
 * whole file exists to prevent: a 404 that reads as "not published yet".
 *
 * May needs only one candidate because its name IS its abbreviation.
 */
function iciciMonthFolders(dataMonth: Date): string[] {
  const full = titleMonth(monthEnd(dataMonth).getUTCMonth());
  const abbr = full.slice(0, 3);
  if (full === abbr) return [full];
  return full.length <= 4 ? [full, abbr] : [abbr, full];
}

/**
 * UTI's consolidated-disclosure index for one month — MONEY-1407.
 *
 * THE MONTH MUST BE THE FULL ENGLISH NAME. `month=08` answers **200** with
 * `{"rows":[]}`, which is a silent zero and reads exactly like "not published
 * yet"; `month=August` answers 200 with the row. Measured 2026-09-13 and
 * re-measured 2026-09-14 across August, July and June 2026 — one row each time.
 */
export function buildUtiDisclosureApiUrl(dataMonth: Date): string {
  // The DATA month, not the publication month. HDFC is the house on this table
  // that needs both and the one that proves the distinction is not academic:
  // its path segment is `2026-08` while its filename says July, and using
  // either for both is a 404 that reads like "not published yet".
  return (
    `https://www.utimf.com/api/get-consolidate-portfolio-disclosure` +
    `?year=${dataMonth.getUTCFullYear()}` +
    `&month=${titleMonth(dataMonth.getUTCMonth())}`
  );
}

/**
 * The disclosure zip's URL out of that index — VERBATIM, or `null`.
 *
 * ## Measured, not guessed (2026-09-14, three months)
 *
 *   August 2026  `{"rows":[{"name":"Consolidated Portfolio August 2026",
 *                 "type":"Zip","category":"Consolidate portfolio disclosure",
 *                 "month":"August","year":"2026","url":"https://d3ce1o48hc5oli
 *                 .cloudfront.net/s3fs-public/2026-09/fw_uti_mf_scheme_
 *                 portfolios_31.08.2026_revised_final.zip?VersionId=…"}]}`
 *   July 2026    same shape, `…_31.07.2026.zip?VersionId=…`
 *   June 2026    same shape, `…_30.06.2026_rv1.zip?VersionId=…`
 *
 * Three months, three different filename conventions and three different
 * `VersionId`s: that is the whole reason this AMC has no `buildUrl`. The URL is
 * returned EXACTLY as given — the query string is part of the object's identity
 * on CloudFront, and stripping it is a 403.
 *
 * ## What it refuses
 *
 * Zero matching rows, or more than one. Never the first of several: an index
 * that starts carrying two consolidated files for a month is telling us
 * something we do not yet know, and picking one would be a guess that stores
 * cleanly. The echoed `month`/`year` are checked as well as the name, because
 * the endpoint answers 200 for a month it has nothing for and an unchecked
 * caller would happily store a stale month's holdings under the requested one.
 */
export function pickUtiDisclosureUrl(
  body: unknown,
  dataMonth: Date,
): string | null {
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return null;

  const wantMonth = titleMonth(dataMonth.getUTCMonth());
  const wantYear = String(dataMonth.getUTCFullYear());

  const hits = rows.filter((raw): raw is { url: string } => {
    const row = raw as {
      url?: unknown;
      name?: unknown;
      month?: unknown;
      year?: unknown;
    } | null;
    return (
      typeof row?.url === "string" &&
      row.url.length > 0 &&
      String(row.month ?? "") === wantMonth &&
      String(row.year ?? "") === wantYear &&
      /\bconsolidated?\s+portfolio\b/i.test(String(row.name ?? ""))
    );
  });
  return hits.length === 1 ? hits[0]!.url : null;
}

export const AMC_SOURCES: readonly AmcSource[] = [
  {
    id: "SBI",
    amfiMfId: "22",
    name: "SBI Mutual Fund",
    buildUrl: (m) => {
      const end = monthEnd(m);
      return (
        `https://www.sbimf.com/docs/default-source/scheme-portfolios/` +
        `all-schemes-monthly-portfolio---as-on-${ordinal(end.getUTCDate())}-` +
        `${MONTHS_LOWER[end.getUTCMonth()]}-${end.getUTCFullYear()}.xlsx`
      );
    },
    portalUrl: "https://www.sbimf.com/portfolios",
    provenance: "verified",
    perScheme: false,
    backfillable: true,
    notes:
      "ONE workbook, 122 sheets. English ORDINAL date (31st-july-2026) and a " +
      "lowercase month; the plain '31-july-2026' spelling is a different URL. " +
      "The `?sfvrsn=` query the portal appends is NOT required — verified 200 " +
      "at 2,638,783 bytes without it, byte-matching the committed fixture.",
  },
  {
    id: "NIPPON",
    amfiMfId: "21",
    name: "Nippon India Mutual Fund",
    buildUrl: (m) => {
      const end = monthEnd(m);
      const yy = String(end.getUTCFullYear()).slice(-2);
      return (
        `https://mf.nipponindiaim.com/InvestorServices/FactsheetsDocuments/` +
        `NIMF-MONTHLY-PORTFOLIO-${end.getUTCDate()}-${titleMonth(end.getUTCMonth())}-${yy}.xls`
      );
    },
    portalUrl:
      "https://mf.nipponindiaim.com/investor-service/downloads/factsheet-portfolio-and-other-disclosures",
    provenance: "verified",
    perScheme: false,
    // June-2026 404s while July-2026 serves. Only the current month is kept.
    backfillable: false,
    notes:
      "ONE workbook, 108 sheets. TITLE-case month with a TWO-DIGIT year " +
      "(31-July-26). CURRENT MONTH ONLY — the June file 404s while July " +
      "serves, so a missed month may be unrecoverable and the SCHEDULE carries " +
      "the risk. Served as `application/vnd.ms-excel` with an `.xls` extension " +
      "while actually being OOXML: BOTH lie, and only the magic bytes do not.",
  },
  {
    id: "HDFC",
    amfiMfId: "9",
    name: "HDFC Mutual Fund",
    // Per-scheme: a month alone is not enough to build a URL. Use buildHdfcUrl.
    buildUrl: null,
    portalUrl:
      "https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio",
    provenance: "verified",
    perScheme: true,
    backfillable: true,
    notes:
      "ONE FILE PER SCHEME, so `buildUrl` is null and `buildHdfcUrl(month, " +
      "scheme)` is the builder. TWO DIFFERENT MONTHS in one URL: the path " +
      "segment is the PUBLICATION month (2026-08) and the filename is the DATA " +
      "month (31 July 2026). Spaces are percent-encoded. Verified 200 at " +
      "155,355 bytes, byte-matching the committed fixture.",
  },
  {
    id: "KOTAK",
    amfiMfId: "17",
    name: "Kotak Mahindra Mutual Fund",
    buildUrl: (m) => {
      const end = monthEnd(m);
      const month = titleMonth(end.getUTCMonth());
      const year = end.getUTCFullYear();
      return (
        `https://vatseelabs-s3.kotakmf.com/FormsDownloads/Portfolios/` +
        `Consolidated-SEBI-Portfolio-as-on-${month}-${end.getUTCDate()},-${year}/` +
        `ConsolidatedSEBIPortfolio${month}${year}.xlsx`
      );
    },
    portalUrl: "https://www.kotakmf.com/Information/forms-and-downloads",
    provenance: "verified",
    // NOT per-scheme, despite what this row asserted for a year: ONE
    // consolidated workbook holds all 119 schemes. The old `true` was assumed
    // from HDFC and the row said so.
    perScheme: false,
    backfillable: true,
    notes:
      "ONE workbook, 119 sheets. NEVER the `www.` host — MONEY-1197 measured a " +
      "Radware bot wall there; `vatseelabs-s3.kotakmf.com` is open and is the " +
      "one to use. The DAY and the MONTH appear in the directory with a literal " +
      "COMMA before the year (`…as-on-August-31,-2026`) while the filename " +
      "glues month to year with neither (`ConsolidatedSEBIPortfolioAugust2026`). " +
      "Served `application/octet-stream`, bytes are PK. Its `Name of Instrument` " +
      "header is MERGED across three columns, which is why `instrumentNameSpan` " +
      "exists — without it the workbook parses to one cash line per scheme. " +
      "Verified 2026-09-13: August-2026, 200, 3,706,593 bytes, 119 portfolio " +
      "sheets, as-on 2026-08-31 on 118 of them, 6,388 holdings, zero " +
      "scale-suspect sheets.",
  },
  {
    id: "ICICI",
    // 20, not 2 — MONEY-1407. `2` is not an AMFI mf_id at all (the live
    // registry holds 57 AMCs and has no row for it), so this join was DEAD:
    // `resolverCoverage` counted ICICI in neither bucket and reported "ICICI
    // Prudential Mutual Fund" nightly as an AMC with no resolver, while the
    // house was being fetched and writing ~9,857 holdings a month. Measured
    // against AMFI's own feed 2026-09-14: `mf_id 20 -> ICICI Prudential Mutual
    // Fund`. Coverage reads 17 of 57 with this, 16 without.
    //
    // It survived because the fixture the join test uses is TRIMMED and the
    // test skips an id it cannot find — so a NONEXISTENT id is indistinguishable
    // from a trimmed-away one. The ids are pinned by value below for that
    // reason; widening the fixture is a follow-up.
    amfiMfId: "20",
    name: "ICICI Prudential Mutual Fund",
    buildUrl: (m) => buildIciciUrl(m, iciciMonthFolders(m)[0]!),
    altUrls: (m) =>
      iciciMonthFolders(m)
        .slice(1)
        .map((folder) => buildIciciUrl(m, folder)),
    portalUrl:
      "https://www.icicipruamc.com/news-and-media/downloads?currentTabFilter=Disclosures&&subCatTabFilter=MonthlyPortfolioDisclosures",
    provenance: "verified",
    // One file per scheme INSIDE ONE ZIP, which is a different thing from
    // HDFC's per-scheme URLs: a month alone still addresses it, so it is
    // fetchable and `perScheme` stays false. The 147 members are unwrapped by
    // `parseAmcPortfolioWorkbook`.
    perScheme: false,
    backfillable: true,
    notes:
      "THE BIGGEST GAP IN THE INDUSTRY, 2,498 funds, and NOT reachable through " +
      "AMFI's registry — the link AMFI publishes for ICICI 404s (measured " +
      "2026-09-13, 15 KB of text/html). This blob path is the way in. ONE ZIP " +
      "of 147 per-scheme .xlsx INCLUDING the ETFs. Every member sets zip " +
      "general-purpose bit 3, so a local-header reader mis-sizes them — see " +
      "`unzipWorkbookEntries`. Every member also prints the AMC's OWN name on " +
      "row 1 above the scheme's, so the SCHEME NAME comes from the zip member " +
      "filename, not from the sheet. THAT KNOWN LIMIT IS CLOSED — MONEY-1409. " +
      "The Overnight Fund's `Reverse Repo` heading (182% of NAV) carries a " +
      "subtotal AND both its child rows have neither an ISIN nor a quantity, " +
      "the one shape `headsItsOwnSection` cannot tell from a holding; " +
      "`headsItsOwnSectionBySum` answers it structurally — the heading equals " +
      "the whole block beneath it (944,966.09 + 84,961.91 = 1,029,928.00, to " +
      "the paisa). Measured on the July-2026 zip, that rule drops 17 rows " +
      "across 17 of the 146 sheets and NOTHING else: the Overnight repo " +
      "subtotal, and `INTEREST RATE SWAPS (At Notional Value)` on 16 debt " +
      "funds, which is the same defect at a smaller scale (Corporate Bond: " +
      "147,500 against eighteen legs totalling exactly 147,500). Sheets inside " +
      "95-105% went 134 -> 139 of 146; sheets ABOVE 105% went 9 -> 4; zero " +
      "real positions removed — every dropped row is provably the sum of its " +
      "own block. The four still above and the three still below are " +
      "interest-rate swaps carried at NOTIONAL, which is a real disclosure " +
      "choice and not a parse fault. " +
      "Verified 2026-09-13: August-2026, 200 application/x-zip-compressed, " +
      "25,378,416 bytes, 147 portfolio sheets, as-on 2026-08-31 on all of them, " +
      "9,766 holdings, zero scale-suspect sheets. " +
      "NOTE that 200 was the FALLBACK url — MONEY-1408. Re-measured 2026-09-14 " +
      "across all 8 published months of 2026: the month FOLDER is the 3-letter " +
      "abbreviation unless the name is four letters or fewer (May, June, July), " +
      "8 of 8, so the old full-name-first ordering made `buildUrl` a 404 in " +
      "five of those eight while this row read `verified`. The ordering is now " +
      "the measured rule and `altUrls` is the hedge against it being a " +
      "coincidence of one calendar year.",
  },
  {
    id: "UTI",
    amfiMfId: "28",
    name: "UTI Mutual Fund",
    // NOT constructible — the file lives behind its own JSON index. See
    // `buildUtiDisclosureApiUrl` / `pickUtiDisclosureUrl`.
    buildUrl: null,
    discoverUrl: {
      apiUrl: buildUtiDisclosureApiUrl,
      pick: pickUtiDisclosureUrl,
    },
    portalUrl: "https://www.utimf.com/forms-and-downloads/downloads",
    provenance: "verified",
    perScheme: false,
    backfillable: true,
    notes:
      "ONE SHEET, EVERY SCHEME — MONEY-1407. Ingested since 2026-09-14; the " +
      "row read `observed` for a release because the file was reachable and " +
      "not yet readable, which is the state this column exists to express.\n" +
      "URL: `GET https://www.utimf.com/api/get-consolidate-portfolio-" +
      "disclosure?year=2026&month=August` -> 200 `{rows:[{name:'Consolidated " +
      "Portfolio August 2026', type:'Zip', url:'…cloudfront…/fw_uti_mf_" +
      "scheme_portfolios_31.08.2026_revised_final.zip?VersionId=…'}]}`. The " +
      "month MUST be the full English name (`month=08` returns `{rows:[]}` at " +
      "200, a silent zero) and the URL is used VERBATIM — the `?VersionId=` " +
      "is part of the object's identity and three consecutive months carried " +
      "three different filename conventions (`_revised_final`, bare, `_rv1`).\n" +
      "FILE, re-measured 2026-09-14: 200 application/zip, 1,692,892 bytes, " +
      "FOUR members. Only `Sebi Exposure as on 31 Aug 2026_final_REVISED.xlsx` " +
      "(329,181 B) holds holdings; the dividend master, the futures-exposure " +
      "sheet and the 29-tab risk-o-meter workbook yield ZERO portfolio sheets " +
      "through `parseAmcPortfolioWorkbook` (measured member by member), so " +
      "there is no `memberFilter` and nothing about UTI is special-cased " +
      "inside the parser.\n" +
      "SHAPE: one worksheet, `EXPOSURE`, 9,208 rows, 85 scheme blocks end to " +
      "end delimited by `SCHEME CODE<nnn>STARTS` / `SCHEME: <name>` / " +
      "`SCHEME CODE<nnn>ENDS`. `splitConsolidatedSheet` cuts it on those " +
      "markers; each block re-prints its own column header, so nothing is " +
      "prepended. It dates itself `PORTFOLIO DISCLOSURE AS OF 31/08/2026` — " +
      "`AS OF`, the third spelling `AS_ON_STRICT` now admits.\n" +
      "PARSED (August 2026): 85 sheets, 5,435 holdings, as-on 2026-08-31 on " +
      "ALL 85, zero scale-suspect, 83 summing inside 95-105%. The two " +
      "remainders are the YES BANK AT1 SIDE-POCKETS (`… ( Segregated " +
      "-06032020)`), whose every value is 0 and whose every `% TO NAV` cell is " +
      "`*` ('less than 0.01') — no percentages to sum, correctly, rather than " +
      "wrong ones.\n" +
      "KNOWN LIMIT: the block's grand total is `TOTAL : <scheme name>`, not " +
      "`Grand Total`, so `totalAumLakhs` is null and `checkPercentSum` reads " +
      "`uncheckable` on all 85 — the money-vs-percent cross-check does not run " +
      "for this house. Not a refusal (only `scale-suspect` refuses), and not " +
      "worth a looser `GRAND_TOTAL`, which would start matching every section " +
      "subtotal on every other house's sheets.",
  },
];

/**
 * How much of the industry we can actually resolve, measured against AMFI's own
 * registry rather than against our own table.
 *
 * `AMC_SOURCES` on its own can only answer "how many did we write down", which
 * is a statement about our effort, not about coverage. Joined to the 57-AMC
 * registry on `amfiMfId` it answers the real question — and, more importantly,
 * NAMES the AMCs with no resolver instead of leaving them an unquantified
 * remainder. "We cover 3" reads very differently from "we cover 3 of 57", and
 * the second is what a scheduled run should report.
 *
 * Deliberately a COUNT, not an AUM weighting. AUM flatters the picture
 * enormously — the three verified AMCs are ~35% of industry assets but 5% of
 * AMCs — and both framings are true. The count is here because it is derivable
 * from data this module already holds; the AUM view needs AMFI's AAUM feed.
 */
export interface ResolverCoverage {
  /** AMCs in AMFI's registry. */
  total: number;
  /** Registry AMCs we have a FETCHABLE resolver for. */
  resolved: string[];
  /**
   * Registry AMCs we have a row for, but whose provenance forbids fetching
   * (`needs-discovery` / `unproven` / `observed`). Distinct from `missing`:
   * known-and-blocked, rather than never considered.
   */
  knownButNotFetchable: string[];
  /** Registry AMCs with no row here at all. */
  missing: string[];
}

export function resolverCoverage(
  registry: readonly { mfId: string; fundName: string }[],
  /**
   * AMFI ids of AMCs resolved by PAGE SCRAPE rather than by a URL template.
   * Passed in rather than imported so this module stays free of a dependency on
   * `amc-page-scrape.ts` — that file already imports from here, and a cycle
   * between the two would be a real load-order hazard for a table that must be
   * readable at module scope.
   */
  scrapedMfIds: readonly string[] = [],
): ResolverCoverage {
  const byMfId = new Map(AMC_SOURCES.map((s) => [s.amfiMfId, s]));
  const fetchable = new Set([
    ...fetchableSources().map((s) => s.amfiMfId),
    ...scrapedMfIds,
  ]);

  const resolved: string[] = [];
  const knownButNotFetchable: string[] = [];
  const missing: string[] = [];

  for (const amc of registry) {
    if (fetchable.has(amc.mfId)) resolved.push(amc.fundName);
    else if (byMfId.has(amc.mfId)) knownButNotFetchable.push(amc.fundName);
    else missing.push(amc.fundName);
  }
  return { total: registry.length, resolved, knownButNotFetchable, missing };
}

/** The sources a scheduled run may fetch: those with a template we trust. */
export function fetchableSources(): AmcSource[] {
  return AMC_SOURCES.filter(
    (s) =>
      s.provenance === "verified" &&
      // A URL this run can arrive at on its own: built from the month, or
      // asked for (MONEY-1407). `perScheme` houses still have neither and are
      // still excluded — a month alone does not name their files.
      (s.buildUrl !== null || s.discoverUrl !== undefined),
  );
}

export function amcSource(id: AmcId): AmcSource | undefined {
  return AMC_SOURCES.find((s) => s.id === id);
}
