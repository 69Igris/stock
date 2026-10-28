/**
 * `query_lake` — allow-listed, parameterised reads of the lake's gold layer.
 * MONEY-1597 (data-platform C5b).
 *
 * The research agent's one door into BigQuery, for the facts no per-symbol API
 * can give it: what happened after events like this one, and where a listing
 * stands against its whole market. Four templates, named parameters, no
 * free-form SQL — every decision that can be made without BigQuery is made in
 * `./lake/templates.ts`, which is pure and fully tested.
 *
 * ## A WORKER TOOL, NEVER THE WEB REQUEST PATH — lake-layout.md §8
 *
 * `stockbook-api@`, the account the web and API run as, holds nothing on
 * BigQuery, and apps/web imports this package's barrel. So the tool REFUSES on
 * Vercel by name, and its BigQuery client and Redis cache are loaded lazily
 * inside `execute`, never at import — registering it costs the web bundle
 * nothing it can run.
 *
 * ## AS `lake-reader-{env}@`, BY IMPERSONATION
 *
 * The workers run as `stockbook-api@` too. Rather than widen that account, the
 * tool mints a short-lived token for `lake-reader-{env}@` — dataViewer on
 * silver and gold of ONE environment, nothing on bronze or private, no write
 * (lake-layout.md §10). The runtime account needs
 * `roles/iam.serviceAccountTokenCreator` on that one reader and nothing else;
 * until it has it, every call fails loudly with a permission error rather than
 * reading as an empty lake.
 *
 * THE AUTH LIBRARY IS RESOLVED THROUGH BIGQUERY'S OWN DEPENDENCY CHAIN, and
 * that is not fussiness. The workers image carries TWO google-auth-library
 * majors: v10 under workers/node_modules and v9 at the root, which is the one
 * `@google-cloud/bigquery` -> `@google-cloud/common` is built against. A bare
 * `import("google-auth-library")` from the workers bundle resolves v10; v10's
 * `getRequestHeaders()` returns a `Headers` object that v9's `authorizeRequest`
 * `Object.assign`s into nothing — a request with no Authorization header, a
 * 401 that reads like a missing grant. `createRequire` anchored at BigQuery's
 * resolved path loads the one it will actually talk to.
 *
 * ## CACHED FOR 15 MINUTES, BY (template, params)
 *
 * Through the repo's canonical cache client (`@usemoney/core/cache`, memory +
 * Redis). Only SUCCESSFUL answers are cached; a refusal, a byte-cap failure or
 * a permission error is never stored, so a transient fault cannot be served
 * back for the rest of the window as though it were the data.
 */
import type { BigQuery, BigQueryOptions } from "@google-cloud/bigquery";

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  LAKE_QUERY_LIMITS,
  LAKE_TEMPLATES,
  LakeRequestError,
  UNIVERSE_METRICS,
  buildLakeJob,
  lakeCacheKey,
  parseLakeRequest,
  toPlain,
  type LakeJob,
  type LakeRequest,
  type LakeTarget,
  type LakeTemplate,
} from "./lake/templates";

type Row = Record<string, unknown>;

/** What is cached, and what `data` carries. */
export interface LakeAnswer {
  template: LakeTemplate;
  params: Record<string, string | number>;
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  asOf: string;
}

/** The effects, injectable so the tests can see every one. */
export interface QueryLakeDeps {
  /** Which warehouse, and refusal off the worker path. Throws a `LakeRequestError`. */
  target(): LakeTarget;
  run(job: LakeJob, target: LakeTarget): Promise<Row[]>;
  cacheGet(key: string): Promise<LakeAnswer | null>;
  cacheSet(key: string, value: LakeAnswer): Promise<void>;
  /** `YYYY-MM-DD` (UTC). */
  today(): string;
}

/**
 * `LAKE_ENV` and the project, read PER CALL — a module-scope read freezes at
 * import on a warm container (CLAUDE.md, `XBRL_PROJECTION_APPLY`). Refused
 * rather than defaulted, as `packages/lake/src/gold.ts` refuses: a silent
 * fallback to QA makes a production answer come from the wrong warehouse.
 */
export function lakeTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LakeTarget {
  if (env.VERCEL) {
    throw new LakeRequestError(
      "refused on the web request path (lake-layout.md §8) — it runs only in the research worker",
    );
  }
  const projectId = env.LAKE_PROJECT ?? env.GCP_PROJECT_ID ?? "";
  const lakeEnv = env.LAKE_ENV ?? "";
  if (!projectId) {
    throw new LakeRequestError(
      "LAKE_PROJECT (or GCP_PROJECT_ID) is not set on this worker",
    );
  }
  if (lakeEnv !== "qa" && lakeEnv !== "prod") {
    throw new LakeRequestError(
      `LAKE_ENV must be "qa" or "prod" on this worker (got ${JSON.stringify(lakeEnv)})`,
    );
  }
  return { projectId, env: lakeEnv };
}

/**
 * Whether this process can run the tool at all — the same test the tool's own
 * refusal applies, so the two cannot disagree. Read per call.
 *
 * The research skills PLAN a query_lake task only when this holds (MONEY-1597
 * review): until LAKE_ENV and the reader grant exist (MONEY-1605), a planned
 * task would fail in every run and put an "unavailable source" line in every
 * report. The refusal inside the tool stays — this only stops asking.
 */
export function isLakeQueryConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    lakeTargetFromEnv(env);
    return true;
  } catch {
    return false;
  }
}

/** `lake-reader-{env}@` — setup-lake.sh's SA_READER_BASE, env-suffixed. */
export function lakeReaderAccount(t: LakeTarget): string {
  return `lake-reader-${t.env}@${t.projectId}.iam.gserviceaccount.com`;
}

let reader: { key: string; bq: BigQuery } | null = null;

async function readerClient(t: LakeTarget): Promise<BigQuery> {
  const key = `${t.projectId}:${t.env}`;
  if (reader?.key === key) return reader.bq;

  const { createRequire } = await import("node:module");
  const here = createRequire(import.meta.url);
  const bqPath = here.resolve("@google-cloud/bigquery");
  const { BigQuery: BigQueryCtor } = here(
    bqPath,
  ) as typeof import("@google-cloud/bigquery");
  // See the header: the auth library BigQuery's own `common` resolves.
  const commonPath = createRequire(bqPath).resolve("@google-cloud/common");
  const auth = createRequire(commonPath)("google-auth-library") as {
    GoogleAuth: new (o: { scopes: string[] }) => {
      getClient(): Promise<unknown>;
    };
    Impersonated: new (o: {
      sourceClient: unknown;
      targetPrincipal: string;
      targetScopes: string[];
      delegates: string[];
      lifetime: number;
    }) => unknown;
  };

  const sourceClient = await new auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const authClient = new auth.Impersonated({
    sourceClient,
    targetPrincipal: lakeReaderAccount(t),
    targetScopes: ["https://www.googleapis.com/auth/bigquery"],
    delegates: [],
    lifetime: 3600,
  });
  const bq = new BigQueryCtor({
    projectId: t.projectId,
    location: "asia-south1",
    // Typed structurally above so this package takes no second dependency on
    // an auth library it must NOT resolve by itself; this is that library's
    // own AuthClient at run time.
    authClient: authClient as BigQueryOptions["authClient"],
  });
  reader = { key, bq };
  return bq;
}

/** The slice of the BigQuery client the runner touches, so a test can fake it. */
export interface LakeQueryClient {
  createQueryJob(
    options: LakeJob["query"],
  ): Promise<[LakeQueryJob, ...unknown[]]>;
}
export interface LakeQueryJob {
  getQueryResults(): Promise<[Row[], ...unknown[]]>;
  getMetadata(): Promise<[JobMetadataLike, ...unknown[]]>;
}
interface JobMetadataLike {
  status?: { state?: string; errorResult?: { message?: string } | null };
}

/**
 * A job that is not DONE, or DONE with an error, is a FAILURE — never rows.
 *
 * The MONEY-1597 review found the client returning `[]` for a job still
 * running (see LakeJob in lake/templates.ts): an empty answer is a claim that
 * nothing exists, and a slow query must not be able to make it. The state is
 * read from the job itself, after the results, so no early return on any
 * path the client grows can slip an incomplete job through.
 */
export function assertJobDone(meta: JobMetadataLike | undefined): void {
  const status = meta?.status;
  if (status?.errorResult) {
    throw new Error(
      `BigQuery job failed: ${status.errorResult.message ?? "no message"}`,
    );
  }
  if (status?.state !== "DONE") {
    throw new Error(
      `the query did not complete (job state ${status?.state ?? "unknown"}) — timed out`,
    );
  }
}

/**
 * Run one job to completion. No `maxResults`: auto-pagination polls until the
 * job is DONE, and a job BigQuery cancels at `jobTimeoutMs` comes back as an
 * error ("Job timed out after 20 sec", measured) rather than as `[]`.
 */
export async function runLakeJob(
  bq: LakeQueryClient,
  job: LakeJob,
): Promise<Row[]> {
  const [queryJob] = await bq.createQueryJob(job.query);
  const [rows] = await queryJob.getQueryResults();
  const [meta] = await queryJob.getMetadata();
  assertJobDone(meta);
  return rows;
}

const CACHE_CONFIG = {
  ttl: LAKE_QUERY_LIMITS.cacheTtlSeconds,
  enableMemory: true,
  enableRedis: true,
} as const;

export const defaultQueryLakeDeps: QueryLakeDeps = {
  target: () => lakeTargetFromEnv(),
  run: async (job, t) =>
    runLakeJob((await readerClient(t)) as unknown as LakeQueryClient, job),
  cacheGet: async (key) => {
    const { cacheClient } = await import("@usemoney/core/cache");
    return cacheClient.get<LakeAnswer>(key, CACHE_CONFIG);
  },
  cacheSet: async (key, value) => {
    const { cacheClient } = await import("@usemoney/core/cache");
    await cacheClient.set(key, value, CACHE_CONFIG);
  },
  today: () => new Date().toISOString().slice(0, 10),
};

/**
 * What the numbers MEAN, per template — MONEY-1597 re-review. One note for all
 * four left `universe_top_by` unexplained: its `pct_*` metrics are FRACTIONS
 * (0.35 is +35%, easy to print as "0.35%") and `realised_vol_30d` is an
 * ANNUALISED fraction.
 */
const NOTES: Readonly<Record<LakeTemplate, string>> = Object.freeze({
  events_for_listing:
    "ret_* and abn_ret_* are FRACTIONS (0.02 = +2%); gap_open_pct is PERCENT. " +
    "abn_ret_* is the listing's return minus its market benchmark's over the same " +
    "sessions (SPY for US, NIFTY 50 for India). vol_20d_* is the DAILY stddev of " +
    "log returns, not annualised. Point-in-time: only sessions dated AFTER the " +
    "event's venue-local observed date count, so an event seen before the open " +
    "measures the drift after its first reaction day, not that day. " +
    "window_status NO_LISTING / NO_BARS / STALE_BARS rows carry no returns and " +
    "are counted, not dropped. Cite event_id for every event you describe.",
  event_outcomes_by_type:
    "mean_*/median_* returns are FRACTIONS (0.02 = +2%); share_*_positive is a " +
    "FRACTION of events (0.6 = 60%); mean_gap_open_pct is PERCENT. abn_ret is " +
    "measured against SPY (US) or NIFTY 50 (India). n_* counts only measured " +
    "windows; events_without_listing / events_without_bars / " +
    "events_with_stale_bars count the ones that could not be measured — state " +
    "them beside any average.",
  rolling_stats_for:
    "Prices (adj_close, sma_*, high_52w, low_52w) are ADJUSTED, in the row's " +
    "`currency`. realised_vol_30d is an ANNUALISED FRACTION (0.35 = 35% a year). " +
    "avg_volume_20 is split-adjusted SHARES. sessions_in_window says how many " +
    "sessions the widest window held: a 200-day SMA over fewer than 200 is not one.",
  universe_top_by:
    "metric_value units: pct_above_sma_50 / pct_above_sma_200 / " +
    "pct_below_52w_high / pct_above_52w_low are FRACTIONS (0.35 = 35%, never " +
    "'0.35%'); realised_vol_30d is an ANNUALISED FRACTION (0.35 = 35% a year); " +
    "avg_volume_20 is split-adjusted SHARES. One row per SECURITY (its full " +
    "ISIN; NSE preferred over BSE), ranked highest first.",
});

/**
 * The answer as the report writer receives it: the note and the counts FIRST,
 * the rows LAST. `truncateTaskResult` (prompts.ts) cuts every task's JSON at
 * 4,000 characters, so a note placed after the rows was cut off whenever a
 * listing had more than a handful of events — and it is the only thing that
 * says ret_* is a fraction while gap_open_pct is a percent.
 */
function present(a: LakeAnswer): Record<string, unknown> {
  return {
    template: a.template,
    note: NOTES[a.template],
    rowCount: a.rowCount,
    truncated: a.truncated,
    asOf: a.asOf,
    params: a.params,
    rows: a.rows,
  };
}

/**
 * An EMPTY answer that is not a fact is REFUSED by name, never returned as a
 * success (and so never cached) — the same principle as `assertJobDone`.
 * MONEY-1597 re-review: until the MONEY-1522 replay reaches gold, prod bars
 * still spell India ids `SYM:NSE`, so every derived `SYM:NSE:unknown` read
 * came back empty and "successful".
 *
 *   events_for_listing  the SQL returns a `listing_sessions` probe row even
 *                       when there are no events. No events and no sessions
 *                       since @since: the lake does not know this listing.
 *                       No events WITH sessions: a real "nothing happened".
 *                       Events are kept even without sessions — they are
 *                       facts, and their window_status says NO_BARS.
 *   rolling_stats_for   empty means no session in the 14 days before as_of.
 *   universe_top_by     empty means no listing in the market has a fresh one.
 */
function interpret(
  req: LakeRequest,
  rows: Row[],
): { rows: Row[] } | { refusal: string } {
  switch (req.template) {
    case "events_for_listing": {
      const sessions = Number(rows[0]?.listing_sessions ?? 0);
      const events = rows
        .filter((r) => r.event_id !== null && r.event_id !== undefined)
        .map(({ listing_sessions: _probe, ...event }) => event);
      if (events.length === 0 && sessions === 0) {
        return {
          refusal:
            `query_lake: the lake holds no bars for ${describeTarget(req)} since ${String(req.params.since)}, ` +
            'so "no events" cannot be told apart from an unknown or not-yet-loaded listing. ' +
            "Nothing was cached.",
        };
      }
      return { rows: events };
    }
    case "rolling_stats_for":
      return rows.length > 0
        ? { rows }
        : {
            refusal:
              `query_lake: ${describeTarget(req)} has no session in the 14 days before ${String(req.params.as_of)} ` +
              "in the lake — delisted, suspended, or its bars are not loaded. Nothing was cached.",
          };
    case "universe_top_by":
      return rows.length > 0
        ? { rows }
        : {
            refusal:
              `query_lake: no ${String(req.params.market)} listing has a session in the week before ${String(req.params.as_of)} ` +
              "with enough history for this metric — the lake holds no ranking to give. Nothing was cached.",
          };
    case "event_outcomes_by_type":
      return { rows };
  }
}

function describeTarget(req: LakeRequest): string {
  return req.params.listing_id
    ? String(req.params.listing_id)
    : `the US ticker ${String(req.params.us_symbol)}`;
}

/** Why a BigQuery call failed, in words a report can carry. */
function describeFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/bytes billed|maximumBytesBilled|billing tier/i.test(msg)) {
    return `query_lake: the template would scan more than the ${LAKE_QUERY_LIMITS.maximumBytesBilled / 1024 ** 3} GiB cap and was refused before it ran`;
  }
  if (/unable to impersonate|iam\.serviceAccounts\.getAccessToken/i.test(msg)) {
    // Measured from a laptop 2026-09-23: this is the exact failure until the
    // runtime account is granted roles/iam.serviceAccountTokenCreator on the
    // reader. Named, because "BigQuery refused" sends the reader to the SQL.
    return "query_lake: this worker may not act as the lake reader (roles/iam.serviceAccountTokenCreator is missing on lake-reader-{env}@)";
  }
  if (/timeout|timed out|exceeded.*time/i.test(msg)) {
    return `query_lake: the query did not finish within ${LAKE_QUERY_LIMITS.jobTimeoutMs / 1000}s`;
  }
  return `query_lake: BigQuery refused the query — ${msg.slice(0, 200)}`;
}

/** The whole call: validate, key, cache, run, cap. */
export async function runQueryLake(
  raw: Record<string, unknown>,
  deps: QueryLakeDeps = defaultQueryLakeDeps,
): Promise<ToolOutput> {
  let req: LakeRequest;
  let t: LakeTarget;
  try {
    req = parseLakeRequest(raw, deps.today());
    t = deps.target();
  } catch (err) {
    if (err instanceof LakeRequestError)
      return { success: false, error: err.message };
    throw err;
  }

  const key = lakeCacheKey(req, t.env);
  const hit = await deps.cacheGet(key).catch(() => null);
  if (hit) {
    return {
      success: true,
      data: present(hit),
      metadata: { source: "lake_gold", template: req.template, cached: true },
    };
  }

  let rows: Row[];
  try {
    rows = await deps.run(buildLakeJob(req, t), t);
  } catch (err) {
    return { success: false, error: describeFailure(err) };
  }

  const read = interpret(req, rows);
  if ("refusal" in read) return { success: false, error: read.refusal };
  rows = read.rows;

  // The SQL fetched rowCap + 1: the extra row is the evidence of a cut.
  const kept = rows.slice(0, req.rowCap).map((r) => toPlain(r) as Row);
  const answer: LakeAnswer = {
    template: req.template,
    params: req.params,
    rows: kept,
    rowCount: kept.length,
    truncated: rows.length > req.rowCap,
    asOf: deps.today(),
  };
  // Best-effort: a cache outage must not fail an answer we already have.
  await deps.cacheSet(key, answer).catch(() => undefined);
  return {
    success: true,
    data: present(answer),
    metadata: { source: "lake_gold", template: req.template, cached: false },
  };
}

/**
 * How to CALL the tool, for a planner that is otherwise shown tool NAMES only
 * (prompts.ts) — MONEY-1597 re-review. Without it a planner asked to use
 * query_lake invents its parameters, omits the required `template`, and every
 * such task fails validation. Each line is a complete, valid call; the test
 * suite parses every one through `parseLakeRequest`.
 */
export const QUERY_LAKE_PLANNER_USAGE = [
  "query_lake PARAMETERS — it runs one fixed template and NEVER takes SQL. Its params object is exactly one of:",
  '  {"template":"events_for_listing","symbol":"M&M","exchange":"NSE"}   (the returns after each past filing/news event; optional "since":"YYYY-MM-DD")',
  '  {"template":"event_outcomes_by_type","event_type":"FILING_8K","market":"US"}   (how the market moved after events of one type)',
  '  {"template":"rolling_stats_for","symbol":"TCS","exchange":"NSE"}   (SMAs, 52-week range, volatility; optional "as_of")',
  '  {"template":"universe_top_by","metric":"pct_above_sma_200","market":"IN","n":20}   (the top n securities by one metric)',
  "  Use the RAW ticker plus its exchange (NSE, BSE, NASDAQ, NYSE). event_type is one of the closed list in the tool description; metric one of " +
    Object.keys(UNIVERSE_METRICS).join(", ") +
    ".",
].join("\n");

export const queryLakeTool: ResearchToolDef = {
  name: "query_lake",
  description:
    "Cross-sectional facts from the market-data warehouse, via four fixed templates (never free-form SQL): " +
    "events_for_listing(listing_id|symbol+exchange, since) — every filing/news event on one listing with the 1/5/20-session returns and abnormal returns that FOLLOWED it, point-in-time, citing event_id; " +
    "event_outcomes_by_type(event_type, market, since) — how the whole market moved after events of one type (mean/median abnormal return, hit rate, counts of unmeasurable events); " +
    "rolling_stats_for(listing_id|symbol+exchange, as_of) — SMAs, 52-week range, average volume and realised volatility on one date; " +
    `universe_top_by(metric, market, as_of, n) — the n securities in a market (one row per full ISIN; NSE preferred over BSE) ranked by one of ${Object.keys(UNIVERSE_METRICS).join(", ")}.`,
  category: "data",
  parameters: {
    template: {
      type: "string",
      description: `One of: ${LAKE_TEMPLATES.join(", ")}`,
      required: true,
    },
    listing_id: {
      type: "string",
      description:
        "Lake listing id SYMBOL:VENUE:LISTING_START, e.g. AAPL:NASDAQ:1980-12-12 or RELIANCE:NSE:unknown. Or pass symbol instead.",
      required: false,
    },
    symbol: {
      type: "string",
      description:
        "Ticker, raw (M&M, BAJAJ-AUTO, AAPL) or with a .NS/.BO suffix. Where it trades comes from the suffix, else from `exchange`, else it is read as a US ticker.",
      required: false,
    },
    exchange: {
      type: "string",
      description:
        "NSE | BSE for India; NASDAQ | NYSE | AMEX | NYSE ARCA | BATS | US for a US ticker.",
      required: false,
    },
    since: {
      type: "string",
      description:
        "YYYY-MM-DD lower bound on the event's observed date (default: one year ago)",
      required: false,
    },
    as_of: {
      type: "string",
      description: "YYYY-MM-DD (default: today)",
      required: false,
    },
    event_type: {
      type: "string",
      description:
        "FILING_8K | FILING_10Q | FILING_10K | FILING_13F | FILING_OTHER | INSIDER_TXN | OWNERSHIP_13D_G | NEWS | CORP_ACTION | RESULT",
      required: false,
    },
    market: {
      type: "string",
      description: "US | IN",
      required: false,
    },
    metric: {
      type: "string",
      description: `universe_top_by only: ${Object.keys(UNIVERSE_METRICS).join(" | ")}`,
      required: false,
    },
    n: {
      type: "number",
      description: `universe_top_by only: how many companies, 1-${LAKE_QUERY_LIMITS.maxRows} (default 20)`,
      required: false,
      default: 20,
    },
  },
  cacheTTL: LAKE_QUERY_LIMITS.cacheTtlSeconds,
  execute: (params) => runQueryLake(params),
};
