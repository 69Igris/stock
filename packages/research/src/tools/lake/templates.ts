/**
 * `query_lake`'s templates, and everything about a call that can be decided
 * without BigQuery. MONEY-1597 (data-platform C5b).
 *
 * PURE: no BigQuery, no Redis, no clock (`today` is an argument). The tool
 * (`../query-lake.ts`) validates here, keys its cache here, and hands the job
 * this module builds to BigQuery verbatim — so every limit the brief sets is a
 * value a test can read rather than a behaviour it would have to provoke.
 *
 * ## NO FREE-FORM SQL, AND NOTHING A CALLER SENDS IS INTERPOLATED
 *
 * A call names one of FOUR templates and supplies values. Values are BOUND as
 * named query parameters; the only text substituted into a template is the two
 * dataset names, and those come from the tool's own configuration. An argument
 * whose NAME mentions SQL is refused outright, so a planner that tries to hand
 * the tool a query gets told no instead of having it silently ignored.
 *
 * ## DATES ARE BOUND AS STRINGS — MONEY-1538
 *
 * `@google-cloud/bigquery` serialises a DATE- or TIMESTAMP-typed parameter by
 * reading `value.value`, which a plain string does not have, so a string sent
 * as DATE reaches BigQuery as NULL and `observed_date >= NULL` matches nothing
 * — an empty, successful answer. Every date here is a STRING parsed IN SQL by
 * `PARSE_DATE('%Y-%m-%d', @x)` (packages/lake/src/load.ts `dateBound`), and a
 * test serialises every template's parameters through the client's own
 * `valueToQueryParameter_` to prove each one arrives.
 *
 * ## WHY THE SQL IS HERE TWICE
 *
 * The brief puts each template in `sql/<name>.sql`, where it reads as SQL and
 * reviews as SQL. But the research tools ship inside the WORKERS bundle, which
 * copies `dist/` and nothing else, and inside apps/web's server bundle — neither
 * carries a `.sql` file, and a runtime `readFileSync` would ENOENT on the first
 * real call. So the text is mirrored below as string constants, and
 * `packages/research/__tests__/query-lake.test.ts` fails if a single byte
 * differs from the file. Edit the `.sql`, then paste it here.
 */
import { createHash } from "node:crypto";
import { EVENT_MARKETS, EVENT_TYPES } from "@usemoney/core/events/event-types";
import { buildListingId } from "@usemoney/core/market-data/tiingo/tiingo-logic";

export const LAKE_TEMPLATES = [
  "events_for_listing",
  "event_outcomes_by_type",
  "rolling_stats_for",
  "universe_top_by",
] as const;
export type LakeTemplate = (typeof LAKE_TEMPLATES)[number];

/**
 * The per-call ceilings. The byte cap is enforced BY BIGQUERY
 * (`maximumBytesBilled` — a query that would bill more fails before it is
 * charged), the timeout by BigQuery too (`jobTimeoutMs` cancels the job), and
 * the row cap by `LIMIT @row_limit` — bound one past the cap so a cut answer
 * says so — and a slice after the fetch.
 *
 * 2 GiB, measured: while `rolling_stats` was a VIEW, one listing's
 * `rolling_stats_for` dry-ran at 1.61 GB over prod's 14.3M India bars
 * (2026-09-23) — the whole adjusted history recomputed per call, and US bars
 * (MONEY-1513) would have crossed the cap. MONEY-1606 materialised it,
 * partitioned by month and clustered by (market, listing_id): the same two
 * templates dry-run at 20.4 MB and 11.9 MB against a table of that shape.
 * Raise nothing here; a template that nears the cap wants a table.
 */
export const LAKE_QUERY_LIMITS = Object.freeze({
  maximumBytesBilled: 2 * 1024 ** 3,
  jobTimeoutMs: 20_000,
  maxRows: 500,
  cacheTtlSeconds: 15 * 60,
});

/**
 * The metrics `universe_top_by` may rank by, and the fewest sessions a
 * listing's window must hold for that metric to mean what its name says.
 * The CASE in `universe_top_by.sql` has one branch per key; a test holds the
 * two lists together.
 */
export const UNIVERSE_METRICS = Object.freeze({
  realised_vol_30d: 30,
  avg_volume_20: 20,
  pct_above_sma_50: 50,
  pct_above_sma_200: 200,
  pct_below_52w_high: 252,
  pct_above_52w_low: 252,
} as const);
export type UniverseMetric = keyof typeof UNIVERSE_METRICS;

/** How far back an events template looks when the caller names no `since`. */
export const DEFAULT_SINCE_DAYS = 365;
/** `universe_top_by`'s default `n`. */
export const DEFAULT_TOP_N = 20;
/** How recent a listing's last session must be to be ranked by `universe_top_by`. */
export const UNIVERSE_FRESH_DAYS = 7;

/** A refusal. The tool turns it into `{ success: false, error }`. */
export class LakeRequestError extends Error {
  constructor(message: string) {
    super(`query_lake: ${message}`);
    this.name = "LakeRequestError";
  }
}

export type LakeParamType = "STRING" | "INT64";

/** A validated call: the template and every parameter it binds, typed. */
export interface LakeRequest {
  template: LakeTemplate;
  params: Record<string, string | number>;
  types: Record<string, LakeParamType>;
  /**
   * The rows the caller may see. The SQL is bound to fetch ONE MORE
   * (`row_limit = rowCap + 1`), so an answer that was cut is known to have
   * been cut — `truncated` is read off that extra row, never inferred.
   */
  rowCap: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   Validation
   ──────────────────────────────────────────────────────────────────────── */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as `YYYY-MM-DD`, or a refusal. */
function day(value: unknown, name: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!ISO_DAY.test(s)) {
    throw new LakeRequestError(
      `${name} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  const ms = Date.parse(`${s}T00:00:00Z`);
  // `Date.parse` rolls 2026-02-31 into March rather than failing, so the
  // round trip is what refuses an impossible day.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== s) {
    throw new LakeRequestError(`${name} is not a calendar day: ${s}`);
  }
  return s;
}

function shiftDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  const s = typeof value === "string" ? value.trim() : "";
  if (!(allowed as readonly string[]).includes(s)) {
    throw new LakeRequestError(
      `${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return s as T;
}

/** `{symbol}:{venue}:{listingStart|unknown}` — the one lake spelling. */
const LISTING_ID =
  /^[^:\s]{1,32}:[A-Z][A-Z ]{0,15}:(?:\d{4}-\d{2}-\d{2}|unknown)$/;
const TICKER = /^[A-Z0-9][A-Z0-9.&-]{0,19}$/;

/** Where a bare symbol trades. India ids are derivable; US ones are not. */
const INDIA_EXCHANGES = ["NSE", "BSE"] as const;
const US_VENUES = [
  "US",
  "NASDAQ",
  "NYSE",
  "AMEX",
  "NYSE ARCA",
  "NYSE MKT",
  "BATS",
] as const;

/**
 * Which listing a per-listing template reads.
 *
 *   listing_id  the full lake id, exact.
 *   symbol      a ticker, in the RAW form or the research agent's Yahoo form.
 *               Where it trades comes from its `.NS` / `.BO` suffix, else from
 *               `exchange`, else it is taken as a US ticker.
 *                 India (NSE/BSE): the id is DERIVED — `buildListingId`, the
 *                   one India spelling since MONEY-1522 (M&M:NSE:unknown).
 *                 US: the id carries the listing's START date, which only
 *                   silver `listing` knows, so it is resolved in SQL to the
 *                   listing that holds the ticker TODAY.
 *
 * `resolveSymbol` spells Mahindra as `M%26M` — URL-encoded for Yahoo — so the
 * symbol is DECODED before it is read (MONEY-1597 re-review): the ticker check
 * refused `M%26M`, and every M&M report would have carried a failed source.
 *
 * Exactly one of the two bound values is non-empty; `''` matches nothing.
 */
function target(raw: Record<string, unknown>): {
  listing_id: string;
  us_symbol: string;
} {
  if (typeof raw.listing_id === "string" && raw.listing_id.trim() !== "") {
    const id = raw.listing_id.trim();
    if (!LISTING_ID.test(id)) {
      throw new LakeRequestError(
        `listing_id must be SYMBOL:VENUE:LISTING_START (e.g. AAPL:NASDAQ:1980-12-12, RELIANCE:NSE:unknown); got ${JSON.stringify(id)}`,
      );
    }
    return { listing_id: id, us_symbol: "" };
  }
  if (typeof raw.symbol === "string" && raw.symbol.trim() !== "") {
    let s: string;
    try {
      s = decodeURIComponent(raw.symbol.trim()).toUpperCase();
    } catch {
      throw new LakeRequestError(
        `symbol is not a ticker: ${JSON.stringify(raw.symbol)}`,
      );
    }
    const suffixed = /^(.+)\.(NS|BO)$/.exec(s);
    const base = suffixed ? suffixed[1]! : s;
    const exchange = suffixed
      ? suffixed[2] === "NS"
        ? "NSE"
        : "BSE"
      : raw.exchange === undefined ||
          raw.exchange === null ||
          raw.exchange === ""
        ? "US"
        : oneOf(
            String(raw.exchange).trim().toUpperCase(),
            [...INDIA_EXCHANGES, ...US_VENUES],
            "exchange",
          );
    if (!TICKER.test(base)) {
      throw new LakeRequestError(
        `symbol is not a ticker: ${JSON.stringify(raw.symbol)}`,
      );
    }
    if ((INDIA_EXCHANGES as readonly string[]).includes(exchange)) {
      return {
        listing_id: buildListingId(base, exchange, null),
        us_symbol: "",
      };
    }
    return { listing_id: "", us_symbol: base };
  }
  throw new LakeRequestError(
    "name the listing: listing_id (SYMBOL:VENUE:LISTING_START), or symbol plus exchange (M&M + NSE, AAPL + NASDAQ)",
  );
}

function topN(value: unknown): number {
  if (value === undefined || value === null || value === "")
    return DEFAULT_TOP_N;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LAKE_QUERY_LIMITS.maxRows) {
    throw new LakeRequestError(
      `n must be an integer from 1 to ${LAKE_QUERY_LIMITS.maxRows}; got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Validate a raw tool call into a bound template.
 *
 * Arguments a template does not read are ignored — the executor and the LLM
 * planner both add context the tool has no use for — EXCEPT anything whose
 * name mentions SQL, which is refused: this tool never runs a caller's query,
 * and saying so beats dropping it.
 *
 * @param today `YYYY-MM-DD`, the default `as_of` and the anchor for `since`.
 */
export function parseLakeRequest(
  raw: Record<string, unknown>,
  today: string,
): LakeRequest {
  const sqlArg = Object.keys(raw).find((k) => /sql/i.test(k));
  if (sqlArg !== undefined) {
    throw new LakeRequestError(
      `refused the "${sqlArg}" argument — this tool NEVER runs free-form SQL. ` +
        `Pick a template (${LAKE_TEMPLATES.join(", ")}) and pass its parameters.`,
    );
  }
  const template = oneOf(raw.template, LAKE_TEMPLATES, "template");
  const since = (): string =>
    raw.since === undefined || raw.since === null || raw.since === ""
      ? shiftDays(today, -DEFAULT_SINCE_DAYS)
      : day(raw.since, "since");
  const asOf = (): string =>
    raw.as_of === undefined || raw.as_of === null || raw.as_of === ""
      ? today
      : day(raw.as_of, "as_of");

  switch (template) {
    case "events_for_listing": {
      const t = target(raw);
      return {
        template,
        params: {
          ...t,
          since: since(),
          row_limit: LAKE_QUERY_LIMITS.maxRows + 1,
        },
        types: {
          listing_id: "STRING",
          us_symbol: "STRING",
          since: "STRING",
          row_limit: "INT64",
        },
        rowCap: LAKE_QUERY_LIMITS.maxRows,
      };
    }
    case "event_outcomes_by_type":
      return {
        template,
        params: {
          event_type: oneOf(raw.event_type, EVENT_TYPES, "event_type"),
          market: oneOf(raw.market, EVENT_MARKETS, "market"),
          since: since(),
        },
        types: { event_type: "STRING", market: "STRING", since: "STRING" },
        // One aggregate row, always: no GROUP BY, so nothing to cut.
        rowCap: 1,
      };
    case "rolling_stats_for": {
      const t = target(raw);
      return {
        template,
        params: {
          ...t,
          as_of: asOf(),
          row_limit: LAKE_QUERY_LIMITS.maxRows + 1,
        },
        types: {
          listing_id: "STRING",
          us_symbol: "STRING",
          as_of: "STRING",
          row_limit: "INT64",
        },
        rowCap: LAKE_QUERY_LIMITS.maxRows,
      };
    }
    case "universe_top_by": {
      const metric = oneOf(
        raw.metric,
        Object.keys(UNIVERSE_METRICS) as UniverseMetric[],
        "metric",
      );
      const asOfDay = asOf();
      const n = topN(raw.n);
      return {
        template,
        params: {
          metric,
          market: oneOf(raw.market, EVENT_MARKETS, "market"),
          as_of: asOfDay,
          // A week back: a listing with no session since is not ranked on a
          // stale close. Derived here, not by INTERVAL in SQL, so the test
          // suite can execute the template (MONEY-1606).
          fresh_since: shiftDays(asOfDay, -UNIVERSE_FRESH_DAYS),
          min_sessions: UNIVERSE_METRICS[metric],
          row_limit: n + 1,
        },
        types: {
          metric: "STRING",
          market: "STRING",
          as_of: "STRING",
          fresh_since: "STRING",
          min_sessions: "INT64",
          row_limit: "INT64",
        },
        rowCap: n,
      };
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Cache key, SQL, job
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `(template, params)` → one Redis key, per environment.
 *
 * The FULL sha256 of the canonical (key-sorted) parameters, not the 8-hex
 * `generateVersionHash` the cache package offers: at 32 bits two different
 * questions sharing a key is a birthday problem, and the loser is served the
 * other's answer for 15 minutes with nothing to say so. The env is in the key
 * because QA and prod are different warehouses.
 */
export function lakeCacheKey(req: LakeRequest, env: string): string {
  const canonical = JSON.stringify(
    Object.keys(req.params)
      .sort()
      .map((k) => [k, req.params[k]]),
  );
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `lake:q:v1:${env}:${req.template}:${digest}`;
}

export interface LakeTarget {
  projectId: string;
  env: "qa" | "prod";
}

/** The one region for the whole data plane (lake-layout.md §2). */
export const LAKE_REGION = "asia-south1";

/** The template's text with its two datasets named. Nothing else is substituted. */
export function renderLakeSql(template: LakeTemplate, t: LakeTarget): string {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(t.projectId)) {
    throw new LakeRequestError(
      `not a GCP project id: ${JSON.stringify(t.projectId)}`,
    );
  }
  if (t.env !== "qa" && t.env !== "prod") {
    throw new LakeRequestError(
      `env must be qa or prod; got ${JSON.stringify(t.env)}`,
    );
  }
  return LAKE_SQL[template]
    .replaceAll("{{gold}}", `\`${t.projectId}.lake_gold_${t.env}\``)
    .replaceAll("{{silver}}", `\`${t.projectId}.lake_silver_${t.env}\``);
}

/**
 * Exactly what `BigQuery#createQueryJob` receives.
 *
 * NO `maxResults`, and that is the MONEY-1597 review's first finding. A
 * numeric `maxResults` makes the client's paginator turn `autoPaginate` OFF,
 * so `getQueryResults` makes ONE call — which BigQuery answers after ~10 s
 * with `jobComplete: false` and zero rows, and the client hands that back as
 * `[]` with no error. A 16-second query came back as an empty SUCCESS, was
 * cached for 15 minutes, and the report said "no events" as a fact. The SQL
 * `LIMIT @row_limit` bounds the rows instead; the runner also refuses any job
 * that is not DONE (`assertJobDone` in ../query-lake.ts).
 */
export interface LakeJob {
  query: {
    query: string;
    params: Record<string, string | number>;
    types: Record<string, LakeParamType>;
    location: string;
    useLegacySql: false;
    maximumBytesBilled: string;
    jobTimeoutMs: number;
    labels: Record<string, string>;
  };
}

export function buildLakeJob(req: LakeRequest, t: LakeTarget): LakeJob {
  return {
    query: {
      query: renderLakeSql(req.template, t),
      params: req.params,
      types: req.types,
      location: LAKE_REGION,
      useLegacySql: false,
      // A STRING: the API field is int64, which JSON carries as a string.
      maximumBytesBilled: String(LAKE_QUERY_LIMITS.maximumBytesBilled),
      jobTimeoutMs: LAKE_QUERY_LIMITS.jobTimeoutMs,
      labels: { tool: "query_lake", template: req.template },
    },
  };
}

/**
 * BigQuery row values → JSON-plain values, so a cached answer and a fresh one
 * are the same shape. `BigQueryDate` / `BigQueryTimestamp` are `{ value }`
 * wrappers; NUMERIC arrives as a `Big` whose `toJSON` is its exact decimal
 * string, which is kept as a string rather than rounded through a double.
 */
export function toPlain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlain);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "value") {
    return toPlain((v as { value: unknown }).value);
  }
  const withJson = v as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return withJson.toJSON();
  return Object.fromEntries(
    keys.map((k) => [k, toPlain((v as Record<string, unknown>)[k])]),
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The templates — byte-identical mirrors of sql/*.sql (see the header)
   ──────────────────────────────────────────────────────────────────────── */

export const LAKE_SQL: Readonly<Record<LakeTemplate, string>> = Object.freeze({
  events_for_listing: `-- events_for_listing(listing_id, since) — MONEY-1597 (C5b).
--
-- Every event on one listing observed on or after @since, newest first, with
-- the returns that followed it (gold.event_return_outcome) and what the event
-- said (the latest silver instrument_event row: title, tags, evidence_uri).
--
-- The listing is named EITHER by its full lake id in @listing_id, OR — for a
-- US ticker — by @us_symbol, resolved to its ACTIVE listing in silver.listing.
-- The unused one is bound to '' and matches nothing. A US ticker is not a
-- security (DOW is two companies), so the resolution is to the listing that
-- holds the ticker TODAY, and every row names the listing_id it came from.
--
-- NO EVENTS IS AN ANSWER ONLY IF THE LAKE KNOWS THE LISTING. Every row carries
-- listing_sessions: the listing's sessions in gold.rolling_stats since @since.
-- When there are no events the query still returns ONE row, with a NULL
-- event_id, so the tool can tell "no events" (sessions > 0) from "an id the
-- lake holds no bars for" (sessions = 0) — a misspelt or not-yet-loaded id
-- would otherwise come back as an empty success and be cached as a fact.
-- The count reads one listing over the window's month partitions.
--
-- @row_limit is the tool's cap + 1: the extra row is how it knows it cut.
-- Named parameters only. {{gold}} and {{silver}} are dataset names from the
-- tool's own configuration, never from a caller.
WITH target AS (
  SELECT @listing_id AS listing_id
  UNION DISTINCT
  SELECT listing_id
  FROM {{silver}}.listing
  WHERE market = 'US' AND status = 'ACTIVE' AND symbol = @us_symbol
),
coverage AS (
  SELECT COUNT(*) AS listing_sessions
  FROM {{gold}}.rolling_stats
  WHERE session_date >= PARSE_DATE('%Y-%m-%d', @since)
    AND listing_id IN (SELECT listing_id FROM target)
),
events AS (
  SELECT
    o.event_id,
    o.market,
    o.listing_id,
    o.event_type,
    e.title,
    e.tags,
    e.evidence_uri,
    e.source,
    o.observed_at,
    o.observed_date,
    o.window_status,
    o.base_session_date,
    o.session_date_1d,
    o.session_date_20d,
    o.ret_1d,
    o.ret_5d,
    o.ret_20d,
    o.abn_ret_1d,
    o.abn_ret_5d,
    o.abn_ret_20d,
    o.vol_20d_before,
    o.vol_20d_after,
    o.gap_open_pct,
    o.benchmark_id
  FROM {{gold}}.event_return_outcome AS o
  LEFT JOIN (
    SELECT event_id, title, tags, evidence_uri, source
    FROM {{silver}}.instrument_event
    -- One day of slack: a venue date of D is a UTC instant as early as D-1
    -- 18:30 (IST), and this prunes silver's DATE(observed_at) partitions.
    WHERE observed_at >= TIMESTAMP(DATE_SUB(PARSE_DATE('%Y-%m-%d', @since), INTERVAL 1 DAY))
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY event_id ORDER BY observed_at DESC, ingested_at DESC
    ) = 1
  ) AS e
    ON e.event_id = o.event_id
  WHERE o.observed_date >= PARSE_DATE('%Y-%m-%d', @since)
    AND o.listing_id IN (SELECT listing_id FROM target)
  ORDER BY o.observed_at DESC
  LIMIT @row_limit
)
SELECT c.listing_sessions, ev.*
FROM coverage AS c
LEFT JOIN events AS ev ON TRUE
ORDER BY ev.observed_at DESC
`,
  event_outcomes_by_type: `-- event_outcomes_by_type(event_type, market, since) — MONEY-1597 (C5b).
--
-- What happened, on average, after every event of one type in one market
-- since @since. One row.
--
-- The events that could NOT be measured are counted, by reason, beside the
-- ones that were — an average over 40 measured events out of 4,000 is a
-- different claim from one over 4,000, and nothing else in the row says so.
-- ret_* and abn_ret_* are FRACTIONS (0.02 = +2%); gap_open_pct is PERCENT.
-- Returns are NULL outside OPEN/COMPLETE, so every aggregate below reads only
-- measured windows; n_* says how many.
--
-- Named parameters only.
SELECT
  @event_type AS event_type,
  @market AS market,
  PARSE_DATE('%Y-%m-%d', @since) AS since,
  COUNT(*) AS events,
  COUNTIF(window_status = 'COMPLETE') AS events_window_complete,
  COUNTIF(window_status = 'OPEN') AS events_window_open,
  COUNTIF(window_status = 'NO_LISTING') AS events_without_listing,
  COUNTIF(window_status = 'NO_BARS') AS events_without_bars,
  COUNTIF(window_status = 'STALE_BARS') AS events_with_stale_bars,
  COUNT(ret_1d) AS n_1d,
  AVG(ret_1d) AS mean_ret_1d,
  AVG(abn_ret_1d) AS mean_abn_ret_1d,
  APPROX_QUANTILES(abn_ret_1d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_1d,
  SAFE_DIVIDE(COUNTIF(abn_ret_1d > 0), COUNT(abn_ret_1d)) AS share_abn_ret_1d_positive,
  COUNT(ret_5d) AS n_5d,
  AVG(ret_5d) AS mean_ret_5d,
  AVG(abn_ret_5d) AS mean_abn_ret_5d,
  APPROX_QUANTILES(abn_ret_5d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_5d,
  SAFE_DIVIDE(COUNTIF(abn_ret_5d > 0), COUNT(abn_ret_5d)) AS share_abn_ret_5d_positive,
  COUNT(ret_20d) AS n_20d,
  AVG(ret_20d) AS mean_ret_20d,
  AVG(abn_ret_20d) AS mean_abn_ret_20d,
  APPROX_QUANTILES(abn_ret_20d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_20d,
  SAFE_DIVIDE(COUNTIF(abn_ret_20d > 0), COUNT(abn_ret_20d)) AS share_abn_ret_20d_positive,
  AVG(gap_open_pct) AS mean_gap_open_pct,
  AVG(SAFE_DIVIDE(vol_20d_after, vol_20d_before)) AS mean_vol_ratio_after_to_before
FROM {{gold}}.event_return_outcome
WHERE event_type = @event_type
  AND market = @market
  AND observed_date >= PARSE_DATE('%Y-%m-%d', @since)
`,
  rolling_stats_for: `-- rolling_stats_for(listing_id, as_of) — MONEY-1597 (C5b).
--
-- One listing's rolling statistics on the last session ON OR BEFORE @as_of:
-- SMAs, 52-week range, 20-session average volume, 30-session realised
-- volatility — gold.rolling_stats, all on the ADJUSTED series.
--
-- The listing is named as in events_for_listing (@listing_id, or @us_symbol
-- for a US ticker's ACTIVE listing). A listing with no session in the 14 days
-- before @as_of returns NO row rather than a stale one dressed as current, and
-- the tool REFUSES that empty answer by name instead of reporting it as a
-- success: an id the lake holds no bars for must never read as "no stats".
-- Prices are in the listing's own currency, which is stated per row.
--
-- Named parameters only.
SELECT
  r.market,
  r.listing_id,
  r.symbol,
  r.exchange,
  r.session_date,
  CASE r.market WHEN 'US' THEN 'USD' WHEN 'IN' THEN 'INR' END AS currency,
  r.adj_close,
  r.sma_20,
  r.sma_50,
  r.sma_200,
  r.high_52w,
  r.low_52w,
  r.avg_volume_20,
  r.realised_vol_30d,
  r.sessions_in_window,
  r.adjustment_policy_version
FROM {{gold}}.rolling_stats AS r
WHERE r.session_date <= PARSE_DATE('%Y-%m-%d', @as_of)
  AND r.session_date >= DATE_SUB(PARSE_DATE('%Y-%m-%d', @as_of), INTERVAL 14 DAY)
  AND (
    r.listing_id = @listing_id
    OR r.listing_id IN (
      SELECT listing_id
      FROM {{silver}}.listing
      WHERE market = 'US' AND status = 'ACTIVE' AND symbol = @us_symbol
    )
  )
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY r.market, r.listing_id ORDER BY r.session_date DESC
) = 1
LIMIT @row_limit
`,
  universe_top_by: `-- universe_top_by(metric, market, as_of, n) — MONEY-1597 (C5b), MONEY-1606.
--
-- The n securities in one market with the highest @metric on their last
-- session in the week before @as_of. @row_limit is n + 1: the extra row is how
-- the tool knows the list was cut. The cross-sectional question — "which
-- names are most extended above their 200-day", "which are most volatile" —
-- that no per-symbol tool can answer.
--
-- @metric IS A BOUND STRING, NEVER A COLUMN NAME. It selects a branch of the
-- CASE below; an unknown value selects none, and the tool refuses it against
-- UNIVERSE_METRICS before a query is ever built. Nothing a caller sends is
-- interpolated into this text.
--
-- @min_sessions comes from the same allow-list: a 200-day SMA over twelve
-- sessions is a number (rolling_stats.sqlx says so), and a recent IPO would
-- otherwise top every "above its 200-day" list. @fresh_since is @as_of less a
-- week, computed by the tool: a listing with no session since then is not
-- ranked on a stale close.
--
-- ONE ROW PER SECURITY, NOT PER LISTING — MONEY-1606. One security listed on
-- NSE and BSE is two listings with near-identical numbers, and ranking both
-- hands the top of every Indian list to the same names twice. Listings are
-- grouped by their FULL ISIN, NSE kept, BSE only where NSE has no value (no
-- metric, a stale close, too short a window). NOT by ticker: FOCUS is Focus
-- Lighting on NSE and Focus Business Solution on BSE, two companies.
--
-- AND NOT BY THE MONEY-1543 ISSUER CODE (chars 3-7), which this first shipped
-- with. That code is the right key for attributing a corporate action across a
-- split's re-issued serial, and the wrong one for ranking, because an issuer
-- has many SECURITIES. Measured on prod over the latest week of India bars
-- (9,465 listings): grouped by issuer, 162 groups merged 1,406 distinct
-- securities — every ETF of one AMC under its INF code, NCDs and bonds under
-- the equity's code, with a digit-leading bond symbol able to win the group.
-- "Equity-shaped ISINs only" (kind E, type 01) still merged one: GATECH
-- (INE224E01028) with GATECHDVR (INE224E01036), a DVR issued under an E..01
-- serial. The full ISIN merges NONE and still folds 2,738 NSE/BSE twins. A
-- listing with no usable ISIN (every US row) stays its own group.
--
-- An EMPTY ranking (no listing in the market with a fresh session — US today,
-- before MONEY-1513's bars) is refused by the tool by name, never cached as
-- "nothing qualifies".
--
-- Written without QUALIFY or INTERVAL so the test suite can EXECUTE it.
-- Named parameters only.
WITH latest AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, isin,
    adj_close, sma_50, sma_200, high_52w, low_52w,
    avg_volume_20, realised_vol_30d, sessions_in_window
  FROM (
    SELECT
      r.market, r.listing_id, r.symbol, r.exchange, r.session_date, r.isin,
      r.adj_close, r.sma_50, r.sma_200, r.high_52w, r.low_52w,
      r.avg_volume_20, r.realised_vol_30d, r.sessions_in_window,
      ROW_NUMBER() OVER (
        PARTITION BY r.listing_id ORDER BY r.session_date DESC
      ) AS listing_rank
    FROM {{gold}}.rolling_stats AS r
    WHERE r.market = @market
      AND r.session_date <= PARSE_DATE('%Y-%m-%d', @as_of)
      AND r.session_date >= PARSE_DATE('%Y-%m-%d', @fresh_since)
  ) AS ranked
  WHERE listing_rank = 1
),
scored AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, adj_close,
    sessions_in_window,
    CASE
      WHEN REGEXP_CONTAINS(isin, '^[A-Z]{2}[A-Z0-9]{9}[0-9]$') THEN isin
    END AS isin,
    CASE @metric
      WHEN 'realised_vol_30d' THEN realised_vol_30d
      WHEN 'avg_volume_20' THEN avg_volume_20
      WHEN 'pct_above_sma_50' THEN SAFE_DIVIDE(adj_close, sma_50) - 1
      WHEN 'pct_above_sma_200' THEN SAFE_DIVIDE(adj_close, sma_200) - 1
      WHEN 'pct_below_52w_high' THEN 1 - SAFE_DIVIDE(adj_close, high_52w)
      WHEN 'pct_above_52w_low' THEN SAFE_DIVIDE(adj_close, low_52w) - 1
    END AS metric_value
  FROM latest
  WHERE sessions_in_window >= @min_sessions
),
one_per_issuer AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, adj_close,
    sessions_in_window, isin, metric_value,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(isin, listing_id)
      ORDER BY CASE exchange WHEN 'NSE' THEN 0 ELSE 1 END, listing_id
    ) AS issuer_rank
  FROM scored
  WHERE metric_value IS NOT NULL
)
SELECT
  @metric AS metric,
  metric_value,
  market,
  listing_id,
  symbol,
  exchange,
  isin,
  session_date,
  CASE market WHEN 'US' THEN 'USD' WHEN 'IN' THEN 'INR' END AS currency,
  adj_close,
  sessions_in_window
FROM one_per_issuer
WHERE issuer_rank = 1
ORDER BY metric_value DESC, listing_id
LIMIT @row_limit
`,
});
