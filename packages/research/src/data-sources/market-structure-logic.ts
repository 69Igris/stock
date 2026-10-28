/**
 * Market-structure research data — PURE — MONEY-1204 (P14 / 14e.2).
 *
 * Row-shaping, grain arithmetic and the DB-first orchestrator behind the
 * research agent's market-structure tools. No Prisma, no network, no clock
 * except through arguments. `market-structure-store.ts` is the thin reader.
 *
 * ## Every tool returns `{ rows, asOf, provenance }`
 *
 * The agent cites its sources, so a tool that returns bare rows forces the
 * synthesizer to invent an attribution. `provenance.origin` distinguishes the
 * three answers that look identical in a bare array — "our table said so",
 * "our table was empty so we scraped", and "nobody could tell us" — and
 * `asOf` is the newest row's own date, never the fetch time.
 *
 * ## Three traps this module exists to not fall into
 *
 * **(1) `MarketPositioning` now holds TWO INCOMPATIBLE GRAINS.** The
 * participant feed writes `metric` `OI` / `VOLUME` over the buckets
 * `FUT_IDX FUT_STK OPT_IDX_CALL OPT_IDX_PUT OPT_STK_CALL OPT_STK_PUT`. The
 * `nse-fii-stats` feed writes `metric: "FII_STATS"` over its OWN namespace
 * (`IDX_FUT`, `IDX_OPT`, `STK_FUT`, `STK_OPT`, plus per-underlying breakdowns
 * like `IDX_OPT:NIFTY`) and carries the rupee values the participant feed
 * lacks. A query that does not filter on `metric` returns both, and open
 * interest (a STOCK) averaged with volume (a FLOW) is meaningless. So `metric`
 * is REQUIRED, not defaulted.
 *
 * **(2) Within FII_STATS the parents are SUBTOTALS.** `IDX_OPT` is the exact
 * sum of `IDX_OPT:NIFTY`, `IDX_OPT:BANKNIFTY`, … — so summing the table sums
 * every index twice. `isFiiStatsTotal` (a bucket with no `:`) is the predicate,
 * and `sumPositioning` REFUSES a mixed set rather than returning a number that
 * is quietly double what it should be. Refusing is the point: a helper that
 * silently de-duplicated would make the mistake invisible again the next time
 * someone wrote their own loop.
 *
 * **(3) Absence is not zero, anywhere.** `MarketPositioning`'s rupee columns
 * are null on every participant-feed row (that feed publishes contract counts
 * and no lot size, so a notional cannot be derived) and there are REAL
 * published zeros beside them. India VIX prints five trailing `-` for
 * Volume/Turnover/PE/PB/DivYield because a volatility index has no basket to
 * value. `bond_eod` is nearly empty because its history walk is founder-gated.
 * All three stay `null`, and a tool with nothing to say returns an EMPTY CITED
 * RESULT — never an error, and never a fabricated zero.
 */

import { FII_STATS_METRIC, isFiiStatsTotal } from "@usemoney/core/market-data";

// ─── Cited results ───────────────────────────────────────────────────

/** Where a tool's rows came from, and how much to trust them. */
export interface ToolProvenance {
  /**
   * `DB` — our own synced table. `LIVE` — fetched from the source just now.
   * `NONE` — neither could answer; `rows` is empty and that is the finding.
   */
  origin: "DB" | "LIVE" | "NONE";
  /** Prisma model or live endpoint, e.g. `"InstitutionalDeal"` / `"NSE"`. */
  source: string;
  /** True when the DB path came up empty (or threw) and live answered. */
  fallback?: boolean;
  /** The live source's error, when one was captured while degrading. */
  sourceError?: string;
  /**
   * Why an empty result is empty, in the agent's own words. The difference
   * between "no bonds match" and "we have not ingested bond prices yet" is the
   * difference between a finding and a data gap, and only this field carries it.
   */
  note?: string;
}

export interface CitedRows<T> {
  rows: T[];
  /** Newest row's OWN date (ISO), never the fetch time. Null when empty. */
  asOf: string | null;
  provenance: ToolProvenance;
}

/** An empty, cited, non-error result. The honest answer to "we have nothing". */
export function emptyCited<T>(
  source: string,
  note: string,
  extra: Partial<ToolProvenance> = {},
): CitedRows<T> {
  return {
    rows: [],
    asOf: null,
    provenance: { origin: "NONE", source, note, ...extra },
  };
}

/** ISO day/instant, or null. Accepts `Date` and string alike. */
export function isoOrNull(
  v: Date | string | number | null | undefined,
): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

/** Finite number, or null. Accepts `bigint` — Prisma `BigInt` columns reach
 *  here and `JSON.stringify` throws on one, so the coercion happens once. */
export function num(v: unknown): number | null {
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

/** Trimmed non-empty string, or null. `""` / `"-"` are ABSENCE, never a value. */
export function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || t === "-" ? null : t;
}

/** Newest `asOf` across rows carrying a `date`-ish member. */
export function newestAsOf(
  rows: ReadonlyArray<{ date?: string | null; period?: string | null }>,
): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const d = r.date ?? r.period ?? null;
    if (d === null) continue;
    if (best === null || d > best) best = d;
  }
  return best;
}

/**
 * DB-first, live-fallback (the MONEY-1060 shape, inverted).
 *
 * `fetch_company_profile` is LIVE-primary because Yahoo is fresher than our
 * sync. These three are the opposite case: we now ingest the deals, the flows
 * and the macro series ourselves, on a schedule, with history — so the DB is
 * both fresher in practice (a scrape returns one page; the table returns
 * years) and free. Live is kept as the fallback, not deleted: our tables are
 * new, an environment may not have back-filled, and losing the tool entirely
 * would be a regression for exactly those environments.
 *
 * The ordering rules, all of which the tests pin:
 *
 *   * DB rows present → return them, `origin: "DB"`. Live is NEVER called, so
 *     the happy path costs no egress.
 *   * DB empty or throwing → try live, `origin: "LIVE"`, `fallback: true`.
 *   * Both empty → an EMPTY CITED result, not an error. "We looked in both
 *     places and there is nothing" is a finding.
 *   * Live THREW while DB was empty → still a cited result, with the error in
 *     `sourceError`, so the synthesizer can tell an outage from a real gap.
 */
export async function dbFirstWithLiveFallback<T>(
  dbFetch: () => Promise<CitedRows<T> | null>,
  liveFetch: (() => Promise<CitedRows<T> | null>) | null,
  opts: { source: string; emptyNote: string },
): Promise<CitedRows<T>> {
  let dbError: string | undefined;
  try {
    const fromDb = await dbFetch();
    if (fromDb && fromDb.rows.length > 0) return fromDb;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (!liveFetch) {
    return emptyCited<T>(opts.source, opts.emptyNote, {
      ...(dbError ? { sourceError: dbError } : {}),
    });
  }

  let liveError: string | undefined;
  try {
    const fromLive = await liveFetch();
    if (fromLive && fromLive.rows.length > 0) {
      return {
        ...fromLive,
        provenance: { ...fromLive.provenance, fallback: true },
      };
    }
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }

  const sourceError = liveError ?? dbError;
  return emptyCited<T>(opts.source, opts.emptyNote, {
    fallback: true,
    ...(sourceError ? { sourceError } : {}),
  });
}

// ─── Institutional deals (bulk / block) ──────────────────────────────

export interface DealRow {
  date: string;
  symbol: string;
  exchange: string;
  securityName: string | null;
  clientName: string;
  buySell: string;
  /** `BigInt` in Prisma — a single print in a high-float penny name exceeds
   *  Int32 — coerced here so nothing downstream can throw on stringify. */
  qty: number | null;
  avgPrice: number | null;
  dealType: string;
  remarks: string | null;
  source: string;
}

export function toDealRow(row: Record<string, unknown>): DealRow | null {
  const symbol = text(row.symbol);
  const clientName = text(row.clientName);
  const date = isoOrNull(row.date as Date | string | null | undefined);
  if (!symbol || !date) return null;
  return {
    date,
    symbol,
    exchange: text(row.exchange) ?? "NSE",
    securityName: text(row.securityName),
    // The client IS the point of this feed; a row without one is still a real
    // print, so it is kept with an explicit empty rather than dropped.
    clientName: clientName ?? "",
    buySell: text(row.buySell) ?? "",
    qty: num(row.qty),
    avgPrice: num(row.avgPrice),
    dealType: text(row.dealType) ?? "",
    remarks: text(row.remarks),
    source: text(row.source) ?? "NSE_DEALS",
  };
}

// ─── Institutional flows (FII / DII cash) ────────────────────────────

export interface FlowRow {
  date: string;
  /** FII | DII. FPI is the same money under another regulatory name and NSE
   *  prints them as one bucket, so it collapses to FII upstream. */
  category: string;
  segment: string;
  /** ₹ CRORE — NSE's own unit, stored and returned UNCONVERTED. */
  buyValue: number | null;
  sellValue: number | null;
  netValue: number | null;
  source: string;
}

export function toFlowRow(row: Record<string, unknown>): FlowRow | null {
  const date = isoOrNull(row.date as Date | string | null | undefined);
  const category = text(row.category);
  if (!date || !category) return null;
  return {
    date,
    category,
    segment: text(row.segment) ?? "CASH",
    buyValue: num(row.buyValue),
    sellValue: num(row.sellValue),
    // NSE publishes its own net and a publisher correction to it is data we
    // would otherwise discard, so it is read, not re-derived.
    netValue: num(row.netValue),
    source: text(row.source) ?? "NSE_FII_DII_CASH",
  };
}

// ─── Macro series ────────────────────────────────────────────────────

export interface MacroRow {
  seriesId: string;
  /** Period the observation DESCRIBES (ISO), not when we fetched it. */
  period: string;
  value: number;
  /** PERCENT | INDEX | INR_CRORE | USD_MILLION | INR_PER_UNIT — one page mixes
   *  all of them, so a bare number is uninterpretable without this. */
  unit: string;
  frequency: string;
  /** The upstream row label VERBATIM, base-year parenthetical included: it is
   *  what makes a rebase DISCONTINUITY discoverable instead of invisible. */
  label: string;
  releasedOn: string | null;
  source: string;
}

export function toMacroRow(row: Record<string, unknown>): MacroRow | null {
  const seriesId = text(row.seriesId);
  const period = isoOrNull(row.period as Date | string | null | undefined);
  const value = num(row.value);
  if (!seriesId || !period || value === null) return null;
  return {
    seriesId,
    period,
    value,
    unit: text(row.unit) ?? "",
    frequency: text(row.frequency) ?? "",
    label: typeof row.label === "string" ? row.label : "",
    releasedOn: isoOrNull(row.releasedOn as Date | string | null | undefined),
    source: text(row.source) ?? "",
  };
}

/** Newest observation per `seriesId` — the dashboard shape. Input must be
 *  sorted period-DESC per series (the reader's `orderBy` does that). */
export function latestPerSeries(rows: readonly MacroRow[]): MacroRow[] {
  const best = new Map<string, MacroRow>();
  for (const r of rows) {
    const prev = best.get(r.seriesId);
    if (!prev || r.period > prev.period) best.set(r.seriesId, r);
  }
  return [...best.values()].sort((a, b) =>
    a.seriesId.localeCompare(b.seriesId),
  );
}

// ─── Stock flags ─────────────────────────────────────────────────────

export interface StockFlagRowOut {
  kind: string;
  /**
   * The stored `value`, VERBATIM. Surveillance codes are kept exactly as NSE
   * wrote them (`"GSM STAGE - I"`, `"Long Term ASM - Stage IV"`) and decoded
   * only here, at render — so a wording NSE invents next month survives in the
   * data and a better decode table can re-read rows written years ago.
   */
  raw: string;
  /** Read-time decode. Null when the wording is not recognised — never a
   *  guessed framework, and the raw code is right there beside it. */
  framework: string | null;
  stage: number | null;
  label: string;
  /** Trading day of the newest row carrying this value. */
  date: string;
  /** First day of the unbroken run ending at `date`. */
  since: string;
  observedSessions: number;
  /** The run consumed every row we fetched, so `since` is a LOWER BOUND. */
  runReachesWindowEdge: boolean;
  /**
   * The kind's newest day is the newest day that kind was published
   * MARKET-WIDE. `false` means the flag ENDED — and it is the whole reason
   * `some(r => r.kind === "FO_BAN")` is the wrong query: a 40-day ban is 40
   * rows and there is no `@@unique` to collapse them, so an existence check
   * reports a ban that lifted in January as current in August.
   */
  isCurrent: boolean;
  series: string | null;
  source: string | null;
}

/**
 * `StockFlagBadge` → the tool's row shape.
 *
 * The decode is applied HERE, at render, over the verbatim `raw` — never
 * stored. That is what lets a wording NSE invents next month survive in the
 * table, and lets a better decode table re-read rows written years ago. An
 * unrecognised code keeps `framework: null` beside its intact `raw`, rather
 * than being bucketed into a guess.
 */
export function toStockFlagRowOut(badge: {
  kind: string;
  label: string;
  raw: string;
  parsed: unknown;
  date: string;
  since: string;
  observedSessions: number;
  runReachesWindowEdge: boolean;
  isCurrent: boolean;
  series: string | null;
  source: string | null;
}): StockFlagRowOut {
  const parsed = badge.parsed as
    | {
        type?: string;
        decode?: { framework?: string; stage?: number | null } | null;
      }
    | null
    | undefined;
  const decode =
    parsed && parsed.type === "SURVEILLANCE" ? (parsed.decode ?? null) : null;
  return {
    kind: badge.kind,
    raw: badge.raw,
    framework: decode?.framework ?? null,
    stage: decode?.stage ?? null,
    label: badge.label,
    date: badge.date,
    since: badge.since,
    observedSessions: badge.observedSessions,
    runReachesWindowEdge: badge.runReachesWindowEdge,
    isCurrent: badge.isCurrent,
    series: badge.series,
    source: badge.source,
  };
}

// ─── Positioning ─────────────────────────────────────────────────────

/** Which grain of `MarketPositioning` a caller wants. */
export type PositioningGrain = "TOTALS" | "BREAKDOWNS" | "ALL";

export interface PositioningRow {
  date: string;
  participant: string;
  bucket: string;
  metric: string;
  /** Contract COUNTS. The participant feed publishes nothing else. */
  longQty: number | null;
  shortQty: number | null;
  netQty: number | null;
  /** ₹ crore. NULL on every participant-feed row — that feed has no lot size,
   *  so a notional cannot be derived and is not invented. */
  longValue: number | null;
  shortValue: number | null;
  netValue: number | null;
  openInterestQty: number | null;
  openInterestValue: number | null;
  /**
   * True when this row is a segment TOTAL rather than a per-underlying
   * BREAKDOWN of one. Only meaningful inside `FII_STATS`; the participant
   * feed's six legs are all totals of nothing and are all `true`.
   */
  isTotal: boolean;
  source: string;
}

export function toPositioningRow(
  row: Record<string, unknown>,
): PositioningRow | null {
  const date = isoOrNull(row.date as Date | string | null | undefined);
  const participant = text(row.participant);
  const bucket = text(row.bucket);
  const metric = text(row.metric);
  if (!date || !participant || !bucket || !metric) return null;
  return {
    date,
    participant,
    bucket,
    metric,
    longQty: num(row.longQty),
    shortQty: num(row.shortQty),
    netQty: num(row.netQty),
    longValue: num(row.longValue),
    shortValue: num(row.shortValue),
    netValue: num(row.netValue),
    openInterestQty: num(row.openInterestQty),
    openInterestValue: num(row.openInterestValue),
    // The `:` convention is FII_STATS's; outside it every bucket is a leaf.
    isTotal: metric === FII_STATS_METRIC ? isFiiStatsTotal(bucket) : true,
    source: text(row.source) ?? "",
  };
}

/**
 * Rows of ONE metric, at ONE grain.
 *
 * `metric` is required and not defaulted: the two feeds writing this table are
 * column-identical and describe different things (open interest is a STOCK,
 * volume is a FLOW, and FII_STATS is a third namespace entirely), so a caller
 * that forgets to say which one wants an answer nobody can interpret. Rows of
 * any other metric are DROPPED here rather than silently averaged in.
 */
export function selectPositioningRows(
  rows: readonly PositioningRow[],
  opts: { metric: string; grain?: PositioningGrain },
): PositioningRow[] {
  const grain = opts.grain ?? "TOTALS";
  return rows.filter((r) => {
    if (r.metric !== opts.metric) return false;
    if (grain === "TOTALS") return r.isTotal;
    if (grain === "BREAKDOWNS") return !r.isTotal;
    return true;
  });
}

export interface PositioningSum {
  rows: number;
  metric: string;
  netQty: number;
  /** Null when NO row carried a rupee value — the participant feed's case.
   *  Not 0: "this feed does not publish notional" is a different fact. */
  netValue: number | null;
  longQty: number;
  shortQty: number;
}

export type PositioningSumResult =
  | { ok: true; sum: PositioningSum }
  | {
      ok: false;
      reason: "EMPTY" | "MIXED_METRICS" | "MIXED_GRAIN";
      detail: string;
    };

/**
 * Total a set of positioning rows — or REFUSE, with a reason.
 *
 * It refuses two ways, and both refusals are the feature:
 *
 *   * **MIXED_METRICS** — open interest and volume are incomparable
 *     magnitudes; FII_STATS is a third namespace over the same participant and
 *     days. A sum across them is a number with no meaning.
 *   * **MIXED_GRAIN** — inside FII_STATS, `IDX_OPT` IS the sum of
 *     `IDX_OPT:NIFTY`, `IDX_OPT:BANKNIFTY`, … Adding parents to children
 *     double-counts every index, and the result looks entirely plausible.
 *
 * Silently de-duplicating instead would hide the modelling error and let the
 * next hand-written loop reproduce it. Returning a reason makes it a test.
 */
export function sumPositioning(
  rows: readonly PositioningRow[],
): PositioningSumResult {
  if (rows.length === 0) {
    return { ok: false, reason: "EMPTY", detail: "no rows to sum" };
  }

  const metrics = new Set(rows.map((r) => r.metric));
  if (metrics.size > 1) {
    return {
      ok: false,
      reason: "MIXED_METRICS",
      detail: `refusing to sum across metrics ${[...metrics].sort().join(", ")} — open interest is a stock, volume is a flow, and FII_STATS is a separate namespace`,
    };
  }

  const metric = rows[0]!.metric;
  if (metric === FII_STATS_METRIC) {
    const grains = new Set(rows.map((r) => r.isTotal));
    if (grains.size > 1) {
      return {
        ok: false,
        reason: "MIXED_GRAIN",
        detail:
          "refusing to sum FII_STATS totals together with their per-underlying breakdowns — the parent IS the sum of its children, so this double-counts every index",
      };
    }
  }

  let netQty = 0;
  let longQty = 0;
  let shortQty = 0;
  let netValue = 0;
  let sawValue = false;
  for (const r of rows) {
    netQty += r.netQty ?? 0;
    longQty += r.longQty ?? 0;
    shortQty += r.shortQty ?? 0;
    if (r.netValue !== null) {
      netValue += r.netValue;
      sawValue = true;
    }
  }

  return {
    ok: true,
    sum: {
      rows: rows.length,
      metric,
      netQty,
      // No row carried a rupee value ⇒ null, not 0. The participant feed
      // publishes contract counts and no lot size.
      netValue: sawValue ? netValue : null,
      longQty,
      shortQty,
    },
  };
}

// ─── Mutual-fund holdings ("which funds hold X") ─────────────────────

export interface FundHoldingRow {
  period: string;
  amc: string;
  /** The scheme name EXACTLY as printed — the only identifier in the file. */
  schemeName: string;
  schemeKey: string;
  isin: string | null;
  instrumentName: string;
  holdingType: string;
  /** Nullable: cash-equivalent lines have no quantity. */
  quantity: number | null;
  /** ₹ LAKH — the AMCs' own unit, returned UNCONVERTED. */
  marketValueLakh: number | null;
  percentToNav: number | null;
  source: string;
}

export function toFundHoldingRow(
  row: Record<string, unknown>,
): FundHoldingRow | null {
  const period = isoOrNull(row.period as Date | string | null | undefined);
  const instrumentName = text(row.instrumentName);
  if (!period || !instrumentName) return null;
  return {
    period,
    amc: text(row.amc) ?? "",
    schemeName: text(row.schemeName) ?? "",
    schemeKey: text(row.schemeKey) ?? "",
    isin: text(row.isin),
    instrumentName,
    holdingType: text(row.holdingType) ?? "OTHER",
    quantity: num(row.quantity),
    marketValueLakh: num(row.marketValue),
    percentToNav: num(row.percentToNav),
    source: text(row.source) ?? "",
  };
}

// ─── Bonds ───────────────────────────────────────────────────────────

export interface BondQuoteRow {
  isin: string;
  date: string;
  /** CBM | WDM. IN the identity: the same ISIN prints in both segments on the
   *  same day at different prices, and collapsing them loses one. */
  segment: string;
  lastPrice: number | null;
  lastYtm: number | null;
  wapPrice: number | null;
  wtdYtm: number | null;
  /** ₹ LACS — the file's own unit, name-carried and unconverted. */
  totalTradeValueLacs: number | null;
  // From BondMaster, when the ISIN resolved there.
  symbol: string | null;
  issuer: string | null;
  /** Annual coupon in PERCENT. Null and never 0. */
  coupon: number | null;
  /** NULL is MEANINGFUL: perpetual instruments genuinely have no maturity. */
  maturityDate: string | null;
  creditRating: string | null;
  secType: string | null;
  source: string;
}

export function toBondQuoteRow(
  eod: Record<string, unknown>,
  master: Record<string, unknown> | null,
): BondQuoteRow | null {
  const isin = text(eod.isin);
  const date = isoOrNull(eod.date as Date | string | null | undefined);
  if (!isin || !date) return null;
  return {
    isin,
    date,
    segment: text(eod.segment) ?? "",
    lastPrice: num(eod.lastPrice),
    lastYtm: num(eod.lastYtm),
    wapPrice: num(eod.wapPrice),
    wtdYtm: num(eod.wtdYtm),
    totalTradeValueLacs: num(eod.totalTradeValueLacs),
    symbol: master ? text(master.symbol) : null,
    issuer: master ? text(master.issuer) : null,
    coupon: master ? num(master.coupon) : null,
    maturityDate: master
      ? isoOrNull(master.maturityDate as Date | string | null | undefined)
      : null,
    creditRating: master ? text(master.creditRating) : null,
    secType: master ? text(master.secType) : null,
    source: text(eod.source) ?? "",
  };
}

/** ISINs are normalised `.trim().toUpperCase()` on ingest because `cbm_trd`
 *  prints them with a TRAILING SPACE while `wdmlist` does not — an
 *  un-normalised join matches nothing, which looks exactly like "this bond does
 *  not trade". */
export function normalizeIsin(v: unknown): string | null {
  const t = text(v);
  return t === null ? null : t.toUpperCase();
}

// ─── India VIX ───────────────────────────────────────────────────────

/** The `IndexClose.indexSlug` India VIX is stored under. */
export const INDIA_VIX_SLUG = "india-vix";

export interface VixRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  /**
   * The five columns NSE prints as `-` for this index, and the reason they are
   * `number | null` rather than `number`:
   *
   *   `India VIX,14-08-2026,11.4175,11.56,10.825,11.31,-,-,-,-,-`
   *
   * A volatility index has no basket to value, so it has no volume, no
   * turnover, no P/E, no P/B and no dividend yield. Rendering 0 for any of them
   * would state a measurement nobody made — and a 0 P/E reads as a
   * screaming-cheap index in any screen built on this table.
   */
  volume: number | null;
  turnoverCr: number | null;
  pe: number | null;
  pb: number | null;
  divYield: number | null;
}

export function toVixRow(row: Record<string, unknown>): VixRow | null {
  const date = isoOrNull(row.date as Date | string | null | undefined);
  if (!date) return null;
  return {
    date,
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    prevClose: num(row.prevClose),
    volume: num(row.volume),
    turnoverCr: num(row.turnoverCr),
    pe: num(row.pe),
    pb: num(row.pb),
    divYield: num(row.divYield),
  };
}

export interface VixSummary {
  latest: number | null;
  /** Mean close over the returned window, SKIPPING sessions with no close. */
  mean: number | null;
  /** Sessions that actually contributed to `mean`. */
  n: number;
  min: number | null;
  max: number | null;
  /** latest − mean; null when either side is unknown. */
  vsMean: number | null;
}

/** Headline stats over VIX rows. Input newest-first (the reader's order). */
export function summarizeVix(rows: readonly VixRow[]): VixSummary {
  let sum = 0;
  let n = 0;
  let min: number | null = null;
  let max: number | null = null;
  for (const r of rows) {
    if (r.close === null) continue;
    sum += r.close;
    n++;
    if (min === null || r.close < min) min = r.close;
    if (max === null || r.close > max) max = r.close;
  }
  const latest = rows[0]?.close ?? null;
  const mean = n === 0 ? null : Math.round((sum / n) * 10_000) / 10_000;
  return {
    latest,
    mean,
    n,
    min,
    max,
    vsMean:
      latest === null || mean === null
        ? null
        : Math.round((latest - mean) * 10_000) / 10_000,
  };
}
