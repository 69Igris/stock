/**
 * Screener.in COMPANY IDENTITY resolution — MONEY-1255 (A2).
 *
 * PURE. This module makes NO HTTP REQUEST OF ANY KIND, and that is a designed
 * property rather than an accident of what it happens to need — see the
 * robots.txt section below, and the guard test that keeps it true.
 *
 * ## The gap this closes
 *
 * 2,389 real companies are listed on BSE with NO NSE row. Every
 * financial-document producer in this repo is NSE-keyed — both legs of
 * `stock-document-sync` read NSE endpoints, and the "Tickertape" leg is a read
 * of `stock_financials`, which `xbrl-projection` fills from an NSE-FILERS-ONLY
 * ingest. So those companies can never receive an annual report, and document
 * coverage ceilings at 56.8% of 5,523 real companies no matter how well the
 * rotation works.
 *
 * screener.in reaches all of them, but not by our ticker: its company page is
 * keyed by a SLUG. This module turns one of our instruments into that slug.
 *
 * ## How: ISIN -> BSE's own scrip master -> `/company/<scripcode>/`
 *
 * The slug is USUALLY THE BSE SCRIP CODE, and we already fetch BSE's authority
 * on scrip codes every night: `fetchBseScripMaster()`
 * (`packages/core/src/market-data/instruments/bse-master-instruments.ts`) runs
 * on `instrument-sync-daily` and returns scrip code + ISIN + name for the whole
 * ~12,600-row active universe. All 2,389 BSE-only companies carry an ISIN on
 * `InstrumentMapping`. So the resolution is a JOIN on a stable identity, not a
 * lookup against a search engine.
 *
 * Verified against four sampled BSE-only companies — `/company/530127/`,
 * `/company/511122/`, `/company/512517/`, `/company/526081/` all answer 200
 * with 8-13 annual-report links.
 *
 * ## WRONG IS IMPOSSIBLE HERE, not merely unlikely
 *
 * A slug is a CLAIM that a screener page belongs to this company. Get it wrong
 * and we attach another company's annual reports to our symbol, where they are
 * indistinguishable from correct data: the PDF parses, the numbers project into
 * `stock_financials` under our key, every dashboard reads green. Having no
 * document at all is strictly better than that.
 *
 * An ISIN -> scrip-code join is a FACT published by the exchange that issues
 * both identifiers. There is no similarity judgement in it, so there is no
 * threshold to tune and no near-match to accept by mistake. The only two ways
 * it declines are "no row for this ISIN" (a miss) and "this ISIN maps to more
 * than one scrip code" (ambiguous, and EXCLUDED rather than last-wins).
 *
 * The name-similarity machinery below — {@link namesAgree},
 * {@link chooseScreenerCandidate} — is NOT on that path. It is retained,
 * exported and tested because it encodes a trap worth keeping (`Bosch India`
 * and `Bosch Rexroth India` score IDENTICALLY to a legitimate name variant), and
 * because an alpha-slug source would need it. `money1255-screener-slug-resolution`
 * asserts it has no caller in `src/`, so "not on the live path" is a CHECKED
 * property and cannot quietly stop being true.
 *
 * ## screener.in's robots.txt — why there is no search call here
 *
 * Fetched 2026-08-26 from `https://www.screener.in/robots.txt`, verbatim:
 *
 *     User-agent: *
 *     Disallow: /user/*
 *     Disallow: /*?q=
 *     Disallow: /*?sort=
 *     Disallow: /*?limit=
 *     Disallow: /*?page=
 *     Disallow: /company/source/quarter/*
 *
 * `Disallow: /*?q=` covers `/api/company/search/?q=<symbol>`. `/api/` is not
 * separately exempted and the file carries no `Allow:` lines.
 *
 * An earlier draft of this module DID call that endpoint. It has been removed
 * outright rather than demoted to a guarded fallback: a code path that can
 * fetch a Disallowed URL is one flag flip away from fetching it. The company
 * PAGE fetch (`/company/<slug>/consolidated/`) is allowed, is the fetch we were
 * already making, and is the only screener request this feature adds — zero
 * extra requests to a host that has 429'd us before (MONEY-853).
 *
 * `screener-full-scraper.ts`'s header used to claim "we never hit the Disallowed
 * `?q=` search". That claim is TRUE again, and it is now enforced by a scan
 * rather than by a comment.
 *
 * The last rule matters too: `Disallow: /company/source/quarter/*` covers the
 * quarterly raw-PDF endpoint in {@link buildQuarterSourceUrl}, which is
 * DOCUMENTED AND NOT FETCHED for that reason and one other.
 *
 * ## `null` is a FINDING, and it expires — but only when we actually LOOKED
 *
 * `screenerSlug: null` with a fresh `screenerSlugCheckedAt` means "BSE's master
 * has no scrip code we can join this company to" — a real, re-checkable state,
 * and NOT the same as never-asked (the timestamp absent). It expires after
 * {@link SCREENER_SLUG_TTL_MS}, because new listings appear.
 *
 * A master that could not be FETCHED is a fourth outcome, `unavailable`, and it
 * must never be persisted. `fetchBseScripMaster` returns `[]` on a failed fetch
 * AND when `BSE_MASTER_ENRICH=off`, so treating an empty index as "no match"
 * would stamp a 90-day "no page" finding onto every BSE-only company in the
 * page during a transient BSE outage — caching a failure as a fact, which is
 * the one thing this codebase has a standing rule against.
 *
 * @see workers/src/processors/stock-document-sync.ts (the only caller)
 * @see packages/database/prisma/schema.prisma InstrumentMapping.screenerSlug
 */

/**
 * How long a resolution attempt stands before it is asked again.
 *
 * Applies to the NEGATIVE answers only (`miss` / `ambiguous`). A resolved scrip
 * code is used for as long as it is stored: unlike a search result it does not
 * go stale — BSE does not reissue scrip codes — and re-deriving it would spend
 * a master fetch to reach the same answer.
 *
 * (KNOWN, DELIBERATELY NOT BUILT: a scrip code whose screener page 404s is not
 * self-healing. The scrape returns null and the symbol writes nothing, exactly
 * as it did before this module existed. Invalidating on a 404 would need the
 * scraper to distinguish "404" from "parsed nothing", which it does not:
 * `scrapeScreenerFullPage` returns `null` for both.)
 */
export const SCREENER_SLUG_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The token overlap two company names must reach to be called the same company.
 *
 * NOT ON THE LIVE PATH — see the module header. Retained because the table
 * below is knowledge, and because the seventh row is the one that matters.
 *
 * Jaccard (`|A n B| / |A u B|`) over significant tokens, corporate-form noise
 * removed first, because "Krisna Filaments" and "Krisna Filaments Ltd" are one
 * company and the suffix carries no identity.
 *
 * 0.6 is chosen against the shape that actually hurts, the SIBLING COMPANY — a
 * real, differently-listed entity sharing a house name:
 *
 *   Krisna Filaments      vs Krisna Filaments Ltd          -> 2/2  = 1.00  accept
 *   Tata Consultancy Svcs vs Tata Consultancy Svcs Ltd     -> 3/3  = 1.00  accept
 *   Krisna Filaments      vs Krisna Filaments Industries   -> 2/3  = 0.67  accept
 *   Sun Pharmaceutical    vs Sun Pharma Advanced Research  -> 1/4  = 0.25  reject
 *   Reliance Industries   vs Reliance Industrial Infra     -> 1/4  = 0.25  reject
 *   Bajaj Finance         vs Bajaj Finserv                 -> 1/3  = 0.33  reject
 *   Bosch India           vs Bosch Rexroth India           -> 2/3  = 0.67  ????
 *
 * IT IS NOT SUFFICIENT ON ITS OWN, and that was found by the test rather than
 * by the table: the last row is a DIFFERENT COMPANY scoring exactly what a
 * legitimate variant scores. {@link namesAgree} is the real rule — this
 * threshold PLUS an ordered-prefix test, which separates a qualifier APPENDED
 * to the same name from one INSERTED into a sibling's.
 */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * Words that carry no company identity, stripped before the overlap is taken.
 *
 * Deliberately SHORT. Every word removed here makes two different companies
 * look more alike, so it holds corporate-form boilerplate ONLY — never a
 * business word (`INDUSTRIES`, `TEXTILES`, `FINANCE`) and never a geography
 * (`INDIA`), because "Bosch India" and "Bosch Rexroth India" are two companies
 * and `INDIA` is doing real work in telling them apart.
 */
const CORPORATE_STOPWORDS: ReadonlySet<string> = new Set([
  "LTD",
  "LIMITED",
  "PVT",
  "PRIVATE",
  "CO",
  "COMPANY",
  "CORP",
  "CORPN",
  "CORPORATION",
  "INC",
  "INCORPORATED",
  "PLC",
  "LLP",
  "THE",
  "AND",
  "OF",
]);

/**
 * One screener company candidate — a name plus a company path.
 *
 * NOT produced by anything on the live path (nothing here queries screener's
 * search). It is the input shape {@link chooseScreenerCandidate} validates.
 */
export interface ScreenerSearchHit {
  /** Screener's own numeric company id — see {@link buildQuarterSourceUrl}. */
  id: number | null;
  /** Display name, e.g. "Krisna Filaments Ltd". */
  name: string;
  /** Company path, e.g. "/company/511122/" or "/company/KRISNAFILA/". */
  url: string;
}

/**
 * Why a resolution ended the way it did.
 *
 * `unavailable` is the one that must NOT be persisted: it means we could not
 * look, not that we looked and found nothing. See the module header.
 */
export type ScreenerSlugOutcome =
  | "resolved"
  | "miss"
  | "ambiguous"
  | "unavailable";

/** The decision, plus everything the caller persists or counts. */
export interface ScreenerSlugChoice {
  outcome: ScreenerSlugOutcome;
  /** The accepted slug, or `null` on anything else. */
  slug: string | null;
  /** Derived when — and only when — the accepted slug is all digits. */
  bseScripCode: string | null;
  /** Screener's numeric company id, when a candidate carried one. */
  screenerId: number | null;
  /** Human-readable justification. Goes straight into the run log. */
  reason: string;
}

/** Upper-case and drop everything that is not a letter or digit. */
export function normalizeSlugToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The slug out of a screener company URL, or `null` when there isn't one.
 *
 * Takes the segment immediately AFTER `company`, which is what makes the
 * `/consolidated/` and `/standalone/` tails a non-issue rather than a list of
 * suffixes to strip — screener serves several and adding one would otherwise
 * turn a good slug into `KRISNAFILA/standalone`, i.e. a 404 that reads exactly
 * like "this company has no page".
 *
 * Rejects a slug carrying characters a screener slug cannot contain, so a
 * malformed or hostile `url` cannot be pasted into a fetch path.
 */
export function extractSlugFromUrl(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  // Tolerate an absolute URL as well as the relative path the API returns.
  const path = url.replace(/^https?:\/\/[^/]+/i, "");
  const segments = path.split("/").filter((s) => s.length > 0);
  const idx = segments.indexOf("company");
  const slug = idx >= 0 ? segments[idx + 1] : undefined;
  if (!slug) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9&._-]*$/.test(slug)) return null;
  return slug;
}

/** True when the slug is entirely digits — i.e. it IS a BSE scrip code. */
export function isNumericSlug(slug: string): boolean {
  return /^[0-9]+$/.test(slug);
}

/**
 * Significant tokens of a company name IN ORDER, upper-cased, boilerplate
 * removed, de-duplicated.
 *
 * Order is kept because {@link namesAgree} needs it — see the prefix rule
 * there. De-duplicated so a repeated word cannot inflate an overlap.
 */
export function companyNameTokenList(name: string): string[] {
  const out: string[] = [];
  if (typeof name !== "string") return out;
  const seen = new Set<string>();
  for (const raw of name.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (raw.length === 0) continue;
    if (CORPORATE_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** The same tokens as a `Set`, for the overlap. */
export function companyNameTokens(name: string): Set<string> {
  return new Set(companyNameTokenList(name));
}

/**
 * Jaccard similarity of two company names, in [0, 1].
 *
 * Returns 0 when either side has no significant tokens — a name that is
 * entirely boilerplate carries no identity, and 0/0 must not read as "perfect
 * agreement". (The non-finite guard this repo keeps re-learning: the empty
 * case is the one that turns a divide into a silent `NaN` and a `NaN >=
 * threshold` into `false`, which happens to be right here, but only by luck.)
 */
export function nameSimilarity(a: string, b: string): number {
  const A = companyNameTokens(a);
  const B = companyNameTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const token of A) if (B.has(token)) shared += 1;
  const union = A.size + B.size - shared;
  if (union <= 0) return 0;
  return shared / union;
}

/**
 * Do these two names name the SAME company? The name arm of the acceptance rule.
 *
 * TWO tests, both required, because each one alone admits a false positive that
 * the other rejects. Both counterexamples are in the test file; neither is
 * hypothetical.
 *
 *  1. **Overlap** — {@link nameSimilarity} at or above
 *     {@link NAME_MATCH_THRESHOLD}. Rejects a name that merely shares a house
 *     word ("Bajaj Finance" vs "Bajaj Finserv", 0.33).
 *
 *  2. **Prefix** — the shorter ordered token list must be a PREFIX of the
 *     longer. This is the test that separates an appended QUALIFIER from an
 *     inserted one, and overlap cannot do it because both score identically:
 *
 *       Krisna Filaments  vs Krisna Filaments Industries  0.67, prefix    ACCEPT
 *       Bosch India       vs Bosch Rexroth India          0.67, NO prefix REJECT
 *
 *     The second is a different legal entity in the same house — precisely the
 *     confusion that files one company's annual reports under another's ticker.
 *     Discovered by the test, not by reasoning: the threshold was chosen
 *     against a table of six examples and the seventh broke it.
 *
 * And why overlap is still needed once there is a prefix test: a prefix rule
 * alone accepts "Tata" vs "Tata Motors". Overlap scores that 0.5 and refuses.
 */
export function namesAgree(a: string, b: string): boolean {
  if (nameSimilarity(a, b) < NAME_MATCH_THRESHOLD) return false;
  const A = companyNameTokenList(a);
  const B = companyNameTokenList(b);
  if (A.length === 0 || B.length === 0) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  return short.every((token, i) => long[i] === token);
}

/**
 * THE ACCEPTANCE RULE. Pure, total, and the only place a slug is blessed.
 *
 * See the module header for why each arm is what it is. In one line: accept a
 * candidate on SLUG IDENTITY or NAME IDENTITY, and only when exactly one
 * distinct slug clears the bar.
 */
export function chooseScreenerCandidate(
  instrument: { symbol: string; name: string },
  candidates: readonly ScreenerSearchHit[],
): ScreenerSlugChoice {
  const wantedSymbol = normalizeSlugToken(instrument.symbol ?? "");

  // De-duplicate by slug FIRST. Screener returns the same company under
  // `/company/X/` and `/company/X/consolidated/`, and counting that as two
  // acceptable candidates would report every ordinary success as ambiguous.
  const bySlug = new Map<
    string,
    { slug: string; name: string; id: number | null }
  >();
  for (const hit of candidates) {
    const slug = extractSlugFromUrl(hit.url);
    if (!slug) continue;
    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { slug, name: hit.name, id: hit.id });
      continue;
    }
    // Keep the richer row: a name and an id are both worth more than neither.
    if (!existing.name && hit.name) existing.name = hit.name;
    if (existing.id === null && hit.id !== null) existing.id = hit.id;
  }

  if (bySlug.size === 0) {
    return {
      outcome: "miss",
      slug: null,
      bseScripCode: null,
      screenerId: null,
      reason:
        candidates.length === 0
          ? "screener returned no results"
          : `screener returned ${candidates.length} result(s), none with a usable company url`,
    };
  }

  const accepted: Array<{
    slug: string;
    id: number | null;
    why: string;
  }> = [];
  for (const cand of bySlug.values()) {
    if (
      wantedSymbol.length > 0 &&
      normalizeSlugToken(cand.slug) === wantedSymbol
    ) {
      accepted.push({ slug: cand.slug, id: cand.id, why: "slug==symbol" });
      continue;
    }
    if (namesAgree(instrument.name ?? "", cand.name)) {
      accepted.push({
        slug: cand.slug,
        id: cand.id,
        why: `name overlap ${nameSimilarity(instrument.name ?? "", cand.name).toFixed(2)}`,
      });
    }
  }

  if (accepted.length === 0) {
    // NOT a miss. Screener HAS pages that answered to this query; we simply
    // cannot prove any of them is ours, and guessing is the one outcome this
    // module refuses. `slugAmbiguous` is the counter that keeps that visible
    // rather than folding it into "no page exists".
    return {
      outcome: "ambiguous",
      slug: null,
      bseScripCode: null,
      screenerId: null,
      reason:
        `${bySlug.size} candidate(s), none defensible ` +
        `(${[...bySlug.values()]
          .map((c) => `${c.slug}:${c.name}`)
          .join(" | ")
          .slice(0, 200)})`,
    };
  }

  if (accepted.length > 1) {
    return {
      outcome: "ambiguous",
      slug: null,
      bseScripCode: null,
      screenerId: null,
      reason: `${accepted.length} candidates cleared the bar (${accepted
        .map((a) => a.slug)
        .join(", ")}) — cannot tell which page is ours`,
    };
  }

  const winner = accepted[0]!;
  return {
    outcome: "resolved",
    slug: winner.slug,
    bseScripCode: isNumericSlug(winner.slug) ? winner.slug : null,
    screenerId: winner.id,
    reason: winner.why,
  };
}

/**
 * What to do about a row's cached screener identity, before spending anything.
 *
 * - `cached` — a slug is stored; use it.
 * - `skip`   — we asked recently and the answer was "no page". Do NOT re-ask.
 * - `resolve` — never asked, or the negative answer has expired.
 *
 * NOTE what this function does NOT do: it never builds a Prisma `where`. Both
 * `{screenerSlug: null}` and `{screenerSlug: {not: null}}` match ZERO rows on
 * Mongo, because `db push` creates indexes and never fields and the attribute
 * is ABSENT on all ~20,804 pre-existing rows (MONEY-1050 / 1205 / 1234 / 1236).
 * The decision is taken in code, from a row already in hand.
 */
export function planScreenerSlugResolution(
  row: {
    screenerSlug?: string | null;
    screenerSlugCheckedAt?: Date | string | null;
  },
  nowMs: number,
  ttlMs: number = SCREENER_SLUG_TTL_MS,
): "cached" | "skip" | "resolve" {
  const slug = row.screenerSlug;
  if (typeof slug === "string" && slug.trim().length > 0) return "cached";

  const raw = row.screenerSlugCheckedAt;
  if (raw === undefined || raw === null) return "resolve";
  const checkedAt = raw instanceof Date ? raw : new Date(raw);
  const t = checkedAt.getTime();
  // An Invalid Date is not a fresh finding; it is a corrupt one. Re-ask.
  if (!Number.isFinite(t)) return "resolve";
  return nowMs - t < ttlMs ? "skip" : "resolve";
}

/**
 * The per-quarter raw-PDF endpoint a screener page exposes — MONEY-1255 A2.4.
 *
 * `https://www.screener.in/company/source/quarter/<screenerId>/<month>/<year>/`
 *
 * RECORDED, NOT FETCHED, for two independent reasons — either one sufficient:
 *
 *  1. `bse-announcements-sync` is the PRIMARY source for a BSE-only company's
 *     quarterly filings. A second fetcher here would make two writers for one
 *     docType race on the same `@@unique([symbol, exchange, docType, period])`,
 *     which is how one source silently overwrites the other's rows on a
 *     schedule nobody is watching.
 *  2. screener.in's robots.txt carries `Disallow: /company/source/quarter/*`
 *     (verbatim in the module header, fetched 2026-08-26). This path is named
 *     explicitly, not swept up by a wildcard.
 *
 * It is written down because the shape is PROVEN and the knowledge is
 * perishable: if the BSE announcements route turns out not to cover quarterly
 * results for these companies, this is the fallback, and re-deriving it means
 * re-probing screener.
 */
export function buildQuarterSourceUrl(
  screenerId: number,
  month: number,
  year: number,
): string {
  return `https://www.screener.in/company/source/quarter/${screenerId}/${month}/${year}/`;
}

// ───────────────────────────────────────────────────────────────────────────
// THE LIVE PATH — ISIN -> BSE's own scrip master -> /company/<scripcode>/
// ───────────────────────────────────────────────────────────────────────────

/** The subset of a `BseMasterRow` this join reads. Structural, so the research
 * package does not have to depend on `@usemoney/core` for a type. */
export interface BseScripMasterRow {
  /** BSE trading symbol. Does NOT always equal our stored symbol. */
  scripId: string;
  /** Numeric BSE scrip code — the screener slug we are after. */
  scripCode: string;
  isin: string | null;
}

/**
 * ISIN / scrip-id lookups built from BSE's scrip master.
 *
 * CONFLICTS ARE EXCLUDED, NOT LAST-WINS. If one ISIN appears against two scrip
 * codes, a `Map.set` loop would silently hand back whichever row BSE happened
 * to serve second — a wrong company, arrived at by iteration order, which is
 * precisely the failure this whole module is shaped to make impossible. The key
 * is removed and recorded instead, so the resolution reports `ambiguous`.
 */
export interface BseScripIndex {
  byIsin: ReadonlyMap<string, string>;
  byScripId: ReadonlyMap<string, string>;
  ambiguousIsins: ReadonlySet<string>;
  ambiguousScripIds: ReadonlySet<string>;
  /**
   * Master rows indexed.
   *
   * ZERO IS NOT "NO MATCHES" — it is "we could not look". `fetchBseScripMaster`
   * returns `[]` both on a failed fetch and when `BSE_MASTER_ENRICH=off`, so an
   * empty index that resolved as a miss would stamp a 90-day "no page" finding
   * onto every BSE-only company in the page during a transient BSE outage.
   * {@link resolveScreenerSlugFromBse} reports `unavailable` and the caller
   * persists nothing.
   */
  size: number;
}

/** Build the lookups. Pure; safe on an empty or junk array. */
export function buildBseScripIndex(
  rows: readonly BseScripMasterRow[],
): BseScripIndex {
  const byIsin = new Map<string, string>();
  const byScripId = new Map<string, string>();
  const ambiguousIsins = new Set<string>();
  const ambiguousScripIds = new Set<string>();

  const add = (
    map: Map<string, string>,
    conflicts: Set<string>,
    rawKey: string | null | undefined,
    code: string,
  ): void => {
    const key = (rawKey ?? "").trim().toUpperCase();
    if (key.length === 0) return;
    if (conflicts.has(key)) return;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, code);
      return;
    }
    if (existing !== code) {
      map.delete(key);
      conflicts.add(key);
    }
  };

  let size = 0;
  for (const row of rows) {
    if (!row) continue;
    const code = (row.scripCode ?? "").trim();
    // A scrip code is pasted into a URL path. Anything that is not digits is
    // refused outright rather than encoded and hoped for.
    if (!isNumericSlug(code)) continue;
    size += 1;
    add(byIsin, ambiguousIsins, row.isin, code);
    add(byScripId, ambiguousScripIds, row.scripId, code);
  }

  return { byIsin, byScripId, ambiguousIsins, ambiguousScripIds, size };
}

/**
 * Resolve ONE instrument to its screener slug, from BSE's own master.
 *
 * ISIN FIRST, scrip-id second — the ordering `scripts/data/backfill-bse-results.ts`
 * already uses, and for its reason: the ISIN is the stable identity, while
 * BSE's `scrip_id` does not always equal our stored `symbol` (a rename leaves
 * the two carrying different tickers for one company, MONEY-1177). The fallback
 * exists because a handful of rows carry no ISIN on either side; it is a
 * lookup on an exchange-published key, not a guess.
 *
 * There is no similarity judgement anywhere in here, so there is no threshold to
 * tune and no near-match to accept by mistake. The slug it returns is numeric by
 * construction, which is why `bseScripCode` comes free and authoritative — what
 * A4's XBRL bridge needs, from the exchange that issues it.
 */
export function resolveScreenerSlugFromBse(
  instrument: { symbol: string; isin?: string | null },
  index: BseScripIndex,
): ScreenerSlugChoice {
  if (index.size === 0) {
    return {
      outcome: "unavailable",
      slug: null,
      bseScripCode: null,
      screenerId: null,
      reason:
        "BSE scrip master unavailable (fetch failed, or BSE_MASTER_ENRICH=off) " +
        "— NOT a finding, nothing persisted",
    };
  }

  const isin = (instrument.isin ?? "").trim().toUpperCase();
  const symbol = (instrument.symbol ?? "").trim().toUpperCase();

  if (isin.length > 0) {
    if (index.ambiguousIsins.has(isin)) {
      return {
        outcome: "ambiguous",
        slug: null,
        bseScripCode: null,
        screenerId: null,
        reason: `ISIN ${isin} maps to more than one scrip code in BSE's master`,
      };
    }
    const code = index.byIsin.get(isin);
    if (code) {
      return {
        outcome: "resolved",
        slug: code,
        bseScripCode: code,
        screenerId: null,
        reason: `ISIN ${isin} -> scrip ${code} (BSE master)`,
      };
    }
  }

  if (symbol.length > 0) {
    if (index.ambiguousScripIds.has(symbol)) {
      return {
        outcome: "ambiguous",
        slug: null,
        bseScripCode: null,
        screenerId: null,
        reason: `scrip_id ${symbol} maps to more than one scrip code in BSE's master`,
      };
    }
    const code = index.byScripId.get(symbol);
    if (code) {
      return {
        outcome: "resolved",
        slug: code,
        bseScripCode: code,
        screenerId: null,
        reason: `scrip_id ${symbol} -> scrip ${code} (BSE master)`,
      };
    }
  }

  return {
    outcome: "miss",
    slug: null,
    bseScripCode: null,
    screenerId: null,
    reason:
      `no BSE master row for ISIN ${isin || "(none)"} or scrip_id ${symbol}` +
      ` (${index.size} rows indexed)`,
  };
}
