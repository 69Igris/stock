/**
 * Fund Composition — Pure Logic
 *
 * Pure, side-effect-free helpers used by `fund-composition-service.ts`:
 * Gemini response parsing, holding validation/cleaning, prompt construction,
 * staleness (both CLOCK and CONTENT), the persist/retry policy and the
 * auto-extract policy. Extracted so the exact logic that production runs can be
 * unit-tested without Gemini or a database.
 *
 * `fund-composition-service.ts` imports and calls these — no parallel copies.
 * `apps/web/components/FundCompositionSection.tsx` imports the auto-extract
 * policy + content-staleness from here for the same reason (this module pulls
 * in no I/O, so a client component can import it).
 */

export interface ExtractedHolding {
  holdingName: string;
  holdingSymbol: string | null;
  isin: string | null;
  holdingType: "EQUITY" | "DEBT" | "CASH" | "REIT" | "GOLD" | "OTHER";
  sector: string | null;
  industry: string | null;
  marketCap: "LARGE" | "MID" | "SMALL" | "MICRO" | null;
  weightPercent: number;
}

export interface ParsedGeminiResponse {
  holdings: ExtractedHolding[];
  sectorBreakdown: Array<{ sector: string; weight: number }>;
  capBreakdown: Array<{ cap: string; weight: number }>;
  assetBreakdown: Array<{ type: string; weight: number }>;
  confidence: number;
  dataAsOf: string;
}

// ============== CONSTANTS ==============

/** Stale threshold: 90 days in milliseconds. */
export const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * MONEY-1205 — CONTENT staleness, in whole months.
 *
 * `STALE_THRESHOLD_MS` above measures the CLOCK (`extractedAt`), which is the
 * wrong field and can never fire: every re-extraction re-stamps `extractedAt =
 * now`, so a run that returns identical two-year-old content re-arms a fresh
 * 90-day window around it. Measured on prod 2026-08-18: all 111
 * `fund_composition_meta` rows carry `dataAsOf` in {2024-04, 2024-05, 2024-06}
 * (26-28 months behind) while `extractedAt` spans 2026-02 -> 2026-08. Six
 * months of re-extraction moved the clock and never moved the content.
 *
 * So the gate has to measure the CONTENT — the disclosure month the model
 * claims it read.
 *
 * ## Why 6
 *
 * SEBI requires every AMC to disclose the full scheme portfolio MONTHLY, within
 * 10 days of month end. The newest genuine disclosure is therefore never more
 * than ~40 days old, and a correct extraction should land 1-2 months behind
 * `now`. Six months is 4-5 disclosure cycles of slack: it absorbs an AMC that
 * publishes late, a scheme that only files quarterly, a model that names the
 * quarter rather than the month, and month-boundary/timezone slop — while still
 * catching the failure that actually happens. It is deliberately NOT tight (1-2
 * months) because a false FAILED hides a composition we could have shown; the
 * observed failure is 27 months, so every threshold in [1, 24] flags all 111
 * rows and the choice costs nothing on real data.
 */
export const CONTENT_STALE_THRESHOLD_MONTHS = 6;

/**
 * How far into the FUTURE a claimed disclosure month may sit before it is
 * treated as invalid. A disclosure that has not happened yet cannot have been
 * read, but `now` is compared in UTC while Indian disclosures are dated IST, so
 * one month of tolerance keeps a legitimately-current month from flipping
 * invalid for 5.5 hours at every month boundary.
 */
export const CONTENT_FUTURE_TOLERANCE_MONTHS = 1;

/**
 * MONEY-1205 — how long a FAILED extraction is left alone before another Gemini
 * call is spent on it.
 *
 * Without this, demoting the 111 content-stale rows to FAILED would be a
 * REGRESSION, not a fix: a demoted row reads as "no composition", which is
 * exactly the condition that triggered extraction in the first place, so every
 * page view would re-run Gemini, get the same 2024-05 answer, re-fail, and do
 * it again on the next view. One week means a fund that genuinely cannot be
 * extracted costs at most ~52 calls a year instead of one per page view.
 */
export const FAILED_RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a row parked in `EXTRACTING` is treated as an in-flight extraction
 * rather than a crashed one. The Gemini call itself is capped at 60s
 * (`generateWithTimeout`), so 5 minutes is comfortably past any live run and
 * short enough that a crashed extraction unblocks itself. This is what stops
 * two concurrent page views from both spending a call on the same fund.
 */
export const EXTRACTION_LOCK_MS = 5 * 60 * 1000;

export const VALID_HOLDING_TYPES = new Set([
  "EQUITY",
  "DEBT",
  "CASH",
  "REIT",
  "GOLD",
  "OTHER",
]);
export const VALID_CAP_SIZES = new Set(["LARGE", "MID", "SMALL", "MICRO"]);

/** A composition is stale once more than STALE_THRESHOLD_MS has elapsed. */
export function isCompositionStale(
  extractedAt: Date,
  now: number = Date.now(),
): boolean {
  return now - extractedAt.getTime() >= STALE_THRESHOLD_MS;
}

// ============== CONTENT PROVENANCE (MONEY-1205) ==============

/** A calendar month, 1-indexed (`month` 1 = January). */
export interface DisclosureMonth {
  year: number;
  month: number;
}

/**
 * Parse the model-reported disclosure period (`dataAsOf`) into a calendar
 * month. Accepts `"YYYY-MM"` (what the prompt asks for) and `"YYYY-MM-DD"`.
 *
 * ABSENCE IS NULL, NEVER A DATE: `""`, `"-"`, `"N/A"`, a non-string, an
 * out-of-range month and anything else unparseable all return `null` — the
 * caller must not read that as "month 0" or as "now".
 */
export function parseDisclosureMonth(
  dataAsOf: string | null | undefined,
): DisclosureMonth | null {
  if (typeof dataAsOf !== "string") return null;
  const trimmed = dataAsOf.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.toUpperCase() === "N/A") {
    return null;
  }
  const match = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  if (year < 1900 || year > 9999) return null;
  return { year, month };
}

/**
 * How many whole months the claimed disclosure month sits behind `now`.
 * Negative means the model claimed a period in the future. `null` when
 * `dataAsOf` carries no parseable month at all (see
 * {@link parseDisclosureMonth}) — the caller must distinguish "unknown" from
 * "zero months behind".
 */
export function monthsBehindNow(
  dataAsOf: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const parsed = parseDisclosureMonth(dataAsOf);
  if (!parsed) return null;
  const at = new Date(now);
  return (
    (at.getUTCFullYear() - parsed.year) * 12 +
    (at.getUTCMonth() + 1 - parsed.month)
  );
}

/**
 * MONEY-1205 — is the composition's CONTENT stale (or undateable)?
 *
 * This is the gate the clock-based {@link isCompositionStale} could never be:
 * it reads the disclosure month the extraction itself reported, which a
 * re-extraction cannot launder by re-stamping `extractedAt`.
 *
 * `true` (stale / not usable) when the claimed month is
 *   - missing or unparseable — an extraction that cannot say WHICH disclosure
 *     it read has not demonstrated that it read one; or
 *   - more than {@link CONTENT_STALE_THRESHOLD_MONTHS} months behind `now`; or
 *   - further than {@link CONTENT_FUTURE_TOLERANCE_MONTHS} in the future — a
 *     disclosure that has not been published cannot have been read.
 */
export function isCompositionContentStale(
  dataAsOf: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const behind = monthsBehindNow(dataAsOf, now);
  if (behind === null) return true;
  if (behind > CONTENT_STALE_THRESHOLD_MONTHS) return true;
  if (behind < -CONTENT_FUTURE_TOLERANCE_MONTHS) return true;
  return false;
}

/**
 * MONEY-1401 — may this composition be SERVED to a reader?
 *
 * The scoped form of {@link isCompositionContentStale}: the content gate exists
 * to disbelieve a MODEL that claims to have read a disclosure, and a filed
 * disclosure has nothing to disbelieve. `dataAsOf` on an `AMC_DISCLOSURE`
 * composition is `MfPortfolioHolding.period` — the month the AMC's own filing
 * describes — so a scheme whose AMC last published seven months ago must keep
 * its real portfolio rather than have it dropped by a gate written for an
 * entirely different failure.
 *
 * It lives here rather than inline in `FundCompositionSection` because the
 * POLARITY is the whole rule and a source scan cannot assert a polarity: the
 * component's `if (!unverifiedAndStale)` and its inverse both match
 * `/isCompositionContentStale\(…\)/`, so the assertion that was guarding it
 * stayed green with the branch flipped to serve ONLY stale recollections.
 */
export function shouldServeComposition(
  composition: { source?: string | null; dataAsOf?: string | null },
  now: number = Date.now(),
): boolean {
  if (composition?.source === "AMC_DISCLOSURE") return true;
  return !isCompositionContentStale(composition?.dataAsOf, now);
}

/**
 * The `FundCompositionMeta.errorMessage` written when an extraction is demoted
 * for content staleness. Records the evidence (the claimed month and how far
 * behind it is) so the row explains itself without a re-run.
 */
export function contentStaleReason(
  dataAsOf: string | null | undefined,
  now: number = Date.now(),
): string {
  const behind = monthsBehindNow(dataAsOf, now);
  if (behind === null) {
    return (
      "Extraction reported no usable disclosure period (dataAsOf=" +
      `${JSON.stringify(dataAsOf ?? null)}), so it cannot be attributed to a ` +
      "filed portfolio disclosure."
    );
  }
  if (behind < 0) {
    return (
      `Extraction reported a future disclosure period (${dataAsOf}, ` +
      `${-behind} month(s) ahead), which cannot have been published yet.`
    );
  }
  return (
    `Extraction reported disclosure period ${dataAsOf}, ${behind} months ` +
    `behind now (limit ${CONTENT_STALE_THRESHOLD_MONTHS}). SEBI portfolio ` +
    "disclosures are monthly, so this is a failed extraction, not fresh data."
  );
}

/** Outcome of the provenance gate applied before a composition is stored. */
export interface CompositionPersistDecision {
  status: "READY" | "FAILED";
  errorMessage: string | null;
}

/**
 * Decide how an extraction result must be RECORDED.
 *
 * A result whose content is stale/undateable is a FAILED extraction, not a
 * successful one — writing it as `READY` is what let a two-year-old recitation
 * render as authoritative fund data for six months. This is the single place
 * that decision is made; `persistComposition` branches on it.
 */
export function decideCompositionPersist(
  dataAsOf: string | null | undefined,
  now: number = Date.now(),
): CompositionPersistDecision {
  if (isCompositionContentStale(dataAsOf, now)) {
    return {
      status: "FAILED",
      errorMessage: contentStaleReason(dataAsOf, now),
    };
  }
  return { status: "READY", errorMessage: null };
}

/**
 * Is a previously FAILED extraction due for another attempt? `null`/undefined
 * (a row with no recorded attempt time) is treated as due.
 */
export function isFailedRetryDue(
  lastAttemptAt: Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!(lastAttemptAt instanceof Date)) return true;
  const at = lastAttemptAt.getTime();
  if (!Number.isFinite(at)) return true;
  return now - at >= FAILED_RETRY_COOLDOWN_MS;
}

/**
 * Is another extraction already in flight for this fund? True while a row has
 * been sitting in `EXTRACTING` for less than {@link EXTRACTION_LOCK_MS}.
 */
export function isExtractionLockHeld(
  lastAttemptAt: Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!(lastAttemptAt instanceof Date)) return false;
  const at = lastAttemptAt.getTime();
  if (!Number.isFinite(at)) return false;
  return now - at < EXTRACTION_LOCK_MS;
}

// ============== AUTO-TRIGGER POLICY (MONEY-1205) ==============

/** Everything the auto-extract decision is allowed to depend on. */
export interface AutoExtractContext {
  fundType: "MF" | "ETF" | "INDEX";
  /** An official AMC/exchange portfolio disclosure is already on the page. */
  hasOfficialDisclosure: boolean;
  /** Demo sessions render fabricated data and must never call Gemini. */
  isDemoMode: boolean;
  /** A cached composition was already returned for this fund. */
  hasComposition: boolean;
}

/**
 * May a page VIEW spend a Gemini call, with no user asking for it?
 *
 * **No. Never. For any fund type.** — MONEY-1405 D6.
 *
 * MONEY-1205 narrowed this to "only an MF, only when nothing better exists,
 * only when there is nothing to show", which stopped ~446 ETF pages from each
 * burning an LLM call on mount. What it left standing was the MF half, and the
 * MF half rests on a premise that measurement has now removed: that an
 * auto-extraction produces something worth having when the AMC publishes
 * nothing.
 *
 * It does not. `buildExtractionPrompt` interpolates three strings out of our
 * own database — name, issuer, category — and asks `gemini-2.5-pro` at
 * temperature 0.9 for "the top 15-25 holdings based on the most recent publicly
 * available SEBI portfolio disclosure", a disclosure it is never given. There is
 * no fetch, no PDF, no grounding of any kind. It is RECALL, and it measures
 * like recall: 1,800 stored holdings across 111 funds, weight sums with a p50 of
 * 84% of NAV and 10 funds under 50%, every `dataAsOf` in {2024-04, 2024-05,
 * 2024-06} at a self-reported 0.95-0.99 confidence.
 *
 * A page view is not consent to spend a paid thinking call on that. The
 * "Analyze Holdings" button still exists and still works — it is labelled as a
 * third-party model estimate, it is authenticated and rate-limited (MONEY-1405
 * A1), and a human pressing it is the whole difference.
 *
 * The signature keeps `AutoExtractContext` rather than collapsing to a bare
 * `false`, so the call site keeps supplying the facts and a future
 * re-introduction has to argue against the evidence above rather than simply
 * widen a condition nobody is reading.
 */
export function shouldAutoExtractComposition(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ctx: AutoExtractContext,
): boolean {
  return false;
}

/**
 * Parse JSON from a Gemini response, tolerating a leading/trailing markdown
 * code fence. Returns null when the payload is not valid JSON or is missing a
 * holdings array. Non-array breakdowns default to []; confidence/dataAsOf get
 * sensible defaults.
 */
export function parseGeminiResponse(raw: string): ParsedGeminiResponse | null {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(cleaned);

    if (!parsed.holdings || !Array.isArray(parsed.holdings)) {
      return null;
    }

    return {
      holdings: parsed.holdings,
      sectorBreakdown: Array.isArray(parsed.sectorBreakdown)
        ? parsed.sectorBreakdown
        : [],
      capBreakdown: Array.isArray(parsed.capBreakdown)
        ? parsed.capBreakdown
        : [],
      assetBreakdown: Array.isArray(parsed.assetBreakdown)
        ? parsed.assetBreakdown
        : [],
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      dataAsOf: typeof parsed.dataAsOf === "string" ? parsed.dataAsOf : "",
    };
  } catch {
    return null;
  }
}

/**
 * Validate and clean extracted holdings. Drops items without a non-empty name
 * or a weightPercent in (0, 100]; coerces holdingType/marketCap to known values
 * (default EQUITY / null); trims string fields; rounds weight to 2 decimals.
 */
export function validateHoldings(raw: unknown[]): ExtractedHolding[] {
  const valid: ExtractedHolding[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;

    if (typeof h.holdingName !== "string" || !h.holdingName.trim()) continue;
    if (typeof h.weightPercent !== "number" || h.weightPercent <= 0) continue;
    if (h.weightPercent > 100) continue;

    const holdingType = VALID_HOLDING_TYPES.has(h.holdingType as string)
      ? (h.holdingType as ExtractedHolding["holdingType"])
      : "EQUITY";

    const marketCap = VALID_CAP_SIZES.has(h.marketCap as string)
      ? (h.marketCap as ExtractedHolding["marketCap"])
      : null;

    valid.push({
      holdingName: h.holdingName.trim(),
      holdingSymbol:
        typeof h.holdingSymbol === "string" ? h.holdingSymbol.trim() : null,
      isin: typeof h.isin === "string" ? h.isin.trim() : null,
      holdingType,
      sector: typeof h.sector === "string" ? h.sector.trim() : null,
      industry: typeof h.industry === "string" ? h.industry.trim() : null,
      marketCap,
      weightPercent: Math.round(h.weightPercent * 100) / 100,
    });
  }

  return valid;
}

/**
 * Build the Gemini extraction prompt for a fund.
 *
 * MONEY-1205 — do NOT "fix" the provenance problem by telling the model its
 * `dataAsOf` must be recent. The gate in {@link isCompositionContentStale}
 * works precisely because the model reports the period it actually believes it
 * read; instructing it to report a recent month converts an honest, detectable
 * failure into an undetectable one. The prompt asks for the true month and the
 * persist gate decides what to do with the answer.
 */
export function buildExtractionPrompt(
  fundType: "MF" | "ETF" | "INDEX",
  fundInfo: { name: string; issuer: string; category: string },
): string {
  const typeLabel =
    fundType === "MF" ? "mutual fund" : fundType === "INDEX" ? "index" : "ETF";
  return `You are a financial data extraction expert specializing in Indian mutual funds and ETFs.

TASK: Extract the portfolio holdings for the following ${typeLabel}:

Fund Name: ${fundInfo.name}
${fundType === "MF" ? `AMC: ${fundInfo.issuer}` : `Issuer: ${fundInfo.issuer}`}
Category: ${fundInfo.category}

INSTRUCTIONS:
1. Based on the most recent publicly available SEBI portfolio disclosure, list the top 15-25 holdings.
2. For each holding provide: holdingName, holdingSymbol (NSE ticker), isin, holdingType, sector, industry, marketCap, weightPercent.
3. holdingType must be one of: EQUITY, DEBT, CASH, REIT, GOLD, OTHER
4. marketCap must be one of: LARGE, MID, SMALL, MICRO (or null for non-equity)
5. weightPercent should be the approximate portfolio allocation percentage.
6. Also compute pre-aggregated breakdown arrays:
   - sectorBreakdown: [{ "sector": "Banking", "weight": 25.5 }, ...]
   - capBreakdown: [{ "cap": "LARGE", "weight": 65 }, ...]
   - assetBreakdown: [{ "type": "EQUITY", "weight": 85 }, ...]
7. Include a "confidence" score (0-1) indicating your overall confidence in the data.
8. Include "dataAsOf" field with the approximate disclosure month (e.g. "2025-12").

CRITICAL RULES:
- Only include holdings you are confident about. Do NOT fabricate data.
- Use NSE symbols for Indian stocks (e.g. HDFCBANK, RELIANCE, INFY).
- Ensure weightPercent values are realistic and roughly sum to 80-100% for top holdings.
- If you cannot find reliable data, return fewer holdings with higher confidence.

RESPONSE FORMAT: Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "holdings": [
    {
      "holdingName": "HDFC Bank Ltd",
      "holdingSymbol": "HDFCBANK",
      "isin": "INE040A01034",
      "holdingType": "EQUITY",
      "sector": "Banking",
      "industry": "Private Banking",
      "marketCap": "LARGE",
      "weightPercent": 8.5
    }
  ],
  "sectorBreakdown": [{ "sector": "Banking", "weight": 25.5 }],
  "capBreakdown": [{ "cap": "LARGE", "weight": 65 }],
  "assetBreakdown": [{ "type": "EQUITY", "weight": 85 }],
  "confidence": 0.85,
  "dataAsOf": "2025-12"
}`;
}
