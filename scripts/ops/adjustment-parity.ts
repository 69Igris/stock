/**
 * adjustment-parity.ts — the SQL adjustment equals the TypeScript, in BIGQUERY.
 * MONEY-1506 (data-platform B4); read-only and action-bearing since MONEY-1528.
 *
 *   npx tsx scripts/ops/adjustment-parity.ts qa
 *   npx tsx scripts/ops/adjustment-parity.ts prod
 *
 * ## WHAT THIS ADDS OVER THE CI TEST
 *
 * `packages/core/__tests__/market-data/adjustment-sql-parity.test.ts` runs the
 * SAME SQL over the SAME fixtures in `node:sqlite` and compares it to the SAME
 * TypeScript reference. It proves the ALGEBRA, on every push, with no
 * credentials.
 *
 * Two things it cannot prove, both of which live here:
 *
 *   1. that BigQuery PARSES the text at all — SQLite and BigQuery overlap but
 *      are not the same dialect, and a construct only one of them accepts fails
 *      at the first real workflow invocation rather than in CI;
 *   2. that BigQuery's ARITHMETIC matches. SQLite has no NUMERIC, so a type
 *      BigQuery quantises is invisible offline. That is not hypothetical:
 *      MONEY-1528 found every factor in the view running in NUMERIC(38,9) —
 *      `EXP(LN(10) + LN(5))` is 49.999999979 there — and this script failed on
 *      it (price 2.8e-9 against a 1e-9 bound, one adjusted volume off by a
 *      share) the first time it was fed an action row.
 *
 * It needs credentials and a billed query, so it is a `verify:push` proof
 * rather than a CI test — the B4 brief says exactly that.
 *
 * ## WHAT IT EXECUTES AGAINST: ONE READ-ONLY QUERY, AND NOTHING ELSE
 *
 * Both inputs are INLINE. The CSV and the action-path fixture are rendered as
 * typed literals and handed to `adjustedBarD1Sql` in place of the two silver
 * tables, each as
 *
 *     (SELECT <columns> FROM lake_silver_{env}.<table> WHERE FALSE
 *      UNION ALL SELECT * FROM UNNEST(<the fixture rows>))
 *
 * The `WHERE FALSE` half is why the real table is named at all. It reads
 * nothing — a dry run of it bills 0 bytes — but BigQuery still resolves every
 * column the SQL names against the DEPLOYED schema, and the fixture is unioned
 * into that schema's types. So SQL naming a column this environment's silver
 * does not have yet fails HERE, by name, rather than at the first scheduled
 * Dataform run. `observed_ratio` is exactly that column until its DDL is
 * applied (MONEY-1528 B).
 *
 * IT USED TO WRITE. Until MONEY-1528 it created `price_bar_d1_parity_fixture`
 * in `lake_silver_{env}` and loaded the CSV into it, so `… prod` was a table
 * create plus a load job against the production silver dataset, dropped after
 * unless `--keep`. And the action side was `corporate_action WHERE FALSE`, so
 * every CTE MONEY-1516 added was parsed here and never once executed.
 *
 * ## THE TYPESCRIPT IS FED WHAT BIGQUERY SAW
 *
 * The raw OHLCV columns come back from the same query as the adjusted ones, so
 * the reference series is built from the values BigQuery actually read rather
 * than from a second parse of the fixtures. The actions do not come back (the
 * view does not return them); they are exact decimal literals, which NUMERIC
 * reads exactly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { LAKE_REGION } from "@usemoney/core/ops/lake-layout";
import { computeAdjustedSeries } from "@usemoney/core/market-data/tiingo/tiingo-logic";
import {
  ACTION_PATH_ACTIONS,
  ACTION_PATH_BARS,
  referenceBars,
  type ParityBarRow,
} from "../../packages/core/__tests__/market-data/fixtures/adjustment-parity-actions";

const PROJECT_ID = "stock-book-483718";
/** The same bound the CI test asserts. One tolerance, not two. */
const PARITY_TOLERANCE = 1e-9;

/** `import.meta.dirname` is undefined under tsx's CJS output — the repo idiom. */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIXTURE_CSV = join(
  ROOT,
  "packages/core/__tests__/market-data/fixtures/adjustment-parity.csv",
);
const INCLUDE_PATH = join(ROOT, "dataform/includes/adjustment.js");

// REQUIRED, never defaulted — same reasoning as lake-smoke.ts. A dropped
// argument must not certify prod with a QA run.
const env = process.argv[2];
if (env !== "qa" && env !== "prod") {
  console.error(
    `Usage: npx tsx scripts/ops/adjustment-parity.ts {qa|prod}  ` +
      `(got ${env === undefined ? "no argument" : `"${env}"`})`,
  );
  process.exit(1);
}

const SILVER = `lake_silver_${env}`;

interface AdjustmentInclude {
  ADJUSTMENT_POLICY_VERSION: string;
  adjustedBarD1Sql: (source: string, actionSource: string) => string;
}

type SqlType = "STRING" | "DATE" | "NUMERIC" | "INT64" | "TIMESTAMP";
type Cell = string | number | null;

/** The columns `adjustedBarD1Sql` reads from each table, in the DDL's types. */
const BAR_COLUMNS: readonly (readonly [string, SqlType])[] = [
  ["market", "STRING"],
  ["listing_id", "STRING"],
  ["symbol", "STRING"],
  ["exchange", "STRING"],
  ["session_date", "DATE"],
  ["open", "NUMERIC"],
  ["high", "NUMERIC"],
  ["low", "NUMERIC"],
  ["close", "NUMERIC"],
  ["volume", "INT64"],
  ["div_cash", "NUMERIC"],
  ["split_factor", "NUMERIC"],
  ["source", "STRING"],
];
const ACTION_COLUMNS: readonly (readonly [string, SqlType])[] = [
  ["market", "STRING"],
  ["listing_id", "STRING"],
  ["action_type", "STRING"],
  ["ex_date", "DATE"],
  ["ratio", "NUMERIC"],
  ["observed_ratio", "NUMERIC"],
  ["cash", "NUMERIC"],
  ["observed_at", "TIMESTAMP"],
  ["source_record_key", "STRING"],
  ["source", "STRING"],
];

/**
 * A typed SQL literal. NUMERIC is written as a decimal STRING literal, so the
 * fixture's `1017.40` reaches BigQuery as exactly that decimal — never through
 * a double, which is the rounding this script exists to observe.
 */
function literal(type: SqlType, v: Cell): string {
  if (v === null || v === "") return "NULL";
  const s = String(v);
  switch (type) {
    case "STRING":
      return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "DATE":
      return `DATE '${s}'`;
    case "TIMESTAMP":
      return `TIMESTAMP '${s}'`;
    case "NUMERIC":
      return `NUMERIC '${s}'`;
    case "INT64":
      if (!/^-?\d+$/.test(s)) throw new Error(`not an INT64 literal: ${s}`);
      return s;
  }
}

/** `(SELECT … FROM <real> WHERE FALSE UNION ALL SELECT * FROM UNNEST(…))`. */
function inlineTable(
  table: string,
  columns: readonly (readonly [string, SqlType])[],
  rows: readonly Readonly<Record<string, Cell>>[],
): string {
  const names = columns.map(([name]) => name).join(", ");
  const struct = columns.map(([name, type]) => `${name} ${type}`).join(", ");
  const tuples = rows
    .map(
      (r) =>
        `(${columns.map(([name, type]) => literal(type, r[name] ?? null)).join(", ")})`,
    )
    .join(",\n");
  return `(SELECT ${names} FROM \`${PROJECT_ID}.${SILVER}.${table}\` WHERE FALSE
UNION ALL
SELECT * FROM UNNEST(ARRAY<STRUCT<${struct}>>[
${tuples}
]))`;
}

/** The CSV as string cells — decimals stay exactly as written. */
function csvRows(): Record<string, Cell>[] {
  const lines = readFileSync(FIXTURE_CSV, "utf8").trim().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? null]));
  });
}

/**
 * BigQuery hands NUMERIC back as a `Big` (or a string) precisely because it
 * does not fit a double, FLOAT64 as a number, and DATE as `{ value }`.
 * Coercing with `Number()` here is correct and is the last place it happens:
 * the comparison is against a TypeScript implementation that works in doubles,
 * so the reference itself has no more precision than this.
 */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(String(v));
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}
function day(v: unknown): string {
  return typeof v === "string" ? v : String((v as { value: string }).value);
}

type ResultRow = Record<string, unknown> & { listing_id: string };

async function main(): Promise<void> {
  const include = (await import(pathToFileURL(INCLUDE_PATH).href)) as {
    default?: AdjustmentInclude;
  } & AdjustmentInclude;
  const adjustment: AdjustmentInclude = include.default ?? include;

  const bars: Readonly<Record<string, Cell>>[] = [
    ...csvRows(),
    ...ACTION_PATH_BARS.map((b) => ({ ...b })),
  ];
  const sql = adjustment.adjustedBarD1Sql(
    inlineTable("price_bar_d1", BAR_COLUMNS, bars),
    inlineTable(
      "corporate_action",
      ACTION_COLUMNS,
      ACTION_PATH_ACTIONS.map((a) => ({ ...a })),
    ),
  );

  console.log(
    `[adjustment-parity] ${bars.length} bars + ${ACTION_PATH_ACTIONS.length} actions, inline, ` +
      `typed against ${SILVER} (${LAKE_REGION}) — nothing is written`,
  );
  const bq = new BigQuery({ projectId: PROJECT_ID, location: LAKE_REGION });
  const [job] = await bq.createQueryJob({
    query: `${sql} ORDER BY listing_id, session_date`,
    location: LAKE_REGION,
  });
  // ASSERTED, not assumed — a job that ran in the US would certify the one
  // thing the region rule exists to check (lake-smoke.ts records this).
  const jobLocation = job.metadata?.jobReference?.location ?? "(absent)";
  if (jobLocation !== LAKE_REGION) {
    throw new Error(`the query ran in ${jobLocation}, expected ${LAKE_REGION}`);
  }
  const [rows] = (await job.getQueryResults()) as unknown as [ResultRow[]];

  // Every fixture bar exactly once. An empty result would make every
  // comparison below vacuously true, and a short one would skip the bars it
  // dropped.
  if (rows.length !== bars.length) {
    throw new Error(
      `BigQuery returned ${rows.length} rows for ${bars.length} fixture bars`,
    );
  }

  const byListing = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const list = byListing.get(r.listing_id) ?? [];
    list.push(r);
    byListing.set(r.listing_id, list);
  }

  let worstPrice = 0;
  let worstVolume = 0;
  let where = "none";
  let compared = 0;

  for (const [listingId, listingRows] of byListing) {
    const seen: ParityBarRow[] = listingRows.map((r) => ({
      market: String(r.market),
      listing_id: listingId,
      symbol: String(r.symbol),
      exchange: String(r.exchange),
      session_date: day(r.session_date),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: num(r.volume),
      div_cash: numOrNull(r.div_cash),
      split_factor: numOrNull(r.split_factor),
      source: String(r.source),
    }));
    const ts = computeAdjustedSeries(referenceBars(seen, ACTION_PATH_ACTIONS));
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      const s = listingRows[i]!;
      for (const [name, got, want] of [
        ["adjOpen", num(s.adj_open), t.adjOpen],
        ["adjHigh", num(s.adj_high), t.adjHigh],
        ["adjLow", num(s.adj_low), t.adjLow],
        ["adjClose", num(s.adj_close), t.adjClose],
      ] as [string, number, number][]) {
        compared++;
        const rel = Math.abs(got - want) / Math.max(1, Math.abs(want));
        if (rel > worstPrice) {
          worstPrice = rel;
          where = `${listingId} ${t.date} ${name}: bq=${got} ts=${want}`;
        }
      }
      const volDiff = Math.abs(num(s.adj_volume) - t.adjVolume);
      if (volDiff > worstVolume) {
        worstVolume = volDiff;
        where = `${listingId} ${t.date} adjVolume: bq=${num(s.adj_volume)} ts=${t.adjVolume}`;
      }
      if (
        s.adjustment_policy_version !== adjustment.ADJUSTMENT_POLICY_VERSION
      ) {
        throw new Error(
          `${listingId} ${t.date}: BigQuery stamped ` +
            `"${String(s.adjustment_policy_version)}", the include says ` +
            `"${adjustment.ADJUSTMENT_POLICY_VERSION}"`,
        );
      }
    }
  }

  console.log(
    `[adjustment-parity] ${rows.length} rows, ${byListing.size} listings, ${compared} price comparisons`,
  );
  console.log(
    `[adjustment-parity] worst relative price disagreement ${worstPrice.toExponential(3)} ` +
      `(tolerance ${PARITY_TOLERANCE.toExponential(0)})`,
  );
  console.log(
    `[adjustment-parity] worst adjusted-volume difference ${worstVolume}`,
  );

  if (worstPrice > PARITY_TOLERANCE || worstVolume !== 0) {
    console.error(`[adjustment-parity] FAIL at ${where}`);
    process.exitCode = 1;
    return;
  }
  console.log("[adjustment-parity] OK — BigQuery agrees with the TypeScript");
}

main().catch((err: unknown) => {
  console.error(
    `[adjustment-parity] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
