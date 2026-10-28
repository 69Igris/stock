/**
 * `query_lake` — MONEY-1597 (data-platform C5b).
 *
 * The tool reads BigQuery, so every limit the brief sets is asserted where it
 * is DECIDED rather than provoked: the job object handed to the client
 * verbatim, the bound parameters, the cache key, the refusal. The effects run
 * through injected deps, so the cache and the runner are observed, not mocked
 * away.
 *
 * ## WHAT THE CLIENT SENDS — MONEY-1538
 *
 * A green parameter object once coexisted with prod DELETEs binding NULL: the
 * builder typed a date string `DATE`, and `@google-cloud/bigquery` drops a
 * string sent that way. So every template's parameters are serialised here
 * through the client's own `valueToQueryParameter_`.
 *
 * MUTATION-VERIFIED — see the MONEY-1597 hand-off for the list; each named edit
 * was applied, confirmed RED, and reverted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BigQuery } from "@google-cloud/bigquery";

import {
  LAKE_QUERY_LIMITS,
  LAKE_SQL,
  LAKE_TEMPLATES,
  LakeRequestError,
  UNIVERSE_METRICS,
  buildLakeJob,
  lakeCacheKey,
  parseLakeRequest,
  renderLakeSql,
  toPlain,
  type LakeJob,
  type LakeRequest,
  type LakeTarget,
  type LakeTemplate,
} from "../src/tools/lake/templates";
import {
  assertJobDone,
  isLakeQueryConfigured,
  lakeTargetFromEnv,
  queryLakeTool,
  runLakeJob,
  runQueryLake,
  type LakeAnswer,
  type LakeQueryClient,
  type QueryLakeDeps,
} from "../src/tools/query-lake";
import {
  buildPlannerUserPrompt,
  buildSynthesizerUserPrompt,
  getPlannerPrompt,
} from "../src/prompts";
import type { ResearchTask } from "../src/types";
import { ResearchToolRegistry } from "../src/tools/registry";
import {
  SKILL_TOOL_ALLOWLIST,
  unplannableTools,
} from "../src/skills/skill-tool-map";
import { newsSentimentCatalystsSkill } from "../src/skills/news-sentiment-catalysts";
// The MONEY-1543 issuer rule, the ONE definition. Relative, because core does
// not export this module and the point is to compare against the real function.
import { isinIssuer } from "../../core/src/market-data/price-adjust";

const TODAY = "2026-09-23";
const TARGET: LakeTarget = { projectId: "stock-book-483718", env: "prod" };
const SQL_DIR = join(import.meta.dirname, "..", "src", "tools", "lake", "sql");

/** One valid call per template — the fixtures every structural case walks. */
const VALID: Record<LakeTemplate, Record<string, unknown>> = {
  events_for_listing: {
    template: "events_for_listing",
    listing_id: "AAPL:NASDAQ:1980-12-12",
    since: "2025-09-01",
  },
  event_outcomes_by_type: {
    template: "event_outcomes_by_type",
    event_type: "FILING_8K",
    market: "US",
    since: "2025-09-01",
  },
  rolling_stats_for: {
    template: "rolling_stats_for",
    symbol: "RELIANCE.NS",
    as_of: "2026-09-18",
  },
  universe_top_by: {
    template: "universe_top_by",
    metric: "pct_above_sma_200",
    market: "IN",
    as_of: "2026-09-18",
    n: 25,
  },
};

function parse(raw: Record<string, unknown>): LakeRequest {
  return parseLakeRequest(raw, TODAY);
}

function refused(raw: Record<string, unknown>, pattern: RegExp): void {
  assert.throws(
    () => parse(raw),
    (e: unknown) => e instanceof LakeRequestError && pattern.test(e.message),
    `expected a refusal matching ${pattern} for ${JSON.stringify(raw)}`,
  );
}

/** Comment-free SQL, so prose naming a parameter cannot satisfy a scan. */
function code(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
}

/* ─────────────────────────────────────────────────────────────────────────
   The templates themselves
   ──────────────────────────────────────────────────────────────────────── */

describe("the four templates", () => {
  it("the shipped strings are byte-identical to sql/*.sql", () => {
    assert.deepEqual([...LAKE_TEMPLATES].sort(), Object.keys(LAKE_SQL).sort());
    for (const t of LAKE_TEMPLATES) {
      const file = readFileSync(join(SQL_DIR, `${t}.sql`), "utf8");
      assert.equal(
        LAKE_SQL[t],
        file,
        `${t}: templates.ts drifted from sql/${t}.sql — paste the file into LAKE_SQL`,
      );
    }
  });

  it("every @parameter in the SQL is bound, and every binding is used", () => {
    for (const t of LAKE_TEMPLATES) {
      const req = parse(VALID[t]);
      const used = new Set(
        [...code(LAKE_SQL[t]).matchAll(/@([a-z_]+)/g)].map((m) => m[1]!),
      );
      assert.deepEqual(
        [...used].sort(),
        Object.keys(req.params).sort(),
        `${t}: SQL parameters and bound parameters differ`,
      );
      assert.deepEqual(
        Object.keys(req.types).sort(),
        Object.keys(req.params).sort(),
        `${t}: a parameter has no declared type`,
      );
    }
  });

  it("the only substitutions are the two dataset names", () => {
    for (const t of LAKE_TEMPLATES) {
      const holes = [...LAKE_SQL[t].matchAll(/\{\{(\w+)\}\}/g)].map(
        (m) => m[1],
      );
      assert.ok(holes.length > 0, `${t} names no dataset`);
      for (const h of holes)
        assert.ok(h === "gold" || h === "silver", `${t}: {{${h}}}`);
      const sql = renderLakeSql(t, TARGET);
      assert.doesNotMatch(sql, /\{\{/);
      assert.match(sql, /`stock-book-483718\.lake_gold_prod`/);
    }
  });

  it("a caller's metric is BOUND, never interpolated — every metric renders the same text", () => {
    const rendered = new Set(
      Object.keys(UNIVERSE_METRICS).map(
        (metric) =>
          buildLakeJob(parse({ ...VALID.universe_top_by, metric }), TARGET)
            .query.query,
      ),
    );
    assert.equal(rendered.size, 1);
    // …and the CASE covers exactly the allow-list.
    const block = /CASE @metric([\s\S]*?)\bEND\b/.exec(
      code(LAKE_SQL.universe_top_by),
    );
    assert.ok(block, "universe_top_by has no CASE @metric");
    const branches = [...block[1]!.matchAll(/WHEN '([a-z0-9_]+)' THEN/g)].map(
      (m) => m[1]!,
    );
    assert.deepEqual(branches.sort(), Object.keys(UNIVERSE_METRICS).sort());
  });

  it("every row-returning template caps its rows in SQL", () => {
    assert.match(code(LAKE_SQL.events_for_listing), /\n  LIMIT @row_limit\n/);
    assert.match(code(LAKE_SQL.rolling_stats_for), /LIMIT @row_limit\s*$/);
    assert.match(code(LAKE_SQL.universe_top_by), /LIMIT @row_limit\s*$/);
    // One aggregate row, no GROUP BY — nothing to cap.
    assert.doesNotMatch(code(LAKE_SQL.event_outcomes_by_type), /GROUP BY/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Parameter validation
   ──────────────────────────────────────────────────────────────────────── */

describe("it NEVER accepts free-form SQL", () => {
  for (const key of ["sql", "SQL", "raw_sql", "sqlText"]) {
    it(`refuses a "${key}" argument, even beside a valid template`, () => {
      refused(
        { ...VALID.event_outcomes_by_type, [key]: "SELECT 1" },
        /NEVER runs free-form SQL/,
      );
    });
  }

  it("the tool refuses it before BigQuery or the cache is touched", async () => {
    const f = fakeDeps();
    const out = await runQueryLake(
      { template: "events_for_listing", sql: "SELECT * FROM lake_gold_prod.x" },
      f.deps,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /NEVER runs free-form SQL/);
    assert.equal(f.runs.length, 0);
    assert.equal(f.gets.length, 0);
  });

  it("SQL passed AS the template name is just an unknown template", () => {
    refused({ template: "SELECT * FROM x" }, /template must be one of/);
  });
});

describe("template parameter validation", () => {
  it("refuses bad values, by name", () => {
    refused({ template: "nope" }, /template must be one of/);
    refused(
      { ...VALID.events_for_listing, since: "yesterday" },
      /since must be YYYY-MM-DD/,
    );
    refused(
      { ...VALID.events_for_listing, since: "2026-02-31" },
      /not a calendar day/,
    );
    refused(
      { ...VALID.rolling_stats_for, as_of: "2026-13-01" },
      /not a calendar day/,
    );
    refused(
      { ...VALID.event_outcomes_by_type, market: "UK" },
      /market must be one of US, IN/,
    );
    refused(
      { ...VALID.event_outcomes_by_type, event_type: "EARNINGS" },
      /event_type must be one of/,
    );
    refused(
      { ...VALID.universe_top_by, metric: "market_cap" },
      /metric must be one of/,
    );
    refused(
      { ...VALID.universe_top_by, metric: "realised_vol_30d; DROP TABLE x" },
      /metric must be one of/,
    );
    for (const n of [0, 501, 1.5, "ten"]) {
      refused(
        { ...VALID.universe_top_by, n },
        /n must be an integer from 1 to 500/,
      );
    }
    refused({ template: "events_for_listing" }, /name the listing/);
    refused(
      { template: "rolling_stats_for", listing_id: "AAPL" },
      /SYMBOL:VENUE:LISTING_START/,
    );
    refused(
      { template: "rolling_stats_for", listing_id: "AAPL:NASDAQ" },
      /SYMBOL:VENUE:LISTING_START/,
    );
    refused({ template: "rolling_stats_for", symbol: "^NSEI" }, /not a ticker/);
  });

  it("defaults: since one year back, as_of today, n 20", () => {
    const e = parse({ template: "events_for_listing", symbol: "AAPL" });
    assert.equal(e.params.since, "2025-09-23");
    const r = parse({ template: "rolling_stats_for", symbol: "AAPL" });
    assert.equal(r.params.as_of, TODAY);
    const u = parse({
      template: "universe_top_by",
      metric: "avg_volume_20",
      market: "US",
    });
    // n is what the caller sees; the SQL fetches one more, to know it cut.
    assert.equal(u.rowCap, 20);
    assert.equal(u.params.row_limit, 21);
    assert.equal(u.params.fresh_since, "2026-09-16");
    assert.equal(e.rowCap, 500);
    assert.equal(e.params.row_limit, 501);
    assert.equal(u.params.min_sessions, UNIVERSE_METRICS.avg_volume_20);
  });

  it("M&M in every spelling the agent produces is ONE listing (MONEY-1597 re-review)", () => {
    // resolveSymbol("M&M", "NSE") is "M%26M" — URL-encoded for Yahoo — and the
    // agent may hand back "M%26M.NS". All of them are Mahindra on NSE.
    for (const symbol of ["M&M", "m&m", "M%26M", "M%26M.NS", "M&M.NS"]) {
      assert.equal(
        parse({ template: "rolling_stats_for", symbol, exchange: "NSE" }).params
          .listing_id,
        "M&M:NSE:unknown",
        symbol,
      );
    }
    assert.equal(
      parse({
        template: "rolling_stats_for",
        symbol: "BAJAJ-AUTO",
        exchange: "NSE",
      }).params.listing_id,
      "BAJAJ-AUTO:NSE:unknown",
    );
  });

  it("the exchange decides: NSE/BSE derive the id, a US venue resolves the ticker", () => {
    assert.deepEqual(
      pick(
        parse({
          template: "rolling_stats_for",
          symbol: "AAPL",
          exchange: "NASDAQ",
        }),
      ),
      { listing_id: "", us_symbol: "AAPL" },
    );
    assert.deepEqual(
      pick(
        parse({
          template: "rolling_stats_for",
          symbol: "BRK-B",
          exchange: "nyse",
        }),
      ),
      { listing_id: "", us_symbol: "BRK-B" },
    );
    // A suffix outranks the exchange argument: it is the symbol's own claim.
    assert.equal(
      parse({
        template: "rolling_stats_for",
        symbol: "TCS.BO",
        exchange: "NSE",
      }).params.listing_id,
      "TCS:BSE:unknown",
    );
    refused(
      { template: "rolling_stats_for", symbol: "VOD", exchange: "LSE" },
      /exchange must be one of/,
    );
    refused(
      { template: "rolling_stats_for", symbol: "BAD%ZZ", exchange: "NSE" },
      /not a ticker/,
    );
  });

  it("a symbol names its listing: .NS/.BO is derived, a bare ticker resolves in SQL", () => {
    assert.deepEqual(
      pick(parse({ template: "rolling_stats_for", symbol: "reliance.ns" })),
      { listing_id: "RELIANCE:NSE:unknown", us_symbol: "" },
    );
    assert.deepEqual(
      pick(parse({ template: "rolling_stats_for", symbol: "TCS.BO" })),
      { listing_id: "TCS:BSE:unknown", us_symbol: "" },
    );
    assert.deepEqual(
      pick(parse({ template: "events_for_listing", symbol: "aapl" })),
      { listing_id: "", us_symbol: "AAPL" },
    );
    // A full id wins over a symbol and is taken exactly.
    assert.deepEqual(
      pick(
        parse({
          template: "events_for_listing",
          listing_id: "DOW:NYSE:2019-03-20",
          symbol: "DOW",
        }),
      ),
      { listing_id: "DOW:NYSE:2019-03-20", us_symbol: "" },
    );
  });

  it("the metric's minimum history comes from the allow-list, not the caller", () => {
    const u = parse({ ...VALID.universe_top_by, min_sessions: 1 });
    assert.equal(u.params.min_sessions, UNIVERSE_METRICS.pct_above_sma_200);
  });
});

function pick(req: LakeRequest): { listing_id: unknown; us_symbol: unknown } {
  return { listing_id: req.params.listing_id, us_symbol: req.params.us_symbol };
}

/* ─────────────────────────────────────────────────────────────────────────
   What BigQuery receives
   ──────────────────────────────────────────────────────────────────────── */

describe("every template's parameters reach BigQuery with a VALUE (MONEY-1538)", () => {
  for (const t of LAKE_TEMPLATES) {
    it(`${t}: nothing is serialised empty, and no date is typed DATE`, () => {
      const req = parse(VALID[t]);
      assert.doesNotMatch(JSON.stringify(req.types), /DATE|TIMESTAMP/);
      for (const [name, value] of Object.entries(req.params)) {
        const sent = BigQuery.valueToQueryParameter_(value, req.types[name]);
        const v = sent.parameterValue?.value;
        assert.ok(
          v !== undefined && v !== null,
          `${t}: @${name} (${req.types[name]}) reaches BigQuery as NULL — ${JSON.stringify(sent)}`,
        );
        assert.equal(String(v), String(value));
      }
    });
  }

  it("the trap is real: the same date typed DATE is dropped", () => {
    // Proves the check above can fail — the client drops a string it is told
    // is a DATE, which is how MONEY-1538 bound NULL.
    const sent = BigQuery.valueToQueryParameter_("2025-09-01", "DATE");
    assert.equal(sent.parameterValue?.value, undefined);
  });
});

describe("the job: 2 GiB byte cap, 20 s timeout, rows bounded by the SQL", () => {
  it("is what BigQuery#createQueryJob is handed, verbatim — and has NO maxResults", () => {
    const job = buildLakeJob(parse(VALID.events_for_listing), TARGET);
    assert.equal(job.query.maximumBytesBilled, String(2 * 1024 ** 3));
    assert.equal(job.query.maximumBytesBilled, "2147483648");
    assert.equal(job.query.jobTimeoutMs, 20_000);
    // A numeric maxResults turns the client's auto-pagination OFF and a slow
    // query comes back as [] with no error (MONEY-1597 review). Anywhere.
    assert.doesNotMatch(JSON.stringify(job), /maxResults/i);
    assert.equal(job.query.location, "asia-south1");
    assert.equal(job.query.useLegacySql, false);
    assert.equal(LAKE_QUERY_LIMITS.cacheTtlSeconds, 900);
  });

  it("refuses a malformed project or env rather than rendering it", () => {
    assert.throws(() =>
      renderLakeSql("rolling_stats_for", {
        projectId: "x`; DROP",
        env: "prod",
      }),
    );
    assert.throws(() =>
      renderLakeSql("rolling_stats_for", {
        projectId: "stock-book-483718",
        env: "dev" as "qa",
      }),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The cache key
   ──────────────────────────────────────────────────────────────────────── */

describe("the cache key is (env, template, params)", () => {
  const base = parse(VALID.universe_top_by);

  it("is stable, and ignores the order parameters were written in", () => {
    const reordered: LakeRequest = {
      ...base,
      params: Object.fromEntries(Object.entries(base.params).reverse()),
    };
    assert.equal(lakeCacheKey(base, "prod"), lakeCacheKey(reordered, "prod"));
    assert.match(
      lakeCacheKey(base, "prod"),
      /^lake:q:v1:prod:universe_top_by:[0-9a-f]{64}$/,
    );
  });

  it("differs for every input that changes the answer", () => {
    const keys = new Set([
      lakeCacheKey(base, "prod"),
      lakeCacheKey(base, "qa"),
      lakeCacheKey(parse({ ...VALID.universe_top_by, n: 26 }), "prod"),
      lakeCacheKey(parse({ ...VALID.universe_top_by, market: "US" }), "prod"),
      lakeCacheKey(
        parse({ ...VALID.universe_top_by, as_of: "2026-09-17" }),
        "prod",
      ),
      lakeCacheKey(
        parse({ ...VALID.universe_top_by, metric: "realised_vol_30d" }),
        "prod",
      ),
      lakeCacheKey({ ...base, template: "rolling_stats_for" }, "prod"),
    ]);
    assert.equal(keys.size, 7);
  });

  it("a defaulted parameter and the same value spelled out share a key", () => {
    const implicit = parse({ template: "events_for_listing", symbol: "AAPL" });
    const explicit = parse({
      template: "events_for_listing",
      symbol: "AAPL",
      since: "2025-09-23",
    });
    assert.equal(
      lakeCacheKey(implicit, "prod"),
      lakeCacheKey(explicit, "prod"),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The tool, end to end over fake effects
   ──────────────────────────────────────────────────────────────────────── */

function fakeDeps(rows: Record<string, unknown>[] = [{ event_id: "e1" }]): {
  deps: QueryLakeDeps;
  runs: LakeJob[];
  gets: string[];
  sets: Map<string, LakeAnswer>;
  fail: { next: Error | null };
} {
  const runs: LakeJob[] = [];
  const gets: string[] = [];
  const sets = new Map<string, LakeAnswer>();
  const fail = { next: null as Error | null };
  return {
    runs,
    gets,
    sets,
    fail,
    deps: {
      target: () => TARGET,
      run: async (job) => {
        runs.push(job);
        if (fail.next) throw fail.next;
        return rows;
      },
      cacheGet: async (key) => {
        gets.push(key);
        return sets.get(key) ?? null;
      },
      cacheSet: async (key, value) => {
        sets.set(key, value);
      },
      today: () => TODAY,
    },
  };
}

describe("runQueryLake", () => {
  it("runs once, caches under the key, and serves the second call from cache", async () => {
    const f = fakeDeps();
    const first = await runQueryLake(VALID.event_outcomes_by_type, f.deps);
    assert.equal(first.success, true);
    assert.equal(f.runs.length, 1);
    const key = lakeCacheKey(parse(VALID.event_outcomes_by_type), "prod");
    assert.ok(
      f.sets.has(key),
      "the answer was not cached under (template, params)",
    );
    const second = await runQueryLake(VALID.event_outcomes_by_type, f.deps);
    assert.equal(f.runs.length, 1, "a cache hit still ran the query");
    assert.equal((second.metadata as { cached: boolean }).cached, true);
  });

  it("never caches a failure", async () => {
    const f = fakeDeps();
    f.fail.next = new Error(
      "Query exceeded limit for bytes billed: 2147483648.",
    );
    const out = await runQueryLake(VALID.rolling_stats_for, f.deps);
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /2 GiB cap/);
    assert.equal(f.sets.size, 0);
    f.fail.next = null;
    const retry = await runQueryLake(VALID.rolling_stats_for, f.deps);
    assert.equal(retry.success, true);
    assert.equal(f.runs.length, 2);
  });

  it("names a missing impersonation grant instead of blaming the SQL", async () => {
    const f = fakeDeps();
    // Verbatim from a real call, 2026-09-23, before the grant existed.
    f.fail.next = new Error(
      "Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).",
    );
    const out = await runQueryLake(VALID.event_outcomes_by_type, f.deps);
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /serviceAccountTokenCreator/);
    assert.equal(f.sets.size, 0);
  });

  it("truncated is read off the one extra row the SQL is bound to fetch", async () => {
    // An executor that does what BigQuery does with the bound LIMIT: returns
    // min(population, @row_limit). C:NYSE:1977-01-03 had 883 one-year events
    // on prod (2026-09-23), NVDA 604 — more than the cap.
    const events = (population: number): QueryLakeDeps => {
      const f = fakeDeps();
      return {
        ...f.deps,
        run: async (job) =>
          Array.from(
            {
              length: Math.min(population, Number(job.query.params.row_limit)),
            },
            (_, i) => ({ event_id: `e${i}` }),
          ),
      };
    };
    const cut = (await runQueryLake(VALID.events_for_listing, events(883)))
      .data as LakeAnswer;
    assert.equal(cut.rowCount, 500);
    assert.equal(cut.rows.length, 500);
    assert.equal(cut.truncated, true);
    // Exactly at the cap is NOT a cut: nothing was left behind.
    const whole = (await runQueryLake(VALID.events_for_listing, events(500)))
      .data as LakeAnswer;
    assert.equal(whole.rowCount, 500);
    assert.equal(whole.truncated, false);
  });

  it("an INCOMPLETE job is a failure — never an empty success, never cached", async () => {
    // The client returning [] for a job still running is exactly what the
    // review measured with maxResults set: a 16 s query answered [] and "ok".
    const created: unknown[] = [];
    const client = (state: string, error?: string): LakeQueryClient => ({
      createQueryJob: async (options) => {
        created.push(options);
        return [
          {
            getQueryResults: async () => [[]],
            getMetadata: async () => [
              {
                status: {
                  state,
                  errorResult: error ? { message: error } : null,
                },
              },
            ],
          },
        ];
      },
    });
    for (const [state, error] of [
      ["RUNNING", undefined],
      ["PENDING", undefined],
      ["DONE", "Job timed out after 20 sec"],
    ] as const) {
      const f = fakeDeps();
      const out = await runQueryLake(VALID.events_for_listing, {
        ...f.deps,
        run: (job) => runLakeJob(client(state, error), job),
      });
      assert.equal(out.success, false, `${state}: reported success`);
      assert.match(out.error ?? "", /did not finish within 20s/);
      assert.equal(f.sets.size, 0, `${state}: a failure was cached`);
    }
    assert.ok(created.length === 3);
    for (const o of created) {
      assert.doesNotMatch(JSON.stringify(o), /maxResults/i);
    }
  });

  it("a DONE job's rows are returned, including an honest zero", async () => {
    const done: LakeQueryClient = {
      createQueryJob: async () => [
        {
          getQueryResults: async () => [[]],
          getMetadata: async () => [{ status: { state: "DONE" } }],
        },
      ],
    };
    const rows = await runLakeJob(
      done,
      buildLakeJob(parse(VALID.events_for_listing), TARGET),
    );
    assert.deepEqual(rows, []);
    assert.throws(() => assertJobDone(undefined), /did not complete/);
  });

  it("a refusal from the environment is a clean failure, not a throw", async () => {
    const f = fakeDeps();
    const out = await runQueryLake(VALID.rolling_stats_for, {
      ...f.deps,
      target: () =>
        lakeTargetFromEnv({
          VERCEL: "1",
          LAKE_ENV: "prod",
          GCP_PROJECT_ID: "p",
        }),
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /web request path/);
    assert.equal(f.runs.length, 0);
  });
});

describe("lakeTargetFromEnv — never the web path, never a default warehouse", () => {
  it("refuses on Vercel even when fully configured", () => {
    assert.throws(
      () =>
        lakeTargetFromEnv({
          VERCEL: "1",
          LAKE_ENV: "prod",
          GCP_PROJECT_ID: "stock-book-483718",
        }),
      /web request path/,
    );
  });
  it("refuses a missing or unknown LAKE_ENV instead of assuming QA", () => {
    assert.throws(
      () => lakeTargetFromEnv({ GCP_PROJECT_ID: "stock-book-483718" }),
      /LAKE_ENV/,
    );
    assert.throws(
      () =>
        lakeTargetFromEnv({
          GCP_PROJECT_ID: "stock-book-483718",
          LAKE_ENV: "production",
        }),
      /LAKE_ENV/,
    );
  });
  it("reads the worker's configuration when it is complete", () => {
    assert.deepEqual(
      lakeTargetFromEnv({
        GCP_PROJECT_ID: "stock-book-483718",
        LAKE_ENV: "qa",
      }),
      { projectId: "stock-book-483718", env: "qa" },
    );
  });
});

describe("toPlain", () => {
  it("unwraps BigQuery's date wrappers and keeps NUMERIC exact", () => {
    const big = { toJSON: () => "1334.800000001", c: [1], e: 3, s: 1 };
    assert.deepEqual(
      toPlain({
        d: { value: "2026-03-09" },
        n: big,
        tags: ["item:2.02"],
        x: null,
      }),
      { d: "2026-03-09", n: "1334.800000001", tags: ["item:2.02"], x: null },
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Registration and skills
   ──────────────────────────────────────────────────────────────────────── */

describe("registered, described, and wired", () => {
  it("is in the registry, and its description names every template", () => {
    const registry = new ResearchToolRegistry();
    assert.equal(registry.get("query_lake"), queryLakeTool);
    for (const t of LAKE_TEMPLATES) {
      assert.ok(
        queryLakeTool.description.includes(t),
        `description omits ${t}`,
      );
    }
    assert.match(queryLakeTool.description, /never free-form SQL/);
  });

  it("the cross-sectional skills allow-list it", () => {
    for (const skill of [
      "news-sentiment-catalysts",
      "catalyst-calendar",
      "theme-evaluation",
    ] as const) {
      assert.ok(SKILL_TOOL_ALLOWLIST[skill].includes("query_lake"), skill);
    }
  });

  it("news-sentiment-catalysts asks how the price moved after the listing's past events", () => {
    const plan = withEnv(CONFIGURED, () =>
      newsSentimentCatalystsSkill.buildPlan({ symbol: "TCS" }),
    );
    const task = plan.tasks.find((t) => t.tool === "query_lake");
    assert.ok(task, "no query_lake task in the plan");
    assert.equal(task.params.template, "events_for_listing");
    // The RAW symbol and its exchange — not resolveSymbol's Yahoo form.
    assert.equal(task.params.symbol, "TCS");
    assert.equal(task.params.exchange, "NSE");
    // The params it plans must be ones the tool accepts.
    assert.equal(parse(task.params).params.listing_id, "TCS:NSE:unknown");
    // M&M, which resolveSymbol spells M%26M, and a US ticker with its venue.
    const lakeCall = (params: Record<string, unknown>): LakeRequest =>
      parse(
        withEnv(CONFIGURED, () =>
          newsSentimentCatalystsSkill.buildPlan(params),
        ).tasks.find((t) => t.tool === "query_lake")!.params,
      );
    assert.equal(
      lakeCall({ symbol: "M&M" }).params.listing_id,
      "M&M:NSE:unknown",
    );
    assert.equal(
      lakeCall({ symbol: "BAJAJ-AUTO", exchange: "BSE" }).params.listing_id,
      "BAJAJ-AUTO:BSE:unknown",
    );
    assert.deepEqual(pick(lakeCall({ symbol: "AAPL", exchange: "NASDAQ" })), {
      listing_id: "",
      us_symbol: "AAPL",
    });
    const report = plan.tasks[plan.tasks.length - 1]!;
    assert.ok(
      report.dependsOn.includes(task.id),
      "the report does not wait for it",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Planned only where it can run — MONEY-1597 review (item 5)
   ──────────────────────────────────────────────────────────────────────── */

/** A worker with LAKE_ENV set: the tool can run. */
const CONFIGURED = { LAKE_ENV: "prod", GCP_PROJECT_ID: "stock-book-483718" };
/** The deployment as it is today (MONEY-1605 pending): no LAKE_ENV. */
const UNCONFIGURED = {
  LAKE_ENV: undefined,
  LAKE_PROJECT: undefined,
  GCP_PROJECT_ID: undefined,
  VERCEL: undefined,
};

/** Run `fn` with these env vars set (undefined deletes), then restore them. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  const put = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const restore = (): void => {
    for (const [k, v] of Object.entries(saved)) put(k, v);
  };
  for (const [k, v] of Object.entries(vars)) put(k, v);
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // An async body keeps the env until it SETTLES, not until its first await.
  if (out instanceof Promise) {
    return out.finally(restore) as T;
  }
  restore();
  return out;
}

function minTasks(skills: readonly string[]): number {
  const m = /MINIMUM TASK COUNT: (\d+)/.exec(
    buildPlannerUserPrompt("q", undefined, skills),
  );
  assert.ok(m, "no MINIMUM TASK COUNT in the planner prompt");
  return Number(m[1]);
}

/** The four MONEY-490 skills apps/web pins at 16, and dcf pinned at 8. */
const PINNED_QUANT = [
  "quant-factor-scores",
  "regime-volatility",
  "risk-portfolio-impact",
  "risk-var-stress",
];

describe("query_lake is planned only where it can run", () => {
  it("UNCONFIGURED: no task, not offered, not counted — and the tool still refuses", async () => {
    await withEnv(UNCONFIGURED, async () => {
      assert.equal(isLakeQueryConfigured(), false);
      assert.ok(unplannableTools().has("query_lake"));
      const plan = newsSentimentCatalystsSkill.buildPlan({ symbol: "TCS" });
      assert.deepEqual(
        plan.tasks.map((t) => t.tool),
        [
          "fetch_news",
          "fetch_corporate_actions",
          "compute_news_sentiment",
          "synthesize_report",
        ],
      );
      assert.ok(
        !plan.tasks.at(-1)!.dependsOn.includes("event_reactions"),
        "the report waits on a task that was never planned",
      );
      assert.doesNotMatch(
        getPlannerPrompt(["fetch_news", "query_lake"]),
        /- query_lake\b/,
      );
      // fetch_news + compute_news_sentiment + fetch_corporate_actions, + 2.
      assert.equal(minTasks(["news-sentiment-catalysts"]), 5);
      assert.equal(minTasks(PINNED_QUANT), 16);
      assert.equal(minTasks(["dcf-valuation"]), 8);
      // The refusal inside the tool is untouched.
      const out = await runQueryLake(VALID.event_outcomes_by_type);
      assert.equal(out.success, false);
      assert.match(out.error ?? "", /LAKE_ENV|LAKE_PROJECT/);
    });
  });

  it("CONFIGURED: planned, offered, counted — and the pinned floors do not move", () => {
    withEnv(CONFIGURED, () => {
      assert.equal(isLakeQueryConfigured(), true);
      assert.equal(unplannableTools().size, 0);
      const plan = newsSentimentCatalystsSkill.buildPlan({ symbol: "TCS" });
      assert.equal(plan.tasks.length, 5);
      assert.ok(plan.tasks.some((t) => t.tool === "query_lake"));
      assert.match(
        getPlannerPrompt(["fetch_news", "query_lake"]),
        /- query_lake\b/,
      );
      assert.equal(minTasks(["news-sentiment-catalysts"]), 6);
      assert.equal(minTasks(PINNED_QUANT), 16);
      assert.equal(minTasks(["dcf-valuation"]), 8);
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   An empty answer that is not a fact is refused — MONEY-1597 re-review
   ──────────────────────────────────────────────────────────────────────── */

/** An executor returning exactly `rows`, recording nothing else. */
function returning(rows: Record<string, unknown>[]): QueryLakeDeps {
  const f = fakeDeps(rows);
  return f.deps;
}

describe("an EMPTY answer is refused by name unless it is a fact", () => {
  it("the events SQL always returns the probe row — a LEFT join onto a one-row count", () => {
    // Not executable here (QUALIFY, INTERVAL); executed on prod 2026-09-23,
    // where RELIANCE:NSE:unknown returned exactly one row, listing_sessions 0.
    // An INNER join would return NO row when there are no events, and the
    // tool would then refuse a listing it does know.
    const sql = code(LAKE_SQL.events_for_listing);
    assert.match(sql, /FROM coverage AS c\s+LEFT JOIN events AS ev ON TRUE/);
    assert.match(
      sql,
      /COUNT\(\*\) AS listing_sessions\s+FROM \{\{gold\}\}\.rolling_stats\s+WHERE session_date >= PARSE_DATE\('%Y-%m-%d', @since\)/,
    );
  });

  it("events_for_listing: no events AND no sessions — the lake does not know the listing", async () => {
    // The shape the SQL returns with no events: one probe row, NULL event.
    const f = fakeDeps([{ listing_sessions: 0, event_id: null }]);
    const out = await runQueryLake(VALID.events_for_listing, f.deps);
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /holds no bars for AAPL:NASDAQ:1980-12-12/);
    assert.equal(f.sets.size, 0, "a refusal was cached");
  });

  it("events_for_listing: no events WITH sessions is a real, cacheable zero", async () => {
    const f = fakeDeps([{ listing_sessions: 12, event_id: null }]);
    const out = await runQueryLake(VALID.events_for_listing, f.deps);
    assert.equal(out.success, true);
    const data = out.data as LakeAnswer;
    assert.equal(data.rowCount, 0);
    assert.deepEqual(data.rows, []);
    assert.equal(f.sets.size, 1);
  });

  it("events_for_listing: events are kept even with no sessions, and the probe column is dropped", async () => {
    const out = await runQueryLake(
      VALID.events_for_listing,
      returning([
        { listing_sessions: 0, event_id: "a", window_status: "NO_BARS" },
        { listing_sessions: 0, event_id: "b", window_status: "NO_BARS" },
      ]),
    );
    assert.equal(out.success, true);
    const rows = (out.data as LakeAnswer).rows;
    assert.deepEqual(
      rows.map((r) => r.event_id),
      ["a", "b"],
    );
    assert.ok(!("listing_sessions" in rows[0]!));
  });

  it("rolling_stats_for and universe_top_by: empty is refused and not cached", async () => {
    for (const [raw, pattern] of [
      [
        VALID.rolling_stats_for,
        /RELIANCE:NSE:unknown has no session in the 14 days before 2026-09-18/,
      ],
      [
        VALID.universe_top_by,
        /no IN listing has a session in the week before 2026-09-18/,
      ],
    ] as const) {
      const f = fakeDeps([]);
      const out = await runQueryLake(raw, f.deps);
      assert.equal(out.success, false);
      assert.match(out.error ?? "", pattern);
      assert.equal(f.sets.size, 0);
    }
  });

  it("event_outcomes_by_type is always one aggregate row, so it is never refused for size", async () => {
    const out = await runQueryLake(
      VALID.event_outcomes_by_type,
      returning([{ events: 0, n_1d: 0 }]),
    );
    assert.equal(out.success, true);
  });
});

describe("each template carries the units of ITS numbers", () => {
  it("universe_top_by says the pct_* metrics and volatility are fractions", async () => {
    const out = await runQueryLake(
      VALID.universe_top_by,
      returning([{ metric_value: 0.35 }]),
    );
    const note = String((out.data as { note: string }).note);
    assert.match(
      note,
      /pct_above_sma_200[^.]*FRACTIONS \(0\.35 = 35%, never '0\.35%'\)/,
    );
    assert.match(note, /realised_vol_30d is an ANNUALISED FRACTION/);
  });

  it("rolling_stats_for says volatility is annualised and prices carry a currency", async () => {
    const out = await runQueryLake(
      VALID.rolling_stats_for,
      returning([{ adj_close: 1 }]),
    );
    const note = String((out.data as { note: string }).note);
    assert.match(note, /realised_vol_30d is an ANNUALISED FRACTION/);
    assert.match(note, /currency/);
  });

  it("no two templates share a note, and every one is placed before the rows", async () => {
    const notes = new Set<string>();
    for (const t of LAKE_TEMPLATES) {
      const out = await runQueryLake(
        VALID[t],
        returning([{ event_id: "x", a: 1 }]),
      );
      const keys = Object.keys(out.data as object);
      assert.ok(keys.indexOf("note") < keys.indexOf("rows"), t);
      notes.add(String((out.data as { note: string }).note));
    }
    assert.equal(notes.size, LAKE_TEMPLATES.length);
  });
});

describe("the planner is told how to CALL query_lake (MONEY-1597 re-review)", () => {
  const calls = (prompt: string): Record<string, unknown>[] =>
    [...prompt.matchAll(/\{"template":[^\n]*?\}/g)].map(
      (m) => JSON.parse(m[0]) as Record<string, unknown>,
    );

  it("every call the prompt shows is one the tool accepts, and all four templates are shown", () => {
    withEnv(CONFIGURED, () => {
      const prompt = getPlannerPrompt(["fetch_news", "query_lake"]);
      const shown = calls(prompt);
      assert.deepEqual(
        shown.map((c) => c.template).sort(),
        [...LAKE_TEMPLATES].sort(),
      );
      for (const c of shown) {
        assert.doesNotThrow(() => parse(c), JSON.stringify(c));
      }
      // The raw-ticker convention the skill uses is the one it teaches.
      assert.equal(
        parse(shown.find((c) => c.template === "events_for_listing")!).params
          .listing_id,
        "M&M:NSE:unknown",
      );
    });
  });

  it("the usage appears only where the tool is offered", () => {
    withEnv(UNCONFIGURED, () => {
      assert.deepEqual(
        calls(getPlannerPrompt(["fetch_news", "query_lake"])),
        [],
      );
    });
    withEnv(CONFIGURED, () => {
      assert.deepEqual(calls(getPlannerPrompt(["fetch_news"])), []);
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The report writer sees the units note — MONEY-1597 review (item 4)
   ──────────────────────────────────────────────────────────────────────── */

describe("the note survives the synthesizer's 4,000-character cut", () => {
  it("a 500-row answer still carries the note and the counts", async () => {
    const f = fakeDeps(
      Array.from({ length: 501 }, (_, i) => ({
        event_id: `${"f".repeat(38)}${String(i).padStart(2, "0")}`,
        event_type: "FILING_8K",
        title: "Results of Operations and Financial Condition",
        ret_1d: 0.0123,
        abn_ret_1d: -0.004,
        gap_open_pct: 1.7,
      })),
    );
    const out = await runQueryLake(VALID.events_for_listing, f.deps);
    const task: ResearchTask = {
      id: "event_reactions",
      type: "data_fetch",
      tool: "query_lake",
      params: {},
      dependsOn: [],
      status: "completed",
      result: out.data,
    };
    const prompt = buildSynthesizerUserPrompt("q", [task]);
    const section = prompt.split("--- query_lake (event_reactions) ---\n")[1]!;
    assert.ok(
      section.length < 4_100,
      "the result was not cut — test proves nothing",
    );
    assert.match(section, /gap_open_pct is PERCENT/);
    assert.match(section, /Point-in-time/);
    assert.match(section, /"truncated":true/);
    assert.match(section, /"rowCount":500/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   universe_top_by, EXECUTED — one row per SECURITY (MONEY-1606 + review)
   ──────────────────────────────────────────────────────────────────────── */

interface StatRow {
  listing_id: string;
  exchange: "NSE" | "BSE";
  isin: string | null;
  session_date: string;
  adj_close: number;
  sma_200: number | null;
  sessions_in_window: number;
}

/**
 * Shaped on prod `instrument_current` / `price_bar_d1` rows measured
 * 2026-09-23. MBECL is one security on both exchanges (INE748A01024); FOCUS is
 * two companies (INE593W01028 NSE, INE0DXR01010 BSE); GATECH (INE224E01028)
 * and GATECHDVR (INE224E01036) are two securities of ONE issuer, E224E.
 */
function stat(
  symbol: string,
  exchange: "NSE" | "BSE",
  isin: string | null,
  metric: number | null,
  over: Partial<StatRow> = {},
): StatRow {
  return {
    listing_id: `${symbol}:${exchange}:unknown`,
    exchange,
    isin,
    session_date: "2026-09-18",
    adj_close: 100,
    // pct_above_sma_200 = adj_close / sma_200 - 1, so the metric is set here.
    sma_200: metric === null ? null : 100 / (1 + metric),
    sessions_in_window: 252,
    ...over,
  };
}

const UNIVERSE_ROWS: StatRow[] = [
  stat("MBECL", "NSE", "INE748A01024", 15.76),
  stat("MBECL", "NSE", "INE748A01024", 99, { session_date: "2026-09-17" }), // older: not its latest
  stat("MBECL", "BSE", "INE748A01024", 15.74),
  stat("FOCUS", "NSE", "INE593W01028", 3.0),
  stat("FOCUS", "BSE", "INE0DXR01010", 2.9),
  stat("TRUSTWAVE", "BSE", "INE668Y01024", 6.38),
  // NSE has no value (no 200-day SMA): BSE is the fallback.
  stat("WORTHPERI", "NSE", "INE196Y01018", null),
  stat("WORTHPERI", "BSE", "INE196Y01018", 1.5),
  // NSE's last session is two weeks stale: BSE is the fallback.
  stat("STALECO", "NSE", "INE111B01011", 8.0, { session_date: "2026-09-01" }),
  stat("STALECO", "BSE", "INE111B01011", 1.4),
  // NSE's window is too short for a 200-day SMA to mean one.
  stat("NEWCO", "NSE", "INE222C01012", 9.0, { sessions_in_window: 12 }),
  stat("NEWCO", "BSE", "INE222C01012", 1.3),
  // ONE issuer, TWO securities: an ordinary share and a DVR under E..01
  // serials. The issuer key merged them; each is its own row, twins folded.
  stat("GATECH", "NSE", "INE224E01028", 0.8),
  stat("GATECH", "BSE", "INE224E01028", 0.79),
  stat("GATECHDVR", "NSE", "INE224E01036", 0.7),
  stat("GATECHDVR", "BSE", "INE224E01036", 0.69),
  // Two ETFs of one AMC share its INF code; each is its own security, and
  // one ETF's NSE/BSE twins fold.
  stat("NIFTYBEES", "NSE", "INF204KB14I2", 0.3),
  stat("NIFTYBEES", "BSE", "INF204KB14I2", 0.29),
  stat("BANKBEES", "NSE", "INF204KB15I9", 0.25),
  // A BSE-only equity and a BSE-only NCD under the SAME company code. By
  // issuer, listing_id ascending let the digit-leading bond win the group.
  stat("RFLTD", "BSE", "INE555E01011", 0.6),
  stat("135RFL27", "BSE", "INE555E07018", 0.5),
  // One exchange already on a re-issued serial: two ISINs, so two rows. Seen
  // only for the days around a re-serialisation — the price of never merging
  // two securities.
  stat("SPLITCO", "NSE", "INE333D01010", 1.2),
  stat("SPLITCO", "BSE", "INE333D01028", 1.19),
  // A malformed ISIN is no key at all — it must not merge into MBECL.
  stat("TRUNC", "BSE", "INE748A0102", 1.1),
  // No ISIN: each listing is its own group.
  stat("NOISIN", "NSE", null, 1.0),
  stat("NOISIN", "BSE", null, 0.9),
];

/**
 * An executor for the job the tool BUILDS — rendered SQL, bound params — run in
 * SQLite over `rows`, with the three BigQuery built-ins it uses registered.
 * Only the backticked dataset qualifier is stripped.
 */
function sqliteRun(rows: readonly StatRow[]) {
  return async (job: LakeJob): Promise<Record<string, unknown>[]> => {
    const db = new DatabaseSync(":memory:");
    try {
      db.function("PARSE_DATE", (fmt, s) => {
        assert.equal(fmt, "%Y-%m-%d");
        return s;
      });
      db.function("REGEXP_CONTAINS", (s, re) =>
        s === null ? null : new RegExp(String(re)).test(String(s)) ? 1 : 0,
      );
      db.function("SAFE_DIVIDE", (a, b) =>
        a === null || b === null || Number(b) === 0
          ? null
          : Number(a) / Number(b),
      );
      db.exec(`CREATE TABLE rolling_stats (
        market TEXT, listing_id TEXT, symbol TEXT, exchange TEXT,
        session_date TEXT, isin TEXT, adj_close REAL, sma_50 REAL,
        sma_200 REAL, high_52w REAL, low_52w REAL, avg_volume_20 REAL,
        realised_vol_30d REAL, sessions_in_window INTEGER
      )`);
      const ins = db.prepare(
        `INSERT INTO rolling_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of rows) {
        ins.run(
          "IN",
          r.listing_id,
          r.listing_id.split(":")[0]!,
          r.exchange,
          r.session_date,
          r.isin,
          r.adj_close,
          null,
          r.sma_200,
          null,
          null,
          null,
          null,
          r.sessions_in_window,
        );
      }
      return db
        .prepare(job.query.query.replace(/`[^`]+`\./g, ""))
        .all(job.query.params) as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
}

async function universe(n = 50): Promise<LakeAnswer> {
  const f = fakeDeps();
  const out = await runQueryLake(
    {
      template: "universe_top_by",
      metric: "pct_above_sma_200",
      market: "IN",
      as_of: "2026-09-18",
      n,
    },
    { ...f.deps, run: sqliteRun(UNIVERSE_ROWS) },
  );
  assert.equal(out.success, true, out.error);
  return out.data as LakeAnswer;
}

describe("universe_top_by ranks SECURITIES, not listings", () => {
  it("one row per ISIN, NSE kept, BSE only where NSE has no value", async () => {
    const got = (await universe()).rows.map((r) => r.listing_id);
    assert.deepEqual([...got].sort(), [
      "135RFL27:BSE:unknown",
      "BANKBEES:NSE:unknown",
      "FOCUS:BSE:unknown",
      "FOCUS:NSE:unknown",
      "GATECH:NSE:unknown",
      "GATECHDVR:NSE:unknown",
      "MBECL:NSE:unknown",
      "NEWCO:BSE:unknown",
      "NIFTYBEES:NSE:unknown",
      "NOISIN:BSE:unknown",
      "NOISIN:NSE:unknown",
      "RFLTD:BSE:unknown",
      "SPLITCO:BSE:unknown",
      "SPLITCO:NSE:unknown",
      "STALECO:BSE:unknown",
      "TRUNC:BSE:unknown",
      "TRUSTWAVE:BSE:unknown",
      "WORTHPERI:BSE:unknown",
    ]);
  });

  it("securities that SHARE a MONEY-1543 issuer code are never merged", async () => {
    const got = new Set((await universe()).rows.map((r) => r.listing_id));
    for (const [a, b, isinA, isinB] of [
      ["GATECH", "GATECHDVR", "INE224E01028", "INE224E01036"],
      ["NIFTYBEES", "BANKBEES", "INF204KB14I2", "INF204KB15I9"],
    ] as const) {
      // They DO share the issuer — this is the case the issuer key merged.
      assert.equal(isinIssuer(isinA), isinIssuer(isinB));
      assert.ok(got.has(`${a}:NSE:unknown`), a);
      assert.ok(got.has(`${b}:NSE:unknown`), b);
    }
    // And a bond cannot displace its issuer's equity.
    assert.equal(isinIssuer("INE555E01011"), isinIssuer("INE555E07018"));
    assert.ok(got.has("RFLTD:BSE:unknown"));
  });

  it("the group key is the full ISIN, and a malformed one is no key", async () => {
    const rows = (await universe()).rows;
    const isinOf = new Map(UNIVERSE_ROWS.map((r) => [r.listing_id, r.isin]));
    for (const r of rows) {
      const own = isinOf.get(String(r.listing_id));
      const valid = own !== null && own !== undefined && own.length === 12;
      assert.equal(r.isin ?? null, valid ? own : null, String(r.listing_id));
    }
  });

  it("each security's LATEST session is the one ranked", async () => {
    const mbecl = (await universe()).rows.find(
      (r) => r.listing_id === "MBECL:NSE:unknown",
    )!;
    assert.equal(mbecl.session_date, "2026-09-18");
    assert.ok(Math.abs(Number(mbecl.metric_value) - 15.76) < 1e-9);
  });

  it("ranked highest first, cut at n — and the cut is reported", async () => {
    const top = await universe(3);
    assert.deepEqual(
      top.rows.map((r) => r.listing_id),
      ["MBECL:NSE:unknown", "TRUSTWAVE:BSE:unknown", "FOCUS:NSE:unknown"],
    );
    assert.equal(top.truncated, true);
    const all = await universe(50);
    assert.equal(all.rowCount, 18);
    assert.equal(all.truncated, false);
  });
});
