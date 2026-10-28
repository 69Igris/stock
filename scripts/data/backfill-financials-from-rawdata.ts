/**
 * Backfill `StockFinancials` typed columns from the `rawData` already on the row
 * — MONEY-1205.
 *
 * ## What is wrong, and why no refetch is needed
 *
 * Prod holds 32,359 `stock_financials` rows, 100% `source:"TICKERTAPE"`, all
 * written by `scripts/seed/seed-stock-financials.ts` on 2026-03-21. Eleven of
 * the thirteen typed columns are **null on every single row**, and `periodEnd`
 * is null on every row too. Only `revenue` (12,209) and `ebitda` (12,212) are
 * populated.
 *
 * That is not missing data. The seed read `row.incNpat`, `row.bsTass`,
 * `row.bsTdbt`, `row.bsTeq`, `row.cfOcf` and `row.cfFcf`; Tickertape's keys are
 * `incNinc`, `balTota`, `balTdeb`, `balTeq`, `cafCfoa` and `cafFcf`. Only
 * `incTrev` and `incEbi` were guessed correctly — exactly the two columns that
 * are populated. Every figure the seed failed to read was nonetheless stored
 * VERBATIM in `rawData` on the same row, because the seed wrote
 * `rawData: JSON.parse(JSON.stringify(row))` before mapping.
 *
 * **So the fix is a re-read, not a re-fetch.** This script re-resolves every
 * typed column and `periodEnd` from each row's own `rawData` through the shared
 * `mapTickertapeStatementRow`, and touches no network at all. Refetching 32,359
 * rows would take ~11k Tickertape calls, would be rate-limited for hours, and
 * would answer a question we already hold the answer to.
 *
 * ## What it will NOT do
 *
 *  - **It never nulls a populated column.** A column the mapper cannot resolve
 *    from `rawData` is left exactly as it is. That is the MONEY-1205 landmine
 *    restated: `revenue` and `ebitda` are the only real data in this table, and
 *    a backfill that "normalised" them to null would destroy the one thing the
 *    seed got right.
 *  - **It never touches `source`, `rawData` or `fetchedAt`.** Those record
 *    provenance. This script derives nothing new — it reads what is already on
 *    the row — so the row's provenance is unchanged and must keep saying so.
 *    Rewriting `rawData` would also destroy any `displacedByXbrl` record
 *    (`packages/core/src/market-data/xbrl-projection.ts`).
 *  - **It never invents a value.** `grossProfit` stays null because `incGpro`
 *    is null in 100% of Tickertape rows; it is not derived from
 *    revenue − costOfRevenue, because `incCrev` is null too.
 *  - **It never writes a row a higher-ranked source owns.** `rawData` here is a
 *    TICKERTAPE payload, so filling a column from it is a Tickertape-authored
 *    write however indirect it looks, and it is gated on
 *    `mayOverwriteFinancials("TICKERTAPE", row.source)` like every other writer
 *    of this model. Today prod is 100% TICKERTAPE so the guard skips nothing —
 *    but the moment `xbrl-projection-writer` is armed, an NSE_XBRL row that
 *    still carries a Tickertape-shaped `rawData` would otherwise get Tickertape
 *    numbers written into its NULL columns under an NSE_XBRL stamp: a row
 *    nobody can attribute, which is the exact state MONEY-1175 sat in.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/backfill-financials-from-rawdata.ts                 # dry run, DATABASE_URL
 *   npx tsx scripts/data/backfill-financials-from-rawdata.ts --env qa        # dry run vs QA
 *   npx tsx scripts/data/backfill-financials-from-rawdata.ts --env prod      # dry run vs prod
 *   npx tsx scripts/data/backfill-financials-from-rawdata.ts --env prod --apply
 *   … --symbols=HDFCBANK,TCS   … --limit=500   … --verbose
 *
 * `--apply` is TTY-gated and prompts with the host it is about to write to,
 * matching `reclassify-instruments.ts` / `resector-real-estate.ts`. It is
 * deliberately not wrappable: there is no `--yes`.
 */

import { execFileSync } from "child_process";
import { createInterface } from "readline";
// The NARROW subpath, never the `@usemoney/core/market-data` BARREL —
// MONEY-1205.
//
// The barrel re-exports `instrument-sync`, `quote-service`, `mf-nav-service`
// and seven more modules that import `@usemoney/database` as a VALUE.
// `@usemoney/database` builds its PrismaClient at MODULE scope from
// `process.env.DATABASE_URL`, and ESM evaluates every static import before any
// statement in this file's body — so the client would be pinned to whatever
// DATABASE_URL the shell exported, BEFORE `main()` resolves `--env`.
//
// That is the worst failure shape a safety prompt can have, and it is not
// hypothetical: `confirmWrite` below echoes the host that `--env prod`
// resolved, so the operator types "yes" to prod while the writes land on the
// shell's database. `resector-real-estate.ts` deferred its own prisma import
// correctly and was still broken by exactly this barrel.
//
// `xbrl-projection.ts` has a single `import type` and reaches no runtime
// dependency at all. Guarded by the `ops-script-db-target` static scan, which
// now lists this script.
import { mayOverwriteFinancials } from "@usemoney/core/market-data/xbrl-projection";
import {
  mapTickertapeStatementRow,
  tickertapeStatementColumns,
  type TickertapeFinancialColumn,
  type TickertapeStatementType,
} from "@usemoney/research/data-sources/db-store-logic";

const GCP_PROJECT = "stock-book-483718";

/** Every typed column this backfill can fill. Ordered for a stable report. */
const COLUMNS = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "ebitda",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
] as const satisfies ReadonlyArray<TickertapeFinancialColumn>;

/** Rows read per page. Keyset-paged so a growing table cannot skip rows. */
const PAGE_SIZE = 1000;

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  symbols: string[];
  verbose: boolean;
}

/**
 * Every flag this script understands — MONEY-1205.
 *
 * Unlike its siblings, this parser accepts BOTH `--flag value` and
 * `--flag=value`, so the equals form is legal here and is not rejected.
 *
 * The rejection that IS needed is the unknown flag. `resector-real-estate.ts`
 * grew the same guard after `--apply --dry-run` WROTE — an ignored `--dry-run`
 * reads as a safe rehearsal right up until the rows change. This script is a
 * prod writer over 32,359 rows with no transaction, so the same footgun is
 * loaded here.
 */
const KNOWN_FLAGS = new Set([
  "--apply",
  "--env",
  "--limit",
  "--symbols",
  "--verbose",
]);

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ` +
        `${[...KNOWN_FLAGS].join(", ")}. Refusing to run rather than ` +
        `silently ignoring an option you believed was in effect — ` +
        `"--apply --dry-run" must never be read as a rehearsal.`,
    );
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);

  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${f}=`));
    if (eq) return eq.slice(f.length + 1);
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    // A flag given with NO value is an ERROR, not an absent flag — MONEY-1205.
    //
    // This used to `return null` for `--limit --apply`, which is the same value
    // "--limit was not passed" produces. So the guard below that refuses a
    // non-positive limit never fired, and the run silently became UNLIMITED:
    // `--limit --apply` against prod is a full-table write by the operator who
    // asked for 500 rows. `--env --apply` is the same shape one step worse — it
    // leaves APPLY mode pointed at the ambient DATABASE_URL.
    if (next === undefined || next.startsWith("--")) {
      throw new Error(
        `${f} was given without a value. Use "${f} <value>" or ` +
          `"${f}=<value>". Refusing to run rather than treating it as absent — ` +
          `an ignored --limit means EVERY row, and an ignored --env means the ` +
          `ambient DATABASE_URL.`,
      );
    }
    return next;
  };

  const env = val("--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const limitRaw = val("--limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `--limit must be a positive integer, got "${limitRaw}". ` +
          `Refusing to run rather than silently processing every row.`,
      );
    }
    limit = n;
  }

  const apply = has("--apply");
  // Fail FAST on a non-interactive stdin, before touching the database. The
  // prompt below also guards this, but by then the script has read tens of
  // thousands of rows. `--apply` on a closed stdin can never succeed.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging — a hung prompt exits 0, " +
        "which a wrapper's && reads as success.",
    );
  }

  return {
    apply,
    env: (env as "qa" | "prod" | null) ?? null,
    limit,
    symbols: (val("--symbols") ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    verbose: has("--verbose"),
  };
}

/** Fetch DATABASE_URL from Secret Manager, mirroring scripts/seed-env.sh. */
function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints any credential. */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/**
 * Confirm before ANY write, echoing the host. Keyed on the WRITE, never on a
 * flag: the `DATABASE_URL=... --apply` form has no `--env`, so an `--env`-keyed
 * check would wave through exactly the invocation most likely to be pointed at
 * prod by accident.
 */
async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n  Fix the connection string so the prompt can show " +
        "you what you are hitting.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n  This script is deliberately interactive — run it from " +
        "a terminal.\n",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\n  About to WRITE to ${host} (${envLabel}).\n` +
        `  Type "yes" to continue: `,
      resolve,
    );
  });
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("  Aborted — nothing written.\n");
    process.exit(1);
  }
}

/** One row's worth of decisions. */
interface RowPlan {
  id: string;
  label: string;
  /** Columns that will be SET (currently null, resolvable from rawData). */
  set: Partial<Record<TickertapeFinancialColumn, number | null>>;
  /** `periodEnd` to set, when currently absent and resolvable. */
  periodEnd?: Date;
  /**
   * Columns already populated that rawData resolves DIFFERENTLY. Reported and
   * NEVER written — a disagreement here means either the seed's two lucky keys
   * were not so lucky, or a higher-authority source has since written the row.
   * Both need a human, and neither is something a backfill should decide.
   */
  conflicts: Array<{ column: string; stored: number; fromRaw: number }>;
}

/** Numbers agree if they are within a hair — these are stored ₹ crore at 2dp. */
function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= 1e-9;
}

function planRow(row: {
  id: string;
  symbol: string;
  exchange: string;
  statementType: string;
  periodType: string;
  period: string;
  periodEnd: Date | null;
  rawData: unknown;
  [column: string]: unknown;
}): RowPlan | null {
  const raw = row.rawData;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const mapped = mapTickertapeStatementRow(
    row.statementType as TickertapeStatementType,
    raw as Record<string, unknown>,
    row.periodType === "QUARTERLY" ? "QUARTERLY" : "ANNUAL",
  );
  if (!mapped) return null;

  const columns = tickertapeStatementColumns(mapped);
  const plan: RowPlan = {
    id: row.id,
    label: `${row.symbol}.${row.exchange} ${row.periodType} ${row.period} ${row.statementType}`,
    set: {},
    conflicts: [],
  };

  for (const column of COLUMNS) {
    const resolved = columns[column];
    // UNRESOLVED (key absent from rawData) — leave the column untouched. This
    // is the guard that stops the backfill nulling `revenue`/`ebitda`.
    if (resolved === undefined) continue;

    const stored = row[column];
    if (stored === null || stored === undefined) {
      // Only fill genuine holes. `null` from the source (DISCLOSED-ABSENT, e.g.
      // a bank's `balTdeb`) is deliberately NOT written: the column is already
      // null, so writing null changes nothing and would only inflate the count.
      if (resolved !== null) plan.set[column] = resolved;
      continue;
    }
    if (typeof stored === "number" && typeof resolved === "number") {
      if (!sameNumber(stored, resolved)) {
        plan.conflicts.push({ column, stored, fromRaw: resolved });
      }
    }
  }

  if (row.periodEnd === null && mapped.periodEnd !== undefined) {
    plan.periodEnd = mapped.periodEnd;
  }

  return plan;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error("DATABASE_URL is not set (pass --env qa|prod, or set it)");
  }

  const { prisma } = await import("@usemoney/database");

  console.log(
    `\n  Financials rawData backfill — ${opts.apply ? "APPLY" : "DRY RUN"}` +
      `\n  target: ${maskedHost(uri) ?? "<unknown host>"}` +
      (opts.symbols.length ? `\n  symbols: ${opts.symbols.join(",")}` : "") +
      (opts.limit ? `\n  limit: ${opts.limit}` : "") +
      `\n  re-resolving typed columns + periodEnd from each row's own rawData` +
      `\n  (no network: nothing is refetched)\n`,
  );

  const where = opts.symbols.length ? { symbol: { in: opts.symbols } } : {};
  const total = await prisma.stockFinancials.count({ where });
  console.log(`  ${total} row(s) match.\n`);

  if (opts.apply) await confirmWrite(uri, opts.env ?? "DATABASE_URL");

  // Counters. Every row lands in EXACTLY ONE terminal bucket, and they are
  // asserted to sum to `read` at the end — a completeness check at the row
  // granularity, not the run granularity (MONEY-1189).
  let read = 0;
  let updated = 0; // had something to write (or would have)
  let unchanged = 0; // mapped fine, nothing left to fill
  let unmappable = 0; // rawData missing / not an object / no usable period
  let skippedAuthority = 0; // a higher-ranked source owns the row
  let failed = 0; // the write itself threw
  let conflictRows = 0;

  const filledByColumn: Record<string, number> = Object.fromEntries(
    COLUMNS.map((c) => [c, 0]),
  );
  let periodEndFilled = 0;
  const conflictSamples: string[] = [];

  // Keyset pagination on `id`. `skip`/`take` over a collection other jobs are
  // writing shifts the window under the reader and silently skips rows.
  let cursor: string | null = null;
  let stop = false;

  while (!stop) {
    const take = opts.limit
      ? Math.min(PAGE_SIZE, opts.limit - read)
      : PAGE_SIZE;
    if (take <= 0) break;

    // Hoisted + annotated to break a TS7022 self-reference: `cursor` is
    // assigned from `page`, and `page`'s inferred type depends on the `where`
    // that reads `cursor`. Naming the type here cuts the cycle.
    const pageWhere: Record<string, unknown> = cursor
      ? { ...where, id: { gt: cursor } }
      : { ...where };

    const page = await prisma.stockFinancials.findMany({
      where: pageWhere,
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        symbol: true,
        exchange: true,
        statementType: true,
        periodType: true,
        period: true,
        periodEnd: true,
        rawData: true,
        source: true,
        revenue: true,
        grossProfit: true,
        operatingIncome: true,
        netIncome: true,
        ebitda: true,
        totalAssets: true,
        totalLiabilities: true,
        totalEquity: true,
        totalDebt: true,
        totalCash: true,
        operatingCashFlow: true,
        capitalExpenditure: true,
        freeCashFlow: true,
      },
    });

    if (page.length === 0) break;
    if (page.length < take) stop = true;
    cursor = page[page.length - 1]!.id;

    for (const row of page) {
      read++;

      const plan = planRow(row);
      if (!plan) {
        unmappable++;
        continue;
      }

      if (plan.conflicts.length > 0) {
        conflictRows++;
        if (conflictSamples.length < 20) {
          for (const c of plan.conflicts) {
            conflictSamples.push(
              `    ${plan.label}: ${c.column} stored=${c.stored} rawData=${c.fromRaw}`,
            );
          }
        }
      }

      const setKeys = Object.keys(plan.set) as TickertapeFinancialColumn[];
      const hasWork = setKeys.length > 0 || plan.periodEnd !== undefined;
      if (!hasWork) {
        unchanged++;
        continue;
      }

      // MONEY-1204/1205 — DIRECTLY above the write, not at the top of the loop:
      // this is the decision that gates the `update` below, and the guard has to
      // be readable next to the statement it protects.
      //
      // The order is not re-derived here. `mayOverwriteFinancials`
      // (@usemoney/core/market-data) is its single declared form. `rawData` on
      // these rows is a TICKERTAPE payload, so filling a column from it is a
      // Tickertape-authored write however indirect it looks. An unknown source
      // ranks LAST inside the helper, so a new upstream can only be protected.
      //
      // It is checked in DRY RUN too: a dry run that counts rows the apply
      // would refuse is a plan the operator cannot act on.
      if (!mayOverwriteFinancials("TICKERTAPE", row.source)) {
        skippedAuthority++;
        continue;
      }

      if (opts.apply) {
        try {
          await prisma.stockFinancials.update({
            where: { id: plan.id },
            // `source`, `rawData` and `fetchedAt` are deliberately ABSENT. This
            // derives nothing new — it reads what the row already carries — so
            // the provenance is unchanged and must keep saying so. Rewriting
            // `rawData` would also destroy any `displacedByXbrl` record.
            data: {
              ...plan.set,
              ...(plan.periodEnd ? { periodEnd: plan.periodEnd } : {}),
            },
          });
        } catch (err) {
          // One bad row never ends the run, but it is COUNTED — a partial run
          // that says it was partial is worth more than one that stops silently.
          failed++;
          console.error(`    FAILED ${plan.label}: ${String(err)}`);
          continue;
        }
      }

      // Counted only once the write has actually landed (or, in a dry run, once
      // every gate that could have refused it has passed). Counting at plan
      // time would report fills that an authority skip or a failed write never
      // made — the wrong-granularity completeness signal of MONEY-1189.
      updated++;
      for (const k of setKeys) filledByColumn[k] = (filledByColumn[k] ?? 0) + 1;
      if (plan.periodEnd !== undefined) periodEndFilled++;
      if (opts.verbose) {
        console.log(
          `    ${opts.apply ? "SET" : "WOULD SET"} ${plan.label}: ` +
            `${setKeys.join(",") || "-"}` +
            (plan.periodEnd ? ` +periodEnd` : ""),
        );
      }
    }

    console.log(
      `  … ${read}/${opts.limit ?? total} read | ` +
        `${updated} ${opts.apply ? "updated" : "would update"} | ` +
        `${unchanged} unchanged | ${unmappable} unmappable | ` +
        `${skippedAuthority} skipped-authority | ${failed} failed`,
    );
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\n  Per-column fills (${opts.apply ? "written" : "planned"}):`);
  for (const c of COLUMNS) {
    console.log(`    ${c.padEnd(20)} ${filledByColumn[c] ?? 0}`);
  }
  console.log(`    ${"periodEnd".padEnd(20)} ${periodEndFilled}`);

  if (conflictRows > 0) {
    console.log(
      `\n  ${conflictRows} row(s) hold a populated column that rawData ` +
        `resolves DIFFERENTLY. NOT written — a disagreement means either the ` +
        `stored value did not come from this rawData, or a higher-authority ` +
        `source has since written the row. Both need a human.`,
    );
    for (const line of conflictSamples) console.log(line);
    if (conflictSamples.length < conflictRows) {
      console.log(`    … (${conflictRows - conflictSamples.length} more)`);
    }
  }

  // The completeness line, at ROW granularity. Every row read landed in exactly
  // one of four buckets; if they do not sum, the report is lying about coverage
  // and the run must not read as success (MONEY-1189).
  const accounted =
    updated + unchanged + unmappable + skippedAuthority + failed;
  console.log(
    `\n  ${accounted}/${read} rows accounted for ` +
      `(${updated} ${opts.apply ? "updated" : "would update"}, ` +
      `${unchanged} unchanged, ${unmappable} unmappable, ` +
      `${skippedAuthority} skipped-authority, ${failed} failed)`,
  );

  if (accounted !== read) {
    console.error(
      `\n  INCOMPLETE: ${read - accounted} row(s) fell through every bucket. ` +
        `Refusing to report success.\n`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  if (!opts.limit && read !== total) {
    console.error(
      `\n  INCOMPLETE: read ${read} of ${total} matching rows. The pager ` +
        `stopped early — do NOT treat this run as a full backfill.\n`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`\n  ${failed} row(s) failed to write. Exiting non-zero.\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(
    opts.apply
      ? `\n  Done — ${updated} row(s) updated.\n`
      : `\n  DRY RUN — nothing written. Re-run with --apply from a terminal.\n`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
