/**
 * Backfill `corporate_actions.isin` — MONEY-1301.
 *
 * ## What it repairs
 *
 * Measured on prod 2026-08-30: `corporate_actions` holds 56,446 rows over 8,577
 * symbols and is one of the healthiest tables in this repo — 7/7 days of clean
 * runs, 8,832 selected = 8,832 written. `isin` is populated on **2,507 of them
 * (4.4%)**, so the `@@index([isin])` at `schema.prisma:3444` indexes an almost
 * empty column and every ISIN-keyed join off this table returns nothing: the
 * dual-listing dedupe, the XBRL `dividendPerShare` feed behind `dividendYield`,
 * the MF-holding cross-references. None of them error. They report "no
 * corporate actions", which is what an empty join looks like from the outside.
 *
 * ## How it decides
 *
 * It does not decide. It imports `buildIsinIndex` / `attachIsins` from
 * `workers/src/processors/corporate-actions-sync-logic.ts` — the SAME pure join
 * the nightly writer now uses — so the repair and the writer cannot disagree.
 * Running this after the writer has been deployed for a full window is a
 * fixpoint over that window: those rows report `already has an ISIN`.
 *
 * ## The join key is (symbol, exchange). Never symbol alone.
 *
 * A symbol is NOT unique across exchanges. Ten active-equity symbols are two
 * DIFFERENT companies with distinct ISINs (KIRLPNU, SEL, CORDELIA, RAJPUTANA,
 * TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL, ZEAL), and `instrument_mappings` is
 * `@@unique([symbol, exchange])` precisely because of that. A wrong ISIN on a
 * DIVIDEND row is strictly worse than a missing one: it attributes a payout to
 * another company, through an index that then makes the join look healthy. So
 * a row whose exchange cannot be placed keeps its null, and a symbol that
 * exists only on the OTHER exchange is reported in its own bucket and NOT
 * filled from there.
 *
 * ## The residual is bucketed, not summed
 *
 * A single "unresolved: N" would be unactionable, because the causes need
 * different work and one of them needs none at all. MONEY-1298 established
 * that ~61% of `instrument_mappings` rows typed "EQUITY" are actually bonds,
 * and this table carries INTEREST_PAYMENT (3,754) and REDEMPTION (386) rows for
 * debt instruments — a debt series' ISIN may simply not be in our master, and
 * chasing it is not the same job as filling in a missing equity mapping. Every
 * unresolved bucket is therefore cross-cut by action TYPE and by SOURCE.
 *
 * ## Safety
 *
 *   - DRY RUN BY DEFAULT. `--apply` is required to write anything.
 *   - `--apply` REFUSES a non-TTY stdin and then prompts for "yes", echoing the
 *     masked target host. An agent runs dry runs; a human runs writes.
 *   - It writes ONE column, `isin`, and ONLY where it is currently empty. It
 *     never overwrites an existing value and never nulls one — a row that
 *     already carries an ISIN got it from a source that knew more than a
 *     (symbol, exchange) join does.
 *   - `@usemoney/database` is imported LAZILY, after `--env` resolves. A static
 *     import bakes the ambient `DATABASE_URL` into the client at module
 *     evaluation and silently ignores `--env` (documented at length on
 *     `reclassify-instruments.ts`; guarded by `ops-script-db-target.test.ts`).
 *
 * ## Usage
 *
 *   npx tsx scripts/data/backfill-corp-action-isins.ts --env prod
 *   npx tsx scripts/data/backfill-corp-action-isins.ts --env prod --apply
 *
 *   Options
 *     --apply           actually write (default: dry run)
 *     --env <qa|prod>   fetch DATABASE_URL from GCP Secret Manager
 *     --limit <n>       cap corporate_actions rows examined (dry run only)
 *     --samples <n>     example rows to print per unresolved bucket (default 8)
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

// PURE, which is why it can be a static import: the module has no Prisma
// client, so importing it cannot construct a connection before `--env` has
// chosen one.
import {
  attachIsins,
  buildIsinIndex,
  corpActionIsinKey,
  type InstrumentIsinRow,
} from "../../workers/src/processors/corporate-actions-sync-logic";

type PrismaLike = (typeof import("@usemoney/database"))["default"];
let prisma: PrismaLike | null = null;

const GCP_PROJECT = "stock-book-483718";
const PAGE = 5_000;
const WRITE_CHUNK = 500;

interface Opts {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  samples: number;
}

const KNOWN_FLAGS = new Set("--apply,--env,--limit,--samples".split(","));

function parseArgs(argv: string[]): Opts {
  // Refuse an unrecognised flag rather than ignoring it. `argv.includes(...)`
  // silently drops what it does not know, which is how `--apply --dry-run`
  // once WROTE (reclassify-instruments.ts).
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}.`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and ` +
        `an unparsed --env leaves APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }

  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    // A flag present with NO value is an error, not "flag absent" — a trailing
    // `--limit` returning null would mean "no limit", i.e. every row.
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };
  const positiveInt = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} must be a positive integer, got "${raw}".`);
    }
    return n;
  };

  const env = val("--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}".`);
  }

  const limitRaw = val("--limit");
  const limit = limitRaw === null ? null : positiveInt("--limit", limitRaw);
  const samplesRaw = val("--samples");
  const samples =
    samplesRaw === null ? 8 : positiveInt("--samples", samplesRaw);

  const apply = has("--apply");
  // `--limit` takes a prefix of the collection ordered by id, so the plan it
  // prints is not the plan `--apply` would execute.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: a limited prefix is not the " +
        "population the write would touch. Use --limit for the dry run, then " +
        "--apply without it.",
    );
  }
  // Fail FAST, before reading 56,446 rows. `--apply` on a closed stdin can
  // never succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging.",
    );
  }
  return { apply, env: (env as "qa" | "prod" | null) ?? null, limit, samples };
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
  if (!out) throw new Error(`Secret ${secret} resolved empty.`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints a credential. */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    // mongodb+srv with a comma-separated host list is not a legal URL.
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    // Refuse rather than prompt with a placeholder: the prompt exists so the
    // operator can SEE what they are about to hit.
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n!!  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `   It fills corporate_actions.isin where it is currently empty.\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success.
    console.log("Aborted.");
    process.exit(1);
  }
}

/**
 * Why a row was not filled. Each one needs different work, which is the reason
 * they are not summed into a single "unresolved".
 */
type Bucket =
  /** Already carries an ISIN. The control — and the fixpoint after a run. */
  | "present"
  /** (symbol, exchange) matched a mapping row that has an ISIN. */
  | "fill"
  /**
   * The action's own exchange is absent or is not one this join can place, so
   * no lookup was attempted. Different alarm entirely: it means a feed started
   * tagging rows with a venue we do not map, and no instrument-master coverage
   * will fix it.
   */
  | "unkeyable"
  /**
   * A mapping row EXISTS at (symbol, exchange) and carries no ISIN. Fixable by
   * instrument-master enrichment, not by this script.
   */
  | "mapping-no-isin"
  /**
   * No mapping row at (symbol, exchange), but the SAME symbol has one with an
   * ISIN on the other exchange. DELIBERATELY NOT FILLED — this is exactly the
   * shape that puts one company's ISIN on another company's dividend.
   */
  | "other-exchange-only"
  /** The symbol appears nowhere in `instrument_mappings`. Delisted, mostly. */
  | "symbol-absent";

const BUCKET_ORDER: Bucket[] = [
  "present",
  "fill",
  "mapping-no-isin",
  "other-exchange-only",
  "symbol-absent",
  "unkeyable",
];

/** Types whose subject is a DEBT instrument rather than an equity. */
const DEBT_TYPES = new Set(["INTEREST_PAYMENT", "REDEMPTION"]);

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function topN(m: Map<string, number>, n: number): string {
  return (
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ") || "none"
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const envLabel = opts.env ? `--env ${opts.env}` : "ambient DATABASE_URL";
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set and no --env was given.");

  console.log(`\n  target : ${maskedHost(uri) ?? "<unknown>"}`);
  console.log(`  source : ${envLabel}`);
  console.log(`  mode   : ${opts.apply ? "APPLY (writes)" : "DRY RUN"}\n`);

  if (opts.apply) await confirmWrite(uri, envLabel);

  prisma = (await import("@usemoney/database")).default;
  const db = prisma;

  // The whole cash-equity mapping universe, ONCE. ~26,669 rows across both
  // exchanges fits in memory and turns 56,446 per-row lookups into one read.
  //
  // `isActive` is deliberately NOT filtered. `corporate_actions` is
  // history-preserving by design, so its oldest rows belong to exactly the
  // delisted / merged / renamed issuers an active-only join would withhold an
  // identity from. Activity is a property of the listing; the ISIN is the
  // identity, and the identity does not lapse.
  const mappings = (await db.instrumentMapping.findMany({
    where: { exchange: { in: ["NSE", "BSE"] } },
    select: { symbol: true, exchange: true, isin: true },
  })) as InstrumentIsinRow[];

  const index = buildIsinIndex(mappings);
  /** Every (symbol, exchange) that HAS a row, with or without an ISIN. */
  const rowExists = new Set<string>();
  /** symbol -> exchanges on which the symbol has a row bearing an ISIN. */
  const isinExchangesBySymbol = new Map<string, Set<string>>();
  for (const m of mappings) {
    const key = corpActionIsinKey(m.symbol, m.exchange);
    if (!key) continue;
    rowExists.add(key);
    if (!m.isin) continue;
    const sym = key.split("|")[0]!;
    const set = isinExchangesBySymbol.get(sym);
    if (set) set.add(key.split("|")[1]!);
    else isinExchangesBySymbol.set(sym, new Set([key.split("|")[1]!]));
  }

  /**
   * Symbols whose NSE and BSE rows carry DIFFERENT ISINs — i.e. two different
   * companies sharing a ticker. Counted so the report can state, as a number
   * rather than an assurance, how many fills the exchange half of the key
   * actually disambiguated.
   */
  const collidingSymbols = new Set<string>();
  {
    const isinsBySymbol = new Map<string, Set<string>>();
    for (const [key, isin] of index) {
      const sym = key.split("|")[0]!;
      const set = isinsBySymbol.get(sym);
      if (set) set.add(isin);
      else isinsBySymbol.set(sym, new Set([isin]));
    }
    for (const [sym, isins] of isinsBySymbol) {
      if (isins.size > 1) collidingSymbols.add(sym);
    }
  }

  console.log(
    `  instrument_mappings : ${mappings.length} NSE/BSE rows, ` +
      `${rowExists.size} distinct (symbol, exchange), ` +
      `${index.size} carrying an ISIN\n` +
      `  symbols whose NSE and BSE ISINs DIFFER (two companies, one ticker): ` +
      `${collidingSymbols.size}\n`,
  );

  const counts = new Map<Bucket, number>();
  /** Per-bucket cross-cuts. */
  const typesBy = new Map<Bucket, Map<string, number>>();
  const sourcesBy = new Map<Bucket, Map<string, number>>();
  const samplesBy = new Map<Bucket, string[]>();
  const symbolsBy = new Map<Bucket, Set<string>>();
  for (const b of BUCKET_ORDER) {
    counts.set(b, 0);
    typesBy.set(b, new Map());
    sourcesBy.set(b, new Map());
    samplesBy.set(b, []);
    symbolsBy.set(b, new Set());
  }
  /** Unresolved rows whose action type is debt servicing. */
  let debtUnresolved = 0;
  let equityUnresolved = 0;
  let fillsOnCollidingSymbol = 0;
  /** isin -> corporate_action ids to stamp with it. */
  const writes = new Map<string, string[]>();

  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const take = opts.limit ? Math.min(PAGE, opts.limit - scanned) : PAGE;
    if (take <= 0) break;
    const page = await db.corporateAction.findMany({
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        isin: true,
        type: true,
        source: true,
      },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    scanned += page.length;

    for (const row of page) {
      let bucket: Bucket;
      if (row.isin) {
        bucket = "present";
      } else {
        const key = corpActionIsinKey(row.symbol, row.exchange);
        if (!key) {
          bucket = "unkeyable";
        } else if (index.has(key)) {
          bucket = "fill";
        } else if (rowExists.has(key)) {
          bucket = "mapping-no-isin";
        } else if (
          (isinExchangesBySymbol.get(key.split("|")[0]!)?.size ?? 0) > 0
        ) {
          bucket = "other-exchange-only";
        } else {
          bucket = "symbol-absent";
        }

        if (bucket === "fill") {
          const isin = index.get(key!)!;
          if (collidingSymbols.has(key!.split("|")[0]!))
            fillsOnCollidingSymbol++;
          const list = writes.get(isin);
          if (list) list.push(row.id);
          else writes.set(isin, [row.id]);
        } else {
          // Reached only when the row had no ISIN and the join could not
          // supply one, so every arm here is genuinely unresolved.
          if (DEBT_TYPES.has(row.type)) debtUnresolved++;
          else equityUnresolved++;
        }
      }

      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      bump(typesBy.get(bucket)!, row.type);
      bump(sourcesBy.get(bucket)!, row.source ?? "(none)");
      symbolsBy.get(bucket)!.add(row.symbol);
      const samples = samplesBy.get(bucket)!;
      if (samples.length < opts.samples) {
        samples.push(
          `${row.symbol}/${row.exchange || "(no exchange)"} ${row.type} [${row.source ?? "-"}]`,
        );
      }
    }
    if (opts.limit && scanned >= opts.limit) break;
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const unresolved =
    total - (counts.get("present") ?? 0) - (counts.get("fill") ?? 0);

  console.log(`  corporate_actions scanned : ${total}\n`);
  const pct = (n: number): string =>
    total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
  for (const b of BUCKET_ORDER) {
    const n = counts.get(b) ?? 0;
    console.log(
      `  ${b.padEnd(20)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}  ` +
        `over ${symbolsBy.get(b)!.size} symbol(s)`,
    );
  }
  console.log(
    `\n  fill rate after this run : ` +
      `${pct((counts.get("present") ?? 0) + (counts.get("fill") ?? 0))} ` +
      `(from ${pct(counts.get("present") ?? 0)})`,
  );
  console.log(
    `  fills on a symbol whose two exchanges hold DIFFERENT ISINs: ` +
      `${fillsOnCollidingSymbol} — every one of these would have been a ` +
      `coin-flip under a symbol-only join`,
  );
  console.log(
    `\n  residual (${unresolved} rows) split by what the action is ABOUT:\n` +
      `    debt servicing (INTEREST_PAYMENT/REDEMPTION) : ${debtUnresolved}\n` +
      `    everything else                              : ${equityUnresolved}`,
  );

  for (const b of BUCKET_ORDER) {
    if (b === "present" || b === "fill") continue;
    const n = counts.get(b) ?? 0;
    if (n === 0) continue;
    console.log(`\n  ${b} (${n})`);
    console.log(`    types   : ${topN(typesBy.get(b)!, 8)}`);
    console.log(`    sources : ${topN(sourcesBy.get(b)!, 6)}`);
    console.log(`    e.g.    : ${samplesBy.get(b)!.join("  |  ")}`);
  }

  if (!opts.apply) {
    console.log(
      `\n  DRY RUN — nothing written. ` +
        `Would stamp ${counts.get("fill") ?? 0} row(s) across ` +
        `${writes.size} distinct ISIN(s).\n` +
        `  Re-run with --apply to write.\n`,
    );
    return;
  }

  let written = 0;
  for (const [isin, ids] of writes) {
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const slice = ids.slice(i, i + WRITE_CHUNK);
      const res = await db.corporateAction.updateMany({
        // Narrowed by id, so a row that acquired an ISIN between the scan and
        // the write is still only ever written with the value this plan chose
        // for it. There is no null-filter here on purpose: `{isin: null}` on
        // Mongo matches only rows that CARRY the key, and the whole population
        // this script exists for is rows where the field is ABSENT
        // (MONEY-1050 / 1205 / 1234 / 1236).
        where: { id: { in: slice } },
        data: { isin },
      });
      written += res.count;
    }
  }
  console.log(
    `\n  WROTE isin on ${written} row(s) across ${writes.size} distinct ISIN(s).\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
