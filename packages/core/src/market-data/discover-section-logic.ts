/**
 * Pure read-side helpers for the DISCOVER data-engine surfaces — MONEY-1204
 * (P14 / 14d.2 · 14d.3 · 14d.5 · 14d.6).
 *
 * Four surfaces, one module, because they share the same four hazards and it is
 * cheaper to solve each once than four times:
 *
 *   14d.2  `InstitutionalFlow` + `MarketPositioning` + `MacroSeries`
 *          → the three markets-page widgets
 *   14d.3  `UpcomingIpo`      → /discover/ipo (upcoming | current | listed)
 *   14d.5  `NseCircular`      → /discover/circulars + the per-stock SURV strip
 *   14d.6  `IndexConstituent` + `IndexMembership` + `IndexClose`
 *          → /discover/indices/[slug]
 *
 * ## Hazard 1 — a missing session is not a zero
 *
 * Every series here is published per TRADING day, and trading days have holes:
 * holidays, a late publication, a feed the archive missed. The tempting shape
 * is a calendar-indexed array with the gaps filled in, and it is wrong in a way
 * that never surfaces as an error — a 20-session cumulative over a calendar
 * window silently averages in zeros and drags every figure toward the middle.
 * {@link buildInstitutionalFlowSection} therefore counts SESSIONS PRESENT, not
 * days elapsed, and reports `windowComplete` so a short window is stated rather
 * than implied.
 *
 * ## Hazard 2 — two grains in one table
 *
 * `MarketPositioning` holds the participant feed (`metric: "OI" | "VOLUME"`,
 * buckets `FUT_IDX`…) AND `nse-fii-stats` (`metric: "FII_STATS"`, buckets
 * `IDX_FUT`… plus per-underlying breakdowns like `IDX_OPT:NIFTY`). They
 * describe the same participant on the same days in incompatible units:
 * contract counts vs contract counts AND rupees, totals vs totals-plus-children.
 * A read with no `metric` filter mixes both; a `sum()` over the mixed set
 * double-counts every index. Neither raises anything. So the metric filter is
 * mandatory at the query (the service) AND re-checked here
 * ({@link checkPositioningGrain}, {@link sumPositioningField}), because a widget
 * that is correct only while its caller is careful is not correct.
 *
 * ## Hazard 3 — the IST calendar day
 *
 * `UpcomingIpo.issueEnd` is UTC midnight of the IST closing day. Comparing that
 * instant against `Date.now()` marks the issue closed at 00:00 UTC — 05:30 IST
 * — so an IPO vanishes from "currently bidding" for the whole of its own final
 * day, during the exact hours anyone would look. Every date question in this
 * module is answered on IST DATE KEYS (`YYYY-MM-DD` via {@link toIstDateKey}),
 * never on instants. See {@link classifyIpoPhase}.
 *
 * ## Hazard 4 — `-` is not 0
 *
 * `IndexClose.pe/pb/divYield/volume/turnoverCr` are nullable and null means NOT
 * REPORTED: a volatility or dividend-points index has no basket to value. A 0
 * P/E reads as a screaming-cheap index. `IndexConstituent.weightBps` is null on
 * every archive-derived row (NSE's list files publish no weight), so a 0%
 * weight would be a fabrication too. Absence propagates as null through here
 * and is rendered as `—` at the boundary.
 */

import { finiteOrNull, isoOrNull, textOrNull } from "./stock-section-logic";
import { toIstDateKey } from "./nse-holidays";
import { FII_STATS_METRIC, isFiiStatsTotal } from "./fii-stats-logic";

// ─── Shared primitives ───────────────────────────────────────────────

/** Round to `dp` decimals, preserving null. Never turns null into 0. */
function round(n: number | null, dp = 2): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * IST calendar day of a stored instant, as `YYYY-MM-DD`.
 *
 * The ONLY date primitive this module compares on. `toIstDateKey` adds +5:30
 * manually rather than trusting the host TZ, which is what makes the answer the
 * same on a Mumbai laptop, a UTC Cloud Run container and a Vercel edge region.
 */
export function istDayKey(v: Date | string | number): string | null {
  const iso = isoOrNull(v);
  return iso === null ? null : toIstDateKey(new Date(iso));
}

/** `YYYY-MM-DD` shifted by whole IST days. Used for "last N days" windows. */
export function shiftDayKey(key: string, days: number): string {
  const t = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return key;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════
// 14d.2 (a) — FII/DII cash flows
// ════════════════════════════════════════════════════════════════════

/**
 * The `InstitutionalFlow` columns this widget reads.
 *
 * Money is in ₹ CRORE — NSE's own unit, stored unconverted (see the model's
 * `buyValue` comment). It is NOT rescaled here either: converting to rupees
 * would multiply by 1e7 and produce figures no Indian reader recognises, and
 * converting to "₹ Cr" twice is how a display ends up off by a crore. The unit
 * travels with the data in {@link InstitutionalFlowSection.unit} and in the
 * `Cr` field-name suffix, so a consumer that drops the label still cannot
 * mistake the scale.
 */
export interface InstitutionalFlowInput {
  date: Date | string | number;
  /** "FII" | "DII" — FPI is folded into FII upstream. */
  category: string;
  /** "CASH" | "FNO". */
  segment: string;
  buyValue?: number | null;
  sellValue?: number | null;
  netValue?: number | null;
}

/** One session of one (category, segment) series. All money ₹ crore. */
export interface FlowDayPoint {
  /** IST trading day, `YYYY-MM-DD`. */
  date: string;
  netCr: number | null;
  buyCr: number | null;
  sellCr: number | null;
}

export interface FlowSeries {
  category: string;
  segment: string;
  /** Newest session, or null when the series has none. */
  latest: FlowDayPoint | null;
  /**
   * Sum of `netCr` over the trailing `windowSessions` sessions PRESENT.
   *
   * Null — not 0 — when no session in the window carried a net. Zero is a real,
   * published reading (a day FIIs bought and sold the same rupee amount) and
   * must stay distinguishable from "we hold nothing".
   */
  cumulativeNetCr: number | null;
  /** How many sessions actually contributed. Never inferred from the window. */
  sessionsCounted: number;
  /** What was asked for. `sessionsCounted < windowSessions` ⇒ short window. */
  windowSessions: number;
  /** False when the series has fewer sessions than the window requested. */
  windowComplete: boolean;
  /** Oldest→newest nets over the window, for the sparkline. Gaps are ABSENT. */
  spark: number[];
  /** Oldest→newest points over the window. */
  points: FlowDayPoint[];
}

export interface InstitutionalFlowSection {
  /** ₹ crore, always. Carried so a renderer cannot guess wrong. */
  unit: "INR_CRORE";
  windowSessions: number;
  series: FlowSeries[];
  /** Newest IST day across every series, ISO-day form. */
  asOf: string | null;
}

/** Order the widget renders in; anything else follows alphabetically. */
const FLOW_CATEGORY_ORDER = ["FII", "DII"] as const;

/**
 * Group flows into per-(category, segment) series with a trailing cumulative.
 *
 * THE RULE THIS ENCODES: the window is counted in SESSIONS PRESENT, not in
 * calendar days. Given rows for 21 trading days with the 10th missing, the
 * 20-session cumulative is the sum of the 20 most recent rows that EXIST — it
 * does not reach back a 21st day to make the count up, and it does not insert a
 * 0 for the hole. Both alternatives are wrong in the same direction: they let a
 * gap in the feed masquerade as a flat session, and "FIIs did nothing that day"
 * is a claim the data never made.
 *
 * Duplicate (date, category, segment) rows collapse to the LAST one seen. The
 * DB's unique makes that unreachable in practice; it is here because the one
 * thing that would silently double a cumulative is a re-run appending instead
 * of upserting, and a defensive `Map` costs nothing.
 */
export function buildInstitutionalFlowSection(
  rows: ReadonlyArray<InstitutionalFlowInput>,
  opts: { windowSessions?: number } = {},
): InstitutionalFlowSection {
  const windowSessions = Math.max(1, Math.trunc(opts.windowSessions ?? 20));

  // key = `${category}|${segment}` → dayKey → point
  const byKey = new Map<string, Map<string, FlowDayPoint>>();
  for (const r of rows) {
    const date = istDayKey(r.date);
    const category = textOrNull(r.category)?.toUpperCase();
    const segment = textOrNull(r.segment)?.toUpperCase() ?? "CASH";
    if (date === null || !category) continue;
    const key = `${category}|${segment}`;
    let days = byKey.get(key);
    if (!days) {
      days = new Map();
      byKey.set(key, days);
    }
    days.set(date, {
      date,
      netCr: finiteOrNull(r.netValue),
      buyCr: finiteOrNull(r.buyValue),
      sellCr: finiteOrNull(r.sellValue),
    });
  }

  const series: FlowSeries[] = [];
  let asOf: string | null = null;

  for (const [key, days] of byKey) {
    const [category = "", segment = "CASH"] = key.split("|");
    // Ascending by IST day key. String compare is correct for `YYYY-MM-DD`.
    const ordered = [...days.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    if (ordered.length === 0) continue;

    // The trailing window over PRESENT sessions — a plain slice of the sorted
    // rows, which is exactly why a hole cannot be filled with a zero: a day
    // with no row is simply not an element.
    const windowPoints = ordered.slice(-windowSessions);
    const nets = windowPoints
      .map((p) => p.netCr)
      .filter((n): n is number => n !== null);

    const latest = ordered[ordered.length - 1] ?? null;
    if (latest && (asOf === null || latest.date > asOf)) asOf = latest.date;

    series.push({
      category,
      segment,
      latest,
      cumulativeNetCr:
        nets.length === 0 ? null : round(nets.reduce((a, b) => a + b, 0)),
      sessionsCounted: nets.length,
      windowSessions,
      windowComplete: windowPoints.length >= windowSessions,
      spark: nets,
      points: windowPoints,
    });
  }

  series.sort((a, b) => {
    const ai = FLOW_CATEGORY_ORDER.indexOf(
      a.category as (typeof FLOW_CATEGORY_ORDER)[number],
    );
    const bi = FLOW_CATEGORY_ORDER.indexOf(
      b.category as (typeof FLOW_CATEGORY_ORDER)[number],
    );
    const ar = ai === -1 ? FLOW_CATEGORY_ORDER.length : ai;
    const br = bi === -1 ? FLOW_CATEGORY_ORDER.length : bi;
    if (ar !== br) return ar - br;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.segment.localeCompare(b.segment);
  });

  return { unit: "INR_CRORE", windowSessions, series, asOf };
}

// ════════════════════════════════════════════════════════════════════
// 14d.2 (b) — participant positioning
// ════════════════════════════════════════════════════════════════════

/** The four NSE participant categories the toggle offers. */
export const POSITIONING_PARTICIPANT_ORDER = [
  "FII",
  "DII",
  "CLIENT",
  "PRO",
] as const;
export type PositioningParticipant =
  (typeof POSITIONING_PARTICIPANT_ORDER)[number];

/**
 * The metrics the PARTICIPANT feed publishes.
 *
 * `FII_STATS` is deliberately NOT here. It is a different feed with a different
 * bucket namespace and rupee columns the participant files do not have; it
 * shares this table only because it describes the same participant on the same
 * days. Listing it as a participant metric is precisely the mix this module
 * exists to prevent.
 */
export const PARTICIPANT_METRICS = ["OI", "VOLUME"] as const;
export type ParticipantMetric = (typeof PARTICIPANT_METRICS)[number];

/** The `MarketPositioning` columns read here. Rupee columns are FII_STATS-only. */
export interface PositioningRowInput {
  date: Date | string | number;
  participant: string;
  bucket: string;
  metric: string;
  longQty?: number | null;
  shortQty?: number | null;
  netQty?: number | null;
  longValue?: number | null;
  shortValue?: number | null;
  netValue?: number | null;
  openInterestQty?: number | null;
  openInterestValue?: number | null;
}

/** What a mixed-grain row set looks like, and why it cannot be summed. */
export interface PositioningGrainCheck {
  /** Distinct `metric` values present, sorted. */
  metrics: string[];
  /** More than one metric ⇒ contract counts and rupees in one pile. */
  mixedMetrics: boolean;
  /**
   * True when the set holds BOTH a `nse-fii-stats` total (bucket without `:`)
   * and at least one per-underlying breakdown (bucket with `:`). Summing that
   * set counts every index twice.
   */
  mixedGrain: boolean;
  /** False when either hazard is present. */
  ok: boolean;
}

/** Is this bucket a per-underlying BREAKDOWN of a `nse-fii-stats` total? */
export function isPositioningBreakdown(bucket: string): boolean {
  return !isFiiStatsTotal(String(bucket ?? ""));
}

/**
 * Detect the two ways this table double-counts.
 *
 * Deliberately a REPORT rather than a throw. A caller that has legitimately
 * fetched both grains (an ops sweep, a "what do we hold for day D" panel) is
 * not doing anything wrong; what is wrong is aggregating across them. So the
 * check names the hazard and {@link sumPositioningField} refuses to produce a
 * number when it is present.
 */
export function checkPositioningGrain(
  rows: ReadonlyArray<PositioningRowInput>,
): PositioningGrainCheck {
  const metrics = new Set<string>();
  let hasTotal = false;
  let hasBreakdown = false;
  for (const r of rows) {
    const m = textOrNull(r.metric);
    if (m) metrics.add(m);
    const bucket = String(r.bucket ?? "");
    if (bucket === "") continue;
    if (isPositioningBreakdown(bucket)) hasBreakdown = true;
    else hasTotal = true;
  }
  const list = [...metrics].sort();
  const mixedMetrics = list.length > 1;
  const mixedGrain = hasTotal && hasBreakdown;
  return {
    metrics: list,
    mixedMetrics,
    mixedGrain,
    ok: !mixedMetrics && !mixedGrain,
  };
}

/** Why a sum refused to produce a number. */
export type PositioningSumBlock = "MIXED_METRIC" | "MIXED_GRAIN";

export interface PositioningSum {
  /** Null whenever `blocked` is set — never a partial or "best effort" total. */
  value: number | null;
  rowsUsed: number;
  rowsSkipped: number;
  blocked: PositioningSumBlock | null;
}

/**
 * Sum one numeric column across positioning rows, or refuse.
 *
 * Refuses (value `null`) when the set mixes metrics or mixes total/breakdown
 * grain. Returning a number in either case is the failure mode: it is plausible,
 * it is roughly double, and nothing downstream can tell.
 */
export function sumPositioningField(
  rows: ReadonlyArray<PositioningRowInput>,
  field: keyof Omit<
    PositioningRowInput,
    "date" | "participant" | "bucket" | "metric"
  >,
): PositioningSum {
  const grain = checkPositioningGrain(rows);
  if (grain.mixedMetrics)
    return {
      value: null,
      rowsUsed: 0,
      rowsSkipped: rows.length,
      blocked: "MIXED_METRIC",
    };
  if (grain.mixedGrain)
    return {
      value: null,
      rowsUsed: 0,
      rowsSkipped: rows.length,
      blocked: "MIXED_GRAIN",
    };

  let sum = 0;
  let used = 0;
  let skipped = 0;
  for (const r of rows) {
    const v = finiteOrNull(r[field]);
    if (v === null) {
      skipped += 1;
      continue;
    }
    sum += v;
    used += 1;
  }
  return {
    value: used === 0 ? null : round(sum),
    rowsUsed: used,
    rowsSkipped: skipped,
    blocked: null,
  };
}

/**
 * Filter to ONE metric, and optionally one participant / bucket.
 *
 * The filter is not optional and has no "all metrics" mode on purpose. Every
 * caller in this lane wants one grain; making the mixed read unspellable here
 * means the only way to get it is to write a raw query, which is visible in
 * review.
 */
export function selectPositioningRows(
  rows: ReadonlyArray<PositioningRowInput>,
  sel: { metric: string; participant?: string; bucket?: string },
): PositioningRowInput[] {
  const metric = String(sel.metric ?? "").toUpperCase();
  const participant = sel.participant
    ? String(sel.participant).toUpperCase()
    : null;
  const bucket = sel.bucket ? String(sel.bucket).toUpperCase() : null;
  return rows.filter((r) => {
    if (String(r.metric ?? "").toUpperCase() !== metric) return false;
    if (
      participant &&
      String(r.participant ?? "").toUpperCase() !== participant
    )
      return false;
    if (bucket && String(r.bucket ?? "").toUpperCase() !== bucket) return false;
    return true;
  });
}

/** One derivative leg for the selected participant on the latest day. */
export interface PositioningLeg {
  bucket: string;
  label: string;
  longQty: number | null;
  shortQty: number | null;
  netQty: number | null;
  /** `netQty` minus the previous session's, or null when there is no prior day. */
  netChange: number | null;
  /** long / (long + short) as a percentage. Null when neither side is known. */
  longSharePct: number | null;
}

export interface PositioningSection {
  participant: string;
  metric: string;
  /** IST day the legs describe. */
  date: string | null;
  /** The session `netChange` was measured against. Null ⇒ no prior session. */
  previousDate: string | null;
  legs: PositioningLeg[];
  /** Grain report for the rows this was built from. `ok:false` ⇒ empty legs. */
  grain: PositioningGrainCheck;
}

const BUCKET_LABELS: Readonly<Record<string, string>> = {
  FUT_IDX: "Index futures",
  FUT_STK: "Stock futures",
  OPT_IDX_CALL: "Index calls",
  OPT_IDX_PUT: "Index puts",
  OPT_STK_CALL: "Stock calls",
  OPT_STK_PUT: "Stock puts",
};

/** Render order — futures first, then index options, then stock options. */
const BUCKET_ORDER = [
  "FUT_IDX",
  "FUT_STK",
  "OPT_IDX_CALL",
  "OPT_IDX_PUT",
  "OPT_STK_CALL",
  "OPT_STK_PUT",
];

/** Human label for a participant bucket; unknown codes pass through. */
export function positioningBucketLabel(bucket: string): string {
  const key = String(bucket ?? "").trim();
  if (key === "") return "";
  return BUCKET_LABELS[key.toUpperCase()] ?? key;
}

/**
 * Latest-day legs for one participant, plus the day-on-day change in net.
 *
 * REFUSES to build legs when the incoming rows mix metrics or grains — the
 * section comes back with `grain.ok === false` and no legs, which the UI shows
 * as an explicit "cannot render" rather than as a plausible chart. That is the
 * belt to the service's braces: the query filters `metric` and this rejects the
 * row set that proves it did not.
 *
 * `netChange` is measured against the PREVIOUS DAY PRESENT in the rows, not
 * against "yesterday" — a Monday's change is versus Friday, and a change versus
 * a holiday is not a thing that exists.
 */
export function buildPositioningSection(
  rows: ReadonlyArray<PositioningRowInput>,
  sel: { participant: string; metric: string },
): PositioningSection {
  const participant = String(sel.participant ?? "").toUpperCase();
  const metric = String(sel.metric ?? "").toUpperCase();
  const selected = selectPositioningRows(rows, { metric, participant });
  const grain = checkPositioningGrain(selected);

  const empty: PositioningSection = {
    participant,
    metric,
    date: null,
    previousDate: null,
    legs: [],
    grain,
  };
  if (!grain.ok || selected.length === 0) return empty;

  // day → bucket → row
  const byDay = new Map<string, Map<string, PositioningRowInput>>();
  for (const r of selected) {
    const day = istDayKey(r.date);
    const bucket = textOrNull(r.bucket)?.toUpperCase();
    if (day === null || !bucket) continue;
    let buckets = byDay.get(day);
    if (!buckets) {
      buckets = new Map();
      byDay.set(day, buckets);
    }
    buckets.set(bucket, r);
  }
  const days = [...byDay.keys()].sort();
  const latestDay = days[days.length - 1];
  if (latestDay === undefined) return empty;
  const prevDay = days.length >= 2 ? (days[days.length - 2] ?? null) : null;

  const latest = byDay.get(latestDay);
  const prev = prevDay === null ? null : (byDay.get(prevDay) ?? null);
  if (!latest) return empty;

  const legs: PositioningLeg[] = [];
  for (const [bucket, row] of latest) {
    const longQty = finiteOrNull(row.longQty);
    const shortQty = finiteOrNull(row.shortQty);
    const netQty =
      finiteOrNull(row.netQty) ??
      (longQty !== null && shortQty !== null ? longQty - shortQty : null);
    const prevRow = prev?.get(bucket) ?? null;
    const prevNet = prevRow === null ? null : finiteOrNull(prevRow.netQty);
    const gross =
      longQty !== null && shortQty !== null ? longQty + shortQty : null;
    legs.push({
      bucket,
      label: positioningBucketLabel(bucket),
      longQty,
      shortQty,
      netQty,
      netChange:
        netQty !== null && prevNet !== null ? round(netQty - prevNet) : null,
      longSharePct:
        gross !== null && gross > 0 && longQty !== null
          ? round((longQty / gross) * 100)
          : null,
    });
  }

  legs.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    const ar = ai === -1 ? BUCKET_ORDER.length : ai;
    const br = bi === -1 ? BUCKET_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return a.bucket.localeCompare(b.bucket);
  });

  return {
    participant,
    metric,
    date: latestDay,
    previousDate: prevDay,
    legs,
    grain,
  };
}

/** Re-exported so a caller never has to spell the FII_STATS metric by hand. */
export { FII_STATS_METRIC };

// ════════════════════════════════════════════════════════════════════
// 14d.2 (c) — macro strip
// ════════════════════════════════════════════════════════════════════

/** The `MacroSeries` columns the strip reads. */
export interface MacroSeriesInput {
  seriesId: string;
  period: Date | string | number;
  value?: number | null;
  unit?: string | null;
  frequency?: string | null;
  label?: string | null;
  releasedOn?: Date | string | number | null;
}

/** Why a strip item has no number. Never collapsed into a 0. */
export type MacroUnavailable = "NO_DATA" | "NO_BASE" | "REBASE";

export interface MacroStripItem {
  seriesId: string;
  /** Display name for the tile, e.g. "Repo rate". */
  title: string;
  /** LEVEL renders `value` as published; YOY renders a year-on-year change. */
  kind: "LEVEL" | "YOY";
  value: number | null;
  unit: string | null;
  /**
   * THIS item's own period, ISO day. Each series has its own vintage — the repo
   * rate is a weekly reading, CPI is a month old by the time it prints, forex
   * reserves are a Friday snapshot. One shared "as of" over the strip would
   * misdescribe at least two of the four every single day, so there is no
   * section-level date and the renderer must show these.
   */
  period: string | null;
  /** When the source PUBLISHED it, when known. Different fact from `period`. */
  releasedOn: string | null;
  frequency: string | null;
  /** For YOY: the period the base observation came from. */
  basePeriod: string | null;
  /** Set when `value` is null, saying WHY. */
  unavailable: MacroUnavailable | null;
}

export interface MacroStrip {
  items: MacroStripItem[];
  /** Newest period across the strip — for the envelope only, never a tile. */
  newestPeriod: string | null;
}

/** What the markets strip shows, in order. */
export const MACRO_STRIP_SPEC: ReadonlyArray<{
  seriesId: string;
  title: string;
  kind: "LEVEL" | "YOY";
}> = [
  { seriesId: "RBI_REPO_RATE", title: "Repo rate", kind: "LEVEL" },
  { seriesId: "MOSPI_CPI_COMBINED", title: "CPI inflation", kind: "YOY" },
  { seriesId: "OEA_WPI_ALL_COMMODITIES", title: "WPI inflation", kind: "YOY" },
  {
    seriesId: "RBI_FOREX_RESERVES_TOTAL_USD_MN",
    title: "Forex reserves",
    kind: "LEVEL",
  },
];

/** Every seriesId the strip needs — the service's `IN` list. */
export const MACRO_STRIP_SERIES_IDS: readonly string[] = MACRO_STRIP_SPEC.map(
  (s) => s.seriesId,
);

/** A year-on-year change computed from two index LEVELS. */
export interface MacroYoy {
  yoyPct: number | null;
  latestPeriod: string | null;
  basePeriod: string | null;
  /** True when the base observation carries a DIFFERENT raw label. */
  rebased: boolean;
  unavailable: MacroUnavailable | null;
}

/** Month distance between two ISO day keys, base-year aware. */
function monthsBetween(fromKey: string, toKey: string): number {
  const fy = Number(fromKey.slice(0, 4));
  const fm = Number(fromKey.slice(5, 7));
  const ty = Number(toKey.slice(0, 4));
  const tm = Number(toKey.slice(5, 7));
  if (![fy, fm, ty, tm].every(Number.isFinite)) return NaN;
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Year-on-year percentage change of an INDEX series.
 *
 * CPI and WPI are stored as index LEVELS (unit `INDEX`), so "CPI inflation" is
 * not a column — it is this arithmetic against the observation twelve months
 * back. Three refusals, all returning null rather than a number:
 *
 *   NO_DATA  fewer than one observation;
 *   NO_BASE  no observation exactly twelve months before the latest. Reaching
 *            for "the nearest older one" instead would silently compute an
 *            11- or 14-month change and label it annual;
 *   REBASE   the base observation's RAW label differs from the latest's. The
 *            label carries the base year ("(2022-23=100)"), and a rebase is a
 *            level discontinuity — the ratio across it is arithmetic on two
 *            different scales. `MacroSeries.label` exists for exactly this;
 *            `normaliseMacroLabel` strips the parenthetical so the SERIES keeps
 *            flowing, which is right for storage and wrong to reuse here.
 */
export function computeMacroYoy(
  points: ReadonlyArray<MacroSeriesInput>,
): MacroYoy {
  const clean = points
    .map((p) => ({
      key: istDayKey(p.period),
      value: finiteOrNull(p.value),
      label: textOrNull(p.label),
    }))
    .filter(
      (p): p is { key: string; value: number | null; label: string | null } =>
        p.key !== null,
    )
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const latest = clean[clean.length - 1];
  if (!latest || latest.value === null) {
    return {
      yoyPct: null,
      latestPeriod: latest?.key ?? null,
      basePeriod: null,
      rebased: false,
      unavailable: "NO_DATA",
    };
  }

  const base = clean.find(
    (p) => monthsBetween(p.key, latest.key) === 12 && p.value !== null,
  );
  if (!base || base.value === null || base.value === 0) {
    return {
      yoyPct: null,
      latestPeriod: latest.key,
      basePeriod: base?.key ?? null,
      rebased: false,
      unavailable: "NO_BASE",
    };
  }

  const rebased = (base.label ?? "") !== (latest.label ?? "");
  if (rebased) {
    return {
      yoyPct: null,
      latestPeriod: latest.key,
      basePeriod: base.key,
      rebased: true,
      unavailable: "REBASE",
    };
  }

  return {
    yoyPct: round(((latest.value - base.value) / base.value) * 100),
    latestPeriod: latest.key,
    basePeriod: base.key,
    rebased: false,
    unavailable: null,
  };
}

/**
 * Build the four-tile macro strip.
 *
 * Every tile carries its OWN `period`. There is no section-level "as of" and
 * that is the point: the repo rate can be three days old while CPI is six weeks
 * old, and one shared timestamp would present the older as fresh.
 */
export function buildMacroStrip(
  rows: ReadonlyArray<MacroSeriesInput>,
  spec: ReadonlyArray<{
    seriesId: string;
    title: string;
    kind: "LEVEL" | "YOY";
  }> = MACRO_STRIP_SPEC,
): MacroStrip {
  const bySeries = new Map<string, MacroSeriesInput[]>();
  for (const r of rows) {
    const id = textOrNull(r.seriesId);
    if (!id) continue;
    const list = bySeries.get(id);
    if (list) list.push(r);
    else bySeries.set(id, [r]);
  }

  const items: MacroStripItem[] = [];
  let newestPeriod: string | null = null;

  for (const s of spec) {
    const points = (bySeries.get(s.seriesId) ?? [])
      .map((p) => ({ p, key: istDayKey(p.period) }))
      .filter((x): x is { p: MacroSeriesInput; key: string } => x.key !== null)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const newest = points[points.length - 1];

    if (newest && (newestPeriod === null || newest.key > newestPeriod)) {
      newestPeriod = newest.key;
    }

    if (s.kind === "YOY") {
      const yoy = computeMacroYoy(points.map((x) => x.p));
      items.push({
        seriesId: s.seriesId,
        title: s.title,
        kind: "YOY",
        value: yoy.yoyPct,
        // A year-on-year change is a percentage regardless of the level's own
        // unit (INDEX), so the tile does NOT inherit `unit` from the row.
        unit: "PERCENT",
        period: yoy.latestPeriod,
        releasedOn: newest ? isoOrNull(newest.p.releasedOn ?? null) : null,
        frequency: newest ? textOrNull(newest.p.frequency) : null,
        basePeriod: yoy.basePeriod,
        unavailable: yoy.unavailable,
      });
      continue;
    }

    const value = newest ? finiteOrNull(newest.p.value) : null;
    items.push({
      seriesId: s.seriesId,
      title: s.title,
      kind: "LEVEL",
      value,
      unit: newest ? textOrNull(newest.p.unit) : null,
      period: newest?.key ?? null,
      releasedOn: newest ? isoOrNull(newest.p.releasedOn ?? null) : null,
      frequency: newest ? textOrNull(newest.p.frequency) : null,
      basePeriod: null,
      unavailable: value === null ? "NO_DATA" : null,
    });
  }

  return { items, newestPeriod };
}

// ════════════════════════════════════════════════════════════════════
// 14d.3 — IPO windows
// ════════════════════════════════════════════════════════════════════

/**
 * UPCOMING  bidding has not opened
 * CURRENT   `issueStart <= today <= issueEnd`, all in IST
 * RECENT    listed, or closed, within the lookback window
 */
export type IpoPhase = "UPCOMING" | "CURRENT" | "RECENT";

/** The `UpcomingIpo` columns the page reads. EVERY date/price is nullable. */
export interface UpcomingIpoInput {
  symbol: string;
  companyName?: string | null;
  series?: string | null;
  isSme?: boolean | null;
  issueStart?: Date | string | number | null;
  issueEnd?: Date | string | number | null;
  listingDate?: Date | string | number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  issueSize?: number | null;
  lotSize?: number | null;
  status?: string | null;
}

export interface IpoView {
  symbol: string;
  companyName: string | null;
  series: string | null;
  isSme: boolean;
  /** IST day keys, `YYYY-MM-DD`, or null when NSE has not fixed the date. */
  issueStart: string | null;
  issueEnd: string | null;
  listingDate: string | null;
  /** Band ends. Null is "not announced" — NEVER 0, which reads as a free issue. */
  priceMin: number | null;
  priceMax: number | null;
  /** AS PRINTED by NSE; the unit is not normalised upstream, so not here either. */
  issueSize: number | null;
  lotSize: number | null;
  /** NSE's own stamp, kept for display; never used to place the row. */
  status: string | null;
  phase: IpoPhase | null;
  /** Whole IST days until open (UPCOMING) or until close (CURRENT). */
  daysToOpen: number | null;
  daysToClose: number | null;
  /** True on the final bidding day — the one the UTC bug hides. */
  closesToday: boolean;
}

export interface IpoSections {
  /** The IST day every classification was made against. */
  today: string;
  upcoming: IpoView[];
  current: IpoView[];
  /** Listed or closed within `recentDays`. */
  recent: IpoView[];
  /**
   * Rows with NO usable date and NO usable status. Surfaced, never dropped —
   * a forthcoming issue whose dates NSE has not fixed is real (`firstSeenAt`
   * exists to track exactly those).
   *
   * Deliberately NOT the same bucket as an old listing. Conflating "we cannot
   * place this" with "this is older than the tab shows" puts every IPO in
   * history into a section headed "dates not announced", which is both wrong
   * and unbounded.
   */
  unplaced: IpoView[];
  /** Placed as RECENT but older than the window. Counted so nothing vanishes silently. */
  archivedCount: number;
}

/** How far back a listing still counts as "recently listed". */
export const IPO_RECENT_DAYS = 30;

function daysBetweenKeys(fromKey: string, toKey: string): number | null {
  const a = Date.parse(`${fromKey}T00:00:00.000Z`);
  const b = Date.parse(`${toKey}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Place one IPO against an IST calendar day.
 *
 * THE BUG THIS ENCODES AGAINST: `issueEnd` is UTC midnight of the IST closing
 * day, so `issueEnd >= new Date()` goes false at 00:00 UTC — 05:30 IST — and
 * the issue disappears from "currently bidding" for the entirety of its own
 * last day. Comparing IST DATE KEYS instead makes the window inclusive at both
 * ends of the day the exchange means, and makes the answer independent of the
 * server's timezone.
 *
 * Dates are authoritative; `status` is the fallback and only when BOTH window
 * dates are missing. The column is stamped by whichever sync endpoint won the
 * merge and goes stale between runs, so trusting it over a date NSE actually
 * published would let a finished issue keep advertising itself as open.
 *
 * PHASE ONLY — the recency WINDOW is not applied here. An issue that closed in
 * January is `RECENT` (it is in the past) and it is {@link bucketIpos} that
 * decides the "recently listed" tab shows 30 days of it. Folding the window in
 * here made a January listing return null, which put it in `unplaced` alongside
 * the genuinely un-dated rows — so a tab meaning "dates not announced" filled
 * up with every IPO in recorded history. Classification and windowing are
 * separate questions and are kept separate.
 *
 * Returns null ONLY when the row can be placed by neither a date nor a status.
 */
export function classifyIpoPhase(
  row: UpcomingIpoInput,
  todayKey: string,
): IpoPhase | null {
  const start = row.issueStart == null ? null : istDayKey(row.issueStart);
  const end = row.issueEnd == null ? null : istDayKey(row.issueEnd);
  const listing = row.listingDate == null ? null : istDayKey(row.listingDate);

  // A listing that has already happened is settled history, whatever the
  // window said — an extended issue can list after a `status` still reads OPEN.
  if (listing !== null && listing <= todayKey) return "RECENT";

  if (start !== null && end !== null) {
    if (todayKey < start) return "UPCOMING";
    return todayKey <= end ? "CURRENT" : "RECENT";
  }
  if (start !== null) return todayKey < start ? "UPCOMING" : "CURRENT";
  if (end !== null) return todayKey <= end ? "CURRENT" : "RECENT";

  // No window at all. NSE's own stamp is all that is left.
  const status = textOrNull(row.status)?.toUpperCase();
  if (status === "OPEN") return "CURRENT";
  if (status === "UPCOMING") return "UPCOMING";
  if (status === "LISTED") return "RECENT";
  return null;
}

/** Shape one row for the page, preserving every absence. */
export function toIpoView(row: UpcomingIpoInput, todayKey: string): IpoView {
  const issueStart = row.issueStart == null ? null : istDayKey(row.issueStart);
  const issueEnd = row.issueEnd == null ? null : istDayKey(row.issueEnd);
  const listingDate =
    row.listingDate == null ? null : istDayKey(row.listingDate);
  const phase = classifyIpoPhase(row, todayKey);
  return {
    symbol: String(row.symbol ?? "").toUpperCase(),
    companyName: textOrNull(row.companyName),
    series: textOrNull(row.series),
    isSme: row.isSme === true,
    issueStart,
    issueEnd,
    listingDate,
    priceMin: finiteOrNull(row.priceMin),
    priceMax: finiteOrNull(row.priceMax),
    issueSize: finiteOrNull(row.issueSize),
    lotSize: finiteOrNull(row.lotSize),
    status: textOrNull(row.status),
    phase,
    daysToOpen:
      issueStart !== null && issueStart > todayKey
        ? daysBetweenKeys(todayKey, issueStart)
        : null,
    daysToClose:
      issueEnd !== null && issueEnd >= todayKey
        ? daysBetweenKeys(todayKey, issueEnd)
        : null,
    closesToday: issueEnd !== null && issueEnd === todayKey,
  };
}

/**
 * Split IPO rows into the three tabs, against an IST calendar day.
 *
 * `todayKey` is a parameter, not `new Date()` inside the function, so the
 * boundary is testable at both ends without freezing the clock — and so the
 * service resolves "today" ONCE for a request instead of drifting between two
 * calls that straddled midnight.
 */
export function bucketIpos(
  rows: ReadonlyArray<UpcomingIpoInput>,
  opts: { today: Date | string | number; recentDays?: number },
): IpoSections {
  const todayKey = istDayKey(opts.today) ?? toIstDateKey(new Date());
  const recentDays = Math.max(
    0,
    Math.trunc(opts.recentDays ?? IPO_RECENT_DAYS),
  );
  const cutoff = shiftDayKey(todayKey, -recentDays);
  const views = rows.map((r) => toIpoView(r, todayKey));

  const upcoming = views.filter((v) => v.phase === "UPCOMING");
  const current = views.filter((v) => v.phase === "CURRENT");
  // The window is applied HERE, not in the classifier — an issue outside it is
  // still correctly placed in the past, it is simply older than this tab shows.
  const past = views.filter((v) => v.phase === "RECENT");
  const inWindow = (v: IpoView) =>
    (v.listingDate ?? v.issueEnd ?? "") >= cutoff;
  const recent = past.filter(inWindow);
  const archivedCount = past.length - recent.length;
  const unplaced = views.filter((v) => v.phase === null);

  // Soonest first for the two forward tabs; newest first for history.
  const asc = (a: string | null, b: string | null) =>
    (a ?? "9999-99-99").localeCompare(b ?? "9999-99-99");
  upcoming.sort((a, b) => asc(a.issueStart, b.issueStart));
  current.sort((a, b) => asc(a.issueEnd, b.issueEnd));
  recent.sort((a, b) =>
    (b.listingDate ?? b.issueEnd ?? "").localeCompare(
      a.listingDate ?? a.issueEnd ?? "",
    ),
  );

  return {
    today: todayKey,
    upcoming,
    current,
    recent,
    unplaced,
    archivedCount,
  };
}

/** The dashboard card payload — only meaningful while a window is open. */
export interface IpoDashboardCard {
  /** How many issues are accepting bids today. */
  openCount: number;
  /** Issues whose FINAL bidding day is today. The actionable subset. */
  closingToday: IpoView[];
  /** Up to `limit` open issues, closing soonest first. */
  open: IpoView[];
  /** The next issue to open, when nothing is open right now. */
  nextOpen: IpoView | null;
  /** True when there is genuinely nothing to show — mount nothing. */
  empty: boolean;
}

/**
 * Condense the IPO sections into a dashboard card.
 *
 * Returns `empty: true` when no window is open AND nothing is forthcoming, so
 * the dashboard can skip the card entirely rather than render a permanent
 * "no IPOs" tile competing for space with a user's portfolio.
 */
export function buildIpoDashboardCard(
  sections: IpoSections,
  opts: { limit?: number } = {},
): IpoDashboardCard {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 3));
  const open = sections.current.slice(0, limit);
  const nextOpen =
    sections.current.length === 0 ? (sections.upcoming[0] ?? null) : null;
  return {
    openCount: sections.current.length,
    closingToday: sections.current.filter((v) => v.closesToday),
    open,
    nextOpen,
    empty: sections.current.length === 0 && nextOpen === null,
  };
}

// ════════════════════════════════════════════════════════════════════
// 14d.5 — circulars
// ════════════════════════════════════════════════════════════════════

/** The `NseCircular` columns the feed reads. */
export interface NseCircularInput {
  circularNumber: string;
  displayNumber?: string | null;
  department: string;
  category?: string | null;
  subject: string;
  company?: string | null;
  circularDate: Date | string | number;
  topic?: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  approxSizeBytes?: number | null;
}

export interface CircularView {
  /** `circularNumber::department` — the model's OWN unique, see below. */
  key: string;
  circularNumber: string;
  displayNumber: string | null;
  department: string;
  category: string | null;
  subject: string;
  company: string | null;
  /** IST day, `YYYY-MM-DD`. */
  date: string | null;
  topic: string | null;
  fileUrl: string | null;
  fileName: string | null;
  approxSizeBytes: number | null;
}

/**
 * The row's identity, and it is NOT `circularNumber`.
 *
 * NSE re-issues one circular under every department it applies to: measured
 * over one live 237-record window, 205 numbers were distinct and 26 appeared
 * more than once (75736 is filed under both "Listing" and "Emerge" with the
 * same subject). `@@unique([circularNumber, department])` is the model's key
 * for that reason. Using the number alone as a React key or a dedupe key
 * discards half of every re-issued circular, and the survivor looks entirely
 * normal — which is why this is a named function rather than an inline
 * template string somewhere in a component.
 */
export function circularKey(
  row: Pick<NseCircularInput, "circularNumber" | "department">,
): string {
  return `${String(row.circularNumber ?? "").trim()}::${String(row.department ?? "").trim()}`;
}

/** Shape circulars for the feed, newest first, deduped on the real key. */
export function buildCircularFeed(
  rows: ReadonlyArray<NseCircularInput>,
): CircularView[] {
  const seen = new Map<string, CircularView>();
  for (const r of rows) {
    const key = circularKey(r);
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      circularNumber: String(r.circularNumber ?? "").trim(),
      displayNumber: textOrNull(r.displayNumber),
      department: String(r.department ?? "").trim(),
      category: textOrNull(r.category),
      subject: String(r.subject ?? "").trim(),
      company: textOrNull(r.company),
      date: istDayKey(r.circularDate),
      topic: textOrNull(r.topic),
      fileUrl: textOrNull(r.fileUrl),
      fileName: textOrNull(r.fileName),
      approxSizeBytes: finiteOrNull(r.approxSizeBytes),
    });
  }
  return [...seen.values()].sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? ""),
  );
}

/** Departments present in a result set, with counts, for the filter chips. */
export function countCircularDepartments(
  rows: ReadonlyArray<NseCircularInput>,
): Array<{ department: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const d = textOrNull(r.department);
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([department, count]) => ({ department, count }))
    .sort(
      (a, b) => b.count - a.count || a.department.localeCompare(b.department),
    );
}

// ── The SURV symbol heuristic ────────────────────────────────────────

/** How a circular came to be associated with a symbol. */
export type CircularMatchBasis = "COMPANY_FIELD" | "SUBJECT_TOKEN";

export interface CircularSymbolMatch {
  circular: CircularView;
  basis: CircularMatchBasis;
  /**
   * HIGH  the circular's own `company` column names the symbol
   * LOW   the symbol appeared as a bare token in the free-text subject
   *
   * Both are HEURISTIC. Neither may be presented as "this circular is about
   * this stock" — see {@link CIRCULAR_MATCH_DISCLAIMER}.
   */
  confidence: "HIGH" | "LOW";
  /** The token that matched, for a "why am I seeing this" tooltip. */
  matchedOn: string;
}

/**
 * The label the UI MUST render beside these matches.
 *
 * Exported as a constant so the wording cannot drift between the stock page and
 * the circulars page, and so a reviewer can grep for it to prove it is on
 * screen. A string match on a ticker is a guess; presenting a guess as a fact
 * about a specific security is the failure mode that matters here.
 */
export const CIRCULAR_MATCH_DISCLAIMER =
  "Heuristic match — matched by symbol name in the circular text, not by an exchange-provided link.";

/**
 * Minimum symbol length for SUBJECT-text matching.
 *
 * Three characters is the floor, and even that only survives because matching
 * is on TOKENS. Two-character symbols collide with ordinary English ("IT",
 * "ON") often enough that no stopword list rescues them, so they are matched
 * on the `company` column only.
 */
export const MIN_SUBJECT_MATCH_LENGTH = 3;

/**
 * Tokens that are symbols AND ordinary words/abbreviations in exchange prose.
 *
 * Not a general English dictionary — only the collisions that actually occur in
 * circular subjects. Each entry is a symbol that would otherwise match on
 * nearly every circular NSE publishes.
 */
export const CIRCULAR_MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "NSE",
  "BSE",
  "SEBI",
  "INDIA",
  "LTD",
  "LIMITED",
  "THE",
  "AND",
  "FOR",
  "ALL",
  "NEW",
  "NOW",
  "ONE",
  "TWO",
  "DAY",
  "END",
  "NET",
  "PAY",
  "TOP",
  "SME",
  "ASM",
  "GSM",
  "ESM",
  "IPO",
  "NAV",
  "OTC",
  "EOD",
  "FNO",
]);

/**
 * Split free text into comparable tokens.
 *
 * Splitting on every non-alphanumeric run is what bounds the largest false
 * positive class: a substring search for "BEL" (Bharat Electronics) hits the
 * word "below", which appears in a large share of price-band circulars, and
 * would attach an unrelated exchange notice to that stock's page every week.
 * Tokenising makes "BELOW" one token that is not equal to "BEL".
 *
 * Apostrophes split too, so "RELIANCE's" yields "RELIANCE" — a true positive
 * that a whole-word regex with a trailing `\b` would also catch, but that a
 * naive `split(" ")` would not.
 */
export function tokenizeCircularText(text: string): string[] {
  return String(text ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Circulars plausibly about one symbol. HEURISTIC — see the disclaimer.
 *
 * Two bases, in order of trust:
 *
 *   COMPANY_FIELD  NSE populated `company` and the symbol appears as a token
 *                  in it. Still not authoritative (the column is free text and
 *                  carries a company NAME, not a ticker), but it is the
 *                  exchange's own attribution rather than ours.
 *   SUBJECT_TOKEN  the symbol is a bare token in the subject line. This is the
 *                  guess, and it is bounded three ways: token equality rather
 *                  than substring, a minimum length, and a stopword set.
 *
 * WHAT REMAINS UNFIXABLE, stated so nobody thinks the bounds close the hole: a
 * symbol that is also an ordinary word used in its ordinary sense — "IDEA" in
 * "clarification on the idea of…" — matches, and no amount of tokenising
 * changes that. The residue is why the surface is labelled a heuristic instead
 * of being tightened until it looks like a fact. If the SURV strip ever needs
 * to be authoritative it needs an exchange-provided symbol link, not a better
 * regex.
 */
export function matchCircularsForSymbol(
  rows: ReadonlyArray<NseCircularInput>,
  symbol: string,
  opts: { departments?: readonly string[]; limit?: number } = {},
): CircularSymbolMatch[] {
  const sym = String(symbol ?? "")
    .trim()
    .toUpperCase();
  if (sym === "") return [];

  const deptFilter =
    opts.departments && opts.departments.length > 0
      ? new Set(opts.departments.map((d) => d.trim().toUpperCase()))
      : null;
  const limit = Math.max(1, Math.trunc(opts.limit ?? 10));

  const subjectEligible =
    sym.length >= MIN_SUBJECT_MATCH_LENGTH &&
    !CIRCULAR_MATCH_STOPWORDS.has(sym);

  const out: CircularSymbolMatch[] = [];
  for (const view of buildCircularFeed(rows)) {
    if (deptFilter && !deptFilter.has(view.department.toUpperCase())) continue;

    if (view.company && tokenizeCircularText(view.company).includes(sym)) {
      out.push({
        circular: view,
        basis: "COMPANY_FIELD",
        confidence: "HIGH",
        matchedOn: sym,
      });
      continue;
    }
    if (subjectEligible && tokenizeCircularText(view.subject).includes(sym)) {
      out.push({
        circular: view,
        basis: "SUBJECT_TOKEN",
        confidence: "LOW",
        matchedOn: sym,
      });
    }
  }

  // High-confidence first, then newest. A company-field hit is a better answer
  // than a subject guess from a more recent day.
  out.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "HIGH" ? -1 : 1;
    return (b.circular.date ?? "").localeCompare(a.circular.date ?? "");
  });
  return out.slice(0, limit);
}

// ════════════════════════════════════════════════════════════════════
// 14d.6 — index detail
// ════════════════════════════════════════════════════════════════════

/**
 * Route slug → the TWO index keys the DB uses.
 *
 * `IndexClose.indexSlug` is derived from NSE's display name ("Nifty 50" →
 * "nifty-50"). `IndexConstituent.indexId` / `IndexMembership.indexId` use a
 * different, older vocabulary ("nifty50", and "banknifty" where NSE's own file
 * says "niftybank"). They were never one namespace and joining them by eye is
 * how a route renders a valuation for one index and a constituent list for
 * another.
 *
 * `indexId: null` is the NORMAL case, not an error: `ind_close_all` publishes
 * ~100 indices and only eight registry families fetch constituent lists. A
 * closes-only index gets a working page with the constituents section in its
 * empty state, which is the honest answer.
 */
export const INDEX_ROUTE_MAP: Readonly<
  Record<string, { indexId: string | null; label: string }>
> = {
  "nifty-50": { indexId: "nifty50", label: "Nifty 50" },
  "nifty-next-50": { indexId: "niftynext50", label: "Nifty Next 50" },
  "nifty-100": { indexId: "nifty100", label: "Nifty 100" },
  "nifty-500": { indexId: "nifty500", label: "Nifty 500" },
  "nifty-bank": { indexId: "banknifty", label: "Nifty Bank" },
  "nifty-it": { indexId: "niftyit", label: "Nifty IT" },
  "nifty-midcap-100": { indexId: "niftymidcap100", label: "Nifty Midcap 100" },
  "nifty-smallcap-100": {
    indexId: "niftysmallcap100",
    label: "Nifty Smallcap 100",
  },
};

/**
 * Accepted spellings that are not the canonical slug.
 *
 * NSE renames cosmetically and our own surfaces spell these several ways
 * ("banknifty" is the DB id, "niftybank" is NSE's file, "bank-nifty" is what a
 * human types). A 404 on a legitimate alias is a worse failure than a redirect,
 * so the aliases resolve rather than miss.
 */
const INDEX_SLUG_ALIASES: Readonly<Record<string, string>> = {
  nifty: "nifty-50",
  nifty50: "nifty-50",
  "nifty-bank-index": "nifty-bank",
  banknifty: "nifty-bank",
  niftybank: "nifty-bank",
  "bank-nifty": "nifty-bank",
  niftyit: "nifty-it",
  "nifty-it-index": "nifty-it",
  niftynext50: "nifty-next-50",
  nifty100: "nifty-100",
  nifty500: "nifty-500",
  niftymidcap100: "nifty-midcap-100",
  niftysmallcap100: "nifty-smallcap-100",
};

/**
 * Normalise any spelling into `IndexClose.indexSlug` form.
 *
 * Mirrors `toIndexSlug` in `workers/src/processors/bhavcopy-sync-logic.ts`,
 * which is the WRITER of that column: lowercase, every non-alphanumeric run to
 * a single hyphen, trimmed. Kept as a copy rather than an import because the
 * worker is not a dependency of `@usemoney/core` and inverting that would drag
 * the whole worker graph into the web bundle; the test pins the writer's own
 * documented examples so a drift shows up as a red test rather than a 404.
 */
export function normalizeIndexSlug(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ResolvedIndexRoute {
  /** `IndexClose.indexSlug` — always present; every index has closes. */
  indexSlug: string;
  /** `IndexConstituent.indexId` / `IndexMembership.indexId`, or null. */
  indexId: string | null;
  /** Display label. Falls back to a title-cased slug for unmapped indices. */
  label: string;
  /** True when the slug is one we hold a constituent list for. */
  known: boolean;
}

/** Route param → the keys each table needs. Never throws; never 404s. */
export function resolveIndexRoute(raw: string): ResolvedIndexRoute {
  const normalized = normalizeIndexSlug(raw);
  const canonical = INDEX_SLUG_ALIASES[normalized] ?? normalized;
  const hit = INDEX_ROUTE_MAP[canonical];
  if (hit) {
    return {
      indexSlug: canonical,
      indexId: hit.indexId,
      label: hit.label,
      known: true,
    };
  }
  return {
    indexSlug: canonical,
    indexId: null,
    label: titleCaseSlug(canonical),
    known: false,
  };
}

/**
 * Slug → a readable label for an index we have no explicit entry for.
 *
 * Only genuine ACRONYMS are upper-cased. An earlier version upper-cased any
 * word in a short allow-list, which turned "india-vix" into "INDIA VIX" — the
 * list conflated "words that appear in index names" with "words that are
 * initialisms", and the first is not a reason to shout.
 */
const INDEX_LABEL_ACRONYMS = new Set([
  "vix",
  "it",
  "psu",
  "pse",
  "fmcg",
  "cpse",
  "reit",
  "tri",
  "gs",
  "sdl",
  "esg",
  "psb",
]);

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) =>
      INDEX_LABEL_ACRONYMS.has(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

/** The `IndexConstituent` columns the route reads. */
export interface IndexConstituentInput {
  symbol: string;
  weightBps?: number | null;
  rank?: number | null;
  lastSyncedAt?: Date | string | number | null;
}

export interface IndexConstituentView {
  symbol: string;
  rank: number | null;
  /**
   * Free-float weight as a PERCENTAGE, or null when not published.
   *
   * `weightBps` is misnamed: the column stores NSE's 4-decimal percentage times
   * 10,000 (8.4321% → 84321), which is percent×10⁴, not basis points
   * (percent×10²). Dividing by 100 — the arithmetic the field NAME asks for —
   * inflates every weight a hundredfold and makes a 50-stock index sum to
   * 10,000%. Divide by 10,000.
   *
   * Null on every archive-derived row: NSE's constituent list files publish no
   * weight at all, so this is the common case and 0% would be a fabrication.
   */
  weightPct: number | null;
}

export interface IndexConstituentSection {
  rows: IndexConstituentView[];
  /** True when at least one row carries a weight. Drives the column's presence. */
  hasWeights: boolean;
  /** Sum of published weights, when any. Null when none are published. */
  weightCoveragePct: number | null;
  /** Newest `lastSyncedAt`, ISO. */
  syncedAt: string | null;
}

/**
 * Constituents, ranked, with weights where NSE published them.
 *
 * Ordered by `rank` when present, then by symbol — NOT by weight, because
 * sorting on a column that is null for most rows silently buries the whole
 * index behind the handful of rows that happen to carry one.
 */
export function buildIndexConstituents(
  rows: ReadonlyArray<IndexConstituentInput>,
): IndexConstituentSection {
  const views: IndexConstituentView[] = [];
  let weightSum = 0;
  let weighted = 0;
  let syncedAt: string | null = null;

  for (const r of rows) {
    const symbol = textOrNull(r.symbol)?.toUpperCase();
    if (!symbol) continue;
    const bps = finiteOrNull(r.weightBps);
    const weightPct = bps === null ? null : round(bps / 10_000, 4);
    if (weightPct !== null) {
      weightSum += weightPct;
      weighted += 1;
    }
    const synced = isoOrNull(r.lastSyncedAt ?? null);
    if (synced !== null && (syncedAt === null || synced > syncedAt)) {
      syncedAt = synced;
    }
    views.push({ symbol, rank: finiteOrNull(r.rank), weightPct });
  }

  views.sort((a, b) => {
    const ar = a.rank ?? Number.POSITIVE_INFINITY;
    const br = b.rank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    rows: views,
    hasWeights: weighted > 0,
    weightCoveragePct: weighted === 0 ? null : round(weightSum, 2),
    syncedAt,
  };
}

/** The `IndexMembership` columns the change log reads. */
export interface IndexMembershipInput {
  symbol: string;
  firstSeen: Date | string | number;
  lastSeen: Date | string | number;
  addedOn?: Date | string | number | null;
  removedOn?: Date | string | number | null;
}

export type MembershipChangeKind = "ADDED" | "REMOVED";

export interface MembershipChange {
  symbol: string;
  kind: MembershipChangeKind;
  /** IST day of the observed join or exit. */
  date: string;
}

export interface IndexMembershipSection {
  /** Observed joins and exits, newest first. */
  changes: MembershipChange[];
  /** Symbols whose stint is still open (`removedOn: null`). */
  currentCount: number;
  /**
   * Members with `addedOn: null` — already in the index when we started
   * observing. Counted, never dated: deriving `addedOn` from `firstSeen` would
   * tell a backtest that every constituent joined on our earliest snapshot, a
   * fabricated index-wide rebalance indistinguishable from a real one.
   */
  preexistingCount: number;
  /** Earliest `firstSeen` — the start of the observation window. */
  observedFrom: string | null;
}

/**
 * Membership change history from the point-in-time table.
 *
 * Only OBSERVED transitions become changes: a row with `addedOn: null` was
 * already a member when observation began and produces no ADDED event. The open
 * interval is `removedOn: null`, matching the model.
 */
export function buildIndexMembership(
  rows: ReadonlyArray<IndexMembershipInput>,
): IndexMembershipSection {
  const changes: MembershipChange[] = [];
  let currentCount = 0;
  let preexistingCount = 0;
  let observedFrom: string | null = null;

  for (const r of rows) {
    const symbol = textOrNull(r.symbol)?.toUpperCase();
    if (!symbol) continue;
    const first = istDayKey(r.firstSeen);
    if (first !== null && (observedFrom === null || first < observedFrom)) {
      observedFrom = first;
    }
    const removedOn = r.removedOn == null ? null : istDayKey(r.removedOn);
    if (removedOn === null) currentCount += 1;

    const addedOn = r.addedOn == null ? null : istDayKey(r.addedOn);
    if (addedOn === null && removedOn === null) preexistingCount += 1;
    if (addedOn !== null)
      changes.push({ symbol, kind: "ADDED", date: addedOn });
    if (removedOn !== null)
      changes.push({ symbol, kind: "REMOVED", date: removedOn });
  }

  changes.sort(
    (a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol),
  );
  return { changes, currentCount, preexistingCount, observedFrom };
}

/** The `IndexClose` columns the route reads. Five of them are nullable. */
export interface IndexCloseInput {
  date: Date | string | number;
  name?: string | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  prevClose?: number | null;
  pe?: number | null;
  pb?: number | null;
  divYield?: number | null;
  volume?: number | null;
  turnoverCr?: number | null;
}

export interface IndexClosePoint {
  date: string;
  close: number | null;
}

export interface IndexValuation {
  /**
   * All five NULLABLE and null means NOT REPORTED (`-` in NSE's file), never
   * zero. A volatility or dividend-points index has no basket to value, so it
   * publishes `-` forever — and a 0 P/E renders as the cheapest index on the
   * exchange. Nothing here coalesces with `?? 0`, and the renderer shows `—`.
   */
  pe: number | null;
  pb: number | null;
  /** Percent (1.25 = 1.25%). */
  divYield: number | null;
  volume: number | null;
  /** ₹ crore — the file's own unit, name-carried. */
  turnoverCr: number | null;
}

export interface IndexDetailSection {
  label: string;
  /** NSE's display name from the newest close row. */
  name: string | null;
  /** IST day of the newest close. */
  date: string | null;
  close: number | null;
  prevClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  valuation: IndexValuation;
  /** Oldest→newest closes for the sparkline. Sessions with no close are dropped. */
  spark: IndexClosePoint[];
  sessions: number;
}

/**
 * Newest close + the valuation block + a sparkline.
 *
 * `changePct` uses `prevClose` when NSE published one and the PREVIOUS SESSION
 * IN THE SERIES otherwise; it stays null when neither exists rather than
 * falling back to `open`, which is a different quantity (intraday, not
 * day-on-day) and would silently change what the number means on exactly the
 * days the feed is incomplete.
 */
export function buildIndexDetail(
  rows: ReadonlyArray<IndexCloseInput>,
  opts: { label: string },
): IndexDetailSection {
  const points = rows
    .map((r) => ({ r, key: istDayKey(r.date) }))
    .filter((x): x is { r: IndexCloseInput; key: string } => x.key !== null)
    .sort((a, b) => a.key.localeCompare(b.key));

  const newest = points[points.length - 1];
  const previous = points.length >= 2 ? points[points.length - 2] : undefined;

  const close = newest ? finiteOrNull(newest.r.close) : null;
  const prevClose = newest
    ? (finiteOrNull(newest.r.prevClose) ??
      (previous ? finiteOrNull(previous.r.close) : null))
    : null;

  const changeAbs =
    close !== null && prevClose !== null ? round(close - prevClose) : null;
  const changePct =
    close !== null && prevClose !== null && prevClose !== 0
      ? round(((close - prevClose) / prevClose) * 100)
      : null;

  return {
    label: opts.label,
    name: newest ? textOrNull(newest.r.name) : null,
    date: newest?.key ?? null,
    close,
    prevClose,
    changeAbs,
    changePct,
    open: newest ? finiteOrNull(newest.r.open) : null,
    high: newest ? finiteOrNull(newest.r.high) : null,
    low: newest ? finiteOrNull(newest.r.low) : null,
    valuation: {
      pe: newest ? finiteOrNull(newest.r.pe) : null,
      pb: newest ? finiteOrNull(newest.r.pb) : null,
      divYield: newest ? finiteOrNull(newest.r.divYield) : null,
      volume: newest ? finiteOrNull(newest.r.volume) : null,
      turnoverCr: newest ? finiteOrNull(newest.r.turnoverCr) : null,
    },
    spark: points
      .map((x) => ({ date: x.key, close: finiteOrNull(x.r.close) }))
      .filter((p): p is IndexClosePoint => p.close !== null),
    sessions: points.length,
  };
}
