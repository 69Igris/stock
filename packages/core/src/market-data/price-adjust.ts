/**
 * Back-adjustment of raw exchange prices for corporate actions — MONEY-1176.
 *
 * ## Why this is needed
 *
 * `DailyPrice` stores what the exchange actually printed, in raw rupees
 * (MONEY-1175 made that uniform), and `toHistoricalBar` plots the raw `close`.
 * So a chart gaps down at every split and bonus. Those gaps are CORRECT in raw
 * terms — the price really did halve — but a user reading a 5Y RELIANCE chart
 * sees the price fall by half overnight with nothing to explain it.
 *
 * ## The model
 *
 * Standard back-adjustment, the same thing Yahoo does. We know it is the same
 * because MONEY-1175 reverse-engineered Yahoo's factors from our own data: the
 * bhavcopy/Yahoo ratio for RELIANCE steps 13.933 -> 8.831 -> 4.364 -> 2.197,
 * landing exactly on the 2006 demerger and the 2009/2017 1:1 bonuses.
 *
 *     adjusted(d) = raw(d) / PRODUCT( R_a  for every action a with exDate > d )
 *
 * where R is the post:pre share ratio — a 1:1 bonus doubles the share count so
 * R = 2, a 1:5 split gives R = 5, a reverse split gives R < 1. Prices before
 * the event are divided so they are comparable with prices after it.
 *
 * VOLUME moves the OTHER WAY: the same rupee turnover is spread over R times as
 * many shares, so pre-event volume is MULTIPLIED by R. Getting this backwards
 * is easy and silent — a volume chart simply looks wrong in a way nobody
 * attributes to adjustment.
 *
 * ## Where the factor comes from, per action type
 *
 * SPLIT / BONUS carry an exact rational ratio (2, 5, 10, 3/2 …), and the exact
 * value is used — these are clean powers and rounding them would accumulate
 * error across a 30-year series.
 *
 * DEMERGER and other CAPITAL_ADJUSTMENT events have NO clean rational. When a
 * company spins off a subsidiary, the parent's price drops by whatever the
 * market valued the spun-off piece at: RELIANCE's 2006 demerger factor was
 * 0.634, which is not 2/3 or any other tidy fraction. For those, the only
 * honest factor is the one OBSERVED in the price series, carried in
 * `details.observedRatio` by the price-derived detector.
 *
 * ## Idempotence and identity
 *
 * `applyAdjustment` returns the input array UNCHANGED (same reference) when
 * there is nothing to apply, which is the case for ~95% of instruments and
 * makes the whole feature free for them.
 *
 * Applying adjustment twice would divide twice. The type system carries the
 * distinction (`AdjustedBar` is branded) so a double-apply is a compile error
 * rather than a subtly wrong chart.
 */

export interface RawBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

/** A bar that has already been through `applyAdjustment`. */
export type AdjustedBar = RawBar & { readonly __adjusted: true };

/** The subset of a CorporateAction row this module needs. */
export interface AdjustingAction {
  type: string;
  exDate: Date;
  ratio?: number | null;
  source?: string | null;
  details?: unknown;
  /** Who FILED the row — `refuseForeignIssuers` names its issuer. MONEY-1543. */
  symbol?: string;
  exchange?: string;
  isin?: string | null;
}

/** One step of the cumulative factor: applies to bars STRICTLY BEFORE `before`. */
export interface AdjustmentStep {
  before: Date;
  factor: number;
}

/** Action types that change the share count and therefore the price basis. */
export const QTY_CHANGING_TYPES = new Set([
  "SPLIT",
  "BONUS",
  "DEMERGER",
  "CAPITAL_ADJUSTMENT",
]);

/**
 * Higher wins when two rows describe the SAME event. A hand-classified
 * exchange record beats a scraper, which beats something we inferred from the
 * price series ourselves.
 *
 * EXPORTED AND FROZEN — MONEY-1537. `dataform/includes/adjustment.js` carries
 * the SQL mirror (`ACTION_SOURCE_RANK`) that gold breaks same-instant ties
 * with, and the only pin between the two used to be a literal copy in a test:
 * it held the SQL to the copy and let this table drift freely.
 * adjustment-sql-parity.test.ts now holds the two tables EQUAL, both ways.
 */
export const SOURCE_RANK: Readonly<Record<string, number>> = Object.freeze({
  NSE_HIST: 100,
  NSE: 90,
  BSE: 90,
  SCREENER: 50,
  SEED: 40,
  MANUAL: 110,
  DERIVED: 10,
});
/** An absent or unknown source: above DERIVED, below every named feed. */
export const SOURCE_RANK_DEFAULT = 20;
/**
 * The rank of the STRONGEST tag in a `+`-joined source — MONEY-1527 review.
 *
 * `mergeCorporateActions` (`corporate-actions.service.ts`) writes `source` as
 * a sorted `+`-joined UNION when two feeds describe one event: "BSE+NSE",
 * "NSE+SCREENER". A whole-string lookup misses every one of those and falls to
 * the unknown default of 20 — BELOW a bare SCREENER at 50 — so the row with
 * MORE corroboration lost to the one with less. `dedupeActions` uses this as
 * its only tiebreak, so the loser's ratio simply vanished and the chart
 * divided the pre-split history by the wrong multiple.
 *
 * Measured on prod: `NSE+SCREENER` exists (2 rows today). The count is small
 * and the mechanism is not — the merge runs whenever two feeds overlap.
 *
 * MAX, not sum or average: a union of witnesses is at least as good as its
 * best member, and never better than one.
 */
const sourceRank = (s: string | null | undefined): number => {
  if (!s) return SOURCE_RANK_DEFAULT;
  let best: number | undefined;
  for (const tag of s.split("+")) {
    const r = SOURCE_RANK[tag];
    if (r !== undefined && (best === undefined || r > best)) best = r;
  }
  return best ?? SOURCE_RANK_DEFAULT;
};

/** Events within this many days of each other are treated as ONE event. */
export const SAME_EVENT_DAYS = 3;

/**
 * How far a DERIVED row may sit from a feed filing and still describe the same
 * event — MONEY-1541. Wider than `SAME_EVENT_DAYS`, and only for a detector
 * row's EXACT twin.
 *
 * The detector dates a cliff on the first session the EXCHANGE traded after
 * it; a feed dates the ex-date. On an illiquid scrip the two differ by every
 * untraded session plus the weekend. Measured on prod 2026-09-23, every
 * DERIVED row with an equal-ratio feed filing sits within 4.23 days of it or
 * more than 365 days away: VEGA (BSE BONUS 5 ex 2026-04-24, first BSE print
 * 04-28), DOLPHIN 4.23, MOHITE and HAMPS 3.23 — a Friday ex-date with no
 * print until Monday reads 3.23 days, because a feed row is stamped 18:30Z
 * the day before and the detector's 00:00Z. Past 3 days all four applied the
 * event twice (VEGA's pre-bonus history divided by 25.2 where 5 is right).
 *
 * Gold never missed them: it counts SESSIONS between carrier bars, and each
 * pair shares one carrier. A calendar window is the TypeScript's stand-in,
 * because the timeline is built from actions alone. The general chain keeps
 * its 3 days — two FEED filings differ by a date convention, not by trading,
 * and the one equal-factor feed pair beyond 3 days on prod (RANJEET, 19 days)
 * is two filings nobody should merge on proximity.
 */
export const DERIVED_WITNESS_DAYS = 7;

/**
 * The corporate-action rows a listing's CHART is adjusted by, as a Prisma
 * `where` — one query for every origin that serves an India chart. MONEY-1541.
 *
 * NOT scoped to the exchange: a bonus is an act of the COMPANY and the feeds
 * file it per exchange and unevenly (RELIANCE's Oct-2024 bonus arrived from BSE
 * only). Every former symbol and the ISIN are matched too (MONEY-1177). The
 * legacy chart route has always queried this; the tile builder queried
 * `{symbol, exchange}` and so could disagree with it about which splits exist.
 *
 * A symbol is not a company, so this admits another issuer's filings under the
 * same ticker. Call `loadAdjustingActions`, which refuses them (MONEY-1543).
 */
export function adjustingActionsWhere(listing: {
  symbol: string;
  previousSymbols?: readonly string[] | null;
  isin?: string | null;
}): {
  type: { in: string[] };
  OR: ({ symbol: { in: string[] } } | { isin: string })[];
} {
  return {
    type: { in: [...QTY_CHANGING_TYPES] },
    OR: [
      { symbol: { in: [listing.symbol, ...(listing.previousSymbols ?? [])] } },
      ...(listing.isin ? [{ isin: listing.isin }] : []),
    ],
  };
}

/**
 * Every field `AdjustingAction` reads, as a Prisma `select` — MONEY-1541.
 *
 * The tile builder selected `exDate, type, ratio`, so it never saw `details`
 * (the observed gap a CAPITAL_ADJUSTMENT divides by) or `source` (which the
 * DERIVED rules turn on): for the detector cliffs with no feed twin it divided
 * by the SNAPPED ratio, up to 2.97% off the chart. Typed against the interface,
 * so a field added there does not compile here until it is selected.
 */
export const ADJUSTING_ACTION_SELECT = {
  type: true,
  exDate: true,
  ratio: true,
  source: true,
  details: true,
  symbol: true,
  exchange: true,
  isin: true,
} as const satisfies Record<keyof AdjustingAction, true>;

/**
 * The ISSUER half of an ISIN — chars 3-7, the issuer-type letter plus the
 * four-character company code. MONEY-1543.
 *
 * Never the whole ISIN: a face-value split re-issues the SECURITY (INE002A01018
 * becomes a new serial) while the company code stands, and a chart must keep
 * the splits its company lived through under the old serial.
 */
export function isinIssuer(isin: string | null | undefined): string | null {
  return typeof isin === "string" && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)
    ? isin.slice(2, 7)
    : null;
}

/** An instrument that can name the issuer of a row filed under its symbol. */
export interface IssuerCandidate {
  symbol: string;
  exchange: string;
  isin: string | null;
  previousSymbols: readonly string[];
}

export const ISSUER_CANDIDATE_SELECT = {
  symbol: true,
  exchange: true,
  isin: true,
  previousSymbols: true,
} as const satisfies Record<keyof IssuerCandidate, true>;

/**
 * The instruments that traded, or trade, under the symbols of the rows that
 * carry no ISIN of their own — or null when no row needs one. MONEY-1543.
 * Both branches are indexed (`symbol_exchange`, `previousSymbols`).
 */
export function issuerCandidatesWhere(rows: readonly AdjustingAction[]): {
  exchange: { in: string[] };
  OR: [
    { symbol: { in: string[] } },
    { previousSymbols: { hasSome: string[] } },
  ];
} | null {
  const unnamed = rows.filter(
    (r) => isinIssuer(r.isin) === null && r.symbol && r.exchange,
  );
  if (unnamed.length === 0) return null;
  const symbols = [...new Set(unnamed.map((r) => r.symbol!))];
  return {
    exchange: { in: [...new Set(unnamed.map((r) => r.exchange!))] },
    OR: [
      { symbol: { in: symbols } },
      { previousSymbols: { hasSome: symbols } },
    ],
  };
}

/**
 * Drop the rows ANOTHER COMPANY filed — MONEY-1543.
 *
 * `adjustingActionsWhere` matches by symbol across both exchanges, and a
 * ticker is not a company: FOCUS is Focus Lighting on NSE and Focus Business
 * Solution on BSE, so each chart divided its history by the other's bonus or
 * split. A row's issuer is its own ISIN (213 of 5,072 qty-changing rows carry
 * one); otherwise the instrument that trades under the row's (symbol,
 * exchange), together with every instrument that USED to — WORTH on BSE is
 * Worth Investment & Trading, not the NSE WORTH that became WORTHPERI.
 *
 * REFUSED ONLY WHEN BOTH ISSUERS ARE KNOWN AND DIFFER. A listing with no ISIN,
 * a row no instrument names, a candidate with no ISIN, or candidates that
 * disagree (one ticker reused on one exchange — only a DATED symbol history
 * could say which company filed, and the Mongo store has none) are all
 * `unknown`: admitted and counted, so this can never drop an action nobody can
 * attribute. A missed adjustment is a visible cliff; a foreign one is a wrong
 * chart that looks right.
 *
 * Measured on prod 2026-09-23 over all 23,912 active NSE/BSE listings: 7,428
 * admitted rows, 7,399 same issuer, 8 foreign, 21 unknown. The 8 are FOCUS
 * (NSE and BSE), WORTHPERI:NSE via WORTH, ZEAL:NSE and RAJPUTANA:NSE.
 */
export function refuseForeignIssuers<T extends AdjustingAction>(
  listingIsin: string | null | undefined,
  rows: readonly T[],
  candidates: readonly IssuerCandidate[],
): { actions: T[]; refused: T[]; unknownIssuer: number } {
  const mine = isinIssuer(listingIsin);
  if (mine === null) {
    return { actions: [...rows], refused: [], unknownIssuer: rows.length };
  }
  const actions: T[] = [];
  const refused: T[] = [];
  let unknownIssuer = 0;
  for (const r of rows) {
    const theirs = rowIssuer(r, candidates);
    if (theirs === null) unknownIssuer++;
    if (theirs !== null && theirs !== mine) refused.push(r);
    else actions.push(r);
  }
  return { actions, refused, unknownIssuer };
}

function rowIssuer(
  r: AdjustingAction,
  candidates: readonly IssuerCandidate[],
): string | null {
  const own = isinIssuer(r.isin);
  if (own !== null) return own;
  const named = new Set(
    candidates
      .filter(
        (c) =>
          c.exchange === r.exchange &&
          (c.symbol === r.symbol || c.previousSymbols.includes(r.symbol!)),
      )
      .map((c) => isinIssuer(c.isin)),
  );
  return named.size === 1 ? [...named][0]! : null;
}

/** A row as `loadAdjustingActions` returns it. */
export type LoadedAdjustingAction = AdjustingAction & {
  symbol: string;
  exchange: string;
  isin: string | null;
  updatedAt: Date;
};

const LOADED_ACTION_SELECT = {
  ...ADJUSTING_ACTION_SELECT,
  updatedAt: true,
} as const;

/** The two Prisma delegates the loader reads, typed structurally. */
export interface AdjustingActionDb {
  corporateAction: {
    findMany(args: {
      where: ReturnType<typeof adjustingActionsWhere>;
      select: typeof LOADED_ACTION_SELECT;
      orderBy: { exDate: "asc" };
    }): Promise<LoadedAdjustingAction[]>;
  };
  instrumentMapping: {
    findMany(args: {
      where: NonNullable<ReturnType<typeof issuerCandidatesWhere>>;
      select: typeof ISSUER_CANDIDATE_SELECT;
    }): Promise<IssuerCandidate[]>;
  };
}

/**
 * A listing's adjusting actions, another company's refused — the ONE loader
 * the chart and the tile builder both call, so their scope cannot drift again.
 * MONEY-1541 (the query), MONEY-1543 (the issuer).
 */
export async function loadAdjustingActions(
  db: AdjustingActionDb,
  listing: Parameters<typeof adjustingActionsWhere>[0],
): Promise<{
  actions: LoadedAdjustingAction[];
  refused: LoadedAdjustingAction[];
  unknownIssuer: number;
}> {
  const rows = await db.corporateAction.findMany({
    where: adjustingActionsWhere(listing),
    select: LOADED_ACTION_SELECT,
    orderBy: { exDate: "asc" },
  });
  const where = isinIssuer(listing.isin) ? issuerCandidatesWhere(rows) : null;
  const candidates = where
    ? await db.instrumentMapping.findMany({
        where,
        select: ISSUER_CANDIDATE_SELECT,
      })
    : [];
  return refuseForeignIssuers(listing.isin, rows, candidates);
}

const dayMs = 86_400_000;

/**
 * The factor an action contributes, or null if it cannot be trusted.
 *
 * A demerger's `ratio` (if any) describes share entitlement, not the price
 * gap, so the OBSERVED ratio is preferred whenever the detector supplied one.
 */
export function actionFactor(action: AdjustingAction): number | null {
  const observed = (action.details as { observedRatio?: unknown } | null)
    ?.observedRatio;
  const candidates: unknown[] =
    action.type === "SPLIT" || action.type === "BONUS"
      ? [action.ratio, observed]
      : [observed, action.ratio];

  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c);
    // A ratio of 0, negative, non-finite or exactly 1 contributes nothing and
    // would either destroy the series or silently no-op. Skip and let the
    // caller count it.
    if (Number.isFinite(n) && n > 0 && n !== 1) return n;
  }
  return null;
}

/**
 * Collapse rows that describe one event, keeping the highest-authority record.
 *
 * Necessary because the same split legitimately arrives from NSE, BSE and the
 * price-derived detector, sometimes typed differently and dated a day or two
 * apart. Applying all three would divide the history by the cube of the ratio.
 *
 * ## TWO WAYS ONE EVENT GOT APPLIED TWICE — MONEY-1537, measured on prod
 *
 * Both were live on the chart path (`getSymbolAdjustment`, verified against
 * prod `corporate_actions` 2026-09-23 over all 3,030 NSE/BSE series with a
 * qty-changing action):
 *
 * 1. THE DETECTOR'S TWIN WAS MATCHED ON ITS OBSERVED GAP. `actionFactor` hands
 *    a CAPITAL_ADJUSTMENT its observed gap, which also carries the ex-session's
 *    own market move, so a DERIVED row and the feed filing of the same event
 *    differ by that move while their FILED ratios are equal. Past the 2% of
 *    `nearlyEqual` they stopped being one event: 15 series divided their
 *    pre-event history twice. SBIN (NSE + BSE) by 97.96 where 10 is right;
 *    GANGAFORGE 97.51 for 10; SHIVAMAUTO 51.39 for 10; MOTHERSON, ALKYLAMINE,
 *    TCS, INFY and AVTNPL about 2x. Gold never had this — its `suppressed`
 *    CTE matches the twin on the filed ratio — so `derivedOverlaps` is that
 *    rule: an EXISTS over every non-DERIVED row, never the observed gap.
 *
 *    NOT "a DERIVED row near any feed row". Three prod cliffs (MAHSEAMLES,
 *    AIAENG, JINDRILL) sit beside a feed SPLIT whose ratio is NULL — the
 *    detector's row is the ONLY usable witness there, and matching on type
 *    plus proximity would erase a real 2x-5x cliff.
 *
 * 2. A ROW WITH NO FACTOR SHIELDED A DUPLICATE. The chain compared each row
 *    with the LAST KEPT one, and a row `actionFactor` cannot price still
 *    occupied that slot. AHLEAST 2022 files BONUS 1.5 on NSE and BSE beside a
 *    NULL-ratio DEMERGER on each, all at one instant; in the order the store
 *    returned them the DEMERGER sat between the bonuses and 1.5 was applied
 *    twice. The same slot is why matching twins on the filed ratio inside the
 *    chain would still miss SBIN, whose NSE SPLIT has no ratio.
 *
 *    MONEY-1541 generalised the fix: a row is compared with EVERY kept row in
 *    reach (`filingOf`), not with one slot, so no row between two filings can
 *    shield either. Two filings of one unpriceable event still collapse into
 *    one `ignored` action, of any type, exactly as before — letting them both
 *    through moved the `ignored` count on 324 prod series whose prices did not
 *    change at all, and this moves it on none.
 */
export function dedupeActions(
  actions: readonly AdjustingAction[],
): AdjustingAction[] {
  const dated = actions.filter(
    (a) => a.exDate instanceof Date && !Number.isNaN(a.exDate.getTime()),
  );
  const redundant = derivedOverlaps(dated);
  const sorted = dated
    .filter((a) => !redundant.has(a))
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());

  const out: AdjustingAction[] = [];
  for (const a of sorted) {
    const factor = actionFactor(a);
    const at = filingOf(out, a, factor);
    const prev = at < 0 ? undefined : out[at];
    const sameEvent =
      prev !== undefined &&
      Math.abs(a.exDate.getTime() - prev.exDate.getTime()) <=
        SAME_EVENT_DAYS * dayMs &&
      // Two DIFFERENT splits three days apart are vanishingly rare; two
      // records of ONE split are common. Treat them as the same event only
      // when the factors agree too, so a genuine pair is never collapsed.
      nearlyEqual(factor, actionFactor(prev));
    if (!sameEvent) {
      out.push(a);
      continue;
    }
    if (sourceRank(a.source) > sourceRank(prev.source)) {
      out[at] = a;
    }
  }
  return out;
}

/**
 * The kept row `a` is another FILING of, or -1 — MONEY-1541.
 *
 * ANY kept row, not the last one. One event filed by both exchanges as BONUS
 * plus SPLIT is four rows at one instant, and the store returns ties in no
 * promised order: comparing with the last kept row collapsed one exchange's
 * SPLIT into the other's only when nothing sat between them. Measured over all
 * 3,030 prod chart series on 2026-09-23: 74 changed factor when their own rows
 * were reshuffled, and in the order prod's query returns them today BAJFINANCE
 * divides its pre-June-2025 history by 100 against a raw cliff of 9.95 (TITAN
 * 2011 happens to come back adjacent and reads 20; in insertion order, 200).
 * Now none depend on the order.
 *
 * The SAME TYPE, as gold's near-duplicate rule requires. A bonus and a split on
 * one ex-date are two share-count changes even when both are 2: ONGC 2011 files
 * BONUS 2 and SPLIT 2, NSE's own print falls 4.24x, and the chart divided by 2.
 * A DERIVED row never reaches this with a feed twin — `derivedOverlaps`
 * settled those on the filed ratio first. A row with NO factor matches a kept
 * row with none of any type, as it always did; only the `ignored` count rides
 * on it.
 */
function filingOf(
  out: readonly AdjustingAction[],
  a: AdjustingAction,
  factor: number | null,
): number {
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i]!;
    if (
      (factor === null || p.type === a.type) &&
      Math.abs(a.exDate.getTime() - p.exDate.getTime()) <=
        SAME_EVENT_DAYS * dayMs &&
      nearlyEqual(factor, actionFactor(p))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Rows a DERIVED detection makes redundant — gold's `suppressed` branches (1),
 * (3) and (4), in TypeScript. MONEY-1537, MONEY-1541.
 *
 * The detector MEASURES a whole cliff; a feed FILES what it was told. When
 * both describe one event, applying both multiplies the event by itself, so
 * one side goes. Which side is decided on the FILED ratios — the detector's is
 * the ratio it SNAPPED the cliff to, which is why a twin equals its feed filing
 * exactly (33 of 33 on prod) — compared at silver's NUMERIC(18,6) scale, as
 * gold compares them. With P the product of the feed's DISTINCT
 * (type, filed ratio) events within `SAME_EVENT_DAYS`, and D the detector's
 * filed ratio:
 *
 *   TWIN       a feed row files D itself, within    -> drop the detector row
 *              `DERIVED_WITNESS_DAYS`
 *   COMPOSED   P == D                               -> drop the detector row
 *   PARTIAL    1 < P < D                            -> drop the feed rows
 *   otherwise  (no priced feed row, or P > D)       -> both stay, as before
 *
 * COMPOSED is SUDARSCHEM 2014: BSE files BONUS 2 and SPLIT 5 (NSE the SPLIT
 * alone), the detector saw 10.29 and snapped 10, and the chart divided the
 * pre-2014-09-30 history by 102.88. NSE + BSE filing one SPLIT 5 is one event,
 * hence DISTINCT events rather than rows.
 *
 * PARTIAL is TORNTPHARM 2006 and HIMATSEIDE 2005: BSE files BONUS 2, and
 * NSE's own prints fall 975.30 -> 239.80 and 535.10 -> 133.90 on that day
 * (4.07x and 4.00x) with the series flat on both sides. The chart applied both
 * and drew a 2x JUMP UP at the ex-date. The rule is NOT a guess about what the
 * feed left out. For 1 < P < D the truth is either D (the feed recorded part of
 * the event) or P (the stock also fell D/P that day); applying both is wrong by
 * P or by D, applying D by 1 or by D/P, so D is never further from the truth
 * than today. P > D has no such bound — a wrong filing and a cliff disagree,
 * and neither can be preferred — so it is left, and prod holds none. Gold
 * reaches SUDARSCHEM:NSE through this branch: its listing carries NSE's SPLIT 5
 * alone, whose own description reads "Bonus 1 : 1 / Face Value Split From
 * Rs 10/- To Rs 2/-".
 *
 * NOT "a DERIVED row near any feed row": MAHSEAMLES, AIAENG and JINDRILL sit
 * beside a feed SPLIT with NO ratio. There is no P, the detector is the only
 * witness, and it applies.
 *
 * Measured on prod 2026-09-23 over all 156 DERIVED rows (chart scope): 37
 * twins (33 within 3 days, VEGA/DOLPHIN/MOHITE/HAMPS within 4.23), SUDARSCHEM
 * composed, TORNTPHARM and HIMATSEIDE partial, the three ratio-less neighbours
 * above, and 113 with no feed filing in reach. It moves 12 of 3,030 chart
 * series, every one toward its own raw cliff: SUDARSCHEM 102.88 -> 10, VEGA
 * 25.20 -> 5, MOHITE 102.00 -> 10, DOLPHIN 98.03 -> 10, HAMPS 4.08 -> 2,
 * TORNTPHARM 32.54 -> 16.27 (4.07 x its two later bonuses), HIMATSEIDE
 * 7.99 -> 4.00.
 */
function derivedOverlaps(
  all: readonly AdjustingAction[],
): Set<AdjustingAction> {
  const redundant = new Set<AdjustingAction>();
  for (const d of all) {
    const detected = d.source === "DERIVED" ? filedRatio(d) : null;
    if (detected === null) continue;
    const feed = all.filter(
      (f) =>
        f.source !== "DERIVED" &&
        filedRatio(f) !== null &&
        Math.abs(f.exDate.getTime() - d.exDate.getTime()) <=
          DERIVED_WITNESS_DAYS * dayMs,
    );
    if (feed.length === 0) continue;
    if (feed.some((f) => filedRatio(f) === detected)) {
      redundant.add(d);
      continue;
    }
    // COMPOSED and PARTIAL reach only SAME_EVENT_DAYS. The trailing window is
    // for an EXACT twin, whose ratio identifies the event; a product of
    // whatever was filed that week has no such identity, and a feed bonus on
    // Monday beside a detected split on Friday would read as PARTIAL and drop
    // the bonus. Every composed and partial row on prod is same-day.
    const near = feed.filter(
      (f) =>
        Math.abs(f.exDate.getTime() - d.exDate.getTime()) <=
        SAME_EVENT_DAYS * dayMs,
    );
    if (near.length === 0) continue;
    const events = new Map(
      near.map((f) => [`${f.type}:${filedRatio(f)}`, f.ratio as number]),
    );
    const product = [...events.values()].reduce((p, r) => p * r, 1);
    const composed = Number(product.toFixed(6));
    if (composed === Number(detected)) redundant.add(d);
    else if (composed > 1 && composed < Number(detected)) {
      for (const f of near) redundant.add(f);
    }
  }
  return redundant;
}

/** The ratio as FILED — the event's identity, never the observed gap. */
function filedRatio(a: AdjustingAction): string | null {
  return typeof a.ratio === "number" && Number.isFinite(a.ratio) && a.ratio > 0
    ? a.ratio.toFixed(6)
    : null;
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) / Math.max(a, b) < 0.02;
}

/**
 * Build the cumulative-factor timeline, oldest step first.
 *
 * Each step says: bars dated strictly before `before` must be divided by
 * `factor`. Only qty-changing actions with a usable factor take part.
 */
export function buildAdjustmentTimeline(actions: readonly AdjustingAction[]): {
  steps: AdjustmentStep[];
  used: number;
  ignored: number;
} {
  const relevant = dedupeActions(
    actions.filter((a) => QTY_CHANGING_TYPES.has(a.type)),
  );

  const withFactors: Array<{ exDate: Date; factor: number }> = [];
  let ignored = 0;
  for (const a of relevant) {
    const f = actionFactor(a);
    if (f === null) {
      ignored++;
      continue;
    }
    withFactors.push({ exDate: a.exDate, factor: f });
  }

  // Suffix products: a bar before action i is affected by i and everything
  // after it.
  const steps: AdjustmentStep[] = [];
  let running = 1;
  for (let i = withFactors.length - 1; i >= 0; i--) {
    running *= withFactors[i]!.factor;
    steps.unshift({ before: withFactors[i]!.exDate, factor: running });
  }

  return { steps, used: withFactors.length, ignored };
}

/** The cumulative factor for a single date. Linear scan; fine for a few steps. */
export function factorForDate(
  steps: readonly AdjustmentStep[],
  date: Date,
): number {
  const t = date.getTime();
  for (const s of steps) {
    if (t < s.before.getTime()) return s.factor;
  }
  return 1;
}

/**
 * Divide prices (and multiply volume) by the cumulative factor.
 *
 * Returns the SAME ARRAY REFERENCE when there is nothing to do, so the ~95% of
 * instruments with no corporate actions pay nothing. Bars are assumed sorted
 * ascending by date, which every caller already guarantees.
 */
export function applyAdjustment<T extends RawBar>(
  bars: readonly T[],
  steps: readonly AdjustmentStep[],
): readonly T[] {
  if (steps.length === 0 || bars.length === 0) return bars;

  return bars.map((bar) => {
    const f = factorForDate(steps, bar.date);
    if (f === 1) return bar;
    return {
      ...bar,
      open: bar.open / f,
      high: bar.high / f,
      low: bar.low / f,
      close: bar.close / f,
      // Opposite direction on purpose: the same turnover spread over R times
      // as many shares.
      volume: Math.round(bar.volume * f),
      adjClose: bar.adjClose === undefined ? undefined : bar.adjClose / f,
    };
  });
}
