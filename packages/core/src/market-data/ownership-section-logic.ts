/**
 * Ownership sections for the stock page — MONEY-1204 (P14 / 14c.4, 14c.5, 14c.6).
 *
 * Pure shaping for three panels that all answer "who owns this, and who has
 * been moving": the quarterly shareholding pattern, insider/promoter activity,
 * and disclosed bulk/block deals. No Prisma, no network, no clock of its own —
 * every window is measured against a `now` the caller passes, so the tests pin
 * boundaries instead of racing them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## The one rule the whole file is built around: null is not zero
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `-`, `""` and a missing column all mean NOT REPORTED. `Number("")` is `0`, and
 * that single coercion is how an undisclosed promoter pledge becomes a
 * fabricated all-clear on screen. A stored `0` means a filer reported zero, and
 * those two must never render the same. So:
 *
 *   - every percentage, quantity and rupee value in here is `number | null`;
 *   - `readOwnershipPct` / `finiteOrNull` return null rather than 0 for blanks,
 *     sentinels and non-finite values;
 *   - a QoQ delta across a missing quarter is null, NOT the delta to the quarter
 *     before it (see `computeQoqDeltas`);
 *   - a net that had nothing disclosed to add up is null, not 0
 *     (`netInsiderActivity`), and the count of undisclosed filings travels with
 *     it so the UI can say what was excluded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 14c.4 — two shareholding tables that disagree
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ShareholdingPattern` (NSE, `shareholding_patterns`) and `StockShareholding`
 * (Tickertape, `stock_shareholding`) both describe the same quarters and do NOT
 * join: NSE's `quarter` is canonical `YYYY-MM` of the quarter END, Tickertape's
 * is free-form (`"Q3-2024"`). Merging them per-quarter would mean matching one
 * vendor's idea of a period against another's — silently mixing two providers
 * inside one series, which is exactly the thing the provenance envelope exists
 * to prevent.
 *
 * So the rule is PRECEDENCE, not merge: NSE wins whole, Tickertape serves only
 * when NSE has nothing, and the chosen source is labelled either way. A fallback
 * the user cannot see is a silent downgrade.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Absence primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Values that a feed uses to say "nothing here". Upper-cased before lookup.
 * `"NULL"` is included because a CSV that literally carries the four letters is
 * never reporting a real remark — but note `"0"` is deliberately absent.
 */
const BLANK_SENTINELS: ReadonlySet<string> = new Set([
  "",
  "-",
  "--",
  "–",
  "—",
  "NA",
  "N/A",
  "N.A.",
  "NIL",
  "NULL",
  "UNDEFINED",
]);

function isBlankText(raw: string): boolean {
  return BLANK_SENTINELS.has(raw.trim().replace(/\s+/g, " ").toUpperCase());
}

/** Finite number or null. Never 0 for a blank. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value !== "string") return null;
  if (isBlankText(value)) return null;
  // Strip thousands separators and a stray percent sign; anything else that is
  // still not a number falls through to null rather than to 0.
  const cleaned = value.replace(/[,\s%]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read an ownership percentage.
 *
 * Exported because it is the null-vs-zero rule itself, and the rule is worth a
 * direct test rather than only an indirect one through a builder.
 */
export function readOwnershipPct(value: unknown): number | null {
  return finiteOrNull(value);
}

/**
 * Free text that a feed may have left blank. `remarks` is null on `-` AND when
 * `block.csv` omits the column entirely; both must come out as null so the UI
 * never prints the word "null" or a lone dash where a sentence belongs.
 */
export function dealTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s+/g, " ");
  return isBlankText(s) ? null : s;
}

/** Kill float artefacts (0.30000000000000004) without pretending to precision. */
function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-07` — UTC, because every date this file sees is UTC midnight of an IST day. */
function monthKeyOfDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabelOfKey(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const idx = Number(m[2]) - 1;
  const name = MONTH_NAMES[idx];
  return name ? `${name} ${m[1]}` : key;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.4 — Shareholding pattern (NSE primary, Tickertape fallback)
// ═══════════════════════════════════════════════════════════════════════════

export type ShareholdingSource = "NSE_SHP" | "BSE_SHP" | "TICKERTAPE";

/**
 * The section's preferred EXCHANGE filing. NSE and BSE each publish their own;
 * `SHAREHOLDING_EXCHANGE_AUTHORITY` decides which wins a quarter both filed.
 *
 * This is the DEFAULT for a row that names neither a source nor an exchange —
 * it is the schema's own two defaults restated (`exchange @default("NSE")`,
 * `source @default("NSE_SHP")`), not a guess. It is NOT the section's answer:
 * `buildShareholdingSection` returns the source of the row that actually WON,
 * because a BSE-only company served entirely from BSE filings used to render
 * the chip "NSE shareholding" (MONEY-1255).
 */
export const SHAREHOLDING_PRIMARY_SOURCE: ShareholdingSource = "NSE_SHP";
/** Served only when NO exchange has a row for the symbol — always labelled. */
export const SHAREHOLDING_FALLBACK_SOURCE: ShareholdingSource = "TICKERTAPE";

/**
 * Filing exchange → the `source` code its row is stored under.
 *
 * Both writers stamp these explicitly (`ownership-sync.ts` writes `"NSE_SHP"`
 * on the NSE leg and `"BSE_SHP"` on the BSE leg), so this map is the FALLBACK
 * for a reader whose `select` omitted the column — never the primary answer.
 */
export const EXCHANGE_SHAREHOLDING_SOURCE: Readonly<
  Record<string, ShareholdingSource>
> = {
  NSE: "NSE_SHP",
  BSE: "BSE_SHP",
};

/**
 * Which filing a `shareholding_patterns` row came from.
 *
 * Order matters and each rung is a different kind of evidence:
 *
 *   1. the row's own `source` column — what the writer recorded;
 *   2. its `exchange` column — what the writer keyed it under;
 *   3. `SHAREHOLDING_PRIMARY_SOURCE`, but ONLY when the row names neither.
 *      That is the schema's declared default for both columns, so it is a
 *      restatement rather than an assumption.
 *
 * A row that DOES name an exchange we have no code for returns null. Saying
 * "we do not know" costs an em dash in the chip; saying "NSE" costs the
 * reader a false provenance claim, which is the whole defect being fixed.
 */
export function shareholdingRowSource(row: {
  source?: string | null;
  exchange?: string | null;
}): ShareholdingSource | null {
  const stored =
    typeof row.source === "string" ? row.source.trim().toUpperCase() : "";
  if (stored === "NSE_SHP" || stored === "BSE_SHP") return stored;

  const exchange =
    typeof row.exchange === "string" ? row.exchange.trim().toUpperCase() : "";
  if (exchange === "" && stored === "") return SHAREHOLDING_PRIMARY_SOURCE;
  return EXCHANGE_SHAREHOLDING_SOURCE[exchange] ?? null;
}

/** A `shareholding_patterns` row (NSE). Percentages nullable by design. */
export interface NseShareholdingRow {
  /** Canonical `YYYY-MM` of the quarter END when parseable, else verbatim. */
  quarter: string;
  /** Filing exchange. Part of the row's unique key since MONEY-1207, so a
   *  reader that omits it gets the same quarter back once per exchange. */
  exchange?: string | null;
  /**
   * The stored `source` code — `"NSE_SHP"` or `"BSE_SHP"`.
   *
   * Optional in the TYPE and mandatory in practice: a reader that leaves it out
   * of its `select` falls back to `exchange`, and a reader that leaves BOTH out
   * gets the schema default. That is a silent downgrade of the provenance chip,
   * which is exactly what {@link shareholdingRowSource} documents — so the
   * service test asserts the column is selected rather than trusting this
   * comment.
   */
  source?: string | null;
  promoterPct?: number | null;
  pledgedPct?: number | null;
  fiiPct?: number | null;
  diiPct?: number | null;
  publicPct?: number | null;
}

/** A `stock_shareholding` row (Tickertape). Bare field names, free-form quarter. */
export interface TickertapeShareholdingRow {
  /** Free-form, e.g. `"Q3-2024"`. Does NOT join to the NSE key. */
  quarter: string;
  promoter?: number | null;
  fii?: number | null;
  dii?: number | null;
  public?: number | null;
  pledgedPercent?: number | null;
  fetchedAt?: Date | string | null;
}

/** One quarter of the chosen series, before deltas are attached. */
export interface ShareholdingObservation {
  quarter: string;
  label: string;
  /**
   * Which filing THIS quarter's numbers came from.
   *
   * Per-quarter and not per-section, because the series can legitimately mix:
   * a dual-listed name whose BSE filing is the newest, with an older quarter
   * only NSE published, is one series drawn from two exchanges. The section's
   * chip names the NEWEST row's source and `ShareholdingSection.sources` lists
   * the whole set, so a mixed series can say so instead of picking one and
   * implying the rest.
   */
  source: ShareholdingSource | null;
  promoterPct: number | null;
  pledgedPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  publicPct: number | null;
}

export interface ShareholdingDeltas {
  promoterPct: number | null;
  pledgedPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  publicPct: number | null;
}

export interface ShareholdingQuarter extends ShareholdingObservation {
  /** Change vs the immediately older quarter IN THIS SERIES. Null-propagating. */
  deltas: ShareholdingDeltas;
}

export interface PledgePoint {
  quarter: string;
  label: string;
  /** Null is a GAP, not a zero pledge. */
  pledgedPct: number | null;
}

export interface ShareholdingSection {
  /**
   * The NEWEST rendered quarter's source — the row that actually won, never a
   * constant.
   *
   * It is stamped from the same row `asOf` is derived from, which is the rule
   * `getStockInsiderSection` already follows: a chip that names one provider
   * while the date beside it belongs to another is two facts pretending to be
   * one. Null only when nothing usable was found (or when the winning row
   * names an exchange we have no code for).
   */
  source: ShareholdingSource | null;
  /**
   * Every distinct source across the RENDERED quarters, newest-first order.
   *
   * One element is the ordinary case. Two means the series is drawn from both
   * exchanges' filings, which is real for a dual-listed name that missed a
   * quarter on one of them — and the chip alone cannot say so.
   */
  sources: ShareholdingSource[];
  /**
   * True ONLY on the third-party fallback path. A BSE filing is not a fallback:
   * it is an exchange's own disclosure, ranked below NSE by
   * `SHAREHOLDING_EXCHANGE_AUTHORITY` for a quarter they BOTH filed, and
   * authoritative for one only it filed.
   */
  fallback: boolean;
  /** Newest quarter first. */
  quarters: ShareholdingQuarter[];
  /** Oldest first (chart order); nulls preserved as gaps. */
  pledgeTrend: PledgePoint[];
}

/**
 * Comparable rank for a quarter label, in months since year 0.
 *
 * Handles, in order: canonical `YYYY-MM` (NSE), `Q<n>-YYYY` / `YYYY-Q<n>`
 * (Tickertape and screener spellings), and `<Mon> YYYY`. Returns null when the
 * label carries no recoverable period, so the caller can fall back to the input
 * order instead of sorting garbage to the top.
 *
 * The existing `sortQuartersNewestFirst` in `apps/web/lib/actions/stock-tabs.ts`
 * CANNOT be reused here: it ranks as `year * 10 + quarter`, and for a canonical
 * `2026-03` it finds no `Q<n>` and no month NAME, so it scores 20260 — the same
 * as `2026-06`, `2026-09` and `2026-12`. Every NSE quarter of a year would tie
 * and fall back to insertion order. Quarter parsing has to see `YYYY-MM` first,
 * which is why this is a separate function rather than an import.
 *
 * Q<n> maps to the quarter's END month (Q1 → 3) so a `Q1-2024`-style series and
 * a `2024-03`-style series rank on the same scale. That is a convenience for
 * tests and debugging only — the two series are never merged.
 */
export function quarterSortRank(quarter: string): number | null {
  const q = quarter.trim().toUpperCase();
  if (q === "") return null;

  const canonical = /^(\d{4})-(\d{1,2})$/.exec(q);
  if (canonical) {
    const y = Number(canonical[1]);
    const m = Number(canonical[2]);
    if (m >= 1 && m <= 12) return y * 12 + m;
  }

  const qFirst = /^Q([1-4])[\s\-/]?(?:FY)?(\d{4})$/.exec(q);
  if (qFirst) return Number(qFirst[2]) * 12 + Number(qFirst[1]) * 3;

  const yFirst = /^(\d{4})[\s\-/]?Q([1-4])$/.exec(q);
  if (yFirst) return Number(yFirst[1]) * 12 + Number(yFirst[2]) * 3;

  const named = /^([A-Z]{3})[A-Z]*[\s\-/]?(\d{4})$/.exec(q);
  if (named) {
    const idx = MONTH_NAMES.findIndex(
      (m) => m.toUpperCase() === (named[1] as string),
    );
    if (idx >= 0) return Number(named[2]) * 12 + idx + 1;
  }

  return null;
}

/**
 * UTC end-of-day of the quarter a label names, or null when it names none.
 *
 * This is what the section's `asOf` is built from. It is derived from the SAME
 * parse as `quarterSortRank`, so a label that sorts must also date — the
 * alternative (stamping `asOf` from `fetchedAt`) would report when WE last
 * copied the row, which is precisely the lie the provenance envelope documents
 * `asOf` as existing to prevent.
 */
export function quarterEndDate(quarter: string): Date | null {
  const rank = quarterSortRank(quarter);
  if (rank === null) return null;
  const year = Math.floor((rank - 1) / 12);
  const month = rank - year * 12; // 1..12
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(year, month, 0, 0, 0, 0, 0));
}

/** `"2026-03"` → `"Mar 2026"`. Anything unparseable renders verbatim. */
export function shareholdingQuarterLabel(quarter: string): string {
  const canonical = /^(\d{4})-(\d{1,2})$/.exec(quarter.trim());
  if (canonical) {
    const idx = Number(canonical[2]) - 1;
    const name = MONTH_NAMES[idx];
    if (name) return `${name} ${canonical[1]}`;
  }
  return quarter.trim();
}

function hasAnyPct(o: ShareholdingObservation): boolean {
  return (
    o.promoterPct !== null ||
    o.pledgedPct !== null ||
    o.fiiPct !== null ||
    o.diiPct !== null ||
    o.publicPct !== null
  );
}

/**
 * Declared authority when the SAME quarter exists on more than one exchange.
 *
 * NSE first because its filing is the one every other reader in this repo has
 * historically shown, so preferring it keeps already-rendered numbers stable;
 * an unlisted exchange sorts last rather than being dropped.
 */
export const SHAREHOLDING_EXCHANGE_AUTHORITY: readonly string[] = [
  "NSE",
  "BSE",
];

/** A row carrying the exchange it was filed on. */
export interface ExchangeScopedQuarter {
  quarter: string;
  exchange?: string | null;
}

/**
 * ONE row per quarter, chosen by declared authority.
 *
 * `shareholding_patterns` is unique on `(symbol, exchange, quarter)` —
 * `exchange` joined the key in MONEY-1207 so the BSE provider could not upsert
 * over NSE's row. The consequence every READER has to handle is the other half
 * of that trade: for the 2,465 symbols listed on both, a quarter both exchanges
 * have filed exists TWICE, with independently-reported percentages.
 *
 * Left undeduped it does not read as "two rows" anywhere it matters — it reads
 * as a WRONG ANSWER in the shape of a right one:
 *
 *   - the section table renders `2026-06` twice (React duplicate-key warning);
 *   - `applyShareholdingValues` takes rows[0] as the level and rows[1] as the
 *     PRIOR quarter, so latest and previous are the same period and every QoQ
 *     delta is exactly 0 — a fabricated "no movement" that screener filters
 *     then match on;
 *   - any `take` window holds half the distinct quarters it was sized for.
 *
 * Merging the two filings field-by-field is deliberately NOT done: it would
 * synthesise a quarter no exchange actually published. One filing is picked and
 * the rest of that quarter is discarded, which is the same "pick one and say
 * which" rule `buildShareholdingSection` already applies to NSE-vs-Tickertape.
 *
 * Input order is otherwise preserved — callers own the sort.
 */
export function dedupeShareholdingByQuarter<T extends ExchangeScopedQuarter>(
  rows: ReadonlyArray<T>,
  preferExchange?: string | null,
): T[] {
  const preferred =
    typeof preferExchange === "string" && preferExchange.trim() !== ""
      ? preferExchange.trim().toUpperCase()
      : null;

  // Lower rank wins. The caller's own exchange outranks the standing order, so
  // a BSE page shows BSE's filing where one exists.
  const rank = (exchange?: string | null): number => {
    const ex =
      typeof exchange === "string" ? exchange.trim().toUpperCase() : "";
    if (preferred !== null && ex === preferred) return -1;
    const i = SHAREHOLDING_EXCHANGE_AUTHORITY.indexOf(ex);
    return i === -1 ? SHAREHOLDING_EXCHANGE_AUTHORITY.length : i;
  };

  const bestFor = new Map<string, { row: T; rank: number; at: number }>();
  const order: string[] = [];

  rows.forEach((row, at) => {
    if (typeof row?.quarter !== "string") return;
    const key = row.quarter.trim();
    if (key === "") return;

    const candidate = { row, rank: rank(row.exchange), at };
    const held = bestFor.get(key);
    if (held === undefined) {
      bestFor.set(key, candidate);
      order.push(key);
      return;
    }
    // Strictly-better only, so ties keep the earlier row and the whole function
    // stays a stable pick rather than a last-writer-wins one.
    if (candidate.rank < held.rank) bestFor.set(key, candidate);
  });

  return order.map((key) => bestFor.get(key)!.row);
}

/** `shareholding_patterns` rows → the common observation shape. */
export function normalizeNseShareholding(
  rows: ReadonlyArray<NseShareholdingRow>,
): ShareholdingObservation[] {
  return rows
    .filter((r) => typeof r.quarter === "string" && r.quarter.trim() !== "")
    .map((r) => ({
      quarter: r.quarter.trim(),
      label: shareholdingQuarterLabel(r.quarter),
      source: shareholdingRowSource(r),
      promoterPct: readOwnershipPct(r.promoterPct),
      pledgedPct: readOwnershipPct(r.pledgedPct),
      fiiPct: readOwnershipPct(r.fiiPct),
      diiPct: readOwnershipPct(r.diiPct),
      publicPct: readOwnershipPct(r.publicPct),
    }));
}

/** `stock_shareholding` rows → the common observation shape (bare → *Pct names). */
export function normalizeTickertapeShareholding(
  rows: ReadonlyArray<TickertapeShareholdingRow>,
): ShareholdingObservation[] {
  return rows
    .filter((r) => typeof r.quarter === "string" && r.quarter.trim() !== "")
    .map((r) => ({
      quarter: r.quarter.trim(),
      label: shareholdingQuarterLabel(r.quarter),
      source: SHAREHOLDING_FALLBACK_SOURCE,
      promoterPct: readOwnershipPct(r.promoter),
      pledgedPct: readOwnershipPct(r.pledgedPercent),
      fiiPct: readOwnershipPct(r.fii),
      diiPct: readOwnershipPct(r.dii),
      publicPct: readOwnershipPct(r.public),
    }));
}

/** Newest first. Unrankable labels keep their input order, at the end. */
export function sortShareholdingNewestFirst(
  rows: ReadonlyArray<ShareholdingObservation>,
): ShareholdingObservation[] {
  // One implementation, two callers — the breakdown card sorts the same free-
  // text `quarter` column by the same rules, and two copies of a comparator
  // this subtle is how the two series start disagreeing about which quarter is
  // newest.
  return sortByQuarterNewestFirst(rows);
}

function deltaOf(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null) return null;
  return roundTo(cur - prev, 4);
}

/** Months between two quarter labels, or null when either cannot be ranked. */
function quarterGapMonths(cur: string, prev: string): number | null {
  const a = quarterSortRank(cur);
  const b = quarterSortRank(prev);
  if (a === null || b === null) return null;
  return a - b;
}

/**
 * Attach the quarter-on-quarter change to a NEWEST-FIRST series.
 *
 * The comparison is against the immediately older element AND ONLY IF that
 * element is the immediately preceding QUARTER. Two different absences break a
 * QoQ delta and both have shipped as wrong numbers here:
 *
 *   1. the previous row reported no value for that field  ⇒ null;
 *   2. the previous quarter has no row at all  ⇒ null.
 *
 * (2) is the one positional `[i+1]` cannot see. A series of [Jun-26, Sep-25]
 * arrives whenever a filing is missed or the read was starved, and subtracting
 * positionally labels a nine-month move "this quarter". On `pledgedPct` that is
 * not merely imprecise: a published 0 → 40 renders as "+40 this quarter" for a
 * promoter who pledged in over three of them.
 *
 * `quarterSortRank` is months-since-year-0, so adjacency is a difference of
 * exactly 3. A label that cannot be ranked (`normalizeQuarter` keeps an
 * unparseable one VERBATIM) cannot be shown to be adjacent, so it yields null
 * rather than a delta nobody can date.
 */
export function computeQoqDeltas(
  newestFirst: ReadonlyArray<ShareholdingObservation>,
): ShareholdingQuarter[] {
  return newestFirst.map((cur, i) => {
    const older = newestFirst[i + 1] ?? null;
    const prev =
      older !== null && quarterGapMonths(cur.quarter, older.quarter) === 3
        ? older
        : null;
    return {
      ...cur,
      deltas: {
        promoterPct: deltaOf(cur.promoterPct, prev?.promoterPct ?? null),
        pledgedPct: deltaOf(cur.pledgedPct, prev?.pledgedPct ?? null),
        fiiPct: deltaOf(cur.fiiPct, prev?.fiiPct ?? null),
        diiPct: deltaOf(cur.diiPct, prev?.diiPct ?? null),
        publicPct: deltaOf(cur.publicPct, prev?.publicPct ?? null),
      },
    };
  });
}

/** Oldest-first pledge series for a sparkline. Nulls stay null (gaps). */
export function buildPledgeTrend(
  newestFirst: ReadonlyArray<ShareholdingObservation>,
): PledgePoint[] {
  return newestFirst
    .map((r) => ({
      quarter: r.quarter,
      label: r.label,
      pledgedPct: r.pledgedPct,
    }))
    .reverse();
}

/**
 * Pick the source, shape the series.
 *
 * The EXCHANGE filings win WHOLE whenever `shareholding_patterns` has at least
 * one usable row for the symbol — from either exchange. The third-party copy
 * serves only their total absence, and is flagged `fallback: true` so the
 * section chrome renders the visible chip.
 *
 * "Usable" excludes an all-null row: the NSE parser rejects those at write time
 * (`parseShareholdingMaster` requires one non-null percentage), but if one ever
 * lands, treating it as presence would suppress a populated fallback series and
 * show an empty panel with a confident label.
 *
 * ## `source` is READ OFF THE WINNING ROW (MONEY-1255)
 *
 * It used to be the constant `SHAREHOLDING_PRIMARY_SOURCE`, returned whenever
 * the exchange path was taken at all. `shareholding_patterns` now holds 17,075
 * BSE rows across 4,705 symbols, and 2,605 of those symbols have NO NSE row —
 * so for every one of them the panel rendered numbers sourced entirely from
 * BSE's filing under a chip reading "NSE shareholding". That is not a cosmetic
 * mislabel: the chip is the ONLY thing on the page that says where a number
 * came from, which is the entire premise of the provenance envelope.
 */
export function buildShareholdingSection(input: {
  nse: ReadonlyArray<NseShareholdingRow>;
  tickertape: ReadonlyArray<TickertapeShareholdingRow>;
  /** Quarters to keep, newest first. Default 12 (three years). */
  maxQuarters?: number;
  /** Exchange whose filing wins when both have published the same quarter.
   *  Usually the exchange being viewed. See dedupeShareholdingByQuarter. */
  preferExchange?: string | null;
}): ShareholdingSection {
  const maxQuarters = Math.max(1, input.maxQuarters ?? 12);

  // Deduped HERE, not in the reader, so every caller is covered by construction
  // — the same quarter arriving twice from two exchanges is a property of the
  // table, not of one query.
  const nse = normalizeNseShareholding(
    dedupeShareholdingByQuarter(input.nse, input.preferExchange),
  ).filter(hasAnyPct);
  // The PATH taken, which is a different question from the source of any one
  // row: "we fell back to a third party" is a property of the section, while
  // "this quarter came from BSE" is a property of a row.
  const chosen: {
    fallback: boolean;
    rows: ShareholdingObservation[];
  } =
    nse.length > 0
      ? { fallback: false, rows: nse }
      : (() => {
          const tt = normalizeTickertapeShareholding(input.tickertape).filter(
            hasAnyPct,
          );
          return tt.length > 0
            ? { fallback: true, rows: tt }
            : { fallback: false, rows: [] };
        })();

  const sorted = sortShareholdingNewestFirst(chosen.rows).slice(0, maxQuarters);

  // Newest-first, so `sources[0]` is the chip's source and any second entry is
  // the older exchange the series also drew on.
  const sources: ShareholdingSource[] = [];
  for (const row of sorted) {
    if (row.source !== null && !sources.includes(row.source))
      sources.push(row.source);
  }

  return {
    // The row that WON, not the path that was taken. `sorted[0]` is the same
    // row the caller derives `asOf` from.
    source: sorted[0]?.source ?? null,
    sources,
    fallback: chosen.fallback && sorted.length > 0,
    quarters: computeQoqDeltas(sorted),
    pledgeTrend: buildPledgeTrend(sorted),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.4b — Ownership breakdown (`shareholding_breakdown`) — MONEY-1255
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The institutional split, from the FILING rather than from NSE's summary.
 *
 * `shareholding_breakdown` holds 52,435 rows across 4,828 symbols and — until
 * this section — NOTHING user-facing read a single one of them. The summary
 * table above cannot answer the question it answers: `shareholding_patterns`
 * has no mutual-fund, insurance, banks, government or retail column at all, and
 * its FII/DII columns were null on 100% of 7,953 rows when MONEY-1207 measured
 * them. So "who owns this, institutionally" was unanswerable on screen while
 * the answer sat parsed in a table.
 *
 * Every rule this file already lives by applies unchanged, and two of them are
 * load-bearing HERE specifically:
 *
 *   - **null is not zero.** `diiPct` null with `mutualFundPct` populated is a
 *     legitimate filing state (the schema says so), and BEDMUTHA files no
 *     institutional members at all. Writing 0 for either would state that an
 *     institution reported a nil holding.
 *   - **a total is derived from GUARDED values or not at all.** See
 *     {@link institutionalTotal}: it refuses rather than summing around a
 *     missing leg, because a total that silently omits DII understates by
 *     however much DII was.
 */

/** The two writers that fill `shareholding_breakdown`. */
export type OwnershipBreakdownSource = "NSE_SHP_XBRL" | "BSE_SHP";

const OWNERSHIP_BREAKDOWN_SOURCES: ReadonlySet<string> = new Set([
  "NSE_SHP_XBRL",
  "BSE_SHP",
]);

/**
 * Exchange → the breakdown `source` code, for a reader whose `select` dropped
 * the column. NSE's leg parses the XBRL attachment; BSE's parses its own JSON.
 */
const EXCHANGE_BREAKDOWN_SOURCE: Readonly<
  Record<string, OwnershipBreakdownSource>
> = {
  NSE: "NSE_SHP_XBRL",
  BSE: "BSE_SHP",
};

/** Same three-rung resolution as {@link shareholdingRowSource}, other table. */
export function breakdownRowSource(row: {
  source?: string | null;
  exchange?: string | null;
}): OwnershipBreakdownSource | null {
  const stored =
    typeof row.source === "string" ? row.source.trim().toUpperCase() : "";
  if (OWNERSHIP_BREAKDOWN_SOURCES.has(stored))
    return stored as OwnershipBreakdownSource;

  const exchange =
    typeof row.exchange === "string" ? row.exchange.trim().toUpperCase() : "";
  if (exchange === "" && stored === "") return "NSE_SHP_XBRL";
  return EXCHANGE_BREAKDOWN_SOURCE[exchange] ?? null;
}

/** A `shareholding_breakdown` row as the reader hands it over. */
export interface OwnershipBreakdownRow {
  quarter: string;
  exchange?: string | null;
  source?: string | null;
  fiiPct?: number | null;
  diiPct?: number | null;
  mutualFundPct?: number | null;
  insurancePct?: number | null;
  banksFiPct?: number | null;
  govtPct?: number | null;
  retailPct?: number | null;
  /**
   * Absolute counts. `bigint` because that is what Prisma hands over, and
   * `JSON.stringify` THROWS on one — so they leave here as decimal STRINGS.
   * See {@link shareCountString}.
   */
  promoterShares?: bigint | number | string | null;
  fiiShares?: bigint | number | string | null;
  diiShares?: bigint | number | string | null;
  publicShares?: bigint | number | string | null;
  totalShares?: bigint | number | string | null;
}

export type OwnershipBreakdownLegKey =
  | "fii"
  | "dii"
  | "mutualFund"
  | "insurance"
  | "banksFi"
  | "govt"
  | "retail";

export interface OwnershipBreakdownLeg {
  key: OwnershipBreakdownLegKey;
  label: string;
  /** Longer gloss for the row's tooltip. */
  title: string;
  /**
   * True when this leg is a COMPONENT of the DII line above it. The filing's
   * own DII total is not the sum of these (it may carry legs we do not model),
   * so they are shown indented rather than added up.
   */
  nested: boolean;
  /** Latest quarter's percentage. Null is NOT REPORTED, never zero. */
  pct: number | null;
  /** QoQ change in percentage POINTS. Null unless both quarters reported it. */
  deltaPct: number | null;
  /**
   * QoQ change RELATIVE to the prior level, in percent.
   *
   * Null when the prior level is 0: `(0.4 - 0) / 0` is `Infinity`, and
   * "+Infinity%" on a screen is the exact non-finite-money defect this repo
   * keeps re-learning. A move off zero has no percentage change — the
   * percentage-POINT delta beside it carries that fact honestly.
   */
  changePct: number | null;
}

/** Share counts, as decimal strings. Null is not-reported. */
export interface OwnershipBreakdownShares {
  promoter: string | null;
  fii: string | null;
  dii: string | null;
  public: string | null;
  total: string | null;
}

export interface OwnershipBreakdownSection {
  /** Canonical `YYYY-MM` of the latest quarter, or null when there is none. */
  quarter: string | null;
  label: string | null;
  /**
   * The next-newest quarter WE HOLD — reported whether or not it is adjacent,
   * so the card can name what it declined to compare against instead of
   * looking like it found nothing.
   */
  prevQuarter: string | null;
  prevLabel: string | null;
  /**
   * True when `prevQuarter` is the IMMEDIATELY preceding quarter, which is the
   * only case the deltas are computed in. False means every delta is null ON
   * PURPOSE — a nine-month move must never be labelled "this quarter", the same
   * rule {@link computeQoqDeltas} enforces upstairs.
   */
  comparable: boolean;
  /** The winning row's source. Null when it names an exchange we cannot code. */
  source: OwnershipBreakdownSource | null;
  /** The exchange whose filing won, verbatim from the row. */
  exchange: string | null;
  legs: OwnershipBreakdownLeg[];
  /**
   * FII + DII from GUARDED values, and null unless BOTH reported — see
   * {@link institutionalTotal}.
   */
  institutionalPct: number | null;
  institutionalDeltaPct: number | null;
  shares: OwnershipBreakdownShares;
}

interface LegSpec {
  key: OwnershipBreakdownLegKey;
  label: string;
  title: string;
  nested: boolean;
  read: (row: OwnershipBreakdownRow) => unknown;
}

/**
 * The seven lines, in filing order.
 *
 * Foreign first, then the domestic total and its legs indented under it, then
 * the retail slice of the public holding. Deliberately NOT a flat list: MF /
 * insurance / banks / government sit INSIDE DII, and a flat column of eight
 * percentages that sum to more than the register is a chart nobody can read.
 */
const OWNERSHIP_BREAKDOWN_LEGS: readonly LegSpec[] = [
  {
    key: "fii",
    label: "FII",
    title: "Foreign portfolio investors (SEBI Cat I + II)",
    nested: false,
    read: (r) => r.fiiPct,
  },
  {
    key: "dii",
    label: "DII",
    title:
      "Domestic institutional investors — the filing's own total, not the sum of the legs below it",
    nested: false,
    read: (r) => r.diiPct,
  },
  {
    key: "mutualFund",
    label: "Mutual funds",
    title: "Mutual fund schemes",
    nested: true,
    read: (r) => r.mutualFundPct,
  },
  {
    key: "insurance",
    label: "Insurance",
    title: "Insurance companies",
    nested: true,
    read: (r) => r.insurancePct,
  },
  {
    key: "banksFi",
    label: "Banks & FIs",
    title: "Banks and other financial institutions",
    nested: true,
    read: (r) => r.banksFiPct,
  },
  {
    key: "govt",
    label: "Government",
    title: "Central and state government holdings",
    nested: true,
    read: (r) => r.govtPct,
  },
  {
    key: "retail",
    label: "Retail",
    title: "Individual shareholders, within the public holding",
    nested: false,
    read: (r) => r.retailPct,
  },
];

/**
 * A Prisma `BigInt` (or anything number-shaped) as a decimal STRING.
 *
 * String, not number, and not because of a hypothetical: `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt`, which is a 500 at
 * the server/client boundary rather than a wrong number on screen. `Number()`
 * would survive the wire but is lossy above 2^53, and a share count is the one
 * place in this file where every digit is the fact.
 *
 * Non-integers, non-finite values and non-numeric text return null rather than
 * 0 — `Number("")` is 0, and the whole file exists to keep that coercion out.
 */
export function shareCountString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const t = Math.trunc(value);
    // Beyond 2^53 `String(t)` yields exponential notation ("1e+21"), which is
    // not a share count. BigInt renders every digit.
    return Number.isSafeInteger(t) ? String(t) : BigInt(t).toString();
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || isBlankText(s)) return null;
  return /^-?\d+$/.test(s) ? s : null;
}

/**
 * FII + DII, and ONLY when both are reported.
 *
 * A total assembled from whichever legs happened to be present is worse than no
 * total: it renders as a confident number that is short by exactly the missing
 * leg, with nothing on screen to say so. `finiteOrNull` is what keeps a NaN out
 * — `x ?? 0` does not catch NaN, and NaN + 20 is NaN all the way to the render.
 */
export function institutionalTotal(
  row: OwnershipBreakdownRow | null | undefined,
): number | null {
  if (!row) return null;
  const fii = finiteOrNull(row.fiiPct);
  const dii = finiteOrNull(row.diiPct);
  if (fii === null || dii === null) return null;
  return roundTo(fii + dii, 4);
}

/**
 * Relative QoQ change, in percent. Guarded on BOTH ends.
 *
 * `prev === 0` returns null rather than Infinity: a holding that went 0 → 0.4
 * did not rise by any percentage, it appeared. The percentage-POINT delta says
 * that correctly and this one would say "+Infinity%".
 */
export function relativeChangePct(cur: unknown, prev: unknown): number | null {
  const c = finiteOrNull(cur);
  const p = finiteOrNull(prev);
  if (c === null || p === null || p === 0) return null;
  const out = ((c - p) / p) * 100;
  // A denormal `p` can still overflow the division. Re-check rather than trust.
  return Number.isFinite(out) ? roundTo(out, 2) : null;
}

/** Generic newest-first sort by quarter label. Unrankable labels keep order, last. */
function sortByQuarterNewestFirst<T extends { quarter: string }>(
  rows: ReadonlyArray<T>,
): T[] {
  return rows
    .map((row, i) => ({ row, i, rank: quarterSortRank(row.quarter) }))
    .sort((a, b) => {
      if (a.rank === null && b.rank === null) return a.i - b.i;
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return b.rank - a.rank || a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * Shape the ownership-breakdown card: latest quarter + its QoQ movement.
 *
 * The dedupe is {@link dedupeShareholdingByQuarter}, unchanged and reused:
 * `shareholding_breakdown` carries the SAME `@@unique([symbol, exchange,
 * quarter])` as the summary table, so a dual-listed name has every quarter
 * twice here too. Reading it exchange-scoped instead would drop a quarter only
 * the other exchange filed — the reason the summary read is symbol-only, and it
 * applies here identically.
 */
export function buildOwnershipBreakdownSection(
  rows: ReadonlyArray<OwnershipBreakdownRow>,
  opts: { preferExchange?: string | null } = {},
): OwnershipBreakdownSection {
  const deduped = dedupeShareholdingByQuarter(rows, opts.preferExchange);
  const sorted = sortByQuarterNewestFirst(deduped);
  const latest = sorted[0] ?? null;
  const older = sorted[1] ?? null;

  // Adjacency, not position. [2026-06, 2025-06] is one row apart and four
  // quarters apart, and calling that a QoQ move is the same defect
  // `computeQoqDeltas` documents: a year of drift labelled "this quarter".
  const comparable =
    latest !== null &&
    older !== null &&
    quarterGapMonths(latest.quarter, older.quarter) === 3;
  const prev = comparable ? older : null;

  const legs: OwnershipBreakdownLeg[] = OWNERSHIP_BREAKDOWN_LEGS.map((spec) => {
    const cur = latest === null ? null : finiteOrNull(spec.read(latest));
    const before = prev === null ? null : finiteOrNull(spec.read(prev));
    return {
      key: spec.key,
      label: spec.label,
      title: spec.title,
      nested: spec.nested,
      pct: cur,
      deltaPct: deltaOf(cur, before),
      changePct: relativeChangePct(cur, before),
    };
  });

  const institutionalPct = institutionalTotal(latest);
  const institutionalPrev = institutionalTotal(prev);

  return {
    quarter: latest?.quarter ?? null,
    label: latest ? shareholdingQuarterLabel(latest.quarter) : null,
    // `older`, not `prev`: an un-comparable neighbour is still a fact about
    // what we hold, and hiding it turns "we would not compare these" into
    // "there was nothing to compare".
    prevQuarter: older?.quarter ?? null,
    prevLabel: older ? shareholdingQuarterLabel(older.quarter) : null,
    comparable,
    source: latest ? breakdownRowSource(latest) : null,
    exchange:
      typeof latest?.exchange === "string" && latest.exchange.trim() !== ""
        ? latest.exchange.trim()
        : null,
    legs,
    institutionalPct,
    institutionalDeltaPct: deltaOf(institutionalPct, institutionalPrev),
    shares: {
      promoter: shareCountString(latest?.promoterShares),
      fii: shareCountString(latest?.fiiShares),
      dii: shareCountString(latest?.diiShares),
      public: shareCountString(latest?.publicShares),
      total: shareCountString(latest?.totalShares),
    },
  };
}

/**
 * Is there anything on this card worth rendering?
 *
 * The payload is an OBJECT, so the provenance envelope's length-based
 * `isEmptyPayload` cannot answer this — it is the documented `emptyOverride`
 * case. Seven null legs and five null counts IS empty, however real the row
 * that produced them is.
 */
export function hasOwnershipBreakdownValues(
  section: OwnershipBreakdownSection,
): boolean {
  if (section.quarter === null) return false;
  if (section.legs.some((l) => l.pct !== null)) return true;
  const s = section.shares;
  return (
    s.promoter !== null ||
    s.fii !== null ||
    s.dii !== null ||
    s.public !== null ||
    s.total !== null
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.5 — Insider & promoter activity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An `insider_events` row as the reader hands it over.
 *
 * `qty` arrives as `number | null` and NOT as the Prisma `BigInt` it is stored
 * as: `JSON.stringify` throws on a BigInt, so a server action that returned one
 * would crash at the server/client boundary. The coercion belongs at the read,
 * and this type is what enforces that it happened.
 */
export interface InsiderEventInput {
  id?: string | null;
  date: Date | string;
  person?: string | null;
  /** PIT | SAST | PLEDGE. */
  category: string;
  /**
   * BUY | SELL | PLEDGE_CREATION | PLEDGE_RELEASE | PLEDGE_INVOCATION — or the
   * VERBATIM upper-cased source text when the feed said something we do not
   * recognise. There is deliberately no OTHER bucket upstream, so an unknown
   * string here is normal input, never a parse failure.
   */
  action: string;
  qty?: number | null;
  value?: number | null;
  source?: string | null;
}

export type InsiderDirection = "BUY" | "SELL" | "PLEDGE" | "UNKNOWN";

/** The four recognised pledge actions, for label lookup. */
const INSIDER_ACTION_LABELS: Readonly<Record<string, string>> = {
  BUY: "Buy",
  SELL: "Sell",
  PLEDGE_CREATION: "Pledge created",
  PLEDGE_RELEASE: "Pledge released",
  PLEDGE_INVOCATION: "Pledge invoked",
};

/** The `category` value NSE's pledge snapshot rows carry. */
export const PLEDGE_CATEGORY = "PLEDGE";

/**
 * Label for a pledge row whose `action` is empty — MONEY-1205.
 *
 * "Not stated" was a claim about NSE: that a transaction type existed and the
 * filer withheld it. `/api/corporate-pledgedata` has no event-type field at
 * all, so there is nothing to state. These rows are a DAILY COMPANY SNAPSHOT of
 * a running `numSharesPledged` total, and the label says that instead.
 */
export const PLEDGE_SNAPSHOT_ACTION_LABEL = "Pledge position update";

/**
 * Label for a pledge row with no pledgor — MONEY-1205.
 *
 * Same falsehood at the person level. The snapshot endpoint has no pledgor
 * column, so "Person not disclosed" invents a withholding party; the row is
 * about the COMPANY's total pledged shares, and nobody was asked.
 */
export const PLEDGE_SNAPSHOT_PERSON_LABEL = "Company-wide pledged shares";

/**
 * Classify an action for NETTING only.
 *
 * `UNKNOWN` is a first-class outcome, not an error: upstream stores unrecognised
 * source text verbatim precisely so a new SEBI transaction type stays readable.
 * Such a row must still RENDER (with its raw text) — it just cannot be added to
 * a buy/sell net, because we do not know its sign.
 *
 * ## `category` OUTRANKS `action` for pledges (MONEY-1205)
 *
 * 5,734 of the 5,734 `PLEDGE`-category rows on prod carry `action: ""` — every
 * single one — because NSE's `/api/corporate-pledgedata` publishes no event
 * type. The parser is not misreading a field; the field does not exist. Reading
 * `action` alone therefore classified the ENTIRE pledge feed as `UNKNOWN`, and
 * the section told the user it held "N filings with an unrecognised transaction
 * type". The category column already says what these are, so it decides.
 *
 * The parameter is optional so existing callers (and the two apps that pass
 * only an action) keep working; every call site inside this module passes it.
 */
export function insiderDirection(
  action: string,
  category?: string | null,
): InsiderDirection {
  if ((category ?? "").trim().toUpperCase() === PLEDGE_CATEGORY)
    return "PLEDGE";
  const a = (action ?? "").trim().toUpperCase();
  if (a === "BUY") return "BUY";
  if (a === "SELL") return "SELL";
  if (a.startsWith("PLEDGE")) return "PLEDGE";
  return "UNKNOWN";
}

/**
 * Display text for an action. Unknown actions come back VERBATIM — the feed's
 * own words are more informative than "Other", and rewriting them would hide
 * the very case the no-OTHER-bucket design was built to expose.
 *
 * An EMPTY action on a `PLEDGE`-category row is the one case that is neither
 * unknown nor withheld — see {@link PLEDGE_SNAPSHOT_ACTION_LABEL}. An empty
 * action anywhere else still reads "Not stated", because there the filer really
 * did leave a field we expect blank.
 */
export function insiderActionLabel(
  action: string,
  category?: string | null,
): string {
  const a = (action ?? "").trim();
  const isPledgeRow = (category ?? "").trim().toUpperCase() === PLEDGE_CATEGORY;
  if (a === "")
    return isPledgeRow ? PLEDGE_SNAPSHOT_ACTION_LABEL : "Not stated";
  return INSIDER_ACTION_LABELS[a.toUpperCase()] ?? a;
}

/**
 * Who the row is about, as a sentence — MONEY-1205.
 *
 * A pledge snapshot has no pledgor to name, so it gets a label that describes
 * the row instead of accusing NSE of withholding one. Everything else keeps the
 * honest "we were not told who" wording.
 */
export function insiderPersonLabel(
  person: string | null | undefined,
  category?: string | null,
): string {
  const p = dealTextOrNull(person);
  if (p !== null) return p;
  return (category ?? "").trim().toUpperCase() === PLEDGE_CATEGORY
    ? PLEDGE_SNAPSHOT_PERSON_LABEL
    : "Person not disclosed";
}

/**
 * A `stock_documents` row offered as a possible corroborating filing.
 *
 * NOTE (finding, MONEY-1204 14c.5): `StockDocument` has NO filing-date column —
 * only `period`, `fetchedAt`, `createdAt`, `updatedAt`. The nearest thing to
 * "when this document happened" is therefore OUR INGEST TIME, not the
 * announcement date. `date` is passed in by the caller so this function stays
 * honest about that: it matches whatever date the caller considers the
 * document's, and the resulting link is labelled `likely`, never asserted.
 */
export interface StockDocumentInput {
  id: string;
  docType: string;
  title?: string | null;
  sourceUrl?: string | null;
  /** The document's effective date, chosen by the caller. */
  date: Date | string | null;
}

export interface LikelyDocumentLink {
  id: string;
  title: string | null;
  docType: string;
  sourceUrl: string | null;
  /**
   * Always true. This is a date-proximity heuristic against a document whose
   * only available timestamp is our ingest time — it must never be presented as
   * a stated relationship between the filing and the event.
   */
  likely: true;
  /** Signed whole days from event date to document date. */
  dayGap: number;
}

/**
 * Doc types that plausibly carry an insider/promoter announcement.
 *
 * `corporate_filing` is the enum value the schema names; the other two are
 * spellings seen in `sourceType`-varied writers. Matching is case-insensitive
 * and `docType` is free-form, so an unknown type is simply not offered as a
 * match — a wrong link is worse than no link.
 */
export const ANNOUNCEMENT_DOC_TYPES: readonly string[] = [
  "corporate_filing",
  "corporate_announcement",
  "announcement",
];

export function isAnnouncementDoc(docType: string): boolean {
  return ANNOUNCEMENT_DOC_TYPES.includes((docType ?? "").trim().toLowerCase());
}

/** Default proximity for the document heuristic: the event date ±2 days. */
export const INSIDER_DOC_MATCH_WINDOW_DAYS = 2;

/**
 * Closest announcement document within ±windowDays of the event, or null.
 *
 * Ties (two docs equidistant) resolve to the one that appears first in the
 * input, which the caller orders deterministically. Never guesses across a
 * larger window "because there is nothing closer" — an unrelated filing linked
 * to an insider trade is a claim we cannot support.
 */
export function matchLikelyDocument(
  eventDate: Date | string,
  docs: ReadonlyArray<StockDocumentInput>,
  opts: { windowDays?: number } = {},
): LikelyDocumentLink | null {
  const when = toDate(eventDate);
  if (!when) return null;
  const windowDays = Math.max(
    0,
    opts.windowDays ?? INSIDER_DOC_MATCH_WINDOW_DAYS,
  );

  let best: LikelyDocumentLink | null = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const doc of docs) {
    if (!isAnnouncementDoc(doc.docType)) continue;
    const docDate = toDate(doc.date);
    if (!docDate) continue;
    const gapDays = (docDate.getTime() - when.getTime()) / MS_PER_DAY;
    const abs = Math.abs(gapDays);
    if (abs > windowDays) continue;
    if (abs < bestAbs) {
      bestAbs = abs;
      best = {
        id: doc.id,
        title: dealTextOrNull(doc.title),
        docType: doc.docType,
        sourceUrl: dealTextOrNull(doc.sourceUrl),
        likely: true,
        dayGap: roundTo(gapDays, 2),
      };
    }
  }
  return best;
}

/** A wire-safe insider event: no Date, no BigInt. */
export interface InsiderEventView {
  id: string | null;
  dateIso: string;
  person: string | null;
  /**
   * `person` as a sentence — the pledgor's name, or a label that says why there
   * is none. NEVER "Person not disclosed" for a pledge snapshot, which has no
   * pledgor column to disclose (MONEY-1205). See {@link insiderPersonLabel}.
   */
  personLabel: string;
  category: string;
  /** The stored action string, verbatim. */
  action: string;
  actionLabel: string;
  direction: InsiderDirection;
  qty: number | null;
  value: number | null;
  source: string | null;
  document: LikelyDocumentLink | null;
}

export interface InsiderMonthGroup {
  /** `YYYY-MM` (UTC). */
  monthKey: string;
  label: string;
  events: InsiderEventView[];
}

export interface InsiderNetSummary {
  windowDays: number;
  /** Inclusive lower bound of the window, ISO. */
  from: string;
  to: string;
  eventCount: number;
  buyCount: number;
  sellCount: number;
  pledgeCount: number;
  /**
   * The subset of `pledgeCount` that is NSE's daily company snapshot — a
   * running `numSharesPledged` total, `category === "PLEDGE"`, no pledgor and
   * no event type because the endpoint publishes neither (MONEY-1205).
   *
   * Split out from `pledgeCount` so the UI can word the two apart: a SAST
   * `PLEDGE INVOKE` filing IS an event that happened on a day, while these are
   * the same standing position restated every session.
   */
  pledgeSnapshotCount: number;
  /** Events whose action we could not classify. They are shown, never netted. */
  unknownCount: number;
  /** Sums of DISCLOSED quantities. Null when nothing on that side disclosed one. */
  buyQty: number | null;
  sellQty: number | null;
  netQty: number | null;
  buyValue: number | null;
  sellValue: number | null;
  netValue: number | null;
  /** BUY/SELL events in the window that disclosed no quantity / no value. */
  undisclosedQtyCount: number;
  undisclosedValueCount: number;
}

/** 90 days is the summary window the section headlines. */
export const INSIDER_NET_WINDOW_DAYS = 90;

/**
 * Net the last N days of insider buying and selling.
 *
 * Window is `[now - windowDays, ∞)` — INCLUSIVE at the lower bound, and
 * deliberately open at the top. `InsiderEvent.date` is the TRANSACTION WINDOW
 * END (`acqtoDt`), not the intimation date, so a filing can legitimately name a
 * window that ends tomorrow; dropping it would silently lose the most recent
 * disclosure, which is the one a user came to see.
 *
 * PLEDGE events are counted but never netted: a pledge creation moves no
 * ownership, and adding its quantity to a buy/sell net would state a change of
 * hands that did not happen.
 *
 * A null sum means NOTHING WAS DISCLOSED on that side — not zero. Where some
 * filings disclosed and others did not, the disclosed ones are summed and
 * `undisclosedQtyCount` travels with the number so the UI can say what the
 * total excludes.
 */
export function netInsiderActivity(
  events: ReadonlyArray<InsiderEventInput>,
  opts: { now: Date | string; windowDays?: number },
): InsiderNetSummary {
  const now = toDate(opts.now) ?? new Date(0);
  const windowDays = Math.max(0, opts.windowDays ?? INSIDER_NET_WINDOW_DAYS);
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;

  let eventCount = 0;
  let buyCount = 0;
  let sellCount = 0;
  let pledgeCount = 0;
  let pledgeSnapshotCount = 0;
  let unknownCount = 0;
  let buyQty: number | null = null;
  let sellQty: number | null = null;
  let buyValue: number | null = null;
  let sellValue: number | null = null;
  let undisclosedQtyCount = 0;
  let undisclosedValueCount = 0;

  for (const ev of events) {
    const when = toDate(ev.date);
    if (!when || when.getTime() < cutoff) continue;
    eventCount += 1;

    // `category` is passed because it OUTRANKS `action` for pledges — every
    // row in NSE's pledge snapshot has an empty action, and reading the action
    // alone filed the whole feed under "unrecognised transaction type".
    const dir = insiderDirection(ev.action, ev.category);
    if (dir === "PLEDGE") {
      pledgeCount += 1;
      if ((ev.category ?? "").trim().toUpperCase() === PLEDGE_CATEGORY)
        pledgeSnapshotCount += 1;
      continue;
    }
    if (dir === "UNKNOWN") {
      unknownCount += 1;
      continue;
    }

    const qty = finiteOrNull(ev.qty);
    const value = finiteOrNull(ev.value);
    if (qty === null) undisclosedQtyCount += 1;
    if (value === null) undisclosedValueCount += 1;

    if (dir === "BUY") {
      buyCount += 1;
      if (qty !== null) buyQty = (buyQty ?? 0) + qty;
      if (value !== null) buyValue = (buyValue ?? 0) + value;
    } else {
      sellCount += 1;
      if (qty !== null) sellQty = (sellQty ?? 0) + qty;
      if (value !== null) sellValue = (sellValue ?? 0) + value;
    }
  }

  const net = (b: number | null, s: number | null): number | null =>
    b === null && s === null ? null : roundTo((b ?? 0) - (s ?? 0), 4);

  return {
    windowDays,
    from: new Date(cutoff).toISOString(),
    to: now.toISOString(),
    eventCount,
    buyCount,
    sellCount,
    pledgeCount,
    pledgeSnapshotCount,
    unknownCount,
    buyQty,
    sellQty,
    netQty: net(buyQty, sellQty),
    buyValue,
    sellValue,
    netValue: net(buyValue, sellValue),
    undisclosedQtyCount,
    undisclosedValueCount,
  };
}

/** Group a newest-first event list into newest-first calendar months. */
export function groupInsiderEventsByMonth(
  events: ReadonlyArray<InsiderEventView>,
): InsiderMonthGroup[] {
  const order: string[] = [];
  const byMonth = new Map<string, InsiderEventView[]>();
  for (const ev of events) {
    const d = toDate(ev.dateIso);
    if (!d) continue;
    const key = monthKeyOfDate(d);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(ev);
    else {
      byMonth.set(key, [ev]);
      order.push(key);
    }
  }
  return order
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((monthKey) => ({
      monthKey,
      label: monthLabelOfKey(monthKey),
      events: byMonth.get(monthKey) ?? [],
    }));
}

export interface InsiderSection {
  months: InsiderMonthGroup[];
  summary: InsiderNetSummary;
  /** Events kept after the display cap (not the count in the DB). */
  eventCount: number;
}

/**
 * Shape the whole insider panel.
 *
 * The NET is computed over EVERY event passed in, before the display cap: a
 * 90-day net that only saw the newest 50 rows would quietly under-report a
 * heavily-traded name. The cap applies to the rendered timeline only.
 */
export function buildInsiderSection(
  events: ReadonlyArray<InsiderEventInput>,
  opts: {
    now: Date | string;
    windowDays?: number;
    documents?: ReadonlyArray<StockDocumentInput>;
    docWindowDays?: number;
    limit?: number;
  },
): InsiderSection {
  const summary = netInsiderActivity(events, {
    now: opts.now,
    windowDays: opts.windowDays,
  });
  const docs = opts.documents ?? [];
  const limit = Math.max(1, opts.limit ?? 60);

  const views: InsiderEventView[] = events
    .map((ev) => ({ ev, when: toDate(ev.date) }))
    .filter((x): x is { ev: InsiderEventInput; when: Date } => x.when !== null)
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, limit)
    .map(({ ev, when }) => ({
      id: ev.id ?? null,
      dateIso: when.toISOString(),
      person: dealTextOrNull(ev.person),
      personLabel: insiderPersonLabel(ev.person, ev.category),
      category: ev.category,
      action: ev.action ?? "",
      actionLabel: insiderActionLabel(ev.action ?? "", ev.category),
      direction: insiderDirection(ev.action ?? "", ev.category),
      qty: finiteOrNull(ev.qty),
      value: finiteOrNull(ev.value),
      source: dealTextOrNull(ev.source),
      document:
        docs.length > 0
          ? matchLikelyDocument(when, docs, { windowDays: opts.docWindowDays })
          : null,
    }));

  return {
    months: groupInsiderEventsByMonth(views),
    summary,
    eventCount: views.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.6 — Bulk & block deals
// ═══════════════════════════════════════════════════════════════════════════

/** An `institutional_deals` row. `qty` already coerced off Prisma's BigInt. */
export interface DealInput {
  id?: string | null;
  date: Date | string;
  securityName?: string | null;
  /** The disclosed counterparty — the point of this feed. */
  clientName: string;
  /** BUY | SELL (the file also ships single letters). */
  buySell: string;
  qty?: number | null;
  avgPrice?: number | null;
  /** BULK | BLOCK. */
  dealType: string;
  /** Null on `-` AND when block.csv omits the column. Never render "null". */
  remarks?: string | null;
}

export type DealSide = "BUY" | "SELL";

export interface DealView {
  id: string | null;
  dateIso: string;
  securityName: string | null;
  clientName: string;
  side: DealSide | null;
  qty: number | null;
  avgPrice: number | null;
  /** qty × price, only when BOTH are known. Null otherwise — never 0. */
  value: number | null;
  dealType: string;
  remarks: string | null;
  /** True when this counterparty printed at least twice inside the window. */
  repeatClient: boolean;
}

export interface RepeatClient {
  /** Display name — the first spelling seen, verbatim. */
  clientName: string;
  /** Case/whitespace-normalised grouping key. */
  key: string;
  prints: number;
  buyPrints: number;
  sellPrints: number;
  /** Net of DISCLOSED quantities; null when none disclosed one. */
  netQty: number | null;
  /** Oldest and newest print inside the window, ISO. */
  firstDate: string;
  lastDate: string;
}

export interface DealsSection {
  /** Newest first, capped for display. */
  deals: DealView[];
  repeatClients: RepeatClient[];
  windowDays: number;
  minPrints: number;
  /**
   * BULK / BLOCK deals across EVERY dateable deal supplied — BEFORE the display
   * cap, like `repeatClients`. These two and `dealCount` deliberately disagree
   * once the cap bites, and that is the point: the panel shows a page, the
   * headline describes the window.
   */
  bulkCount: number;
  blockCount: number;
  /** Deals kept AFTER the display cap — i.e. `deals.length`. */
  dealCount: number;
}

/** A counterparty printing this many times inside the window is "repeat". */
export const REPEAT_CLIENT_MIN_PRINTS = 2;
/** …measured over this many days. */
export const REPEAT_CLIENT_WINDOW_DAYS = 90;

/**
 * Grouping key for a counterparty.
 *
 * Upper-cased, whitespace-collapsed, and trailing punctuation dropped, because
 * the same fund prints as `"GRAVITON RESEARCH CAPITAL LLP"` and
 * `"Graviton Research Capital  LLP."` on different days. Deliberately NOT
 * fuzzy beyond that: collapsing `"… FUND A"` into `"… FUND B"` would invent a
 * repeat buyer, which is the one error this feature must not make.
 */
export function normalizeClientName(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,]+$/, "");
  return isBlankText(s) ? "" : s.toUpperCase();
}

/** `"BUY"`/`"B"` → BUY, `"SELL"`/`"S"` → SELL, anything else null. */
export function dealSide(buySell: unknown): DealSide | null {
  const s = String(buySell ?? "")
    .trim()
    .toUpperCase();
  if (s === "") return null;
  if (s.startsWith("B")) return "BUY";
  if (s.startsWith("S")) return "SELL";
  return null;
}

/**
 * Counterparties with ≥ `minPrints` prints inside the window.
 *
 * The window is INCLUSIVE at its lower bound: a print exactly `windowDays` old
 * counts. A boundary that silently excluded the edge would make the "90 days"
 * label mean 89, and the repeat flag would flicker off a day early.
 */
export function detectRepeatClients(
  deals: ReadonlyArray<DealInput>,
  opts: { now: Date | string; windowDays?: number; minPrints?: number },
): RepeatClient[] {
  const now = toDate(opts.now) ?? new Date(0);
  const windowDays = Math.max(0, opts.windowDays ?? REPEAT_CLIENT_WINDOW_DAYS);
  const minPrints = Math.max(1, opts.minPrints ?? REPEAT_CLIENT_MIN_PRINTS);
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;

  interface Acc {
    clientName: string;
    key: string;
    prints: number;
    buyPrints: number;
    sellPrints: number;
    netQty: number | null;
    first: number;
    last: number;
    order: number;
  }
  const acc = new Map<string, Acc>();
  let order = 0;

  for (const d of deals) {
    const key = normalizeClientName(d.clientName);
    if (key === "") continue;
    const when = toDate(d.date);
    if (!when || when.getTime() < cutoff) continue;

    const existing = acc.get(key);
    const entry: Acc = existing ?? {
      clientName: String(d.clientName).trim().replace(/\s+/g, " "),
      key,
      prints: 0,
      buyPrints: 0,
      sellPrints: 0,
      netQty: null,
      first: when.getTime(),
      last: when.getTime(),
      order: order++,
    };
    entry.prints += 1;
    const side = dealSide(d.buySell);
    if (side === "BUY") entry.buyPrints += 1;
    else if (side === "SELL") entry.sellPrints += 1;
    const qty = finiteOrNull(d.qty);
    if (qty !== null && side !== null) {
      entry.netQty = (entry.netQty ?? 0) + (side === "BUY" ? qty : -qty);
    }
    entry.first = Math.min(entry.first, when.getTime());
    entry.last = Math.max(entry.last, when.getTime());
    acc.set(key, entry);
  }

  return [...acc.values()]
    .filter((e) => e.prints >= minPrints)
    .sort((a, b) => b.prints - a.prints || b.last - a.last || a.order - b.order)
    .map((e) => ({
      clientName: e.clientName,
      key: e.key,
      prints: e.prints,
      buyPrints: e.buyPrints,
      sellPrints: e.sellPrints,
      netQty: e.netQty === null ? null : roundTo(e.netQty, 4),
      firstDate: new Date(e.first).toISOString(),
      lastDate: new Date(e.last).toISOString(),
    }));
}

/** `dealType` as the panel groups it: trimmed, upper-cased, never null. */
function dealTypeOf(d: DealInput): string {
  return String(d.dealType ?? "")
    .trim()
    .toUpperCase();
}

/**
 * Shape the whole deals panel.
 *
 * Repeat detection AND the bulk/block totals run over EVERY deal supplied,
 * before the display cap, for the same reason the insider net does: a client
 * whose second print fell just outside the visible rows is still a repeat
 * buyer, and a block deal that fell outside them still happened. `dealCount` is
 * the one number that IS post-cap — it is `deals.length`.
 */
export function buildDealsSection(
  deals: ReadonlyArray<DealInput>,
  opts: {
    now: Date | string;
    windowDays?: number;
    minPrints?: number;
    limit?: number;
  },
): DealsSection {
  const windowDays = Math.max(0, opts.windowDays ?? REPEAT_CLIENT_WINDOW_DAYS);
  const minPrints = Math.max(1, opts.minPrints ?? REPEAT_CLIENT_MIN_PRINTS);
  const limit = Math.max(1, opts.limit ?? 50);

  const repeatClients = detectRepeatClients(deals, {
    now: opts.now,
    windowDays,
    minPrints,
  });
  const repeatKeys = new Set(repeatClients.map((r) => r.key));

  // Dateable deals, newest first — the whole window, BEFORE the display cap.
  const dated = deals
    .map((d) => ({ d, when: toDate(d.date) }))
    .filter((x): x is { d: DealInput; when: Date } => x.when !== null)
    .sort((a, b) => b.when.getTime() - a.when.getTime());

  // Counted here, over `dated`, for the same reason repeat detection is: the
  // cap is a DISPLAY cap. Counting over the page reports "50 bulk · 0 block"
  // for a stock with ten block deals whenever the newest 50 prints are bulk —
  // and block deals are the ones an investor is looking for.
  let bulkCount = 0;
  let blockCount = 0;
  for (const { d } of dated) {
    const type = dealTypeOf(d);
    if (type === "BULK") bulkCount += 1;
    else if (type === "BLOCK") blockCount += 1;
  }

  const views: DealView[] = dated.slice(0, limit).map(({ d, when }) => {
    const qty = finiteOrNull(d.qty);
    const avgPrice = finiteOrNull(d.avgPrice);
    return {
      id: d.id ?? null,
      dateIso: when.toISOString(),
      securityName: dealTextOrNull(d.securityName),
      clientName: String(d.clientName ?? "")
        .trim()
        .replace(/\s+/g, " "),
      side: dealSide(d.buySell),
      qty,
      avgPrice,
      // Both or nothing: a `0` here would read as a free trade.
      value:
        qty !== null && avgPrice !== null ? roundTo(qty * avgPrice, 2) : null,
      dealType: dealTypeOf(d),
      remarks: dealTextOrNull(d.remarks),
      repeatClient: repeatKeys.has(normalizeClientName(d.clientName)),
    };
  });

  return {
    deals: views,
    repeatClients,
    windowDays,
    minPrints,
    bulkCount,
    blockCount,
    dealCount: views.length,
  };
}
