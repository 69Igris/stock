/**
 * Corporate-action REQUEST CHUNKING — MONEY-1098 (P5.2).
 *
 * ## Why this exists
 *
 * Both whole-market corporate-action feeds take a `(fromDate, toDate)` window:
 *   - NSE  `corporates-corporateActions` — `from_date` / `to_date` (DD-MM-YYYY)
 *   - BSE  `DefaultData/w`               — `Fdate` / `TDate`      (dd MMM yyyy)
 *
 * Neither one honours an ARBITRARILY wide window. A 20-year request is rejected
 * or — far worse — silently truncated to the most recent slice, which is
 * indistinguishable from "the market had no corporate actions in 2005". That is
 * the same failure shape MONEY-1085 hit with the instrument masters: no error,
 * the data just never arrives, and every downstream count looks plausible.
 *
 * So the fetchers keep their public `(fromDate, toDate)` signature and chunk
 * INTERNALLY into windows of at most {@link MAX_CORP_ACTION_WINDOW_DAYS} days,
 * fetched SEQUENTIALLY (never in parallel — both hosts rate-limit, and NSE's
 * Akamai layer 403s bursts) and concatenated.
 *
 * ## Why the splitter is pure and exported
 *
 * Chunk-boundary arithmetic is the whole correctness surface: one off-by-one and
 * you either DROP a day (a dividend that silently never existed) or DOUBLE-COUNT
 * one (a duplicate row that the dedupe key happens to absorb today, and won't
 * the day someone adds a counter). {@link splitDateWindows} is therefore a pure
 * function with no IO, unit-tested to prove the windows re-union EXACTLY to the
 * requested range — no gap, no overlap, each endpoint present exactly once.
 *
 * ## Day granularity, UTC
 *
 * Both APIs see a DATE, not an instant, so the splitter floors everything to UTC
 * midnight and steps in whole 86_400_000 ms days. UTC (not local) because a
 * local-midnight step crosses DST in half the world's zones and silently yields
 * 23- or 25-hour "days"; the exchange formatters (`formatNSEDate`,
 * `formatBseDate`) already read their components with `getUTC*`, so this matches
 * what actually goes on the wire.
 *
 * Windows are INCLUSIVE at both ends (that is how both APIs read them), so
 * consecutive windows must be ADJACENT — `next.from === prev.to + 1 day` — not
 * overlapping at the shared boundary.
 */

import { fetchNSECorporateActionsBulk } from "./nse-filings";
import type { NSECorporateAction } from "./nse-filings-types";

const MS_PER_DAY = 86_400_000;

/**
 * Largest window either feed answers reliably. 180 days ≈ two quarters, which
 * comfortably covers the daily/weekly incremental sync and keeps a 20-year
 * backfill at ~41 requests rather than one silently-truncated one.
 */
export const MAX_CORP_ACTION_WINDOW_DAYS = 180;

/**
 * Default pause between sequential windows.
 *
 * The single-call fetchers never needed pacing — one request per run pauses
 * itself. A backfill is now a BURST of 41 requests at the same host, which is
 * exactly the shape NSE's Akamai layer answers with a 403 challenge page (and
 * BSE with a 429). Read per-call from the env so tests can zero it out; a 41 ×
 * 1.2s sleep inside a unit test is an orphan waiting to happen.
 */
const DEFAULT_WINDOW_PACE_MS = 1_200;

/** An inclusive `[from, to]` date window, both ends floored to UTC midnight. */
export interface DateWindow {
  from: Date;
  to: Date;
}

/** Effective inter-window pace, env-overridable (`CORP_ACTIONS_WINDOW_PACE_MS`). */
export function windowPaceMs(): number {
  const n = Number(process.env.CORP_ACTIONS_WINDOW_PACE_MS);
  // `>= 0` on purpose: 0 is a legitimate value (tests, local backfills) and must
  // not fall through to the default the way a falsy check would.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WINDOW_PACE_MS;
}

/** Floor a Date to UTC midnight. Returns null for missing / Invalid Date. */
export function toUtcDay(d: Date | null | undefined): Date | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/**
 * Inclusive day count of a `[from, to]` range — `from === to` is ONE day, not
 * zero. Exported because "how many days did we ask for" is what the window-count
 * log line and its tests are asserting against.
 */
export function inclusiveDaySpan(from: Date, to: Date): number {
  const a = toUtcDay(from);
  const b = toUtcDay(to);
  if (!a || !b) return 0;
  const diff = Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
  return diff < 0 ? 0 : diff + 1;
}

/**
 * Split `[from, to]` (inclusive) into consecutive windows of at most `maxDays`
 * DAYS each.
 *
 * Guarantees, all pinned by unit tests:
 *   - `windows[0].from` equals the requested `from` (floored to UTC midnight)
 *   - `windows.at(-1).to` equals the requested `to`
 *   - `windows[i].from === windows[i-1].to + 1 day` — adjacent, so no gap and no
 *     overlap; every calendar day in the range is covered EXACTLY once
 *   - every window spans `>= 1` and `<= maxDays` days
 *   - the inclusive day counts sum to `inclusiveDaySpan(from, to)`
 *
 * Returns `[]` for an inverted range (`to < from`) or an Invalid Date — a caller
 * that asked for nothing coherent gets no requests rather than an accidental
 * whole-market pull. Never throws.
 */
export function splitDateWindows(
  from: Date,
  to: Date,
  maxDays: number = MAX_CORP_ACTION_WINDOW_DAYS,
): DateWindow[] {
  const start = toUtcDay(from);
  const end = toUtcDay(to);
  if (!start || !end) return [];
  if (end.getTime() < start.getTime()) return [];

  // A non-finite / non-positive cap would loop forever or emit zero-day windows.
  const step =
    Number.isFinite(maxDays) && maxDays >= 1
      ? Math.floor(maxDays)
      : MAX_CORP_ACTION_WINDOW_DAYS;

  const windows: DateWindow[] = [];
  let cursor = start.getTime();
  const last = end.getTime();

  while (cursor <= last) {
    // `step - 1` because the window is INCLUSIVE of its own start day: a 180-day
    // window running from day D ends on D+179, and the NEXT window starts at
    // D+180. Using `step` here is the off-by-one that silently overlaps every
    // boundary by a day.
    const windowEnd = Math.min(cursor + (step - 1) * MS_PER_DAY, last);
    windows.push({ from: new Date(cursor), to: new Date(windowEnd) });
    cursor = windowEnd + MS_PER_DAY;
  }

  return windows;
}

/** Sleep helper; skips the timer entirely at `<= 0` so tests leave nothing armed. */
async function pace(ms: number): Promise<void> {
  if (!(ms > 0)) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * What a windowed walk produced, and what it could NOT ask for.
 *
 * `failedWindows` is the whole point: it is the difference between "these are
 * the corporate actions of the last 20 years" and "these are the corporate
 * actions of the last 20 years MINUS nine months nobody noticed". A caller that
 * ignores it is asserting completeness it has not checked.
 */
export interface WindowedFetchResult<T> {
  rows: T[];
  /** Windows whose fetcher returned null (asked, never answered). */
  failedWindows: DateWindow[];
}

/**
 * Render failed windows as `DD-MM-YYYY..DD-MM-YYYY` for an operator to act on.
 *
 * Deliberately the SAME `DD-MM-YYYY` grammar the NSE query takes, so a logged
 * failure can be pasted straight back into a heal run instead of being
 * translated by hand — the previous incident was found by grepping run logs and
 * hand-reconstructing 37 ranges.
 *
 * Caps the list so one catastrophic run cannot emit a 41-window log line, but
 * says how many it dropped rather than truncating silently.
 */
export function describeWindows(
  windows: readonly DateWindow[],
  max = 8,
): string {
  const fmt = (d: Date): string => {
    if (Number.isNaN(d.getTime())) return "unparseable";
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  };
  const shown = windows
    .slice(0, max)
    .map((w) => `${fmt(w.from)}..${fmt(w.to)}`)
    .join(", ");
  return windows.length > max
    ? `${shown} (+${windows.length - max} more)`
    : shown;
}

export interface FetchInWindowsOptions {
  /** Max days per request (default {@link MAX_CORP_ACTION_WINDOW_DAYS}). */
  maxDays?: number;
  /** Pause between windows (default {@link windowPaceMs}). */
  paceMs?: number;
  /** Short label used in the split log line, e.g. `"NSE corp-actions"`. */
  label?: string;
  /** Log sink (default `console.log`) — injected so tests stay silent. */
  log?: (message: string) => void;
}

/**
 * Run `fetchWindow` once per chunk of `[from, to]`, SEQUENTIALLY, and
 * concatenate the results in chronological order.
 *
 * Logs the split whenever it produces more than one window
 * (`"NSE corp-actions: 7306d span -> 41 windows (<=180d each)"`). A 20-year
 * backfill that looks like a single call in the logs is the observability gap
 * that has bitten this repo repeatedly — the count is the only cheap signal that
 * chunking is actually engaged.
 *
 * Errors PROPAGATE. Per-window degradation is the caller's decision, because
 * the two feeds disagree about it: BSE's persistent 429 must circuit-break the
 * whole run, while a single flaky NSE window should not cost you the other 40.
 *
 * A window whose fetcher returns `null` is a FAILED window: it is recorded in
 * {@link WindowedFetchResult.failedWindows} and the walk continues. `[]` still
 * means the fetcher answered and the window was genuinely empty — conflating
 * the two is what let a 20-year backfill lose 37 windows and report success
 * (MONEY-1189).
 */
export async function fetchInWindows<T>(
  from: Date,
  to: Date,
  fetchWindow: (window: DateWindow) => Promise<T[] | null>,
  options: FetchInWindowsOptions = {},
): Promise<WindowedFetchResult<T>> {
  const maxDays = options.maxDays ?? MAX_CORP_ACTION_WINDOW_DAYS;
  const windows = splitDateWindows(from, to, maxDays);
  if (windows.length === 0) return { rows: [], failedWindows: [] };

  if (windows.length > 1) {
    const log = options.log ?? ((m: string) => console.log(m));
    const label = options.label ?? "corp-actions";
    log(
      `[corp-actions-window] ${label}: ${inclusiveDaySpan(from, to)}d span -> ` +
        `${windows.length} windows (<=${maxDays}d each)`,
    );
  }

  const paceMs = options.paceMs ?? windowPaceMs();
  const all: T[] = [];
  const failedWindows: DateWindow[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const rows = await fetchWindow(w);
    if (rows === null) failedWindows.push(w);
    else all.push(...rows);
    // Pace BETWEEN windows only — a trailing sleep just makes every run slower.
    if (i < windows.length - 1) await pace(paceMs);
  }
  return { rows: all, failedWindows };
}

// ── NSE bulk corporate actions, windowed ─────────────────────────────────────

/**
 * Parse NSE's own `DD-MM-YYYY` query format back into a UTC-midnight `Date`.
 *
 * `fetchNSECorporateActionsBulk` accepts an ALREADY-FORMATTED string as well as
 * a `Date`, so the windowed wrapper has to be able to round-trip it. `new
 * Date("15-03-2024")` is not a thing V8 parses (and where it does guess, it
 * guesses American), hence the explicit parse.
 */
export function parseNSEDate(value: string): Date | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates that JS would roll over (31-02-2024 -> 2 Mar).
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/** Coerce the `Date | string` the public fetchers accept into a real Date. */
function coerceWindowDate(value: Date | string): Date | null {
  if (value instanceof Date) return toUtcDay(value);
  return parseNSEDate(value);
}

/**
 * MONEY-1098 (P5.2) — {@link fetchNSECorporateActionsBulk} with `<=180`-day
 * request chunking.
 *
 * Same public `(fromDate, toDate)` signature as the raw bulk fetcher. It returns
 * a {@link WindowedFetchResult} rather than a bare array so a caller cannot
 * silently treat a partially-fetched span as complete — the underlying fetcher
 * returns `null` when every retry is exhausted, and one bad window costs that
 * window and nothing else PROVIDED the caller reports it.
 *
 * Cross-window duplicates are NOT filtered here on purpose. The windows are
 * adjacent-not-overlapping, so NSE would have to echo an action outside the
 * window it was asked for to produce one — and if it does, the persist seam
 * (`dedupeCorporateActions`, keyed `[symbol, exchange, type, exDate]`) collapses
 * it anyway. Filtering here would just be a second, drifting copy of that key.
 *
 * Degrades to a SINGLE unwindowed call when the inputs can't be parsed into a
 * range (rather than returning nothing), preserving the old behaviour exactly
 * for any caller passing something unexpected.
 */
export async function fetchNSECorporateActionsBulkWindowed(
  fromDate: Date | string,
  toDate: Date | string,
  options: FetchInWindowsOptions = {},
): Promise<WindowedFetchResult<NSECorporateAction>> {
  const from = coerceWindowDate(fromDate);
  const to = coerceWindowDate(toDate);
  if (!from || !to) {
    // Unparseable range: one unwindowed call, still reporting failure honestly.
    const rows = await fetchNSECorporateActionsBulk(fromDate, toDate);
    return rows === null
      ? {
          rows: [],
          failedWindows: [{ from: new Date(NaN), to: new Date(NaN) }],
        }
      : { rows, failedWindows: [] };
  }
  return fetchInWindows(
    from,
    to,
    (w) => fetchNSECorporateActionsBulk(w.from, w.to),
    { label: "NSE corp-actions", ...options },
  );
}
