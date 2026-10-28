/**
 * Provenance envelope for data-engine-backed sections — MONEY-1204 (P14 / 14c.0).
 *
 * Every section added in Lane 14c reads a table the user has never seen before:
 * NSE shareholding rather than Tickertape's, filings from the exchange rather
 * than a scraper, per-underlying FII positioning. Those tables disagree with the
 * incumbents sometimes, and they are empty sometimes. Both of those are fine —
 * what is not fine is a number on screen with no way to tell WHICH source it
 * came from and HOW OLD it is.
 *
 * So the envelope is not decoration. It is the thing that makes the rest of the
 * lane safe to ship:
 *
 *   - `source` lets the UI label a value, which is what makes a
 *     PRIMARY-with-fallback reader (14c.4 shareholding, 14c.8 financials,
 *     14d.1 MF portfolio, 14d.4 movers) honest instead of merely convenient.
 *     Every one of those falls back to a different provider under some
 *     condition; unlabelled, the user cannot tell which one they are looking at.
 *   - `asOf` is what stops a stale panel reading as a live one. A section whose
 *     data stopped updating three weeks ago looks identical to a quiet market
 *     unless the timestamp is on screen.
 *   - `empty` is an explicit BOOLEAN rather than something the caller infers
 *     from `rows.length === 0`. Those are different questions once a fallback
 *     exists: zero rows from the primary with a populated fallback is not empty,
 *     and zero rows because NSE has published nothing yet is not an error. The
 *     house rule is that a missing row returns `success: true` with an empty
 *     payload and the component owns the empty state — this field is what the
 *     component branches on.
 *
 * Lives in `@usemoney/services` because the web action and its `apps/api` mirror
 * must return the SAME shape, and the standing rule is that those two stay in
 * sync. One definition, imported by both, is the only version of that rule a
 * reviewer does not have to enforce by eye.
 */

/** Where a section's data actually came from. */
export interface Provenance {
  /**
   * The producing source, in the vocabulary the DB stores — `"NSE_XBRL"`,
   * `"TICKERTAPE"`, `"NSE_SHP"`, a registry family id like `"nse-fii-stats"`.
   * Stored verbatim and decoded for display at the render boundary, the same
   * rule `StockFlag` follows for surveillance codes.
   */
  source: string | null;
  /**
   * When the underlying data describes, NOT when we fetched it. For a daily
   * feed that is the trading day; for a quarterly filing, the quarter end.
   * ISO-8601 or null when the rows carry no date at all.
   */
  asOf: string | null;
  /**
   * True when there is genuinely nothing to show for this symbol. Distinct from
   * an error, and distinct from `data` being an empty array after a fallback
   * supplied rows.
   */
  empty: boolean;
  /**
   * Set when `source` is NOT the section's preferred provider — e.g.
   * shareholding served from Tickertape because NSE has no row. The UI must
   * label these visibly; a fallback the user cannot see is a silent downgrade.
   */
  fallback?: boolean;
  /** Optional one-line note the UI may surface on hover. */
  note?: string;
}

export type WithProvenance<T> = Provenance & { data: T };

/**
 * Wrap rows in the section envelope.
 *
 * `empty` is DERIVED here rather than trusted from the caller, because the one
 * thing every caller gets wrong under time pressure is passing `empty: false`
 * alongside an empty array. Pass `emptyOverride` only for the genuine exception:
 * a section whose payload is an object rather than a list, where "nothing to
 * show" cannot be read off a length.
 */
export function withProvenance<T>(
  data: T,
  meta: {
    source?: string | null;
    asOf?: Date | string | null;
    fallback?: boolean;
    note?: string;
    emptyOverride?: boolean;
  } = {},
): WithProvenance<T> {
  const empty = meta.emptyOverride ?? isEmptyPayload(data);
  return {
    data,
    source: meta.source ?? null,
    asOf: toIso(meta.asOf ?? null),
    empty,
    ...(meta.fallback === true ? { fallback: true } : {}),
    ...(meta.note ? { note: meta.note } : {}),
  };
}

/**
 * "Is there nothing to show?"
 *
 * Deliberately does NOT treat `0` or `false` as empty — a delivery percentage of
 * 0 and a flag count of 0 are real, published facts, and the whole absence-rules
 * discipline in this codebase exists to keep "reported zero" distinguishable
 * from "not reported". Only null/undefined, an empty array, and an object with
 * no own keys count.
 */
function isEmptyPayload(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data as object).length === 0;
  return false;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * The newest date across a set of rows, for `asOf`.
 *
 * Returns null on an empty set rather than "now" — stamping an empty section
 * with the current time is precisely the lie `asOf` exists to prevent. Non-date
 * and invalid values are skipped, not coerced, so one malformed row cannot make
 * a whole section look fresh.
 */
export function latestAsOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  field = "date",
): Date | null {
  let best: number | null = null;
  for (const r of rows) {
    const raw = r[field];
    const t =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === "string" || typeof raw === "number"
          ? new Date(raw).getTime()
          : NaN;
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best);
}
