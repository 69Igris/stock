/**
 * Pure read-side helpers for the stock page's data-engine sections — MONEY-1204
 * (P14 / 14c.1 · 14c.2 · 14c.3).
 *
 * Three surfaces share this module:
 *
 *   14c.1  header badges + index chips   ← `StockFlag`, `IndexMembership`
 *   14c.2  overview delivery chip/trend  ← `DailyPrice.deliveryPct`
 *   14c.3  F&O section                   ← `DerivativeSummary`, `SlbPosition`,
 *                                          `MwplDaily`, `StockFlag(FO_BAN)`
 *
 * Everything here is a PURE function over rows the service already fetched: no
 * Prisma, no network, no clock. That is what makes the four judgement calls
 * below testable, because every one of them is a place where the obvious
 * implementation is quietly wrong:
 *
 * 1. **"Current" flag state is a reduce, not a query.** `StockFlag` carries NO
 *    `@@unique` by design — a 40-day GSM stint is 40 rows and the run length IS
 *    the datum. So "what is this stock's state today" is the newest DATE per
 *    kind, and the run is how far back that same value goes. Doing it per-kind
 *    with `findFirst` would be N queries and would still not give you the run.
 *
 * 2. **A kind can hold several simultaneous values.** NSE routinely publishes
 *    `GSM Stage I` and `ESM Stage II` for the same stock on the same day, and
 *    with no unique both land. Taking "the first row of the newest date" would
 *    silently drop one framework — on the surface whose entire job is warning
 *    retail investors. Every distinct value on the newest date becomes its own
 *    badge, each with its OWN run.
 *
 * 3. **Delivery nulls are not zeroes.** NSE prints `-` for delivery on
 *    trade-for-trade series, where delivery is 100% by construction. Averaging
 *    those as 0 understates delivery on exactly the illiquid, surveilled names
 *    where the number matters most. The mean SKIPS nulls and reports how many
 *    of the window actually contributed, so the UI can say `n/20` instead of
 *    implying twenty clean observations.
 *
 * 4. **The SLB per-series ladder is the data.** MONEY-1201 measured that
 *    collapsing `slb_positions` across series discarded 84.2% of open borrow
 *    interest while reporting success. The ladder is preserved and the total is
 *    derived FROM it, never the other way round.
 *
 * Absence discipline throughout: `""` / `"-"` / blank / unparseable ⇒ `null`,
 * never `0`. A null means "not reported"; a zero means "reported as zero", and
 * the two are different facts.
 *
 * Wire shape: every date crossing a function boundary here is an ISO string,
 * not a `Date`. The same payloads travel a Next server action AND an
 * `apps/api` JSON response, and only one of those preserves `Date`.
 */

import {
  decodeSurveillanceCode,
  isStockFlagKind,
  stockFlagShape,
  type StockFlagKind,
  type StockFlagShape,
  type SurveillanceDecode,
} from "./stock-flags";
import { getNonTradingReason } from "./nse-holidays";
import type { OiBuildup } from "./fo-analytics-logic";

// ─── Shared primitives ───────────────────────────────────────────────

/**
 * Finite number or null. The single coercion gate for this module.
 *
 * `""` and `"-"` are NOT numbers — `Number("")` is 0, which is the exact
 * silent-zero this codebase keeps re-learning about, so they are rejected
 * before the coercion rather than after it.
 */
export function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "-" || s === "NA" || s === "N/A") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

/** Non-empty trimmed string, or null. `"-"` is absence, not a label. */
export function textOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "-" ? null : s;
}

/** `Date | string | number` → ISO string, or null when it is not a real date. */
export function isoOrNull(v: Date | string | number | null | undefined) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

function dayKey(v: Date | string | number): string | null {
  const iso = isoOrNull(v);
  return iso === null ? null : iso.slice(0, 10);
}

/** Round to `dp` decimals, preserving null. Never turns null into 0. */
function round(n: number | null, dp = 2): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const DAY_MS = 86_400_000;

/**
 * Longest closure we will walk over looking for the previous session.
 *
 * A weekend plus the longest Indian holiday cluster is four days; seven is a
 * whole week. Past that we return null and the caller BREAKS the run, which is
 * the safe direction: under-reporting a stint is a smaller lie than asserting
 * one held over a fortnight nobody looked at.
 */
const MAX_CLOSURE_DAYS = 7;

/**
 * The session before `dayIso` according to the exchange calendar, or null.
 *
 * Static data, not a clock: `getNonTradingReason` is called with an explicit
 * date and `NSE_HOLIDAYS_BY_FY` is a hardcoded table. A financial year missing
 * from that table degrades to "weekends only", which over-reports sessions and
 * therefore only ever BREAKS a run early — never extends one.
 */
function previousCalendarSession(dayIso: string): string | null {
  const t = Date.parse(`${dayIso}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  for (let back = 1; back <= MAX_CLOSURE_DAYS; back++) {
    const d = new Date(t - back * DAY_MS);
    if (!getNonTradingReason(d).isClosed) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * The session immediately before `dayIso`, best-effort.
 *
 * Two sources, and the CLOSER one wins:
 *
 *   - `observedDesc` — every day we hold a row for, for ANY kind. A row is
 *     proof a session happened, so this beats the calendar whenever it is
 *     nearer: NSE does hold the occasional Saturday session, and a hardcoded
 *     holiday table can drift.
 *   - the exchange calendar, for the (normal) case where we simply hold no row
 *     on the previous session.
 */
function previousSessionDay(
  dayIso: string,
  observedDesc: ReadonlyArray<string>,
): string | null {
  const calendar = previousCalendarSession(dayIso);
  const observed = observedDesc.find((d) => d < dayIso) ?? null;
  if (calendar === null) return observed;
  if (observed === null) return calendar;
  return observed > calendar ? observed : calendar;
}

// ════════════════════════════════════════════════════════════════════
// 14c.1 — StockFlag current state
// ════════════════════════════════════════════════════════════════════

/** The `StockFlag` columns this module reads. Dates may arrive either way. */
export interface StockFlagStateRow {
  kind: string;
  value: string;
  date: Date | string;
  series?: string | null;
  source?: string | null;
}

/** Kind-specific decode of the `value` column. `type` mirrors `kind`. */
export type StockFlagParsed =
  | {
      type: "WK52_HIGH_LOW";
      high: number | null;
      highDate: string | null;
      low: number | null;
      lowDate: string | null;
    }
  | { type: "BAND_CHANGE"; from: string | null; to: string | null }
  | { type: "PRICE_BAND"; band: string | null }
  | { type: "SURVEILLANCE"; code: string; decode: SurveillanceDecode | null }
  | { type: "FO_BAN" }
  | { type: "SERIES_CHANGE"; from: string | null; to: string | null }
  | { type: "SHORT_SELLING"; qty: number | null };

/** Badge severity. Drives colour only — never hides a flag. */
export type StockFlagTone = "critical" | "warn" | "info" | "neutral";

export interface StockFlagBadge {
  kind: StockFlagKind;
  /** Short chip text, e.g. `"GSM Stage I"` / `"F&O ban"` / `"20% band"`. */
  label: string;
  tone: StockFlagTone;
  /** Longer sentence for the tooltip; null when the label says everything. */
  detail: string | null;
  /** The stored `value`, VERBATIM. Kept so the UI can show what NSE wrote. */
  raw: string;
  /** Decoded payload; null when `value` did not parse for this kind. */
  parsed: StockFlagParsed | null;
  /** Trading day of the newest row carrying this value (ISO). */
  date: string;
  /** First day of the UNBROKEN run of this value ending at `date` (ISO). */
  since: string;
  /**
   * Distinct trading days observed in that run.
   *
   * "Observed", not "elapsed": we count rows we hold, not calendar or trading
   * days between the two dates. A gap in ingestion shortens this number rather
   * than inventing sessions we never saw.
   */
  observedSessions: number;
  /**
   * The run consumed EVERY day we were handed for this kind, so `since` is a
   * lower bound: the stint may well start earlier than the fetched window.
   *
   * The service reads a bounded page per kind (a 7.5M-row table is not one to
   * scan per page view), and without this flag a 400-session GSM stint read
   * through a 60-row window would render as "since 60 sessions ago" — a
   * confident, wrong, and unfalsifiable date. The UI renders "since at least X"
   * when this is true.
   */
  runReachesWindowEdge: boolean;
  /**
   * STATE or POINT, straight from `FLAG_KIND_POLICY`; null for a kind the
   * policy table has never seen.
   *
   * THE UI MUST BRANCH ON THIS BEFORE RENDERING "(ended)". A POINT event is a
   * dated one-off: it is never "in force" and can never "end", so an "(ended)"
   * suffix on a `BAND_CHANGE` is not a stale label, it is a false statement
   * about a fact that was only ever true for one day (MONEY-1205).
   */
  shape: StockFlagShape | null;
  /**
   * "Is this badge live news?" — and the answer is shape-dependent, which is
   * the whole point of carrying `shape` beside it.
   *
   *   STATE — the flag is still in force: this badge's day is at or after the
   *     newest day THIS KIND published, market-wide.
   *   POINT — the event landed within {@link POINT_EVENT_RECENCY_DAYS} of the
   *     market's latest observed day. Not "in force"; recent.
   *
   * ## Per KIND, never one shared day (MONEY-1205)
   *
   * The reference is THIS KIND's own latest market-wide publication, supplied
   * by the caller through `opts.referenceDayByKind` (or `opts.referenceDay`
   * when the caller is already per-kind). A single cross-kind day is a
   * FAIL-OPEN: `PRICE_BAND` and `WK52_HIGH_LOW` publish the entire universe
   * every session and therefore always set the bar, so every sparser family —
   * surveillance, F&O ban, short selling — reads as stale the moment its own
   * file skips a day. That is what produced "Short sold 106 (ended)" on a
   * stock whose short-selling row was the newest one that family had.
   * `flagsReferenceDayByKind` (screener) and `market-structure-store`
   * (research) both already do it per kind; this builder was the last reader
   * getting it wrong.
   *
   * Derived from the DATA's own latest day, never from `Date.now()`: the flag
   * feed runs post-market on trading days, so a wall-clock comparison would
   * mark every badge stale over a weekend, and a paused ingestion would blank
   * the header instead of showing its age.
   */
  isCurrent: boolean;
  series: string | null;
  source: string | null;
}

/**
 * How long a POINT event stays "news" after the day it happened.
 *
 * Calendar days against the market's latest OBSERVED day, not the wall clock —
 * same reason `isCurrent` is data-derived. Thirty days is about a month of
 * sessions: long enough that a band revision is still context for the current
 * quarter's chart, short enough that HDFCBANK's 21-May-2024 band change stops
 * being a 2026 header badge, which is the bug this constant exists to close.
 */
export const POINT_EVENT_RECENCY_DAYS = 30;

/** Badge order for the header strip — most alarming first, stable per kind. */
const KIND_ORDER: readonly string[] = [
  "FO_BAN",
  "SURVEILLANCE",
  "SERIES_CHANGE",
  "BAND_CHANGE",
  "PRICE_BAND",
  "SHORT_SELLING",
  "WK52_HIGH_LOW",
];

const KNOWN_KINDS = new Set<string>(KIND_ORDER);

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A malformed `value` is a parse bug upstream, not a reason to 500 a page.
    // The badge still renders from `raw`.
    return null;
  }
}

/**
 * Decode one stored `value` for its kind.
 *
 * Returns null rather than a guess when the payload does not fit — an
 * un-decodable flag still renders (from `raw`), which is strictly better than a
 * confident wrong reading of a format that drifted.
 */
export function parseStockFlagValue(
  kind: string,
  value: string,
): StockFlagParsed | null {
  const raw = String(value ?? "");
  switch (kind) {
    case "WK52_HIGH_LOW": {
      const o = safeJson(raw);
      if (!o) return null;
      return {
        type: "WK52_HIGH_LOW",
        high: finiteOrNull(o.high),
        highDate: textOrNull(o.highDate),
        low: finiteOrNull(o.low),
        lowDate: textOrNull(o.lowDate),
      };
    }
    case "BAND_CHANGE": {
      const o = safeJson(raw);
      if (!o) return null;
      return {
        type: "BAND_CHANGE",
        from: textOrNull(o.from),
        to: textOrNull(o.to),
      };
    }
    case "PRICE_BAND": {
      const o = safeJson(raw);
      if (!o) return null;
      // NOTE `band` is a PUBLISHED STRING and stays one: NSE prints `No Band`
      // for F&O names in this column and `Number("No Band")` is NaN. See the
      // encoding note in stock-flags.ts.
      return { type: "PRICE_BAND", band: textOrNull(o.band) };
    }
    case "SURVEILLANCE": {
      const code = raw.trim();
      if (code === "") return null;
      return {
        type: "SURVEILLANCE",
        code,
        decode: decodeSurveillanceCode(code),
      };
    }
    case "FO_BAN":
      return { type: "FO_BAN" };
    case "SERIES_CHANGE": {
      const o = safeJson(raw);
      if (!o) return null;
      return {
        type: "SERIES_CHANGE",
        from: textOrNull(o.from),
        to: textOrNull(o.to),
      };
    }
    case "SHORT_SELLING": {
      const o = safeJson(raw);
      if (!o) return null;
      return { type: "SHORT_SELLING", qty: finiteOrNull(o.qty) };
    }
    default:
      return null;
  }
}

function labelFor(
  kind: string,
  raw: string,
  parsed: StockFlagParsed | null,
): { label: string; tone: StockFlagTone; detail: string | null } {
  switch (parsed?.type) {
    case "SURVEILLANCE": {
      const d = parsed.decode;
      if (!d) {
        // Unknown wording is shown VERBATIM rather than dropped — a framework
        // NSE invented last week is exactly the one worth surfacing.
        return { label: parsed.code, tone: "warn", detail: null };
      }
      const critical =
        d.framework === "GSM" || d.framework === "ESM" || d.framework === "IBC";
      return {
        label: d.label,
        tone: critical ? "critical" : "warn",
        detail: `NSE surveillance: ${parsed.code}`,
      };
    }
    case "FO_BAN":
      return {
        label: "F&O ban",
        tone: "critical",
        detail:
          "Derivatives in this stock are in the ban period — only position-reducing trades are allowed.",
      };
    case "SERIES_CHANGE":
      return {
        label:
          parsed.from && parsed.to
            ? `Series ${parsed.from} → ${parsed.to}`
            : `Series ${parsed.to ?? parsed.from ?? "changed"}`,
        tone: "warn",
        detail: "Settlement series changed by the exchange.",
      };
    case "BAND_CHANGE":
      return {
        // BOTH sides go through the band rule. `Band ${from}% → ${to}%` printed
        // "Band 5% → No Band%" for the 208 stocks NSE publishes with no circuit
        // limit, because the `%` was appended unconditionally to a value that
        // is a WORD for F&O names (MONEY-1205). The guard already existed one
        // function down and was wired into PRICE_BAND only.
        label:
          parsed.from && parsed.to
            ? `Band ${bandSide(parsed.from)} → ${bandSide(parsed.to)}`
            : "Price band changed",
        tone: "info",
        detail: "Daily price band revised by the exchange.",
      };
    case "PRICE_BAND":
      return {
        label: parsed.band === null ? "Price band" : bandLabel(parsed.band),
        tone: "info",
        detail: "Maximum daily move allowed before the stock is frozen.",
      };
    case "SHORT_SELLING":
      return {
        label:
          parsed.qty === null
            ? "Short selling reported"
            : `Short sold ${indianNumber(parsed.qty)}`,
        tone: "neutral",
        detail: "Shares disclosed as sold short for the session.",
      };
    case "WK52_HIGH_LOW":
      return { label: "52-week range", tone: "neutral", detail: null };
    default:
      // Kind we do not know how to render: label with the kind, not the raw
      // JSON blob, and keep `raw` on the badge for anyone who needs it.
      return {
        label: humanizeKind(kind),
        tone: "neutral",
        detail: raw || null,
      };
  }
}

/** `"No Band"` stays words; a numeric band gets its `%`. */
function bandLabel(band: string): string {
  return finiteOrNull(band) === null ? band : `${band}% band`;
}

/**
 * ONE side of a band transition: `"5"` → `"5%"`, `"No Band"` → `"no band"`.
 *
 * The same rule as {@link bandLabel} minus the trailing noun, because a
 * transition already reads as bands: "5% → no band", not "5% band → No Band
 * band". Non-numeric values are lower-cased so they sit inside a sentence;
 * they are NOT re-spelled, so a wording NSE invents next month passes through.
 */
function bandSide(band: string): string {
  return finiteOrNull(band) === null ? band.toLowerCase() : `${band}%`;
}

/** Indian digit grouping — 106000 → `1,06,000`, not `106,000`. */
function indianNumber(n: number, dp?: number): string {
  return n.toLocaleString(
    "en-IN",
    dp === undefined
      ? undefined
      : { minimumFractionDigits: dp, maximumFractionDigits: dp },
  );
}

const MONTH_ABBR = [
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

/**
 * `"2024-05-21"` (or a full ISO instant) → `"21 May 2024"`, else null.
 *
 * Formatted from UTC PARTS, not `toLocaleDateString`: every date in this
 * module is UTC midnight of a trading day, and a locale formatter running in
 * IST on a UTC-midnight Date is fine while one running in UTC-5 prints the day
 * before. A hand-rolled format is the only one that cannot drift with the
 * server's timezone.
 */
function shortDay(v: Date | string | number | null | undefined): string | null {
  const iso = isoOrNull(v ?? null);
  if (iso === null) return null;
  const d = new Date(iso);
  const mon = MONTH_ABBR[d.getUTCMonth()];
  if (mon === undefined) return null;
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

/**
 * ONE human-readable decode of a stored `StockFlag.value` — MONEY-1205.
 *
 * Four products were each formatting the raw column themselves, and three of
 * them were shipping JSON to a user: the web popover and `/v1/stocks/:symbol/
 * flags` rendered `{"band":"5"}`, the research tool quoted it into a prompt,
 * and a price-band alert notification read `{"band":"5"} → {"band":"10"}`.
 * This is the shared decoder they call instead.
 *
 * ## SURVEILLANCE is returned BYTE-IDENTICAL to `value`, on purpose
 *
 * Not decoded, not title-cased, not normalised. `stock-flags.ts` stores NSE's
 * wording verbatim precisely so a better decode table re-reads rows written
 * years earlier (`decodeSurveillanceCode` is the read-time helper for that, and
 * the badge `label` already applies it). A decoder that rewrote the stored text
 * here would make the verbatim column unverifiable against what NSE published,
 * which is the one property it exists to have.
 *
 * `opts.date` is appended to POINT kinds only — `BAND_CHANGE` / `SERIES_CHANGE`
 * are one-day events and the day IS half the fact. STATE kinds describe an
 * ongoing condition, so dating them inside the sentence would read as an end
 * date.
 *
 * Never throws, never returns `""`: an unparseable value falls back to `raw`,
 * so a format drift shows up as odd text rather than a blank cell.
 */
export function formatStockFlagValue(
  kind: string,
  value: string,
  opts: { date?: Date | string | null } = {},
): string {
  const raw = String(value ?? "");
  const parsed = parseStockFlagValue(kind, raw);
  const on = shortDay(opts.date ?? null);
  const dated = (s: string): string => (on === null ? s : `${s} on ${on}`);

  // Switched on KIND, not on `parsed.type`, and that is the load-bearing
  // difference. A known kind whose value did not parse still gets its kind's
  // sentence; falling through to `raw` would put the malformed blob itself in
  // front of a user, which is the failure this decoder exists to end. `raw`
  // survives beside it on the badge and the history row for anyone debugging.
  switch (kind) {
    case "SURVEILLANCE":
      // VERBATIM — byte-identical to `value`. See the note above before
      // "improving" this line. Empty is the only case with nothing to echo.
      return raw.trim() === "" ? "Surveillance flag" : raw;

    case "FO_BAN":
      // `value` is the constant "BAN"; the row's EXISTENCE is the signal.
      return "F&O ban";

    case "BAND_CHANGE": {
      const p = parsed?.type === "BAND_CHANGE" ? parsed : null;
      // The noun is part of the decode. "5% → no band" alone does not say WHAT
      // moved, and this string lands in an email row, a push notification and a
      // research prompt with no kind label beside it.
      return p?.from && p.to
        ? dated(`Price band ${bandSide(p.from)} → ${bandSide(p.to)}`)
        : dated("Price band changed");
    }

    case "SERIES_CHANGE": {
      const p = parsed?.type === "SERIES_CHANGE" ? parsed : null;
      if (p?.from && p.to) return dated(`Series ${p.from} → ${p.to}`);
      const one = p?.to ?? p?.from ?? null;
      return dated(one === null ? "Series changed" : `Series ${one}`);
    }

    case "PRICE_BAND": {
      const band = parsed?.type === "PRICE_BAND" ? parsed.band : null;
      if (band === null) return "Price band";
      // `No Band` is NSE's own published value for an F&O name, which has no
      // circuit limit at all — a positive fact, not a missing one.
      return finiteOrNull(band) === null
        ? "no price band (F&O)"
        : `${band}% band`;
    }

    case "SHORT_SELLING": {
      const qty = parsed?.type === "SHORT_SELLING" ? parsed.qty : null;
      return qty === null
        ? "Short selling reported"
        : `${indianNumber(qty)} shares sold short`;
    }

    case "WK52_HIGH_LOW": {
      const p = parsed?.type === "WK52_HIGH_LOW" ? parsed : null;
      const parts: string[] = [];
      if (p && p.high !== null) {
        const d = shortDay(p.highDate);
        parts.push(`High ₹${indianNumber(p.high, 2)}${d ? ` (${d})` : ""}`);
      }
      if (p && p.low !== null) {
        const d = shortDay(p.lowDate);
        parts.push(`Low ₹${indianNumber(p.low, 2)}${d ? ` (${d})` : ""}`);
      }
      // Both extremes absent is a row NSE published as `-`/`-`; it carries no
      // number to show, so say so rather than printing an empty separator.
      return parts.length === 0
        ? "52-week range not reported"
        : parts.join(" · ");
    }

    default:
      // A family the policy table has never seen. Here — and ONLY here — the
      // stored text is the honest answer: the module's standing rule is that a
      // new NSE family surfaces as itself rather than as something invented.
      return raw.trim() === "" ? humanizeKind(kind) : raw;
  }
}

function humanizeKind(kind: string): string {
  return kind
    .toLowerCase()
    .split("_")
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Rows → one badge per (kind, currently-active value), newest state first.
 *
 * Input may be in any order and may span many days; the service hands over a
 * `findMany` ordered `date desc`, and this sorts defensively anyway because a
 * reduce that depends on caller ordering is a bug waiting for a refactor.
 *
 * Rows whose date does not parse are DROPPED (they cannot be placed in a run),
 * and rows of an unrecognised kind are kept — a new NSE flag family should show
 * up as an unstyled badge, not vanish, which is the whole reason `kind` is a
 * String column and not a Prisma enum.
 *
 * ## The two reference inputs, and which one you want
 *
 * `opts.referenceDayByKind` — `kind` → that kind's newest MARKET-WIDE day.
 * This is the correct denominator for `isCurrent` and the one a page-level
 * caller should supply: it is what distinguishes "the surveillance file has
 * not named this stock since 24-Jul" from "the surveillance file has not been
 * published since 24-Jul". A `null` entry means the family has not landed at
 * all for this environment, and the kind then falls back with the rest.
 *
 * `opts.referenceDay` — one day for every kind handed in. Kept for callers
 * that are ALREADY per-kind (`market-fields-logic` and `market-structure-store`
 * both call this once per kind with that kind's own day), where it is exactly
 * right. Do NOT use it to pass a cross-kind maximum; that is the fail-open
 * documented on `StockFlagBadge.isCurrent`.
 *
 * With NEITHER supplied, a STATE kind is judged against its OWN newest row —
 * so a badge is "current" and its `date` shows how old it is. That is the only
 * honest answer available without a market-wide calendar, and it fails toward
 * showing a stale warning rather than toward announcing an EXIT nobody
 * observed. Every production caller supplies a reference; the fallback is for
 * tests and for a family whose calendar we do not hold.
 *
 * A run (`since` / `observedSessions`) counts CONSECUTIVE SESSIONS, so it stops
 * at the first day between two rows that has no row for the value — see the
 * walk below. Rows for other kinds and the exchange calendar together decide
 * what "the previous session" was; neither alone is enough, because most of
 * these feeds publish a row only on the days the flag applies.
 */
export function buildStockFlagBadges(
  rows: ReadonlyArray<StockFlagStateRow>,
  opts: {
    referenceDay?: string | null;
    referenceDayByKind?: Readonly<Record<string, string | null>> | null;
  } = {},
): StockFlagBadge[] {
  // kind → day → set of values (+ the representative row per (day, value))
  const byKind = new Map<
    string,
    { days: string[]; rows: Map<string, Map<string, StockFlagStateRow>> }
  >();
  /** Every day carrying a row, across ALL kinds — see `previousSessionDay`. */
  const observedDays = new Set<string>();

  for (const r of rows) {
    if (!r || typeof r.kind !== "string" || r.kind === "") continue;
    const day = dayKey(r.date);
    if (day === null) continue;
    const value = String(r.value ?? "");
    let bucket = byKind.get(r.kind);
    if (!bucket) {
      bucket = { days: [], rows: new Map() };
      byKind.set(r.kind, bucket);
    }
    let dayRows = bucket.rows.get(day);
    if (!dayRows) {
      dayRows = new Map();
      bucket.rows.set(day, dayRows);
      bucket.days.push(day);
    }
    if (!dayRows.has(value)) dayRows.set(value, r);
    observedDays.add(day);
  }

  // Newest first. Every day we hold ANY row for — the evidence that a session
  // happened, independent of which kind published on it.
  const observedDesc = [...observedDays].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );

  const sharedReference = opts.referenceDay
    ? opts.referenceDay.slice(0, 10)
    : null;
  const byKindReference = opts.referenceDayByKind ?? null;

  /**
   * THIS KIND's newest market-wide publication day, or null when nobody knows.
   *
   * Precedence: the per-kind map, then a caller who is already per-kind, then
   * the kind's own newest row. Never a cross-kind maximum — see `isCurrent`.
   */
  const referenceFor = (kind: string, ownNewest: string): string | null => {
    if (byKindReference && kind in byKindReference) {
      const d = byKindReference[kind];
      return d ? d.slice(0, 10) : null;
    }
    if (sharedReference !== null) return sharedReference;
    return ownNewest;
  };

  /**
   * The market's latest observed day — the data-derived stand-in for "now",
   * used ONLY to age POINT events.
   *
   * A cross-kind maximum is the right shape for THIS job and the wrong one for
   * `isCurrent`: any row on day D proves a session happened on D, which is
   * exactly what a clock needs and exactly what a per-family publication
   * calendar is not. Caller-supplied reference days count too, since a kind can
   * have published market-wide on a day this stock has no row for.
   */
  let marketDay: string | null = sharedReference;
  if (byKindReference) {
    for (const d of Object.values(byKindReference)) {
      const day = d ? d.slice(0, 10) : null;
      if (day !== null && (marketDay === null || day > marketDay)) {
        marketDay = day;
      }
    }
  }
  for (const d of observedDesc) {
    if (marketDay === null || d > marketDay) marketDay = d;
  }

  const badges: StockFlagBadge[] = [];

  for (const [kind, bucket] of byKind) {
    // Newest day first. ISO day strings sort lexicographically = chronologically.
    const days = [...bucket.days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const newest = days[0];
    if (newest === undefined) continue;
    const currentRows = bucket.rows.get(newest);
    if (!currentRows) continue;

    for (const [value, row] of currentRows) {
      // Walk back while this exact value is still present on the IMMEDIATELY
      // PRECEDING SESSION. Two ways the run ends, and the second one is the
      // reason this is not a simple "next row for this kind" loop:
      //
      //   a. the older day carries a different value (the stint changed), or
      //   b. the older day is not the previous session at all — days with no
      //      row sit between them.
      //
      // (b) is the normal shape of most of these feeds: a ban row exists only
      // on a ban day, so a stock banned today and last banned ten days ago has
      // exactly two rows. Reading those as adjacent reports "2 sessions, since
      // 4-Aug" — and the UI prints the word "consecutive" next to it — for a
      // ban that started this morning.
      let sinceDay = newest;
      let observed = 1;
      let reachedEdge = days.length === 1;
      for (let i = 1; i < days.length; i++) {
        const d = days[i]!;
        if (!bucket.rows.get(d)?.has(value)) break;
        if (d !== previousSessionDay(sinceDay, observedDesc)) break;
        sinceDay = d;
        observed++;
        if (i === days.length - 1) reachedEdge = true;
      }

      const parsed = parseStockFlagValue(kind, value);
      const { label, tone, detail } = labelFor(kind, value, parsed);
      const shape = stockFlagShape(kind);
      badges.push({
        kind: kind as StockFlagKind,
        label,
        tone,
        detail,
        raw: value,
        parsed,
        date: isoOrNull(row.date) ?? `${newest}T00:00:00.000Z`,
        since: `${sinceDay}T00:00:00.000Z`,
        observedSessions: observed,
        runReachesWindowEdge: reachedEdge,
        shape,
        isCurrent:
          shape === "POINT"
            ? isRecentPointEvent(newest, marketDay)
            : // An unknown kind is treated as STATE here — its `shape` is null,
              // so a UI still knows not to trust the reading — because the
              // alternative is aging a family whose cadence we do not know
              // against a 30-day window we invented for it.
              isStateInForce(newest, referenceFor(kind, newest)),
        series: textOrNull(row.series),
        source: textOrNull(row.source),
      });
    }
  }

  const rank = (k: string): number => {
    const i = KIND_ORDER.indexOf(k);
    // Unknown kinds sort after the known ones rather than jumping to the front.
    return i === -1 ? KIND_ORDER.length : i;
  };
  badges.sort((a, b) => {
    const d = rank(a.kind) - rank(b.kind);
    if (d !== 0) return d;
    return a.label.localeCompare(b.label);
  });
  return badges;
}

/**
 * STATE: is the flag still in force?
 *
 * A null reference means the kind's market-wide calendar is unknown; the caller
 * has already degraded to the kind's own newest day by then, so this only sees
 * null when a per-kind map explicitly said "this family has not landed". Answer
 * FALSE there rather than true: an unlanded family cannot attest that anything
 * is in force, and the badge still renders with its date.
 */
function isStateInForce(
  newestDay: string,
  referenceDay: string | null,
): boolean {
  return referenceDay === null ? false : newestDay >= referenceDay;
}

/** POINT: did the event land inside {@link POINT_EVENT_RECENCY_DAYS}? */
function isRecentPointEvent(
  eventDay: string,
  marketDay: string | null,
): boolean {
  if (marketDay === null) return false;
  const e = Date.parse(`${eventDay}T00:00:00.000Z`);
  const m = Date.parse(`${marketDay}T00:00:00.000Z`);
  if (!Number.isFinite(e) || !Number.isFinite(m)) return false;
  // A row dated AFTER the market day is not "in the future" — it is the market
  // day itself moving (an F&O ban published for the next session), so the
  // comparison is one-sided.
  return (m - e) / DAY_MS <= POINT_EVENT_RECENCY_DAYS;
}

/** Is `kind` one this module knows how to style? Exported for the UI's filters. */
export function isKnownStockFlagKind(kind: string): kind is StockFlagKind {
  return KNOWN_KINDS.has(kind);
}

// ─── Headline selection ──────────────────────────────────────────────

/**
 * Does this badge belong in the header strip? — MONEY-1205.
 *
 * ## Why this is a SELECTOR and not a filter inside `buildStockFlagBadges`
 *
 * The builder's output has three other consumers that need the FULL set and
 * would silently lose data if the header's taste were baked in: the screener's
 * `applyFlagValues` reads `PRICE_BAND` off it to populate `priceBand` /
 * `priceBandFlag`, the research tool returns every kind, and the stock page's
 * own history popover renders the rest. `buildStockFlagBadges` answers "what is
 * this stock's flag state"; this answers "what does the header lead with", and
 * those are different questions with different right answers. Nothing is lost —
 * a non-headline badge is still in `badges` and its rows are still in
 * `history`.
 *
 * ## The rule, per kind
 *
 *   SURVEILLANCE   always. ASM/GSM/ESM is THE exception this strip exists for,
 *                  and an ended stint is still the most informative thing on
 *                  the page (the run dates say when).
 *   FO_BAN         when in force. A lifted ban is history, not a warning.
 *   PRICE_BAND     only a NUMERIC band under 20%. 2,429 of 3,489 stocks sit at
 *                  20% (prod, 2026-08-17) — the exchange default — and 208 have
 *                  no band at all because they are F&O names. Neither says
 *                  anything about the stock; a 5% or 2% band says it is being
 *                  restrained.
 *   SERIES_CHANGE  when recent. EQ→BE is real news for a month, then it is just
 *   BAND_CHANGE    the series the stock trades in, which the row itself shows.
 *   WK52_HIGH_LOW  never — published for every stock every session.
 *   SHORT_SELLING  never — a recurring quantity, not a condition. It belongs in
 *                  the F&O panel beside SLB, which is where the number is
 *                  legible.
 *
 * A kind the policy table has never seen returns TRUE. A new NSE family is by
 * construction rare, and the module's standing rule is that it shows up as an
 * unstyled badge rather than vanishing — the opposite default would make the
 * next family invisible until somebody noticed.
 */
export function isHeadlineWorthy(badge: StockFlagBadge): boolean {
  if (!badge) return false;
  switch (badge.kind) {
    case "SURVEILLANCE":
      return true;
    case "FO_BAN":
      return badge.isCurrent;
    case "SERIES_CHANGE":
    case "BAND_CHANGE":
      // POINT kinds: `isCurrent` is the recency window, never "in force".
      return badge.isCurrent;
    case "PRICE_BAND": {
      if (!badge.isCurrent) return false;
      const band =
        badge.parsed?.type === "PRICE_BAND" ? badge.parsed.band : null;
      const pct = finiteOrNull(band);
      return pct !== null && pct < 20;
    }
    case "WK52_HIGH_LOW":
    case "SHORT_SELLING":
      return false;
    default:
      return !isStockFlagKind(badge.kind);
  }
}

/**
 * The header strip: `badges` narrowed by {@link isHeadlineWorthy}, order kept.
 *
 * Returns `[]` for a plain 20%-band, 52-week-only stock — which is most of the
 * market, and is the point. Before this, 100% of stock pages rendered a "flag"
 * strip because `PRICE_BAND` and `WK52_HIGH_LOW` publish for the whole universe
 * daily, so the strip's presence carried no information at all.
 */
export function selectHeadlineStockFlagBadges(
  badges: ReadonlyArray<StockFlagBadge>,
): StockFlagBadge[] {
  return badges.filter((b) => isHeadlineWorthy(b));
}

// ─── Index chips ─────────────────────────────────────────────────────

export interface IndexMembershipRow {
  indexId: string;
  addedOn?: Date | string | null;
  firstSeen?: Date | string | null;
  lastSeen?: Date | string | null;
  removedOn?: Date | string | null;
}

export interface StockIndexChip {
  indexId: string;
  label: string;
  /**
   * Observed join date, or null for "already a member when we started looking".
   * Deliberately NOT back-filled from `firstSeen` — see the `IndexMembership`
   * model note: deriving it would tell a reader that every constituent joined
   * on our earliest snapshot, a fabricated index-wide rebalance.
   */
  addedOn: string | null;
  /** Last day we observed the membership (ISO) — the chip's own `asOf`. */
  lastSeen: string | null;
  /** True when the chip came from `IndexConstituent` (today-only fallback). */
  fallback: boolean;
}

/**
 * Slug → display label.
 *
 * Sized against the REAL universe of ids, not a guess: `index-constituent-sync`
 * writes `ALL_INDEX_IDS = keys(STATIC_INDICES) ∪ keys(MCAP_RANK_SPECS)` —
 * 22 + 14 = 36 ids — and `IndexMembership` is derived from the eight
 * `nse-index-constituents-*` registry families on top of that. All of them are
 * listed here, plus the two bare `midcap150` / `smallcap250` spellings
 * `IndexConstituent`'s own model comment names.
 *
 * An id NOT in this table renders VERBATIM in upper case rather than through a
 * guessed expansion — the same rule surveillance codes follow, and the reason a
 * new NSE index shows up as itself instead of as something invented.
 *
 * `apps/web/lib/screener/index-constituents.ts#INDEX_OPTIONS` carries the same
 * labels and stays where it is: it also encodes option grouping and filter
 * semantics for the screener's dropdown, which is a different concern from
 * labelling a chip, and it is a web module this package cannot import.
 */
const INDEX_LABELS: Readonly<Record<string, string>> = {
  // Broad market (mcap-rank derived)
  nifty50: "Nifty 50",
  niftynext50: "Nifty Next 50",
  nifty100: "Nifty 100",
  nifty200: "Nifty 200",
  nifty500: "Nifty 500",
  niftylargemid250: "Nifty LargeMidcap 250",
  niftytotalmarket: "Nifty Total Market",
  niftymidcap50: "Nifty Midcap 50",
  niftymidcap100: "Nifty Midcap 100",
  niftymidcap150: "Nifty Midcap 150",
  niftysmallcap50: "Nifty Smallcap 50",
  niftysmallcap100: "Nifty Smallcap 100",
  niftysmallcap250: "Nifty Smallcap 250",
  niftymidsmall400: "Nifty MidSmallcap 400",
  niftymicrocap250: "Nifty Microcap 250",
  // Banking & finance
  banknifty: "Bank Nifty",
  niftybank: "Nifty Bank",
  niftyprivatebank: "Nifty Private Bank",
  niftypsubank: "Nifty PSU Bank",
  niftyfinservice: "Nifty Financial Services",
  // Sectoral
  niftyit: "Nifty IT",
  niftypharma: "Nifty Pharma",
  niftyhealthcare: "Nifty Healthcare",
  niftyfmcg: "Nifty FMCG",
  niftyauto: "Nifty Auto",
  niftymetal: "Nifty Metal",
  niftyenergy: "Nifty Energy",
  niftyoilgas: "Nifty Oil & Gas",
  niftyrealty: "Nifty Realty",
  niftymedia: "Nifty Media",
  // Thematic
  niftycommodities: "Nifty Commodities",
  niftyconsumption: "Nifty Consumption",
  niftyinfra: "Nifty Infrastructure",
  niftypse: "Nifty PSE",
  niftycpse: "Nifty CPSE",
  niftymnc: "Nifty MNC",
  niftydivopp50: "Nifty Dividend Opportunities 50",
  // Bare spellings from `IndexConstituent`'s model comment
  midcap150: "Nifty Midcap 150",
  smallcap250: "Nifty Smallcap 250",
};

export function indexChipLabel(indexId: string): string {
  const key = String(indexId ?? "").trim();
  if (key === "") return "";
  return INDEX_LABELS[key.toLowerCase()] ?? key.toUpperCase();
}

/**
 * Open memberships → chips, broadest index first.
 *
 * "Open" is the caller's job (`removedOn: null` in the where clause); anything
 * that arrives here WITH a `removedOn` is dropped, so a widened query cannot
 * quietly start advertising a stock's ex-memberships as current.
 *
 * Duplicate `indexId`s collapse to the stint with the newest `lastSeen`: a
 * symbol that left and returned has two rows by design, and the current stint
 * is the one to chip.
 */
export function buildIndexChips(
  rows: ReadonlyArray<IndexMembershipRow>,
  opts: { fallback?: boolean } = {},
): StockIndexChip[] {
  const best = new Map<string, StockIndexChip>();
  for (const r of rows) {
    if (!r || typeof r.indexId !== "string" || r.indexId.trim() === "")
      continue;
    if (r.removedOn !== null && r.removedOn !== undefined) continue;
    const indexId = r.indexId.trim();
    const chip: StockIndexChip = {
      indexId,
      label: indexChipLabel(indexId),
      addedOn: isoOrNull(r.addedOn ?? null),
      lastSeen: isoOrNull(r.lastSeen ?? null),
      fallback: opts.fallback === true,
    };
    const prev = best.get(indexId);
    if (!prev || (chip.lastSeen ?? "") > (prev.lastSeen ?? "")) {
      best.set(indexId, chip);
    }
  }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ════════════════════════════════════════════════════════════════════
// 14c.2 — delivery
// ════════════════════════════════════════════════════════════════════

export interface DeliveryDayRow {
  date: Date | string;
  deliveryPct?: number | null;
  deliveryQty?: bigint | number | null;
  volume?: number | null;
  avgPrice?: number | null;
  trades?: number | null;
  close?: number | null;
  /**
   * `DailyPrice.source` — "BHAVCOPY", "YAHOO", … It travels WITH the row
   * because the headline must be attributed to the row it was read from, and
   * that is not necessarily the newest row: `source` defaults to "YAHOO" and
   * Yahoo rows carry OHLCV only.
   */
  source?: string | null;
}

export interface DeliveryPoint {
  date: string;
  /** null = NSE reported `-` for the session. NOT zero. */
  deliveryPct: number | null;
}

export interface DeliveryTrend {
  /**
   * Newest session that carries ANY of the delivery columns, else null.
   *
   * "Carries" is load-bearing and is NOT "the newest row we hold". A Yahoo
   * session has OHLCV and no delivery columns at all, so headlining it would
   * date the panel to a day nobody measured delivery on, blank the number, and
   * null the `vsMean20` — with real bhavcopy sessions sitting right behind it.
   */
  latest: {
    date: string;
    deliveryPct: number | null;
    deliveryQty: number | null;
    avgPrice: number | null;
    trades: number | null;
    /** `DailyPrice.source` of THIS row — the row the headline was read from. */
    source: string | null;
  } | null;
  /** Mean delivery % over the last 20 sessions, SKIPPING null sessions. */
  mean20: number | null;
  /** How many of those sessions actually reported a figure — the `n` in n/20. */
  n20: number;
  /** Sessions in the window: `min(20, rows)`. The `20` in n/20. */
  window20: number;
  /** Last 60 sessions oldest→newest, nulls PRESERVED so gaps stay visible. */
  series60: DeliveryPoint[];
  /** `latest.deliveryPct − mean20`; null when either side is unknown. */
  vsMean20: number | null;
}

/**
 * Delivery headline + trend from `DailyPrice` rows.
 *
 * Rows may arrive in any order; sorted newest-first internally. Rows with an
 * unparseable date are dropped, and the headline session is the newest one that
 * REPORTED delivery — see `DeliveryTrend.latest`.
 *
 * The mean is the whole point of this function, so, once more, explicitly: a
 * session whose `deliveryPct` is null contributes to NEITHER the numerator nor
 * the denominator. NSE prints `-` on trade-for-trade series — where delivery is
 * 100% by construction — and folding those in as zero drags the average down on
 * precisely the surveilled, illiquid names whose delivery ratio a retail
 * investor most needs to read correctly. `n20` is returned alongside so the UI
 * can show the honest denominator rather than implying twenty clean readings.
 */
export function computeDeliveryTrend(
  rows: ReadonlyArray<DeliveryDayRow>,
): DeliveryTrend {
  const sorted = rows
    .map((r) => ({ row: r, iso: isoOrNull(r?.date) }))
    .filter((x): x is { row: DeliveryDayRow; iso: string } => x.iso !== null)
    .sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));

  if (sorted.length === 0) {
    return {
      latest: null,
      mean20: null,
      n20: 0,
      window20: 0,
      series60: [],
      vsMean20: null,
    };
  }

  // The HEADLINE row is the newest one that actually reported delivery, not
  // `sorted[0]`. `DailyPrice.source` defaults to "YAHOO" and a Yahoo row has no
  // delivery columns, so on any day the bhavcopy has not landed (or a symbol
  // Yahoo covers and NSE does not) `sorted[0]` is a delivery-less row: the
  // panel then renders a blank %, dates itself to that day, attributes it to
  // "YAHOO" and reports `vsMean20: null`, all while the real sessions it needs
  // sit one row behind. Skipping to the newest REPORTING row costs an older
  // `asOf` — which is the honest answer — and the source travels with it so
  // the chip can never name a provider that did not supply the number.
  const head =
    sorted.find(
      (x) =>
        finiteOrNull(x.row.deliveryPct) !== null ||
        finiteOrNull(x.row.deliveryQty) !== null,
    ) ?? null;
  const latest =
    head === null
      ? null
      : {
          date: head.iso,
          deliveryPct: finiteOrNull(head.row.deliveryPct),
          deliveryQty: finiteOrNull(head.row.deliveryQty),
          avgPrice: finiteOrNull(head.row.avgPrice),
          trades: finiteOrNull(head.row.trades),
          source: textOrNull(head.row.source),
        };

  const window = sorted.slice(0, 20);
  let sum = 0;
  let n = 0;
  for (const x of window) {
    const pct = finiteOrNull(x.row.deliveryPct);
    if (pct === null) continue; // `-` is absence, not 0.
    sum += pct;
    n++;
  }
  const mean20 = n === 0 ? null : round(sum / n);

  const series60: DeliveryPoint[] = sorted
    .slice(0, 60)
    .map((x) => ({ date: x.iso, deliveryPct: finiteOrNull(x.row.deliveryPct) }))
    .reverse();

  return {
    latest,
    mean20,
    n20: n,
    window20: window.length,
    series60,
    vsMean20:
      latest === null || latest.deliveryPct === null || mean20 === null
        ? null
        : round(latest.deliveryPct - mean20),
  };
}

// ════════════════════════════════════════════════════════════════════
// 14c.3 — F&O
// ════════════════════════════════════════════════════════════════════

/** The ΔOI × Δprice quadrant, expanded for display. */
export interface OiBuildupQuadrant {
  buildup: OiBuildup;
  label: string;
  /** What the quadrant says about price and open interest on the day. */
  priceDirection: "UP" | "DOWN";
  oiDirection: "UP" | "DOWN";
  /** Directional read the quadrant conventionally carries. */
  bias: "BULLISH" | "BEARISH";
  tone: StockFlagTone;
  detail: string;
}

/**
 * `DerivativeSummary.oiBuildup` → the display quadrant.
 *
 * The four names are stated slightly differently on every desk and getting
 * LONG and SHORT_COVER the wrong way round is invisible in an aggregate, so the
 * mapping is pinned here against `classifyOiBuildup`'s sign logic
 * (fo-analytics-logic.ts): OI up ⇒ LONG when price rose, SHORT when it fell;
 * OI down ⇒ SHORT_COVER when price rose, LONG_UNWIND when it fell.
 *
 * Null in ⇒ null out. `classifyOiBuildup` returns null when either axis is
 * exactly flat, because a flat day is not a quadrant, and inventing one
 * manufactures a directional call the reader cannot tell apart from a real one.
 */
export function describeOiBuildup(
  buildup: string | null | undefined,
): OiBuildupQuadrant | null {
  switch (buildup) {
    case "LONG":
      return {
        buildup: "LONG",
        label: "Long buildup",
        priceDirection: "UP",
        oiDirection: "UP",
        bias: "BULLISH",
        tone: "info",
        detail: "Price up with open interest up — fresh longs.",
      };
    case "SHORT":
      return {
        buildup: "SHORT",
        label: "Short buildup",
        priceDirection: "DOWN",
        oiDirection: "UP",
        bias: "BEARISH",
        tone: "warn",
        detail: "Price down with open interest up — fresh shorts.",
      };
    case "SHORT_COVER":
      return {
        buildup: "SHORT_COVER",
        label: "Short covering",
        priceDirection: "UP",
        oiDirection: "DOWN",
        bias: "BULLISH",
        tone: "info",
        detail: "Price up with open interest down — shorts closing out.",
      };
    case "LONG_UNWIND":
      return {
        buildup: "LONG_UNWIND",
        label: "Long unwinding",
        priceDirection: "DOWN",
        oiDirection: "DOWN",
        bias: "BEARISH",
        tone: "warn",
        detail: "Price down with open interest down — longs exiting.",
      };
    default:
      return null;
  }
}

// ─── SLB ─────────────────────────────────────────────────────────────

export interface SlbPositionRowInput {
  series?: string | null;
  openQty?: number | null;
  openValue?: number | null;
  expiryDate?: Date | string | null;
}

export interface SlbSeriesRung {
  /** null when the file had no Series column — its own value, not a collision. */
  series: string | null;
  openQty: number;
  openValue: number | null;
  /** Share of the day's total open quantity, %; null when the total is 0. */
  sharePct: number | null;
  expiryDate: string | null;
}

export interface SlbLadder {
  totalOpenQty: number;
  totalOpenValue: number | null;
  seriesCount: number;
  /** Per-series rungs, largest first. NEVER collapsed. */
  series: SlbSeriesRung[];
}

/**
 * Per-series SLB ladder + its derived total.
 *
 * The direction matters. MONEY-1201 widened `@@unique([symbol, date])` to
 * `[symbol, date, series]` after measuring that the old key stored 37,607,169
 * of 238,395,729 open shares — 84.2% of borrow demand discarded, while the run
 * reported 331 successful rows. Summing in the DB read reintroduces exactly
 * that loss at the read side: it destroys the ladder, which is the shape that
 * makes SLB usable as a short-interest proxy. So the rungs are the payload and
 * the total is computed FROM them.
 *
 * `openValue` totals only when at least one rung reports it — summing a set of
 * nulls to 0 would print ₹0 of borrow value for a day nobody priced.
 */
export function buildSlbLadder(
  rows: ReadonlyArray<SlbPositionRowInput>,
): SlbLadder {
  const rungs: SlbSeriesRung[] = [];
  let totalQty = 0;
  let valueSum = 0;
  let valueSeen = 0;

  for (const r of rows) {
    if (!r) continue;
    const qty = finiteOrNull(r.openQty);
    if (qty === null) continue;
    const openValue = finiteOrNull(r.openValue);
    if (openValue !== null) {
      valueSum += openValue;
      valueSeen++;
    }
    totalQty += qty;
    rungs.push({
      series: textOrNull(r.series),
      openQty: qty,
      openValue,
      sharePct: null,
      expiryDate: isoOrNull(r.expiryDate ?? null),
    });
  }

  for (const rung of rungs) {
    rung.sharePct =
      totalQty > 0 ? round((rung.openQty / totalQty) * 100) : null;
  }
  rungs.sort((a, b) => b.openQty - a.openQty);

  return {
    totalOpenQty: totalQty,
    totalOpenValue: valueSeen === 0 ? null : round(valueSum),
    seriesCount: rungs.length,
    series: rungs,
  };
}

// ─── MWPL ────────────────────────────────────────────────────────────

/**
 * Ban-proximity band, or null for "cannot be determined".
 *
 * NULL IS THE NORMAL ANSWER TODAY and must stay distinguishable from "safe".
 * `MwplDaily.mwpl` and `.utilisationPct` are null on every row in the table —
 * NSE's own limit is not in the file the parser reads, and the model's comment
 * forbids populating it from `oi_cli_limit` or any other substitute
 * denominator. So a stock at 97% utilisation and a stock with no MWPL source
 * both arrive here as null, and returning `"NONE"` for them would render an
 * all-clear the data does not support.
 *
 * Thresholds are NSE's: the ban trips at 95% of market-wide position limit, and
 * 80% is the conventional watch level.
 */
export type MwplBand = "NONE" | "WATCH" | "NEAR_BAN";

export function mwplBand(
  utilisationPct: number | null | undefined,
): MwplBand | null {
  const pct = finiteOrNull(utilisationPct);
  if (pct === null) return null;
  if (pct >= 95) return "NEAR_BAN";
  if (pct >= 80) return "WATCH";
  return "NONE";
}

export interface MwplSnapshotRow {
  date?: Date | string | null;
  notionalOi?: number | null;
  futEquivOi?: number | null;
  mwpl?: number | null;
  utilisationPct?: number | null;
  source?: string | null;
}

export interface MwplSnapshot {
  date: string | null;
  notionalOi: number | null;
  futEquivOi: number | null;
  /** null on every row today — see `mwplBand`. */
  mwpl: number | null;
  utilisationPct: number | null;
  /** null ⇒ "not measurable"; the UI must NOT render an all-clear for it. */
  band: MwplBand | null;
  source: string | null;
}

export function buildMwplSnapshot(
  row: MwplSnapshotRow | null | undefined,
): MwplSnapshot | null {
  if (!row) return null;
  const utilisationPct = finiteOrNull(row.utilisationPct);
  return {
    date: isoOrNull(row.date ?? null),
    notionalOi: finiteOrNull(row.notionalOi),
    futEquivOi: finiteOrNull(row.futEquivOi),
    mwpl: finiteOrNull(row.mwpl),
    utilisationPct,
    band: mwplBand(utilisationPct),
    source: textOrNull(row.source),
  };
}

// ─── DerivativeSummary ───────────────────────────────────────────────

export interface DerivativeSummaryRowInput {
  date?: Date | string | null;
  futOi?: bigint | number | null;
  futOiChange?: bigint | number | null;
  futBasisPct?: number | null;
  pcrOi?: number | null;
  pcrVol?: number | null;
  maxPain?: number | null;
  maxPainExpiry?: Date | string | null;
  rolloverPct?: number | null;
  oiBuildup?: string | null;
  nearFutExpiry?: Date | string | null;
  nearFutOi?: bigint | number | null;
  nearFutClose?: number | null;
  callOi?: bigint | number | null;
  putOi?: bigint | number | null;
  callVol?: bigint | number | null;
  putVol?: bigint | number | null;
  underlyingClose?: number | null;
  source?: string | null;
}

export interface DerivativeSummaryView {
  date: string | null;
  /** Every OI/volume field is a NUMBER here — see the BigInt note below. */
  futOi: number | null;
  futOiChange: number | null;
  /** `futOiChange / (futOi − futOiChange)` as %; null when undeterminable. */
  futOiChangePct: number | null;
  futBasisPct: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  maxPain: number | null;
  maxPainExpiry: string | null;
  /** Only meaningful in expiry week — see `isExpiryWeek`. */
  rolloverPct: number | null;
  buildup: OiBuildupQuadrant | null;
  nearFutExpiry: string | null;
  nearFutOi: number | null;
  nearFutClose: number | null;
  callOi: number | null;
  putOi: number | null;
  callVol: number | null;
  putVol: number | null;
  underlyingClose: number | null;
  source: string | null;
  /**
   * True when the summary's own trading day is within `expiryWindowDays` of
   * `nearFutExpiry`. Rollover % is a rollover-week statistic; outside the
   * window it is a real number describing a question nobody asked, so the UI
   * gates on this rather than on the value being non-null.
   */
  isExpiryWeek: boolean;
}

/** Sessions before `nearFutExpiry` within which rollover % is worth showing. */
export const EXPIRY_WINDOW_DAYS = 7;

/**
 * `DerivativeSummary` row → the view the section renders.
 *
 * BIGINT IS THE TRAP THIS FUNCTION EXISTS FOR. `futOi`, `futOiChange`,
 * `nearFutOi`, `callOi`, `putOi`, `callVol` and `putVol` are Prisma `BigInt`,
 * and `JSON.stringify` THROWS on a BigInt — so a server action or a Hono
 * handler that passes the Prisma row straight through crashes at the
 * serialisation boundary, not at the query. Every one of them is coerced to
 * `number` here, once, at the read edge.
 *
 * Precision: NSE-wide futures OI peaks in the 10^9 contracts range, five orders
 * of magnitude inside `Number.MAX_SAFE_INTEGER`, so `Number` is lossless for
 * this data. (`finiteOrNull` also rejects a BigInt that overflows to a
 * non-finite double, which is the only way that could ever stop being true.)
 */
export function buildDerivativeSummaryView(
  row: DerivativeSummaryRowInput | null | undefined,
): DerivativeSummaryView | null {
  if (!row) return null;
  const futOi = finiteOrNull(row.futOi);
  const futOiChange = finiteOrNull(row.futOiChange);
  const prevOi =
    futOi === null || futOiChange === null ? null : futOi - futOiChange;

  const date = isoOrNull(row.date ?? null);
  const nearFutExpiry = isoOrNull(row.nearFutExpiry ?? null);

  return {
    date,
    futOi,
    futOiChange,
    futOiChangePct:
      prevOi === null || prevOi <= 0 || futOiChange === null
        ? null
        : round((futOiChange / prevOi) * 100),
    futBasisPct: finiteOrNull(row.futBasisPct),
    pcrOi: finiteOrNull(row.pcrOi),
    pcrVol: finiteOrNull(row.pcrVol),
    maxPain: finiteOrNull(row.maxPain),
    maxPainExpiry: isoOrNull(row.maxPainExpiry ?? null),
    rolloverPct: finiteOrNull(row.rolloverPct),
    buildup: describeOiBuildup(row.oiBuildup ?? null),
    nearFutExpiry,
    nearFutOi: finiteOrNull(row.nearFutOi),
    nearFutClose: finiteOrNull(row.nearFutClose),
    callOi: finiteOrNull(row.callOi),
    putOi: finiteOrNull(row.putOi),
    callVol: finiteOrNull(row.callVol),
    putVol: finiteOrNull(row.putVol),
    underlyingClose: finiteOrNull(row.underlyingClose),
    source: textOrNull(row.source),
    isExpiryWeek: isExpiryWeek(date, nearFutExpiry),
  };
}

/**
 * Is `date` inside the rollover window before `expiry`?
 *
 * Both bounds inclusive; a summary dated AFTER its own near expiry (which
 * happens on expiry day itself once the contract rolls) is not in the window.
 */
export function isExpiryWeek(
  date: string | null,
  expiry: string | null,
  windowDays = EXPIRY_WINDOW_DAYS,
): boolean {
  if (date === null || expiry === null) return false;
  const d = new Date(date).getTime();
  const e = new Date(expiry).getTime();
  if (!Number.isFinite(d) || !Number.isFinite(e)) return false;
  const days = (e - d) / 86_400_000;
  return days >= 0 && days <= windowDays;
}
