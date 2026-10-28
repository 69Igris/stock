/**
 * Stock-document-sync — PURE helpers (no Prisma / NSE / Screener / GCS / I/O).
 *
 * Side-effect-free helpers extracted out of `stock-document-sync.ts` so they can
 * be unit-tested by importing the REAL symbol (no shadow copies). Importing the
 * processor itself would boot Prisma + `@usemoney/research` data-sources, so the
 * pure logic lives here; `stock-document-sync.ts` imports and CALLS every export,
 * so the production path and the tests execute the SAME code. Mirrors the worker
 * precedent `sync-logic.ts` / `import-logic.ts`.
 *
 * The old inline `processor-stock-document-sync.test.ts` re-declared ALL of
 * these (constants, `extractPeriod`, the symbol clean/validate logic, the
 * api-limit / doc-type / extension / url helpers) and asserted the copies — a
 * shadow.
 *
 * @see workers/src/processors/stock-document-sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-stock-document-sync.test.ts (tests the real exports)
 */

// MONEY-1255 — the EXTRACTOR owns the definition of "a PDF we can read", so the
// normalizer is imported rather than restated. Both modules are pure leaves, so
// this adds no I/O to either.
import {
  CANONICAL_PDF_MIME_TYPE,
  ZIP_MIME_TYPE,
  normalizeDocMimeType,
} from "@usemoney/core/market-data/doc-mime";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";

/** Delay between per-symbol passes (politeness toward NSE/Tickertape). */
export const DELAY_BETWEEN_SYMBOLS_MS = 2000;

/** NSE base origin; relative attachment paths are resolved against it. */
export const NSE_BASE = "https://www.nseindia.com";

/** Per-source hard caps on external API calls within a single run. */
export const API_LIMITS = {
  tickertape: 5000,
  nse: 2000,
  // MONEY-853: was 2000 — Screener 429s (per-IP rate limit / quota) well before
  // that, so the whole-market run hit a 429 wall and ZERO screener data reached
  // GCS. Cap per-run volume + pair with the scraper's 429 backoff + the run-level
  // circuit-breaker. (Prod-only scraping now; tune up as coverage/rotation allow.)
  screener: 500,
  gcsUploads: 10000,
} as const;

/** A downloaded document smaller than this (bytes) is treated as junk/empty. */
export const MIN_DOC_BUFFER_BYTES = 500;

/**
 * PAGE SIZE for one sync invocation, and a runaway guard.
 *
 * RESOURCE BOUND (security / reliability): each symbol fans out into several
 * external fetches (NSE + Screener) plus GCS uploads and a 2s politeness delay,
 * so one run must never accept "all 8,000 listed equities" from a caller.
 *
 * It is NOT the throughput control — {@link SYNC_RUN_TIME_BUDGET_MS} is. A
 * count cannot express the constraint that actually binds (a 600s ack
 * deadline), which is why MONEY-1201 rejected shrinking a count as a fix for
 * exactly this shape in `xbrl-sync`.
 *
 * MONEY-807 said the tail past the cap was DROPPED and never reached, and that
 * this could only be fixed by "true self-pagination (persist a cursor)". That
 * was true and it is now fixed, though not with a cursor: the page is ordered
 * by {@link buildDocumentSyncOrderBy} (stale-first) and every visited row is
 * STAMPED, so the rotation marker IS the cursor and the tail arrives on a later
 * page. What made the old cap fatal was not the cap — it was that the ORDER was
 * constant, so "the head" was the same 250 symbols on every run forever.
 */
export const MAX_SYMBOLS_PER_RUN = 250;

/**
 * Clamp a CALLER-SUPPLIED symbol list to {@link MAX_SYMBOLS_PER_RUN} (or a
 * smaller caller-supplied `batchSize`). Pure + total: returns the same array
 * when already within the cap, otherwise a head slice. Guards against a
 * non-finite / non-positive `batchSize` by falling back to the hard cap.
 *
 * This is the `message.symbols` path only — a targeted, human-scoped run. The
 * DISCOVERED page is sized by {@link resolveSymbolPageSize} and ordered by
 * {@link buildDocumentSyncOrderBy}, so its tail is carried by the rotation
 * marker rather than by this function. Slicing a list the caller handed us is
 * still a head-only slice with no carry-over, which is correct: the caller
 * named those symbols, and the ones past the cap are theirs to re-send.
 */
export function boundSymbolBatch(
  symbols: readonly string[],
  batchSize?: number,
): string[] {
  const requested =
    typeof batchSize === "number" && Number.isFinite(batchSize) && batchSize > 0
      ? Math.floor(batchSize)
      : MAX_SYMBOLS_PER_RUN;
  const limit = Math.min(requested, MAX_SYMBOLS_PER_RUN);
  return symbols.length > limit ? symbols.slice(0, limit) : [...symbols];
}

/** A valid NSE equity ticker: starts A-Z, then 1-19 of [A-Z0-9&] (e.g. M&M). */
export const VALID_EQUITY_PATTERN = /^[A-Z][A-Z0-9&]{1,19}$/;

/**
 * The same shape, but allowing a leading DIGIT. Reachable only alongside a
 * company ISIN — see {@link isValidEquitySymbol}. Note the hyphen is still
 * absent from the character class, so state-government paper like
 * `747UK34-SG` and `748AP33-SG` remains excluded on shape alone.
 */
export const DIGIT_LED_EQUITY_PATTERN = /^[0-9][A-Z0-9&]{1,19}$/;

/** An Indian COMPANY equity ISIN. Government and debt series do not match. */
export const COMPANY_ISIN = /^INE/;

/** Index pseudo-symbols that must never be treated as a researchable equity. */
export const EXCLUDE_SYMBOLS: ReadonlySet<string> = new Set([
  "NIFTY",
  "NIFTY50",
  "BANKNIFTY",
  "SENSEX",
  "NIFTYNXT50",
  "NIFTYIT",
  "NIFTYPSE",
  "NIFTYBANK",
  "NIFTYMID50",
]);

/** Index / ETF / debt instrument symbol prefixes to exclude. */
export const EXCLUDE_PATTERNS =
  /^(NIFTY\d|MIDCAP\d|SMLCAP\d|IDX|LIQUIDBEES|LIQUID[A-Z]|GILT[A-Z]|MONEY[A-Z]|GSEC|SDL\d|TBILL)/i;

/** Screener doc types stored verbatim; anything else → `corporate_filing`. */
export const VALID_SCREENER_DOC_TYPES = [
  "concall_transcript",
  "concall_ppt",
  "concall_ai_summary",
  "annual_report",
  "drhp",
  // MONEY-853 — credit-rating PDFs + exchange announcement filings scraped from
  // Screener's Documents section are stored under their own docType (not folded
  // into corporate_filing) so RAG/UI can distinguish them.
  "credit_rating",
  "announcement",
] as const;

/** The minimal filing shape `extractPeriod` reads (a full NSEFiling satisfies it). */
export interface FilingPeriodInput {
  title: string;
  filingDate: Date;
}

/**
 * Derive a document period key from a filing. Prefers a quarter in the title
 * (`Q1-2026`), then a financial year (`FY2026`), else falls back to the filing
 * date as `YYYY-MM-DD` (month/day zero-padded).
 *
 * INVALID-DATE GUARD: if neither pattern matches AND `filingDate` is an Invalid
 * Date, the date fallback would otherwise yield `"NaN-NaN-NaN"` — a corrupt
 * period that becomes part of the GCS path and the Prisma unique key, silently
 * fragmenting/duplicating documents. We return the explicit sentinel
 * `"unknown-date"` instead so the bad key is at least recognisable.
 *
 * The date is the filing's IST calendar day — MONEY-1536. It read the PROCESS's
 * local date parts, which only ever looked right because the parse was local
 * too: `new Date("23-Sep-2026 02:00:00")` and `getDate()` cancel in any TZ.
 * With the parse now IST-correct, a local read on Cloud Run (UTC) would key a
 * filing made before 05:30 IST on the day BEFORE. The IST day is the value
 * every existing key already holds.
 */
export function extractPeriod(filing: FilingPeriodInput): string {
  const qMatch = filing.title.match(/Q[1-4]\s*[-–]?\s*(\d{4})/i);
  if (qMatch) return `Q${filing.title.match(/Q([1-4])/i)?.[1]}-${qMatch[1]}`;

  const fyMatch = filing.title.match(/FY\s*(\d{4})/i);
  if (fyMatch) return `FY${fyMatch[1]}`;

  const d = filing.filingDate;
  if (Number.isNaN(d.getTime())) return "unknown-date";
  return toIstDateKey(d);
}

/** Strip a `.NS` / `.BO` suffix and upper-case the ticker. */
export function cleanSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
}

/**
 * True when `symbol` is a researchable equity: matches `VALID_EQUITY_PATTERN`
 * AND is neither an excluded index pseudo-symbol nor an excluded ETF/debt
 * prefix. (This is the exact filter `processStockDocumentSync` applies.)
 */
export function isValidEquitySymbol(
  symbol: string,
  isin?: string | null,
): boolean {
  if (EXCLUDE_SYMBOLS.has(symbol) || EXCLUDE_PATTERNS.test(symbol))
    return false;
  if (VALID_EQUITY_PATTERN.test(symbol)) return true;
  // MONEY-1257 — a DIGIT-LEADING symbol is a real company only if it carries a
  // company ISIN.
  //
  // `VALID_EQUITY_PATTERN` anchors on `^[A-Z]`, which silently excluded 3,791
  // symbols — among them 3MINDIA, 5PAISA, 360ONE, 63MOONS and 20MICRONS, all
  // listed companies with a decade of annual reports available.
  //
  // Loosening the anchor to `^[A-Z0-9]` was the obvious fix and is the WRONG
  // one. Measured on prod: of those 3,791, exactly 25 carry an `INE…` ISIN and
  // 3,766 are debt instruments — `07QPD`, `09AMR`, `07BPB` — with no ISIN at
  // all. Admitting them to gain 25 companies would put 3,766 rows back into a
  // symbol-ordered rotation whose head is ALREADY 11,110 non-equity rows, and
  // digits sort first, so they would lead the queue for weeks.
  //
  // The ISIN is the discriminator, it is already on the row, and it is the
  // exchange's own answer to "is this an equity". `INE` is the Indian company
  // prefix; `IN0`/`IN1`/`IN2` and friends are government and debt series.
  return DIGIT_LED_EQUITY_PATTERN.test(symbol) && COMPANY_ISIN.test(isin ?? "");
}

/**
 * True while `currentCalls` is STRICTLY below the source's cap (so the call at
 * exactly the limit is rejected). Matches the `apiCalls.X < API_LIMITS.X` guards.
 */
export function isWithinApiLimit(
  source: keyof typeof API_LIMITS,
  currentCalls: number,
): boolean {
  return currentCalls < API_LIMITS[source];
}

/** Map a raw Screener doc type to a stored type, defaulting to `corporate_filing`. */
export function normalizeScreenerDocType(docType: string): string {
  return (VALID_SCREENER_DOC_TYPES as readonly string[]).includes(docType)
    ? docType
    : "corporate_filing";
}

/**
 * Infer a file extension from a content-type: pdf → "pdf", text → "txt", else "pdf".
 *
 * MONEY-1255 — this now DELEGATES to `normalizeDocMimeType`, which is the same
 * decision the stored `mimeType` is made with. It used to be an independent
 * substring test, and that independence was the bug: `application/pdf;charset=UTF-8`
 * made this return "pdf" (so the GCS object was correctly named `.pdf`) while
 * the column the extract query filters on kept the parameterised spelling and
 * matched nothing. The file was right and the row was unreachable, which is why
 * nothing looked broken.
 */
export function inferExtension(contentType: string): string {
  const mime = normalizeDocMimeType(contentType);
  if (mime === CANONICAL_PDF_MIME_TYPE) return "pdf";
  // MONEY-1319 — a ZIP gets `.zip`. Without this arm it fell through to the
  // `return "pdf"` default, so an archive would be stored under a `.pdf` key:
  // the precise shape of the 179 prod objects this ticket exists to unpick,
  // manufactured fresh by the writer while the column said `application/zip`.
  if (mime === ZIP_MIME_TYPE) return "zip";
  if (mime.startsWith("text/")) return "txt";
  return "pdf";
}

/** Resolve an NSE attachment URL to absolute (relative paths get `NSE_BASE`). */
export function buildNseUrl(attachmentUrl: string): string {
  return attachmentUrl.startsWith("http")
    ? attachmentUrl
    : `${NSE_BASE}${attachmentUrl}`;
}

/** Screener.in company-page base; the symbol is appended verbatim. */
export const SCREENER_BASE = "https://www.screener.in/company";

/** Tickertape public stock-page base; the security id (`sid`) is appended. */
export const TICKERTAPE_BASE = "https://www.tickertape.in/stocks";

/**
 * MONEY-784 (P3b) — citation URL for a Screener financials doc.
 * `https://www.screener.in/company/{SYMBOL}/` — Screener resolves the symbol
 * directly, so no sid is needed. (Consolidated `/consolidated/` is the default
 * landing for most companies, but the bare company URL redirects correctly.)
 */
export function buildScreenerUrl(symbol: string): string {
  return `${SCREENER_BASE}/${symbol.toUpperCase()}/`;
}

/**
 * MONEY-784 (P3b) — citation URL for a Tickertape financial-statement doc.
 *
 * Tickertape's public stock page is `/stocks/<slug>-<sid>`. The slug is
 * cosmetic — Tickertape redirects on the trailing sid alone — so when we have a
 * `sid` we emit `/stocks/-<sid>`. Without a sid we fall back to the symbol-keyed
 * search URL (`/stocks?ticker=<SYMBOL>`) so the chunk still carries SOME
 * clickable citation rather than none.
 */
export function buildTickertapeUrl(
  symbol: string,
  sid?: string | null,
): string {
  if (sid && sid.trim().length > 0) {
    return `${TICKERTAPE_BASE}/-${sid.trim()}`;
  }
  return `${TICKERTAPE_BASE}?ticker=${symbol.toUpperCase()}`;
}

// ===========================================================================
// ROTATION — MONEY-1255 (the batch that never advanced)
// ===========================================================================

/**
 * Order the symbol page STALE-FIRST.
 *
 * ## What this replaced, and why it produced nothing
 *
 * The selection was `orderBy: { analysisCount: "desc" }` with no tiebreak.
 * `analysisCount` is incremented in exactly one place — a StockSage research
 * run (`packages/research/src/data-sources/db-store.ts`) — and the repo has
 * already measured the consequence and written it down at
 * `news-sync-logic.ts`: **0 of 10,444 active NSE equities have
 * `analysisCount > 0`**. A sort key that is CONSTANT across the population is
 * not a sort at all: Mongo resolves the same arbitrary order every time,
 * nothing in the run mutates the key, and the page is therefore the identical
 * ~250 symbols on every trigger, forever. The other 18,000 were never
 * selected once.
 *
 * That is MONEY-1211 restated for the third time (681 of 781 symbols), and it
 * is the direct cause of the measured hole: 15,866 of 20,804 active equity
 * rows (76.3%) have no document of any kind.
 *
 * ## The Mongo trap this function is written around
 *
 * `documentsSyncedAt` is ABSENT — not null — on every pre-existing row, because
 * `prisma db push` creates indexes and never fields. Prisma's Mongo connector
 * does not treat an absent field as null, so a WHERE arm of
 * `{ documentsSyncedAt: null }` matches ZERO rows and `{ not: null }` matches
 * ZERO rows: the population would silently become empty. That class has now
 * caused MONEY-1050, MONEY-1205, MONEY-1234 and MONEY-1236.
 *
 * The defence is structural rather than careful: the marker appears ONLY in the
 * `orderBy` and NEVER in the `where`. Ordering has no such hazard — Mongo sorts
 * a missing field lowest, so an unstamped row sorts FIRST under `asc`, which is
 * exactly the semantics wanted (a never-synced symbol is the most stale thing
 * there is). `buildDocumentSyncWhere` below is asserted to never mention the
 * field, so the trap cannot be walked back into by a later edit.
 *
 * Written as plain `asc` rather than `{ sort, nulls }` because that form needs
 * Prisma's `orderByNulls` preview flag, which this schema does not enable —
 * the same choice `news-sync` and `buildFinancialTierOrderBy` made.
 *
 * `symbol: "asc"` is the tiebreak. Without it the order WITHIN one marker value
 * is unspecified, and on the first run every row shares one value (absent), so
 * consecutive pages could overlap arbitrarily.
 */
export function buildDocumentSyncOrderBy(): Array<
  { documentsSyncedAt: "asc" } | { symbol: "asc" }
> {
  return [{ documentsSyncedAt: "asc" }, { symbol: "asc" }];
}

/**
 * WHERE clause for the symbol page.
 *
 * `tickertapeOnly` is the `stock-document-sync-tickertape-daily` shape: that
 * schedule sends `docTypes:["financial_statement"]`, and only stocks carrying a
 * Tickertape sid can produce one.
 *
 * The `analysisCount > 0` arm is kept as an OR branch — it is dead today (0 of
 * 10,444 rows) and correct the day StockSage starts writing it. Exactly the
 * call `buildNewsDiscoveryWhere` made.
 *
 * NOTE the deliberate ABSENCE of any `documentsSyncedAt` arm; see
 * {@link buildDocumentSyncOrderBy}.
 */
export function buildDocumentSyncWhere(tickertapeOnly: boolean): {
  isActive: true;
  instrumentType: "EQUITY";
  exchange: { in: string[] };
  OR?: Array<{ tickertapeSid: { not: null } } | { analysisCount: { gt: 0 } }>;
} {
  return {
    isActive: true,
    instrumentType: "EQUITY",
    exchange: { in: ["NSE", "BSE"] },
    ...(tickertapeOnly
      ? {
          OR: [
            { tickertapeSid: { not: null } as { not: null } },
            { analysisCount: { gt: 0 } as { gt: 0 } },
          ],
        }
      : {}),
  };
}

/**
 * True when this schedule can only produce Tickertape financial statements.
 * Extracted so the WHERE gate and any reader of it are one decision.
 */
export function isTickertapeOnlyRun(docTypes?: string[]): boolean {
  return docTypes?.length === 1 && docTypes[0] === "financial_statement";
}

/**
 * The `take` for ONE page of instrument ROWS.
 *
 * Clamped to {@link MAX_SYMBOLS_PER_RUN}. This is the number the chain decision
 * compares against, so it must be the number actually passed to `take` — the
 * scheduler sends `batchSize: 8000`, and comparing a 250-row page against 8000
 * would read as "the table ran dry" and end the chain after one link, every
 * night, silently.
 */
export function resolveSymbolPageSize(batchSize?: number): number {
  const requested =
    typeof batchSize === "number" && Number.isFinite(batchSize) && batchSize > 0
      ? Math.floor(batchSize)
      : MAX_SYMBOLS_PER_RUN;
  return Math.min(requested, MAX_SYMBOLS_PER_RUN);
}

/** One selected instrument row, as the page returns it. */
export interface SelectedInstrumentRow {
  symbol: string;
  exchange: string;
  /**
   * The instrument's ISIN, when we hold one. MONEY-1257 — this is what lets a
   * DIGIT-LEADING symbol be told apart from a debt instrument; see
   * {@link isValidEquitySymbol}. The page query already selects it for the
   * BSE-only scrip-code join, so this costs nothing new.
   */
  isin?: string | null;
}

/** The page, split into what the loop will visit and what it will not. */
export interface PartitionedSymbolPage {
  /**
   * Distinct researchable equities, NSE listing preferred, IN PAGE ORDER.
   *
   * BSE-only symbols are IN here — they are visited like any other target, just
   * with a different set of legs (see {@link resolveLegsForTarget}). Keeping
   * them in one ordered list rather than appending a second is not cosmetic: a
   * stale-first page is truncated by a wall clock, so a class that always sorts
   * last is a class that is always truncated away — and because an unvisited
   * row keeps its stale marker, it leads the next page and is pushed to the
   * back of the target list again. That is a livelock, and it is the same
   * "constant order" defect the rotation fix exists to remove.
   */
  eligible: SelectedInstrumentRow[];
  /**
   * The BSE-only subset of {@link eligible} — MONEY-1255 (A2.2), the third
   * class.
   *
   * A company listed ONLY on BSE cannot be served by either NSE leg or by the
   * `stock_financials` read (that table is filled from an NSE-FILERS-ONLY XBRL
   * ingest), so for these symbols the Screener leg is not one source among
   * three — it is the only one that can ever produce a document.
   *
   * Page-level and ADVISORY: the per-symbol `findFirst` in the loop re-reads
   * the listing and is the authority the writes are keyed on, because a
   * caller-supplied symbol list has no page to classify and `cleanSymbol` can
   * rewrite a ticker between the two queries. What this array is for is SIZING
   * — how much of this page is Screener-only work — before the loop starts
   * spending a 300s budget on it.
   */
  bseOnly: SelectedInstrumentRow[];
  /**
   * Symbols rejected by {@link isValidEquitySymbol} (index pseudo-symbols,
   * ETF/debt prefixes). They are NOT merely dropped: they must be stamped, or
   * they occupy the head of a stale-first rotation on every run forever, which
   * is the very defect being fixed one level up.
   */
  excluded: string[];
}

/**
 * Collapse a page of rows to one entry per symbol, preferring the NSE listing.
 *
 * A dual-listed company has TWO rows and both are selected, so a page counted
 * in ROWS holds fewer distinct symbols than its size — the MONEY-1207
 * duplication factor. Preferring NSE matters because every write in this job is
 * keyed on `(symbol, exchange, …)` and both NSE legs only cover NSE: filing a
 * dual-listed company under its BSE row would key its documents to an exchange
 * that cannot source them.
 */
export function partitionSymbolPage(
  rows: readonly SelectedInstrumentRow[],
): PartitionedSymbolPage {
  const best = new Map<string, SelectedInstrumentRow>();
  const excluded = new Set<string>();

  for (const row of rows) {
    if (!isValidEquitySymbol(row.symbol, row.isin)) {
      excluded.add(row.symbol);
      continue;
    }
    const existing = best.get(row.symbol);
    if (!existing || (existing.exchange !== "NSE" && row.exchange === "NSE")) {
      best.set(row.symbol, { symbol: row.symbol, exchange: row.exchange });
    }
  }

  const eligible = [...best.values()];
  return {
    eligible,
    // Derived from `eligible` rather than from `rows`, so a DUAL-listed company
    // — whose BSE row is in the page and whose NSE row won the collapse — can
    // never be classified BSE-only. Reading `rows` directly would put TCS in
    // this list on any page that happened to include its BSE listing.
    bseOnly: eligible.filter((r) => r.exchange !== "NSE"),
    excluded: [...excluded],
  };
}

/**
 * The legs ONE target may enter, from the run's legs and its listing.
 *
 * A BSE-only company runs the **Screener leg only**, and the two it loses are
 * lost for a structural reason rather than a policy one:
 *
 *  - `fetchNSEFinancialResults` / `fetchCategorizedAnnouncements` read NSE
 *    endpoints. NSE does not list this company, so they answer nothing —
 *    spending an API-limit slot and a network round trip to be told so.
 *  - the "Tickertape" leg is a read of `stock_financials`, filled by
 *    `xbrl-projection` from an ingest that is NSE-FILERS-ONLY. There is no row
 *    to find, and there will not be one until a BSE XBRL ingest exists.
 *
 * Pure, so the rule is one testable decision rather than three conditions
 * spread down a 600-line loop. Note it can only ever REMOVE legs: a run that
 * gated Screener off by `docTypes` does not get it back here.
 */
export function resolveLegsForTarget(
  legs: EnabledLegs,
  bseOnly: boolean,
): EnabledLegs {
  if (!bseOnly) return legs;
  return { tickertape: false, nse: false, screener: legs.screener };
}

// ===========================================================================
// THROUGHPUT — the 600s Pub/Sub ack deadline (MONEY-1255)
// ===========================================================================

/**
 * Wall-clock budget after which the run stops starting NEW work.
 *
 * ## The arithmetic this job could not satisfy before
 *
 * Every worker job arrives on a push subscription created with
 * `--ack-deadline=600` (`workers/scripts/setup-pubsub.sh`), which is Pub/Sub's
 * MAXIMUM and cannot be raised; Cloud Run's 3600s request timeout never binds.
 * Overrunning the deadline does not make a run slow — Pub/Sub REDELIVERS, a
 * second copy starts on a warm container, and because the selection has no
 * cursor each copy restarts at index 0. The tail is unreachable even inside its
 * own head.
 *
 * The old run was arithmetically incapable of finishing:
 *
 *   249 x DELAY_BETWEEN_SYMBOLS_MS (2,000ms)          =   498s
 *   250 x screener REQUEST_DELAY_MS (3,000ms)         =   750s
 *   ------------------------------------------------------------
 *                                                       1,248s of SLEEP
 *
 * against a 600s ceiling, before one HTTP round trip. Halving the COUNT is the
 * lever MONEY-1201 explicitly rejected — it moves the cliff instead of removing
 * it, because two of the three per-symbol cost terms are not ours to hold
 * still. A wall clock expresses the constraint that actually binds.
 *
 * ## Sizing, against the 600s ceiling
 *
 *   600s   ack deadline (hard ceiling)
 *  -300s   SYNC_RUN_TIME_BUDGET_MS — no new SYMBOL, no new LEG and no new
 *          DOCUMENT DOWNLOAD is started past this
 *  ------
 *   300s   headroom, which has to absorb, in order:
 *
 *   178s   the ONE unit of work already in flight when the budget expires. The
 *          checks sit BETWEEN units, so the true wall is `budget + one unit`.
 *          The worst unit is a Screener page scrape carrying the full 429
 *          ladder (`screener-full-scraper.ts`): a 3s pre-delay, five fetches at
 *          the 20s `API_TIMEOUT_MS`, and four backoffs of 5+10+20+40s. It can
 *          be paid at most ONCE per run — a persistent 429 throws
 *          `ScreenerRateLimitError` and the run-level circuit-breaker skips
 *          Screener for every remaining symbol. (A hostile `Retry-After` header
 *          is honoured verbatim and is therefore NOT bounded by this term; that
 *          is a pre-existing property of the scraper, noted here because it is
 *          the one input that can break the arithmetic.)
 *    ~2s   the trailing DELAY_BETWEEN_SYMBOLS_MS of the last symbol.
 *    ~2s   the page `findMany` plus the excluded-row stamp.
 *    ~2s   reportJobOutcome + the chain publish.
 *   ----
 *   184s   used, ~116s spare. Deliberately generous: being wrong here does not
 *          cost a slow run, it DUPLICATES the run — and a duplicate of THIS job
 *          re-scrapes NSE and Screener, which is how MONEY-853's 429 wall was
 *          built in the first place.
 *
 * Lower than `stock-document-extract`'s 420s on purpose: that job's worst
 * in-flight item is a single ~60s Document AI call, so it can spend more of the
 * deadline on the loop. Here the worst item is ~3x that.
 */
export const SYNC_RUN_TIME_BUDGET_MS = 300_000;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE, and it deliberately does not consult the
 * database, the clock or the queue. Every chained publish carries
 * `chainDepth + 1`, and {@link shouldChainAnotherSyncBatch} refuses once the
 * NEXT depth would REACH this value — so a chain is at most
 * `MAX_SYNC_CHAIN_DEPTH` messages long no matter what the population does. The
 * other stop conditions can only end it SOONER, so none of them can break the
 * bound.
 *
 * Sizing, and why it is not larger: `API_LIMITS` are PER RUN, and every chained
 * link is a new run, so the chain multiplies the per-night external-call
 * budget. At the time budget above a link covers ~150 symbols on the
 * Tickertape-only schedule (2s each, no network) and ~55 on the full weekly one
 * (2s politeness + 3s Screener throttle + fetches), so:
 *
 *   20 links x 300s  = 100 minutes from one trigger
 *   ~55 symbols/link ≈ 1,100 symbols per weekly run  → a full pass over the
 *                      ~10,400 active NSE equities in ~9 weeks
 *
 * Against "the same 250 symbols forever", nine weeks is the fix. Going faster
 * is a SECOND trigger — whose cost is visible in the scheduler — not a longer
 * chain, whose cost is visible only as a 429 from Screener.
 */
export const MAX_SYNC_CHAIN_DEPTH = 20;

/**
 * Sanitise the `chainDepth` carried on an inbound message.
 *
 * The value comes off a Pub/Sub payload, so it is `unknown` until proven
 * otherwise: a missing, negative, fractional, NaN or absurd value must not be
 * able to buy extra links. Anything that is not a finite non-negative number
 * reads as depth 0, and anything above the ceiling is CLAMPED to it — so a
 * forged large value ENDS the chain rather than wrapping it.
 */
export function normalizeSyncChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_SYNC_CHAIN_DEPTH);
}

/**
 * True while the run may start ANOTHER unit of work.
 *
 * Pure so the budget is testable without a clock: the caller passes
 * `Date.now()` and the run's start.
 */
export function isWithinSyncRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = SYNC_RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}

/** Inputs to the self-chain decision. All observed, none inferred. */
export interface SyncChainDecisionInput {
  /**
   * Instrument ROWS the page returned — NOT the post-filter symbol count. A
   * page of 250 rows can collapse to far fewer symbols (dual listings, excluded
   * ETF/debt tickers), and reading a shrunken symbol count as "the table ran
   * dry" would end the chain after one link on a population of 20,000.
   */
  rowsSelected: number;
  /** The `take` this run used. `rowsSelected < pageSize` means the table ran dry. */
  pageSize: number;
  /** This run's depth (0 on a scheduler trigger). */
  chainDepth: number;
  /**
   * Rows whose `documentsSyncedAt` was actually STAMPED this run. Zero means
   * the rotation did not move, so the next link would re-select the identical
   * page — the runaway-poll shape this repo already has an incident for.
   */
  stamped: number;
  /** The caller named an explicit symbol list; there is no page to continue. */
  explicitSymbols: boolean;
  /**
   * Screener answered a persistent 429 and the run circuit-broke. Chaining then
   * re-arms the breaker on a fresh run and walks straight back into the tarpit
   * — MONEY-853, one link later.
   */
  upstreamCircuitBroken: boolean;
}

/**
 * Should this run publish a follow-up message?
 *
 * Six independent reasons to stop, ANY of which ends the chain:
 *
 *  1. **Explicit symbols.** A targeted run has no page to continue.
 *  2. **Depth.** The next link would reach {@link MAX_SYNC_CHAIN_DEPTH}. This
 *     one ALONE bounds the chain — it is a pure function of a number carried on
 *     the message, so no database, clock or population can extend it.
 *  3. **Non-positive page.** Nothing was asked for.
 *  4. **Drained.** Fewer rows came back than were asked for: no next page.
 *  5. **No progress.** Not one row was stamped, so the rotation is unchanged
 *     and the next link re-selects this page.
 *  6. **Circuit-broken upstream.** See {@link SyncChainDecisionInput}.
 */
export function shouldChainAnotherSyncBatch(
  input: SyncChainDecisionInput,
): boolean {
  const {
    rowsSelected,
    pageSize,
    chainDepth,
    stamped,
    explicitSymbols,
    upstreamCircuitBroken,
  } = input;
  if (explicitSymbols) return false;
  if (upstreamCircuitBroken) return false;
  if (chainDepth + 1 >= MAX_SYNC_CHAIN_DEPTH) return false;
  if (pageSize <= 0) return false;
  if (rowsSelected < pageSize) return false;
  if (stamped <= 0) return false;
  return true;
}

// ===========================================================================
// LEGS — which sources a run actually ENABLED (MONEY-1255)
// ===========================================================================

/**
 * NSE announcement categories the announcements leg can produce.
 *
 * Declared HERE rather than inline in the processor because the run-health
 * condition has to ask the same question the leg gate asks. Two copies of this
 * list is how the alarm and the code they describe drift apart, which is the
 * defect immediately below.
 */
export const NSE_ANNOUNCEMENT_DOC_TYPES = [
  "annual_report",
  "investor_presentation",
  "credit_rating",
  "press_release",
  "earnings_call_intimation",
] as const;

/**
 * Doc types the single Screener page fetch can produce. Listed in full so a
 * targeted request for any ONE of them still triggers the one fetch (MONEY-853).
 *
 * ## `annual_report` was MISSING, and it is where annual reports come from
 *
 * MONEY-1255 (A2.3). `VALID_SCREENER_DOC_TYPES` has carried `annual_report`
 * since MONEY-853 and `parseDocumentLinks` emits it as its FIRST section — the
 * Screener page's annual-report block is the single richest source of them we
 * have (11 of 12 sampled companies, typically 8-13 years each). But this list —
 * the LEG GATE — did not contain it, so a request scoped to
 * `docTypes:["annual_report"]` never fetched the Screener page at all. It
 * reached the NSE announcements leg only, which for a BSE-only company is
 * guaranteed empty, and for an NSE one carries whatever the last few weeks of
 * announcements happened to include.
 *
 * Nothing errored. The targeted request simply returned less than it could,
 * which is the shape this whole ticket is about.
 *
 * `resolveEnabledLegs` reads THIS constant rather than a second copy, so the
 * run-health verdict follows the gate automatically — the two cannot drift, and
 * a leg reported "enabled" is exactly a leg the run can enter.
 */
export const SCREENER_PAGE_DOC_TYPES = [
  "concall_transcript",
  "screener_financials",
  "concall_ai_summary",
  "concall_ppt",
  "screener_shareholding",
  "screener_peers",
  "screener_growth",
  "credit_rating",
  "announcement",
  "annual_report",
] as const;

/** Which source legs a run's `docTypes` filter leaves switched on. */
export interface EnabledLegs {
  tickertape: boolean;
  nse: boolean;
  screener: boolean;
}

/**
 * Resolve the legs a run will actually enter, from its `docTypes` filter.
 *
 * `undefined` / empty means "all doc types", which is the weekly full sync.
 */
export function resolveEnabledLegs(
  docTypes?: string[],
  sources?: readonly string[],
): EnabledLegs {
  const all = !docTypes || docTypes.length === 0;
  const fromDocTypes: EnabledLegs = all
    ? { tickertape: true, nse: true, screener: true }
    : (() => {
        const wanted = new Set(docTypes);
        return {
          tickertape: wanted.has("financial_statement"),
          nse:
            wanted.has("quarterly_result") ||
            NSE_ANNOUNCEMENT_DOC_TYPES.some((dt) => wanted.has(dt)),
          screener: SCREENER_PAGE_DOC_TYPES.some((dt) => wanted.has(dt)),
        };
      })();

  // MONEY-1259 — `sources` can only ever REMOVE a leg. An empty or absent list
  // means "no source restriction", NOT "no sources": treating [] as a filter
  // would turn a malformed message into a silent whole-run no-op that reports
  // success, which is the failure shape this file already has three comments
  // about.
  if (!sources || sources.length === 0) return fromDocTypes;
  const allow = new Set(sources);
  return {
    tickertape: fromDocTypes.tickertape && allow.has("tickertape"),
    nse: fromDocTypes.nse && allow.has("nse"),
    screener: fromDocTypes.screener && allow.has("screener"),
  };
}

/** Documents this run actually PERSISTED, per source. */
export interface WritesBySource {
  tickertape: number;
  nse: number;
  screener: number;
}

/** Everything the run-health verdict reads. */
export interface SyncShortfallInput {
  selected: number;
  written: number;
  skippedFresh: number;
  legs: EnabledLegs;
  wrote: WritesBySource;
  transportFailures: number;
  noNseListing: number;
  /**
   * The BSE-only leg's own accounting — MONEY-1255 (A2).
   *
   * OPTIONAL on purpose. `noNseListing` alone says how many companies the page
   * could not serve; it cannot say whether the new Screener path REACHED them,
   * and "2,389 BSE-only symbols, 0 served" is the one shape that must not read
   * the same as "2,389 BSE-only symbols, 2,389 served".
   *
   * Optional rather than required because every existing caller is correct
   * without it — a run with no BSE-only symbols has nothing to report here, and
   * forcing the field would make callers invent a zeroed object to say so.
   */
  bseOnly?: BseOnlyCounters;
  /**
   * Downloads REFUSED because the body sniffed as HTML — MONEY-1315 (B).
   *
   * OPTIONAL, for the reason `bseOnly` is: every existing caller is correct
   * without it, and it is only worth printing when it is non-zero.
   *
   * It belongs in the shortfall string rather than only in the log line
   * because it is the one number that separates "this source has nothing new"
   * from "this source's links have rotted into landing pages". Both produce
   * `wrote.screener === 0` with zero transport failures, and without this the
   * second is unreportable — which is how 1,449 SEBI landing pages were stored
   * as `drhp` and `credit_rating` documents with nothing anywhere saying so.
   */
  htmlRefusals?: number;
}

/** What the BSE-only path did this run. See {@link SyncShortfallInput.bseOnly}. */
export interface BseOnlyCounters {
  /**
   * BSE-only symbols the Screener leg RAN for, with a slug in hand.
   *
   * An ATTEMPT counter, and labelled as one for the same reason `SyncRun.api`
   * is: it is incremented before the scrape it describes, so it counts symbols
   * we tried to serve, never documents. `wrote.screener` is the write signal.
   * `noNseListing - served` is the number that had no usable slug.
   */
  served: number;
  /** Searches this run that produced an ACCEPTED slug. */
  slugResolved: number;
  /** Searches that found no screener page at all — a finding, re-checked in 90d. */
  slugMiss: number;
  /** Resolutions whose ISIN mapped to more than one scrip code. Never guessed. */
  slugAmbiguous: number;
  /**
   * BSE's scrip master could not be fetched this run — MONEY-1255 (A2).
   *
   * A BOOLEAN, not a counter, because it is a property of the RUN rather than
   * of a symbol: one failed master fetch blocks every BSE-only resolution on
   * the page. It exists because the alternative signature — `served 0,
   * resolved 0, miss 0, ambiguous 0` — is something an operator has to infer,
   * and "we could not look" must never be inferred from the same numbers as
   * "we looked and found nothing". Nothing is persisted in this state.
   */
  masterUnavailable: boolean;
}

/**
 * The `skippedReason` for `reportJobOutcome`, or `undefined` when the run looks
 * healthy.
 *
 * ## The alarm this replaces was asserted on EVERY healthy run
 *
 * It read `apiCalls.tickertape === 0 || apiCalls.nse === 0`. The
 * `stock-document-sync-tickertape-daily` schedule sends
 * `docTypes:["financial_statement"]`, which gates BOTH NSE legs off by design —
 * so `apiCalls.nse === 0` was true every single weekday, the reason string was
 * emitted every single weekday, and a permanently-asserted alarm carries no
 * information at all. It also never mentioned `screener`, so a Screener
 * circuit-break — the documented MONEY-853 failure, the one this reason string
 * was added for — was completely invisible.
 *
 * Two changes make it mean something:
 *
 *  - **Leg-aware.** A source is only reported dark when the run ENABLED it.
 *    A gated-off leg is a configuration, not a fault.
 *  - **Counted on WRITES, not on calls.** Every per-source counter used to be
 *    incremented BEFORE the call it was counting, so a source that 403s on
 *    every request still produced a full-looking count. `wrote.*` counts rows
 *    that reached `stock_documents`.
 */
export function describeSyncShortfall(
  input: SyncShortfallInput,
): string | undefined {
  const { selected, written, skippedFresh, legs, wrote } = input;
  const tail =
    `TT=${wrote.tickertape} NSE=${wrote.nse} SCR=${wrote.screener} written, ` +
    `${skippedFresh} already fresh, ${input.transportFailures} upstream failure(s)` +
    (input.noNseListing > 0
      ? `, ${input.noNseListing} symbol(s) with no NSE listing` +
        // MONEY-1255 (A2) — the BSE-only path's own numbers, printed only when
        // there WERE BSE-only symbols. Appending a zeroed clause to every run
        // is how a reason string becomes noise nobody reads, which is the
        // defect one paragraph down.
        (input.bseOnly
          ? ` (${input.bseOnly.served} served via screener; slugs ` +
            `${input.bseOnly.slugResolved} resolved / ` +
            `${input.bseOnly.slugMiss} no-scrip-code / ` +
            `${input.bseOnly.slugAmbiguous} ambiguous` +
            (input.bseOnly.masterUnavailable
              ? "; BSE SCRIP MASTER UNAVAILABLE — nothing cached"
              : "") +
            `)`
          : "")
      : "") +
    // MONEY-1315 (B) — printed only when it happened, on the `noNseListing`
    // precedent above: a zeroed clause appended to every run is how a reason
    // string becomes noise nobody reads.
    (input.htmlRefusals && input.htmlRefusals > 0
      ? `, ${input.htmlRefusals} download(s) refused as HTML pages`
      : "");

  if (selected === 0) return "population gate selected no symbols";
  if (written === 0)
    return `no documents written from any enabled source (${tail})`;

  const dark = (["tickertape", "nse", "screener"] as const).filter(
    (leg) => legs[leg] && wrote[leg] === 0,
  );
  if (dark.length > 0) {
    return `enabled source(s) produced nothing: ${dark.join(", ")} (${tail})`;
  }
  return undefined;
}
