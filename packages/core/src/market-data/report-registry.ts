/**
 * NSE/BSE report registry — MONEY-1097 (Data Engine P2).
 *
 * One typed table naming every exchange report family we intend to ARCHIVE
 * daily, and how to build its URL for a given trading day. It is data, not
 * behaviour: nothing here fetches, parses, or writes. The worker
 * (`workers/src/processors/report-archive-sync.ts`) walks this table and hands
 * each URL to `getFeedAsset`, so archive/replay/QA-mirror all keep working
 * unchanged (MONEY-1085).
 *
 * ## Archive-first, parse-later — why the order matters
 *
 * NSE PRUNES its archives. P1 confirmed it for one feed with real evidence: the
 * PR daily-report zips return a genuine 404 for 1995, 2000 and 2010. Every day
 * spent designing a parser is a day of files aging out of reach. Bytes on GCS
 * can be parsed whenever; bytes never fetched are gone for good. So this ticket
 * deliberately ships NO parsers.
 *
 * An earlier version of this paragraph also claimed "BSE's pre-UDiFF
 * EQ_ISINCODE zips are gone entirely". That was NOT established. All three
 * probes returned 200 + BSE's SPA catch-all page, not 404 — and the probe's
 * `bracket()` sorted HTML into neither the present nor the absent bucket, so
 * "no rungs present" published "NOT AVAILABLE at any probed date". A 200
 * carrying a page means the path did not resolve to a FILE; it says nothing
 * about whether the file exists. `bracket()` now reports that case as
 * INDETERMINATE.
 *
 * ## `enabled` and `provenance` — the honest half of this table
 *
 * P1 live-verified about a dozen of these URL patterns. The rest were written
 * from knowledge of NSE's archive layout, which is a good guess and not
 * evidence. Shipping a guessed path as live would mean the nightly job sends a
 * request that 404s every day forever — and, worse, a 404 from a WRONG PATH is
 * indistinguishable from a 404 meaning "market holiday", so the mistake would
 * never surface.
 *
 * Hence two fields that must be read together:
 *
 *   `provenance`  where the URL pattern came from — evidence or guess
 *   `enabled`     whether the nightly job may fetch it
 *
 * Only patterns with real evidence ship enabled. Everything else is present as
 * an INVENTORY row — the family is named, its shape is written down, its tests
 * pin the URL — but the worker skips it until someone confirms the path with
 * `scripts/data/probe-exchange-archives.ts --registry`, which probes every row
 * once and reports PRESENT/ABSENT. Flip `enabled` from that output, never from
 * confidence.
 *
 * ## `enabled` vs `backfillable` — two different questions (MONEY-941)
 *
 *   `enabled`       may the NIGHTLY job fetch this?
 *   `backfillable`  is this DATE-ADDRESSABLE — does asking for a past date
 *                   return THAT date's file?
 *
 * All four combinations occur and none is an error. The nightly selector
 * (`familiesDue`) reads `enabled`; the backfill selector
 * (`familiesForBackfill`) reads `backfillable`. Conflating them would break the
 * backfill in two opposite directions at once: it would skip the three
 * inventory-only workhorses (the most valuable history we have) and it would
 * walk the rolling families (silent corruption — see below).
 *
 * ## Rolling families have NO OBTAINABLE HISTORY — accepted, not a TODO
 *
 * `bulk.csv`, `block.csv`, the eight `ind_*list.csv` constituent files and the
 * four Mutual Fund monthlies are single undated files that upstream overwrites
 * in place. There is no URL that returns their past state, so:
 *
 *   - They are `backfillable: false`, permanently. Fetching one "for 2019"
 *     returns TODAY's bytes and files them under a 2019 key — the archive would
 *     then assert it holds 2019's bulk deals while holding this morning's.
 *     Undetectable later, and it poisons exactly the artifact this subsystem
 *     exists to protect.
 *   - Bulk/block DEAL history is obtainable, but from a different source: NSE's
 *     `historicalOR` API, which is P4's scope (MONEY-1100) — not this file.
 *   - Index-constituent MEMBERSHIP history simply BEGINS at the P2 deploy date.
 *     Earlier membership is not recoverable from NSE for free, and that is the
 *     accepted cost of having started when we did.
 *
 * If a future reader is tempted to "fix" this by pointing a backfill at them:
 * that is the bug, not the fix.
 *
 * ## Explicitly EXCLUDED (do not add these without a reason)
 *
 *   - **SPAN risk parameter files** — intraday, many per day, only meaningful
 *     to a margin engine we do not have. Concretely this covers the six
 *     `WDM-SPAN-*` keys (BEGIN-DAY, INTRA-DAY-1..4, END-DAY) that MONEY-1201
 *     found in the live `daily-reports?key=WDM` payload; six 111 KB zips per
 *     day, none of them analytics.
 *   - **VaR DAT files** — same: per-settlement risk inputs, not analytics.
 *     Covers `SLBS-BEGIN-DAY-VAR` (MONEY-1200).
 *   - **Latency / infrastructure stats** — exchange plumbing telemetry.
 *   - **Settlement statistics, AUB, CSQR** — keyed by SETTLEMENT NUMBER, not by
 *     date, so they cannot be addressed by this table's `buildUrl(date)` shape
 *     at all. They need a settlement-calendar lookup first.
 *   - **Haircut files** — collateral valuation, again margin-engine territory.
 *   - **Historical PR zips** — P1 probed 1995/2000/2010 and all three 404'd.
 *     The path serves RECENT days only, so there is no history to backfill and
 *     the current day is already covered by the individual files inside it.
 */

// ─── Hosts ───────────────────────────────────────────────────────────

const NSE_ARCHIVES = "https://nsearchives.nseindia.com";
const NSE_WWW = "https://www.nseindia.com";
const BSE_WWW = "https://www.bseindia.com";
const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api";
const NIFTY_INDICES = "https://www.niftyindices.com";

// ─── Date tokens ─────────────────────────────────────────────────────
//
// Every exchange filename is keyed to the IST trading date, so the +5:30 shift
// is applied explicitly rather than trusting the host timezone — the same
// convention as `istParts` in bhavcopy.ts and `toIstDateKey` in nse-holidays.ts.
//
// These are exported and unit-tested against golden strings because NSE is
// gratuitously inconsistent about them: the same archive serves `08-AUG-2026`,
// `08-Aug-2026`, `08082026` and `20260808` across different families, and a
// single wrong case silently yields a 404 that reads as "market holiday".

const MONTHS_UPPER = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

function istParts(date: Date): { y: number; m: number; d: number } {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD` — UDiFF bhavcopies. */
export function tokYYYYMMDD(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${y}${pad2(m)}${pad2(d)}`;
}

/** `DDMMYYYY` — MTO, sec_bhavdata_full, EGR. */
export function tokDDMMYYYY(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}${pad2(m)}${y}`;
}

/** `DDMMYY` — legacy zips and several `.lst` families. */
export function tokDDMMYY(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}${pad2(m)}${String(y).slice(-2)}`;
}

/** `DDMM` — BSE gross delivery (the year lives in the path, not the name). */
export function tokDDMM(date: Date): string {
  const { m, d } = istParts(date);
  return `${pad2(d)}${pad2(m)}`;
}

/** `DDMMMYYYY` upper — e.g. `03NOV1994`, legacy NSE cash bhavcopy. */
export function tokDDMMMYYYY(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}${MONTHS_UPPER[m - 1]}${y}`;
}

/** `DD-MON-YYYY` upper — e.g. `08-AUG-2026`, used by `oi_cli_limit`. */
export function tokDashMonUpper(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}-${MONTHS_UPPER[m - 1]}-${y}`;
}

/** `DD-Mon-YYYY` title — e.g. `08-Aug-2026`, used by `fii_stats`. */
export function tokDashMonTitle(date: Date): string {
  const { y, m, d } = istParts(date);
  const mon = MONTHS_UPPER[m - 1]!;
  return `${pad2(d)}-${mon[0]}${mon.slice(1).toLowerCase()}-${y}`;
}

/** `DD/MM/YYYY` — BSE's api.bseindia.com query params. */
export function tokSlash(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

/** `MON` upper — month-name path segment, e.g. `.../1994/NOV/...`. */
export function tokMonthUpper(date: Date): string {
  return MONTHS_UPPER[istParts(date).m - 1]!;
}

/**
 * `YYYY-MM` — month path segment, e.g. `2026-07`. NSE's mediaattachment tree.
 *
 * Note this is the FIRST monthly token in this file. Every other token here
 * resolves to a day, which is why the registry's whole vocabulary is daily; a
 * monthly family addressed with a daily token would build 30 distinct URLs for
 * one document and count 29 phantom 404s as gaps.
 */
export function tokIsoMonth(date: Date): string {
  const { y, m } = istParts(date);
  return `${y}-${pad2(m)}`;
}

/**
 * FULL month names. Every other month constant in this file is the 3-letter
 * abbreviation (`MONTHS_UPPER` is `JAN`…`DEC`), which is why this exists
 * separately rather than being derived: title-casing `AUG` yields `Aug`, and
 * `Aug` 404s on the Market Pulse path where `August` returns 206.
 */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `Monthname` in title case — e.g. `August`. NSE's Market Pulse filename.
 *
 * Deliberately NOT `tokDashMonTitle`, which abbreviates (`08-Aug-2026`). The
 * two read as the same intent and produce different strings, and the
 * abbreviated form 404s here — the same casing/abbreviation trap that already
 * forced `oi_cli_limit` (DD-MON-YYYY upper) and `fii_stats` (DD-Mon-YYYY title)
 * to be pinned by golden tests on this very site.
 */
export function tokMonthNameTitle(date: Date): string {
  return MONTH_NAMES[istParts(date).m - 1]!;
}

/** IST `YYYY-MM-DD`, the canonical key for "which trading day is this". */
export function tokIsoDay(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// ─── Types ───────────────────────────────────────────────────────────

export type ReportCadence = "daily" | "weekly" | "monthly";

export type ReportFormat =
  | "csv"
  | "zip"
  | "dat"
  | "xls"
  | "lst"
  | "gz"
  | "json"
  // MONEY-1187 P11 — Market Pulse. The first NON-TABULAR format in this
  // registry: every other member is bytes that `feed-parse` turns into rows,
  // whereas a PDF is bytes that only an extractor can read. It is registered
  // anyway because ARCHIVING and PARSING are different jobs here — the archive
  // is what makes a later extractor possible without re-scraping five years of
  // NSE. `feed-parse` has no entry for it and will skip it loudly, which is the
  // correct behaviour rather than an oversight.
  | "pdf"
  // MONEY-1204 P0.2 — NSE's XBRL result filings. Like `pdf`, registered for the
  // ARCHIVE rather than for `feed-parse`; unlike every other member, it is also
  // the first format whose family is fetched by a DIFFERENT job entirely
  // (`xbrl-sync`, per filing) rather than by `report-archive-sync`. See the
  // `nse-results-xbrl` row for why that is not a workaround.
  | "xml";

/**
 * Where a URL pattern came from. This is the field that decides whether a row
 * is trustworthy, so it is required rather than optional.
 */
export type ReportProvenance =
  /** Live-probed in MONEY-1096; see docs/reference/exchange-archive-ranges.md. */
  | "p1-verified"
  /** Already fetched in production today (bhavcopy.ts), so proven by use. */
  | "existing-code"
  /** Captured from a live API response during P1 (the EGR daily-reports JSON). */
  | "api-captured"
  /** Confirmed live by `probe-exchange-archives.ts --registry` (MONEY-1097). */
  | "p2-probed"
  /** Written from knowledge of the archive layout. NOT evidence. */
  | "unverified";

export interface ReportFamily {
  /** Stable id, also the log key. */
  id: string;
  exchange: "NSE" | "BSE";
  /** GCS slug — the `{feed}` segment of `feeds/{exchange}/{feed}/{YYYY}/{MM}/`. */
  feed: string;
  /**
   * URL for a given trading day, or `null` when this family publishes nothing
   * for that date (wrong day-of-month for a monthly, before `startDate`).
   * Returning null is how a family opts out WITHOUT the worker having to know
   * anything family-specific.
   */
  buildUrl(date: Date): string | null;
  cadence: ReportCadence;
  /** Earliest date the family is known/believed to exist, `YYYY-MM-DD`. */
  startDate: string;
  format: ReportFormat;
  /**
   * Needs the cookie-gated www.nseindia.com API rather than a static archive.
   *
   * ## This flag DECIDES — it is not a note (MONEY-1238)
   *
   * It used to be neither read nor asserted anywhere in the repo, which made it
   * a comment that looked like configuration. Meanwhile the nightly fetch path
   * — `familiesDue()` → `report-archive-sync` → `getFeedAsset` →
   * `fetchExchangeAsset` — sends browser-impersonation HEADERS and no cookie
   * jar at any layer. So a `requiresApi` family handed to that path can only
   * ever receive Akamai's challenge interstitial, which `validateFeedPayload`
   * records as `rejected` — every night, forever, and indistinguishable from
   * the format change the rejection counter exists to catch.
   *
   * `familiesDue()` now excludes these rows (see {@link isNightlyFetchable}),
   * and {@link apiGatedFamilies} lists them so the exclusion is inspectable
   * rather than silent. The cookie-capable door is
   * `fetchNseApiJson` + `archiveNseJsonResponse` in
   * `packages/research/src/data-sources/`, which is where the two surveillance
   * endpoints below are actually fetched from.
   */
  requiresApi?: boolean;
  /**
   * Whether the nightly job may fetch this. False = inventory row only.
   * See the header: only rows with real evidence ship enabled.
   */
  enabled: boolean;
  /**
   * Whether this family is DATE-ADDRESSABLE — i.e. asking for a specific past
   * date returns THAT date's file.
   *
   * Deliberately orthogonal to {@link enabled}, which answers a different
   * question ("may the nightly job fetch this?"). All four combinations are
   * real and none is a mistake:
   *
   *   enabled  backfillable  example
   *   true     true          nse-mto-delivery — nightly AND historically walkable
   *   true     false         nse-bulk-deals — nightly, but no history exists
   *   false    true          nse-cm-udiff-bhavcopy — bhavcopy-sync owns the daily
   *                          fetch, but only P3 can walk its history
   *   false    false         bse-egr — shape unknown, buildUrl returns null
   *
   * ## Why `false` on an undated URL is a CORRECTNESS guard, not a preference
   *
   * A rolling family's URL carries no date, so it always serves TODAY. Handing
   * it a 2019 date during a backfill fetches today's bytes and files them under
   * a 2019 archive key — the archive would then assert it holds 2019's bulk
   * deals while holding this morning's. That is silent, undetectable corruption
   * of the one artifact this whole subsystem exists to protect, and it would be
   * discovered only by someone analysing the wrong numbers months later.
   *
   * REQUIRED rather than optional so that adding a family forces the decision.
   * An invariant test also pins `rolling ⟹ !backfillable`.
   */
  backfillable: boolean;
  /**
   * Where `startDate` came from. Separate from {@link ReportProvenance}, which
   * describes the URL PATTERN — a family can have a proven URL and a guessed
   * floor, which was true of 28 rows before the MONEY-941 floor walk.
   *
   * "assumed" means the `nse()` helper default (2020-01-01) or a hand-picked
   * date, and a backfill driven off it will silently skip real history — the
   * walk found families reaching back 8 and 12 years further than assumed.
   */
  startDateProvenance?: "probed" | "assumed";
  /**
   * Last date this family published, for ERA-BOUNDED sources — the legacy
   * NSE formats stopped at the UDiFF cutover (2024-07-05). Omit for families
   * that are still publishing.
   */
  endDate?: string;
  /**
   * Object filename for the archive when the URL cannot supply a usable one.
   *
   * The `/api/reports` door is a REST route, so `buildFeedArchiveKey` derives
   * the basename from the path and gets `reports`, then appends the whole query
   * string as a collision discriminator — producing object names like
   * `2026-08-07-reports?archives=%5B%7B%22name%22%3A%22Approved…`. Unreadable,
   * and with no extension `feedContentType` cannot infer `application/zip`, so
   * a 68 KB zip is stored as `application/octet-stream`.
   *
   * That is tolerable for 5 objects and not for the tens of thousands P3 will
   * write, which is why this lands BEFORE any backfill code.
   */
  buildBasename?(date: Date): string;
  provenance: ReportProvenance;
  /**
   * The file has no date in its name and is overwritten upstream (index
   * constituent lists). Archive a DATED copy anyway so membership history
   * accrues — that history is the entire analytical value, and it does not
   * exist anywhere else once the file is overwritten.
   */
  rolling?: boolean;
  /**
   * Families addressed by a DATE RANGE rather than a single day.
   *
   * BSE's index history is served by
   * `ProduceCSVForDate?dtFromDate=…&dtToDate=…`, so one request returns a whole
   * span. Walking it day by day would issue 30 requests for data the first one
   * already returned — and against a rate-limited host that is not a
   * micro-optimisation but the difference between a walk that finishes and one
   * that gets blocked. `chunkDays` is the window the walker steps by instead.
   */
  chunkDays?: number;
  // NOTE: an `alsoCurrent` flag was removed here. It promised an undated
  // `current/` copy alongside the dated one, was set on all 8 index-constituent
  // rows, and was read by NOTHING — so the key its JSDoc advertised was a
  // permanent 404. Writing it would need a SECOND getFeedAsset call per family
  // per day (the seam couples fetching to archiving), i.e. 8 extra daily
  // requests for bytes already in hand. The dated copies ARE the record; a
  // reader wanting "today's membership" takes the newest dated key.
  /**
   * NSE `daily-reports` fileKeys this family covers, e.g.
   * `["EGR-NCL-CONTRACT-DELTA"]`.
   *
   * The drift guard diffs NSE's published fileKeys against this union. Without
   * it the guard was comparing NSE's namespace to our internal `id` namespace —
   * two sets that never intersect — so every observed key counted as
   * "unregistered" and the number it printed was meaningless. Only families
   * that declare their keys can participate, which keeps the coverage honest:
   * an unmapped family is visibly unmapped rather than silently miscounted.
   */
  nseFileKeys?: readonly string[];
  /**
   * The `/api/reports` archives-door descriptor for this family, when known.
   *
   * P1 CONFIRMED the door serves OLD dates (15-Mar-2019 returned a real file
   * body), which makes it a genuine fallback when `nsearchives` throttles a
   * long backfill. The mechanism is wired in `feed-backfill.ts`; this field is
   * what arms it per family.
   *
   * ## Deliberately EMPTY on every row today
   *
   * The door's `name` is NOT the name `daily-reports` returns. The live index
   * calls the volatility file `"Daily Volatility (CSV)"`, while the door
   * accepts `"CM - Daily Volatility"` — so the two vocabularies are related but
   * not identical, and three tuples built from the daily-reports names were
   * probed and rejected.
   *
   * A wrong door name 404s exactly like an absent file, which is the failure
   * this whole registry is built to avoid, so nothing is populated on a guess.
   * To arm a family: capture the real XHR from the `all-reports` page for that
   * report, confirm it against a date the file is KNOWN to exist for (not one
   * that predates the feed — two of the three failed probes were mine choosing
   * 2019 dates for feeds starting in 2024), then fill this in.
   */
  doorDescriptor?: {
    name: string;
    type: string;
    category: string;
    section: string;
    topLevelType: string;
  };
  notes: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** A family that is simply "this path, keyed by this token". */
function nse(
  id: string,
  feed: string,
  path: (d: Date) => string,
  opts: Partial<ReportFamily> & { format: ReportFormat; notes: string },
): ReportFamily {
  return {
    id,
    exchange: "NSE",
    feed,
    buildUrl: (d) => `${NSE_ARCHIVES}${path(d)}`,
    cadence: "daily",
    startDate: "2020-01-01",
    enabled: false,
    // Every family built by this helper keys its path on the date, so asking
    // for a past day returns THAT day. Overridable via `opts` for exceptions.
    backfillable: true,
    provenance: "unverified",
    ...opts,
  } as ReportFamily;
}

/**
 * NSE index-constituent lists.
 *
 * These have NO date in the filename — NSE overwrites one file per index in
 * place. Archiving only a `current/` copy would therefore preserve exactly one
 * day of membership and destroy the rest, which is backwards: the whole point
 * of capturing constituents is the HISTORY (index inclusions/exclusions are a
 * well-known return driver, and nobody publishes the back series for free).
 * So each is archived under a DATED key as well, and the accumulated dated
 * copies become the membership time series.
 */
function nseIndexList(slug: string, label: string): ReportFamily {
  return {
    id: `nse-index-constituents-${slug}`,
    exchange: "NSE",
    feed: `index-constituents/${slug}`,
    buildUrl: () => `${NSE_ARCHIVES}/content/indices/ind_${slug}list.csv`,
    cadence: "daily",
    startDate: "2020-01-01",
    format: "csv",
    enabled: true,
    // Undated URL: a "2019" fetch returns TODAY's membership and would archive
    // it under a 2019 key. Membership history therefore begins at the P2
    // deploy date and cannot be recovered — see the header's "no obtainable
    // history" note.
    backfillable: false,
    provenance: "p2-probed",
    rolling: true,
    notes: `${label} constituents. Undated upstream — dated copies accrue the membership history from the P2 deploy date onward; earlier membership is NOT obtainable.`,
  };
}

/**
 * NSE's `/api/reports` door — the ONLY route to several report families.
 *
 * Captured from the live site (MONEY-1097), not guessed. P1's guesses at this
 * shape were wrong in ways worth recording, because each looked reasonable:
 *   - Debt is `section: "debt-segment"`, NOT `"debt"`, and needs a top-level
 *     `type=debt-segment` alongside the one inside `archives`.
 *   - Mutual Fund is `type: "monthly-reports"`, NOT `"archives"`, carries a
 *     top-level `type=mutual-fund`, and takes NO date at all.
 * Both answered 404 on the guessed shape, which is why they shipped disabled.
 *
 * Verified to work WITHOUT the cookie handshake: both return a real
 * `application/zip` (39 KB / 68 KB) to plain exchange headers, so these can go
 * through `getFeedAsset` unchanged and do NOT need `requiresApi`.
 */
function nseReportsDoor(opts: {
  name: string;
  type: string;
  category: string;
  section: string;
  topLevelType: string;
  dated: boolean;
}): (d: Date) => string {
  return (d: Date) => {
    const archives = encodeURIComponent(
      JSON.stringify([
        {
          name: opts.name,
          type: opts.type,
          category: opts.category,
          section: opts.section,
        },
      ]),
    );
    const date = opts.dated ? `&date=${tokDashMonTitle(d)}` : "";
    return `${NSE_WWW}/api/reports?archives=${archives}${date}&type=${opts.topLevelType}&mode=single`;
  };
}

/** One monthly Capital-Market > Mutual Fund file. */
function nseMutualFundMonthly(slug: string, name: string): ReportFamily {
  return {
    id: `nse-mf-${slug}`,
    exchange: "NSE",
    feed: `mutual-fund/${slug}`,
    buildUrl: nseReportsDoor({
      name,
      type: "monthly-reports",
      category: "capital-market",
      section: "mutual-fund",
      topLevelType: "mutual-fund",
      dated: false,
    }),
    cadence: "monthly",
    startDate: "2020-01-01",
    format: "zip",
    enabled: true,
    // Undated URL — same corruption hazard as the constituent lists.
    backfillable: false,
    // Without this the object lands as
    // `2026-08-07-reports?archives=%5B%7B%22name%22%3A%22Approved…` with no
    // extension, so feedContentType cannot infer application/zip.
    buildBasename: (d: Date) => `${slug}_${tokYYYYMMDD(d).slice(0, 6)}.zip`,
    provenance: "api-captured",
    // Undated upstream: the URL carries no date, so it always serves the
    // CURRENT month. `rolling` puts the fetch day in the archive key, without
    // which every month would overwrite the last and the series would never
    // accumulate — which is the entire reason to archive these.
    rolling: true,
    notes: `Monthly "${name}" from the Capital Market > Mutual Fund section. URL captured live; no date param exists, so the archive key is the FETCH month.`,
  };
}

// ─── The registry ────────────────────────────────────────────────────

export const REPORT_REGISTRY: readonly ReportFamily[] = [
  // ── NSE: the files production already fetches ──────────────────────
  // Registry rows point at the SAME feed slugs the bhavcopy worker uses, so the
  // archive object is shared rather than duplicated under a second name.
  {
    id: "nse-cm-udiff-bhavcopy",
    exchange: "NSE",
    feed: "bhavcopy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`,
    cadence: "daily",
    startDate: "2024-01-01",
    startDateProvenance: "probed", // floor walk confirmed: no data in the 2 preceding years
    format: "zip",
    enabled: false,
    // bhavcopy-sync owns the DAILY fetch (hence enabled:false), but only a backfill can walk its history — the single most important historical feed we have.
    backfillable: true,
    nseFileKeys: ["CM-UDIFF-BHAVCOPY-CSV"],
    provenance: "existing-code",
    notes:
      "INVENTORY ONLY — deliberately NOT enabled. `bhavcopy-sync` already fetches this exact URL nightly (buildNseBhavcopyUrl / buildNseIndicesUrl / buildBseBhavcopyUrl in bhavcopy.ts) and writes it to the SAME GCS key. Enabling it here would fetch the identical bytes a second and third time each weekday (19:30 + 21:45 on top of 21:00) from hosts that 403 under load, against MONEY-840's scrape-once principle, and `completedFamilyIds` cannot dedupe across jobs because it only queries syncType REPORT_ARCHIVE. The row exists so the registry is a complete inventory and the drift guard can see the family.",
  },
  {
    id: "nse-indices-close",
    exchange: "NSE",
    feed: "indices",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/indices/ind_close_all_${tokDDMMYYYY(d)}.csv`,
    cadence: "daily",
    startDate: "2012-01-01",
    startDateProvenance: "probed", // floor walk found data in 2012 (was assumed 2020-01-01) — 8 further years of index closes
    format: "csv",
    enabled: false,
    // Same split as the CM bhavcopy: daily belongs to bhavcopy-sync, history belongs to the backfill.
    backfillable: true,
    provenance: "existing-code",
    notes:
      "INVENTORY ONLY — deliberately NOT enabled. `bhavcopy-sync` already fetches this exact URL nightly (buildNseBhavcopyUrl / buildNseIndicesUrl / buildBseBhavcopyUrl in bhavcopy.ts) and writes it to the SAME GCS key. Enabling it here would fetch the identical bytes a second and third time each weekday (19:30 + 21:45 on top of 21:00) from hosts that 403 under load, against MONEY-840's scrape-once principle, and `completedFamilyIds` cannot dedupe across jobs because it only queries syncType REPORT_ARCHIVE. The row exists so the registry is a complete inventory and the drift guard can see the family.",
  },
  {
    id: "nse-fo-udiff-bhavcopy",
    exchange: "NSE",
    feed: "fo-bhavcopy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/fo/BhavCopy_NSE_FO_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`,
    cadence: "daily",
    startDate: "2024-01-01",
    startDateProvenance: "probed", // floor walk confirmed: no data in the 2 preceding years
    format: "zip",
    enabled: true,
    backfillable: true,
    provenance: "p2-probed",
    notes:
      "Derivatives UDiFF. --registry confirmed it live (1.06 MB), so the path that merely mirrored CM is now evidence.",
  },

  // ── NSE: P1-verified ───────────────────────────────────────────────
  {
    id: "nse-sec-bhavdata-full",
    exchange: "NSE",
    feed: "sec-bhavdata-full",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/products/content/sec_bhavdata_full_${tokDDMMYYYY(d)}.csv`,
    cadence: "daily",
    startDate: "2019-10-01",
    startDateProvenance: "probed", // floor walk confirmed: no data in the 2 preceding years
    format: "csv",
    enabled: true,
    backfillable: true,
    nseFileKeys: ["CM-BHAVDATA-FULL"],
    provenance: "p1-verified",
    notes:
      "Price + delivery in one row. P1 bracketed the floor to ~(2019-09-18, 2019-10-01]; startDate takes the conservative end.",
  },
  {
    id: "nse-mto-delivery",
    exchange: "NSE",
    feed: "mto",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/archives/equities/mto/MTO_${tokDDMMYYYY(d)}.DAT`,
    cadence: "daily",
    startDate: "2002-01-01",
    startDateProvenance: "probed", // floor walk found data in 2002, consistent with P1's (27-Sep-2002, 01-Apr-2003] bracket
    format: "dat",
    enabled: true,
    backfillable: true,
    nseFileKeys: ["CM-SECWISE-DELIVERY-POSITION"],
    provenance: "p1-verified",
    notes:
      "Security-wise delivery position. P1: absent 1999, present 2003-04-01, floor ~(2002-09-27, 2003-04-01]. Pre-2019 this is the ONLY delivery source (sec_bhavdata_full starts 2019).",
  },
  {
    id: "nse-cd-udiff-bhavcopy",
    exchange: "NSE",
    feed: "cd-bhavcopy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/archives/cd/bhav/BhavCopy_NSE_CD_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`,
    cadence: "daily",
    startDate: "2024-01-02",
    startDateProvenance: "probed", // floor walk confirmed: no data in the 2 preceding years
    format: "zip",
    enabled: true,
    backfillable: true,
    provenance: "p1-verified",
    notes:
      "Currency derivatives UDiFF. Archive-only. P1 confirmed Jan-2024 onward.",
  },
  {
    id: "nse-com-udiff-bhavcopy",
    exchange: "NSE",
    feed: "com-bhavcopy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/com/BhavCopy_NSE_CO_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`,
    cadence: "daily",
    startDate: "2024-01-02",
    startDateProvenance: "probed", // floor walk confirmed: no data in the 2 preceding years
    format: "zip",
    enabled: true,
    backfillable: true,
    provenance: "p1-verified",
    notes: "Commodity UDiFF. Archive-only. P1 confirmed Jan-2024 onward.",
  },
  {
    id: "nse-egr-bhavcopy",
    exchange: "NSE",
    feed: "egr-bhavcopy",
    buildUrl: (d) => `${NSE_ARCHIVES}/archives/egr/EG_BC${tokDDMMYYYY(d)}.DAT`,
    cadence: "daily",
    startDate: "2026-05-01",
    format: "dat",
    enabled: true,
    backfillable: true,
    provenance: "api-captured",
    nseFileKeys: ["EGR-NCL-CONTRACT-DELTA"],
    notes:
      "Electronic Gold Receipts bhavcopy. Pattern taken verbatim from the live daily-reports?key=EGR payload (fileKey EGR-NCL-CONTRACT-DELTA, fileActlName EG_BC{DDMMYYYY}.DAT, filePath /archives/egr/). The drift guard polls that key weekly for NEW EGR fileKeys.",
  },

  // ── NSE: equity market quality / surveillance (inventory) ──────────
  nse(
    "nse-52wk-high-low",
    "52wk-high-low",
    (d) => `/content/CM_52_wk_High_low_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-52 WEEK-HIGH_LOW"],
      startDateProvenance: "probed",
      // floor walk: nothing in the 2 preceding years — 2020 default confirmed
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "52-week high/low per security.",
    },
  ),
  nse(
    "nse-pe-ratio",
    "pe-ratio",
    (d) => `/content/equities/peDetail/PE_${tokDDMMYY(d)}.csv`,
    {
      nseFileKeys: ["CM-PE-RATIO-CSV"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      notes:
        "Per-symbol P/E and adjusted P/E (SYMBOL,SYMBOL P/E,ADJUSTED P/E), ~44.7 KB/day. NOTE the cautionary tale: the first draft used the indices-close path as a placeholder, and the --registry probe reported PRESENT — because it was faithfully fetching the indices file under a second name, byte-identical at 17,122 B. A PRESENT verdict is only evidence when the URL is the one you MEANT; the byte count is what exposed it. The real path was then probed directly.",
    },
  ),
  nse(
    "nse-eq-band-changes",
    "band-changes",
    (d) => `/content/equities/eq_band_changes_${tokDDMMYYYY(d)}.csv`,
    {
      startDate: "2008-01-01",
      startDateProvenance: "probed",
      // floor walk: data found in 2008, 12y deeper than the assumed 2020 default
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Price-band changes.",
    },
  ),
  nse(
    "nse-sec-list",
    "sec-list",
    (d) => `/content/equities/sec_list_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-PRICEBAND-COMPLETE-LIST"],
      startDateProvenance: "probed",
      // floor walk: nothing in the 2 preceding years — 2020 default confirmed
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Band-complete securities list.",
    },
  ),
  nse(
    "nse-surveillance-reg",
    "surveillance-reg",
    (d) => `/content/equities/REG_IND_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-SURVEILLANCE-INDICATOR-CSV"],
      format: "csv",
      notes:
        "Surveillance indicator (REG_IND). [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-surveillance-reg1",
    "surveillance-reg1",
    (d) => `/content/equities/REG1_IND_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-SURVEILLANCE-INDICATOR-NEW-CSV"],
      format: "csv",
      notes:
        "Surveillance indicator (REG1_IND). [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  // MONEY-1189 — the live replacements for the two 404 entries above. Probed
  // 2026-08-12 from our own egress with the cookie client: reportASM returned
  // {longterm:{data:[132]}, shortterm:{data:[66]}} and reportGSM a bare array
  // of 82, every row carrying symbol + ISIN + survDesc.
  //
  // NOT backfillable — and this is the reason the archive families still
  // matter. Both endpoints serve only the CURRENT list; there is no date
  // parameter and no history. Depth therefore accrues only from the day we
  // start archiving forward, which is why `archiveNseJsonResponse` covers them.
  {
    id: "nse-asm-api",
    exchange: "NSE",
    feed: "asm-api",
    buildUrl: () => `${NSE_WWW}/api/reportASM`,
    cadence: "daily",
    startDate: "2026-08-12",
    format: "json",
    requiresApi: true,
    // MONEY-1238 — was `true`, and could never have worked. The nightly fetch
    // path has no cookie jar (see `requiresApi`), so this row asked
    // report-archive-sync to fetch a cookie-gated endpoint with plain headers:
    // a challenge page, `rejected`, nightly, under a feed slug (`NSE/asm-api`)
    // that has never held a byte and never could.
    //
    // Nothing is lost by disabling it, and that is measured rather than hoped.
    // The SAME URL is fetched every day by
    // `workers/src/processors/surveillance-sync.ts` through `fetchNseApiJson`
    // (the cookie client) and archived by `archiveNseJsonResponse`, which maps
    // `reportASM` → `feeds/NSE/api/surveillance-asm/{YYYY}/{MM}/…`. The row
    // stays because its `id` IS `StockFlag.source` for that job
    // (`stock-flags.ts` STOCK_FLAG_SOURCES.asm) — deleting it would orphan the
    // provenance chip the stock page renders.
    enabled: false,
    backfillable: false,
    provenance: "p1-verified",
    notes:
      "Additional Surveillance Measure (long + short term). Current list only — no history. Replaces the 404 nse-surveillance-reg path for ASM. NOT fetched by report-archive-sync (requiresApi — no cookie jar on that path); the live fetch is workers/src/processors/surveillance-sync.ts via fetchNseApiJson, archived under feeds/NSE/api/surveillance-asm/.",
  },
  {
    id: "nse-gsm-api",
    exchange: "NSE",
    feed: "gsm-api",
    buildUrl: () => `${NSE_WWW}/api/reportGSM`,
    cadence: "daily",
    startDate: "2026-08-12",
    format: "json",
    requiresApi: true,
    // MONEY-1238 — see the ASM row directly above; identical reasoning.
    // `reportGSM` → `feeds/NSE/api/surveillance-gsm/{YYYY}/{MM}/…` via
    // surveillance-sync, and this id is STOCK_FLAG_SOURCES.gsm.
    enabled: false,
    backfillable: false,
    provenance: "p1-verified",
    notes:
      "Graded Surveillance Measure. Current list only. `gsmStage` is the surveillance CODE number in Roman numerals, NOT the stage — parse survDesc. NOT fetched by report-archive-sync (requiresApi — no cookie jar on that path); the live fetch is workers/src/processors/surveillance-sync.ts via fetchNseApiJson, archived under feeds/NSE/api/surveillance-gsm/.",
  },
  nse(
    "nse-series-change",
    "series-change",
    (d) => `/content/equities/series_change_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Settlement-series changes — the upstream truth for MONEY-1093 reclassification. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-shortselling",
    "shortselling",
    (d) => `/archives/equities/shortSelling/shortselling_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-SHORT-SELLING"],
      startDate: "2012-01-01",
      startDateProvenance: "probed",
      // floor walk: data found in 2012, 8y deeper than the assumed 2020 default
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Scrip-wise short-selling positions.",
    },
  ),
  nse(
    "nse-stt",
    "stt",
    (d) => `/archives/equities/stt/C_STT_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-STT-NON-APPLICABILITY"],
      format: "csv",
      notes:
        "Securities transaction tax, scrip-wise. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-stt-ind",
    "stt-ind",
    (d) => `/archives/equities/stt/C_STT_IND_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CM-STT-EQUITY-ORIENTED-FUND"],
      format: "csv",
      notes:
        "Securities transaction tax, index/derivatives. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-ael",
    "ael",
    (d) => `/archives/equities/ael/AEL_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Additional eligible list. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),

  // ── NSE: deals — ROLLING files, dated by FETCH day ─────────────────
  // bulk.csv / block.csv are single rolling files with no date in the name.
  // The dated archive key therefore records WHEN WE FETCHED, not the trade date
  // of every row inside — a distinction that matters to whoever parses these
  // later, so it is stated here rather than left to be rediscovered.
  {
    id: "nse-bulk-deals",
    exchange: "NSE",
    feed: "bulk-deals",
    buildUrl: () => `${NSE_ARCHIVES}/content/equities/bulk.csv`,
    cadence: "daily",
    // Rolling and undated: there is no history to have a floor FOR. Left as
    // the nominal date; `backfillable: false` is what actually governs it.
    startDate: "2020-01-01",
    format: "csv",
    enabled: true,
    // ROLLING: one undated file. A dated fetch would archive TODAY's deals under a past key. Deal history comes from the historicalOR API in P4, not from here.
    backfillable: false,
    nseFileKeys: ["CM-BULK-DEAL"],
    provenance: "p2-probed",
    rolling: true,
    notes:
      "Bulk deals. ROLLING: one undated file upstream, so the dated archive key is the FETCH day, not the trade date of its rows.",
  },
  {
    id: "nse-block-deals",
    exchange: "NSE",
    feed: "block-deals",
    buildUrl: () => `${NSE_ARCHIVES}/content/equities/block.csv`,
    cadence: "daily",
    startDate: "2020-01-01",
    format: "csv",
    enabled: true,
    // ROLLING: same as bulk deals.
    backfillable: false,
    nseFileKeys: ["CM-BLOCK-DEAL"],
    provenance: "p2-probed",
    rolling: true,
    notes: "Block deals. ROLLING: same fetch-day-keyed caveat as bulk deals.",
  },

  // ── NSE: derivatives ───────────────────────────────────────────────
  nse(
    "nse-fo-settlement-price",
    "fo-settlement-price",
    (d) => `/archives/fo/mkt/FOSett_prce_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Daily settlement prices for F&O. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-fo-secban",
    "fo-secban",
    (d) => `/archives/fo/sec_ban/fo_secban_${tokDDMMYYYY(d)}.csv`,
    {
      startDate: "2008-01-01",
      startDateProvenance: "probed",
      // floor walk: data found in 2008, 12y deeper than the assumed 2020 default
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Securities in the F&O ban period.",
    },
  ),
  nse(
    "nse-fo-volt",
    "fo-volatility",
    (d) => `/archives/nsccl/volt/FOVOLT_${tokDDMMYYYY(d)}.csv`,
    {
      startDate: "2012-01-01",
      startDateProvenance: "probed",
      // floor walk: data found in 2012, 8y deeper than the assumed 2020 default
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "F&O underlying volatility.",
    },
  ),
  nse(
    "nse-cm-volt",
    "cm-volatility",
    (d) => `/archives/nsccl/volt/CMVOLT_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Cash-market volatility. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-nccl-oi",
    "nccl-oi",
    (d) => `/archives/nsccl/mwpl/nccloi_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Clearing-corp open interest. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-combine-oi",
    "combine-oi",
    (d) => `/archives/nsccl/mwpl/combineoi_${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Combined open interest. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-combine-oi-deleq",
    "combine-oi-deleq",
    (d) => `/archives/nsccl/mwpl/combineoi_deleq_${tokDDMMYYYY(d)}.csv`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Combined OI including delivery-eligible.",
    },
  ),
  nse(
    "nse-mwpl-cli",
    "mwpl-cli",
    (d) => `/archives/nsccl/mwpl/mwpl_cli_${tokDDMMYYYY(d)}.xls`,
    {
      format: "xls",
      notes:
        "Market-wide position limits, client level. XLS, not CSV. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-oi-cli-limit",
    "oi-cli-limit",
    (d) => `/content/nsccl/oi_cli_limit_${tokDashMonUpper(d)}.lst`,
    {
      format: "lst",
      enabled: true,
      provenance: "p2-probed",
      notes:
        "Client-level OI limits (SYMBOL,CLIENT_LIMIT,EXCHANGE), ~13 KB/day. TWO things were wrong in the first draft and either alone 404s: the extension is `.lst`, not `.xls`, and it lives under /content/nsccl/, not /archives/nsccl/mwpl/. Uses the DD-MON-YYYY UPPERCASE token (07-AUG-2026) — title case 404s here, while `fii_stats` on the same site needs the OTHER casing. Both are pinned by golden tests for that reason.",
    },
  ),
  nse(
    "nse-fao-participant-oi",
    "fao-participant-oi",
    (d) => `/content/nsccl/fao_participant_oi_${tokDDMMYYYY(d)}.csv`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Participant-wise open interest (FII/DII/Pro/Client).",
    },
  ),
  nse(
    "nse-fao-participant-vol",
    "fao-participant-vol",
    (d) => `/content/nsccl/fao_participant_vol_${tokDDMMYYYY(d)}.csv`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Participant-wise volume.",
    },
  ),
  nse(
    "nse-fao-top10cm-to",
    "fao-top10cm-to",
    (d) => `/content/nsccl/fao_top10cm_to_${tokDDMMYYYY(d)}.csv`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "csv",
      notes: "Top-10 clearing-member turnover.",
    },
  ),
  nse(
    "nse-fii-stats",
    "fii-stats",
    (d) => `/content/fo/fii_stats_${tokDashMonTitle(d)}.xls`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "xls",
      notes:
        "FII derivatives statistics. Uses the DD-Mon-YYYY TITLE-case token (08-Aug-2026) — deliberately different casing from oi_cli_limit on the same site.",
    },
  ),

  // ── NSE: Market Pulse (monthly PDF) — MONEY-1187 P11 item 8 ────────
  nse(
    "nse-market-pulse",
    "market-pulse",
    (d) =>
      `/web/mediaattachment/${tokIsoMonth(d)}/Market_Pulse_${tokMonthNameTitle(d)}_${istParts(d).y}.pdf`,
    {
      enabled: true,
      provenance: "p2-probed",
      format: "pdf",
      cadence: "monthly",
      // NSE's flagship monthly market review, 5–15 MB of PDF. Ranged-GET probed
      // 2026-08-13/14 (HEAD returns 503 on this host; `Range: bytes=0-0` returns
      // 206 + application/pdf, and no cookies are needed — unlike the JSON API
      // on www).
      //
      // 206 for Dec-2025 and Feb→Jul-2026: six consecutive months. That is what
      // makes this "probed" rather than "unverified" — but read the notes, the
      // coverage is NOT total.
      startDate: "2025-12-01",
      notes:
        "NSE's monthly market review PDF. TWO INDISTINGUISHABLE 404 CAUSES, so this family must NOT treat a 404 as permanent: (a) not published yet — the issue reviews the month just ended, so the current month 404s until it appears, and (b) SPECIAL EDITIONS are named differently — Jan-2026 is the 'Annual Edition' and 404s on this mechanical filename while Dec-2025 and Feb-2026 both return 206. Needs an aging/retry policy. Uses TWO tokens that exist nowhere else in this registry: the YYYY-MM path segment (tokIsoMonth) and the FULL month name in title case (tokMonthNameTitle, 'August'). The abbreviated tokDashMonTitle form ('Aug') 404s. A pre-2025 legacy path exists under /web/sites/default/files/inline-files/ and also returns 206, but it mixes spaces and underscores inconsistently and carries _0 dedupe suffixes — it needs a scraped index, not a token, so it is deliberately NOT built here.",
    },
  ),

  // ── NSE: masters (gz) ──────────────────────────────────────────────
  nse(
    "nse-cm-security-master",
    "cm-security-master",
    (d) => `/content/master/NSE_CM_security_${tokDDMMYYYY(d)}.csv.gz`,
    {
      nseFileKeys: ["NSE-CM-SECURITY-CSV", "BSE-CM-SECURITY-CSV"],
      format: "gz",
      notes:
        "Cash-segment security master, gzipped. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-fo-contract-master",
    "fo-contract-master",
    (d) => `/content/master/NSE_FO_contract_${tokDDMMYYYY(d)}.csv.gz`,
    {
      format: "gz",
      notes:
        "Derivatives contract master, gzipped. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),

  // ── NSE: SLB (securities lending & borrowing) ──────────────────────
  //
  // MONEY-1200. All four paths below were WRONG until 2026-08-14, and the
  // 2026-08-08 probe that recorded "404 — this exact path is WRONG" was right
  // about the fact and wrong about the implication: the conclusion drawn was
  // that SLB might not be published, when in truth every one of these was off
  // by a directory name or a separator.
  //
  //   wanted                                   published
  //   /archives/slbs/bhav/SLBM_BC{d}.csv       /archives/slbs/bhavcopy/SLBM_BC_{d}.DAT
  //   /archives/slbs/openpos/…                 /archives/slbs/open_pos/…
  //   /content/slbs/SLB_ELG_SEC_{d}.csv        /archives/slbs/seclist/SLB_ELG_SEC_{d}.csv
  //
  // The answer was already inside the building. NSE's own report index —
  // `https://www.nseindia.com/api/daily-reports?key=SLBS`, one of the twelve
  // keys `runDriftGuard` has polled weekly since MONEY-1097 — returns
  // `filePath` and `fileActlName` for all five SLBS reports, fully qualified.
  // It answers over plain HTTPS with a browser UA and NO cookie warm-up, and
  // it 200s while www.nseindia.com's HTML homepage 403s from the same egress,
  // so the Akamai block on the site is not a block on this index. When a
  // family in this registry 404s, read that index BEFORE guessing a path: five
  // more candidate URLs were guessed and probed on 2026-08-14, all 404, and
  // the index had the answer on the first call.
  //
  // The fifth SLBS key, `SLBS-BEGIN-DAY-VAR` (C_VAR1_SLB_{d}_1.DAT, ~4.9 MB
  // daily), is deliberately NOT registered — see this file's header, "VaR DAT
  // files" are explicitly excluded as margin-engine inputs. It will therefore
  // show up permanently in the drift guard's INFORMATIONAL `unregistered`
  // list. That is correct, not a gap to close.
  //
  // Every URL below was fetched live on 2026-08-14 for trading day
  // 13-Aug-2026 (see per-family notes for status + size + first bytes).
  // Extensions are CASE-SENSITIVE: `.DAT` and `.CSV` in lowercase both 404.
  nse(
    "nse-slb-bhavcopy",
    "slb-bhavcopy",
    (d) => `/archives/slbs/bhavcopy/SLBM_BC_${tokDDMMYYYY(d)}.DAT`,
    {
      nseFileKeys: ["SLBS-BHAVCOPY-DAT"],
      format: "dat",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2013-01-01",
      notes:
        "SLB bhavcopy — per-contract lending trades. LIVE-VERIFIED 2026-08-14: 200, application/octet-stream, 31,556 bytes for 13-Aug-2026; first row `ABB INDIA LIMITED             ,ABB       ,S1,01-SEP-2026,N,0000114.38,…`. HEADERLESS, 17 comma-separated fixed-width-padded fields, .DAT not .csv despite being comma-delimited (NSE's own displayName is 'Bhavcopy Download (DAT)'). Fields 3+4 are series+expiry, which is the ONLY place the SLB series ladder is decoded — X9→01-SEP-2026 and X8→03-AUG-2027 on the same day, i.e. the code carries a month but not a year. Probed 200 back to 02-Jan-2013. No parser yet; archive-first.",
    },
  ),
  nse(
    "nse-slb-openpos",
    "slb-openpos",
    (d) => `/archives/slbs/open_pos/slb_openpos_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SLBS-OPEN-POSITION"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2013-01-01",
      notes:
        "SLB open positions — the borrow-demand series, and the closest thing India publishes to single-stock short interest. LIVE-VERIFIED 2026-08-14: 200, text/csv, 11,577 bytes for 13-Aug-2026; header `Sr no,Security,Series,Outstanding Quantity at the end of the day`, first row `1,360ONE,X1,2`. Header byte-identical on every day sampled 2020→2026. Date-addressable (200 back to 02-Jul-2012; Saturday 16-Aug-2026 and the 15-Aug holiday both 404, so absence stays legible). PARSE HAZARD: one row per (security, SERIES), not per security — 605 rows / 331 symbols on 13-Aug-2026 — so SlbPosition's @@unique([symbol,date]) collides and feed-parse's upsert would keep the last row and drop 84.2% of the open interest. Fix the writer or the unique BEFORE parsing; see the SLB block in market-data/deals.ts.",
    },
  ),
  nse(
    "nse-slb-eligible",
    "slb-eligible",
    (d) => `/archives/slbs/seclist/SLB_ELG_SEC_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SLBS-ELIGIBLE-SECURITIES-LIST"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2013-01-01",
      notes:
        "SLB eligible securities — which names may be lent/borrowed, per market type. LIVE-VERIFIED 2026-08-14: 200, text/csv, 809,242 bytes for 13-Aug-2026; header `Sr.No.,Symbol,Series,Normal Eligibility,Recall Eligibility,Repay Eligibility,Market Type`, first row `1,11NSETEST,01,E,E,E,N`. NOTE its Series namespace is NUMERIC ('01','02',…), a THIRD namespace distinct from the openpos X-codes and the bhavcopy S1/X-codes — do not join the three on series without a mapping. Probed 200 back to 02-Jan-2013. No parser yet; archive-first.",
    },
  ),
  nse(
    "nse-slb-foreclosure",
    "slb-foreclosure",
    (d) => `/content/slbs/Forclosure_SLB_${tokYYYYMMDD(d)}.CSV`,
    {
      nseFileKeys: ["SLBS-FORCLOSURE-REPORT"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2018-01-01",
      notes:
        "SLB foreclosure report — lending contracts force-closed for corporate actions. NEW family (MONEY-1200): it was never registered, and it surfaced only because the daily-reports?key=SLBS index lists it. LIVE-VERIFIED 2026-08-14: 200, text/csv, 444 bytes for 13-Aug-2026; header `SECURITY,SERIES**,ISIN,ANNOUNCEMENT DATE,BOOK CLOSURE START DATE,RECORD DATE,EX DATE,FORECLOSURE DATE,…`. TWO SPELLING TRAPS, both NSE's: the filename misspells it 'Forclosure' (no 'e'), and the extension is UPPERCASE .CSV — the lowercase .csv 404s. It is also the only SLB family on the tokYYYYMMDD token and under /content/ rather than /archives/slbs/; the other three use tokDDMMYYYY. Probed 200 back to 03-Jan-2018, 404 at 02-Jan-2013. No parser yet; archive-first.",
    },
  ),

  // ── NSE: debt — WDM + CBM (MONEY-1201) ─────────────────────────────
  //
  // Same unblocking technique as SLB (MONEY-1200): NSE's own report index,
  // `https://www.nseindia.com/api/daily-reports?key=CBM` and `?key=WDM`. Both
  // 200 COOKIELESSLY to a browser UA + `Referer: .../all-reports` from the same
  // egress whose HTML homepage Akamai 403s — the site being blocked is not the
  // index being blocked. `?key=DEBT` also 200s but returns
  // `{"data":[],"msg":"no data found"}` in 33 bytes: a 200 carrying an ERROR
  // ENVELOPE, which is why nothing is registered from it.
  //
  // ## The index is AUTHORITATIVE but NOT INFALLIBLE
  //
  // This is the correction to the lesson SLB taught ("read the index BEFORE
  // guessing"). For `WDM-SEC-AVAILABLE-FOR-TRADE` the index was reported
  // publishing `/content/historical/WDM/20wdmlist_13082026.csv` — NSE's own
  // template half-substituting its `{YYYY}/{MON}/` segments, leaving a bare
  // `20`. That path 404s (3,546 B of NSE's HTML error page); the path that
  // serves is `/content/historical/WDM/2026/AUG/wdmlist_13082026.csv`
  // (200, 1,243,367 B). Re-probing the index on 2026-08-14 returned the FULL
  // correct `filePath`, so the defect is intermittent, not permanent — which
  // makes it worse, not better: it cannot be detected by reading the index once.
  // Read the index, then FETCH EVERY PATH IT GIVES YOU before registering it.
  //
  // ## Two publication classes, and why they decide `enabled`
  //
  // Probed 2026-08-14 at 18:32 IST, one hour before the 19:30 pass:
  //
  //   CLASS A — day D's file exists ON day D (index `CurrentDay` bucket):
  //     cbm_trd, Corporate_bond_report, wdmlist, dly.zip     -> enabled
  //   CLASS B — day D's file first appears on day D+1 (index lists them only
  //     under `PreviousDay`): the five /content/cbm/, both /content/cd/, the
  //     five /content/sdi/, and GSEC                          -> NOT enabled
  //
  // Both daily passes (`report-archive-sync-evening` 19:30 and `-night` 21:45,
  // Mon-Fri) call `resolveTargetDay`, which returns the CURRENT trading day on a
  // trading day. A Class B family enabled here would therefore ask for
  // `{name}_{D}` on day D, 404 on both passes, every single day, forever — and
  // that 404 is indistinguishable from a market holiday, which is the exact
  // silent failure this registry exists to prevent. So Class B ships
  // `enabled: false, backfillable: true` — the documented backfill-only
  // quadrant, alongside `nse-cm-udiff-bhavcopy`.
  //
  // Note `provenance: "p2-probed"` on the disabled rows is NOT a contradiction:
  // provenance describes the URL PATTERN (proven — every one returned real dated
  // CSV for 13-Aug-2026), while `enabled` answers "may the NIGHTLY job fetch
  // this?" (no — the schedule is a day early). To flip one, re-probe
  // `{name}_{D}` at >= 21:45 IST on a trading day D and confirm a 200. Do not
  // flip on the assumption that 18:32 was merely too early.
  //
  // ## Deliberately NOT registered
  //
  // The six `WDM-SPAN-*` keys (BEGIN-DAY, INTRA-DAY-1..4, END-DAY;
  // `nsccl_d.{YYYYMMDD}.{i1..i5,s}.zip` under /debt/products/content/). This
  // file's header excludes SPAN risk-parameter files as margin-engine inputs
  // we have no engine for, and the SLB block already left `SLBS-BEGIN-DAY-VAR`
  // unclaimed on the same rule. They will sit in the drift guard's
  // informational `unregistered` list permanently; that is the intended
  // outcome, not a gap.
  //
  // ## Absence stays legible
  //
  // Saturday 15-Aug-2026 (Independence Day) and Sunday 16-Aug-2026 return 404
  // for EVERY family below. NSE's 404 body is a fixed 3,546 B HTML page (3,425 B
  // on the /content/debt/ zip route) — never a 200 carrying a page, so
  // `validateFeedPayload` is not load-bearing here the way it is for BSE.
  nse(
    "nse-corpbond",
    "corpbond",
    (d) => `/archives/equities/corpbond/corpbond_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-CORPBOND"],
      format: "csv",
      notes:
        "Corporate bond trades in the cash segment. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.] MONEY-1201: its claimed fileKey `CBM-CORPBOND` does NOT appear in the live daily-reports?key=CBM payload (15 keys observed 2026-08-14, none of them this one), so the key is stale too. The corporate-bond bhavcopy this row was reaching for is `nse-cbm-trades` (CBM-BHAVCOPY-CSV); prefer that and treat this row as a historical marker.",
    },
  ),

  // --- CLASS A: published SAME DAY — safe for the nightly job ---------
  nse(
    "nse-wdm-list",
    "wdm-list",
    (d) =>
      `/content/historical/WDM/${istParts(d).y}/${tokMonthUpper(d)}/wdmlist_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["WDM-SEC-AVAILABLE-FOR-TRADE"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2005-05-09",
      startDateProvenance: "probed",
      notes:
        "WDM securities available for trading — the wholesale DEBT security master (SECTYPE, SECURITY, ISSUE_NAME/DESC, ISSUE_DATE, MAT_DATE, last/next interest-payment dates, coupon frequency, last traded date + price, ISIN, STATUS). LIVE-VERIFIED 2026-08-14: 200, text/csv, 1,243,367 B for 13-Aug-2026; first row `GS,CG2036,8.33%,GOI LOAN 8.33% 2036,07-Jun-2006,07-Jun-2036,...,IN0020060045,Listed`. THE PATH IS THREE SEGMENTS, NOT ONE: the old `/content/debt/wdmlist_{DDMMYYYY}.csv` 404'd because it dropped the `{YYYY}/{MON}/` tree — and NSE's own index has been seen emitting a half-substituted `/content/historical/WDM/20wdmlist_...` for it. {MON} is the UPPERCASE 3-letter abbreviation (`tokMonthUpper`, same helper as nse-cm-legacy): AUG/JUL/JUN/SEP/DEC all 200, while `Jul` and `jul` both 404 — so it is case-sensitive, not locale-sensitive. Floor bracketed to (2005-05-06, 2005-05-09] — 06-May-2005 404, 09-May-2005 200 at 352,494 B — i.e. ~20 years of debt-master history, NOT the assumed 2020. No parser yet; archive-first.",
    },
  ),
  nse(
    "nse-wdm-daily",
    "wdm-daily",
    (d) => `/content/debt/dly${tokDDMMYYYY(d)}.zip`,
    {
      nseFileKeys: ["WDM-DAILY-REPORT"],
      format: "zip",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2009-11-03",
      startDateProvenance: "probed",
      notes:
        "WDM daily report bundle. LIVE-VERIFIED 2026-08-14: 200, application/zip, 109,340 B for 13-Aug-2026, `PK\\x03\\x04` magic present. TWO things were wrong in the old row and either alone 404s: the directory is /content/debt/, not /archives/wdm/dly/, AND the token is the FOUR-digit-year `tokDDMMYYYY` (dly13082026.zip), not `tokDDMMYY` — the old row's `dly130826.zip` 404s. Floor bracketed to (2009-11-02, 2009-11-03]: 02-Nov-2009 404, 03-Nov-2009 200 at 28,203 B. No parser yet; archive-first — the zip's members are unexamined.",
    },
  ),
  nse(
    "nse-cbm-trades",
    "cbm-trades",
    (d) => `/archives/debt/cbm/cbm_trd${tokYYYYMMDD(d)}.csv`,
    {
      nseFileKeys: ["CBM-BHAVCOPY-CSV"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2007-05-03",
      startDateProvenance: "probed",
      notes:
        "Corporate Bond Market bhavcopy — the debt-segment price series. LIVE-VERIFIED 2026-08-14: 200, text/csv, 44,611 B for 13-Aug-2026; header `Trade Date,ISIN,Last Trade Price (in Rs.),Last Trade Value (Rs. in lacs),Total Trade Value (Rs. in lacs),Last Trade Yield (YTM) (Annualized) (%),Weighted Average Price  (Rs.),Weighted Average Yield (YTM) (%)` (note the DOUBLE SPACE in `Price  (Rs.)` — do not normalise it away when a parser lands), first row `13-Aug-2026,INE498L07210 ,100.6091,...`. ISIN values carry a TRAILING SPACE. Two things were wrong in the old row: the directory is /archives/debt/cbm/, not /content/debt/, and the token is `tokYYYYMMDD` with NO separating underscore (`cbm_trd20260813.csv`), not `cbm_trd_{DDMMYYYY}`. Floor bracketed to (2007-05-02, 2007-05-03]: 02-May-2007 404, 03-May-2007 200 at 311 B. Unlike the /content/ debt families this one is date-addressable AND same-day. No parser yet; archive-first.",
    },
  ),
  nse(
    "nse-corporate-bond-report",
    "corporate-bond-report",
    (d) => `/content/debt/Corporate_bond_report_${tokDashMonTitle(d)}.csv`,
    {
      nseFileKeys: ["CBM-SECURITY-CSV"],
      format: "csv",
      enabled: true,
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "CBM security master / Negotiated Trade Reporting Platform report. LIVE-VERIFIED 2026-08-14: 200, text/csv, 634,520 B for 13-Aug-2026. The PATH was already right; only the TOKEN was wrong — it is `tokDashMonTitle` (`Corporate_bond_report_13-Aug-2026.csv`), the DD-Mon-YYYY title case, NOT `tokDDMMYYYY`. That makes it the third family in this file on the title-case month token (with fii_stats) against oi_cli_limit's UPPERCASE, so it is pinned by a golden test. PARSE HAZARD: this file is NOT a plain table — it opens with banner rows (`,,,National Stock Exchange Of India Limited,,,` then `,,,Negotiated Trade Reporting Platform,,,`) before any header, so a naive header-row-0 reader gets garbage. Floor bracketed to (2019-12-16, 2020-01-02]. No parser yet; archive-first.",
    },
  ),

  // --- CLASS B: published T+1 — proven URLs, backfill-only ------------
  // Every URL below returned real dated CSV for 13-Aug-2026 on 2026-08-14, and
  // every one 404s for its OWN date on that same date. See the section header:
  // enabling them would 404 on both nightly passes forever.
  nse(
    "nse-cbm-list-mandatory",
    "cbm-list-mandatory",
    (d) => `/content/cbm/cbm_list_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-LIST-MANDATORY-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "Listed bonds settled by MANDATORY entities. 200, text/csv, 23,477 B for 13-Aug-2026; header `ISIN,Description,Trade Date,Quantity,Nominal Value,Weighted Average Price,Weighted Average Yield`, first row `INE020B07GH7,RURAL ELEC...`. Shared by all five /content/cbm/ families. Floor bracketed to (2019-10-15, 2020-01-02]. NOTE a real one-day hole ON A TRADING DAY: 15-Jul-2025 404s here and across every /content/cbm/, /content/cd/ and /content/sdi/ family while the CM UDiFF bhavcopy for that day is a healthy 200 — so an in-range 404 is a GAP in NSE's publication, never proof the path is wrong.",
    },
  ),
  nse(
    "nse-cbm-list-non-mandatory",
    "cbm-list-non-mandatory",
    (d) => `/content/cbm/cbm_list_non_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-LIST-NON-MANDATORY-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "Listed bonds settled by NON-MANDATORY entities. 200, text/csv, 57,597 B for 13-Aug-2026; same 7-column header as cbm_list_man, first row `INE0JZO07040,LUCINA LAN...`. The largest of the five /content/cbm/ files. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  nse(
    "nse-cbm-unlisted-mandatory",
    "cbm-unlisted-mandatory",
    (d) => `/content/cbm/cbm_unlist_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-MANDATORY-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "UNLISTED bonds settled by MANDATORY entities. 200, text/csv, 1,121 B for 13-Aug-2026; first row `INE918K07LZ5,NUVAMA WEA...`. NAMING TRAP: NSE's fileKey is the bare `CBM-MANDATORY-CSV` while the FILE is `cbm_unlist_man_` — the key omits the `unlist`, so key and filename disagree about what the family is. The LISTED counterpart is the separately-keyed `CBM-LIST-MANDATORY-CSV`. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  nse(
    "nse-cbm-unlisted-non-mandatory",
    "cbm-unlisted-non-mandatory",
    (d) => `/content/cbm/cbm_unlist_non_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-NON-MANDATORY-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "UNLISTED bonds settled by NON-MANDATORY entities. 200, text/csv, 4,852 B for 13-Aug-2026; first row `INE093J072N3,ANAND RATH...`. Same key-vs-filename mismatch as cbm_unlist_man: the key is the bare `CBM-NON-MANDATORY-CSV`. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  nse(
    "nse-cbm-failed-trades",
    "cbm-failed-trades",
    (d) => `/content/cbm/cbm_fail_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-LIST-TRADES-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "CBM list of FAILED trades — settlement failures, the debt-segment counterpart to a delivery shortage. 200, text/csv, 1,028 B for 13-Aug-2026. THE fileKey IS MISLEADING: `CBM-LIST-TRADES-CSV` reads like a trade list, but NSE's own displayName is 'CBM-List of Failed Trades' and the file is `cbm_fail_`. Do not register a second family for it thinking this key is unclaimed. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  nse(
    "nse-cbm-gsec-settlement",
    "cbm-gsec-settlement",
    (d) =>
      `/archives/debt/cbm/GSEC_SettlementOrderReport_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CBM-GOV-SEC"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-02-17",
      startDateProvenance: "probed",
      notes:
        "Government securities settlement report. 200, text/csv, 3,290 B for the file NAMED 13-Aug-2026. TWO OFFSETS STACK, and both must be understood before anyone parses this: (1) the file named D is first PUBLISHED on D+1 — on 2026-08-14 NSE's index listed `GSEC_..._13082026.csv` under `CurrentDay`/tradingDate 14-Aug while `..._14082026.csv` 404'd; (2) the file named D CONTAINS trades dated D-1 — every row of `..._13082026.csv` reads `Trade Date 12-Aug-26`. So an archive key of D holds D-1's trades, published on D+1. A parser MUST read the in-file Trade Date and MUST NOT derive the trade date from the key. Floor bracketed to (2020-02-03, 2020-02-17]. Publication is sparse even inside the range: 01-Apr-2020 404s (financial-year-end bank closing) while 02-Mar and 15-Apr are 200. Most days are a 105-byte header-only file. This is the ONLY Class B family whose data is NOT keyed by settlement number — despite the name it is keyed by DATE, so this file's header exclusion of 'settlement statistics keyed by SETTLEMENT NUMBER' does NOT apply to it.",
    },
  ),
  nse(
    "nse-cd-settlement",
    "cd-settlement",
    (d) => `/content/cd/CD_SettlementOrderReport_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CD-SETTLEMENT-DETAILS"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "Certificate of Deposit settlement details — money-market issuance our equity feeds cannot see. 200, text/csv, 10,094 B for 13-Aug-2026; header `ISIN,Descriptor,Trade Date,Quantity,Nominal Value,Weighted Average Price (Rs.),Weighted Average Yield (%)` — note `Descriptor`, not the `Description` the /content/cbm/ files use. Lives under /content/cd/, which is NOT the currency-derivatives `cd-bhavcopy` feed. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  nse(
    "nse-cp-settlement",
    "cp-settlement",
    (d) => `/content/cd/CP_SettlementOrderReport_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["CP-SETTLEMENT-DETAILS"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2020-01-02",
      startDateProvenance: "probed",
      notes:
        "Commercial Paper settlement details — corporate short-term borrowing, the closest public read on credit stress in the CP market. 200, text/csv, 4,655 B for 13-Aug-2026, same `Descriptor` header as CD. It shares the /content/cd/ directory with the CD report despite being CP. Floor bracketed to (2019-10-15, 2020-01-02].",
    },
  ),
  // The five Securitised Debt Instrument reports. Registered rather than
  // excluded: none of them matches any category in this file's exclusion list
  // (they are dated, date-addressable trade reports, not SPAN/VaR/haircut/
  // settlement-number-keyed files), and "low volume" is not an exclusion
  // criterion anywhere here. A header-only file is DATA — it asserts "no SDI
  // trades settled that day" — and that series cannot be reconstructed later.
  // All five together are ~1.2 KB/day.
  //
  // PARSE HAZARD for whoever lands the parser: four of the five are 97 bytes
  // (header row, zero data rows) on essentially every date sampled 2014->2026.
  // An empty SDT file is a normal day, NOT a fetch failure.
  nse(
    "nse-sdi-list-mandatory",
    "sdi-list-mandatory",
    (d) => `/content/sdi/sdt_list_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SDT-LIST-MAN-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2014-09-15",
      startDateProvenance: "probed",
      notes:
        "Securitised Debt Instruments, LISTED, settled by mandatory entities. 200, text/csv, 97 B (header only) for 13-Aug-2026; same 7-column `Description` header as the /content/cbm/ files. Note the URL segment is `sdi` while the filename and fileKey are `sdt` — the two spellings are both NSE's and neither is a typo to fix. Floor bracketed to (2014-08-15, 2014-09-15], the deepest of the five.",
    },
  ),
  nse(
    "nse-sdi-failed-trades",
    "sdi-failed-trades",
    (d) => `/content/sdi/sdt_fail_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SDT-LIST-FAILED-TRADES-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2014-09-15",
      startDateProvenance: "probed",
      notes:
        "SDI list of FAILED trades. 200, text/csv, 97 B (header only) for 13-Aug-2026. Same fileKey-vs-filename shape as CBM's failed-trades row: the key says LIST-FAILED-TRADES, the file is `sdt_fail_`. Shares the 2014 floor with sdt_list_man; the other three SDT variants start ~9 years later.",
    },
  ),
  nse(
    "nse-sdi-unlisted-mandatory",
    "sdi-unlisted-mandatory",
    (d) => `/content/sdi/sdt_unlist_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SDT-UNLIST-MAN-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2024-07-15",
      startDateProvenance: "probed",
      notes:
        "SDI, UNLISTED, settled by mandatory entities. 200, text/csv, 97 B (header only) for 13-Aug-2026. Floor bracketed to (2022-07-15, 2024-07-15] — it did NOT exist alongside sdt_list_man, which is why 02-Jan-2020 404s for this row while sdt_list_man returns 192 B on the same day. A single startDate for 'the SDT family' would have manufactured four years of phantom 404s.",
    },
  ),
  nse(
    "nse-sdi-list-non-mandatory",
    "sdi-list-non-mandatory",
    (d) => `/content/sdi/sdt_list_non_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SDT-LIST-NON-MAN-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2024-07-15",
      startDateProvenance: "probed",
      notes:
        "SDI, LISTED, settled by non-mandatory entities. The ONLY one of the five that regularly carries rows: 200, text/csv, 823 B for 13-Aug-2026 (first row `INE2W9A15011,TRUEFORT 0...`), 669 B on 15-Jun-2026, 378 B on 15-Jul-2024. Floor bracketed to (2022-07-15, 2024-07-15].",
    },
  ),
  nse(
    "nse-sdi-unlisted-non-mandatory",
    "sdi-unlisted-non-mandatory",
    (d) => `/content/sdi/sdt_unlist_non_man_${tokDDMMYYYY(d)}.csv`,
    {
      nseFileKeys: ["SDT-UNLIST-NON-MAN-CSV"],
      format: "csv",
      provenance: "p2-probed",
      startDate: "2024-07-15",
      startDateProvenance: "probed",
      notes:
        "SDI, UNLISTED, settled by non-mandatory entities. 200, text/csv, 97 B (header only) for 13-Aug-2026. Floor bracketed to (2022-07-15, 2024-07-15].",
    },
  ),
  nse(
    "nse-tri-party-repo",
    "tri-party-repo",
    (d) => `/archives/trm/bhav/TRM_BC${tokDDMMYYYY(d)}.csv`,
    {
      format: "csv",
      notes:
        "Tri-party repo bhavcopy. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),
  nse(
    "nse-sme-bhavcopy",
    "sme-bhavcopy",
    (d) => `/archives/sme/bhavcopy/sme${tokDDMMYY(d)}.csv`,
    {
      nseFileKeys: ["SME-BHAVCOPY-CSV"],
      format: "csv",
      notes:
        "SME (Emerge) bhavcopy. MONEY-1085 noted the Kite dump omits SME entirely, so this is the only SME price source besides NSE's own master CSV. [--registry probe 2026-08-08: 404 — this exact path is WRONG, not merely unproven. Do not enable without finding the real path first.]",
    },
  ),

  // ── NSE: index constituents (undated upstream, dated here) ─────────
  nseIndexList("nifty50", "Nifty 50"),
  nseIndexList("niftynext50", "Nifty Next 50"),
  nseIndexList("nifty100", "Nifty 100"),
  nseIndexList("nifty500", "Nifty 500"),
  nseIndexList("niftybank", "Nifty Bank"),
  nseIndexList("niftyit", "Nifty IT"),
  nseIndexList("niftymidcap100", "Nifty Midcap 100"),
  nseIndexList("niftysmallcap100", "Nifty Smallcap 100"),

  // ── NSE: shapes P1 actively DISPROVED — disabled on purpose ────────
  // These are not guesses awaiting confirmation; the guessed shapes were tried
  // and returned 404 with `{"error":"Not Found, file is unavailable"}`. They
  // stay as inventory rows so the family is not forgotten, and so nobody
  // re-derives the same wrong URL from the same reasoning.
  {
    id: "nse-debt-weekly-reports",
    exchange: "NSE",
    feed: "debt-weekly-reports",
    buildUrl: nseReportsDoor({
      name: "WDM - Weekly Reports",
      type: "weekly-reports",
      category: "debt",
      section: "debt-segment",
      topLevelType: "debt-segment",
      dated: true,
    }),
    cadence: "weekly",
    startDate: "2020-01-01",
    startDateProvenance: "assumed",
    format: "zip",
    enabled: true,
    backfillable: true,
    // Without this the object is named
    // `reports__archives-5B7B22name223A22WDM20-20Weekly…-d8e0dabf` — unreadable,
    // and extension-less so feedContentType cannot infer application/zip.
    buildBasename: (d: Date) => `WDM-Weekly-Reports_${tokDDMMYYYY(d)}.zip`,
    provenance: "api-captured",
    notes:
      'WDM weekly reports. P1 guessed `section:"debt"` and got a 404; the real value is `section:"debt-segment"` PLUS a top-level `type=debt-segment`. Date token is DD-Mon-YYYY title case. Returns a 39 KB zip to plain exchange headers — no cookie needed.',
  },
  nseMutualFundMonthly(
    "approved-securities",
    "Approved list of Securities (.zip)",
  ),
  nseMutualFundMonthly(
    "approved-mutual-funds",
    "Approved list of Mutual Funds (.zip)",
  ),
  nseMutualFundMonthly(
    "approved-corporate-bond",
    "Approved list of Corporate bond (.zip)",
  ),
  nseMutualFundMonthly(
    "approved-gsec-tbill",
    "Approved list of GSEC and TBILL (.zip)",
  ),

  // ── Index history ──────────────────────────────────────────────────
  {
    id: "nse-index-snapshot",
    exchange: "NSE",
    feed: "index-snapshot",
    buildUrl: (d) =>
      `${NIFTY_INDICES}/Daily_Snapshot/ind_close_all_${tokDDMMYYYY(d)}.csv`,
    cadence: "daily",
    startDate: "2013-04-01",
    startDateProvenance: "assumed",
    format: "csv",
    enabled: false,
    backfillable: true,
    provenance: "p2-probed",
    notes:
      "niftyindices daily all-index snapshot. Live-probed: 01-Jul-2026 returned a real 16.9 KB CSV (`Index Name,Index Date,Open Index Value,…`). enabled:false because bhavcopy-sync already fetches NSE's own ind_close_all daily — this row exists for the HISTORY, which reaches back further than nsearchives keeps it. NOTE niftyindices serves an HTML page (not a 404) for a missing day, so the payload check is what distinguishes a gap here.",
  },
  {
    id: "bse-index-history",
    exchange: "BSE",
    feed: "index-history",
    // Range-addressed: one request covers chunkDays, not one day.
    buildUrl: (d) => {
      const to = new Date(d.getTime() + 29 * 86_400_000);
      return (
        `${BSE_API}/ProduceCSVForDate/w?strIndex=SENSEX` +
        `&dtFromDate=${encodeURIComponent(tokSlash(d))}` +
        `&dtToDate=${encodeURIComponent(tokSlash(to))}&period=D`
      );
    },
    cadence: "daily",
    startDate: "1986-01-01",
    startDateProvenance: "probed",
    chunkDays: 30,
    format: "csv",
    requiresApi: true,
    enabled: false,
    backfillable: true,
    provenance: "p1-verified",
    notes:
      "BSE SENSEX daily history. P1 fetched calendar-1986 successfully (199 rows, 2-Jan-1986 → 24-Dec-1986) — but the early series is CLOSE-ONLY: open/high/low are blank on every row. Whoever parses this must write IndexClose with null OHL rather than zeros, and document that the pre-modern SENSEX series supports levels and returns, not daily ranges.",
  },

  // ── NSE: the LEGACY era (pre-UDiFF) — backfill-only ────────────────
  //
  // These are the headline gap P2 left: zero registry rows could build them, so
  // "NSE CM 1994→" had no URL. Both are `enabled: false` because the era ENDED
  // at the UDiFF cutover — a nightly fetch would 404 forever — and
  // `backfillable: true` because that is precisely what they exist for.
  //
  // ERA OVERLAP (2024-01-01 → 2024-07-05): both the legacy file and the UDiFF
  // file exist. The backfill archives BOTH. UDiFF is canonical for parsing; the
  // overlap is what makes a real parity check possible, since the same trading
  // days are available in two independent formats.
  {
    id: "nse-cm-legacy",
    exchange: "NSE",
    feed: "cm-legacy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/historical/EQUITIES/${istParts(d).y}/${tokMonthUpper(d)}/cm${tokDDMMMYYYY(d)}bhav.csv.zip`,
    cadence: "daily",
    startDate: "1994-11-03",
    endDate: "2024-07-05",
    format: "zip",
    enabled: false,
    backfillable: true,
    provenance: "p1-verified",
    notes:
      "Legacy NSE cash bhavcopy — the ONLY route to pre-2024 equity history. P1 fetched 1994-11-03 and 1994-12-01 successfully. The range is SPARSE, not monotonic: 1994-11-04 returns a genuine 404 while both neighbours exist. An in-range 404 is therefore a GAP, never end-of-history; only K consecutive weekday misses past the floor may end the walk.",
  },
  {
    id: "nse-fo-legacy",
    exchange: "NSE",
    feed: "fo-legacy",
    buildUrl: (d) =>
      `${NSE_ARCHIVES}/content/historical/DERIVATIVES/${istParts(d).y}/${tokMonthUpper(d)}/fo${tokDDMMMYYYY(d)}bhav.csv.zip`,
    cadence: "daily",
    startDate: "2000-06-12",
    endDate: "2024-07-05",
    format: "zip",
    enabled: false,
    backfillable: true,
    provenance: "unverified",
    notes:
      "Legacy NSE derivatives bhavcopy. startDate is the F&O segment's first trading day (2000-06-12). Path mirrors the P1-verified EQUITIES one with DERIVATIVES/fo — NOT independently probed, so the walker's first job is to confirm the floor.",
  },

  // ── BSE ────────────────────────────────────────────────────────────
  {
    id: "bse-cm-udiff-bhavcopy",
    exchange: "BSE",
    feed: "bhavcopy",
    buildUrl: (d) =>
      `${BSE_WWW}/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${tokYYYYMMDD(d)}_F_0000.CSV`,
    cadence: "daily",
    startDate: "2024-01-01",
    format: "csv",
    enabled: false,
    // Same split as the NSE CM bhavcopy.
    backfillable: true,
    provenance: "existing-code",
    notes:
      "INVENTORY ONLY — deliberately NOT enabled. `bhavcopy-sync` already fetches this exact URL nightly (buildNseBhavcopyUrl / buildNseIndicesUrl / buildBseBhavcopyUrl in bhavcopy.ts) and writes it to the SAME GCS key. Enabling it here would fetch the identical bytes a second and third time each weekday (19:30 + 21:45 on top of 21:00) from hosts that 403 under load, against MONEY-840's scrape-once principle, and `completedFamilyIds` cannot dedupe across jobs because it only queries syncType REPORT_ARCHIVE. The row exists so the registry is a complete inventory and the drift guard can see the family.",
  },
  {
    id: "bse-fo-udiff-bhavcopy",
    exchange: "BSE",
    feed: "fo-bhavcopy",
    buildUrl: (d) =>
      `${BSE_WWW}/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_${tokYYYYMMDD(d)}_F_0000.CSV`,
    cadence: "daily",
    startDate: "2024-01-01",
    format: "csv",
    enabled: true,
    backfillable: true,
    provenance: "p1-verified",
    notes:
      "Derivatives UDiFF. NOTE the lowercase-c `Bhavcopy` directory — BSE uses capital-B for Equity and lowercase-b for Derivative. P1 verified both.",
  },
  // ── BSE: the LEGACY era (pre-UDiFF) — backfill-only (MONEY-1101 / P7) ──
  //
  // The BSE counterpart of the NSE legacy block above, and the thing that
  // unblocks P4.1's stranded half: `bse-gross-delivery` is walked back to 2007
  // and parses fine, but it is UPDATE-ONLY — SCBSEALL carries no prices — so
  // every pre-2024 BSE delivery row had no `DailyPrice` to attach to and was
  // counted `no-price-row (pre-2024 BSE days wait for P7)`. These two families
  // ARE that wait: they supply the price rows the delivery leg updates.
  //
  // TWO families, not one, because BSE published two different files over
  // overlapping years and only the later one carries an ISIN:
  //
  //   eq{DDMMYY}_csv.zip        2006 → 2024   14 cols, NO ISIN  → scrip-code join
  //   EQ_ISINCODE_{DDMMYY}.zip  2017 → 2024   18 cols, ISIN     → ISIN@BSE join
  //
  // Both are walked. The ISIN file is the better source wherever it exists, and
  // the overlap is deliberate: it is the only way to parity-check a scrip-code
  // join against an ISIN join on the same trading day.
  //
  // ## BSE answers an ABSENT file with 200 + its SPA page, never a 404
  //
  // A constant 13,850-byte `<!DOCTYPE html>` document. That is why P2 recorded
  // this era as INDETERMINATE rather than absent — and it is the reason both
  // rows are `format: "zip"`: `validateFeedPayload` checks the `PK\x03\x04`
  // magic for zips, so the SPA page is rejected as `[payload]`, which is
  // NON-TERMINAL. A throttle and an absence therefore both get retried instead
  // of being frozen in as a permanent silent gap.
  {
    id: "bse-cm-legacy",
    exchange: "BSE",
    feed: "cm-legacy",
    buildUrl: (d) =>
      `${BSE_WWW}/download/BhavCopy/Equity/eq${tokDDMMYY(d)}_csv.zip`,
    cadence: "daily",
    // Lowest PROBED-PRESENT date (2026-08-13). 2006-01-02 returned the SPA
    // page, so the true floor is inside Jan–Apr 2006; the walk's floor explorer
    // closes that, exactly as it did for nse-cm-legacy. An in-range miss is a
    // GAP, never end-of-history, so a slightly-high floor costs a re-walk and
    // never data.
    startDate: "2006-04-03",
    startDateProvenance: "probed",
    // Last probed-present day. 2024-12-02 and later return the SPA page, so the
    // era ends between the two; `bse-cm-udiff-bhavcopy` (2024-01-01 →) already
    // covers the overlap, so nothing is lost by clamping conservatively.
    endDate: "2024-07-01",
    format: "zip",
    enabled: false,
    backfillable: true,
    provenance: "p2-probed",
    notes:
      "Legacy BSE cash bhavcopy, NO ISIN column (14 cols: SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI). Live-probed 2026-08-13: 2006-04-03 / 2006-07-03 / 2007-01-02 / 2015-01-02 / 2024-07-01 all returned real zips; 2006-01-02 / 2024-12-02 / 2025-02-01 / 2025-07-01 returned BSE's SPA page. Rows join scrip-code → ISIN via the archived BSE scrip master (the map feed-parse already builds for SCBSEALL). This is the ONLY route to BSE cash history before 2017.",
  },
  {
    id: "bse-cm-isin-legacy",
    exchange: "BSE",
    feed: "cm-isin-legacy",
    buildUrl: (d) =>
      `${BSE_WWW}/download/BhavCopy/Equity/EQ_ISINCODE_${tokDDMMYY(d)}.zip`,
    cadence: "daily",
    // 2016-12-01 returned the SPA page and 2017-01-03 a real zip, so the floor
    // sits in that window — narrow enough to declare the probed date.
    startDate: "2017-01-03",
    startDateProvenance: "probed",
    endDate: "2024-07-01",
    format: "zip",
    enabled: false,
    backfillable: true,
    provenance: "p2-probed",
    notes:
      "Legacy BSE cash bhavcopy WITH ISIN_CODE (18 cols) — the ticket's 'file carries ISIN; join ISIN@BSE' leg. Live-probed 2026-08-13: 2017-01-03 / 2017-07-03 / 2018-01-02 / 2019-02-01 / 2020-02-01 / 2023-03-15 / 2024-02-01 / 2024-04-01 / 2024-07-01 returned real zips; 2016-09-01 / 2016-10-03 / 2016-12-01 / 2024-09-02 / 2024-10-01 / 2024-12-01 / 2025-07-01 / 2026-01-02 returned the SPA page. NOTE the header CHANGES INSIDE 2017: column 16 is FILLER1 on 2017-01-03 and TRADING_DATE on 2017-07-03, which is why parseOldBseCmBhavcopy detects by column NAME and treats TRADING_DATE as optional.",
  },
  {
    id: "bse-gross-delivery",
    exchange: "BSE",
    feed: "gross-delivery",
    buildUrl: (d) =>
      `${BSE_WWW}/BSEDATA/gross/${istParts(d).y}/SCBSEALL${tokDDMM(d)}.zip`,
    cadence: "daily",
    startDate: "2007-01-04",
    format: "zip",
    enabled: true,
    backfillable: true,
    provenance: "p1-verified",
    notes:
      "Gross delivery. The YEAR lives in the path and only DDMM in the filename, so the path and token must be built together. P1 confirmed back to at least 2007.",
  },
  {
    id: "bse-index-daily-all",
    exchange: "BSE",
    feed: "index-daily-all",
    buildUrl: (d) =>
      `${BSE_API}/IndexArchDailyAll/w?fmdt=${encodeURIComponent(tokSlash(d))}&todt=${encodeURIComponent(tokSlash(d))}`,
    cadence: "daily",
    startDate: "2020-01-01",
    format: "json",
    requiresApi: true,
    enabled: false,
    // Params unproven (bare `{}`); nothing to walk until the real call is captured.
    backfillable: false,
    provenance: "unverified",
    notes:
      "All-index daily close. DISABLED: P1 got a bare `{}` from this param set, which is ABSENT, not data. The real call likely needs strIndex/Indexcode — capture from the index page XHR before enabling.",
  },
  {
    id: "bse-egr",
    exchange: "BSE",
    feed: "egr",
    buildUrl: () => null,
    cadence: "daily",
    startDate: "2026-05-01",
    format: "csv",
    enabled: false,
    // buildUrl returns null — no endpoint known.
    backfillable: false,
    provenance: "unverified",
    notes:
      "TODO — endpoint unknown. This entry exists because P1 established a NEGATIVE that would otherwise be assumed away: it scanned 4,939 rows of the BSE CM UDiFF file and found NO EGR segment or 18xxxx scrip rows, so BSE EGR does NOT ride the cash bhavcopy and needs its own source. Discover via the BSE EGR streamer/DevTools. buildUrl returns null until then.",
  },

  // ── NSE XBRL result filings (MONEY-1204 P0.2) ────────────────────
  //
  // The only family in this table that report-archive-sync must NOT fetch and
  // that is nonetheless archived every night. See the notes below.
  {
    id: "nse-results-xbrl",
    exchange: "NSE",
    feed: "results-xbrl",
    // NOT a stub, and not a TODO. A results filing is addressed by its own
    // NSE-assigned id and broadcast timestamp
    // (`INDAS_116875_1315808_15112024100348.xml`), which no function of a DATE
    // can produce. Every URL arrives from the results INDEX, one per filing.
    buildUrl: () => null,
    cadence: "daily",
    // Measured, not assumed. On the `.xml` suffix (the stub `/-` url starts
    // with "http", so a startsWith('http') check reports ~100% back to 2012):
    // 0% Jul-2012 -> Feb-2018, 89% May-2018, 97-98% from 2019. May-2018 is the
    // first month where the feed exists in any real sense.
    startDate: "2018-05-01",
    startDateProvenance: "probed",
    format: "xml",
    // NOT fetched by the nightly report-archive pass, and `enabled:false` is
    // what enforces that: report-archive-sync.ts calls familiesDue() ->
    // enabledFamilies() -> .filter(f => f.enabled). getFeedAsset does not
    // consult this registry at all — it takes a bare descriptor — so a
    // disabled row and an archived feed are not a contradiction. The live
    // precedent is `nse-cm-udiff-bhavcopy`: also enabled:false, also fetched
    // through getFeedAsset every night, by bhavcopy.ts.
    enabled: false,
    // Not date-addressable: `familiesForBackfill` walks a family by handing
    // buildUrl a day, and there is no day that yields a filing URL. The
    // backfill route is scripts/jobs/xbrl-backfill.ts, which walks the results
    // INDEX month by month and re-enters the same ingest.
    backfillable: false,
    // The per-filing URLs are fetched in production TODAY by
    // workers/src/processors/xbrl-sync.ts — this row documents an existing,
    // proven fetch rather than a pattern anyone guessed. It is deliberately
    // not "unverified", which would claim we do not know where these come
    // from; what we cannot do is DERIVE one from a date.
    provenance: "existing-code",
    notes:
      "NSE XBRL result filings, archived at feeds/NSE/results-xbrl/{YYYY}/{MM}/{basename-of-sourceUrl}. NOT fetched by report-archive-sync: `enabled:false` keeps it out of familiesDue(), and buildUrl returns null so flipping `enabled` alone still cannot fetch anything. It is fetched PER FILING by workers/src/processors/xbrl-sync.ts via getFeedAsset, whose descriptor is {exchange:'NSE', feed:'results-xbrl', date: the filing's own quarter-end}. buildUrl is null because a filing URL (INDAS_{co}_{seq}_{DDMMYYYYHHMMSS}.xml) is a function of the FILING, not of a date — the results index is the only thing that can produce one. Basenames are per-filing unique, so the URL supplies the object name and no `buildBasename` is needed. Payload shape is pinned in feed-payload.ts as kind 'xml' requiring an `<xbrli:xbrl` root; `feed-parse` has no entry for this format and skips it, which is correct — parsing is xbrl-sync's own job and it does it from the live bytes.",
  },

  // ── BSE results XBRL (MONEY-1255) ────────────────────────────────────
  //
  // The BSE analogue of the row above. Same shape, same reasons, one extra
  // caution: BSE's index emits a WRONG DIRECTORY for one filer class, and this
  // row records that as a live dependency on someone else's bug rather than
  // letting it read as a settled fact about their layout.
  {
    id: "bse-results-xbrl",
    exchange: "BSE",
    feed: "results-xbrl",
    // Same reason as NSE's: a BSE filing URL
    // (`Integrated_Finance_NBFC_{scrip}_{DMYYYYHHMMSS}.xml`) is a function of
    // the FILING, not of a date. Only the per-scrip index produces one.
    buildUrl: () => null,
    cadence: "daily",
    // The oldest instance actually FETCHED during discovery was a 2019 filing
    // (`NonBanking_530127_2952019192952.xml`, in-bse-fin 2018-03-31). The index
    // lists rows older than that, so this is a floor that has been reached, not
    // the floor of the archive — hence "probed" rather than a claim of the
    // earliest available filing.
    startDate: "2019-01-01",
    startDateProvenance: "probed",
    format: "xml",
    // enabled:false for the same mechanical reason as NSE's row — it keeps
    // this out of familiesDue() — and additionally because the BSE ingest is
    // WIRED BUT NOT ARMED. Arming is a founder step.
    enabled: false,
    // Not date-addressable. BSE's index is keyed by SCRIP CODE and takes no
    // date range at all, so there is no day that yields a filing URL. Recovery
    // is per-scrip: `Result_Arch_ng` returns a scrip's FULL history in one
    // response, which is what makes a missed night recoverable despite the
    // daily discovery feed having no date parameter.
    backfillable: false,
    // "api-captured", not "p2-probed": the endpoint and its exact params were
    // captured from BSE's own live application (their Angular bundle names
    // `Result_Arch_ng`, and a live response supplied the row shape), then
    // verified by fetching real instances. `--registry` has not been run
    // against this row, so claiming p2-probed would overstate the evidence.
    provenance: "api-captured",
    notes:
      "BSE XBRL result filings. INDEX: api.bseindia.com/BseIndiaAPI/api/Result_Arch_ng/w?scrip_cd={BSE_SCRIP_CODE} — per-scrip, no date range, no paging; each row carries `stand_xbrl_link` and `conso_xbrl_link` (site-relative /XBRLFILES/... paths on www.bseindia.com) plus `Fld_QuarterName` (Quarter|Year), so basis is a COLUMN PAIR here where NSE files two records. Daily discovery is a SECOND hop: NSTodayResults_ng/w lists the scrips that filed today and carries NO xbrl link. Found by reading BSE's own Angular bundle and verified live 2026-08-26; three earlier guessed paths (AttachLive/AttachHis/AnnualReport + XML_NAME) all 404 because XML_NAME is not a filename — the announcement attachment field is ATTACHMENTNAME. GetCorXbrlDetails_ng category 22 'Financial Results' is a DISPROVED route: it returns zero rows at every date tried while category 7 returns 3,510 for the identical range, so the empty is real and not a param error. TAXONOMY: needs no new parser family — instances declare in-bse-fin (a bseindia.com-hosted namespace, 2018/2019/2020-03-31) or in-capmkt (SEBI, 2025-01-31 / 2026-01-31), both already dispatched on. KNOWN DEFECT (theirs, not ours): integrated-era NBFC rows are indexed under /XBRLFILES/NBFCUploadDocument/Integrated_Finance_NBFC_*, which 404s; the files are served from the sibling /XBRLFILES/IFNBFCUploadDocument/. Verified across three NBFCs (512437, 539773, 530127) and both in-capmkt versions: every such URL 404s and every one resolves under the sibling. `bseInstanceUrlCandidates` in xbrl-filing-index.ts applies this as a FALLBACK (indexed URL first, rewrite only on failure) so the recovery count stays observable — if BSE fixes the index the count falls to zero, and if BSE moves the sibling the failure count rises instead. It is a WORKAROUND for a BSE index defect, NOT a durable fact: re-test before deleting it, and note the same directory's LEGACY NBFC_* files serve fine, so a directory-wide rewrite would break working URLs. Coverage is complete CONDITIONAL on that rewrite. IDENTITY: a BSE-only issuer files <Symbol>NOTLISTED</Symbol> — a literal sentinel, not an absent field — so XbrlFiling.symbol must come from the scrip-code bridge (InstrumentMapping.bseScripCode, then ISIN); see resolveWritableSymbol in xbrl-sync.ts, and note the unique key would otherwise collapse every BSE-only issuer of a given quarter and basis onto one row.",
  },
] as const;

// ─── Lookups ─────────────────────────────────────────────────────────

/**
 * Families whose `enabled` flag is set.
 *
 * NOT the same thing as "families the nightly job fetches", which is what this
 * used to claim — that set is {@link familiesDue}, and it applies
 * {@link isNightlyFetchable} on top. The difference is one row's worth of
 * transport capability today and it is the whole of MONEY-1238.
 */
export function enabledFamilies(): ReportFamily[] {
  return REPORT_REGISTRY.filter((f) => f.enabled);
}

/**
 * Can the NIGHTLY archive job fetch this family? (MONEY-1238)
 *
 * Two conditions, and the second is the one that used to be missing:
 *
 *   1. `enabled` — the operator's intent.
 *   2. `!requiresApi` — the transport's CAPABILITY. `report-archive-sync`
 *      reaches the exchange through `getFeedAsset` → `fetchExchangeAsset`,
 *      which sends browser headers and holds no cookies. A cookie-gated
 *      www.nseindia.com endpoint answers that with Akamai's challenge page, so
 *      including such a family cannot produce bytes — only a nightly `rejected`
 *      that reads exactly like an upstream format change.
 *
 * A separate predicate rather than an inline `&&` so the rule can be exercised
 * against a fabricated family: every row in the shipped table satisfies it
 * today, which would otherwise leave the guard untestable and therefore
 * unverifiable — the precise state `requiresApi` was in before this change.
 */
export function isNightlyFetchable(family: ReportFamily): boolean {
  return family.enabled && !family.requiresApi;
}

/**
 * May the ARCHIVE FETCH PATH request this family at all — MONEY-1236.
 *
 * `requiresApi` describes the FETCH PATH, not the schedule: `getFeedAsset` →
 * `fetchExchangeAsset` carries browser-impersonation headers and NO cookie jar,
 * so a cookie-gated family handed to it can only ever receive Akamai's challenge
 * interstitial. That is true whether the request came from tonight's run or from
 * a backfill of 2019.
 *
 * The exclusion was applied only in {@link isNightlyFetchable}, so
 * {@link backfillableFamilies} and {@link familiesForBackfill} still routed
 * `bse-sensex-daily` (`requiresApi: true, backfillable: true`) to exactly the
 * path the flag exists to keep it away from. Both are test-only consumers today,
 * which is precisely why it was worth closing now rather than after a backfill
 * job wires them up and every request fails identically to a format change.
 */
export function isArchiveFetchable(family: ReportFamily): boolean {
  return !family.requiresApi;
}

/**
 * Families behind the cookie-gated NSE/BSE APIs.
 *
 * The exclusion {@link isNightlyFetchable} applies is silent by construction —
 * a filtered-out row leaves no trace in a run log. This is the inspectable
 * counterpart: whoever wonders "why is this feed empty" gets a list instead of
 * having to re-derive it from a boolean nobody read.
 */
export function apiGatedFamilies(): ReportFamily[] {
  return REPORT_REGISTRY.filter((f) => f.requiresApi === true);
}

/** Every family, including inventory-only rows. For the registry probe. */
export function allFamilies(): readonly ReportFamily[] {
  return REPORT_REGISTRY;
}

export function familyById(id: string): ReportFamily | undefined {
  return REPORT_REGISTRY.find((f) => f.id === id);
}

/**
 * Families due on a given day for a given cadence bucket.
 *
 * `startDate` is enforced HERE rather than in each `buildUrl`, so a family
 * cannot forget it. A date before the family existed yields no URL at all,
 * which keeps the worker from manufacturing 404s during a backfill.
 */
/**
 * Families the BACKFILL driver may walk, and the date window for each.
 *
 * Selects on `backfillable`, NEVER on `enabled` — the two answer different
 * questions and the difference is load-bearing in both directions:
 *
 *   - `nse-cm-udiff-bhavcopy` is enabled:false (bhavcopy-sync owns the nightly
 *     fetch) yet is the most important thing to backfill. Selecting on
 *     `enabled` would silently skip the platform's core price history.
 *   - `nse-bulk-deals` is enabled:true yet must never be walked: its URL is
 *     undated, so a "2019" fetch archives today's bytes under a 2019 key.
 *
 * Returns the window clamped to each family's era, so an era-bounded legacy
 * family cannot be asked for dates after its format was retired.
 */
export function familiesForBackfill(
  from: string,
  to: string,
  ids?: readonly string[],
): Array<{ family: ReportFamily; from: string; to: string }> {
  const wanted = ids ? new Set(ids) : null;
  const out: Array<{ family: ReportFamily; from: string; to: string }> = [];

  for (const family of REPORT_REGISTRY) {
    if (!family.backfillable) continue;
    // Same exclusion as `backfillableFamilies` and for the same reason — the
    // backfill walks the identical cookie-less fetch path (MONEY-1236).
    if (!isArchiveFetchable(family)) continue;
    if (wanted && !wanted.has(family.id)) continue;

    // Clamp the requested window to the family's own era.
    const lo = from > family.startDate ? from : family.startDate;
    const hi = family.endDate && to > family.endDate ? family.endDate : to;
    if (lo > hi) continue;

    out.push({ family, from: lo, to: hi });
  }
  return out;
}

/** Every family that can be walked by date, era-bounds ignored. */
export function backfillableFamilies(): ReportFamily[] {
  // `isArchiveFetchable` as well as `backfillable` — MONEY-1236. A cookie-gated
  // family is unreachable from the archive fetch path in EVERY direction, not
  // just tonight's.
  return REPORT_REGISTRY.filter((f) => f.backfillable && isArchiveFetchable(f));
}

export function familiesDue(
  date: Date,
  cadence: ReportCadence | "all" = "daily",
  registry: readonly ReportFamily[] = REPORT_REGISTRY,
): ReportFamily[] {
  const iso = tokIsoDay(date);
  // `isNightlyFetchable`, not `f.enabled`: a cookie-gated family is excluded
  // here even when enabled, because the fetch path cannot satisfy it. See
  // MONEY-1238 on `requiresApi`.
  //
  // `registry` is injectable for ONE reason and it is not convenience. Every
  // shipped row now satisfies the rule, so a mutation replacing this filter
  // with the old `f.enabled` changes NOTHING observable against the real table
  // — the guard would be held up by the data rather than by the code, which is
  // the same "assertion that cannot fail" this ticket is about. A fabricated
  // registry is the only way to prove the filter is load-bearing.
  return registry.filter(isNightlyFetchable).filter((f) => {
    if (cadence !== "all" && f.cadence !== cadence) return false;
    if (iso < f.startDate) return false;
    return f.buildUrl(date) !== null;
  });
}
