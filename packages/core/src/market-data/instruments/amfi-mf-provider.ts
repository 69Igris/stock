/**
 * AMFI Mutual Fund Provider
 *
 * Fetches mutual fund master data from AMFI India's daily NAV feed.
 * URL: https://portal.amfiindia.com/spages/NAVAll.txt
 *
 * Format (SEMICOLON-separated, grouped by AMC). The column set is NOT fixed —
 * AMFI inserted `Plan` and `Option` in the middle of the row on 2026-08-19:
 * ```
 * BEFORE  Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 * SINCE   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
 * ```
 *
 * This module no longer carries its own copy of that grammar. `parseAmfiFeed`
 * delegates to `parseNavAllGroups` in `market-data/amfi-scheme-bridge.ts`, which
 * resolves the layout from the header's NAMES and returns `null` for bytes that
 * are not this feed — see MONEY-1403 for what the positional read cost.
 */

import { prisma } from "@usemoney/database";
import { parseNavAllGroups } from "../amfi-scheme-bridge";
import { getFeedAsset } from "../feed-archive";
import { toIstDateKey } from "../nse-holidays";

/**
 * The feed did not parse — MONEY-1403.
 *
 * A DISTINCT type rather than a bare `Error` because the caller has to tell
 * "AMFI restructured the file" apart from "the sync wrote nothing today", and
 * for 26 nights it could not: the parser returned `[]` and the job reported
 * success. Thrown, never returned, so no caller can accidentally treat an
 * unreadable feed as an empty one.
 */
export class AmfiNavGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmfiNavGrammarError";
  }
}

// ============== TYPES ==============

export interface AmfiMutualFund {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  nav: number;
  navDate: Date;
  isinGrowth: string | null;
  isinDividend: string | null;
  category: string;
  subCategory: string | null;
  plan: string | null;
}

export interface AmfiSyncResult {
  totalParsed: number;
  upserted: number;
  failed: number;
  errors: string[];
}

// ============== AMFI FEED URL ==============

/**
 * The CANONICAL host, not the historical one — MONEY-1198.
 *
 * `https://www.amfiindia.com/spages/NAVAll.txt` now answers 302 ->
 * `https://portal.amfiindia.com/spages/NAVAll.txt` (verified 2026-08-14; portal
 * returns 200 / 1,649,879 bytes). `fetch` follows redirects by default, so the
 * old constant still WORKED — which is exactly what made it dangerous: the
 * entire MF NAV ingest was resting on a redirect nobody had noticed moving.
 * Any later `redirect: "manual"`, a fetch wrapper that stops following, or an
 * egress policy that allows one host and not the other would have broken the
 * whole pipeline with no code change to blame.
 *
 * Pointing at the canonical host makes the redirect non-load-bearing.
 */
const AMFI_NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";

/**
 * AMFI's own NAV page — the referer a browser sends when it follows the link to
 * the file. Inlined rather than imported from `amfi-fund-metadata-provider.ts`
 * (which exports the same string as `AMFI_SCHEME_MASTER_REFERER`): that module
 * pulls in `xlsx` at import time, and the nightly NAV sync has no business
 * loading a spreadsheet library to obtain a URL.
 */
const AMFI_NAV_REFERER = "https://www.amfiindia.com/net-asset-value";

/**
 * GET NAVAll THROUGH THE ARCHIVE SEAM — MONEY-1404 C6.
 *
 * This feed was fetched with a bare `fetch()` until now, which meant AMFI was
 * in none of the three things the seam buys:
 *
 *   - prod ARCHIVED nothing, so there was no historical copy of the file to
 *     date a grammar change against. When AMFI moved two columns on 2026-08-19
 *     the only way to find out WHEN was to ask AMFI for a file it no longer
 *     serves. MONEY-1403 needed exactly that and did not have it.
 *   - QA REPLAYED nothing, so it scraped AMFI itself (when it ran at all).
 *   - `no-feed-fetch-bypass.test.ts` guarded nothing, because a host that is
 *     not in `FEED_HOSTS` is a host the scan cannot see. The three AMFI/MFAPI
 *     hosts are on that list as of this ticket.
 *
 * The descriptor is DATED, so each day gets its own object. The URL's basename
 * is the constant `NAVAll.txt`, so without an explicit `basename` every fetch
 * in a month would overwrite one key — a dated descriptor with an undated
 * filename is the worst of both, since `current/` at least SAYS it overwrites.
 * The date is the IST day we FETCHED on, not the NAV date inside the file:
 * that is the only one of the two known before parsing, and it is what "the
 * file AMFI was serving on day D" means.
 *
 * `null` from the seam is a 404, and for this feed a 404 is a FETCH FAILURE,
 * never an empty feed — AMFI publishes ~14,300 schemes every calendar day. That
 * distinction is the whole point of MONEY-1403: for 26 nights "nothing came
 * back" and "nothing was published" were the same value.
 */
async function fetchNavAllText(timeoutMs?: number): Promise<string> {
  const day = new Date();
  const res = await getFeedAsset(
    AMFI_NAV_URL,
    AMFI_NAV_REFERER,
    {
      exchange: "AMFI",
      feed: "navall",
      date: day,
      basename: `NAVAll-${toIstDateKey(day)}.txt`,
    },
    undefined,
    timeoutMs === undefined ? undefined : { timeoutMs },
  ).catch((error: unknown) => {
    // Rewrapped so every failure of this fetch reads the same way whether it
    // came from the transport, the archive layer, or a non-OK status.
    throw new Error(
      `Failed to fetch AMFI NAV feed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (res === null) {
    throw new Error(
      "Failed to fetch AMFI NAV feed: 404 — AMFI publishes NAVAll every " +
        "calendar day, so a missing file is a broken fetch, not a quiet day.",
    );
  }

  return res.text();
}

// `SECTION_HEADER` used to be duplicated here, with a comment arguing that
// importing the bridge would invert a dependency. MONEY-1403 settled that
// argument the expensive way: the duplicated GRAMMAR beside it went stale and
// cost 26 nights of NAV. The regex now lives only in the bridge, along with
// everything else that describes this file's shape.

// ============== CATEGORY DETECTION ==============

/**
 * Detect MF category from scheme name.
 * AMFI doesn't provide structured categories, so we infer from scheme name keywords.
 *
 * Exported for unit testing; the production path reaches it via `parseAmfiFeed`.
 */
export function detectCategory(schemeName: string): {
  category: string;
  subCategory: string | null;
  plan: string | null;
} {
  const upper = schemeName.toUpperCase();

  // Plan detection
  let plan: string | null = null;
  if (upper.includes("DIRECT")) plan = "DIRECT";
  else if (upper.includes("REGULAR")) plan = "REGULAR";

  // Sub-category detection
  let subCategory: string | null = null;
  if (upper.includes("GROWTH")) subCategory = "Growth";
  else if (upper.includes("DIVIDEND") || upper.includes("IDCW"))
    subCategory = "Dividend";

  // Category detection from scheme name keywords
  let category = "Other";

  // Equity categories
  if (upper.includes("LARGE CAP") || upper.includes("LARGECAP"))
    category = "Large Cap";
  else if (upper.includes("MID CAP") || upper.includes("MIDCAP"))
    category = "Mid Cap";
  else if (upper.includes("SMALL CAP") || upper.includes("SMALLCAP"))
    category = "Small Cap";
  else if (upper.includes("FLEXI CAP") || upper.includes("FLEXICAP"))
    category = "Flexi Cap";
  else if (upper.includes("MULTI CAP") || upper.includes("MULTICAP"))
    category = "Multi Cap";
  else if (upper.includes("ELSS") || upper.includes("TAX")) category = "ELSS";
  else if (upper.includes("FOCUSED")) category = "Focused";
  else if (upper.includes("VALUE")) category = "Value";
  else if (upper.includes("CONTRA")) category = "Contra";
  else if (upper.includes("DIVIDEND YIELD")) category = "Dividend Yield";
  // Sectoral/Thematic
  else if (upper.includes("SECTORAL") || upper.includes("SECTOR"))
    category = "Sectoral";
  else if (upper.includes("THEMATIC")) category = "Thematic";
  // Debt categories
  else if (upper.includes("LIQUID")) category = "Liquid";
  else if (upper.includes("ULTRA SHORT")) category = "Ultra Short Duration";
  else if (upper.includes("SHORT DURATION") || upper.includes("SHORT TERM"))
    category = "Short Duration";
  else if (upper.includes("MEDIUM DURATION") || upper.includes("MEDIUM TERM"))
    category = "Medium Duration";
  else if (upper.includes("LONG DURATION") || upper.includes("LONG TERM"))
    category = "Long Duration";
  else if (upper.includes("CORPORATE BOND")) category = "Corporate Bond";
  else if (upper.includes("BANKING") || upper.includes("PSU BOND"))
    category = "Banking & PSU";
  else if (upper.includes("GILT")) category = "Gilt";
  else if (upper.includes("DYNAMIC BOND")) category = "Dynamic Bond";
  else if (upper.includes("OVERNIGHT")) category = "Overnight";
  else if (upper.includes("MONEY MARKET")) category = "Money Market";
  else if (upper.includes("CREDIT RISK")) category = "Credit Risk";
  else if (upper.includes("FLOATER")) category = "Floater";
  // Hybrid categories
  else if (upper.includes("AGGRESSIVE HYBRID")) category = "Aggressive Hybrid";
  else if (upper.includes("CONSERVATIVE HYBRID"))
    category = "Conservative Hybrid";
  else if (upper.includes("BALANCED ADVANTAGE") || upper.includes("BAF"))
    category = "Balanced Advantage";
  else if (upper.includes("MULTI ASSET")) category = "Multi Asset";
  else if (upper.includes("EQUITY SAVINGS")) category = "Equity Savings";
  else if (upper.includes("ARBITRAGE")) category = "Arbitrage";
  // Index/ETF
  else if (upper.includes("INDEX")) category = "Index Fund";
  else if (upper.includes("ETF")) category = "ETF";
  else if (upper.includes("FUND OF FUNDS") || upper.includes("FOF"))
    category = "Fund of Funds";
  // Generic equity
  else if (
    upper.includes("EQUITY") &&
    !upper.includes("HYBRID") &&
    !upper.includes("DEBT")
  )
    category = "Equity";
  // Generic debt
  else if (
    upper.includes("DEBT") ||
    upper.includes("BOND") ||
    upper.includes("INCOME")
  )
    category = "Debt";
  else if (upper.includes("HYBRID")) category = "Hybrid";

  return { category, subCategory, plan };
}

// ============== FETCH & PARSE ==============

/**
 * Parse the raw AMFI NAV feed text into structured MF data.
 *
 * Pure (no I/O): exported so the parsing contract can be unit-tested directly.
 * `fetchAmfiNavFeed` fetches the feed and delegates the parsing here, so this
 * export is the SAME code the production sync path runs.
 */
export function parseAmfiFeed(text: string): AmfiMutualFund[] {
  // ── ONE PARSER — MONEY-1403 ────────────────────────────────────────────────
  //
  // This function used to carry its own copy of the NAVAll grammar and read the
  // NAV out of `parts[4]`. On or about 2026-08-19 AMFI inserted `Plan` and
  // `Option` between `Scheme Name` and `Net Asset Value`, so `parts[4]` became
  // `"Direct Plan"`, `parseFloat` returned NaN, `if (isNaN(nav)) continue`
  // skipped all 14,362 rows, and this returned `[]` — for 26 nights, at exit 0,
  // with no monitor able to tell a moved column from an empty feed.
  //
  // `amfi-scheme-bridge.ts` held the SAME grammar and broke the same day, but
  // broke LOUDLY: it rejected every row for the wrong width and returned `null`,
  // which is why `mf-portfolio-sync` was the only job that said anything. Two
  // copies of one rule, and only the copy nobody called was safe.
  //
  // So the grammar now lives in exactly one place. `parseNavAllGroups` reads the
  // layout from the header's NAMES and returns `null` for bytes that are not
  // this feed; everything below is the MAPPING from its records onto the shape
  // this NAV sync stores, and the two places where a NAV sync is deliberately
  // stricter than the bridge are marked.
  const file = parseNavAllGroups(text);
  if (file === null) {
    throw new AmfiNavGrammarError(
      "AMFI NAVAll is unreadable — the feed grammar changed, or the body is " +
        "not the NAV feed. Nothing was parsed; refusing to report an empty " +
        "sync as a successful one.",
    );
  }

  const funds: AmfiMutualFund[] = [];

  for (const group of file.groups) {
    for (const scheme of group.schemes) {
      // A NAV sync drops a row it cannot price — the bridge deliberately keeps
      // it, because there the scheme code is the payload and the price is not.
      if (scheme.nav === null || scheme.nav <= 0) continue;
      if (scheme.navDate === null) continue;

      // `navDate` is built from the PARTS rather than from the `YYYY-MM-DD`
      // string, to preserve the exact instant this sync has always written.
      // `new Date("11-Sep-2026")` is LOCAL midnight; `new Date("2026-09-11")` is
      // UTC midnight — a 5.5 h shift in IST on every one of ~14,000 rows.
      // Normalising that is a deliberate, separate change, not a side effect of
      // repairing the parser.
      const [y, m, d] = scheme.navDate.split("-").map(Number);
      if (y === undefined || m === undefined || d === undefined) continue;
      const navDate = new Date(y, m - 1, d);
      if (isNaN(navDate.getTime())) continue;

      const { category, subCategory, plan } = detectCategory(scheme.schemeName);

      funds.push({
        schemeCode: scheme.schemeCode,
        schemeName: scheme.schemeName,
        amcName: group.amcName,
        nav: scheme.nav,
        navDate,
        // The bridge nulls these by ISIN SHAPE where this parser nulled only a
        // literal `-`. Measured on the live feed 2026-09-13: `isinGrowth`
        // unchanged on all 14,361 rows; `isinDividend` newly null on 10 rows,
        // whose only two distinct values are `HDFCNIVODG` (a ticker) and
        // `Redeemed` (a status word). Strictly a repair.
        isinGrowth: scheme.isinGrowth,
        isinDividend: scheme.isinReinvestment,
        category,
        subCategory,
        // NOT taken from the feed's new `Plan` column, deliberately. That column
        // is authoritative and `detectCategory` only guesses from the name, but
        // its vocabulary differs (`"Direct Plan"` vs this column's `"Direct"`)
        // and switching would rewrite a stored value on every row. Separate
        // change; `NavAllScheme.plan`/`.option` carry it when someone wants it.
        plan,
      });
    }
  }

  return funds;
}

/**
 * Fetches and parses the AMFI NAV feed.
 * Returns structured MF data.
 */
export async function fetchAmfiNavFeed(): Promise<AmfiMutualFund[]> {
  return parseAmfiFeed(await fetchNavAllText());
}

/**
 * Parse AMFI date format: "31-Jan-2026" → Date
 *
 * Exported for unit testing; the production path reaches it via `parseAmfiFeed`.
 */
export function parseAmfiDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============== ISIN RESOLVER ==============

/**
 * Resolve an ISIN to an AMFI scheme code by searching the AMFI NAV feed.
 * This is a fallback for when ISINs aren't yet stored in MutualFundMaster.
 *
 * Fetches the raw AMFI text feed and does a string search for the ISIN.
 * Returns the scheme code if found, or null.
 */
export async function resolveIsinToSchemeCode(
  isin: string,
): Promise<{ schemeCode: string; schemeName: string } | null> {
  try {
    // Same seam, same archive key as the nightly sync — MONEY-1404 C6.
    //
    // Its only caller today is `apps/web/app/mf/[schemeCode]/page.tsx`, where
    // NO archive store is registered (`setFeedArchiveStore` is called by the
    // workers), so `getFeedAsset` is a passthrough there and this still fetches
    // AMFI exactly as before. That is the point rather than a shortfall: the
    // call can no longer BYPASS the seam, so if a store is ever registered in
    // that host it replays for free, and the bypass scan can see this file.
    //
    // The 15 s timeout is preserved — this is a fallback inside a user-facing
    // lookup, not a nightly job, and the seam's default is 30 s.
    const text = await fetchNavAllText(15_000);

    // Third copy of the grammar, removed — MONEY-1403. This loop read
    // `parts[1]`/`parts[2]`, which sit BEFORE the two columns AMFI inserted on
    // 2026-08-19, so it alone kept working. That is luck, not design: the next
    // insertion could land to its left, and the `catch` below would report the
    // failure as "the ISIN is not in the feed".
    const file = parseNavAllGroups(text);
    if (file === null) {
      console.warn(
        `[amfi] Cannot resolve ISIN ${isin}: NAVAll is unreadable (the feed ` +
          `grammar changed). This is NOT "the ISIN is absent" — MONEY-1403.`,
      );
      return null;
    }

    for (const group of file.groups) {
      for (const scheme of group.schemes) {
        const isinGrowth = scheme.isinGrowth;
        const isinDividend = scheme.isinReinvestment;
        if (isinGrowth !== isin && isinDividend !== isin) continue;

        const schemeCode = scheme.schemeCode;
        const schemeName = scheme.schemeName;
        console.log(`[amfi] Resolved ISIN ${isin} → schemeCode ${schemeCode}`);

        // Also update MutualFundMaster with the ISIN for future lookups
        try {
          await prisma.mutualFundMaster.update({
            where: { schemeCode },
            data: {
              ...(isinGrowth === isin && { isinGrowth: isin }),
              ...(isinDividend === isin && { isinDividend: isin }),
            },
          });
        } catch {
          // Record might not exist yet - that's fine
        }

        return { schemeCode, schemeName };
      }
    }

    return null;
  } catch (error) {
    console.warn(
      `[amfi] Failed to resolve ISIN ${isin}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ============== SYNC ==============

/**
 * Syncs AMFI mutual fund data into the MutualFundMaster table.
 * Upserts by schemeCode.
 */
export async function syncAmfiMutualFunds(): Promise<AmfiSyncResult> {
  const result: AmfiSyncResult = {
    totalParsed: 0,
    upserted: 0,
    failed: 0,
    errors: [],
  };

  console.log("[amfi-sync] Fetching AMFI NAV feed...");
  const funds = await fetchAmfiNavFeed();
  result.totalParsed = funds.length;
  console.log(`[amfi-sync] Parsed ${funds.length} mutual funds`);

  // ── ZERO IS A FAILURE, NOT A QUIET DAY — MONEY-1403 ────────────────────────
  //
  // AMFI publishes ~14,300 schemes every single day. There is no state of the
  // world in which this feed legitimately yields none, so a zero here means the
  // bytes were not what we think they are — a moved column, an error page
  // served with a 200, a truncated download.
  //
  // For 26 nights this function returned a clean result with `totalParsed: 0`,
  // `processMfSync` logged it, the route answered 200, and Pub/Sub ACKed. The
  // deployed job looked identical to a healthy one, because a scheduled job
  // that returns 200 having written nothing is indistinguishable from an idle
  // one (MONEY-1214 / MONEY-1220). Throwing makes the route 500, which makes
  // Pub/Sub retry and then dead-letter, which is a signal.
  //
  // `parseAmfiFeed` already throws `AmfiNavGrammarError` for bytes it cannot
  // read at all. This catches the other shape: a file that parsed structurally
  // but produced no priceable row.
  if (funds.length === 0) {
    throw new Error(
      "[amfi-sync] AMFI NAVAll parsed to ZERO schemes. AMFI publishes ~14,300 " +
        "every day, so this is a broken feed, not an empty one. Refusing to " +
        "report a no-op as a successful sync — see MONEY-1403.",
    );
  }

  // ── Dedupe by schemeCode ──
  // The AMFI NAV feed regularly lists the same scheme twice (growth + dividend
  // ISIN variants, occasional mid-feed repeats). Feeding duplicates to
  // Promise.all upserts guarantees MongoDB write conflicts because two
  // concurrent upserts race against the unique index on `schemeCode`. Dedupe
  // first; last occurrence wins so the most recent NAV row in the feed is
  // preserved.
  const dedupedMap = new Map<string, AmfiMutualFund>();
  for (const fund of funds) {
    dedupedMap.set(fund.schemeCode, fund);
  }
  const uniqueFunds = Array.from(dedupedMap.values());
  if (uniqueFunds.length !== funds.length) {
    console.log(
      `[amfi-sync] Deduped ${funds.length} → ${uniqueFunds.length} unique schemeCodes`,
    );
  }

  // ── Upsert with bounded concurrency + transient-conflict retry ──
  // 100-wide Promise.all against a 10-connection pool creates index-region
  // contention on MongoDB's B-tree, manifesting as "write conflict" aborts
  // even after dedup. Use a small concurrency window instead, and retry on
  // transient conflicts with exponential backoff (MongoDB driver docs
  // explicitly recommend application-level retry for these).
  //
  // CONCURRENCY=15: verified safe against the single-member QA replica set
  // with zero write conflicts in Apr 2026 testing. Higher than 15 increases
  // retry pressure without meaningfully helping throughput because we're
  // already saturating the connection pool (maxPoolSize=10) at 15.
  const BATCH_SIZE = 100;
  const CONCURRENCY = 15;
  const MAX_RETRIES = 3;

  async function upsertOne(fund: AmfiMutualFund): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await prisma.mutualFundMaster.upsert({
          where: { schemeCode: fund.schemeCode },
          create: {
            schemeCode: fund.schemeCode,
            schemeName: fund.schemeName,
            amcName: fund.amcName,
            category: fund.category,
            subCategory: fund.subCategory,
            plan: fund.plan,
            nav: fund.nav,
            navDate: fund.navDate,
            isinGrowth: fund.isinGrowth,
            isinDividend: fund.isinDividend,
            isActive: true,
            lastSyncedAt: new Date(),
          },
          update: {
            schemeName: fund.schemeName,
            amcName: fund.amcName,
            category: fund.category,
            subCategory: fund.subCategory,
            plan: fund.plan,
            nav: fund.nav,
            navDate: fund.navDate,
            isinGrowth: fund.isinGrowth,
            isinDividend: fund.isinDividend,
            isActive: true,
            lastSyncedAt: new Date(),
          },
        });
        result.upserted++;
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // MongoDB surfaces these three variants for optimistic-concurrency aborts:
        const isTransientConflict =
          msg.includes("write conflict") ||
          msg.includes("WriteConflict") ||
          msg.includes("deadlock") ||
          msg.includes("TransientTransactionError");
        attempt++;
        if (isTransientConflict && attempt < MAX_RETRIES) {
          // Exponential backoff: 50ms, 150ms, 450ms
          const delay = 50 * Math.pow(3, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        result.failed++;
        if (result.errors.length < 10) {
          result.errors.push(`${fund.schemeCode}: ${msg}`);
        }
        return;
      }
    }
  }

  for (let i = 0; i < uniqueFunds.length; i += BATCH_SIZE) {
    const batch = uniqueFunds.slice(i, i + BATCH_SIZE);
    // Limited parallelism INSIDE each batch - process CONCURRENCY at a time
    // instead of all 100 concurrently.
    for (let j = 0; j < batch.length; j += CONCURRENCY) {
      const slice = batch.slice(j, j + CONCURRENCY);
      await Promise.all(slice.map(upsertOne));
    }
  }

  console.log(
    `[amfi-sync] Done: upserted=${result.upserted}, failed=${result.failed}`,
  );

  return result;
}
