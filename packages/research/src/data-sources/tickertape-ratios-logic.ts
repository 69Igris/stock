/**
 * Tickertape `POST /screener/query` → normalised ratio payload — MONEY-1205.
 *
 * ## Why this is its own module
 *
 * `fetchTickertapeStockRatios` had TWO independent contract bugs, and neither
 * was reachable by a test while the request-building, the HTTP call and the
 * response-mapping all lived inside one `cacheWrap(async () => …)` closure.
 * Splitting the pure halves out is what makes the contract assertable against a
 * CAPTURED response instead of a hand-written one.
 *
 * ## Bug 1 — the query returned the empty set, for every symbol, always
 *
 * The body carried `match: { sid: { values: [sid] } }`. Measured against the
 * live endpoint on 2026-08-18:
 *
 *   match: { sid: { values: ["RELI"] } }  ->  results: [], stats.count: 0
 *   match: { sid: "RELI" }                ->  stats.count: 5858  (filter IGNORED)
 *   sids:  ["RELI"]                       ->  stats.count: 1     (correct)
 *
 * `sid` is not a screener FILTER at all — it is a top-level `sids` array,
 * a sibling of `match`, not a member of it. The caller then read
 * `results[0]`, found `undefined`, and returned null; `syncRatios` early-returns
 * on null, so `ratios-sync-daily` (23:30 IST Mon-Fri) wrote nothing on every run
 * since the query was introduced. Prod's newest `stock_ratios.updatedAt` was
 * 2026-03-21 — five months stale — against 653 live users.
 *
 * Note the second line above is the reason {@link selectRatiosEntry} matches on
 * `sid` rather than taking `results[0]`. A filter this endpoint does not
 * understand does not error: it returns the WHOLE 5,858-row universe, sorted by
 * something else entirely. Under `results[0]` that writes 20 Microns' ratios
 * onto Reliance's row — a silent, total corruption of a table keyed
 * `@@unique([symbol, exchange])`, i.e. one row per symbol with no period
 * dimension to fall back on.
 *
 * ## Bug 2 — 20 of the 27 projected field names do not exist
 *
 * `project` is honoured field-by-field and unknown entries are dropped in
 * silence. Of the 27 names the client asked for, the endpoint returned 7
 * (`mrktCapf`, `pe`, `pb`, `roe`, `roce`, `beta`, `divYield`). The other 20 —
 * `roa`, `evEBITDA`, `debt2Eq`, `curRatio`, `intCover`, `entVal`, `netMrgn`,
 * `revGrwAn` … — were invented spellings. The real names come from
 * `GET https://api.tickertape.in/screener/filters` (247 filters, `label` is the
 * projectable name), and are captured in {@link TICKERTAPE_RATIO_WIRE_KEYS}.
 *
 * ## What is deliberately still unmapped
 *
 * Six columns stay absent because no FREE field on this endpoint MEANS what the
 * column means. Filling them with the nearest-looking metric is the fabrication
 * class this whole audit exists to remove, so they are listed with their reason
 * in {@link TICKERTAPE_RATIO_UNMAPPED} rather than quietly aliased:
 *
 *   operatingMargin  `aopm` is EBITDA Margin. EBITDA excludes D&A; operating
 *                    margin does not. Different number, same-looking name.
 *   grossMargin      no gross-margin field exists (only `balCogs`, the raw COGS
 *                    line, from which margin cannot be derived without revenue
 *                    of the same period).
 *   pegRatio         absent from the filter catalogue entirely.
 *   earningsGrowth   the catalogue offers EPS growth (`epsg`, `epsGwth`) and
 *   earningsGrowth3Y EBITDA growth (`ebitg`, `earnings`) — neither is net-profit
 *   earningsGrowth5Y growth, and EPS growth diverges from it on any buyback or
 *                    issuance.
 *   revenueGrowth3Y  only the 1Y and 5Y horizons are published.
 *   targetPrice      `fair` / `ptir` are premium — the endpoint answers
 *   recommendation   `breco` is premium — `{"success":false,"error":"No access
 *                    for …"}` for the WHOLE request, so asking for them would
 *                    take the other 14 fields down with them.
 */

/** A `stock` entry as `POST /screener/query` returns it. */
export interface TickertapeScreenerEntry {
  sid?: unknown;
  stock?: {
    advancedRatios?: Record<string, unknown>;
    info?: Record<string, unknown>;
  };
}

/** The envelope `POST /screener/query` returns. */
export interface TickertapeScreenerResponse {
  success?: unknown;
  data?: {
    results?: unknown;
    stats?: { count?: unknown };
  };
  error?: unknown;
}

/**
 * Column → the wire field that actually carries it.
 *
 * Every entry here was confirmed to return a value for RELIANCE, HDFCBANK, TCS,
 * 63MOONS and YESBANK on 2026-08-18, and each is documented in the endpoint's
 * own filter catalogue under the quoted `display` name. The pairing is
 * SEMANTIC, not lexical: a wire field is only listed when its published
 * meaning is the column's meaning.
 */
export const TICKERTAPE_RATIO_WIRE_KEYS = {
  /** "PE Ratio". The undocumented alias `pe` returns an identical value. */
  pe: "apef",
  /** "PB Ratio". The undocumented alias `pb` returns an identical value. */
  pb: "pbr",
  /** "EV/EBITDA Ratio" */
  evToEbitda: "evebitd",
  /** "Return on Equity" */
  roe: "roe",
  /** "Return on Assets" */
  roa: "rtnAsts",
  /** "ROCE" */
  roce: "roce",
  /** "Net Profit Margin" */
  netMargin: "pftMrg",
  /** "1Y Historical Revenue Growth" */
  revenueGrowth: "rvng",
  /** "5Y Historical Revenue Growth" */
  revenueGrowth5Y: "5YrevChg",
  /** "Debt to Equity" */
  debtToEquity: "dbtEqt",
  /** "Current Ratio" */
  currentRatio: "qcur",
  /** "Interest Coverage Ratio" */
  interestCoverage: "aint",
  /** "Beta" */
  beta: "beta",
  /** "Dividend Yield". The undocumented alias `divYield` is identical. */
  divYield: "divDps",
  /** "Market Cap" */
  mCap: "mrktCapf",
  /** "Enterprise Value" */
  enterpriseValue: "ev",
} as const satisfies Record<string, string>;

/**
 * Columns this endpoint CANNOT fill, and why. Exported so the reason travels
 * with the code rather than living in a commit message — the failure mode being
 * guarded is someone "completing" the map with a near-miss field.
 */
export const TICKERTAPE_RATIO_UNMAPPED = {
  operatingMargin: "aopm is EBITDA Margin, which excludes D&A",
  grossMargin: "no gross-margin field is published",
  pegRatio: "absent from the filter catalogue",
  earningsGrowth: "only EPS growth and EBITDA growth are published",
  earningsGrowth3Y: "only EPS growth and EBITDA growth are published",
  earningsGrowth5Y: "only EPS growth and EBITDA growth are published",
  revenueGrowth3Y: "only the 1Y and 5Y horizons are published",
  targetPrice: "premium-gated (fair/ptir) — 403s the whole request",
  recommendation: "premium-gated (breco) — 403s the whole request",
} as const satisfies Record<string, string>;

/**
 * The `project` list, derived from the map so the two can never drift.
 *
 * Derived rather than written out because the previous list was hand-kept and
 * 20 of its 27 entries had no counterpart on the wire — a divergence nothing
 * could detect, since an unknown projection is dropped without an error.
 */
export const TICKERTAPE_RATIO_PROJECTION: ReadonlyArray<string> = Object.values(
  TICKERTAPE_RATIO_WIRE_KEYS,
);

/**
 * Build the request body for a single stock's ratios.
 *
 * `match` stays present-but-empty: the endpoint accepts its absence, but every
 * other caller in this client sends one and an empty object is what "no filter"
 * means here. `sids` is what actually selects the row.
 */
export function buildTickertapeRatiosQuery(sid: string): {
  match: Record<string, never>;
  sids: string[];
  project: ReadonlyArray<string>;
  offset: number;
  count: number;
} {
  return {
    match: {},
    sids: [sid],
    project: TICKERTAPE_RATIO_PROJECTION,
    offset: 0,
    // `count` TRUNCATES the result page while `stats.count` reports the true
    // total, so it must never be smaller than the number of sids requested.
    count: 1,
  };
}

/**
 * Pick the entry for `sid` out of a screener page.
 *
 * Results do NOT come back in request order — a captured three-sid response
 * asked for `[RELI, TCS, HDBK]` and returned `[RELI, HDBK, TCS]`
 * (`__tests__/fixtures/tickertape-screener-ratios-multi.json`). More
 * importantly, a filter this endpoint does not understand is IGNORED rather
 * than rejected, so `results[0]` is a live mis-attribution risk and not merely
 * an ordering nicety. Returning null on no match is correct: the caller treats
 * null as "nothing to write", which leaves the incumbent row alone.
 */
export function selectRatiosEntry(
  sid: string,
  results: unknown,
): TickertapeScreenerEntry | null {
  if (!Array.isArray(results)) return null;
  const want = sid.trim().toUpperCase();
  for (const entry of results as TickertapeScreenerEntry[]) {
    if (typeof entry?.sid !== "string") continue;
    if (entry.sid.trim().toUpperCase() === want) return entry;
  }
  return null;
}

/**
 * Normalise one wire value.
 *
 * Three outcomes, and the difference between them is the whole point:
 *   - `undefined` — the endpoint did not return the field. ABSENT. The caller
 *     must omit it, never write a null over a live value.
 *   - `null` — the endpoint positively reported it as unavailable (HDFC Bank
 *     has no meaningful current ratio; the captured fixture carries
 *     `qcur: null`). That is information and is preserved.
 *   - a finite number — kept AS IS, including `0`. The captured fixture carries
 *     `dbtEqt: 0` for HDFCBANK, and a zero debt-to-equity is a fact about the
 *     company. `parseFloat(x) || null` and `Number(x) || undefined` both
 *     destroy it.
 *
 * Anything else (NaN, Infinity, a string, an object) is UNRESOLVED, not zero.
 */
function normaliseRatio(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  return undefined;
}

/** The normalised payload `fetchTickertapeStockRatios` resolves to. */
export interface TickertapeRatiosPayload {
  ticker: string;
  name: string;
  [key: string]: unknown;
}

/**
 * Map a screener response onto the client's normalised ratio names.
 *
 * Returns null when the response carries no entry for `sid` — an empty page, a
 * page about other stocks, or a body without `stock`. Null means "nothing was
 * learned", and every caller treats it as "do not write".
 *
 * The raw wire fields are spread FIRST and the normalised names written over
 * them, so `rawData` keeps the untouched upstream payload for provenance while
 * a wire key that happens to share a column's spelling can never win over the
 * mapping. (The previous version spread `...r` LAST, which let the wire decide.)
 */
export function mapTickertapeRatiosPayload(
  sid: string,
  resp: TickertapeScreenerResponse | null | undefined,
): TickertapeRatiosPayload | null {
  const entry = selectRatiosEntry(sid, resp?.data?.results);
  if (!entry?.stock) return null;

  const r = entry.stock.advancedRatios ?? {};
  const info = entry.stock.info ?? {};

  const out: Record<string, unknown> = { ...r };

  // `ticker` and `name` are NOT projectable — asking for them returns nothing.
  // They arrive on `stock.info` regardless of what `project` requests.
  out.ticker = typeof info.ticker === "string" ? info.ticker : sid;
  out.name = typeof info.name === "string" ? info.name : sid;

  for (const [column, wireKey] of Object.entries(
    TICKERTAPE_RATIO_WIRE_KEYS,
  ) as Array<[string, string]>) {
    const v = normaliseRatio(r[wireKey]);
    if (v === undefined) {
      // UNRESOLVED — and the column name must be DELETED, not merely skipped.
      //
      // Three wire names are spelled exactly like the column they fill (`roe`,
      // `roce`, `beta`), so the `...r` spread has already put the raw value
      // under the column's own name. Skipping would leave a NaN — or, for a
      // non-colliding pair like `apef`->`pe`, a stale undocumented alias —
      // sitting in the column as though the mapper had resolved it. The
      // mapping owns the column name unconditionally; the raw payload does not
      // get a vote.
      delete out[column];
      continue;
    }
    out[column] = v;
  }

  return out as TickertapeRatiosPayload;
}
