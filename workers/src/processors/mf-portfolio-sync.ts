/**
 * AMC monthly portfolio disclosures — MONEY-1105 (Data Engine P8a).
 *
 * SEBI requires every AMC to publish each scheme's full holdings monthly. This
 * job downloads those workbooks, parses them with the pure
 * `parseAmcPortfolioWorkbook`, and upserts `MfPortfolioHolding`.
 *
 * Two pure modules carry the judgement; this file does I/O only:
 *   `amc-portfolio-sources`  — WHERE each AMC publishes, and how sure we are
 *   `mf-portfolio-logic`     — what the bytes MEAN
 *
 * ## Why this is not `FundHolding`
 *
 * `FundHolding` is a CURRENT-SNAPSHOT table keyed without a period, holding an
 * LLM extraction with only a weight. Twelve months of filings written into it
 * would have each month overwrite the last — one present, eleven silently gone.
 * See the schema note on `MfPortfolioHolding`.
 *
 * ## Scheme identity — now resolved, via a feed we already ingest
 *
 * No AMC portfolio file contains an AMFI scheme code (verified against real
 * July-2026 files from four AMCs). AMFI's NAVAll feed is grouped BY AMC and
 * does carry them, and its group headers match the registry's `fundName`
 * byte-exactly, which narrows the match from 14,273 industry-wide schemes to a
 * median of 130. Measured 326/333 (97.9%) on the real committed workbooks.
 *
 * Only an unambiguous match sets `amfiSchemeCode`. An AMBIGUOUS name leaves it
 * null: a wrong scheme code silently attributes one fund's holdings to another,
 * which is strictly worse than no code, because a null is visibly absent and a
 * wrong code is not.
 *
 * `schemeKey` remains OUR normalisation of the printed name and is still the
 * storage key — the AMFI code is an enrichment, so a NAVAll outage degrades the
 * enrichment rather than blocking the ingest.
 *
 * ## One AMC is NOT fetched, on purpose
 *
 * UTI. Its API answers 200 and the zip holds real per-scheme holdings — in ONE
 * sheet covering every scheme, which this pipeline cannot split, so the row is
 * `observed` and `fetchableSources()` excludes it (MONEY-1405 D3; the row
 * states the blocker). ABSL and Kotak used to sit here too and were both
 * promoted in that ticket on a real fetch of the current month.
 *
 * A guessed URL 404s identically to "not published yet", so fetching one would
 * report zero forever while every log line read as success — the house rule
 * that `report-registry.ts` already enforces for exchange feeds.
 *
 * The run REPORTS such houses as skipped-by-provenance rather than omitting
 * them, so the real coverage is visible in the result rather than inferable
 * from a count that looks fine.
 *
 * ## Two mechanisms, one job
 *
 * TEMPLATE houses (SBI, Nippon, Kotak, ICICI) build a URL from the month.
 * PAGE-SCRAPE houses (ABSL, DSP, PPFAS, Tata, Zerodha, …) need TWO fetches —
 * the landing page, then the file a resolver picks out of it — because their
 * file paths carry random hashes or epochs and are not templatable at all.
 * `pickLinkForMonth` returns null for zero matches AND for more than one:
 * several houses publish the same month twice under different spellings, and
 * nothing in the filenames says which is authoritative.
 *
 * HDFC is verified but absent from both loops: it publishes one file per scheme,
 * so it needs a scheme LIST to iterate, which the NAVAll index below now makes
 * possible but which is not yet wired.
 *
 * ## Nippon keeps only the CURRENT month
 *
 * Its June file 404s while July serves. So for Nippon the SCHEDULE is the risk,
 * not the parser — which is why the job runs on the 12th AND the 20th rather
 * than once.
 *
 * ## The 600s ack deadline — MONEY-1401 F12
 *
 * A HOUSE is the unit of work, and the run is bounded by
 * {@link RUN_TIME_BUDGET_MS} checked BETWEEN houses. What it does not reach is
 * published straight back onto this job's own topic as `{month, only}`.
 *
 * THIS PARAGRAPH USED TO ARGUE THAT NO CHAIN-DEPTH CAP WAS NEEDED — that
 * `only` names exactly what is left, so the list strictly shrinks every hop and
 * the chain is bounded by the house count "without reading a database, a clock
 * or a queue". The reasoning was sound and the conclusion was false, because it
 * assumed the follow-up would RECEIVE the `only` it was sent. It did not: the
 * route read `only` off the Pub/Sub push ENVELOPE rather than the decoded
 * payload, so every hop discarded the remainder and re-ran the full table from
 * the top. Seven days, ~240 runs a day, the same first four or five houses
 * re-fetched and re-upserted each time, and the fourteen houses from ABSL to
 * HDFC never reached at all. See MONEY-1490.
 *
 * The envelope bug is fixed in `routes/mf-portfolio-sync.ts` and that alone
 * restores the shrinking property. {@link MAX_CHAIN_DEPTH} is kept anyway, for
 * the reason the incident itself demonstrates: a bound that is ARGUED can be
 * defeated by a defect somewhere else in the message path, and a bound that is
 * COUNTED cannot. Every other self-chaining job in this repo carries one, and
 * each of them prints `n/MAX` — which is also what would have made seven days
 * of this visible on any single log line.
 *
 * The write path is memoised per run ({@link resolveInstrumentIdMemoised}):
 * one `instrumentMapping` query per DISTINCT ISIN rather than per holding,
 * measured at a 78.9% hit rate on the committed workbooks.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { clearCachePattern } from "@usemoney/core/cache";
import prisma from "@usemoney/database";
import {
  parseAmcPortfolioWorkbook,
  fetchableSources,
  amcSource,
  buildHdfcUrl,
  AMC_SOURCES,
  monthStart,
  type AmcSource,
  // Page-scrape houses (MONEY-1105) — seven AMCs that publish their file links
  // in served HTML rather than at a templatable URL.
  scrapableAmcs,
  AMC_PAGE_SCRAPERS,
  findMonthlyPortfolioLinks,
  pickLinkForMonth,
  schemesForMonth,
  type AmcPageRequest,
  // Scheme identity — resolves a workbook's printed scheme name to its AMFI
  // scheme code, which no AMC portfolio file contains.
  parseNavAllGroups,
  buildSchemeIndex,
  resolveSchemeCode,
  AMFI_NAVALL_URL,
  // Industry coverage (MONEY-1405 D2). `resolverCoverage` has been unit-tested
  // since P8a and had no way to run against the live registry, because nothing
  // fetched the page.
  fetchAmfiAmcRegistry,
  resolverCoverage,
  // MONEY-1401 — NAVAll goes through the SAME archive seam packages/core
  // already uses for it, rather than a second raw fetch. See
  // `fetchNavAllViaArchive`.
  getFeedAsset,
  toIstDateKey,
  type SchemeIndex,
  type AmcId,
  type AmcHolding,
  type AmcSchemeSheet,
} from "@usemoney/core/market-data";
import {
  judgeAmcAttempt,
  judgeSheetWrite,
  mfPortfolioRunOk,
  type AmcAttemptTotals,
} from "./mf-portfolio-sync-logic";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[mf-portfolio-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[mf-portfolio-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[mf-portfolio-sync] ${msg}`, data),
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** These are multi-megabyte workbooks over a consumer CDN. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** HDFC publishes one file per scheme; ~160 of them, so pace and cap. */
const HDFC_DELAY_MS = 400;
const HDFC_MAX_SCHEMES = 200;

/**
 * No NEW house is started past this — MONEY-1401 F12.
 *
 * The binding constraint is the 600s Pub/Sub ack deadline (`--ack-deadline=600`
 * on this job's push subscription, Pub/Sub's maximum; Cloud Run's 3600s request
 * timeout never binds). Overrunning it is not "slow": Pub/Sub redelivers, the
 * dedupe middleware answers the redelivery 409 RETRY_LATER, Pub/Sub COUNTS that
 * as a delivery attempt, and after five the message is dead-lettered and the
 * founder is notified — while the original execution is still running and will
 * succeed. That is MONEY-1389, measured at 368 false dead-letters a day on one
 * subscription.
 *
 * 360s, not the 420s `stock-document-extract` and `mf-nav-backfill` use,
 * because the OVERSHOOT here is a whole HOUSE and the largest house is large:
 *
 *   600s   ack deadline
 *  -360s   RUN_TIME_BUDGET_MS — no new house past this
 *  ------
 *   240s   headroom, sized for one worst house:
 *            HDFC   200 sequential downloads paced at HDFC_DELAY_MS = 400ms,
 *                   so 80s of sleeping alone before one round trip
 *            MIRAE  97 workbooks, each fetched and parsed
 *            ICICI  a single ~25 MB download
 *          plus the run-final report + the chain publish.
 *
 * It is checked BETWEEN houses and never inside one: a house is the smallest
 * unit this job can resume at, because `only` — the continuation channel — is
 * a list of AMC ids and nothing finer exists on the message.
 */
const RUN_TIME_BUDGET_MS = 360_000;

/**
 * The TERMINATION PROOF — MONEY-1490.
 *
 * ~19 houses and at least one attempted per hop, so a correct chain needs at
 * most ~19 links; 25 leaves headroom for a house list that grows without this
 * constant being revisited, while still being far below the ~1,680 hops a week
 * of runaway produced.
 *
 * It consults NO database, NO clock and NO queue, which is the whole point: the
 * other stop conditions (nothing deferred, an unhealthy hop) can only ever end
 * a chain SOONER. `stock-document-extract` and `stock-document-sync` both state
 * the same property, and `us-eod-sync` calls its equivalent "the termination
 * proof" in exactly these words.
 */
const MAX_CHAIN_DEPTH = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Should the houses not yet started be handed to a follow-up message?
 *
 * `housesDone > 0` is the PROGRESS GUARANTEE, and it is what makes the chain
 * terminate. Each hop attempts at least one house, so the `only` list it
 * forwards is strictly shorter than the one it received, and the chain is
 * bounded by the number of houses (~18) without consulting a database, a clock
 * or a queue. Drop that clause and a run whose NAVAll download alone blew the
 * budget would chain an identical message forever.
 */
export function shouldDeferRemainingHouses(opts: {
  startedAt: number;
  now: number;
  housesDone: number;
}): boolean {
  return opts.housesDone > 0 && opts.now - opts.startedAt >= RUN_TIME_BUDGET_MS;
}

/**
 * ISIN -> `InstrumentMapping.id`, memoised for the life of ONE run.
 *
 * The same large-caps recur across hundreds of schemes: measured across the
 * four committed workbooks (ABSL, Nippon, SBI, HDFC) 17,463 holdings carry an
 * ISIN and only 3,680 are distinct — a 78.9% hit rate, i.e. 13,783 database
 * round trips removed from an 18,401-holding run. At the ~50-55k rows this job
 * now writes the rate is higher still, because distinct ISINs are bounded by
 * the instrument universe while holdings are not.
 *
 * `memo.has()` is the check, NOT `memo.get(isin) ?? lookup()`. A resolved MISS
 * is stored as `null` and is a legitimate cached answer — an ISIN we have no
 * instrument for is exactly the lookup worth not repeating — so reading the
 * VALUE could not tell "cached, and the answer is no instrument" from "never
 * asked". The first would silently re-query every cash/TREPS/debt line, which
 * is most of what has no mapping.
 *
 * The map is owned by `WriteContext` and built inside `processMfPortfolioSync`,
 * never at module scope: Cloud Run keeps containers warm, so module-scope run
 * state leaks between runs — the bug MONEY-1238 fixed in this same file.
 */
export async function resolveInstrumentIdMemoised(
  memo: Map<string, string | null>,
  isin: string,
  lookup: (isin: string) => Promise<string | null>,
): Promise<string | null> {
  if (memo.has(isin)) return memo.get(isin) ?? null;
  const resolved = await lookup(isin);
  memo.set(isin, resolved);
  return resolved;
}

const HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  accept: "*/*",
};

/**
 * Normalise a printed scheme name into our join handle.
 *
 * Ours, not the AMC's — which is why `schemeName` is stored VERBATIM alongside
 * it. Changing this function is a backfill, not a deploy.
 *
 * Plan and option suffixes are stripped because they are not different
 * portfolios: a Direct and a Regular plan of one scheme hold identical
 * securities and differ only in expense ratio. Keeping them apart would
 * duplicate every holding and make "which funds hold RELIANCE" double-count.
 */
export function schemeKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/\((?:formerly|erstwhile)[^)]*\)/g, "")
    .replace(/\b(direct|regular)\b/g, "")
    .replace(/\b(plan|option|growth|idcw|dividend|payout|reinvestment)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * The key the MASTER-name resolver joins on — MONEY-1404 C5.
 *
 * `schemeKeyOf` is the STORAGE key and changing it is a backfill, so this is a
 * separate function rather than a widening of it. It strips two things that
 * only ONE side of the join ever prints, measured on prod against all 662
 * stored schemes and 14,225 `mutual_fund_masters` rows:
 *
 *   - the trailing SEBI category sentence the AMC sheet appends
 *     (`HDFC Nifty Metal ETF (An open ended scheme replicating/tracking …)`)
 *   - Groww's internal `IB13-` prefix (`IB13-Groww Value Fund`)
 *
 * Both are absent from AMFI's master name, so keying on `schemeKeyOf` alone
 * left 344 of 662 schemes with NO candidate at all. With them stripped that
 * falls to 98 and unique resolutions rise from 81 to 138.
 *
 * It can only ever make a join FAIL SAFE: two masters that differ solely by a
 * trailing parenthetical collapse to one key, which makes them ambiguous, and
 * an ambiguous key resolves to null.
 */
export function schemeMatchKeyOf(name: string): string {
  return schemeKeyOf(
    stripTrailingParenthetical(name).replace(/^[A-Z]{1,3}\d{1,3}\s*-\s*/, " "),
  );
}

/**
 * Remove ONE balanced parenthetical, and only when the name ENDS in it.
 *
 * A depth scan rather than `\([^)]*\)\s*$`, because the real sentences NEST:
 * `HDFC Nifty Metal ETF (An open ended scheme replicating/tracking Nifty Metal
 * Index (TRI))`. The regex form stops at the inner `)` and then fails its
 * end-anchor, so it matched none of the names it was written for — which is a
 * silent no-op, not an error.
 *
 * Anchored at the END so a MID-name parenthetical survives: `SBI Fixed Maturity
 * Plan (FMP)- Series 51` and `… Series 52` are different schemes, and
 * collapsing their `(FMP)` would make them one ambiguous key and leave both
 * funds with no code.
 */
function stripTrailingParenthetical(name: string): string {
  const t = name.trimEnd();
  if (!t.endsWith(")")) return name;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const ch = t[i];
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) return t.slice(0, i);
  }
  // Unbalanced — leave it alone rather than truncate to nothing.
  return name;
}

/**
 * Which section heading a row sat under → our holding type.
 *
 * Falls through to OTHER, which is a real catch-all and not a failure: AMCs
 * invent section wordings freely, and a classifier without a catch-all does not
 * become more precise — it develops a new way to drop rows.
 */
export function holdingTypeOf(section: string | null): string {
  const s = (section ?? "").toLowerCase();
  if (!s) return "OTHER";
  if (s.includes("equity")) return "EQUITY";
  if (s.includes("reit") || s.includes("invit")) return "REIT_INVIT";
  if (s.includes("gold") || s.includes("silver")) return "GOLD";
  if (
    s.includes("derivative") ||
    s.includes("futures") ||
    s.includes("options")
  ) {
    return "DERIVATIVE";
  }
  if (
    s.includes("treps") ||
    s.includes("cash") ||
    s.includes("net receivable") ||
    s.includes("net current asset") ||
    s.includes("reverse repo")
  ) {
    return "CASH";
  }
  if (
    s.includes("debt") ||
    s.includes("bond") ||
    s.includes("debenture") ||
    s.includes("government securit") ||
    s.includes("money market") ||
    s.includes("certificate of deposit") ||
    s.includes("commercial paper") ||
    s.includes("treasury bill")
  ) {
    return "DEBT";
  }
  return "OTHER";
}

export interface MfPortfolioSyncResult {
  ok: boolean;
  /** The month the disclosures describe, `YYYY-MM`. */
  period: string;
  /** AMCs actually attempted. */
  attempted: AmcId[];
  /**
   * AMCs deliberately NOT attempted because their URL is unproven, WITH the
   * reason. Reported rather than omitted: "we cover 2 of 5" must be visible in
   * the result, not inferable from a total that looks reasonable.
   */
  skippedByProvenance: Array<{ amc: AmcId; provenance: string }>;
  perAmc: Array<{
    amc: AmcId;
    /**
     * The house STORED something — MONEY-1238.
     *
     * This used to mean "parsed something" (`amcSheets > 0`, or an
     * unconditional `true` in the template loop), so a run in which every
     * workbook parsed and `writeSheet` returned 0 for all of them reported
     * `ok: true` with `written: 0`. See `judgeAmcAttempt`.
     */
    ok: boolean;
    /** HTTP/transport outcome, or the parser's verdict. */
    status: string;
    bytes: number;
    sheets: number;
    holdings: number;
    written: number;
  }>;
  written: number;
  /**
   * Houses this hop did NOT start because the run-time budget was spent, in
   * the order they would have run — MONEY-1401 F12.
   *
   * Handed to a follow-up message as its `only`, so the remainder is CARRIED
   * rather than dropped. Empty on every run that finishes, which is the normal
   * case; non-empty is a counted, named partial outcome, never a silent
   * truncation.
   */
  deferred: AmcId[];
  /**
   * Sheets PARSED AND REFUSED, run-wide — MONEY-1404 C3 / MONEY-1405 D1.
   *
   * These rows existed, were readable, and were deliberately not stored. They
   * are reported rather than dropped for the reason `skippedByProvenance`
   * exists: "we stored 40,000 rows" with no denominator cannot tell a complete
   * month from a half-refused one.
   */
  refused: {
    /** As-on month ≠ the requested month (Axis's 2022 workbook). */
    stale: number;
    /** No as-on date could be read at all. */
    noAsOn: number;
    /** `checkPercentSum` said the percent column disagrees with the money. */
    scaleSuspect: number;
    /** WRITTEN despite an absent expected column — counted, never refused. */
    missingColumns: number;
  };
  /** How `amfiSchemeCode` was decided across the run — MONEY-1404 C5. */
  schemeCodes: {
    /** NAVAll named exactly ONE code — the scheme has no plan split. */
    navAll: number;
    /**
     * NAVAll named a FAMILY of plan codes (Direct/Regular × Growth/IDCW) —
     * MONEY-1294. All of them go to `amfiSchemeCodes`; an arbitrary one, in
     * feed order, goes to `amfiSchemeCode`. Counted apart from `navAll` because
     * it is the only number that says whether the array writer is doing
     * anything, and apart from `ambiguous` because these schemes ARE resolved.
     */
    planVariant: number;
    master: number;
    ambiguous: number;
    unresolved: number;
  };
}

async function download(url: string): Promise<Uint8Array | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: HEADERS,
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      // A 404 page served as 200, or an empty body. The parser would return
      // null for these anyway, but counting them as a FETCH failure rather than
      // a PARSE failure keeps the two numbers meaning what they say.
      if (buf.byteLength < 1024) return null;
      return buf;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/**
 * Fetch a landing PAGE as text. Separate from `download` because the two have
 * opposite success criteria: a workbook must be big and binary, a landing page
 * must be HTML and is often small.
 */
async function fetchText(
  url: string,
  req?: AmcPageRequest,
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      // MONEY-1198 — honour the per-house request shape. Mirae's listing
      // endpoint is POST-only, and a GET to it returns HTTP **200** with
      // `{"ReturnCode":"9999",…}` — so without this the house looks reachable
      // and simply empty. It fails LOUDLY anyway (that envelope is matched by
      // `errorBody`, which makes findMonthlyPortfolioLinks return null rather
      // than []), but failing loudly on a request we could have made correctly
      // is not the same as fetching the data.
      const method = req?.method ?? "GET";
      const resp = await fetch(url, {
        method,
        headers:
          method === "POST" && req?.contentType
            ? { ...HEADERS, "Content-Type": req.contentType }
            : HEADERS,
        ...(method === "POST" && req?.body !== undefined
          ? { body: req.body }
          : {}),
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!resp.ok) return null;
      return await resp.text();
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/**
 * AMFI's NAV page — the referer a browser sends when it follows the link to the
 * file. Kept byte-identical to `AMFI_NAV_REFERER` in `amfi-mf-provider.ts`; see
 * {@link fetchNavAllViaArchive} for why this file states it rather than
 * importing it.
 */
const AMFI_NAVALL_REFERER = "https://www.amfiindia.com/net-asset-value";

/**
 * GET NAVAll THROUGH THE ARCHIVE SEAM — MONEY-1401 finding, was a raw fetch.
 *
 * `packages/core` has routed this exact URL through `getFeedAsset` since
 * MONEY-1404 C6 (`amfi-mf-provider.ts::fetchNavAllText`), so the same ~1.5 MB
 * file was being pulled TWICE a month — once archived, once not. The un-seamed
 * copy bought none of the three things the seam exists for: prod kept no record
 * of the bytes THIS job parsed, QA had nothing to replay, and
 * `no-feed-fetch-bypass.test.ts` could only record the bypass as a written
 * exemption rather than guard it. That exemption is now deleted, which is the
 * point: its list can only shrink.
 *
 * The DESCRIPTOR is byte-identical to the provider's, so both jobs address ONE
 * archive key. `basename` is passed EXPLICITLY because the URL's own basename
 * is the constant `NAVAll.txt` and a DATED descriptor without one collapses a
 * whole month onto a single object — worse than `current/`, which at least says
 * it overwrites. The date is the IST day we FETCHED on, not the NAV date inside
 * the file: that is the only one of the two knowable before parsing.
 *
 * `fetchNavAllText` itself is not exported from `packages/core`, so this states
 * the descriptor rather than reusing it. A drift between the two spellings is
 * cheap and self-healing — prod would write a second object and QA would miss
 * and re-fetch, i.e. exactly today's behaviour — but it is still silent, so a
 * test pins the two literals in agreement.
 *
 * THREE FAILURE MODES, all folded to null, because this function's caller
 * treats null as a DEGRADATION:
 *   - a replay MISS falls back to the exchange inside `getFeedAsset` and never
 *     reaches here, so a late prod->QA mirror costs one scrape, not a run;
 *   - no `GCP_STORAGE_BUCKET` (local dev) leaves the archive store null, which
 *     skips both the replay and the write and passes the fetch straight
 *     through;
 *   - a non-404 non-OK status THROWS out of `getFeedAsset`, and a 404 returns
 *     `null`. Neither may escape: this job's whole point is that a NAV outage
 *     degrades the enrichment instead of losing the month's holdings.
 */
export async function fetchNavAllViaArchive(
  get: typeof getFeedAsset = getFeedAsset,
): Promise<string | null> {
  try {
    const day = new Date();
    const res = await get(
      AMFI_NAVALL_URL,
      AMFI_NAVALL_REFERER,
      {
        exchange: "AMFI",
        feed: "navall",
        date: day,
        basename: `NAVAll-${toIstDateKey(day)}.txt`,
      },
      undefined,
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    );
    return res === null ? null : await res.text();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "NAVAll fetch threw",
    );
    return null;
  }
}

/**
 * Build the scheme-name -> AMFI-scheme-code index from AMFI's NAVAll feed.
 *
 * Returns null on any failure, and that is a DEGRADATION rather than an abort:
 * for every house with a URL of its own, each holding is still written, just
 * with a null `amfiSchemeCode`. Refusing to ingest a month's holdings because a
 * NAV feed was briefly unreachable would trade a complete dataset for a missing
 * one.
 *
 * WITH ONE EXCEPTION, and this line claimed otherwise until MONEY-1401's review.
 * HDFC publishes a file PER SCHEME and has no `buildUrl`, so this index is not
 * an enrichment for it — it is the only thing that can name its files. A null
 * index means HDFC writes NOTHING, which is why that branch now reports a named
 * `NO_SCHEME_INDEX` refusal instead of being skipped by a falsy `&&`.
 *
 * NOTE the URL now 302s to portal.amfiindia.com. `fetchExchangeAsset` follows
 * redirects, so this works — but it is one `redirect: "manual"` from silently
 * breaking, which is tracked separately.
 */
async function buildSchemeIndexOrNull(): Promise<SchemeIndex | null> {
  const text = await fetchNavAllViaArchive();
  if (text === null) {
    logger.warn(
      { url: AMFI_NAVALL_URL },
      "NAVAll unreachable — holdings will be written WITHOUT an AMFI scheme code",
    );
    return null;
  }
  const file = parseNavAllGroups(text);
  if (file === null) {
    logger.error(
      { url: AMFI_NAVALL_URL, bytes: text.length },
      "NAVAll UNRECOGNISED — the feed grammar changed",
    );
    return null;
  }
  return buildSchemeIndex(file);
}

/**
 * Scheme name → AMFI scheme code, built from `mutual_fund_masters` —
 * MONEY-1404 C5.
 *
 * The SECOND resolver. The first (NAVAll, `resolveSchemeCode`) had set
 * `amfiSchemeCode` on **11 distinct codes across 54,248 rows / 662 schemes** in
 * production — it was zero for August because the NAVAll parser was broken, and
 * fixing that (Phase A) restored a resolver that still only reaches a fraction
 * of the book.
 *
 * Keys are {@link schemeMatchKeyOf}; the VALUE is the set of distinct scheme
 * CODES behind that key, not the master rows. Those are different numbers and
 * the distinction is the whole guard: AMFI issues a separate code per PLAN
 * (Direct/Regular × Growth/IDCW), so one scheme routinely has four master rows
 * — counting rows would call every fund ambiguous.
 *
 * ## IT IS SCOPED BY AMC — MONEY-1401 review finding 8b
 *
 * It was not, and `codes.size === 1` is not a substitute. That test closes the
 * COLLISION case (one key, several codes) and says nothing about OWNERSHIP: a
 * printed name matching exactly one master row AT ANOTHER HOUSE produced a
 * confident, wrong code, and a wrong code attributes one fund's holdings to
 * another with nothing downstream able to see it. The risk is not theoretical
 * for every house — ICICI's scheme names come from a zip-member FILENAME, which
 * need not carry the house at all.
 *
 * The AMC is `AmcSource.name`, joined to `MutualFundMaster.amcName`. That is
 * not a new join: `amcName` is written from the NAVAll GROUP HEADER
 * (`amfi-mf-provider.ts`), which is the same string the FIRST resolver already
 * matches byte-exactly (`findAmc` in `amfi-scheme-bridge.ts`). Measured on prod
 * 2026-09-14: all 19 registry houses are present in `mutual_fund_masters`
 * (SBI 541 rows / ICICI 2,498 / … / Old Bridge 12), so nothing abstains today.
 *
 * A house the masters do not name gets NO second resolver — an abstention, not
 * a fallback to the industry-wide map. `missingAmcs` below NAMES them, at build
 * time rather than per sheet, so it fires for a house whose fetch also failed
 * and an AMFI rename cannot silently zero this resolver.
 *
 * Returns null on a query failure, a DEGRADATION and not an abort, matching
 * `buildSchemeIndexOrNull`: without it every holding is still written, with a
 * null code.
 */
export interface MasterSchemeIndex {
  /** AMC name (`AmcSource.name`) -> {@link schemeMatchKeyOf} -> scheme codes. */
  byAmc: Map<string, Map<string, Set<string>>>;
}

async function buildMasterSchemeIndexOrNull(): Promise<MasterSchemeIndex | null> {
  try {
    const rows = await prisma.mutualFundMaster.findMany({
      select: { schemeName: true, schemeCode: true, amcName: true },
    });
    const byAmc = new Map<string, Map<string, Set<string>>>();
    for (const r of rows) {
      const key = schemeMatchKeyOf(r.schemeName);
      if (!key) continue;
      let keys = byAmc.get(r.amcName);
      if (!keys) byAmc.set(r.amcName, (keys = new Map()));
      let codes = keys.get(key);
      if (!codes) keys.set(key, (codes = new Set()));
      codes.add(r.schemeCode);
    }
    // Which houses this resolver ABSTAINS for. Reported rather than inferred
    // from a coverage number that looks reasonable — same rule as
    // `skippedByProvenance`.
    // The FULL registry, not `fetchableSources()` / `scrapableAmcs()`: those
    // narrow to what we can fetch TODAY, and a house whose AMFI name drifted is
    // exactly a house whose fetch may also be failing. A diagnostic that hides
    // behind another gate reports "fine" for the case it exists to catch.
    const missingAmcs = [...AMC_SOURCES, ...AMC_PAGE_SCRAPERS]
      .map((s) => s.name)
      .filter((name) => !byAmc.has(name));
    logger.info(
      {
        masters: rows.length,
        amcs: byAmc.size,
        keys: [...byAmc.values()].reduce((n, m) => n + m.size, 0),
        missingAmcs,
      },
      missingAmcs.length > 0
        ? "master scheme index built — the second resolver ABSTAINS for the " +
            "houses in missingAmcs (no mutual_fund_masters row names them)"
        : "master scheme index built",
    );
    return { byAmc };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "mutual_fund_masters unreadable — the second scheme resolver is off for " +
        "this run; holdings still write with a null amfiSchemeCode",
    );
    return null;
  }
}

/**
 * Houses this run will NOT visit, and why — over the WHOLE registry.
 *
 * It used to read `AMC_SOURCES` alone. `scrapableAmcs()` filters on
 * `provenance === "verified"`, so a DEMOTED page-scrape house appeared in NONE
 * of `attempted`, `perAmc`, `deferred` or here — `selected` just read one
 * lower. That is byte-identical to the HDFC bug this ticket fixed, over the 13
 * houses in `AMC_PAGE_SCRAPERS`, and zero of them are demoted today, which is
 * exactly when the hole is invisible. Same rule `missingAmcs` states above: the
 * FULL registry, never a list already narrowed by the gate being reported on.
 *
 * `visitable` defaults to the real gates and is a PARAMETER so a demoted house
 * can be exercised — the condition has no fixture otherwise, and a test that
 * cannot produce the state cannot detect its return.
 *
 * Compared against the UNFILTERED gates on purpose: `opts.only` is an operator
 * narrowing one run, not a statement about a house's provenance, and folding it
 * in would report five verified houses as skipped whenever one was named.
 */
export function amcsSkippedByProvenance(
  visitable: ReadonlySet<string> = new Set<string>([
    ...fetchableSources().map((s) => s.id),
    ...scrapableAmcs().map((s) => s.id),
  ]),
): Array<{ amc: AmcId; provenance: string }> {
  return [...AMC_SOURCES, ...AMC_PAGE_SCRAPERS]
    .filter((s) => !visitable.has(s.id))
    .map((s) => ({ amc: s.id, provenance: s.provenance }));
}

/** Per-run counters and lookups shared by all three write sites. */
export interface WriteContext {
  period: Date;
  /** `YYYY-MM` — what the run ASKED for, and what a sheet's as-on must match. */
  periodLabel: string;
  schemeIndex: SchemeIndex | null;
  masterIndex: MasterSchemeIndex | null;
  /**
   * ISIN -> instrument id for this run only — see
   * {@link resolveInstrumentIdMemoised}. Lives here rather than at module
   * scope so it cannot survive into the next run on a warm container.
   */
  instrumentIdByIsin: Map<string, string | null>;
  /** How `amfiSchemeCode`/`amfiSchemeCodes` were decided, across the whole run. */
  resolution: {
    navAll: number;
    /** NAVAll matched a family of SEVERAL plan codes — MONEY-1294. */
    planVariant: number;
    master: number;
    ambiguous: number;
    unresolved: number;
  };
}

/** Which resolver produced the codes. The keys ARE `resolution`'s counters. */
export type SchemeCodeVia = "navAll" | "planVariant" | "master";

export interface SchemeCodeDecision {
  /** Every AMFI code for this scheme. Empty when nothing resolved. */
  codes: string[];
  /** Which resolver answered; null when none did. */
  via: SchemeCodeVia | null;
  /**
   * A name we could not PIN DOWN, as opposed to one we simply never saw.
   * Shared across both resolvers on purpose — they refuse for the same reason —
   * while the three RESOLVED counts stay separable through {@link via}.
   */
  ambiguous: boolean;
}

/**
 * The whole scheme-identity decision, in one pure place. NO portfolio workbook
 * contains an AMFI scheme code, so this is the only thing that can supply one.
 *
 * Only a `matched` resolution yields codes. An ambiguous name is left NULL: a
 * wrong scheme code silently attributes one fund's holdings to another, which
 * is strictly worse than no code at all — a null is visibly absent, a wrong
 * code is not. That is the rule both resolvers below obey.
 *
 * It is pure, exported and separate from `writeSheet` for one reason: every
 * interesting case here is a judgement about a NAME, and reaching them through
 * a function that also opens a Prisma transaction per holding means they are
 * not tested at all.
 *
 * ## 1. NAVAll — and the WHOLE FAMILY is taken (MONEY-1294's writer half)
 *
 * This read `res.schemeCodes.length === 1` and threw the answer away for every
 * family bigger than that, so the column the schema, both indexes and
 * `schemeCodeWhere` were built for was EMPTY on prod: 0 of 54,248 rows.
 * `resolveSchemeCode` already returns every plan variant — the family key
 * strips plan/option words by construction — so a 4-code family is AMFI's
 * Direct/Regular × Growth/IDCW split of ONE filed portfolio, not four funds.
 * Measured on prod 2026-09-14 against that day's feed: 412 more schemes /
 * 32,422 more rows gain a code, ZERO lose one, and exactly ONE scheme's
 * primary changes.
 *
 * The primary (`codes[0]`) is an ARBITRARY member in feed order, and is
 * documented as arbitrary. Picking "Direct + Growth" would be a second grouping
 * rule disagreeing with the bridge's, and a reader that genuinely needs one
 * plan should join `MutualFundMaster` at read time rather than trust a
 * denormalised guess frozen at write time.
 *
 * IT DOES HAVE A CONSUMER, and this comment said it did not for one commit.
 * `docs-section-logic.ts:1244` and `:1389` both build `href: mfHref(
 * a.amfiSchemeCode)` — a `/mf/<code>` link on the fund-holder rows. So the
 * arbitrariness is USER-VISIBLE: the link lands on whichever plan variant AMFI
 * listed first, not necessarily the Direct/Growth one a reader expects. It is
 * a real plan for a real scheme and the holdings behind it are the same filed
 * portfolio, so the link is never WRONG — but "no consumer" was the wrong
 * reason to be comfortable with it. `Prisma.MfPortfolioHolding`'s own schema
 * comment goes further and claims the column holds "the PRIMARY (Direct +
 * Growth where that is identifiable)", which nothing here implements; that
 * disagreement is real and is not this file's to settle.
 *
 * KNOWN AND MEASURED: 5 of the 414 multi-code families (410 rows) also carry a
 * wound-up SEGREGATED PORTFOLIO's codes. That is not filterable any more —
 * AMFI rewrote those names, so `147691` now reads "Nippon India Equity Savings
 * Fund (Existing number of Segregated Portfolios - 2);Direct Plan;Bonus
 * Option", with the side-pocket segment gone from the NAME and the plan moved
 * into the columns AMFI added in Aug 2026. They are near-unreachable in
 * practice: those codes carry `nav <= 0`, which `amfi-mf-provider` drops, so
 * they never enter `mutual_fund_masters` and no fund page exists to ask for
 * them by code.
 *
 * ## 2. The master index — SCOPED BY AMC (MONEY-1401 finding 8b)
 *
 * Tried only when NAVAll produced nothing. A UNIQUE hit WITHIN THE HOUSE yields
 * a code; anything else yields null and a count. See {@link MasterSchemeIndex}
 * for why `codes.size === 1` alone was not enough, and why a house the masters
 * do not name ABSTAINS here rather than falling back to an industry-wide map.
 */
export function resolveSchemeCodes(
  schemeIndex: SchemeIndex | null,
  masterIndex: MasterSchemeIndex | null,
  amcFundName: string,
  schemeName: string,
): SchemeCodeDecision {
  let ambiguous = false;

  if (schemeIndex) {
    const res = resolveSchemeCode(schemeIndex, {
      amc: { fundName: amcFundName },
      schemeName,
    });
    if (res.status === "matched" && res.schemeCodes.length > 0) {
      const codes = [...res.schemeCodes];
      // Counted APART from `navAll`, and apart from `ambiguous`. A plan-variant
      // family is a RESOLVED scheme, and folding it into either would hide the
      // one number that says whether MONEY-1294's writer is doing anything.
      return {
        codes,
        via: codes.length === 1 ? "navAll" : "planVariant",
        ambiguous: false,
      };
    }
    if (res.status === "ambiguous") ambiguous = true;
  }

  if (masterIndex) {
    const codes = masterIndex.byAmc
      .get(amcFundName)
      ?.get(schemeMatchKeyOf(schemeName));
    if (codes && codes.size === 1) {
      return { codes: [...codes], via: "master", ambiguous: false };
    }
    if (codes && codes.size > 1) ambiguous = true;
  }

  return { codes: [], via: null, ambiguous };
}

/**
 * The upsert {@link writeSheet} performs, as a seam — MONEY-1401 review F3.
 *
 * `amfiSchemeCode`/`amfiSchemeCodes` had NO behavioural coverage: three
 * mutations on the two lines that fill them (`?? null` -> `null`,
 * `amfiSchemeCodes` -> `[]`, and mis-counting `resolution`) all left 158/158
 * GREEN, because the only guard was `assert.match(data, /\bamfiSchemeCodes\b/)`
 * — an identifier scan that `amfiSchemeCodes: []` satisfies. The second of
 * those IS MONEY-1294's original defect verbatim (non-empty on 0 of 54,248
 * rows). A resolver that decides correctly and a payload that drops the answer
 * is that defect rebuilt one layer down, so the PAYLOAD is what has to be
 * asserted.
 */
export type HoldingUpsert = (
  args: Parameters<typeof prisma.mfPortfolioHolding.upsert>[0],
) => Promise<unknown>;

const upsertHolding: HoldingUpsert = (args) =>
  prisma.mfPortfolioHolding.upsert(args);

export async function writeSheet(
  amc: AmcId,
  amcFundName: string,
  sheet: AmcSchemeSheet,
  sourceUrl: string,
  ctx: WriteContext,
  upsert: HoldingUpsert = upsertHolding,
): Promise<number> {
  const { period, schemeIndex, masterIndex, resolution } = ctx;
  const schemeName = sheet.schemeName ?? sheet.sheetName;
  const schemeKey = schemeKeyOf(schemeName);

  // Resolve the AMFI scheme code(s) — see {@link resolveSchemeCodes}.
  const decided = resolveSchemeCodes(
    schemeIndex,
    masterIndex,
    amcFundName,
    schemeName,
  );
  const amfiSchemeCodes = decided.codes;
  const amfiSchemeCode: string | null = amfiSchemeCodes[0] ?? null;
  if (decided.via !== null) resolution[decided.via]++;
  else if (decided.ambiguous) resolution.ambiguous++;
  else resolution.unresolved++;

  if (!schemeKey) return 0;

  let written = 0;
  for (const h of sheet.holdings as readonly AmcHolding[]) {
    const instrumentName = h.instrumentName.trim();
    if (!instrumentName) continue;

    // ISIN resolves the instrument when we carry it. Null is common and fine —
    // cash, TREPS and several debt lines legitimately have no ISIN, and
    // dropping them would make the weights fail to sum to 100.
    //
    // MEMOISED per run — MONEY-1401 F12. This was an unconditional
    // `findFirst` per holding, i.e. ~49,000 sequential round trips across a
    // full month, and it is the same few thousand securities over and over.
    let instrumentId: string | null = null;
    if (h.isin) {
      instrumentId = await resolveInstrumentIdMemoised(
        ctx.instrumentIdByIsin,
        h.isin,
        async (isin) =>
          (
            await prisma.instrumentMapping.findFirst({
              where: { isin },
              select: { id: true },
            })
          )?.id ?? null,
      );
    }

    const data = {
      period,
      amc,
      schemeName,
      schemeKey,
      amfiSchemeCode,
      amfiSchemeCodes,
      isin: h.isin,
      instrumentName,
      instrumentId,
      holdingType: holdingTypeOf(h.section),
      industry: h.industry,
      rating: h.rating,
      quantity: h.quantity,
      marketValue: h.marketValueLakhs,
      percentToNav: h.pctToNav,
      source: sourceUrl,
    };

    await upsert({
      where: {
        period_amc_schemeKey_instrumentName: {
          period,
          amc,
          schemeKey,
          instrumentName,
        },
      },
      create: data,
      // A re-run overwrites. AMCs do re-publish a corrected disclosure, and the
      // 20th's straggler sweep re-reads what the 12th already got — both must
      // be no-ops on unchanged rows rather than duplicates.
      update: data,
    });
    written++;
  }
  return written;
}

/**
 * The URLs to try for one templatable house, in order — MONEY-1407.
 *
 * Two shapes, and the refusals are kept apart on purpose. A house with a
 * `buildUrl` needs no request to know where to look; UTI's file lives behind a
 * JSON index, so ASKING is a fetch that can fail on its own, separately from
 * the index answering and naming nothing. Collapsing the two would make "UTI's
 * site is down" and "UTI has not published this month" the same line in the
 * log, which is the shape `FETCH_FAILED`-for-everything already cost this job
 * once.
 *
 * The pick itself is PURE and lives in `amc-portfolio-sources.ts`; this is the
 * I/O around it, exactly as the page-scrape lane below wraps
 * `findMonthlyPortfolioLinks` / `pickLinkForMonth`.
 *
 * EXPORTED WITH AN INJECTED FETCHER — MONEY-1401. Both halves were tested and
 * the GLUE between them was not, which is the half that decides WHICH refusal
 * an operator reads. The seam is the same shape
 * `bse-announcements-sync.ts::defaultDownloadAttachment` uses: the default IS
 * the production path, so injecting changes nothing but testability.
 */
export async function resolveCandidateUrls(
  src: AmcSource,
  month: Date,
  fetchBody: (url: string) => Promise<string | null> = fetchText,
): Promise<{
  urls: string[];
  refusal: "DISCOVERY_FETCH_FAILED" | "NO_PICK" | null;
}> {
  if (src.discoverUrl) {
    const body = await fetchBody(src.discoverUrl.apiUrl(month));
    if (body === null) return { urls: [], refusal: "DISCOVERY_FETCH_FAILED" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A 200 that is not JSON is the index changing shape, not a missing
      // month. Same bucket as "named nothing", because neither yields a URL and
      // neither may be guessed past.
      return { urls: [], refusal: "NO_PICK" };
    }
    const url = src.discoverUrl.pick(parsed, month);
    return url === null
      ? { urls: [], refusal: "NO_PICK" }
      : { urls: [url], refusal: null };
  }

  // MONEY-1405 — ONE house has two spellings and neither is derivable.
  //
  // ICICI Prudential's month FOLDER alternates between the full name and the
  // abbreviation (`2026/June/…June…` then `2026/Aug/…August…`) while the
  // FILENAME is the full month either way. Both are observed 200s, so the fetch
  // settles which one this month used. This is NOT the guessing the registry's
  // header forbids: `altUrls` is empty for every other house, and a house whose
  // primary URL works never issues the second request.
  if (!src.buildUrl) return { urls: [], refusal: "NO_PICK" };
  return {
    urls: [src.buildUrl(month), ...(src.altUrls?.(month) ?? [])],
    refusal: null,
  };
}

/** What one workbook's sheets produced. Accumulates across a house's files. */
type SheetTally = Required<
  Pick<
    AmcAttemptTotals,
    | "sheets"
    | "holdings"
    | "written"
    | "stale"
    | "noAsOn"
    | "scaleSuspect"
    | "missingColumns"
  >
> &
  Pick<AmcAttemptTotals, "refusalExample">;

function newTally(): SheetTally {
  return {
    sheets: 0,
    holdings: 0,
    written: 0,
    stale: 0,
    noAsOn: 0,
    scaleSuspect: 0,
    missingColumns: 0,
  };
}

/**
 * Write one workbook's sheets, THROUGH THE GATE — MONEY-1404 C3 / MONEY-1405 D1.
 *
 * All three write sites (template, page-scrape, HDFC) share this, which is the
 * point: the defect being closed is a check that existed and was applied
 * nowhere, and three hand-copied loops is how the fourth site gets written
 * without one.
 *
 * A refused sheet still counts toward `holdings` — the workbook DID carry them,
 * and a tally that hid them would make a wholly-stale house look like a house
 * whose sheets came out empty, which is a different investigation.
 */
async function writeSheets(
  amc: AmcId,
  amcFundName: string,
  sheets: readonly AmcSchemeSheet[],
  sourceUrl: string,
  ctx: WriteContext,
  tally: SheetTally,
): Promise<void> {
  for (const sheet of sheets) {
    tally.sheets++;
    tally.holdings += sheet.holdings.length;

    const verdict = judgeSheetWrite(sheet, ctx.periodLabel);
    if (verdict.missingColumns) tally.missingColumns++;

    if (!verdict.write) {
      if (verdict.refusal === "STALE_FILE") tally.stale++;
      else if (verdict.refusal === "NO_AS_ON") tally.noAsOn++;
      else tally.scaleSuspect++;
      tally.refusalExample ??= verdict.detail ?? undefined;
      logger.warn(
        {
          amc,
          sheet: sheet.sheetName,
          asOfDate: sheet.asOfDate,
          requested: ctx.periodLabel,
          refusal: verdict.refusal,
          holdings: sheet.holdings.length,
        },
        `sheet REFUSED (${verdict.refusal}) — ${verdict.detail}`,
      );
      continue;
    }

    tally.written += await writeSheet(amc, amcFundName, sheet, sourceUrl, ctx);
  }
}

/**
 * Log how much of AMFI's own industry list we can actually resolve — MONEY-1405.
 *
 * `AMC_SOURCES` can only say "how many did we write down", which measures our
 * effort rather than our coverage. Joined to AMFI's 57-AMC registry on
 * `amfiMfId` it says "14 of 57" and NAMES the remainder, which is the number a
 * scheduled run should be reporting. Fetching the page also archives it —
 * undated, under `current/` — so prod keeps the registry as it stood on each
 * run and QA replays those bytes instead of scraping AMFI a second time.
 *
 * ## Three properties, each load-bearing
 *
 * **It never fails the run.** This is a report, not a leg. The sync's job is to
 * store holdings and it can do that with no idea how many AMCs exist, so an
 * AMFI outage must cost a log line and nothing else. That is also why the
 * failure is logged at WARN with the cause named rather than swallowed: a
 * coverage line that silently stops appearing is the shape this whole ticket
 * is about.
 *
 * **It never adds a source.** A registry link is a landing page for 51 of the
 * 52 AMCs that publish one, and a guessed template 404s identically to "not
 * published yet" — so `provenance` is only ever set by a human who fetched the
 * current month and opened the file. Auto-promoting a link here would turn a
 * discovery signal into 40 sources that report a clean empty run forever.
 * `scripts/data/amc-disclosure-registry.ts` is where an operator does the
 * triage; this is only the nightly number.
 *
 * **A scoped run does not spend the fetch.** `only: ["KOTAK"]` is a manual,
 * targeted invocation; industry coverage is unchanged by it and asking AMFI
 * again on every debugging run is noise upstream for nothing.
 */
async function reportRegistryCoverage(only?: readonly AmcId[]): Promise<void> {
  if (only !== undefined) return;
  try {
    const registry = await fetchAmfiAmcRegistry();
    const coverage = resolverCoverage(
      registry.amcs,
      scrapableAmcs().map((sc) => sc.amfiMfId),
    );
    logger.info(
      {
        total: coverage.total,
        resolved: coverage.resolved.length,
        knownButNotFetchable: coverage.knownButNotFetchable.length,
        missing: coverage.missing.length,
        // NAMED, not just counted. "40 missing" is an unquantified remainder
        // that nobody can act on; the names are the triage list, and the
        // discovery script turns them into URLs and statuses.
        missingAmcs: coverage.missing,
      },
      `AMC resolver coverage: ${coverage.resolved.length} of ${coverage.total} ` +
        `AMFI-registered AMCs are fetchable`,
    );
  } catch (error: unknown) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "AMC registry coverage UNAVAILABLE — the report is missing for this " +
        "run; the sync itself is unaffected",
    );
  }
}

/**
 * Publish the houses this hop did not reach back onto our OWN topic — F12.
 *
 * NO new message field and no new publisher: the route already accepts
 * `{month, only}` (`routes/mf-portfolio-sync.ts`), and `only` carrying the
 * remainder IS the continuation cursor. That is also why this job needs no
 * rotation marker and no `MAX_CHAIN_DEPTH` — the follow-up names exactly what
 * is left, so the list strictly shrinks every hop and the chain is bounded by
 * the house count without reading a database, a clock or a queue.
 *
 * `month` is forwarded as the LABEL this run resolved, never re-defaulted. A
 * follow-up that recomputed "last month" would silently cross a month boundary
 * on a run started near midnight on the 1st and write the remainder into the
 * wrong period.
 *
 * ONLY ON A HEALTHY HOP. An unhealthy one returns 500, Pub/Sub redelivers the
 * ORIGINAL message, and that redelivery re-runs the same houses and reaches
 * this point itself — chaining as well would fan one truncated run out into up
 * to five overlapping chains. The remainder is still NAMED in the outcome
 * either way, so nothing is lost silently.
 *
 * AND ONLY WHILE THE DEPTH ALLOWS — MONEY-1490. The refusal is deliberately
 * LOUD: a chain that stops because it ran out of links has not finished the
 * month, and the houses it never reached are named in the log so the gap is a
 * statement rather than an absence. Reaching the cap at all means something
 * upstream is wrong — a correct chain terminates in ~19 hops.
 *
 * A failed publish is a WARN and not a throw: the rows this hop wrote are
 * already committed, and turning a successful partial run into a 500 would
 * redeliver it rather than recover the remainder.
 */
async function chainDeferredHouses(
  out: MfPortfolioSyncResult,
  monthLabel: string,
  chainDepth: number,
): Promise<void> {
  if (out.deferred.length === 0 || !out.ok) return;

  const nextDepth = chainDepth + 1;
  if (nextDepth >= MAX_CHAIN_DEPTH) {
    logger.error(
      {
        month: monthLabel,
        chainDepth,
        maxChainDepth: MAX_CHAIN_DEPTH,
        unreached: out.deferred,
      },
      `NOT CHAINING — chain depth ${chainDepth}/${MAX_CHAIN_DEPTH} reached ` +
        `with ${out.deferred.length} house(s) still unreached: ` +
        `${out.deferred.join(",")}. A correct chain ends in ~19 hops, so ` +
        `hitting this cap means the remainder is not shrinking — check that ` +
        `the follow-up is actually receiving its 'only' (MONEY-1490).`,
    );
    return;
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.MF_PORTFOLIO_SYNC));
    await topic.publishMessage({
      json: { month: monthLabel, only: out.deferred, chainDepth: nextDepth },
    });
    logger.info(
      { month: monthLabel, only: out.deferred, chainDepth: nextDepth },
      `chained ${out.deferred.length} deferred house(s) to a follow-up run ` +
        `(link ${nextDepth}/${MAX_CHAIN_DEPTH})`,
    );
  } catch (error: unknown) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        deferred: out.deferred,
      },
      "could NOT chain the deferred houses — this month's remainder is " +
        "unwritten until the next scheduled run (the 12th and the 20th)",
    );
  }
}

/**
 * Every key `getFundComposition` writes, across both `source` variants and all
 * three fund types. `fund-composition` is the cache MODULE and `_global` is the
 * userId every call site passes — the two segments `generateCacheKey` puts
 * before the identifier, neither of which `escapeSegment` touches (it escapes
 * only `%` and `:`).
 */
const COMPOSITION_CACHE_PATTERN = "fund-composition:_global:*";

/**
 * Drop the whole `fund-composition` cache once a run has landed holdings —
 * MONEY-1405 residual.
 *
 * `getFundComposition` caches for 24h under
 * `fund-composition:_global:{fundType}:{fundId}:{schemeCode}:{source}`, and
 * NOTHING invalidated it. So a freshly-filed month sat unread for up to a day,
 * and — worse — a `GEMINI_RECALL` composition kept being served after the real
 * disclosure arrived, because the disclosure slot still held the `{none:true}`
 * sentinel written before the filing existed.
 *
 * ## Why the whole namespace, and not the three keys we changed
 *
 * `compositionCacheKey` is PRIVATE to `packages/services`. Rebuilding its
 * format here would be a second copy of a key, and a drifted cache key does not
 * fail — it deletes nothing and reports success, which is the exact silent
 * shape this branch exists to close. And it could only ever be half a fix: an
 * ETF's `fundId` is its TRADING SYMBOL, which `mf_portfolio_holdings` does not
 * carry at all (the service says so itself), so a worker-side key builder would
 * clear every MF and leave every ETF stale.
 *
 * `clearCachePattern` is already exported, needs no private format, and covers
 * MF, ETF, INDEX and BOTH `source` variants by construction.
 *
 * The blast radius is bounded and cheap: `getFundComposition` never calls
 * Gemini — a miss re-reads Mongo — so the cost is one extra DB read per fund
 * anyone looks at in the following 24h, twice a month. A precise invalidation
 * is better and belongs in `packages/services`, as an exported
 * `invalidateFundComposition(schemeCode)` that knows both key shapes.
 *
 * ## It only runs when something LANDED
 *
 * `written === 0` means no row changed, so there is nothing stale to drop.
 * Never throws: a Redis outage must not fail a run whose holdings are already
 * committed, and `clearCachePattern` already returns 0 rather than throwing
 * when Redis is unreachable.
 *
 * KNOWN LIMIT, not fixed here: this clears Redis and only THIS process's L1.
 * A web instance keeps its own in-memory copy for that namespace's memory TTL.
 * `packages/cache/src/types.ts` documents that asymmetry as a property of the
 * cache, and it is not this job's to change.
 */
export async function invalidateCompositionCache(
  written: number,
  clear: (pattern: string) => Promise<number> = clearCachePattern,
): Promise<void> {
  if (written === 0) return;
  try {
    const cleared = await clear(COMPOSITION_CACHE_PATTERN);
    logger.info({ cleared, written }, "fund-composition cache invalidated");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fund-composition cache NOT invalidated — the holdings are written, but " +
        "a fund page may serve its previous composition for up to 24h",
    );
  }
}

export async function processMfPortfolioSync(opts?: {
  /** Any date inside the month whose disclosures are wanted. */
  month?: Date;
  /** Restrict to these AMCs (still subject to provenance). */
  only?: readonly AmcId[];
  /**
   * How many follow-ups deep this run is; 0 on a scheduler trigger.
   *
   * CARRIED on the message, never recomputed — a hop that derived its own
   * depth would restart the count every link and {@link MAX_CHAIN_DEPTH} would
   * bound nothing.
   */
  chainDepth?: number;
}): Promise<MfPortfolioSyncResult> {
  const startedAt = Date.now();
  // Default to the PREVIOUS month: a disclosure for month M is published in
  // M+1, so a run on the 12th of August wants July's data. Using the current
  // month would ask for a file that does not exist yet and read the 404 as a
  // publication delay.
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const month =
    opts?.month ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = monthStart(month);
  const periodLabel = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, "0")}`;

  // ONE NAVAll fetch for the whole run — it is a single ~7 MB file covering
  // every AMC, so fetching it per-AMC would be twelve identical downloads.
  const schemeIndex = await buildSchemeIndexOrNull();
  // ONE master read for the whole run, for the same reason.
  const masterIndex = await buildMasterSchemeIndexOrNull();

  const ctx: WriteContext = {
    period,
    periodLabel,
    schemeIndex,
    masterIndex,
    instrumentIdByIsin: new Map(),
    resolution: {
      navAll: 0,
      planVariant: 0,
      master: 0,
      ambiguous: 0,
      unresolved: 0,
    },
  };

  const fetchable = fetchableSources().filter(
    (s) => !opts?.only || opts.only.includes(s.id),
  );
  const skippedByProvenance = amcsSkippedByProvenance();

  const out: MfPortfolioSyncResult = {
    ok: true,
    period: periodLabel,
    // Pushed to as each house is REACHED, never pre-filled — MONEY-1401 F12.
    // This used to be `fetchable.map(...)`, which claimed every templatable
    // house was attempted before the loop ran; with a budget that can hand the
    // tail to a follow-up, a pre-filled list would report houses this hop never
    // touched, and `selected` feeds the job outcome.
    attempted: [],
    skippedByProvenance,
    perAmc: [],
    written: 0,
    deferred: [],
    refused: { stale: 0, noAsOn: 0, scaleSuspect: 0, missingColumns: 0 },
    schemeCodes: ctx.resolution,
  };

  /** Fold one house's tally into the run totals. */
  const absorb = (t: SheetTally): void => {
    out.written += t.written;
    out.refused.stale += t.stale;
    out.refused.noAsOn += t.noAsOn;
    out.refused.scaleSuspect += t.scaleSuspect;
    out.refused.missingColumns += t.missingColumns;
  };

  /**
   * Hand this house to a follow-up message instead of starting it — F12.
   *
   * Once one house is deferred every later house is too (`out.deferred.length`
   * short-circuits the clock), so the remainder stays CONTIGUOUS in the run's
   * own order. A budget that re-tested the clock per house would skip the slow
   * ones and take the fast ones, leaving a remainder nothing can express as a
   * list.
   */
  const deferIfOverBudget = (amc: AmcId): boolean => {
    if (
      out.deferred.length > 0 ||
      shouldDeferRemainingHouses({
        startedAt,
        now: Date.now(),
        housesDone: out.attempted.length,
      })
    ) {
      out.deferred.push(amc);
      return true;
    }
    return false;
  };

  for (const src of fetchable) {
    if (deferIfOverBudget(src.id)) continue;
    out.attempted.push(src.id);
    const resolved = await resolveCandidateUrls(src, month);
    if (resolved.refusal !== null) {
      out.perAmc.push({
        amc: src.id,
        ok: false,
        status: resolved.refusal,
        bytes: 0,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      logger.warn(
        {
          amc: src.id,
          period: periodLabel,
          api: src.discoverUrl?.apiUrl(month),
        },
        resolved.refusal === "DISCOVERY_FETCH_FAILED"
          ? "the discovery endpoint did not answer — no URL to try"
          : "the discovery endpoint answered and named no single file for " +
              "this month — NOT guessed",
      );
      continue;
    }
    const candidates = resolved.urls;
    let url = candidates[0]!;
    let bytes: Uint8Array | null = null;
    for (const candidate of candidates) {
      bytes = await download(candidate);
      if (bytes !== null) {
        url = candidate;
        break;
      }
    }
    if (bytes === null) {
      out.perAmc.push({
        amc: src.id,
        ok: false,
        status: "FETCH_FAILED",
        bytes: 0,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      logger.warn(
        { amc: src.id, url, backfillable: src.backfillable },
        src.backfillable
          ? "fetch failed — retryable next run"
          : "fetch failed and this AMC keeps ONLY the current month — this " +
              "period may be unrecoverable",
      );
      continue;
    }

    const parsed = parseAmcPortfolioWorkbook(bytes);
    if (parsed === null) {
      // Distinct from FETCH_FAILED and from a workbook with zero holdings.
      // Collapsing them is how "we cannot read this any more" becomes
      // indistinguishable from "the AMC published nothing".
      out.perAmc.push({
        amc: src.id,
        ok: false,
        status: "UNRECOGNISED_WORKBOOK",
        bytes: bytes.byteLength,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      logger.error(
        { amc: src.id, url, bytes: bytes.byteLength },
        "workbook UNRECOGNISED — the format changed",
      );
      continue;
    }

    const tally = newTally();
    await writeSheets(src.id, src.name, parsed.sheets, url, ctx, tally);
    absorb(tally);
    // MONEY-1238 — was an unconditional `ok: true, status: "OK"`. A workbook
    // that downloaded and parsed but stored nothing reported as a clean success.
    const verdict = judgeAmcAttempt({
      ...tally,
      // Reached only AFTER a successful download and parse — MONEY-1236.
      // Without this the zero-sheet outcome reported "FETCH_FAILED".
      parsedOk: true,
    });
    if (!verdict.ok) {
      logger.error(
        { amc: src.id, url, ...tally, status: verdict.status },
        "workbook parsed and NOTHING was stored — check the status: a " +
          "refusal names the file's own as-on date or its percent column, " +
          "and only PARSED_BUT_NOTHING_WRITTEN points at schemeKeyOf()",
      );
    }
    out.perAmc.push({
      amc: src.id,
      ok: verdict.ok,
      status: verdict.status,
      bytes: bytes.byteLength,
      sheets: tally.sheets,
      holdings: tally.holdings,
      written: tally.written,
    });
  }

  // ── Page-scrape houses ──────────────────────────────────────────────
  //
  // Seven AMCs publish their file links in served HTML rather than at a
  // templatable URL, so each needs TWO fetches: the landing page, then the file
  // the resolver picks out of it. Everything that decides WHICH link is pure and
  // lives in `amc-page-scrape.ts`; this loop is I/O.
  for (const cfg of scrapableAmcs()) {
    if (opts?.only && !opts.only.includes(cfg.id)) continue;
    if (deferIfOverBudget(cfg.id)) continue;
    out.attempted.push(cfg.id);

    // MONEY-1198 — `cfg.pageRequest` is honoured, not assumed GET. Mirae's
    // listing endpoint is POST-only; a GET returns 200 with an error envelope.
    const pageHtml = await fetchText(cfg.pageUrl, cfg.pageRequest);
    if (pageHtml === null) {
      out.perAmc.push({
        amc: cfg.id,
        ok: false,
        status: "PAGE_FETCH_FAILED",
        bytes: 0,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      continue;
    }

    const links = findMonthlyPortfolioLinks(pageHtml, cfg.pageUrl, cfg);
    if (links === null) {
      // Not HTML at all — distinct from a page with no links on it.
      out.perAmc.push({
        amc: cfg.id,
        ok: false,
        status: "PAGE_NOT_HTML",
        bytes: 0,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      logger.error({ amc: cfg.id, url: cfg.pageUrl }, "landing page NOT HTML");
      continue;
    }

    // MONEY-1198 — a `perScheme` house needs ONE PICK PER SCHEME.
    //
    // THE BUG: this used to call `pickLinkForMonth(links, month)` with no
    // `scheme` argument, i.e. no filter. On a house that publishes one workbook
    // per scheme, EVERY scheme's file matches the month, so the count is never
    // 1 and the answer is null BY CONSTRUCTION — every month, forever. The
    // 2026-08-14 production log read
    //
    //   [mf-portfolio-sync] no single link for this month
    //     { amc: 'ZERODHA', period: '2026-07', linksOnPage: 338 }
    //     { amc: 'PPFAS',   period: '2026-07', linksOnPage: 403 }
    //
    // which looks like ambiguity IN THE DATA and is not: it is this call being
    // wrong. Measured on the committed fixtures the same holds for OLD_BRIDGE
    // and CAPITALMIND, and now Mirae (97 files/month) and Helios — six of the
    // twelve houses, none of which had ever produced a row.
    //
    // `schemesForMonth` returns exactly the values `pickLinkForMonth` compares
    // against, INCLUDING the `null` that means "the whole-AMC workbook", and
    // sorts that null FIRST — so a combined file is tried before fanning out.
    // For a non-perScheme house it yields the single `null`, which is the
    // previous behaviour exactly.
    //
    // Ambiguity is STILL never guessed. A per-scheme pick that returns null
    // (two spellings of one month — Zerodha ships both `Sep` and `Sept`) is
    // counted and skipped, not resolved by taking the first.
    const schemes = cfg.perScheme
      ? schemesForMonth(links, month)
      : [null as string | null];

    const picks = schemes
      .map((s) => pickLinkForMonth(links, month, s))
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (picks.length === 0) {
      out.perAmc.push({
        amc: cfg.id,
        ok: false,
        status: links.length === 0 ? "NO_LINKS_ON_PAGE" : "NO_UNIQUE_LINK",
        bytes: 0,
        sheets: 0,
        holdings: 0,
        written: 0,
      });
      logger.warn(
        {
          amc: cfg.id,
          period: periodLabel,
          linksOnPage: links.length,
          schemesForMonth: schemes.length,
        },
        "no resolvable link for this month",
      );
      continue;
    }

    // An AMBIGUOUS scheme is reported rather than silently absent: `schemes`
    // counts what was published, `picks` what resolved uniquely, and a gap
    // between them is the Sep/Sept case worth a human look.
    if (picks.length < schemes.length) {
      logger.warn(
        {
          amc: cfg.id,
          period: periodLabel,
          published: schemes.length,
          resolved: picks.length,
        },
        "some schemes did not resolve to a single link this month",
      );
    }

    // One AMC now spans MANY workbooks, so the per-AMC result is an aggregate.
    // A single bad file must not discard the ones that parsed: Mirae publishes
    // 97 files a month, and reporting the whole house FETCH_FAILED because the
    // 40th 404'd would throw away 96 good scheme portfolios.
    let amcBytes = 0;
    const tally = newTally();
    let fetchFailed = 0;
    let unrecognised = 0;

    for (const pick of picks) {
      const bytes = await download(pick.url);
      if (bytes === null) {
        fetchFailed++;
        continue;
      }
      amcBytes += bytes.byteLength;

      const parsed = parseAmcPortfolioWorkbook(bytes);
      if (parsed === null) {
        unrecognised++;
        logger.error(
          { amc: cfg.id, url: pick.url, bytes: bytes.byteLength },
          "workbook UNRECOGNISED — the format changed",
        );
        continue;
      }

      await writeSheets(cfg.id, cfg.name, parsed.sheets, pick.url, ctx, tally);
    }

    absorb(tally);

    // `ok` is "we STORED something", and the status names the DOMINANT failure
    // when we did not — never an unconditional OK. A house where every file
    // failed must not read as a success with zero holdings, which is the shape
    // that let an empty table look healthy for months.
    //
    // MONEY-1238 — this used to be `const gotSomething = amcSheets > 0`, i.e.
    // PARSED rather than WROTE, so a house whose every workbook parsed and
    // whose every `writeSheet` returned 0 reported `ok: true, written: 0`.
    // `parsedOk` — MONEY-1405. At least one of this house's files got past
    // BOTH the download and the parse. Without it a house whose workbooks
    // parsed to zero scheme sheets reported `FETCH_FAILED`, which is how Tata
    // went un-diagnosed: 1.76 MB fetched, 71 sheets in the file, and a status
    // that said the network had failed.
    const verdict = judgeAmcAttempt({
      ...tally,
      fetchFailed,
      unrecognised,
      parsedOk: picks.length - fetchFailed - unrecognised > 0,
    });
    out.perAmc.push({
      amc: cfg.id,
      ok: verdict.ok,
      status: verdict.status,
      bytes: amcBytes,
      sheets: tally.sheets,
      holdings: tally.holdings,
      written: tally.written,
    });

    if (tally.sheets > 0 && tally.written === 0) {
      logger.error(
        { amc: cfg.id, period: periodLabel, ...tally, status: verdict.status },
        "workbooks parsed and NOTHING was stored — check the status: a " +
          "refusal names the file's own as-on date or its percent column, " +
          "and only PARSED_BUT_NOTHING_WRITTEN points at schemeKeyOf()",
      );
    }

    if (verdict.ok && (fetchFailed > 0 || unrecognised > 0)) {
      logger.warn(
        {
          amc: cfg.id,
          period: periodLabel,
          files: picks.length,
          fetchFailed,
          unrecognised,
        },
        "partial month — some scheme workbooks did not land",
      );
    }
  }

  // ── HDFC: one file PER SCHEME ───────────────────────────────────────
  //
  // HDFC has a verified URL template but publishes a separate workbook for every
  // scheme, so a month alone cannot address it — it needs a scheme LIST. That
  // list did not exist until the NAVAll index above, which is why HDFC sat
  // `verified` but unfetchable.
  //
  // Proven 2026-08-14: six scheme names taken straight from NAVAll and pushed
  // through `buildHdfcUrl` returned 6/6 real workbooks (153-174 KB,
  // spreadsheetml). The reconstruction works because HDFC's filename uses the
  // scheme's base name exactly as AMFI prints it, before the first " - ".
  //
  // A 404 here is EXPECTED and not an error: NAVAll lists plan variants
  // ("…-Premium Plan") that have no separate disclosure file. They are counted,
  // not logged as failures — otherwise every run would look broken.
  const hdfc = amcSource("HDFC");
  const hdfcRequested =
    hdfc !== undefined && (!opts?.only || opts.only.includes("HDFC"));

  // A MISSING SCHEME INDEX IS A NAMED REFUSAL, NOT A SILENT SKIP — MONEY-1401
  // review finding 6.
  //
  // `schemeIndex` used to sit inside the `if` below, so when NAVAll was
  // unreachable — a fetch failure, or `parseNavAllGroups` returning null — this
  // entire house was skipped with NO `attempted`, NO `perAmc` row, NO `deferred`
  // entry and NO `skippedReason`. `selected` simply read one lower. Up to 200
  // scheme portfolios absent, `mfPortfolioRunOk` still true off the other
  // houses, route 200, Pub/Sub ACK, nothing to alert on.
  //
  // HDFC is the one house where that is total: it publishes a file PER SCHEME
  // and has no `buildUrl`, so the NAVAll index is not an enrichment here, it is
  // the only way to address the files at all. Every other house writes its
  // holdings with a null `amfiSchemeCode` and loses nothing but the join.
  //
  // So one AMFI outage used to make `mf-sync` throw loudly and this job lose its
  // largest house in silence. Now it is reported the same way every other
  // refusal is, and `judgeAmcAttempt`'s `ok: false` feeds `job.failed`.
  if (hdfcRequested && !schemeIndex) {
    out.attempted.push("HDFC");
    out.perAmc.push({
      amc: "HDFC",
      ok: false,
      status: "NO_SCHEME_INDEX",
      bytes: 0,
      sheets: 0,
      holdings: 0,
      written: 0,
    });
  }

  if (
    hdfc &&
    schemeIndex &&
    hdfcRequested &&
    // LAST in the run and the most expensive house there is — 200 sequential
    // downloads paced at 400ms. It is also the one most likely to be deferred,
    // which is why the follow-up carries it rather than the run dropping it.
    !deferIfOverBudget("HDFC")
  ) {
    out.attempted.push("HDFC");
    const amcIdx = schemeIndex.amcs.find((a) => a.amcName === hdfc.name);
    const bases = amcIdx
      ? [
          ...new Set(
            amcIdx.families.map(
              (f) => f.sampleName.split(" - ")[0]?.trim() ?? "",
            ),
          ),
        ].filter(Boolean)
      : [];

    const tally = newTally();
    let bytesTotal = 0;
    let absent = 0;

    for (const base of bases.slice(0, HDFC_MAX_SCHEMES)) {
      const url = buildHdfcUrl(month, base);
      const bytes = await download(url);
      // Pace it — this is ~160 sequential requests at one AMC's CDN.
      await sleep(HDFC_DELAY_MS);
      if (bytes === null) {
        absent++;
        continue;
      }
      const parsed = parseAmcPortfolioWorkbook(bytes);
      if (parsed === null) continue;
      bytesTotal += bytes.byteLength;
      await writeSheets("HDFC", hdfc.name, parsed.sheets, url, ctx, tally);
    }

    absorb(tally);
    // `absent` is deliberately NOT passed as `fetchFailed`: for HDFC a 404 is
    // EXPECTED (NAVAll lists plan variants with no separate disclosure file),
    // so counting it as a failure would make every healthy run read as partial.
    // The judgement is shared so the "parsed but stored nothing" state gets the
    // same name here as everywhere else — `NO_FILES` could not express it.
    // `absent` is NOT `fetchFailed` (see above), so it cannot be subtracted
    // here either: an expected 404 is not a file we failed to parse. What
    // `parsedOk` asks is "did any workbook reach the parser", and `bytesTotal`
    // is incremented only after a non-null parse, so it answers exactly that.
    const verdict = judgeAmcAttempt({ ...tally, parsedOk: bytesTotal > 0 });
    out.perAmc.push({
      amc: "HDFC",
      ok: verdict.ok,
      // `absent` is the interesting number: it is plan variants with no file,
      // NOT failures. If it ever approaches the whole list, the template broke.
      //
      // The verdict supplies the leading word rather than a literal "OK", so a
      // month where some sheets were REFUSED reads `OK_PARTIAL (2 stale) (…)`
      // instead of a clean OK — a clean run is still byte-identical, because
      // `verdict.status` is exactly "OK" when nothing was refused.
      status:
        tally.written > 0
          ? `${verdict.status} (${absent} scheme(s) had no file)`
          : tally.sheets > 0
            ? verdict.status
            : "NO_FILES",
      bytes: bytesTotal,
      sheets: tally.sheets,
      holdings: tally.holdings,
      written: tally.written,
    });
  }

  // A run where every attempted AMC failed is a failure, not a quiet month.
  //
  // MONEY-1238 — `ok` per AMC now means STORED, so this `some` is finally
  // asserting what it always read as. `written > 0` is stated explicitly rather
  // than inferred from it: the run verdict is the route's HTTP code, and the
  // thing that must be true is that rows landed.
  out.ok = mfPortfolioRunOk({ ...out, scoped: opts?.only !== undefined });

  // A scoped hop that reached houses and stored nothing is ROUTED as healthy
  // (see mfPortfolioRunOk) but it is NOT silent — MONEY-1490. Naming it at WARN
  // is the whole reason returning 200 is safe: the shortfall is reported, the
  // chain carries on, and the job's second monthly run is the retry.
  if (out.ok && out.written === 0) {
    logger.warn(
      {
        period: periodLabel,
        only: opts?.only,
        attempted: out.attempted,
        perAmc: out.perAmc.map((r) => ({ amc: r.amc, status: r.status })),
      },
      `scoped run stored NOTHING from ${out.attempted.length} house(s) — ` +
        `routed 200 because a redelivery would re-read the same absent files, ` +
        `and a 500 here would also abandon the rest of the chain. These houses ` +
        `are owed to the next scheduled run.`,
    );
  }

  if (!out.ok) {
    logger.error(
      {
        period: periodLabel,
        attempted: out.attempted.length,
        written: out.written,
        perAmc: out.perAmc.map((r) => ({ amc: r.amc, status: r.status })),
      },
      "run NOT ok — no AMC stored a single holding. The route will 500 and " +
        "Pub/Sub will redeliver; identity is (period, amc, schemeKey, " +
        "instrumentName) so a redelivery re-upserts the same rows",
    );
  }
  logger.info(out, "done");

  await invalidateCompositionCache(out.written);

  await chainDeferredHouses(out, periodLabel, opts?.chainDepth ?? 0);

  await reportRegistryCoverage(opts?.only);

  // The refusal counters reach `[job-outcome]` through `skippedReason` —
  // MONEY-1404 C3.
  //
  // `JobOutcome` has three numeric fields and none of them fits: `failed` is
  // "rows it attempted and could not persist" and a refused SHEET is neither a
  // row nor a failure to persist, and `transportFailures` is upstream calls.
  // Folding refusals into either would make the one signal this module exists
  // for — `selected > 0 && written === 0` — read as a write-path fault when the
  // write path is the part that is working. `skippedReason` is the free-form
  // field, it is printed on every line, and "why was less written than the
  // sheets suggest" is exactly the question it answers.
  const { stale, noAsOn, scaleSuspect, missingColumns } = out.refused;
  const refusedTotal = stale + noAsOn + scaleSuspect;
  const reasons: string[] = [];
  if (!out.ok) reasons.push("no AMC stored a single holding");
  if (refusedTotal > 0) {
    reasons.push(
      `${refusedTotal} sheet(s) refused (${stale} stale, ${noAsOn} no-as-on, ` +
        `${scaleSuspect} scale-suspect)`,
    );
  }
  // Counted, never refused — but a run where this climbs is an AMC quietly
  // dropping a column, which is invisible in `written`.
  if (missingColumns > 0) {
    reasons.push(`${missingColumns} sheet(s) written with a column missing`);
  }
  // NAMED, not just short. Without this the hop reports a smaller `selected`
  // than the month has houses and reads as a narrower run rather than a
  // truncated one — and the deferral would be invisible in every surface an
  // operator looks at.
  if (out.deferred.length > 0) {
    reasons.push(
      `${out.deferred.length} house(s) deferred to a follow-up on the ` +
        `${RUN_TIME_BUDGET_MS}ms run budget: ${out.deferred.join(",")}`,
    );
  }

  // `selected` is the AMCs ATTEMPTED — houses deliberately not fetched (an
  // unproven URL) are excluded by construction, so "we cover 3 of 5" cannot
  // read as a two-house failure.
  reportJobOutcome({
    job: "mf-portfolio-sync",
    selected: out.attempted.length,
    written: out.written,
    failed: out.perAmc.filter((r) => !r.status.startsWith("OK")).length,
    ...(reasons.length > 0 ? { skippedReason: reasons.join("; ") } : {}),
  });
  return out;
}
